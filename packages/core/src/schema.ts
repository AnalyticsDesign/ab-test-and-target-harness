import { z } from "zod";
import { ExposurePayloadSchema } from "./analytics";
import { PAGE_OPS, PAGE_PARTS, type PageMatch, type PageOp, type PagePart } from "./page";
import { REGEX_LIMITS } from "./regex-compile";
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

export type CtxNode =
  /** url は equals / contains / startsWith(正規表現は path / host だけ) */
  | { ctx: "url"; op: "equals" | "contains" | "startsWith"; value: string }
  | { ctx: "host"; op: "equals" | "endsWith" | "contains" | "regex"; value: string; prog?: RegexProgram }
  | { ctx: "path"; op: "contains" | "equals" | "startsWith" | "regex"; value: string; prog?: RegexProgram }
  | { ctx: "query"; name: string; op: "equals" | "contains"; value: string }
  | { ctx: "query"; name: string; op: "exists" }
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

/** 保存形と配る形で同じ条件(ページ・端末・時刻など) */
const commonCtx = [
  z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("equals"), value: z.string() }),
  z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("contains"), value: z.string().min(1) }),
  z.strictObject({ ctx: z.literal("query"), name: z.string().min(1), op: z.literal("exists") }),
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

/** 配る形の条件(版 2)。url は文字列の一致だけ(正規表現は path / host の命令列) */
const CompiledCtxSchema = z.union([
  z.strictObject({ ctx: z.literal("url"), op: z.enum(["equals", "contains", "startsWith"]), value: matchValue }),
  pageCtx("host", true),
  pageCtx("path", true),
  ...commonCtx,
]);
const CompiledHistSchema = z.union([
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
 * 保存する形の ctx の条件(control が保存し、compile の入力になる)。url の正規表現は形としては受け、regexIssueIn(targeting.ts)が
 * 案内付きで拒否する(保存は 422、compile は CompileError)。閲覧の条件・オーディエンスの参照は targeting.ts
 */
export const StoredCtxSchema = z.union([
  z.strictObject({ ctx: z.literal("url"), op: z.enum(["equals", "contains", "startsWith", "regex"]), value: matchValue }),
  pageCtx("host", false),
  pageCtx("path", false),
  ...commonCtx,
]);
export type StoredCtx = z.infer<typeof StoredCtxSchema>;

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

export const VariantSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
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
  name: z.string().min(1),
  trafficPercentage: z.number().int().min(1).max(100),
  persistAssignment: z.boolean(),
} as const;

export const ExperimentSchema = z
  .strictObject({
    ...ExperimentCommonShape,
    urlMatch: CompiledPageMatchSchema,
    targeting: DslNodeSchema.optional(),
    variants: z.array(VariantSchema).min(2),
  })
  .superRefine(refineVariantWeights);
export type Experiment = z.infer<typeof ExperimentSchema>;

const goalBase = { id: z.string().min(1), name: z.string().min(1) };
const clickGoal = z.strictObject({ ...goalBase, type: z.literal("CLICK"), config: z.strictObject({ selector }) });
const customGoal = z.strictObject({ ...goalBase, type: z.literal("CUSTOM"), config: z.strictObject({}) });

/** 配る形の Goal。PAGEVIEW は `{ page: ページの一致 }`(決定 49。版 1 の `{ urlOp, urlValue }` から名前を付け替えた) */
export const GoalSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...goalBase, type: z.literal("PAGEVIEW"), config: z.strictObject({ page: CompiledPageMatchSchema }) }),
  clickGoal,
  customGoal,
]);
export type Goal = z.infer<typeof GoalSchema>;

/** 保存する形の Goal(control の API と compile の入力) */
export const GoalInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...goalBase, type: z.literal("PAGEVIEW"), config: z.strictObject({ page: PageMatchInputSchema }) }),
  clickGoal,
  customGoal,
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

/** 配る設定に入るすべての命令列の命令数(対象 URL・パターン・目標・配信条件の path / host) */
export function regexInstructionTotal(c: { patterns: Record<string, { prog?: RegexProgram }>; goals: Goal[]; experiments: Array<{ urlMatch: { prog?: RegexProgram }; targeting?: DslNode }> }): number {
  const size = (p?: RegexProgram): number => (p && Array.isArray(p.code) ? p.code.length / 3 : 0);
  const inDsl = (n: DslNode): number =>
    "and" in n ? n.and.reduce((a, x) => a + inDsl(x), 0) : "or" in n ? n.or.reduce((a, x) => a + inDsl(x), 0) : "not" in n ? inDsl(n.not) : "prog" in n ? size(n.prog) : 0;
  let total = 0;
  for (const p of Object.values(c.patterns)) total += size(p.prog);
  for (const g of c.goals) if (g.type === "PAGEVIEW") total += size(g.config.page.prog);
  for (const e of c.experiments) total += size(e.urlMatch.prog) + (e.targeting ? inDsl(e.targeting) : 0);
  return total;
}

/**
 * 版 2 の compiled config(決定 49)。版 1 との差は設計書 §4.3 の表。`timezone` = サイトのタイムゾーン(IANA 名)。
 * 欠けていれば曜日・時間帯の条件は判定できない(対象外)
 */
export const CompiledConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
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
    // runtime は該当エントリが無ければ experiments[] の id / name から導出する(runtime が持つ唯一の導出)
    exposurePayloads: z.record(z.string(), z.record(z.string(), ExposurePayloadSchema)).optional(),
  })
  .superRefine((c, ctx) => {
    refineExposurePayloads(c, ctx);
    // サイト全体の命令数(設計書 §10.2)。compile は上限内しか出さないので、超えるのは手書き・改竄。設定ごと読まない(fail-closed)
    const total = regexInstructionTotal(c);
    if (total > REGEX_LIMITS.instructionsPerSite) ctx.addIssue({ code: "custom", message: `regex instructions ${total} over ${REGEX_LIMITS.instructionsPerSite}` });
  });
export type CompiledConfig = z.infer<typeof CompiledConfigSchema>;
export type PatternDef = z.infer<typeof CompiledPageMatchSchema>;
export type { PageMatch };
