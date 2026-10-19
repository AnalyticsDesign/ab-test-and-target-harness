// 評価時点と収集の締め切り。時刻はすべて UTC のミリ秒(表示は Site のタイムゾーン)。

import type { EvaluationPlan } from "./evaluation-plan";

const DAY_MS = 24 * 60 * 60 * 1000;

type PlanTiming = Pick<EvaluationPlan, "minDays" | "maxWeeks" | "targetPerVariant">;

export type EvaluationPoint = {
  /** 最低期間の終わり = startedAt + minDays 日。 */
  minEnd: number;
  /** 最大期間の終わり = startedAt + maxWeeks 週。 */
  maxEnd: number;
  /** 評価時点。評価時点の前に終了したときは終了の時刻。 */
  evaluationAt: number;
  /** 評価時点より前に終了したか。 */
  stoppedEarly: boolean;
};

/**
 * 評価時点を求める。
 *  - 目標参加者数が無い: minEnd
 *  - ある: 到達していれば min(max(minEnd, reachedAt), maxEnd)、未到達なら maxEnd
 *  - 終了(stoppedAt)がこの評価時点より前なら、終了の時刻を評価時点とし stoppedEarly = true
 *    (ちょうど同じ時刻は早期終了ではない)
 * reachedAt = 全対象パターンが目標参加者数に届いた時刻(参加の exposed_at の最も遅いもの)。呼ぶ側が求めて渡す。
 * 目標参加者数が無いときは reachedAt を無視する。
 */
export function evaluationPoint(
  plan: PlanTiming, startedAt: number, reachedAt: number | null, stoppedAt: number | null,
): EvaluationPoint {
  const minEnd = startedAt + plan.minDays * DAY_MS;
  const maxEnd = startedAt + plan.maxWeeks * 7 * DAY_MS;
  let at: number;
  if (plan.targetPerVariant === null) at = minEnd;
  else if (reachedAt === null) at = maxEnd;
  else at = Math.min(Math.max(minEnd, reachedAt), maxEnd);
  const stoppedEarly = stoppedAt !== null && stoppedAt < at;
  return { minEnd, maxEnd, evaluationAt: stoppedEarly ? stoppedAt : at, stoppedEarly };
}

/**
 * 収集の締め切り(この時刻以降の参加・CV は書かない)。評価時点と同じ値:
 * 目標なし = minEnd、目標あり未到達 = maxEnd、到達 = min(max(minEnd, reachedAt), maxEnd)、評価時点前の終了 = stoppedAt。
 * 目標ありの開始直後は maxEnd で、到達を記録したら書き直す。
 */
export function collectUntilFor(
  plan: PlanTiming, startedAt: number, reachedAt: number | null, stoppedAt: number | null,
): number {
  return evaluationPoint(plan, startedAt, reachedAt, stoppedAt).evaluationAt;
}
