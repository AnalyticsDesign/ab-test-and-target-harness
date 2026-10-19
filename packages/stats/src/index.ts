// @wtt/stats — テスト結果の統計(依存なし・乱数なし・純粋関数)。control(API)と admin(評価計画の補助計算)が使う。
// runtime には入れない。

/** 計算の版。結果の記録に残す(式や数値積分の設定を変えたら上げる)。 */
export const STATS_VERSION = "1";

export { CLOSED_FORM_MAX_TERMS, NUMERIC_BELOW, diffNormal, diffSummary, probBeat, probBest } from "./compare";
export type { Arm, DiffSummary } from "./compare";
export { betaInterval, INTERVAL_NORMAL_FROM } from "./interval";
export { srm } from "./srm";
export { effectiveThreshold, sampleSize } from "./sample-size";
export { DEFAULT_PLAN, defaultBaseline, extensionIssues, planCautions, planIssues } from "./evaluation-plan";
export type { EvaluationDefinition, EvaluationPlan, PlanCaution, PlanIssue } from "./evaluation-plan";
export { collectUntilFor, evaluationPoint } from "./evaluation-point";
export type { EvaluationPoint } from "./evaluation-point";
export { NOTE_KEYS } from "./notes";
export type { Note, NoteKey } from "./notes";
export { STOP_LIMIT_K, STOP_LIMIT_MAX, stopRatioLimit, strictestCvCount, verdict } from "./verdict";
export type { VerdictInput, VerdictOutput, VerdictState } from "./verdict";
