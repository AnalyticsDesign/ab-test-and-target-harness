import { describe, expect, test } from "vitest";
import { betaInterval, INTERVAL_NORMAL_FROM } from "../src/index";
import { betaMoments } from "../src/beta";
import { betaCdf } from "../src/interval";
import { inverseNormalCdf } from "../src/normal";

// CVR の 95% 信用区間(事後分布 Beta(1 + y, 1 + n − y) の分位点)

/** 平均と分散からの正規近似の区間(比べる用) */
function normalInterval(n: number, y: number): [number, number] {
  const { mean, variance } = betaMoments(1 + y, 1 + n - y);
  const sd = Math.sqrt(variance);
  return [mean + sd * inverseNormalCdf(0.025), mean + sd * inverseNormalCdf(0.975)];
}

describe("betaInterval", () => {
  test("CV 0 件(Beta(1, 101))は閉形式 1 − (1 − p)^(1/101) と同じ。正規近似の [0, 0.029] にならない", () => {
    const [lo, hi] = betaInterval(100, 0);
    expect(lo).toBeCloseTo(1 - 0.975 ** (1 / 101), 12);
    expect(hi).toBeCloseTo(1 - 0.025 ** (1 / 101), 12);
    expect(lo).toBeCloseTo(0.00025, 5);
    expect(hi).toBeCloseTo(0.0359, 4);
  });

  test("0 人(Beta(1, 1) = 一様分布)は [0.025, 0.975]", () => {
    const [lo, hi] = betaInterval(0, 0);
    expect(lo).toBeCloseTo(0.025, 12);
    expect(hi).toBeCloseTo(0.975, 12);
  });

  test("全員 CV(Beta(n + 1, 1))は閉形式 p^(1/(n+1)) と同じ", () => {
    const [lo, hi] = betaInterval(50, 50);
    expect(lo).toBeCloseTo(0.025 ** (1 / 51), 12);
    expect(hi).toBeCloseTo(0.975 ** (1 / 51), 12);
  });

  test("正確な分位点: 累積分布に入れると 0.025 と 0.975 に戻る", () => {
    for (const [n, y] of [[1_000, 4], [10_000, 500], [3_000, 1_500], [200_000, 3_999], [37, 12]] as const) {
      const [lo, hi] = betaInterval(n, y);
      expect(betaCdf(lo, 1 + y, 1 + n - y)).toBeCloseTo(0.025, 9);
      expect(betaCdf(hi, 1 + y, 1 + n - y)).toBeCloseTo(0.975, 9);
    }
  });

  test("対称: CV と非 CV を入れ替えると区間は 1 − x で折り返す", () => {
    for (const [n, y] of [[100, 0], [1_000, 37], [20_000, 7_000], [1_000_000, 12_345]] as const) {
      const [lo, hi] = betaInterval(n, y);
      const [lo2, hi2] = betaInterval(n, n - y);
      expect(lo2).toBeCloseTo(1 - hi, 12);
      expect(hi2).toBeCloseTo(1 - lo, 12);
    }
  });

  test("CV も非 CV も多い群は正規近似と同じ(境目の上は正規近似、境目のすぐ下の正確な値も近い)", () => {
    expect(betaInterval(1_000_000, 50_000)).toEqual(normalInterval(1_000_000, 50_000));
    const exact = betaInterval(400_000, INTERVAL_NORMAL_FROM - 1);
    const approx = normalInterval(400_000, INTERVAL_NORMAL_FROM - 1);
    // 区間の幅に対する差が小さい
    const width = exact[1] - exact[0];
    expect(Math.abs(exact[0] - approx[0]) / width).toBeLessThan(0.01);
    expect(Math.abs(exact[1] - approx[1]) / width).toBeLessThan(0.01);
  });

  test("normal_approximation_error_is_within_tolerance: 境目の正規近似の裾の確率のずれは 0.001 以内", () => {
    const m = INTERVAL_NORMAL_FROM;
    for (const ratio of [1, 2, 5, 20, 100, 1_000]) {
      for (const [n, y] of [[m + m * ratio, m], [m + m * ratio, m * ratio]]) {
        const [lo, hi] = betaInterval(n!, y!);
        expect(Math.abs(betaCdf(lo, 1 + y!, 1 + n! - y!) - 0.025)).toBeLessThanOrEqual(0.001);
        expect(Math.abs(betaCdf(hi, 1 + y!, 1 + n! - y!) - 0.975)).toBeLessThanOrEqual(0.001);
      }
    }
  });

  test("乱数を使わない(同じ入力で同じ出力)", () => {
    for (const [n, y] of [[100, 0], [5_000, 123], [2_000_000, 80_000]] as const) {
      expect(betaInterval(n, y)).toEqual(betaInterval(n, y));
    }
  });

  test("区間の幅(level)を変えられる。不正な入力は RangeError", () => {
    const [lo90, hi90] = betaInterval(1_000, 50, 0.9);
    const [lo95, hi95] = betaInterval(1_000, 50);
    expect(lo90).toBeGreaterThan(lo95);
    expect(hi90).toBeLessThan(hi95);
    expect(() => betaInterval(10, 11)).toThrow(RangeError);
    expect(() => betaInterval(10, 1, 1)).toThrow(RangeError);
  });
});
