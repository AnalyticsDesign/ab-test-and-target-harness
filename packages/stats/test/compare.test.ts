import { describe, expect, test } from "vitest";
import { CLOSED_FORM_MAX_TERMS, NUMERIC_BELOW, STATS_VERSION, diffNormal, diffSummary, probBeat, probBest, type Arm } from "../src/index";
import { diffSummaryBy } from "../src/compare";
import { lnBeta, lnGamma, probBeatClosedForm } from "../src/beta";
import { inverseNormalCdf, normalCdf } from "../src/normal";

/** Evan Miller の式をそのまま書いた参照実装(項ごとに lnBeta。漸化式も対称性も使わない)。 */
function referenceProbBeat(a: Arm, b: Arm): number {
  const aA = 1 + a.y, bA = 1 + a.n - a.y, aB = 1 + b.y, bB = 1 + b.n - b.y;
  let sum = 0;
  for (let i = 0; i < aB; i++) {
    sum += Math.exp(lnBeta(aA + i, bA + bB) - Math.log(bB + i) - lnBeta(1 + i, bB) - lnBeta(aA, bA));
  }
  return sum;
}

describe("基礎関数", () => {
  test("lnGamma は参照値と一致する", () => {
    const refs: Array<[number, number]> = [
      [0.5, 0.5723649429247004], [1, 0], [2.5, 0.2846828704729196], [10, 12.801827480081467],
      [100, 359.1342053695754], [1000, 5905.220423209181], [1e5, 1051287.7089736569],
      [1e6, 12815504.569147613], [1e7, 151180949.3694739],
    ];
    for (const [x, y] of refs) expect(Math.abs(lnGamma(x) - y)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(y)));
  });
  test("normalCdf / inverseNormalCdf は参照値と一致する", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 14);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 13);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316300957, 13);
    expect(normalCdf(0.3)).toBeCloseTo(0.6179114221889526, 13);
    expect(normalCdf(5)).toBeCloseTo(0.9999997133484281, 13);
    expect(Math.abs(normalCdf(-8) - 6.22096057427182e-16)).toBeLessThan(1e-20);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.9599639845400534, 12);
    expect(inverseNormalCdf(0.8)).toBeCloseTo(0.8416212335729144, 12);
    expect(inverseNormalCdf(1e-10)).toBeCloseTo(-6.361340902404057, 9);
  });
});

test("golden_values_match_spike_s1", () => {
  const a = { n: 10_000, y: 500 }, b = { n: 10_000, y: 560 };
  expect(probBeat(a, b)).toBeCloseTo(0.97084, 4);
  const d = diffSummary(a, b, 0.2, null);
  expect(d.ci95[0]).toBeCloseTo(-0.021, 2); expect(d.ci95[1]).toBeCloseTo(1.221, 2);
  expect(Math.abs(d.pAboveDelta - 0.896)).toBeLessThanOrEqual(0.002);
  expect(d.expectedLossPer10k).toBeGreaterThanOrEqual(0.355); expect(d.expectedLossPer10k).toBeLessThanOrEqual(0.36);
});

test("端の値", () => {
  expect(probBeat({ n: 0, y: 0 }, { n: 0, y: 0 })).toBeCloseTo(0.5, 6);
  expect(probBeat({ n: 0, y: 0 }, { n: 1, y: 1 })).toBeCloseTo(2 / 3, 5); // 1 人 CV 1 vs 0 人 → 上回る確率 66.667%(基準側が下回る確率 33.333%)
});

test("closed_form_used_for_low_conversion_counts", () => {
  // 設計書 §17: 悪化の確率は閉形式で約 96.9%(正規近似の約 94.9% にならない)
  expect(diffSummary({ n: 1000, y: 4 }, { n: 1000, y: 0 }, 0, null).pBelowZero).toBeCloseTo(0.969, 2);
  // 非 CV が少ない側: P(差 > 0.01 ポイント) ≈ 96.56%(正規近似の約 94.48% にならない)
  expect(diffSummary({ n: 1000, y: 996 }, { n: 1000, y: 1000 }, 0.01, null).pAboveDelta).toBeCloseTo(0.9656, 3);
});

test("閉形式と正規近似の境目で確率が 0.1 ポイント以内", () => {
  // min(CV, 非 CV) = k の組で、項数 k + 1 が上限の前後 3 点ずつになるよう並べ、
  // 上限を外した参照の閉形式(probBeatClosedForm)と probBeat の差を見る。
  // 2 群の CV 数の差は √(合計) の 0.35 倍(z ≈ 0.35)にして、確率が 0 や 1 に張り付かないようにする
  for (let terms = CLOSED_FORM_MAX_TERMS - 2; terms <= CLOSED_FORM_MAX_TERMS + 3; terms++) {
    const k = terms - 1;
    const a = { n: 20 * k, y: k };
    const b = { n: 20 * k, y: k + Math.round(0.35 * Math.sqrt(2 * k)) };
    const exact = probBeatClosedForm(a, b);
    expect(exact).toBeGreaterThan(0.3); expect(exact).toBeLessThan(0.99);
    expect(Math.abs(probBeat(a, b) - exact)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(probBeat(b, a) - (1 - exact))).toBeLessThanOrEqual(0.001);
  }
});

describe("probBeat", () => {
  test("参照実装(項ごとの lnBeta)と一致し、対称性の 4 通りの選び方で値が変わらない", () => {
    const cases: Array<[Arm, Arm]> = [
      [{ n: 50, y: 3 }, { n: 50, y: 7 }],
      [{ n: 200, y: 190 }, { n: 300, y: 270 }],     // 非 CV が少ない側
      [{ n: 1000, y: 4 }, { n: 1000, y: 0 }],
      [{ n: 80, y: 40 }, { n: 120, y: 61 }],
      [{ n: 10_000, y: 500 }, { n: 10_000, y: 560 }],
      [{ n: 7, y: 7 }, { n: 5, y: 0 }],
    ];
    for (const [a, b] of cases) {
      const ref = referenceProbBeat(a, b);
      expect(Math.abs(probBeat(a, b) - ref)).toBeLessThan(1e-9);
      expect(probBeat(a, b) + probBeat(b, a)).toBeCloseTo(1, 9);
    }
  });
  test("項の途中で桁あふれ・桁落ちしない(大きな n、確率が 0 / 1 に近い)", () => {
    const hi = probBeat({ n: 100_000, y: 1000 }, { n: 100_000, y: 3000 });
    expect(hi).toBeGreaterThan(1 - 1e-12); expect(hi).toBeLessThanOrEqual(1);
    const lo = probBeat({ n: 100_000, y: 3000 }, { n: 100_000, y: 1000 });
    expect(lo).toBeGreaterThanOrEqual(0); expect(lo).toBeLessThan(1e-12);
  });
  test("上限を超える CV でも 0〜1 の確率を返す", () => {
    const p = probBeat({ n: 100_000_000, y: 5_000_000 }, { n: 100_000_000, y: 5_010_000 });
    expect(p).toBeGreaterThan(0.9); expect(p).toBeLessThan(1);
  });
  test("不正な入力は例外", () => {
    expect(() => probBeat({ n: 10, y: 11 }, { n: 10, y: 1 })).toThrow(RangeError);
    expect(() => probBeat({ n: -1, y: 0 }, { n: 10, y: 1 })).toThrow(RangeError);
    expect(() => probBeat({ n: 10.5, y: 1 }, { n: 10, y: 1 })).toThrow(RangeError);
    expect(() => probBeat({ n: Number.NaN, y: 0 }, { n: 10, y: 1 })).toThrow(RangeError);
  });
});

describe("diffSummary", () => {
  test("正規近似の領域: 平均・区間・相対・ROPE", () => {
    const d = diffSummary({ n: 10_000, y: 500 }, { n: 10_000, y: 560 }, 0, 0.5);
    expect(d.mean).toBeCloseTo(0.5998, 3);
    expect(d.relMean).not.toBeNull();
    expect(d.relMean as number).toBeCloseTo(11.97, 1);          // % (基準 CVR の事後平均に対する比)
    expect(d.relCi95![0]).toBeLessThan(d.relMean as number);
    expect(d.relCi95![1]).toBeGreaterThan(d.relMean as number);
    expect(d.pAboveDelta).toBeCloseTo(probBeat({ n: 10_000, y: 500 }, { n: 10_000, y: 560 }), 12); // δ = 0 は probBeat
    expect(d.pBelowZero).toBeCloseTo(1 - d.pAboveDelta, 12);
    expect(d.pWithinRope).not.toBeNull();
    expect(d.pWithinRope as number).toBeCloseTo(0.376, 2); // Φ((0.5−0.6)/0.316) − Φ((−0.5−0.6)/0.316)
  });
  test("ROPE が null なら pWithinRope は null", () => {
    expect(diffSummary({ n: 1000, y: 50 }, { n: 1000, y: 60 }, 0, null).pWithinRope).toBeNull();
  });
  test("基準の CV が 0 件のとき相対は null", () => {
    const d = diffSummary({ n: 1000, y: 0 }, { n: 1000, y: 3 }, 0, null);
    expect(d.relMean).toBeNull(); expect(d.relCi95).toBeNull();
  });
  test("数値積分の領域でも δ をほぼ 0 にすると閉形式の確率と一致する", () => {
    const cases: Array<[Arm, Arm]> = [
      [{ n: 1000, y: 4 }, { n: 1000, y: 0 }], [{ n: 200, y: 10 }, { n: 200, y: 14 }],
      [{ n: 1000, y: 996 }, { n: 1000, y: 1000 }], [{ n: 300, y: 12 }, { n: 5000, y: 200 }],
    ];
    for (const [a, b] of cases) {
      const d = diffSummary(a, b, 1e-7, null);
      expect(Math.abs(d.pAboveDelta - probBeat(a, b))).toBeLessThan(0.0015);
    }
  });
  test("数値積分の領域: 区間は平均を含み、ROPE の確率は 0〜1、期待損失は 0 以上", () => {
    const d = diffSummary({ n: 200, y: 10 }, { n: 200, y: 14 }, 0.5, 1);
    expect(d.ci95[0]).toBeLessThan(d.mean); expect(d.ci95[1]).toBeGreaterThan(d.mean);
    expect(d.pWithinRope as number).toBeGreaterThan(0); expect(d.pWithinRope as number).toBeLessThan(1);
    expect(d.expectedLossPer10k).toBeGreaterThan(0);
    expect(d.pAboveDelta).toBeLessThan(diffSummary({ n: 200, y: 10 }, { n: 200, y: 14 }, 0, null).pAboveDelta);
  });
  test("数値積分の領域は、スパイクの MC(40 万回)の値と近い", () => {
    // 200/10 vs 200/14: +0.2pt 超 77.19%、区間 −2.765〜6.836、損失 27.94 / 1000/50 vs 1000/62: 83.37%、−0.824〜3.230、6.28
    const x = diffSummary({ n: 200, y: 10 }, { n: 200, y: 14 }, 0.2, null);
    expect(Math.abs(x.pAboveDelta - 0.7719)).toBeLessThan(0.003);
    expect(Math.abs(x.ci95[0] + 2.765)).toBeLessThan(0.02); expect(Math.abs(x.ci95[1] - 6.836)).toBeLessThan(0.03);
    expect(Math.abs(x.expectedLossPer10k - 27.94)).toBeLessThan(0.2);
    const y = diffSummary({ n: 1000, y: 50 }, { n: 1000, y: 62 }, 0.2, null);
    expect(Math.abs(y.pAboveDelta - 0.8337)).toBeLessThan(0.002);
    expect(Math.abs(y.ci95[0] + 0.824)).toBeLessThan(0.01); expect(Math.abs(y.ci95[1] - 3.230)).toBeLessThan(0.01);
    expect(Math.abs(y.expectedLossPer10k - 6.28)).toBeLessThan(0.05);
  });
  test("正規近似と数値積分の境目(NUMERIC_BELOW)で、確率・ROPE の差が 0.1 ポイント以内", () => {
    for (const mult of [20, 100, 1000]) {
      for (const dz of [-0.8, 0, 0.8, 2]) {
        const n = NUMERIC_BELOW * mult;
        const a = { n, y: NUMERIC_BELOW };
        const b = { n, y: Math.round(NUMERIC_BELOW + dz * Math.sqrt(2 * NUMERIC_BELOW)) };
        for (const delta of [0.001, 0.2]) {
          const num = diffSummaryBy("numeric", a, b, delta * (mult === 20 ? 5 : 1), 0.5);
          const nor = diffSummaryBy("normal", a, b, delta * (mult === 20 ? 5 : 1), 0.5);
          expect(Math.abs(num.pAboveDelta - nor.pAboveDelta)).toBeLessThanOrEqual(0.001);
          expect(Math.abs(num.pWithinRope! - nor.pWithinRope!)).toBeLessThanOrEqual(0.001);
        }
      }
    }
  });
  test("同じ入力で同じ出力", () => {
    const a = { n: 1000, y: 4 }, b = { n: 1000, y: 0 };
    expect(diffSummary(a, b, 0.1, 0.2)).toEqual(diffSummary(a, b, 0.1, 0.2));
  });
  test("端の値(0 人どうし)は例外にならず有限", () => {
    const d = diffSummary({ n: 0, y: 0 }, { n: 0, y: 0 }, 0, 1);
    expect(d.mean).toBeCloseTo(0, 9); expect(d.pAboveDelta).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(d.expectedLossPer10k)).toBe(true);
  });
});

describe("diffNormal(端末別・ほかの目標の参考値)", () => {
  test("人数が多い均衡した組では、diffSummary の正規近似の経路と平均・区間が一致する", () => {
    const a = { n: 10_000, y: 500 }, b = { n: 10_000, y: 560 };
    const x = diffNormal(a, b), d = diffSummary(a, b, 0.2, null);
    expect(x.mean).toBeCloseTo(d.mean, 12);
    expect(x.ci95[0]).toBeCloseTo(d.ci95[0], 12); expect(x.ci95[1]).toBeCloseTo(d.ci95[1], 12);
    expect(x.ci95[0]).toBeCloseTo(-0.021, 2); expect(x.ci95[1]).toBeCloseTo(1.221, 2);
  });
  test("少ない人数でも正規近似だけで出す(数値積分には切り替えない)", () => {
    // diffSummary は数値積分に切り替わるが、diffNormal は常に正規近似
    const a = { n: 200, y: 10 }, b = { n: 200, y: 14 };
    const x = diffNormal(a, b);
    expect(x.ci95[0]).toBeCloseTo(diffSummaryBy("normal", a, b, 0, null).ci95[0], 12);
    expect(x.ci95[1]).toBeCloseTo(diffSummaryBy("normal", a, b, 0, null).ci95[1], 12);
  });
  test("同じ入力で同じ出力 / 不正な入力は例外", () => {
    expect(diffNormal({ n: 100, y: 5 }, { n: 100, y: 9 })).toEqual(diffNormal({ n: 100, y: 5 }, { n: 100, y: 9 }));
    expect(() => diffNormal({ n: 10, y: 11 }, { n: 10, y: 1 })).toThrow(RangeError);
  });
});

test("数値積分の計算量を上限で抑えても、人数の桁が違う組で精度が保たれる", () => {
  // 基準 {1490, 149} と相手 64 倍(上限なしだと最も重かった形)。細かい刻みの参照との差 ≤ 0.001
  const a = { n: 1490, y: 149 };
  for (const rb of [0.5, 1, 1.5]) {
    const b = { n: 1490 * 64, y: Math.round(149 * 64 * rb) };
    for (const delta of [0.001, 0.2]) {
      const ref = diffSummaryBy("numeric", a, b, delta, 0.5, { pointsPerSd: 64, maxCells: 100_000, maxWork: Infinity });
      const got = diffSummaryBy("numeric", a, b, delta, 0.5);
      expect(Math.abs(got.pAboveDelta - ref.pAboveDelta)).toBeLessThanOrEqual(0.001);
      expect(Math.abs(got.pWithinRope! - ref.pWithinRope!)).toBeLessThanOrEqual(0.001);
      expect(Math.abs(got.expectedLossPer10k - ref.expectedLossPer10k)).toBeLessThanOrEqual(0.02 * Math.max(1, ref.expectedLossPer10k));
    }
  }
});

describe("probBest", () => {
  const sets: Arm[][] = [
    [{ n: 1000, y: 50 }, { n: 1000, y: 62 }, { n: 1000, y: 57 }],
    [{ n: 4000, y: 200 }, { n: 4100, y: 230 }, { n: 3900, y: 210 }, { n: 4050, y: 190 }, { n: 4000, y: 225 }],
  ];
  test("probBest の和が 1 / 同じ入力で同じ出力", () => {
    for (const arms of sets) {
      const p = probBest(arms);
      expect(p).toHaveLength(arms.length);
      expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
      expect(Math.abs(p.reduce((s, x) => s + x, 0) - 1)).toBeLessThanOrEqual(1e-9);
      expect(probBest(arms)).toEqual(p);
      for (const x of p) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    }
  });
  test("CVR が最も高い群の確率が最大", () => {
    const p = probBest(sets[0]!);
    expect(p[1]).toBeGreaterThan(p[2]!); expect(p[2]).toBeGreaterThan(p[0]!);
  });
  test("同じ入力の群は同じ確率(2 群で 0.5)", () => {
    const p = probBest([{ n: 500, y: 25 }, { n: 500, y: 25 }]);
    expect(p[0]).toBeCloseTo(0.5, 9); expect(p[1]).toBeCloseTo(0.5, 9);
  });
  test("2 群の正規近似は probBeat に近い", () => {
    const a = { n: 10_000, y: 500 }, b = { n: 10_000, y: 560 };
    expect(Math.abs(probBest([a, b])[1]! - probBeat(a, b))).toBeLessThan(0.002);
  });
  test("人数の桁が大きく違う群が混ざっても和が 1", () => {
    const p = probBest([{ n: 0, y: 0 }, { n: 1_000_000, y: 50_000 }, { n: 30, y: 2 }]);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(p[0]).toBeGreaterThan(0.8); // 参加者 0 人の群(事前分布 = 一様)は、5% の群を上回る可能性が 95% 近くある
  });
  test("端: 0 群 = 空、1 群 = [1]", () => {
    expect(probBest([])).toEqual([]);
    expect(probBest([{ n: 10, y: 1 }])).toEqual([1]);
  });
});

test("STATS_VERSION", () => { expect(STATS_VERSION).toBe("1"); });
