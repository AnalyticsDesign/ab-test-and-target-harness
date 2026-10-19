import { describe, expect, test } from "vitest";
import {
  DEFAULT_PLAN, defaultBaseline, extensionIssues, planCautions, planIssues, type EvaluationPlan,
} from "../src/index";

const ctx = { variantIds: ["a", "b"], goalIds: ["g"] };
const plan = (over: Partial<EvaluationPlan> = {}): EvaluationPlan => ({
  ...DEFAULT_PLAN, primaryGoalId: "g", baselineVariantId: "a", ...over,
});
const paths = (p: EvaluationPlan, c = ctx) => planIssues(p, c).map((i) => i.path);

describe("DEFAULT_PLAN", () => {
  test("既定値(設計書 5.1)", () => {
    expect(DEFAULT_PLAN).toEqual({
      minDays: 14, maxWeeks: 8, targetPerVariant: null, delta: 0, rope: null, threshold: 95,
      definition: {
        version: 1, observationWindow: { kind: "until_end" }, denominator: "displayed", mixed: "keep_first",
        model: { name: "beta-binomial", prior: [1, 1], version: 1 },
      },
    });
  });
  test("既定の計画は入力の検査を通る", () => {
    expect(planIssues(plan(), ctx)).toEqual([]);
  });
  test("既定値は書き換えられない(共有の参照を汚さない)", () => {
    expect(Object.isFrozen(DEFAULT_PLAN)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PLAN.definition)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PLAN.definition.model.prior)).toBe(true);
  });
});

describe("defaultBaseline", () => {
  test("defaultBaseline: オリジナルの中で先頭、なければ先頭(決定 61)", () => {
    expect(defaultBaseline([{ id: "b", position: 1, original: true }, { id: "a", position: 0 }])).toBe("b");
    expect(defaultBaseline([{ id: "b", position: 1 }, { id: "a", position: 0 }])).toBe("a");
    expect(defaultBaseline([])).toBeNull();
  });
  test("オリジナルが複数なら position が最小のもの。入力の並びに依らない", () => {
    const vs = [
      { id: "c", position: 2, original: true }, { id: "b", position: 1, original: true }, { id: "a", position: 0 },
    ];
    expect(defaultBaseline(vs)).toBe("b");
    expect(defaultBaseline([...vs].reverse())).toBe("b");
  });
  test("入力の配列を並べ替えない", () => {
    const vs = [{ id: "b", position: 1 }, { id: "a", position: 0 }];
    defaultBaseline(vs);
    expect(vs.map((v) => v.id)).toEqual(["b", "a"]);
  });
});

describe("planIssues: 入力の範囲", () => {
  test("しきい値は 90〜99.9", () => {
    expect(paths(plan({ threshold: 89.9 }))).toEqual(["threshold"]);
    expect(paths(plan({ threshold: 90 }))).toEqual([]);
    expect(paths(plan({ threshold: 99.9 }))).toEqual([]);
    expect(paths(plan({ threshold: 99.95 }))).toEqual(["threshold"]);
    expect(paths(plan({ threshold: 100 }))).toEqual(["threshold"]);
    expect(paths(plan({ threshold: Number.NaN }))).toEqual(["threshold"]);
  });
  test("最大期間は 2〜26 週(整数)", () => {
    expect(paths(plan({ maxWeeks: 1, minDays: 1 }))).toEqual(["maxWeeks"]);
    expect(paths(plan({ maxWeeks: 2 }))).toEqual([]);
    expect(paths(plan({ maxWeeks: 26 }))).toEqual([]);
    expect(paths(plan({ maxWeeks: 27 }))).toEqual(["maxWeeks"]);
    expect(paths(plan({ maxWeeks: 2.5 }))).toEqual(["maxWeeks"]);
  });
  test("最低期間は 1 日〜最大期間", () => {
    expect(paths(plan({ minDays: 0 }))).toEqual(["minDays"]);
    expect(paths(plan({ minDays: 1 }))).toEqual([]);
    expect(paths(plan({ minDays: 56 }))).toEqual([]); // 8 週ちょうど
    expect(paths(plan({ minDays: 57 }))).toEqual(["minDays"]); // 8 週(56 日)を超える
    expect(paths(plan({ minDays: 14, maxWeeks: 2 }))).toEqual([]);
    expect(paths(plan({ minDays: 15, maxWeeks: 2 }))).toEqual(["minDays"]);
    expect(paths(plan({ minDays: 1.5 }))).toEqual(["minDays"]);
  });
  test("目標参加者数は null か 100 以上の整数", () => {
    expect(paths(plan({ targetPerVariant: null }))).toEqual([]);
    expect(paths(plan({ targetPerVariant: 99 }))).toEqual(["targetPerVariant"]);
    expect(paths(plan({ targetPerVariant: 100 }))).toEqual([]);
    expect(paths(plan({ targetPerVariant: 100.5 }))).toEqual(["targetPerVariant"]);
  });
  test("ROPE は null か 0 より大きい。最小改善幅は 0 以上", () => {
    expect(paths(plan({ rope: null }))).toEqual([]);
    expect(paths(plan({ rope: 0 }))).toEqual(["rope"]);
    expect(paths(plan({ rope: -0.1 }))).toEqual(["rope"]);
    expect(paths(plan({ rope: 0.1 }))).toEqual([]);
    expect(paths(plan({ delta: 0 }))).toEqual([]);
    expect(paths(plan({ delta: -0.01 }))).toEqual(["delta"]);
    expect(paths(plan({ delta: Number.POSITIVE_INFINITY }))).toEqual(["delta"]);
  });
  test("目標と基準は同じ Site / テストのものだけ(null は下書きの未設定として通す)", () => {
    expect(planIssues(plan({ primaryGoalId: "zzz" }), ctx)).toEqual([
      expect.objectContaining({ path: "primaryGoalId", code: "unknown" }),
    ]);
    expect(planIssues(plan({ baselineVariantId: "zzz" }), ctx)).toEqual([
      expect.objectContaining({ path: "baselineVariantId", code: "unknown" }),
    ]);
    expect(planIssues(plan({ primaryGoalId: null, baselineVariantId: null }), ctx)).toEqual([]);
  });
  test("範囲の違反は code = range、message は日本語で非空", () => {
    const [issue] = planIssues(plan({ threshold: 50 }), ctx);
    expect(issue).toEqual({ path: "threshold", code: "range", message: expect.stringMatching(/90/) });
  });
  test("集計の定義は固定(version 1 の形以外は range)", () => {
    expect(paths(plan({ definition: { ...DEFAULT_PLAN.definition, denominator: "assigned" as never } }))).toEqual(["definition"]);
    expect(paths(plan({ definition: { ...DEFAULT_PLAN.definition, model: { name: "beta-binomial", prior: [2, 1], version: 1 } } }))).toEqual(["definition"]);
  });
  test("複数の違反はすべて返す", () => {
    expect(paths(plan({ threshold: 10, targetPerVariant: 5, rope: 0 })).sort()).toEqual(["rope", "targetPerVariant", "threshold"]);
  });
  test("メッセージに非公開の開発記録への参照を含めない", () => {
    const all = planIssues(plan({ threshold: 10, targetPerVariant: 5, rope: 0, delta: -1, minDays: 0, maxWeeks: 1, primaryGoalId: "x", baselineVariantId: "y" }), ctx);
    expect(all.length).toBeGreaterThan(5);
    for (const i of all) expect(i.message).not.toMatch(/決定|spec|§|Plan|Task|docs\/superpowers/);
  });
});

describe("planCautions", () => {
  const keys = (p: EvaluationPlan) => planCautions(p).map((c) => c.key);
  test("最低期間: 14 日以上は注意なし、7〜13 日は short、7 日未満は very_short(重ねて出さない)", () => {
    expect(keys(plan({ minDays: 14, targetPerVariant: 100 }))).toEqual([]);
    expect(keys(plan({ minDays: 13, targetPerVariant: 100 }))).toEqual(["min_days_short"]);
    expect(keys(plan({ minDays: 7, targetPerVariant: 100 }))).toEqual(["min_days_short"]);
    expect(keys(plan({ minDays: 6, targetPerVariant: 100 }))).toEqual(["min_days_very_short"]);
    expect(keys(plan({ minDays: 1, targetPerVariant: 100 }))).toEqual(["min_days_very_short"]);
  });
  test("しきい値 95 未満は threshold_low、95 以上は無し", () => {
    expect(keys(plan({ threshold: 94.9, targetPerVariant: 100 }))).toEqual(["threshold_low"]);
    expect(keys(plan({ threshold: 90, targetPerVariant: 100 }))).toEqual(["threshold_low"]);
    expect(keys(plan({ threshold: 95, targetPerVariant: 100 }))).toEqual([]);
  });
  test("目標参加者数が無ければ no_target", () => {
    expect(keys(plan({ targetPerVariant: null }))).toEqual(["no_target"]);
  });
  test("params に値を添える", () => {
    expect(planCautions(plan({ minDays: 3, threshold: 92, targetPerVariant: 100 }))).toEqual([
      { key: "min_days_very_short", params: { minDays: 3 } },
      { key: "threshold_low", params: { threshold: 92 } },
    ]);
  });
});

describe("extensionIssues", () => {
  test("extensionIssues: 延ばす向きだけ空", () => {
    const p = { ...DEFAULT_PLAN, primaryGoalId: "g", baselineVariantId: "a" };
    expect(extensionIssues(p, { ...p, minDays: 21, maxWeeks: 10, targetPerVariant: 500 })).toEqual([]);
    expect(extensionIssues({ ...p, targetPerVariant: 500 }, { ...p, targetPerVariant: null })).toEqual(["targetPerVariant"]);
    expect(extensionIssues(p, { ...p, threshold: 90 })).toEqual(["threshold"]);
  });
  test("変更なしは空。同じ値は延ばす向きとして受ける", () => {
    expect(extensionIssues(plan(), plan())).toEqual([]);
    expect(extensionIssues(plan({ targetPerVariant: 500 }), plan({ targetPerVariant: 500 }))).toEqual([]);
  });
  test("縮める向き(最低期間・最大期間・目標参加者数)は名前を返す", () => {
    expect(extensionIssues(plan(), plan({ minDays: 13 }))).toEqual(["minDays"]);
    expect(extensionIssues(plan(), plan({ maxWeeks: 7 }))).toEqual(["maxWeeks"]);
    expect(extensionIssues(plan({ targetPerVariant: 500 }), plan({ targetPerVariant: 499 }))).toEqual(["targetPerVariant"]);
    expect(extensionIssues(plan({ targetPerVariant: 500 }), plan({ targetPerVariant: 501 }))).toEqual([]);
    expect(extensionIssues(plan({ targetPerVariant: null }), plan({ targetPerVariant: 100 }))).toEqual([]); // 新しく設ける
  });
  test("判定の基準・目標・基準パターン・定義の変更は不可、複数は項目の並び順で返す", () => {
    expect(extensionIssues(plan(), plan({ delta: 0.1 }))).toEqual(["delta"]);
    expect(extensionIssues(plan(), plan({ rope: 0.1 }))).toEqual(["rope"]);
    expect(extensionIssues(plan(), plan({ primaryGoalId: "h" }))).toEqual(["primaryGoalId"]);
    expect(extensionIssues(plan(), plan({ baselineVariantId: "b" }))).toEqual(["baselineVariantId"]);
    expect(extensionIssues(plan(), plan({ definition: { ...DEFAULT_PLAN.definition, denominator: "assigned" as never } }))).toEqual(["definition"]);
    expect(extensionIssues(plan(), plan({ threshold: 99, delta: 1, minDays: 1 }))).toEqual(["minDays", "delta", "threshold"]);
  });
});
