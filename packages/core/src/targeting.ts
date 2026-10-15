/**
 * 保存する形の配信条件(決定 49、設計書 §4.1 / §4.1.1 / §4.2 / §4.5 / §5)。control が保存し API で読み書きする形と、その検査。
 * zod(TargetingInputSchema)は形だけを見て、意味の検査(エクスペリエンスの形の制限・入れ子・参照・期間・古い書式)は関数で行う。
 * control の保存(422)・compile(Publish の ok: false)・管理画面が同じ関数を使う。runtime には入れない
 */
import { z } from "zod";
import { normalizePageMatch, pageMatchIssue, type PageMatchInput } from "./page-normalize";
import type { RegexIssue } from "./regex-compile";
import { LIMITS, PageMatchInputSchema, StoredCtxSchema, dslDepth, type StoredCtx } from "./schema";

export type Path = Array<string | number>;
export type VisitedInput = { hist: "visited"; page: PageMatchInput; min?: number; withinDays?: number };
export type ConvertedInput = { hist: "converted"; goal: string; withinDays?: number };
export type AudienceRef = { audience: string };
export type TargetingLeaf = StoredCtx | VisitedInput | ConvertedInput | AudienceRef;
export type Targeting = TargetingLeaf | { and: Targeting[] } | { or: Targeting[] } | { not: Targeting };

const withinDays = z.number().int().min(1).max(3650);
const StoredHistSchema = z.union([
  /** 閲覧の条件。min は 2 以上のときだけ保存する(1 は省く)。withinDays = 最後の閲覧が N 日以内(否定なら過去 N 日に閲覧していない) */
  z.strictObject({ hist: z.literal("visited"), page: PageMatchInputSchema, min: z.number().int().min(1).optional(), withinDays: withinDays.optional() }),
  z.strictObject({ hist: z.literal("converted"), goal: z.string().min(1), withinDays: withinDays.optional() }),
]);
/** オーディエンスの参照(エクスペリエンスの配信条件だけで使える。オーディエンスの中では audienceDefinitionIssue が止める) */
const AudienceRefSchema = z.strictObject({ audience: z.string().min(1).max(64) });

const TargetingBase: z.ZodType<Targeting> = z.lazy(() =>
  z.union([
    StoredCtxSchema,
    StoredHistSchema,
    AudienceRefSchema,
    z.strictObject({ and: z.array(TargetingBase).min(1) }),
    z.strictObject({ or: z.array(TargetingBase).min(1) }),
    z.strictObject({ not: TargetingBase }),
  ]),
) as z.ZodType<Targeting>;

/** 保存する形の DSL(形だけ)。深さの上限はここでは配る形と同じ 16 で止め(深すぎる入力を早く断る)、3 / 11 は意味の検査で理由付きにする */
export const TargetingInputSchema = TargetingBase.superRefine((node, ctx) => {
  if (dslDepth(node) > LIMITS.dslDepthMax) ctx.addIssue({ code: "custom", message: `dsl depth over ${LIMITS.dslDepthMax}` });
});

export const LEGACY_TARGETING_MESSAGE = "URL パターンを参照する古い書式の条件です";
export const LEGACY_TARGETING_HINT =
  '閲覧したページの条件は、ページの一致を直接書く形に書き換えてください(例: { "hist": "visited", "page": { "part": "path", "op": "startsWith", "value": "/pricing/" } })';

const isGroup = (n: Targeting): n is { and: Targeting[] } | { or: Targeting[] } => "and" in n || "or" in n;
function children(n: Targeting): Array<[Targeting, Path]> {
  if ("and" in n) return n.and.map((c, i): [Targeting, Path] => [c, ["and", i]]);
  if ("or" in n) return n.or.map((c, i): [Targeting, Path] => [c, ["or", i]]);
  if ("not" in n) return [[n.not, ["not"]]];
  return [];
}

/** 型を問わず JSON の DSL をたどる(D1 に残った古い書式・壊れた値でも落ちない) */
function walkUnknown(raw: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (typeof raw !== "object" || raw === null) return;
  const n = raw as Record<string, unknown>;
  visit(n);
  for (const key of ["and", "or"]) if (Array.isArray(n[key])) for (const c of n[key] as unknown[]) walkUnknown(c, visit);
  if ("not" in n) walkUnknown(n.not, visit);
}

/**
 * 古い書式(URL パターンの ID を参照する `visited` / `page_view_count`)の位置。zod の形の検査より先に呼ぶ(黙って無視すると全員に
 * 配信されるので、`invalid_input` / `validation_failed` に紛れさせず `legacy_targeting` で止める。設計書 §4.1)
 */
export function findLegacyTargeting(raw: unknown, at: Path = []): Path | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  for (const key of ["and", "or"] as const) {
    if (!Array.isArray(n[key])) continue;
    for (const [i, c] of (n[key] as unknown[]).entries()) {
      const p = findLegacyTargeting(c, [...at, key, i]);
      if (p) return p;
    }
    return null;
  }
  if ("not" in n) return findLegacyTargeting(n.not, [...at, "not"]);
  return (n.hist === "visited" || n.hist === "page_view_count") && "pattern" in n ? at : null;
}

/**
 * 保存時の正規化(設計書 §4.1・§4.1.1): 子が 1 つのグループを畳む・not(not(x)) を x に・min: 1 を省く・閲覧の条件の page を
 * normalizePageMatch(part: url を省く・ホストとパスの値)・ホストとパスの条件の値。control は保存の前に、compile は入口で通す
 */
export function normalizeTargeting(node: Targeting): Targeting {
  if (isGroup(node)) {
    const key = "and" in node ? "and" : "or";
    const kids = ("and" in node ? node.and : node.or).map(normalizeTargeting);
    return kids.length === 1 ? kids[0]! : ({ [key]: kids } as Targeting);
  }
  if ("not" in node) {
    const inner = normalizeTargeting(node.not);
    return "not" in inner ? inner.not : { not: inner };
  }
  if ("hist" in node && node.hist === "visited")
    return {
      hist: "visited",
      page: normalizePageMatch(node.page),
      ...(node.min !== undefined && node.min > 1 ? { min: node.min } : {}),
      ...(node.withinDays !== undefined ? { withinDays: node.withinDays } : {}),
    };
  if ("ctx" in node && (node.ctx === "host" || node.ctx === "path")) return { ...node, value: normalizePageMatch({ part: node.ctx, op: node.op, value: node.value }).value } as Targeting;
  return node;
}

/** 正規表現の検査(ページの URL / パス / ホストの条件と、閲覧の条件の page)。最初の 1 つと DSL の中の位置(値の欄まで) */
export function regexIssueIn(node: Targeting, at: Path = []): { issue: RegexIssue; path: Path } | null {
  for (const [c, p] of children(node)) {
    const found = regexIssueIn(c, [...at, ...p]);
    if (found) return found;
  }
  if ("ctx" in node && (node.ctx === "url" || node.ctx === "host" || node.ctx === "path") && node.op === "regex") {
    const issue = pageMatchIssue({ ...(node.ctx === "url" ? {} : { part: node.ctx }), op: "regex", value: node.value });
    return issue ? { issue, path: [...at, "value"] } : null;
  }
  if ("hist" in node && node.hist === "visited") {
    const issue = pageMatchIssue(node.page);
    return issue ? { issue, path: [...at, "page", "value"] } : null;
  }
  return null;
}

/**
 * 否定の形を持つ条件か(設計書 §4.1.1 の対応表。画面の「含まない」「いずれでもない」「未達成」「含まれない」など)。
 * 持たない条件(画面の幅・曜日と時間帯・初回の訪問からの経過・で始まる・で終わる など)の not は、エクスペリエンスの配信条件では使えない
 */
export function hasNegatedForm(n: TargetingLeaf): boolean {
  if ("audience" in n) return true;
  if ("hist" in n) return n.hist === "converted" || n.min === undefined;
  switch (n.ctx) {
    case "url":
      return n.op === "contains" || n.op === "equals";
    case "path":
      return n.op === "contains" || n.op === "equals" || n.op === "regex";
    case "host":
      return n.op === "equals" || n.op === "regex";
    case "query":
      return n.op === "equals" || n.op === "exists";
    case "device":
    case "browser":
    case "os":
      return true;
    case "referrer":
      return n.op === "contains" || n.op === "isEmpty";
    default:
      return false;
  }
}

export type TargetingIssue = { code: "invalid_experiment_targeting" | "invalid_audience_definition"; path: Path; message: string; hint?: string };

const EXPERIMENT_HINT = "入れ子のグループやグループの除外が要るときは、オーディエンスで作って配信条件で選んでください";
const NEGATED_MIN = "閲覧していない条件には回数を指定できません";

/**
 * エクスペリエンスの配信条件の形の制限(設計書 §4.2): 条件 1 つ / 否定の形を持つ条件の not / and・or の下に「条件」か
 * 「否定の形を持つ条件の not」が並ぶ形だけ。画面のフォーム(1 段の and / or)が表せない配信条件を作らせない(決定 34 の同等性)
 */
export function experimentTargetingIssue(node: Targeting): TargetingIssue | null {
  const bad = (path: Path, message: string): TargetingIssue => ({ code: "invalid_experiment_targeting", path, message, hint: EXPERIMENT_HINT });
  const leaf = (n: Targeting, path: Path): TargetingIssue | null => {
    if (isGroup(n)) return bad(path, "配信条件ではグループを入れ子にできません");
    if (!("not" in n)) return null;
    const inner = n.not;
    if (isGroup(inner) || "not" in inner) return bad(path, "配信条件ではグループを除外できません");
    if ("hist" in inner && inner.hist === "visited" && inner.min !== undefined) return bad([...path, "not", "min"], NEGATED_MIN);
    return hasNegatedForm(inner) ? null : bad(path, "この条件は否定の形では使えません");
  };
  if (isGroup(node)) {
    for (const [c, p] of children(node)) {
      const issue = leaf(c, p);
      if (issue) return issue;
    }
  } else {
    const issue = leaf(node, []);
    if (issue) return issue;
  }
  // 形の制限で深さ 3 に収まるはずだが、念のため検査する(設計書 §4.5。plan ② P5)
  return dslDepth(node) > LIMITS.experimentDepthMax ? bad([], "配信条件の入れ子が深すぎます") : null;
}

/**
 * 画面がグループとして開くノードか(入れ子の段数に数える。plan ② P5): and / or と、否定の形を持たない条件の not
 * (`not(time)`・`not(viewport)`・`not(path startsWith)`・`not(host endsWith)` など。画面は子 1 つの除外したグループとして開く。設計書 §4.1.1)。
 * `not(and|or)` は中の and / or で 1 つと数える(not そのものは数えない)
 */
function opensAsGroup(n: Targeting): boolean {
  if (isGroup(n)) return true;
  if (!("not" in n)) return false;
  const inner = n.not;
  return !isGroup(inner) && !("not" in inner) && !hasNegatedForm(inner);
}

/**
 * オーディエンスの定義の検査(設計書 §4.5・§5.5): DSL の深さ 11・グループの入れ子(一番外側の中に 4 段)・別のオーディエンスの参照の禁止・
 * 否定した閲覧の回数の禁止。入れ子は画面がグループとして開くノード(opensAsGroup)の数で数える(画面の nestLevels と同じ結果)。
 * DSL の一番外側がグループでなければ、画面は一番外側を補うので 1 つ少なく数える
 */
export function audienceDefinitionIssue(node: Targeting): TargetingIssue | null {
  const bad = (path: Path, message: string, hint?: string): TargetingIssue => ({ code: "invalid_audience_definition", path, message, ...(hint ? { hint } : {}) });
  if (dslDepth(node) > LIMITS.audienceDepthMax) return bad([], "条件の入れ子が深すぎます");
  const nestLimit = isGroup(node) ? LIMITS.audienceNestMax + 1 : LIMITS.audienceNestMax;
  const walk = (n: Targeting, path: Path, groups: number): TargetingIssue | null => {
    if ("audience" in n) return bad(path, "オーディエンスの中では、別のオーディエンスを使えません", "既存のオーディエンスの条件は、作成画面の「既存のオーディエンスから取り込む」でコピーできます");
    if ("not" in n && "hist" in n.not && n.not.hist === "visited" && n.not.min !== undefined) return bad([...path, "not", "min"], NEGATED_MIN);
    const g = opensAsGroup(n) ? groups + 1 : groups;
    if (g > nestLimit) return bad(path, `グループの入れ子は、一番外側の中に ${LIMITS.audienceNestMax} 段までです`);
    for (const [c, p] of children(n)) {
      const issue = walk(c, [...path, ...p], g);
      if (issue) return issue;
    }
    return null;
  };
  return walk(node, [], 0);
}

/** 期間の条件の最大の N(日)。無ければ 0。保存する形・配る形・古い書式のどれでもたどれる */
export function maxWithinDays(raw: unknown): number {
  let max = 0;
  walkUnknown(raw, (n) => {
    if ("hist" in n && typeof n.withinDays === "number" && n.withinDays > max) max = n.withinDays;
  });
  return max;
}

/** 参照している Goal とオーディエンス(重複なし・出現順)。削除の保護と保存時の存在の検査に使う */
export function targetingReferences(raw: unknown): { goals: string[]; audiences: string[] } {
  const goals: string[] = [];
  const audiences: string[] = [];
  walkUnknown(raw, (n) => {
    if (typeof n.audience === "string" && !audiences.includes(n.audience)) audiences.push(n.audience);
    if (n.hist === "converted" && typeof n.goal === "string" && !goals.includes(n.goal)) goals.push(n.goal);
  });
  return { goals, audiences };
}

/** その種類の ctx の条件を使っているか(例: 画面の幅。Publish の確認画面の案内に使う) */
export function usesCondition(raw: unknown, ctx: string): boolean {
  let hit = false;
  walkUnknown(raw, (n) => {
    if (n.ctx === ctx) hit = true;
  });
  return hit;
}

/** オーディエンスの参照をその時点の定義で置き換える(設計書 §4.3 の 1)。resolve は見つからなければ throw する */
export function expandAudiences(node: Targeting, resolve: (id: string) => Targeting): Targeting {
  if ("audience" in node) return resolve(node.audience);
  if ("and" in node) return { and: node.and.map((c) => expandAudiences(c, resolve)) };
  if ("or" in node) return { or: node.or.map((c) => expandAudiences(c, resolve)) };
  if ("not" in node) return { not: expandAudiences(node.not, resolve) };
  return node;
}
