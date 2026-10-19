import { describe, expect, test } from "vitest";
import { srm } from "../src/index";

describe("srm", () => {
  test("全群 0 人", () => { expect(srm([0, 0], [50, 50])).toBe(1); });
  test("比率どおりなら p = 1", () => {
    expect(srm([500, 500], [50, 50])).toBeCloseTo(1, 12);
    expect(srm([100, 300], [1, 3])).toBeCloseTo(1, 12);
  });
  test("2 群のずれ(自由度 1)", () => {
    // χ² = 200² / 5000 × 2 = 16 → p = erfc(√8)
    expect(srm([5200, 4800], [50, 50])).toBeCloseTo(6.334248366623977e-5, 12);
  });
  test("3 群(自由度 2、p = exp(-χ²/2))", () => {
    // χ² = (10² + 0 + 10²) / 100 = 2
    expect(srm([90, 100, 110], [1, 1, 1])).toBeCloseTo(Math.exp(-1), 12);
  });
  test("重みは比率として扱う(合計が 100 でなくてよい)", () => {
    expect(srm([5200, 4800], [1, 1])).toBeCloseTo(srm([5200, 4800], [50, 50]), 14);
  });
  test("5 群(自由度 4、p = e^{-x/2}(1 + x/2))", () => {
    // χ² = (10² + 10² + 5² + 5² + 0) / 100 = 2.5
    expect(srm([110, 90, 105, 95, 100], [1, 1, 1, 1, 1])).toBeCloseTo(Math.exp(-1.25) * (1 + 1.25), 12);
  });
  test("大きなずれは 0 に近い有限の値", () => {
    const p = srm([100_000, 50_000], [50, 50]);
    expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(1e-300 + 1e-12);
  });
  test("srm は重み 0 の群を受けたら例外(外すのは verdict。Task 2 の srm_ignores_zero_weight_variant)", () => {
    expect(() => srm([10, 10, 0], [50, 50, 0])).toThrow(RangeError);
    expect(() => srm([10, 10], [50, -1])).toThrow(RangeError);
    expect(() => srm([10, 10], [50, Number.NaN])).toThrow(RangeError);
  });
  test("長さの不一致・不正な人数は例外", () => {
    expect(() => srm([10, 10], [50])).toThrow(RangeError);
    expect(() => srm([10, -1], [50, 50])).toThrow(RangeError);
  });
  test("群が 1 つ以下なら検定できないので 1", () => {
    expect(srm([10], [100])).toBe(1);
    expect(srm([], [])).toBe(1);
  });
});
