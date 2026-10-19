// 評価計画: 型・既定値・入力の検査・開始後に変えてよい向き。依存なし(zod を使わない)。
// API の受け口の zod は control 側に置き、範囲の規則(planIssues)は両方から同じものを使う。

/**
 * 集計の定義。利用者は変えない(表示のみ)。結果の記録にも同じものを写す。
 * 将来の数え方(参加後 N 日の窓、割り振りの分母など)は version を上げて足す。
 */
export type EvaluationDefinition = {
  version: 1;
  /** 数える期間。until_end = 参加から評価時点(か終了)まで。 */
  observationWindow: { kind: "until_end" };
  /** 分母。displayed = テスト対象の要素が表示された人(適用の成否は問わない)。 */
  denominator: "displayed";
  /** 複数のパターンを見た人。keep_first = 最初のパターンに数え、件数を品質に出す。 */
  mixed: "keep_first";
  model: { name: "beta-binomial"; prior: [number, number]; version: 1 };
};

export type EvaluationPlan = {
  /** 判定に使う目標。結果を記録するテストの開始までに必須(開始の検査は control)。 */
  primaryGoalId: string | null;
  /** 基準のパターン。 */
  baselineVariantId: string | null;
  /** 最低期間(日)。 */
  minDays: number;
  /** 最大期間(週)。 */
  maxWeeks: number;
  /** パターンごとの目標参加者数。null = 設けない。 */
  targetPerVariant: number | null;
  /** 最小改善幅(ポイント)。 */
  delta: number;
  /** 同等とみなす幅(ポイント)。null = 設けない。 */
  rope: number | null;
  /** 確率のしきい値(%)。比較の回数 m で引き上げて使う(effectiveThreshold)。 */
  threshold: number;
  definition: EvaluationDefinition;
};

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v !== null && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

/** 既定値。共有の参照なので凍結してある(使うときは `{ ...DEFAULT_PLAN, primaryGoalId, baselineVariantId }`)。 */
export const DEFAULT_PLAN: Omit<EvaluationPlan, "primaryGoalId" | "baselineVariantId"> = deepFreeze({
  minDays: 14,
  maxWeeks: 8,
  targetPerVariant: null,
  delta: 0,
  rope: null,
  threshold: 95,
  definition: {
    version: 1,
    observationWindow: { kind: "until_end" },
    denominator: "displayed",
    mixed: "keep_first",
    model: { name: "beta-binomial", prior: [1, 1], version: 1 },
  },
});

/**
 * 基準の既定値: `original` のパターンの中で position が最小のもの。無ければ position が最小のパターン。
 * パターンが無ければ null。入力の配列は並べ替えない。
 */
export function defaultBaseline(variants: Array<{ id: string; position: number; original?: boolean }>): string | null {
  const first = (list: typeof variants) =>
    list.reduce<(typeof variants)[number] | null>((best, v) => (best === null || v.position < best.position ? v : best), null);
  return (first(variants.filter((v) => v.original === true)) ?? first(variants))?.id ?? null;
}

export type PlanIssue = { path: string; code: "range" | "unknown"; message: string };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function sameDefinition(a: EvaluationDefinition, b: EvaluationDefinition): boolean {
  return a.version === b.version
    && a.observationWindow.kind === b.observationWindow.kind
    && a.denominator === b.denominator
    && a.mixed === b.mixed
    && a.model.name === b.model.name
    && a.model.version === b.model.version
    && a.model.prior[0] === b.model.prior[0]
    && a.model.prior[1] === b.model.prior[1];
}

/**
 * 入力の制約(範囲と存在)。違反をすべて返す。空なら受けられる。
 *  - 範囲: しきい値 90〜99.9・最大期間 2〜26 週(整数)・最低期間 1 日〜最大期間(整数)・
 *    目標参加者数 100 以上の整数か null・最小改善幅 0 以上・ROPE は 0 より大きいか null・集計の定義は既定のまま
 *  - 存在: 目標は Site の目標、基準はこのテストのパターン(null は下書きの未設定として通す。必須の検査は開始)
 * 整数を求めるのは、日数・週数は画面で整数を選ぶことと、人数は SQL の OFFSET(target − 1)に使うため。
 */
export function planIssues(plan: EvaluationPlan, ctx: { variantIds: string[]; goalIds: string[] }): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const range = (path: string, message: string) => issues.push({ path, code: "range", message });

  if (plan.primaryGoalId !== null && !ctx.goalIds.includes(plan.primaryGoalId)) {
    issues.push({ path: "primaryGoalId", code: "unknown", message: "判定に使う目標が、この Site にありません" });
  }
  if (plan.baselineVariantId !== null && !ctx.variantIds.includes(plan.baselineVariantId)) {
    issues.push({ path: "baselineVariantId", code: "unknown", message: "基準のパターンが、このテストにありません" });
  }
  const maxOk = isInt(plan.maxWeeks) && plan.maxWeeks >= 2 && plan.maxWeeks <= 26;
  if (!maxOk) range("maxWeeks", "最大期間は 2〜26 週の整数で指定してください");
  if (!isInt(plan.minDays) || plan.minDays < 1) {
    range("minDays", "最低期間は 1 日以上の整数で指定してください");
  } else if (maxOk && plan.minDays > plan.maxWeeks * 7) {
    range("minDays", "最低期間は最大期間以下にしてください");
  }
  if (plan.targetPerVariant !== null && !(isInt(plan.targetPerVariant) && plan.targetPerVariant >= 100)) {
    range("targetPerVariant", "目標参加者数は 100 人以上の整数で指定してください");
  }
  if (!isNum(plan.delta) || plan.delta < 0) range("delta", "最小改善幅は 0 以上のポイントで指定してください");
  if (plan.rope !== null && !(isNum(plan.rope) && plan.rope > 0)) {
    range("rope", "同等とみなす幅は 0 より大きいポイントで指定してください");
  }
  if (!isNum(plan.threshold) || plan.threshold < 90 || plan.threshold > 99.9) {
    range("threshold", "確率のしきい値は 90〜99.9 の範囲で指定してください");
  }
  if (!sameDefinition(plan.definition, DEFAULT_PLAN.definition)) {
    range("definition", "集計の定義は変更できません");
  }
  return issues;
}

export type PlanCaution = {
  key: "min_days_short" | "min_days_very_short" | "threshold_low" | "no_target";
  params?: Record<string, number>;
};

/**
 * 注意(止めない)。評価計画のタブで出す。
 *  - 最低期間が 7 日未満は min_days_very_short、7〜13 日は min_days_short(重ねて出さない)
 *  - しきい値が 95 未満は threshold_low
 *  - 目標参加者数が無ければ no_target
 */
export function planCautions(plan: EvaluationPlan): PlanCaution[] {
  const out: PlanCaution[] = [];
  if (plan.minDays < 7) out.push({ key: "min_days_very_short", params: { minDays: plan.minDays } });
  else if (plan.minDays < 14) out.push({ key: "min_days_short", params: { minDays: plan.minDays } });
  if (plan.threshold < 95) out.push({ key: "threshold_low", params: { threshold: plan.threshold } });
  if (plan.targetPerVariant === null) out.push({ key: "no_target" });
  return out;
}

/**
 * 開始後の変更で、延ばす向き以外に変わった項目の名前(項目の並び順)。空なら受ける。
 * 受ける向き: 最低期間・最大期間を増やす(同じ値も可)、目標参加者数を増やす・新しく設ける。
 * それ以外の項目(目標・基準・δ・ROPE・しきい値・定義)は 1 つでも変われば名前を返す。
 */
export function extensionIssues(before: EvaluationPlan, after: EvaluationPlan): string[] {
  const out: string[] = [];
  if (before.primaryGoalId !== after.primaryGoalId) out.push("primaryGoalId");
  if (before.baselineVariantId !== after.baselineVariantId) out.push("baselineVariantId");
  if (!(after.minDays >= before.minDays)) out.push("minDays");
  if (!(after.maxWeeks >= before.maxWeeks)) out.push("maxWeeks");
  if (before.targetPerVariant !== null && !(after.targetPerVariant !== null && after.targetPerVariant >= before.targetPerVariant)) {
    out.push("targetPerVariant");
  }
  if (before.delta !== after.delta) out.push("delta");
  if (before.rope !== after.rope) out.push("rope");
  if (before.threshold !== after.threshold) out.push("threshold");
  if (!sameDefinition(before.definition, after.definition)) out.push("definition");
  return out;
}
