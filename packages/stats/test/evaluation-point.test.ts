import { describe, expect, test } from "vitest";
import { DEFAULT_PLAN, collectUntilFor, evaluationPoint, type EvaluationPlan } from "../src/index";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 1);
const base: EvaluationPlan = { ...DEFAULT_PLAN, primaryGoalId: "g", baselineVariantId: "a" }; // 14 日 / 8 週
const withTarget: EvaluationPlan = { ...base, targetPerVariant: 500 };
const MIN_END = START + 14 * DAY;
const MAX_END = START + 56 * DAY;

describe("evaluationPoint の各場合", () => {
  test("目標なし = minEnd(minEnd / maxEnd も返す)", () => {
    expect(evaluationPoint(base, START, null, null)).toEqual({
      minEnd: MIN_END, maxEnd: MAX_END, evaluationAt: MIN_END, stoppedEarly: false,
    });
  });
  test("目標なしなら reachedAt が渡されても無視する", () => {
    expect(evaluationPoint(base, START, START + 20 * DAY, null).evaluationAt).toBe(MIN_END);
  });
  test("到達 = max(minEnd, reachedAt)(最低期間より前に届いたら minEnd)", () => {
    expect(evaluationPoint(withTarget, START, START + 3 * DAY, null).evaluationAt).toBe(MIN_END);
    expect(evaluationPoint(withTarget, START, START + 20 * DAY, null).evaluationAt).toBe(START + 20 * DAY);
    expect(evaluationPoint(withTarget, START, MIN_END, null).evaluationAt).toBe(MIN_END);
  });
  test("到達が maxEnd より後なら maxEnd", () => {
    expect(evaluationPoint(withTarget, START, START + 70 * DAY, null).evaluationAt).toBe(MAX_END);
  });
  test("未到達 = maxEnd", () => {
    expect(evaluationPoint(withTarget, START, null, null).evaluationAt).toBe(MAX_END);
  });
  test("終了が評価時点の前 = stoppedAt・stoppedEarly true", () => {
    const early = START + 5 * DAY;
    expect(evaluationPoint(base, START, null, early)).toEqual({
      minEnd: MIN_END, maxEnd: MAX_END, evaluationAt: early, stoppedEarly: true,
    });
    expect(evaluationPoint(withTarget, START, null, START + 30 * DAY)).toMatchObject({ evaluationAt: START + 30 * DAY, stoppedEarly: true });
  });
  test("終了が評価時点の後 = evaluationAt のまま・stoppedEarly false", () => {
    expect(evaluationPoint(base, START, null, MIN_END + DAY)).toMatchObject({ evaluationAt: MIN_END, stoppedEarly: false });
    expect(evaluationPoint(withTarget, START, START + 20 * DAY, START + 30 * DAY)).toMatchObject({ evaluationAt: START + 20 * DAY, stoppedEarly: false });
  });
  test("終了が評価時点とちょうど同じ時刻なら早期終了ではない", () => {
    expect(evaluationPoint(base, START, null, MIN_END)).toMatchObject({ evaluationAt: MIN_END, stoppedEarly: false });
  });
  test("期間は UTC のミリ秒で、週は 7 日", () => {
    const p = { ...base, minDays: 3, maxWeeks: 2 };
    expect(evaluationPoint(p, 0, null, null)).toMatchObject({ minEnd: 3 * DAY, maxEnd: 14 * DAY });
  });
});

describe("collectUntilFor の各場合", () => {
  test("目標なし = minEnd", () => {
    expect(collectUntilFor(base, START, null, null)).toBe(MIN_END);
  });
  test("目標あり未到達 = maxEnd", () => {
    expect(collectUntilFor(withTarget, START, null, null)).toBe(MAX_END);
  });
  test("到達 = min(max(minEnd, reachedAt), maxEnd)", () => {
    expect(collectUntilFor(withTarget, START, START + 3 * DAY, null)).toBe(MIN_END);
    expect(collectUntilFor(withTarget, START, START + 20 * DAY, null)).toBe(START + 20 * DAY);
    expect(collectUntilFor(withTarget, START, START + 70 * DAY, null)).toBe(MAX_END);
  });
  test("評価時点前の終了 = stoppedAt(目標の有無・到達の有無に依らず)", () => {
    expect(collectUntilFor(base, START, null, START + 2 * DAY)).toBe(START + 2 * DAY);
    expect(collectUntilFor(withTarget, START, null, START + 2 * DAY)).toBe(START + 2 * DAY);
    expect(collectUntilFor(withTarget, START, START + 20 * DAY, START + 10 * DAY)).toBe(START + 10 * DAY);
  });
  test("評価時点の後の終了は締め切りを動かさない", () => {
    expect(collectUntilFor(base, START, null, START + 20 * DAY)).toBe(MIN_END);
  });
  test("evaluationPoint の evaluationAt と一致する", () => {
    for (const [p, r, s] of [
      [base, null, null], [withTarget, null, null], [withTarget, START + 20 * DAY, null],
      [withTarget, START + 20 * DAY, START + 10 * DAY], [base, null, START + 30 * DAY],
    ] as const) {
      expect(collectUntilFor(p, START, r, s)).toBe(evaluationPoint(p, START, r, s).evaluationAt);
    }
  });
});
