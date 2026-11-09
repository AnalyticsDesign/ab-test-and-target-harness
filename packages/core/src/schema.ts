import { z } from "zod";
import { ConversionPayloadSchema, ExposurePayloadSchema, GoalAnalyticsSchema } from "./analytics";
import { PAGE_OPS, PAGE_PARTS, type PageMatch, type PageOp, type PagePart, type UrlMatch } from "./page";
import { REGEX_LIMITS } from "./regex-compile";
import { RUN_ID_RE } from "./results";
import type { RegexProgram } from "./regex-run";
import { BROWSERS, DEVICES, OSES, type Browser, type Device, type Os } from "./ua";
import { WEEKDAYS, type Weekday } from "./time";

export const LIMITS = {
  selectorMax: 500,
  regexMax: 200,
  /** 配る形(compiled config)の DSL の深さ(決定 49 で 5 → 16。設計書 §4.5) */
  dslDepthMax: 16,
  /** 保存する形の DSL の深さ(and / or / not / 条件をすべて数える。設計書 §4.5)。エクスペリエンスは形の制限で 3 に収まる */
  experimentDepthMax: 3,
  audienceDepthMax: 11,
  /** オーディエンスのグループの入れ子(一番外側の中の段数。画面の「入れ子 n / 4」) */
  audienceNestMax: 4,
  changeValueMaxBytes: 65536,
  configMaxBytes: 524288,
  /**
   * compile がオーディエンスの参照を展開する量の上限(サイト全体。参照のたびに、そのオーディエンスの定義のノード数 = and / or / not /
   * 条件をすべて 1 つと数えたものを足す)。展開の前に止める(B159)。根拠: 配る設定の上限 512 KB ÷ 展開したノード 1 つの JSON の最小の
   * 大きさ。実測で、一番小さい条件は 31〜33 バイト、`{"not":…}` の包みは +8 バイトで、not と条件を交互にした形が平均約 21 バイト/ノード
   * (2 万ノードで約 420 KB。一番小さい形でも、上限ちょうどの展開が 512 KB の内に収まる)
   */
  audienceExpansionMax: 20_000,
  /** 対象 URL(urlMatch)の行数・パラメータの個数・名前の長さ・全行の正規表現の命令数の合計(B69)、1 行の「かつ」のページの一致(and)の個数(B69 追補) */
  urlIncludeMax: 10,
  urlExcludeMax: 10,
  urlParamsMax: 5,
  urlAndMax: 5,
  urlParamNameMax: 256,
  urlInstructionsMax: 500,
} as const;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------------------------
// ページの一致(決定 49、設計書 §4.1.2 / §10.1)
// ---------------------------------------------------------------------------------------------

const PAGE_OP_VALUES = ["equals", "contains", "startsWith", "endsWith", "regex"] as const satisfies readonly PageOp[];
/** 値に \u0000 を含めない(パターン ID のハッシュの区切りに使うため。設計書 §4.1) */
const matchValue = z.string().min(1).refine((v) => !v.includes("\u0000"), { message: "value must not contain U+0000" });

/** part ごとの一致の仕方(PAGE_OPS)に合うか */
function refinePageOp(m: { part?: PagePart; op: PageOp }, ctx: z.RefinementCtx): void {
  if (!PAGE_OPS[m.part ?? "url"].includes(m.op)) ctx.addIssue({ code: "custom", path: ["op"], message: `op ${m.op} is not allowed for part ${m.part ?? "url"}` });
}

/**
 * 保存する形(control が保存し API で読み書きする。compile の入力)。命令列は持たない。
 * url の正規表現は形としては受け、pageMatchIssue(page-normalize.ts)が案内付きで拒否する(保存は 422、compile は CompileError)
 */
export const PageMatchInputSchema = z
  .strictObject({ part: z.enum(PAGE_PARTS).optional(), op: z.enum(PAGE_OP_VALUES), value: matchValue })
  .superRefine(refinePageOp);

/** 命令列(設計書 §10.3)。形だけを見る。中身の整合(命令の種類・飛び先・集合の添字)は照合器が照合の前に見て、不正なら対象外にする */
export const RegexProgramSchema = z.strictObject({ v: z.number().int(), sets: z.array(z.array(z.number())), code: z.array(z.number()) });

/** 正規表現(op = regex)は part が path / host のときだけで、命令列を必ず持つ。それ以外は命令列を持たない */
function refineCompiledRegex(m: { part?: string; op: string; prog?: unknown }, ctx: z.RefinementCtx): void {
  if (m.op === "regex") {
    if (m.part !== "path" && m.part !== "host") ctx.addIssue({ code: "custom", path: ["part"], message: "regex is allowed only for part path / host" });
    if (m.prog === undefined) ctx.addIssue({ code: "custom", path: ["prog"], message: "regex requires prog" });
  } else if (m.prog !== undefined) ctx.addIssue({ code: "custom", path: ["prog"], message: "prog is only for regex" });
}

/** 配る形(compiled config)。`part` 省略 = url。strict なので未知のキー(版 1 の読み替えの印 `legacy` など)は拒否する */
export const CompiledPageMatchSchema = z
  .strictObject({ part: z.enum(PAGE_PARTS).optional(), op: z.enum(PAGE_OP_VALUES), value: matchValue, prog: RegexProgramSchema.optional() })
  .superRefine((m, ctx) => {
    refinePageOp(m, ctx);
    refineCompiledRegex(m, ctx);
  });

// ---------------------------------------------------------------------------------------------
// 配信条件の DSL(spec §6.2 / 決定 49 §4)
// ---------------------------------------------------------------------------------------------

/**
 * 配信条件の葉(版 3)。ページの URL・ホスト・パス・クエリ(`ctx: url / host / path / query`)は B69 で外し、エクスペリエンスの
 * 対象 URL(urlMatch)で書く。版 2 の読み取りは schema-v2.ts
 */
export type CtxNode =
  | { ctx: "device"; op: "in"; value: Device[] }
  | { ctx: "browser"; op: "in"; value: Browser[] }
  | { ctx: "os"; op: "in"; value: Os[] }
  | { ctx: "referrer"; op: "equals" | "contains"; value: string }
  | { ctx: "referrer"; op: "isEmpty" }
  /** 画面の幅(px)。minWidth 以上・maxWidth 未満。少なくとも片方 */
  | { ctx: "viewport"; minWidth?: number; maxWidth?: number }
  /** 曜日と時間帯(サイトのタイムゾーン)。from / to は両方か、どちらも無い(終日) */
  | { ctx: "time"; days: Weekday[]; from?: string; to?: string }
  /** 初回の訪問からの経過。hours と days のどちらか 1 つ */
  | { ctx: "sinceFirstVisit"; op: "gte" | "lt"; hours?: number; days?: number };

/** 配る形の履歴の条件。visited の pattern は compiled config の `patterns` のキー。min は 1 なら省略、withinDays = 最後の閲覧(達成)が N 日以内 */
export type HistNode = { hist: "visited"; pattern: string; min?: number; withinDays?: number } | { hist: "converted"; goal: string; withinDays?: number };

export type DslNode = CtxNode | HistNode | { and: DslNode[] } | { or: DslNode[] } | { not: DslNode };

const uniqueArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1).refine((a) => new Set(a).size === a.length, { message: "values must be unique" });

const viewportWidth = z.number().int().min(1).max(10000);
const ViewportSchema = z
  .strictObject({ ctx: z.literal("viewport"), minWidth: viewportWidth.optional(), maxWidth: viewportWidth.optional() })
  .refine((v) => v.minWidth !== undefined || v.maxWidth !== undefined, { message: "viewport needs minWidth or maxWidth" })
  .refine((v) => v.minWidth === undefined || v.maxWidth === undefined || v.minWidth < v.maxWidth, { message: "minWidth must be less than maxWidth" });

const TimeSchema = z
  .strictObject({
    ctx: z.literal("time"),
    days: uniqueArray(z.enum(WEEKDAYS)),
    from: z.string().regex(/^(?:[01]\d|2[0-3]):00$/).optional(),
    to: z.string().regex(/^(?:0[1-9]|1\d|2[0-4]):00$/).optional(),
  })
  .refine((v) => (v.from === undefined) === (v.to === undefined), { message: "from and to go together" })
  .refine((v) => v.from === undefined || v.from !== v.to, { message: "from and to must differ (use days only for all day)" });

const SinceFirstVisitSchema = z
  .strictObject({ ctx: z.literal("sinceFirstVisit"), op: z.enum(["gte", "lt"]), hours: z.number().int().min(1).max(8760).optional(), days: z.number().int().min(1).max(3650).optional() })
  .refine((v) => (v.hours === undefined) !== (v.days === undefined), { message: "exactly one of hours / days" });

/** 保存形と配る形で同じ条件(端末・時刻など)。版 2 の読み取り(schema-v2.ts)も使う */
export const COMMON_CTX = [
  z.strictObject({ ctx: z.literal("device"), op: z.literal("in"), value: uniqueArray(z.enum(DEVICES)) }),
  z.strictObject({ ctx: z.literal("browser"), op: z.literal("in"), value: uniqueArray(z.enum(BROWSERS)) }),
  z.strictObject({ ctx: z.literal("os"), op: z.literal("in"), value: uniqueArray(z.enum(OSES)) }),
  z.strictObject({ ctx: z.literal("referrer"), op: z.literal("equals"), value: z.string() }),
  z.strictObject({ ctx: z.literal("referrer"), op: z.literal("contains"), value: z.string().min(1) }),
  z.strictObject({ ctx: z.literal("referrer"), op: z.literal("isEmpty") }),
  ViewportSchema,
  TimeSchema,
  SinceFirstVisitSchema,
] as const;

const pageCtx = (part: "host" | "path", compiled: boolean) =>
  z
    .strictObject({ ctx: z.literal(part), op: z.enum(PAGE_OPS[part] as unknown as [PageOp, ...PageOp[]]), value: matchValue, ...(compiled ? { prog: RegexProgramSchema.optional() } : {}) })
    .superRefine((v, ctx) => {
      if (compiled) refineCompiledRegex({ part, op: v.op, prog: (v as { prog?: unknown }).prog }, ctx);
    });

/**
 * B69 で配信条件・オーディエンスから外したページの条件(ctx: url / host / path / query)の形。使う所は 2 つだけ:
 * 保存の読み取り(StoredCtxReadSchema。D1 に残った古い条件を応答で表す。compiled = false)と、版 2 の読み取り(schema-v2.ts。compiled = true)。
 * 保存形の url は正規表現も形としては受けていた(regexIssueIn が拒否していた)ので、読み取りでも受ける
 */
export const removedPageCtx = (compiled: boolean) =>
  [
    z.strictObject({ ctx: z.literal("url"), op: z.enum(compiled ? ["equals", "contains", "startsWith"] : ["equals", "contains", "startsWith", "regex"]), value: matchValue }),
    pageCtx("host", compiled),
    pageCtx("path", compiled),
    z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("equals"), value: z.string() }),
    z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("contains"), value: z.string().min(1) }),
    z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("exists") }),
  ] as const;

/** 配る形の条件(版 3)。ページの条件は対象 URL に移した */
const CompiledCtxSchema = z.union(COMMON_CTX);
export const CompiledHistSchema = z.union([
  z.strictObject({ hist: z.literal("visited"), pattern: z.string().min(1), min: z.number().int().min(1).optional(), withinDays: z.number().int().min(1).max(3650).optional() }),
  z.strictObject({ hist: z.literal("converted"), goal: z.string().min(1), withinDays: z.number().int().min(1).max(3650).optional() }),
]);

/** DSL の深さ(and / or / not / 条件をすべて数える)。保存形と配る形のどちらにも使う */
export function dslDepth(node: object): number {
  const n = node as { and?: object[]; or?: object[]; not?: object };
  if (Array.isArray(n.and)) return 1 + Math.max(...n.and.map(dslDepth));
  if (Array.isArray(n.or)) return 1 + Math.max(...n.or.map(dslDepth));
  if (n.not !== undefined) return 1 + dslDepth(n.not);
  return 1;
}

const DslNodeBase: z.ZodType<DslNode> = z.lazy(() =>
  z.union([
    CompiledCtxSchema,
    CompiledHistSchema,
    z.strictObject({ and: z.array(DslNodeBase).min(1) }),
    z.strictObject({ or: z.array(DslNodeBase).min(1) }),
    z.strictObject({ not: DslNodeBase }),
  ]),
) as z.ZodType<DslNode>;

/** 配る形(compiled config)の DSL */
export const DslNodeSchema = DslNodeBase.superRefine((node, ctx) => {
  if (dslDepth(node) > LIMITS.dslDepthMax) ctx.addIssue({ code: "custom", message: `dsl depth over ${LIMITS.dslDepthMax}` });
});

/**
 * 保存する形の ctx の条件(control が保存し、compile の入力になる)。閲覧の条件・オーディエンスの参照は targeting.ts。
 * ページの条件(url / host / path / query)は受けない(B69。findRemovedPageCondition が zod より先に理由付きで止める)
 */
export const StoredCtxSchema = z.union(COMMON_CTX);
export type StoredCtx = z.infer<typeof StoredCtxSchema>;

/** 読み取りの応答で古い条件に付ける説明(OpenAPI の describe に出る) */
export const REMOVED_CONDITION_DESCRIPTION = "使えなくなった条件。対象 URL に移すまで保存できない";

/**
 * 読み取りの応答の ctx の条件(GET・一覧・複製)。D1 に残った古いページの条件(url / host / path / query)も表せる。
 * 保存の入力には使わない(StoredCtxSchema)
 */
export const StoredCtxReadSchema = z.union([...COMMON_CTX, ...removedPageCtx(false).map((s) => s.describe(REMOVED_CONDITION_DESCRIPTION))]);
export type StoredCtxRead = z.infer<typeof StoredCtxReadSchema>;

// ---------------------------------------------------------------------------------------------
// 対象 URL(urlMatch、B69)。照合は page.ts の matchTargetUrl、正規化・検査・正規の形は url-match.ts。
// schema はここに置く(url-match.ts → schema.ts の一方向にする。逆向きの import があると、読み込みの順で LIMITS などを初期化の前に読む)
// ---------------------------------------------------------------------------------------------

/** パラメータの条件。equals の値は空文字可(`?ref=` に一致)、contains は 1 字以上。名前は大文字と小文字を区別する */
const ParamMatchSchema = z.union([
  z.strictObject({ name: z.string().min(1).max(LIMITS.urlParamNameMax), op: z.literal("equals"), value: z.string() }),
  z.strictObject({ name: z.string().min(1).max(LIMITS.urlParamNameMax), op: z.literal("contains"), value: z.string().min(1) }),
  z.strictObject({ name: z.string().min(1).max(LIMITS.urlParamNameMax), op: z.literal("exists") }),
]);

/** 行 = ページの一致(page)+「かつ」のページの一致(and。B69 追補。page と同じ型、0〜5 個)+ パラメータの条件(params) */
const urlMatchSchemaOf = <P extends z.ZodType>(page: P) => {
  const row = z.strictObject({ page, and: z.array(page).max(LIMITS.urlAndMax).optional(), params: z.array(ParamMatchSchema).max(LIMITS.urlParamsMax).optional() });
  return z.strictObject({ include: z.array(row).min(1).max(LIMITS.urlIncludeMax), exclude: z.array(row).max(LIMITS.urlExcludeMax).optional() });
};

/** 対象 URL の保存の形(control が保存し API で読み書きする)。古い形 `{ op, value }` は strict で拒否する */
export const UrlMatchInputSchema = urlMatchSchemaOf(PageMatchInputSchema);
/** 対象 URL の配る形(compiled config)。行の page は命令列を持つ */
export const CompiledUrlMatchSchema = urlMatchSchemaOf(CompiledPageMatchSchema);

// ---------------------------------------------------------------------------------------------
// Change / Variant(変更なし)
// ---------------------------------------------------------------------------------------------


const selector = z.string().min(1).max(LIMITS.selectorMax);
const payloadSize = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((v: unknown, ctx: z.RefinementCtx) => {
    if (utf8Bytes(JSON.stringify(v)) > LIMITS.changeValueMaxBytes) {
      ctx.addIssue({ code: "custom", message: `payload over ${LIMITS.changeValueMaxBytes} bytes` });
    }
  });

/**
 * spec §11(決定 16): ATTRIBUTE の allowlist。列挙外の属性(`on*` / `srcdoc` / `style` / `action` /
 * `formaction` / `srcset` など)と、`href` / `src` の `javascript:` / `data:` / `vbscript:` を拒否する。
 * 本来は control の保存時検証(422 + `attribute_not_allowed` + HTML type への UI 誘導)だが、control は
 * まだ無く fixture CLI で書いた config が本番 KV に入るため、決定 30 (2) の BYOID 衝突検証と同じく
 * core の schema に置いて fixture CLI・edge・(将来の)control のすべてに効かせる。
 * control 側の 422 とメッセージはこの schema チェックの上に載る
 */
const ATTRIBUTE_ALLOWED_NAMES = new Set([
  "href", "src", "alt", "title", "class", "id", "target", "rel",
  "placeholder", "value", "disabled", "hidden", "width", "height", "loading",
]);
const ATTRIBUTE_PREFIXED_RE = /^(?:aria|data)-[a-z0-9._-]+$/; // `aria-*` / `data-*`
const ATTRIBUTE_URL_NAMES = new Set(["href", "src"]);

/** HTML の属性名は大小無視。小文字化して照合する(`ONCLICK` も `onclick` として弾かれる) */
function isAllowedAttributeName(name: string): boolean {
  const n = name.toLowerCase();
  return ATTRIBUTE_ALLOWED_NAMES.has(n) || ATTRIBUTE_PREFIXED_RE.test(n);
}

/**
 * `href` / `src` は http(s) と相対 URL のみ。scheme 判定の前に C0 制御文字と空白を落とす —
 * ブラウザは URL 解析でこれらを除去するため、`java\tscript:` や先頭空白付きの `  javascript:` が
 * 素の文字列比較をすり抜ける。除去後に scheme があれば http / https 以外は拒否、無ければ相対 URL として許可
 */
function isAllowedAttributeUrl(value: string): boolean {
  const stripped = value.replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(stripped)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https";
}

export type AttributeIssue = { code: "attribute_not_allowed" | "attribute_url_not_allowed"; message: string };

/** spec §11(決定 16): control の 422 がそのまま使える機械可読コード付きの判定。schema の superRefine もこれを使う */
export function attributeChangeIssue(p: { name: string; value: string }): AttributeIssue | null {
  if (!isAllowedAttributeName(p.name)) {
    return { code: "attribute_not_allowed", message: `attribute ${p.name} is not allowed (not in the attribute allowlist; use an HTML change instead)` };
  }
  if (ATTRIBUTE_URL_NAMES.has(p.name.toLowerCase()) && !isAllowedAttributeUrl(p.value)) {
    return { code: "attribute_url_not_allowed", message: `attribute ${p.name} must be an http(s) or relative URL` };
  }
  return null;
}

const AttributePayloadSchema = z.strictObject({ name: z.string().min(1), value: z.string() }).superRefine((p, ctx) => {
  const issue = attributeChangeIssue(p);
  if (issue) ctx.addIssue({ code: "custom", message: issue.message, params: { code: issue.code } });
});

export const ChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string().min(1), type: z.literal("TEXT"), selector, payload: payloadSize(z.strictObject({ text: z.string() })) }),
  z.strictObject({ id: z.string().min(1), type: z.literal("IMAGE"), selector, payload: payloadSize(z.strictObject({ src: z.string().url().refine((v) => /^https?:\/\//i.test(v), { message: "IMAGE src must be an absolute http(s) URL" }) })) }),
  z.strictObject({ id: z.string().min(1), type: z.literal("HIDE"), selector, payload: z.strictObject({}) }),
  z.strictObject({ id: z.string().min(1), type: z.literal("ATTRIBUTE"), selector, payload: payloadSize(AttributePayloadSchema) }),
  // html の下限(Plan 10 B2): 空文字 + replace は要素の削除(HIDE と紛らわしい暗黙経路)、空 + 他の position は no-op なのに Exposure が出る
  z.strictObject({ id: z.string().min(1), type: z.literal("HTML"), selector, payload: payloadSize(z.strictObject({ html: z.string().min(1), position: z.enum(["replace", "before", "after", "append"]), runScripts: z.boolean() })) }),
  z.strictObject({ id: z.string().min(1), type: z.literal("CSS"), payload: payloadSize(z.strictObject({ css: z.string() })) }),
  z.strictObject({ id: z.string().min(1), type: z.literal("CUSTOM_JS"), selector, payload: payloadSize(z.strictObject({ code: z.string() })) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/**
 * 配る形は `name`(パターン・エクスペリエンス・目標)を持たない(B77 で compile が出さなくなり、版 3 で受け入れも消した。B69)。
 * 名前付きの版 2 は schema-v2.ts が受け、upgradeV2 が payload に移して落とす
 */
export const VariantSchema = z.strictObject({
  id: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  changes: z.array(ChangeSchema),
});
export type Variant = z.infer<typeof VariantSchema>;

export function refineVariantWeights(e: { variants: Array<{ weight: number }> }, ctx: z.RefinementCtx): void {
  const sum = e.variants.reduce((a, v) => a + v.weight, 0);
  if (sum !== 100) ctx.addIssue({ code: "custom", message: `variant weights must sum to 100 (got ${sum})` });
}

/** Experiment の共通 shape(urlMatch / targeting 以外)。compiled と compile の入力で urlMatch / targeting / variants を差し替える */
export const ExperimentCommonShape = {
  id: z.string().min(1),
  trafficPercentage: z.number().int().min(1).max(100),
  persistAssignment: z.boolean(),
} as const;

export const ExperimentSchema = z
  .strictObject({
    ...ExperimentCommonShape,
    urlMatch: CompiledUrlMatchSchema,
    targeting: DslNodeSchema.optional(),
    // 決定 51(設計書 §3.1): 種別は compiled config に載せないので、ここはパターン 1 つ以上だけを見る
    // (テストは 2 つ以上・パーソナライズは 1 つは、control の保存と compile の入力で確かめる)
    variants: z.array(VariantSchema).min(1),
  })
  .superRefine(refineVariantWeights);
export type Experiment = z.infer<typeof ExperimentSchema>;

/** 配る形の Goal の共通部分(名前は持たない)。外部計測は compile が conversionPayloads に焼くので置かない */
const goalBase = { id: z.string().min(1) };
/** 保存する形の Goal の共通部分。`name` は必須(管理画面の中で使う)、`analytics` = 目標の外部計測(B77、K5) */
const goalInputBase = { id: z.string().min(1), name: z.string().min(1), analytics: GoalAnalyticsSchema.optional() };
const clickConfig = z.strictObject({ selector });
const customConfig = z.strictObject({});

/** 配る形の Goal。PAGEVIEW は `{ page: ページの一致 }`(決定 49。版 1 の `{ urlOp, urlValue }` から名前を付け替えた) */
export const GoalSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...goalBase, type: z.literal("PAGEVIEW"), config: z.strictObject({ page: CompiledPageMatchSchema }) }),
  z.strictObject({ ...goalBase, type: z.literal("CLICK"), config: clickConfig }),
  z.strictObject({ ...goalBase, type: z.literal("CUSTOM"), config: customConfig }),
]);
export type Goal = z.infer<typeof GoalSchema>;

/** 保存する形の Goal(control の API と compile の入力) */
export const GoalInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...goalInputBase, type: z.literal("PAGEVIEW"), config: z.strictObject({ page: PageMatchInputSchema }) }),
  z.strictObject({ ...goalInputBase, type: z.literal("CLICK"), config: clickConfig }),
  z.strictObject({ ...goalInputBase, type: z.literal("CUSTOM"), config: customConfig }),
]);
export type GoalInput = z.infer<typeof GoalInputSchema>;

/** spec §10.9: exposurePayloads の record キーと payload 内 ID、対応する Experiment / Variant の存在を検証する(版 1 と版 2 で共通) */
export function refineExposurePayloads(
  c: { experiments: Array<{ id: string; variants: Array<{ id: string }> }>; exposurePayloads?: Record<string, Record<string, { experimentId: string; variantId: string }>> | undefined },
  ctx: z.RefinementCtx,
): void {
  // compile はこの不変条件を満たす出力しか作らないので、ここで落ちるのは手書き・改竄・別バージョンの混入。
  // エントリの **欠落** は runtime のフォールバック対象なので許可し、存在するエントリだけを見る
  if (!c.exposurePayloads) return;
  for (const [eid, byVariant] of Object.entries(c.exposurePayloads)) {
    const exp = c.experiments.find((e) => e.id === eid);
    if (!exp) {
      ctx.addIssue({ code: "custom", path: ["exposurePayloads", eid], message: `exposurePayloads references unknown experiment ${eid}` });
      continue;
    }
    for (const [vid, p] of Object.entries(byVariant)) {
      if (p.experimentId !== eid || p.variantId !== vid) {
        ctx.addIssue({ code: "custom", path: ["exposurePayloads", eid, vid], message: `payload ids ${p.experimentId}/${p.variantId} must match record keys ${eid}/${vid}` });
      }
      if (!exp.variants.some((v) => v.id === vid)) {
        ctx.addIssue({ code: "custom", path: ["exposurePayloads", eid, vid], message: `exposurePayloads references unknown variant ${vid} of ${eid}` });
      }
    }
  }
}

/** B77(K5): conversionPayloads の record キーと payload の goalId の一致と、対応する目標の存在を検証する。欠落は runtime の予備の導出(ID)に任せる */
export function refineConversionPayloads(
  c: { goals: Array<{ id: string }>; conversionPayloads?: Record<string, { goalId: string }> | undefined },
  ctx: z.RefinementCtx,
): void {
  if (!c.conversionPayloads) return;
  for (const [gid, p] of Object.entries(c.conversionPayloads)) {
    if (p.goalId !== gid) ctx.addIssue({ code: "custom", path: ["conversionPayloads", gid], message: `payload goalId ${p.goalId} must match record key ${gid}` });
    if (!c.goals.some((g) => g.id === gid)) ctx.addIssue({ code: "custom", path: ["conversionPayloads", gid], message: `conversionPayloads references unknown goal ${gid}` });
  }
}

/** 命令列の命令数(1 命令 = 3 要素)。版 2 の読み取り(schema-v2.ts)も使う */
export const programSize = (p?: RegexProgram): number => (p && Array.isArray(p.code) ? p.code.length / 3 : 0);

/** 配る設定に入るすべての命令列の命令数(対象 URL の全行の page と and・パターン・目標)。版 3 の配信条件は命令列を持たない(ページの条件は対象 URL に移した) */
export function regexInstructionTotal(c: { patterns: Record<string, { prog?: RegexProgram }>; goals: Goal[]; experiments: Array<{ urlMatch: UrlMatch }> }): number {
  let total = 0;
  for (const p of Object.values(c.patterns)) total += programSize(p.prog);
  for (const g of c.goals) if (g.type === "PAGEVIEW") total += programSize(g.config.page.prog);
  for (const e of c.experiments)
    for (const r of e.urlMatch.include.concat(e.urlMatch.exclude ?? [])) {
      total += programSize(r.page.prog);
      for (const p of r.and ?? []) total += programSize(p.prog);
    }
  return total;
}

/**
 * 設計書 §6.3(D9 ②): 結果の収集。`runs` = 結果を記録する Site の running / paused のテストの experimentId → runId。
 * `forget: true` は個票が残っている間の forget の送信(runs が空でもよい)。結果を記録しない Site には出さない
 */
export const ResultsConfigSchema = z.strictObject({
  forget: z.literal(true),
  runs: z.record(z.string(), z.string().regex(RUN_ID_RE)),
});
export type ResultsConfig = z.infer<typeof ResultsConfigSchema>;

/**
 * 版 3 の compiled config(B69)。版 2 との差: 対象 URL が含める・除くの行になった(urlMatch)、配信条件からページの条件
 * (url / host / path / query)を外した、名前(name)を受けない。`timezone` = サイトのタイムゾーン(IANA 名)。
 * 欠けていれば曜日・時間帯の条件は判定できない(対象外)。版 2 は schema-v2.ts で読み、upgradeV2(config-upgrade.ts)で版 3 にする
 */
export const CompiledConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    version: z.number().int().min(1),
    siteId: z.string().min(1),
    siteSalt: z.string().min(1),
    needsProfile: z.boolean(),
    timezone: z.string().min(1).optional(),
    patterns: z.record(z.string(), CompiledPageMatchSchema),
    prehide: z.record(z.string(), z.array(z.string())), // experimentId -> selectors
    exposureSelectors: z.record(z.string(), z.array(z.string())), // experimentId -> selectors
    goals: z.array(GoalSchema),
    experiments: z.array(ExperimentSchema),
    // spec §10.9(決定 32): experimentId → variantId → 解決済み exposure payload。compile が常に出力する。
    // runtime は該当エントリが無ければ experiments[] から導出する(runtime が持つ唯一の導出。B77 で名前は ID)
    exposurePayloads: z.record(z.string(), z.record(z.string(), ExposurePayloadSchema)).optional(),
    // B77(K5): goalId → 解決済み conversion payload(ab_goal_name = 目標の外部計測の名前 ?? ID)。compile はすべての目標について出す
    conversionPayloads: z.record(z.string(), ConversionPayloadSchema).optional(),
    results: ResultsConfigSchema.optional(),
  })
  .superRefine((c, ctx) => {
    refineExposurePayloads(c, ctx);
    refineConversionPayloads(c, ctx);
    // サイト全体の命令数(設計書 §10.2)。compile は上限内しか出さないので、超えるのは手書き・改竄。設定ごと読まない(fail-closed)
    const total = regexInstructionTotal(c);
    if (total > REGEX_LIMITS.instructionsPerSite) ctx.addIssue({ code: "custom", message: `regex instructions ${total} over ${REGEX_LIMITS.instructionsPerSite}` });
  });
export type CompiledConfig = z.infer<typeof CompiledConfigSchema>;
export type PatternDef = z.infer<typeof CompiledPageMatchSchema>;
export type { PageMatch };
