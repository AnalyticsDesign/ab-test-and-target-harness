import { describe, expect, test } from "vitest";
import { effectiveThreshold, sampleSize } from "../src/index";

test("effectiveThreshold", () => { expect(effectiveThreshold(95, 1)).toBe(95); expect(effectiveThreshold(95, 2)).toBeCloseTo(97.5, 9); });

test("sampleSize", () => {
  expect(Math.abs(sampleSize(0.05, 1, 1, 95) - 8200) / 8200).toBeLessThan(0.02);  // 5% → 6% で約 8,200
  expect(Math.abs(sampleSize(0.05, 1, 2, 95) - 9900) / 9900).toBeLessThan(0.02);  // 3 つ(m = 2)で約 9,900
});

describe("sampleSize の性質", () => {
  test("整数(切り上げ)で返る", () => { expect(Number.isInteger(sampleSize(0.05, 1, 1, 95))).toBe(true); });
  test("差が小さいほど・比較が多いほど・しきい値が高いほど多い", () => {
    expect(sampleSize(0.05, 0.5, 1, 95)).toBeGreaterThan(sampleSize(0.05, 1, 1, 95));
    expect(sampleSize(0.05, 1, 3, 95)).toBeGreaterThan(sampleSize(0.05, 1, 2, 95));
    expect(sampleSize(0.05, 1, 1, 99)).toBeGreaterThan(sampleSize(0.05, 1, 1, 95));
  });
  test("不正な入力は例外", () => {
    expect(() => sampleSize(0, 1, 1, 95)).toThrow(RangeError);
    expect(() => sampleSize(0.05, 0, 1, 95)).toThrow(RangeError);
    expect(() => sampleSize(0.95, 6, 1, 95)).toThrow(RangeError);
    expect(() => sampleSize(0.05, 1, 0, 95)).toThrow(RangeError);
    expect(() => sampleSize(0.05, 1, 1, 100)).toThrow(RangeError);
  });
});
