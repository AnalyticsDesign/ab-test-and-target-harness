import { describe, expect, test } from "vitest";
import {
  DEFAULT_PLAN, STOP_LIMIT_K, diffSummary, effectiveThreshold, probBest, probBeat, stopRatioLimit, strictestCvCount, verdict,
  type EvaluationPlan, type NoteKey, type VerdictInput,
} from "../src/index";

const HOUR = 3_600_000;
const plan = (over: Partial<EvaluationPlan> = {}): EvaluationPlan => ({
  ...DEFAULT_PLAN, primaryGoalId: "g", baselineVariantId: "a", ...over,
});

type ArmIn = VerdictInput["arms"][number];
const arm = (id: string, n: number, y: number, over: Partial<ArmIn> = {}): ArmIn => ({
  id, weight: 50, n, y, mixed: 0, applyFailed: 0, hasChanges: id !== "a", ...over,
});
/** 品質に問題の無い入力(停止なし・失敗なし)。 */
const input = (arms: ArmIn[], over: Partial<VerdictInput> = {}): VerdictInput => ({
  plan: plan(), arms, stopMs: 0, elapsedMs: 100 * HOUR, failedSends: 0, recordedRows: 10_000, ...over,
});
const keys = (notes: Array<{ key: NoteKey }>) => notes.map((n) => n.key);
const state = (o: ReturnType<typeof verdict>, id = "b") => o.comparisons.find((c) => c.variantId === id)!.state;

// 基準 10,000 人 / CV 500 に対して 560 は、スパイク S1 のゴールデン値(上回る確率 97.084%)
const BASE = arm("a", 10_000, 500);
const GOLDEN_B = arm("b", 10_000, 560);

describe("判定の 5 状態(上から順に当てはめる)", () => {
  test("採用候補: 上回る確率がしきい値以上", () => {
    const o = verdict(input([BASE, GOLDEN_B]));
    expect(o.comparisons).toHaveLength(1);
    expect(o.comparisons[0]).toMatchObject({ variantId: "b", state: "adopt", minCountMet: true, probBest: null, applyFailedRate: 0 });
    expect(o.comparisons[0]!.summary.pAboveDelta).toBeCloseTo(0.97084, 4);
    expect(o).toMatchObject({ m: 1, threshold: 95 });
    expect(o.quality.level).toBe("ok");
  });
  test("最小改善幅 δ を超える確率で採用候補を決める(δ = 0.2 ポイントでは 89.6%)", () => {
    expect(state(verdict(input([BASE, GOLDEN_B], { plan: plan({ delta: 0.2 }) })))).toBe("insufficient");
    expect(state(verdict(input([BASE, GOLDEN_B], { plan: plan({ delta: 0.2, threshold: 90 }) })))).toBe("insufficient"); // 89.6 < 90
    expect(state(verdict(input([BASE, GOLDEN_B], { plan: plan({ delta: 0.1, threshold: 90 }) })))).toBe("adopt");
  });
  test("悪化の可能性が高い: 下回る確率がしきい値以上", () => {
    const o = verdict(input([BASE, arm("b", 10_000, 440)]));
    expect(state(o)).toBe("worse");
    expect(o.comparisons[0]!.summary.pBelowZero).toBeGreaterThanOrEqual(0.95);
  });
  test("実務上ほぼ同等: ROPE を設定していて |差| < ROPE の確率がしきい値以上", () => {
    const arms = [arm("a", 50_000, 2_500), arm("b", 50_000, 2_500)];
    expect(state(verdict(input(arms, { plan: plan({ rope: 0.5 }) })))).toBe("equivalent");
    // ROPE が無ければ同等とは出さない
    expect(state(verdict(input(arms, { plan: plan({ rope: null }) })))).toBe("insufficient");
  });
  test("どれにも当たらなければ判断材料が不足", () => {
    expect(state(verdict(input([BASE, arm("b", 10_000, 510)])))).toBe("insufficient");
  });
  test("基準自身は comparisons に入らない。基準だけなら m = 0 でしきい値はそのまま", () => {
    const o = verdict(input([BASE]));
    expect(o.comparisons).toEqual([]);
    expect(o.m).toBe(0);
    expect(o.threshold).toBe(95);
  });
  test("乱数を使わない(同じ入力で同じ出力)", () => {
    const i = input([BASE, GOLDEN_B, arm("c", 10_000, 530)]);
    expect(JSON.stringify(verdict(i))).toBe(JSON.stringify(verdict(i)));
  });
  test("入力を書き換えない", () => {
    const i = input([BASE, GOLDEN_B]);
    const copy = structuredClone(i);
    verdict(i);
    expect(i).toEqual(copy);
  });
  test("applyFailedRate は apply_failed / n(n = 0 なら 0)", () => {
    const o = verdict(input([BASE, arm("b", 10_000, 560, { applyFailed: 250 }), arm("c", 0, 0)]));
    expect(o.comparisons.find((c) => c.variantId === "b")!.applyFailedRate).toBeCloseTo(0.025, 12);
    expect(o.comparisons.find((c) => c.variantId === "c")!.applyFailedRate).toBe(0);
  });
});

describe("品質", () => {
  test("verdict_checks_quality_before_probability", () => {
    // 5,200 対 4,800(重み 50:50)は SRM の p ≈ 6e-5 < 0.001。確率は採用候補の条件を満たす
    const skewed = [arm("a", 5_200, 260), arm("b", 4_800, 400)];
    const o = verdict(input(skewed));
    expect(o.quality.srmP).toBeLessThan(0.001);
    expect(o.comparisons[0]!.summary.pAboveDelta).toBeGreaterThanOrEqual(0.95); // 確率だけなら採用候補
    expect(o.comparisons[0]!.state).toBe("blocked_quality");
    expect(o.quality.level).toBe("blocked");
    expect(o.quality.reasons).toContain("quality_blocked_srm");
    // 同じ確率・同じ人数で SRM が崩れていなければ採用候補
    expect(state(verdict(input([arm("a", 5_000, 250), arm("b", 5_000, 400)])))).toBe("adopt");
  });
  test("品質の問題があっても数値(summary・probBest)は参考として出る", () => {
    const o = verdict(input([arm("a", 5_200, 260), arm("b", 4_800, 400)]));
    expect(o.comparisons[0]!.summary.mean).toBeGreaterThan(0);
  });
  test("SRM の p は 0.001 ちょうど未満だけ判定不可", () => {
    const o = verdict(input([BASE, GOLDEN_B]));
    expect(o.quality.srmP).toBeCloseTo(1, 12);
    expect(o.quality.reasons).toEqual([]);
  });
  test("品質が悪ければ、最低件数に満たない比較も blocked_quality(品質が先)", () => {
    const o = verdict(input([arm("a", 100, 1), arm("b", 50, 0)])); // 100 対 50 は重み 50:50 から大きくずれる
    expect(o.quality.level).toBe("blocked");
    expect(o.comparisons[0]).toMatchObject({ state: "blocked_quality", minCountMet: false });
  });

  describe("停止が上限超で判定不可・以下で警告、失敗の割合 1% 以上で警告、混在 1% 超で判定不可", () => {
    // 上限 = min(5%, 0.5 / √C)。C = 最も厳しい比較の CV の件数(CV の合計 × 重み)。重みが等しい 2 群では 2 群の CV の平均
    const withCv = (yBase: number, yOther: number, stopHours: number) =>
      verdict(input([arm("a", 10_000, yBase), arm("b", 10_000, yOther)], { stopMs: stopHours * HOUR, elapsedMs: 100 * HOUR }));

    test("収集の停止(CV が多い): 上限 2.5%(C = (350 + 450) / 2 = 400)。0 は注意なし、上限ちょうどは警告で判定する、超えたら判定不可", () => {
      const at = (stopHours: number) => withCv(350, 450, stopHours);
      expect(at(0).quality).toMatchObject({ level: "ok", stopRatio: 0, stopLimit: 0.025, reasons: [] });
      expect(keys(at(0).notes)).not.toContain("collection_stops");

      const warn = at(2.5);
      expect(warn.quality).toMatchObject({ level: "warning", stopRatio: 0.025, stopLimit: 0.025, reasons: ["collection_stops"] });
      expect(state(warn)).toBe("adopt");
      expect(warn.notes).toContainEqual({ key: "collection_stops", params: { ratio: 0.025, hours: 2.5, limit: 0.025 } });

      const small = at(0.5);
      expect(small.quality.level).toBe("warning");
      expect(state(small)).toBe("adopt");

      const blocked = at(2.51);
      expect(blocked.quality).toMatchObject({ level: "blocked", stopLimit: 0.025 });
      expect(blocked.quality.reasons).toEqual(["quality_blocked_stops"]);
      expect(state(blocked)).toBe("blocked_quality");
      expect(blocked.notes).toContainEqual({ key: "quality_blocked_stops", params: { ratio: blocked.quality.stopRatio, limit: 0.025 } });
      expect(keys(blocked.notes)).not.toContain("collection_stops"); // 同じ原因で警告と判定不可を重ねない
    });
    test("収集の停止(CV が少ない): 上限は 5% で頭打ち。5% ちょうどは警告、5% 超は判定不可", () => {
      // C = 55 -> 0.5 / √55 = 6.7% > 5%
      const at = (stopHours: number) => withCv(50, 60, stopHours);
      expect(at(5).quality).toMatchObject({ level: "warning", stopRatio: 0.05, stopLimit: 0.05 });
      expect(at(5.01).quality).toMatchObject({ level: "blocked", stopLimit: 0.05 });
      // 上限が 5% になる境目: C = 100 で 0.5 / 10 = 5%
      expect(withCv(50, 150, 0).quality.stopLimit).toBe(0.05);
    });
    test("収集の停止: 最も厳しい比較で上限が決まる(重みが等しい 3 群は、どの比較も合計 × 2/3 ÷ 2)", () => {
      // 合計 900(350 + 450 + 100)。重みが等しい 3 群の各比較は 900 × 2 / (2 × 3) = 300 -> 0.5 / √300
      const o = verdict(input([arm("a", 10_000, 350), arm("b", 10_000, 450), arm("c", 10_000, 100)]));
      expect(o.quality.stopLimit).toBeCloseTo(0.5 / Math.sqrt(300), 12);
      // 重み 0 のパターンは数えない(残るのは a と c。合計 450、重みが等しい 2 群なので 225)
      const z = verdict(input([arm("a", 10_000, 350), arm("b", 10_000, 450, { weight: 0 }), arm("c", 10_000, 100)]));
      expect(z.quality.stopLimit).toBeCloseTo(0.5 / 15, 12);
    });
    test("収集の停止: 上限は CV がパターン間でどう分かれても変わらない(合計が同じなら同じ)", () => {
      const lim = (ys: number[]) => verdict(input(ys.map((y, i) => arm(i === 0 ? "a" : `v${i}`, 10_000, y)))).quality.stopLimit;
      expect(lim([300, 500])).toBe(lim([400, 400]));
      expect(lim([100, 500])).toBe(lim([350, 250]));
      expect(lim([200, 300, 400])).toBe(lim([100, 600, 200]));
      expect(lim([200, 300, 400, 500])).toBe(lim([700, 100, 400, 200]));
    });
    test("strictestCvCount: 重みが違う場合は基準と相手の重みの和が最大の比較(合計 × (w基準 + w相手) / (2 × 重みの合計))", () => {
      const arms = [{ id: "a", weight: 50, y: 100 }, { id: "b", weight: 25, y: 300 }, { id: "c", weight: 25, y: 600 }];
      // 合計 1000、重みの合計 100。a-b も a-c も (50 + 25) / 200 × 1000 = 375
      expect(strictestCvCount(arms, "a")).toBe(375);
      // 基準を b にすると b-a が (25 + 50) / 200 × 1000 = 375、b-c は (25 + 25) / 200 × 1000 = 250 -> 375
      expect(strictestCvCount(arms, "b")).toBe(375);
      // 70/30 の 2 群は重みによらず合計の半分
      expect(strictestCvCount([{ id: "a", weight: 70, y: 100 }, { id: "b", weight: 30, y: 300 }], "a")).toBe(200);
      // 4 群(重み 40/20/20/20): 基準 a(40)の比較は (40 + 20) / (2 × 100) × 合計
      expect(strictestCvCount([{ id: "a", weight: 40, y: 100 }, { id: "b", weight: 20, y: 100 }, { id: "c", weight: 20, y: 100 }, { id: "d", weight: 20, y: 100 }], "a")).toBeCloseTo(0.3 * 400, 12);
    });
    test("収集の停止: CV が 0 件なら上限は 5%", () => {
      expect(withCv(0, 0, 0).quality.stopLimit).toBe(0.05);
      expect(withCv(0, 30, 0).quality.stopLimit).toBe(0.05);
    });
    test("stopRatioLimit・strictestCvCount: 純粋関数", () => {
      expect(stopRatioLimit(0)).toBe(0.05);
      expect(stopRatioLimit(100)).toBe(0.05);
      expect(stopRatioLimit(400)).toBe(0.025);
      expect(stopRatioLimit(50_000)).toBeCloseTo(STOP_LIMIT_K / Math.sqrt(50_000), 12);
      expect(stopRatioLimit(Number.NaN)).toBe(0.05);
      expect(strictestCvCount([{ id: "a", weight: 1, y: 10 }, { id: "b", weight: 1, y: 30 }, { id: "c", weight: 1, y: 5 }], "a")).toBe(15); // 合計 45 × 2 / (2 × 3)
      expect(strictestCvCount([{ id: "a", weight: 1, y: 10 }], "a")).toBe(0);
      expect(strictestCvCount([{ id: "a", weight: 1, y: 10 }], "none")).toBe(0);
    });
    test("経過時間が 0 なら stopRatio は 0", () => {
      expect(verdict(input([BASE, GOLDEN_B], { stopMs: 0, elapsedMs: 0 })).quality.stopRatio).toBe(0);
    });
    test("収集できなかった送信の割合: 1% 未満は注意なし、1% 以上は警告(判定は止めない)", () => {
      const at = (failed: number, recorded: number) => verdict(input([BASE, GOLDEN_B], { failedSends: failed, recordedRows: recorded }));
      const below = at(99, 9_901); // 0.99%
      expect(below.quality).toMatchObject({ level: "ok", reasons: [] });
      expect(below.quality.failureRatio).toBeCloseTo(0.0099, 12);
      const edge = at(100, 9_900); // 1% ちょうど
      expect(edge.quality).toMatchObject({ level: "warning", failureRatio: 0.01, reasons: ["collection_failures"] });
      expect(edge.notes).toContainEqual({ key: "collection_failures", params: { ratio: 0.01, failedSends: 100 } });
      expect(state(edge)).toBe("adopt");
      expect(state(at(5_000, 5_000))).toBe("adopt"); // 50% でも判定は止めない
    });
    test("failureRatio の分母が 0 なら 0", () => {
      expect(verdict(input([BASE, GOLDEN_B], { failedSends: 0, recordedRows: 0 })).quality.failureRatio).toBe(0);
    });
    test("混在率: 1% ちょうどは判定する、1% 超は判定不可", () => {
      const withMixed = (mixed: number) => verdict(input([{ ...BASE, mixed: mixed / 2 }, { ...GOLDEN_B, mixed: mixed / 2 }]));
      const edge = withMixed(200); // 200 / 20,000 = 1%
      expect(edge.quality).toMatchObject({ mixedRate: 0.01, level: "ok", reasons: [] });
      expect(state(edge)).toBe("adopt");
      const over = withMixed(202); // 1.01%
      expect(over.quality.level).toBe("blocked");
      expect(over.quality.reasons).toEqual(["quality_blocked_mixed"]);
      expect(over.notes).toContainEqual({ key: "quality_blocked_mixed", params: { rate: 0.0101 } });
      expect(state(over)).toBe("blocked_quality");
    });
    test("適用の失敗: パターンごとに 1% 以上で警告(判定は止めない)", () => {
      const o = verdict(input([BASE, arm("b", 10_000, 560, { applyFailed: 100 })]));
      expect(o.quality.level).toBe("warning");
      expect(o.quality.reasons).toEqual(["apply_failures"]);
      expect(o.notes).toContainEqual({ key: "apply_failures", params: { variantId: "b", rate: 0.01 } });
      expect(state(o)).toBe("adopt");
      expect(keys(verdict(input([BASE, arm("b", 10_000, 560, { applyFailed: 99 })])).notes)).not.toContain("apply_failures");
    });
    test("基準の適用の失敗も警告に数える", () => {
      const o = verdict(input([arm("a", 10_000, 500, { applyFailed: 300, hasChanges: true }), GOLDEN_B]));
      expect(o.notes).toContainEqual({ key: "apply_failures", params: { variantId: "a", rate: 0.03 } });
    });
    test("警告が複数あっても reasons に同じ鍵は 1 回", () => {
      const o = verdict(input(
        [arm("a", 10_000, 500, { applyFailed: 300 }), arm("b", 10_000, 560, { applyFailed: 300 })],
      ));
      expect(o.quality.reasons).toEqual(["apply_failures"]);
      expect(o.notes.filter((n) => n.key === "apply_failures")).toHaveLength(2);
    });
    test("判定不可の原因が複数ならすべて reasons に出す", () => {
      const o = verdict(input([arm("a", 5_200, 260, { mixed: 500 }), arm("b", 4_800, 400)], { stopMs: 10 * HOUR }));
      expect(o.quality.reasons).toEqual(["quality_blocked_srm", "quality_blocked_mixed", "quality_blocked_stops"]);
    });
  });
});

describe("判定に要る最低の件数", () => {
  test("min_count_rule_withholds_verdict", () => {
    const run = (a: [number, number], b: [number, number], over: Partial<VerdictInput> = {}) =>
      verdict(input([arm("a", ...a), arm("b", ...b)], over));
    // 基準 0 人 vs 100 人 / CV 4 → 判定しない(人数のずれは SRM で見るので重みを揃えて品質は別に確かめる)
    const zeroBase = run([0, 0], [100, 4]);
    expect(zeroBase.comparisons[0]).toMatchObject({ minCountMet: false });
    expect(keys(zeroBase.notes)).toContain("min_count_not_met");
    // 1,000 / 4 vs 1,000 / 0 → 判定しない(合算 CVR = 0.2% で 1,000 × 0.002 = 2 件 < 10)
    const lowCv = run([1_000, 4], [1_000, 0]);
    expect(lowCv.comparisons[0]).toMatchObject({ minCountMet: false, state: "insufficient" });
    expect(lowCv.notes).toContainEqual({ key: "min_count_not_met", params: { variantId: "b" } });
    // 1,000 / 50 vs 1,000 / 0 → 判定する(合算 CVR = 2.5% で 1,000 × 0.025 = 25 件)
    const enough = run([1_000, 50], [1_000, 0]);
    expect(enough.comparisons[0]).toMatchObject({ minCountMet: true, state: "worse" });
    expect(keys(enough.notes)).not.toContain("min_count_not_met");
    // ゴールデン値は判定する
    expect(verdict(input([BASE, GOLDEN_B])).comparisons[0]).toMatchObject({ minCountMet: true, state: "adopt" });
  });
  test("境目: 各群で n × 合算 CVR ≥ 10 かつ n × (1 − 合算 CVR) ≥ 10(ちょうど 10 は満たす)", () => {
    const met = (a: [number, number], b: [number, number]) =>
      verdict(input([arm("a", ...a), arm("b", ...b)])).comparisons[0]!.minCountMet;
    expect(met([1_000, 10], [1_000, 10])).toBe(true); // 合算 1% → 各群 10 件
    expect(met([1_000, 9], [1_000, 10])).toBe(false); // 合算 0.95% → 9.5 件
    // 非 CV の側: 全員が CV に近いと 非 CV の見込みが足りない
    expect(met([1_000, 990], [1_000, 990])).toBe(true); // 非 CV の見込み 10
    expect(met([1_000, 991], [1_000, 990])).toBe(false);
  });
  test("人数が違う 2 群: 少ない側の見込みで見る(群自身の CV ではなく合算の CVR)", () => {
    // 基準 10,000 人 / CV 5、相手 100 人 / CV 0: 合算 CVR = 5/10,100 → 相手の見込み = 100 × 0.0005 = 0.05 < 10
    const o = verdict(input([arm("a", 10_000, 5, { weight: 99 }), arm("b", 100, 0, { weight: 1 })]));
    expect(o.comparisons[0]!.minCountMet).toBe(false);
  });
  test("比較ごとに見る(3 群で一方だけ満たす)", () => {
    const o = verdict(input([BASE, GOLDEN_B, arm("c", 10_000, 2)], { plan: plan() }));
    expect(o.comparisons.find((c) => c.variantId === "b")!.minCountMet).toBe(true);
    // 基準 500 + c の 2 = 502 / 20,000 = 2.51% → 各群 251 件で満たす。c の CV が少なくても合算で見る
    expect(o.comparisons.find((c) => c.variantId === "c")!.minCountMet).toBe(true);
    const o2 = verdict(input([arm("a", 1_000, 0), arm("b", 1_000, 60), arm("c", 1_000, 1)]));
    expect(o2.comparisons.find((c) => c.variantId === "b")!.minCountMet).toBe(true);
    expect(o2.comparisons.find((c) => c.variantId === "c")!.minCountMet).toBe(false);
  });
  test("品質が問題なしで件数が足りなければ insufficient で、数値は参考として出る", () => {
    const o = verdict(input([arm("a", 1_000, 4), arm("b", 1_000, 0)]));
    expect(o.comparisons[0]!.state).toBe("insufficient");
    expect(o.comparisons[0]!.summary.pBelowZero).toBeGreaterThan(0.9);
  });
});

describe("3 つ以上", () => {
  test("3 つ以上: しきい値を m で引き上げ、採用候補が複数なら両方に付ける", () => {
    // 2 群ならゴールデン値(97.08%)は 95% を超えて採用候補。3 群(m = 2)では 97.5% に上がり届かない
    const two = verdict(input([BASE, GOLDEN_B]));
    expect(state(two)).toBe("adopt");
    const three = verdict(input([BASE, GOLDEN_B, arm("c", 10_000, 500)]));
    expect(three.m).toBe(2);
    expect(three.threshold).toBeCloseTo(97.5, 12);
    expect(three.threshold).toBe(effectiveThreshold(95, 2));
    expect(state(three, "b")).toBe("insufficient");
    expect(state(three, "c")).toBe("insufficient");
    // 採用候補が複数: 両方に adopt が付き、最良である確率を添える
    const multi = verdict(input([BASE, arm("b", 10_000, 640), arm("c", 10_000, 650)]));
    expect(state(multi, "b")).toBe("adopt");
    expect(state(multi, "c")).toBe("adopt");
    const pb = multi.comparisons.map((c) => c.probBest!);
    expect(pb.every((p) => p > 0 && p < 1)).toBe(true);
    expect(pb[1]!).toBeGreaterThan(pb[0]!); // 650 の方が最良である確率が高い
    const expected = probBest([{ n: 10_000, y: 500 }, { n: 10_000, y: 640 }, { n: 10_000, y: 650 }]);
    expect(pb[0]!).toBeCloseTo(expected[1]!, 12);
    expect(pb[1]!).toBeCloseTo(expected[2]!, 12);
  });
  test("引き上げ後のしきい値は 悪化 にも同様に効く", () => {
    // pBelowZero(b) ≈ 0.9666(500 対 445)は 95% を超えるが 97.5% には届かない
    expect(state(verdict(input([BASE, arm("b", 10_000, 445)])))).toBe("worse");
    const o = verdict(input([BASE, arm("b", 10_000, 445), arm("c", 10_000, 500)]));
    expect(o.comparisons.find((c) => c.variantId === "b")!.summary.pBelowZero).toBeGreaterThan(0.95);
    expect(state(o, "b")).toBe("insufficient");
  });
  test("probBest は基準を含む全群の中で出す(基準の確率は comparisons に出ないが、合計で 1)", () => {
    const o = verdict(input([BASE, GOLDEN_B, arm("c", 10_000, 520)]));
    const arms = [{ n: 10_000, y: 500 }, { n: 10_000, y: 560 }, { n: 10_000, y: 520 }];
    const exp = probBest(arms);
    expect(o.comparisons[0]!.probBest).toBeCloseTo(exp[1]!, 12);
    expect(o.comparisons[1]!.probBest).toBeCloseTo(exp[2]!, 12);
    expect(exp[0]! + o.comparisons[0]!.probBest! + o.comparisons[1]!.probBest!).toBeCloseTo(1, 12);
  });
  test("summary は diffSummary(基準, 相手, δ, ROPE) そのもの", () => {
    const p = plan({ delta: 0.1, rope: 0.5 });
    const o = verdict(input([BASE, GOLDEN_B], { plan: p }));
    expect(o.comparisons[0]!.summary).toEqual(diffSummary({ n: 10_000, y: 500 }, { n: 10_000, y: 560 }, 0.1, 0.5));
    expect(o.comparisons[0]!.summary.pBelowZero).toBeCloseTo(1 - probBeat({ n: 10_000, y: 500 }, { n: 10_000, y: 560 }), 12);
  });
});

describe("重み 0 のパターン", () => {
  test("srm_ignores_zero_weight_variant", () => {
    const with0 = verdict(input([BASE, GOLDEN_B, arm("c", 0, 0, { weight: 0 })]));
    const without = verdict(input([BASE, GOLDEN_B]));
    // SRM: 重み 0 の群を渡すと例外になる srm を、verdict は呼ばずに除いて同じ p を出す
    expect(with0.quality.srmP).toBe(without.quality.srmP);
    // m: 重み 0 は数えない(しきい値は引き上がらない)
    expect(with0.m).toBe(1);
    expect(with0.threshold).toBe(95);
    // 判定: ほかの比較の結果は変わらない
    expect(state(with0, "b")).toBe("adopt");
    expect(with0.comparisons.find((c) => c.variantId === "b")).toEqual(without.comparisons[0]);
    // 重み 0 の比較は配信していない: 状態は insufficient 以外のラベルを持たず、注記 zero_weight が付く
    expect(with0.comparisons.find((c) => c.variantId === "c")).toMatchObject({ state: "insufficient", minCountMet: false, probBest: null });
    expect(with0.notes).toContainEqual({ key: "zero_weight", params: { variantId: "c" } });
    expect(keys(without.notes)).not.toContain("zero_weight");
    // 重み 0 の群は min_count_not_met の注記も付けない(配信していないため)
    expect(with0.notes).not.toContainEqual({ key: "min_count_not_met", params: { variantId: "c" } });
  });
  test("重み 0 の群に人数が残っていても SRM・probBest・混在率の群には数えない(混在率は全体の参加者を分母にする)", () => {
    const three = [BASE, GOLDEN_B, arm("c", 7, 1, { weight: 0 })];
    const o = verdict(input(three));
    expect(o.comparisons.find((c) => c.variantId === "c")!.state).toBe("insufficient");
    expect(o.comparisons.find((c) => c.variantId === "b")!.probBest).toBeNull(); // 配信中は 2 群なので probBest は出さない
    expect(o.m).toBe(1);
  });
  test("重み 0 を除いて 3 群になれば probBest は配信中の群だけで出す", () => {
    const o = verdict(input([BASE, GOLDEN_B, arm("c", 10_000, 520), arm("d", 0, 0, { weight: 0 })]));
    const exp = probBest([{ n: 10_000, y: 500 }, { n: 10_000, y: 560 }, { n: 10_000, y: 520 }]);
    expect(o.comparisons.find((c) => c.variantId === "b")!.probBest).toBeCloseTo(exp[1]!, 12);
    expect(o.comparisons.find((c) => c.variantId === "d")!.probBest).toBeNull();
    expect(o.m).toBe(2);
  });
  test("基準の重みが 0、または基準が arms に無いのは入力の誤り(開始の検査で防ぐ)として例外", () => {
    expect(() => verdict(input([arm("a", 100, 1, { weight: 0 }), arm("b", 100, 1)]))).toThrow(RangeError);
    expect(() => verdict(input([arm("b", 100, 1)]))).toThrow(RangeError);
    expect(() => verdict(input([arm("a", 100, 1)], { plan: plan({ baselineVariantId: null }) }))).toThrow(RangeError);
  });
});

describe("注記", () => {
  test("aa_test: 基準とほかのどれかの両方に Change が無い", () => {
    const aa = verdict(input([arm("a", 10_000, 500, { hasChanges: false }), arm("b", 10_000, 510, { hasChanges: false })]));
    expect(keys(aa.notes)).toContain("aa_test");
    const mixedChanges = verdict(input([arm("a", 10_000, 500, { hasChanges: false }), arm("b", 10_000, 510), arm("c", 10_000, 505, { hasChanges: false })]));
    expect(keys(mixedChanges.notes)).toContain("aa_test");
    expect(keys(verdict(input([arm("a", 10_000, 500, { hasChanges: false }), arm("b", 10_000, 510)])).notes)).not.toContain("aa_test");
    // 基準に Change があれば A/A ではない
    expect(keys(verdict(input([arm("a", 10_000, 500, { hasChanges: true }), arm("b", 10_000, 510, { hasChanges: false })])).notes)).not.toContain("aa_test");
    // 配信していない(重み 0)パターンだけが Change 無しなら A/A ではない
    expect(keys(verdict(input([arm("a", 10_000, 500, { hasChanges: false }), arm("b", 10_000, 510), arm("c", 0, 0, { weight: 0, hasChanges: false })])).notes)).not.toContain("aa_test");
  });
  test("baseline_not_original: 基準に Change がある", () => {
    expect(keys(verdict(input([arm("a", 10_000, 500, { hasChanges: true }), arm("b", 10_000, 510)])).notes)).toContain("baseline_not_original");
    expect(keys(verdict(input([BASE, GOLDEN_B])).notes)).not.toContain("baseline_not_original");
  });
  test("verdict が出さない鍵(速報・記録・テスト中の変更など)は notes に入らない", () => {
    const o = verdict(input([BASE, GOLDEN_B, arm("c", 0, 0, { weight: 0 })], { stopMs: HOUR, failedSends: 200 }));
    const outside: NoteKey[] = ["interim", "interim_stale", "stopped_early", "test_changes", "plan_changes", "purged", "not_recorded", "store_missing", "definition_missing", "edited_after_evaluation", "unpublished_changes"];
    for (const k of outside) expect(keys(o.notes)).not.toContain(k);
  });
  test("品質の理由はすべて notes にも入る", () => {
    const o = verdict(input([arm("a", 5_200, 260, { mixed: 500 }), arm("b", 4_800, 400)], { stopMs: 10 * HOUR, failedSends: 500 }));
    for (const r of o.quality.reasons) expect(keys(o.notes)).toContain(r);
    expect(keys(o.notes)).toContain("quality_blocked_srm");
    expect(o.notes.find((n) => n.key === "quality_blocked_srm")!.params).toEqual({ p: o.quality.srmP });
  });
});

describe("端の入力", () => {
  test("全群 0 人: 例外にならず、判断材料が不足", () => {
    const o = verdict(input([arm("a", 0, 0), arm("b", 0, 0)]));
    expect(o.quality).toMatchObject({ level: "ok", mixedRate: 0 });
    expect(o.comparisons[0]).toMatchObject({ state: "insufficient", minCountMet: false });
  });
  test("全員 CV: 件数が足りても 差は付かず 判断材料が不足", () => {
    const o = verdict(input([arm("a", 1_000, 1_000), arm("b", 1_000, 1_000)]));
    expect(o.comparisons[0]!.minCountMet).toBe(false); // 非 CV の見込みが 0
    expect(o.comparisons[0]!.state).toBe("insufficient");
  });
  test("有効な群が基準だけなら srmP は null(検定できない)", () => {
    expect(verdict(input([BASE])).quality.srmP).toBeNull();
    expect(verdict(input([BASE, arm("c", 0, 0, { weight: 0 })])).quality.srmP).toBeNull();
  });
  test("不正な人数(負・y > n)は握りつぶさず例外", () => {
    expect(() => verdict(input([BASE, arm("b", 10, 20)]))).toThrow(RangeError);
    expect(() => verdict(input([BASE, arm("b", -1, 0)]))).toThrow(RangeError);
  });
});
