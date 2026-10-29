import { dslNeedsProfile } from "./evaluate";
import {
  CompiledConfig, CompiledConfigSchema, DslNode, Experiment, ExperimentCommonShape, Goal, GoalInputSchema, LIMITS,
  PageMatchInputSchema, PatternDef, ResultsConfigSchema, Variant, VariantSchema, refineVariantWeights,
} from "./schema";
import { ExperimentAnalyticsSchema, VariantAnalyticsSchema, exposurePayloadIssue, resolveConversionPayload, resolveExposurePayload } from "./analytics";
import type { ConversionPayload, ExposurePayload } from "./analytics-defaults";
import { normalizePageMatch, pageMatchIssue, type PageMatchInput } from "./page-normalize";
import { patternIdOf } from "./pattern-id";
import { compileRegex, REGEX_LIMITS } from "./regex-compile";
import { SITE_ID_RE } from "./settings";
import {
  audienceDefinitionIssue, experimentTargetingIssue, findLegacyTargeting, LEGACY_TARGETING_MESSAGE, maxWithinDays,
  normalizeTargeting, TargetingInputSchema, type Targeting,
} from "./targeting";
import { isValidTimeZone } from "./time";
import { z } from "zod";

export type CompileErrorCode =
  | "legacy_targeting"
  | "invalid_experiment_targeting"
  | "invalid_audience_definition"
  | "unknown_audience"
  | "unknown_goal"
  | "within_days_exceeds_retention"
  | "config_too_large"
  | "invalid_input"
  | "invalid_analytics"
  | "invalid_regex"
  | "regex_too_large"
  | "regex_budget_exceeded"
  | "audience_expansion_too_large";

export class CompileError extends Error {
  constructor(public code: CompileErrorCode, message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/**
 * compile 入力の Variant / Experiment = 共有スキーマ + 著者が書く `analytics`(§10.9)。
 * compiled config 側(VariantSchema / ExperimentSchema)には `analytics` を置かない — compile が取り除き、
 * config 内に「生」と「解決済み」を同居させない(残っていれば CompiledConfigSchema の strict が拒否する)。
 * `name` は入力では必須で、出力には出さない(B77、K4。配る形のスキーマでは古い config のために任意)
 */
export const VariantInputSchema = z.strictObject({ ...VariantSchema.shape, name: z.string().min(1), analytics: VariantAnalyticsSchema.optional() });
/** 決定 51(設計書 §3): エクスペリエンスの種別。test = 2 つ以上のパターンに振り分けて比べる、single = パーソナライズ(パターン 1 つ・重み 100) */
export const EXPERIMENT_KINDS = ["test", "single"] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

/** 種別ごとのパターンの数(設計書 §3.1)。重みの合計 100 は refineVariantWeights */
function refineVariantCount(e: { kind: ExperimentKind; variants: unknown[] }, ctx: z.RefinementCtx): void {
  if (e.kind === "single" ? e.variants.length === 1 : e.variants.length >= 2) return;
  ctx.addIssue({ code: "custom", path: ["variants"], message: e.kind === "single" ? "a single experiment must have exactly 1 variant" : "a test must have at least 2 variants" });
}

export const ExperimentInputSchema = z
  .strictObject({
    ...ExperimentCommonShape,
    name: z.string().min(1), // B77(K4): 入力では必須、出力には出さない
    /** 省略は test(既存の入力・fixture を変えない)。compiled config には載せない(設計書 §3.2) */
    kind: z.enum(EXPERIMENT_KINDS).default("test"),
    urlMatch: PageMatchInputSchema,
    targeting: TargetingInputSchema.optional(),
    variants: z.array(VariantInputSchema).min(1),
    analytics: ExperimentAnalyticsSchema.optional(),
  })
  .superRefine((e, ctx) => {
    refineVariantWeights(e, ctx);
    refineVariantCount(e, ctx);
  });
export type ExperimentInput = z.infer<typeof ExperimentInputSchema>;

export const CompileInputSchema = z.strictObject({
  siteId: z.string().regex(SITE_ID_RE),
  siteSalt: z.string().min(1),
  version: z.number().int().min(1),
  /** サイトのタイムゾーン(IANA 名)。曜日・時間帯の条件の判定に使う(決定 49、設計書 §8) */
  timezone: z.string().refine(isValidTimeZone, { message: "timezone must be an IANA time zone name" }).optional(),
  /** 訪問者データの保存期間(日)。期間の条件の N の上限の検査に使う(設計書 §11)。省略したら検査しない(fixture) */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  experiments: z.array(ExperimentInputSchema),
  goals: z.array(GoalInputSchema),
  /** オーディエンスの定義(id → 保存する形の配信条件)。参照されたものだけを、展開の時点で検査する(壊れた未使用のオーディエンスで Publish を止めない) */
  audiences: z.record(z.string(), z.unknown()).default({}),
  /** 結果の収集(D9 ②、設計書 §6.3)。control の publish が足す。compile は形を確かめてそのまま出力に写す */
  results: ResultsConfigSchema.optional(),
});
export type CompileInput = z.infer<typeof CompileInputSchema>;

/**
 * 保存する形のページの一致を配る形に変える: 正規化(§4.1.2)→ 検査(url の正規表現・許可リスト・1 つ 200 命令)→ 正規表現なら命令列を付ける。
 * `budget` に命令数を積む(サイト全体 500 命令の検査用)。`where` は利用者に見せる日本語の場所(Publish の失敗の hint にそのまま出る)
 */
function compileMatch(m: PageMatchInput, where: string, budget: Array<{ where: string; instructions: number }>): PatternDef {
  const n = normalizePageMatch(m);
  const issue = pageMatchIssue(n);
  if (issue) throw new CompileError(issue.code === "regex_too_large" ? "regex_too_large" : "invalid_regex", `${where}: ${issue.message}`);
  if (n.op !== "regex") return n;
  const r = compileRegex(n.value);
  if (!r.ok) throw new CompileError("invalid_regex", `${where}: ${r.issue.message}`); // pageMatchIssue が通した式なので到達しない
  budget.push({ where, instructions: r.instructions });
  return { ...n, prog: r.prog };
}

/** 配信条件のノード数(and / or / not / 条件をすべて 1 つと数える) */
function countNodes(node: Targeting): number {
  if ("and" in node) return 1 + node.and.reduce((a, n) => a + countNodes(n), 0);
  if ("or" in node) return 1 + node.or.reduce((a, n) => a + countNodes(n), 0);
  if ("not" in node) return 1 + countNodes(node.not);
  return 1;
}

/**
 * 形の検査の文言に、保存 422 と同じ直し方(hint)を続ける。Publish の失敗では CompileError の message がそのまま hint に出るため、
 * v0.9 から残った入れ子の配信条件を Publish したときにも「どうすれば」が伝わるようにする(final review Important 1)
 */
function withHint(issue: { message: string; hint?: string }): string {
  return issue.hint ? `${issue.message}。${issue.hint}` : issue.message;
}

export function compile(input: unknown): CompiledConfig {
  // 古い書式(URL パターンの ID を参照する閲覧の条件)は zod より先に見つける(invalid_input に紛れさせない。設計書 §4.1)
  if (typeof input === "object" && input !== null && Array.isArray((input as { experiments?: unknown }).experiments)) {
    for (const e of (input as { experiments: Array<{ id?: unknown; targeting?: unknown } | null> }).experiments) {
      if (e && findLegacyTargeting(e.targeting)) throw new CompileError("legacy_targeting", `エクスペリエンス ${String(e.id)} の配信条件: ${LEGACY_TARGETING_MESSAGE}`);
    }
  }
  const parsed = CompileInputSchema.safeParse(input);
  if (!parsed.success) throw new CompileError("invalid_input", JSON.stringify(parsed.error.issues[0]));
  const { retentionDays, audiences: rawAudiences } = parsed.data;

  const goalIds = new Set(parsed.data.goals.map((g) => g.id));
  const budget: Array<{ where: string; instructions: number }> = [];
  const patterns: Record<string, PatternDef> = {};
  const prehide: Record<string, string[]> = {};
  const exposureSelectors: Record<string, string[]> = {};
  const exposurePayloads: Record<string, Record<string, ExposurePayload>> = {};
  const experiments: Experiment[] = [];
  let needsProfile = false;

  /** オーディエンスの定義(参照されたものを、最初に参照された時点で検査して覚える。設計書 §4.3 の 1)。nodes = 定義のノード数 */
  const audienceCache = new Map<string, { def: Targeting; nodes: number }>();
  const resolveAudience = (id: string, eid: string): { def: Targeting; nodes: number } => {
    const hit = audienceCache.get(id);
    if (hit) return hit;
    if (!Object.prototype.hasOwnProperty.call(rawAudiences, id)) throw new CompileError("unknown_audience", `エクスペリエンス ${eid} の配信条件が参照するオーディエンス ${id} が見つかりません`);
    const raw = rawAudiences[id];
    if (findLegacyTargeting(raw)) throw new CompileError("legacy_targeting", `オーディエンス ${id}: ${LEGACY_TARGETING_MESSAGE}`);
    const p = TargetingInputSchema.safeParse(raw);
    if (!p.success) throw new CompileError("invalid_audience_definition", `オーディエンス ${id} の条件の形が不正です`);
    const def = normalizeTargeting(p.data);
    const issue = audienceDefinitionIssue(def);
    if (issue) throw new CompileError("invalid_audience_definition", `オーディエンス ${id}: ${withHint(issue)}`);
    const entry = { def, nodes: countNodes(def) };
    audienceCache.set(id, entry);
    return entry;
  };

  /**
   * オーディエンスの展開の量(B159、G32)。参照のたびに定義のノード数を足し、展開する前に上限を見る(数千回の参照で、配る設定の
   * 大きさの検査より先に Worker の上限に当たらないように)。refs = オーディエンスごとの参照の回数(超えたときの文言に出す)
   */
  let expanded = 0;
  const refs = new Map<string, number>();
  const countExpansion = (id: string, nodes: number): void => {
    expanded += nodes;
    refs.set(id, (refs.get(id) ?? 0) + 1);
    if (expanded <= LIMITS.audienceExpansionMax) return;
    const top = [...refs]
      .map(([a, k]) => ({ a, k, n: audienceCache.get(a)!.nodes }))
      .sort((x, y) => y.n * y.k - x.n * x.k)
      .slice(0, 5)
      .map((x) => `オーディエンス ${x.a}(条件 ${x.n} 個 × 参照 ${x.k} 回)`)
      .join("、");
    throw new CompileError(
      "audience_expansion_too_large",
      `配信条件のオーディエンスを展開した条件の数の合計が上限を超えます(${expanded} / ${LIMITS.audienceExpansionMax})。多いもの: ${top}。配信条件でのオーディエンスの参照を減らすか、オーディエンスの条件を減らしてください`,
    );
  };

  /**
   * オーディエンスごとの展開の結果(最初の参照で 1 回だけ展開し、以後は同じ DslNode を使い回す)。regexes = 中の ctx の正規表現
   * (場所の文言と命令数)。ctx の正規表現の命令列は参照するエクスペリエンスごとに配る設定へ写るので、参照のたびに budget に積み直す
   * (場所はその参照のエクスペリエンス)。閲覧の条件の正規表現は patterns にパターン ID ごとに 1 回だけ積むので積み直さない。
   * 使い回す DslNode は後の処理(maxWithinDays・dslNeedsProfile・CompiledConfigSchema.parse・JSON 化)が読むだけで書き換えない
   */
  const expansionCache = new Map<string, { node: DslNode; regexes: Array<{ what: string; instructions: number }> }>();

  /**
   * 保存形 → 配る形を 1 回の走査で行う: オーディエンスの参照はその時点の定義に置き換えて(設計書 §4.3 の 1)その中を続けて変換し、
   * 閲覧の条件の page からパターン ID を決める(設計書 §4.3 の 2・§4.4)。via = そのノードが来たオーディエンスの ID(正規表現の場所の
   * 文言に出し、regex_budget_exceeded の hint で原因のオーディエンスが分かるようにする。plan ② P20)。
   * 正規表現の命令数は展開後に出てくるたびに数える(ctx の正規表現の命令列は参照するエクスペリエンスごとに配る設定へ写るため。
   * 閲覧の条件の正規表現は patterns に 1 つだけ載るので、パターン ID ごとに 1 回)
   */
  const toCompiled = (node: Targeting, eid: string, via?: string, regexes?: Array<{ what: string; instructions: number }>): DslNode => {
    const where = (what: string) => `エクスペリエンス ${eid} の${what}${via !== undefined ? `(オーディエンス ${via})` : ""}`;
    if ("and" in node) return { and: node.and.map((n) => toCompiled(n, eid, via, regexes)) };
    if ("or" in node) return { or: node.or.map((n) => toCompiled(n, eid, via, regexes)) };
    if ("not" in node) return { not: toCompiled(node.not, eid, via, regexes) };
    if ("audience" in node) {
      // 定義の中に別の参照は無い(audienceDefinitionIssue が止める)
      const id = node.audience;
      const { def, nodes } = resolveAudience(id, eid);
      countExpansion(id, nodes); // 展開の前に量を見る
      const hit = expansionCache.get(id);
      if (hit) {
        for (const r of hit.regexes) budget.push({ where: `エクスペリエンス ${eid} の${r.what}(オーディエンス ${id})`, instructions: r.instructions });
        return hit.node;
      }
      const found: Array<{ what: string; instructions: number }> = [];
      const compiled = toCompiled(def, eid, id, found);
      expansionCache.set(id, { node: compiled, regexes: found });
      return compiled;
    }
    if ("hist" in node) {
      if (node.hist === "converted") {
        if (!goalIds.has(node.goal)) throw new CompileError("unknown_goal", `エクスペリエンス ${eid} の配信条件が参照する目標 ${node.goal} が見つかりません`);
        return { hist: "converted", goal: node.goal, ...(node.withinDays !== undefined ? { withinDays: node.withinDays } : {}) };
      }
      const id = patternIdOf(node.page);
      patterns[id] ??= compileMatch(node.page, where("閲覧したページの条件"), budget);
      return { hist: "visited", pattern: id, ...(node.min !== undefined && node.min > 1 ? { min: node.min } : {}), ...(node.withinDays !== undefined ? { withinDays: node.withinDays } : {}) };
    }
    if (node.ctx === "url") {
      if (node.op === "regex") compileMatch({ op: "regex", value: node.value }, where("配信条件"), budget); // url の正規表現は必ず invalid_regex
      return node as DslNode;
    }
    if (node.ctx === "host" || node.ctx === "path") {
      const before = budget.length;
      const m = compileMatch({ part: node.ctx, op: node.op, value: node.value }, where("配信条件"), budget);
      if (regexes && budget.length > before) regexes.push({ what: "配信条件", instructions: budget[before]!.instructions });
      return { ctx: node.ctx, op: node.op, value: m.value, ...(m.prog ? { prog: m.prog } : {}) } as DslNode;
    }
    return node as DslNode; // ページ以外の条件(クエリ・端末・時刻など)は保存形と配る形が同じ
  };

  for (const exp of parsed.data.experiments) {
    let targeting: DslNode | undefined;
    if (exp.targeting) {
      const stored = normalizeTargeting(exp.targeting);
      const shape = experimentTargetingIssue(stored);
      if (shape) throw new CompileError("invalid_experiment_targeting", `エクスペリエンス ${exp.id} の配信条件: ${withHint(shape)}`);
      targeting = toCompiled(stored, exp.id);
      const within = maxWithinDays(targeting); // 展開した後の期間(配る形でも withinDays は同じ)
      if (retentionDays !== undefined && within > retentionDays)
        throw new CompileError("within_days_exceeds_retention", `エクスペリエンス ${exp.id} の配信条件の期間(${within} 日)が、訪問者データの保存期間(${retentionDays} 日)を超えています`);
    }
    if (targeting && dslNeedsProfile(targeting)) needsProfile = true;
    if (exp.persistAssignment) needsProfile = true;

    // 全 Variant の Change セレクタの和集合(spec §6.3: prehide / exposureSelectors)
    const selectors: string[] = [];
    let selectorless = false; // CSS など selector を持たない Change があるか
    for (const v of exp.variants) {
      for (const c of v.changes) {
        if ("selector" in c && c.selector) {
          if (!selectors.includes(c.selector)) selectors.push(c.selector);
        } else {
          selectorless = true;
        }
      }
    }
    prehide[exp.id] = selectors;
    const noChanges = exp.variants.every((v) => v.changes.length === 0); // A/A(全パターンの Change が 0 件)
    // spec §10.5 / 決定 38 (1): selector を持たない Change は注入した瞬間に適用成功になる。対照 Variant にも同じ瞬間
    // (= 起動直後)に Exposure させるため、常に存在する :root を exposureSelectors にだけ足す(prehide に足すと全画面が隠れる)。
    // 運用者が selector として :root を使っていれば二重にしない
    // A/A のテスト(全パターンの Change が 0 件)も起動直後に Exposure させる。今までは selector が空で ab_exposure が出なかった(D9 ② K20)
    exposureSelectors[exp.id] = (selectorless || (noChanges && exp.kind === "test")) && !selectors.includes(":root") ? [...selectors, ":root"] : selectors;

    // spec §10.9: Experiment × Variant ごとに合成・検証し exposurePayloads に焼く。著者の analytics は出力から取り除く
    const byVariant: Record<string, ExposurePayload> = {};
    const variants: Variant[] = [];
    for (const v of exp.variants) {
      const payload = resolveExposurePayload(exp, v);
      const issue = exposurePayloadIssue(payload);
      if (issue) throw new CompileError("invalid_analytics", `experiment ${exp.id} variant ${v.id}: ${issue}`);
      byVariant[v.id] = payload;
      // B77: 名前は管理画面の中だけで使い、訪問者に届けない(dataLayer の名前は exposurePayloads だけが持つ)
      const { analytics: _variantAnalytics, name: _variantName, ...variant } = v;
      variants.push(variant);
    }
    exposurePayloads[exp.id] = byVariant;
    const { analytics: _experimentAnalytics, variants: _authored, targeting: _input, urlMatch, kind: _kind, name: _experimentName, ...rest } = exp;
    experiments.push({ ...rest, urlMatch: compileMatch(urlMatch, `エクスペリエンス ${exp.id} の対象 URL`, budget), ...(targeting ? { targeting } : {}), variants });
  }

  // B77(K5): 目標も名前と著者の analytics を取り除き、dataLayer の名前は conversionPayloads に焼く(すべての目標について出す)
  const conversionPayloads: Record<string, ConversionPayload> = {};
  const goals: Goal[] = parsed.data.goals.map((g) => {
    conversionPayloads[g.id] = resolveConversionPayload(g);
    const { name: _goalName, analytics: _goalAnalytics, ...goal } = g;
    return goal.type === "PAGEVIEW" ? { ...goal, config: { page: compileMatch(goal.config.page, `目標 ${g.id}`, budget) } } : goal;
  });

  // サイト全体の命令数(設計書 §10.2)。hint に大きいものから並べる
  const total = budget.reduce((a, b) => a + b.instructions, 0);
  if (total > REGEX_LIMITS.instructionsPerSite) {
    const top = [...budget].sort((a, b) => b.instructions - a.instructions).slice(0, 5).map((b) => `${b.where}(${b.instructions})`).join("、");
    throw new CompileError("regex_budget_exceeded", `正規表現の命令の数の合計 ${total} / ${REGEX_LIMITS.instructionsPerSite}。大きいもの: ${top}`);
  }

  const config: CompiledConfig = {
    schemaVersion: 2,
    version: parsed.data.version,
    siteId: parsed.data.siteId,
    siteSalt: parsed.data.siteSalt,
    needsProfile,
    ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
    patterns,
    prehide,
    exposureSelectors,
    goals,
    experiments,
    exposurePayloads,
    conversionPayloads,
    ...(parsed.data.results !== undefined ? { results: parsed.data.results } : {}),
  };
  const out = CompiledConfigSchema.parse(config);
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes > LIMITS.configMaxBytes) {
    throw new CompileError("config_too_large", `compiled config is ${bytes} bytes (max ${LIMITS.configMaxBytes})`);
  }
  return out;
}
