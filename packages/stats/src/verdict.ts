// 判定: 品質を先に見て、そのあと基準以外のパターンごとに 5 状態を当てはめる。乱数なし。

import { type DiffSummary, diffSummary, probBest } from "./compare";
import type { EvaluationPlan } from "./evaluation-plan";
import type { Note, NoteKey } from "./notes";
import { effectiveThreshold } from "./sample-size";
import { srm } from "./srm";

/** 状態。重み 0 のパターン(配信していない)は insufficient を持ち、zero_weight の注記で区別する。 */
export type VerdictState = "blocked_quality" | "adopt" | "worse" | "equivalent" | "insufficient";

export type VerdictInput = {
  plan: EvaluationPlan;
  arms: Array<{
    id: string; weight: number; n: number; y: number;
    /** 複数のパターンを見た人(最初のパターンに数えた分の件数)。 */
    mixed: number;
    /** 回復していない適用の失敗の人数。 */
    applyFailed: number;
    /** そのパターンに Change があるか(A/A と基準の注記に使う)。 */
    hasChanges: boolean;
  }>;
  /** 開始から cutoff までに収集が止まっていた時間(ms)。 */
  stopMs: number;
  /** 開始から cutoff までの時間(ms)。 */
  elapsedMs: number;
  /** 収集できなかった送信の数。 */
  failedSends: number;
  /** 保存できた行の数。 */
  recordedRows: number;
};

export type VerdictOutput = {
  quality: {
    /** SRM の p。検定できない(配信中の群が 2 つ未満)なら null。 */
    srmP: number | null;
    mixedRate: number;
    stopRatio: number;
    /** 収集の停止の割合の上限(これを超えたら判定不可)。最も厳しい比較の CV の件数から決まる(stopRatioLimit)。 */
    stopLimit: number;
    failureRatio: number;
    level: "ok" | "warning" | "blocked";
    reasons: NoteKey[];
  };
  comparisons: Array<{
    variantId: string;
    state: VerdictState;
    /** 判定に要る最低の件数を満たすか。 */
    minCountMet: boolean;
    summary: DiffSummary;
    /** 最良である確率。配信中の群が 3 つ以上のときだけ。 */
    probBest: number | null;
    applyFailedRate: number;
  }>;
  /** 比較の回数 m で引き上げた後のしきい値(%)。 */
  threshold: number;
  /** 比較の回数(重み 0 を除く、基準以外のパターンの数)。 */
  m: number;
  notes: Note[];
};

/** SRM の判定不可の p。 */
const SRM_BLOCK_P = 0.001;
/** 混在率がこれを超えたら判定不可。 */
const MIXED_BLOCK_RATE = 0.01;
/** 収集の停止の割合の上限の最大値。CV が少ないテストではこれが上限になる。 */
export const STOP_LIMIT_MAX = 0.05;
/**
 * 収集の停止の割合の上限 = min(STOP_LIMIT_MAX, STOP_LIMIT_K / √C)。C = 最も厳しい比較の CV の件数(全体の CV の合計と重みから決める。strictestCvCount)。
 *
 * 決め方: 停止の時間帯は参加の記録も CV の記録も欠かす。CV までの時間がパターンで違うと、停止の間に起きる
 * はずだった CV の割合がパターンで違うため、CVR に偏りが出る(参加者数は同じなので SRM では見つからない)。
 * シミュレーションの悪い側(CV までの時間の差が大きい組。平均 2 日で 60% が同じ訪問 対 平均 5 日で 20%)で、
 * 停止の割合 s のとき CVR の相対的な偏りは約 0.38 × s。一方、2 群の CVR の差の標準偏差は相対で約 √(2 / C)(C は 1 群あたりの CV の件数)。
 * 偏りを標準偏差で測ると 約 0.27 × s × √C なので、s を k / √C に抑えれば人数によらず 約 0.27 × k で一定になる。
 * 差が無いときの「採用候補」(または「悪化」)の率が想定(片方向、比較ごと)の 1.5 倍以内に収まる
 * 偏りの大きさは、2 群で約 0.2 標準偏差まで、3 群で約 0.18、4 群で約 0.17。k = 0.5 だと約 0.14。
 * 確かめ方: sim で、停止の割合を実行ごとの実際の上限の付近(見込みの上限の 85〜115%)に散らし、実際の上限に対する
 * 停止の割合 ρ の帯ごとに、判定が出た実行だけの誤りの率を見る。ρ が 100% 以下の帯(判定が出る)で、CV までの時間の差が
 * 大きい組・小さい組、重みが等しい / 等しくない、停止の位置 random / start、1 群 約 4 千人〜約 98 万人(CV 約 200〜約 5 万件)で、
 * 差が無いときの片方向の率の最大は 2 群 7.1%(1.5 倍の関門 7.5%)・3 群 3.7%(3.75%)・4 群 2.4%(2.5%)。
 * 理論値(上限に張り付いたときの偏り約 0.14 標準偏差)は 2 群 約 6.6%・3 群 約 3.4%・4 群 約 2.3% で、関門との余裕は約 1 割。
 * 余裕は大きくないので k は上げない。ρ が 100% を超える帯は、全規模で判定が出ない(判定が出た比較 0 件)。
 * 5% で頭打ちなのは、CV が少ないテストでは偏りが標準誤差に比べて無視できるため。
 */
export const STOP_LIMIT_K = 0.5;
/** 収集できなかった送信の割合・適用の失敗の割合がこれ以上なら警告。 */
const WARN_RATE = 0.01;
/** 最低の件数(各群の CV の見込み・非 CV の見込み)。 */
const MIN_EXPECTED_COUNT = 10;
const HOUR_MS = 3_600_000;

function assertFiniteNonNegative(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`verdict: ${name} は 0 以上の有限の数です: ${v}`);
}

function validate(input: VerdictInput): void {
  for (const a of input.arms) {
    assertFiniteNonNegative(`weight(${a.id})`, a.weight);
    assertFiniteNonNegative(`n(${a.id})`, a.n);
    assertFiniteNonNegative(`y(${a.id})`, a.y);
    assertFiniteNonNegative(`mixed(${a.id})`, a.mixed);
    assertFiniteNonNegative(`applyFailed(${a.id})`, a.applyFailed);
    if (a.y > a.n) throw new RangeError(`verdict: CV した人(${a.y})が参加者(${a.n})より多いパターンがあります: ${a.id}`);
  }
  assertFiniteNonNegative("stopMs", input.stopMs);
  assertFiniteNonNegative("elapsedMs", input.elapsedMs);
  assertFiniteNonNegative("failedSends", input.failedSends);
  assertFiniteNonNegative("recordedRows", input.recordedRows);
}

/**
 * 2 群を合わせた CVR で、両群の CV の見込み(n × p)と非 CV の見込み(n × (1 − p))がともに 10 以上か。
 * 割り算を最後にして、ちょうど 10 のときの誤差を避ける。2 群とも 0 人なら満たさない。
 */
function minCountMet(a: { n: number; y: number }, b: { n: number; y: number }): boolean {
  const total = a.n + b.n;
  if (total === 0) return false;
  const y = a.y + b.y;
  for (const g of [a, b]) {
    if ((g.n * y) / total < MIN_EXPECTED_COUNT) return false;
    if ((g.n * (total - y)) / total < MIN_EXPECTED_COUNT) return false;
  }
  return true;
}

/**
 * 収集の停止の割合の上限。cvCount = 最も厳しい比較の CV の件数(strictestCvCount)。0 以下なら STOP_LIMIT_MAX。
 * 画面と説明が上限を示すためにも使う。
 */
export function stopRatioLimit(cvCount: number): number {
  if (!Number.isFinite(cvCount) || cvCount <= 0) return STOP_LIMIT_MAX;
  return Math.min(STOP_LIMIT_MAX, STOP_LIMIT_K / Math.sqrt(cvCount));
}

/**
 * 最も厳しい比較の CV の件数 C。重み 0 を除く基準以外のパターン k ごとに
 *   C_k = (配信中の全パターンの CV の合計) × (基準の重み + k の重み) / (2 × 配信中の重みの合計)
 * を取り、その最大を返す(大きいほど偏りが検出されやすく、上限が厳しくなる)。比べる相手が無ければ 0。
 *
 * 比較する 2 群の CV の件数ではなく、全体の CV の合計と設計の重みだけから決める。2 群の CV の件数(min でも平均でも)を
 * 使うと、基準の CV がたまたま少なかった実行ほど上限が緩くなり、判定不可になるかどうかが結果に左右されて、
 * 偏りが無くても判定が出た実行だけの誤りの率が上がる(基準は全比較で共通で、比較の最大を取るので 3 群以上で強く出る)。
 * 合計と重みなら、CV がパターン間でどう分かれても C は変わらない。重みが等しい 2 群では 2 群の CV の平均に等しい。
 */
export function strictestCvCount(arms: Array<{ id: string; weight: number; y: number }>, baselineId: string | null): number {
  const base = arms.find((a) => a.id === baselineId);
  if (base === undefined || base.weight <= 0) return 0;
  const active = arms.filter((a) => a.weight > 0);
  const totalY = active.reduce((t, a) => t + a.y, 0);
  const totalW = active.reduce((t, a) => t + a.weight, 0);
  let c = 0;
  for (const a of active) {
    if (a === base) continue;
    c = Math.max(c, (totalY * (base.weight + a.weight)) / (2 * totalW));
  }
  return c;
}

/**
 * 判定。
 *  1. 品質(テスト全体): SRM p < 0.001・混在率 > 1%・収集の停止 > 上限(stopRatioLimit。5% 以下)のどれかなら blocked。
 *     blocked なら配信中のすべての比較が blocked_quality(数値は参考として出す)。
 *     警告(判定は止めない): 収集の停止 > 0 かつ上限以下・収集できなかった送信の割合 >= 1%・
 *     適用の失敗の割合 >= 1%(パターンごと)。
 *  2. 比較ごと(基準以外・重み 0 を除く): 最低の件数を満たさなければ insufficient。満たせば上から順に
 *     P(差 > δ) >= t → adopt / P(差 < 0) >= t → worse / ROPE ありで P(|差| < ROPE) >= t → equivalent /
 *     どれでもなければ insufficient。t = effectiveThreshold(しきい値, m)。
 *  - 重み 0 のパターン: SRM・m・probBest・A/A の判定から外し、比較には zero_weight の注記と
 *    state = insufficient(minCountMet = false、probBest = null)を付ける。ラベルは画面が注記で置き換える。
 *    混在率は全パターンの参加者を分母にするテスト全体の値。
 *  - 基準が arms に無い・重み 0 の入力は例外(開始の検査で防ぐ値。握りつぶして誤った判定を出さない)。
 */
export function verdict(input: VerdictInput): VerdictOutput {
  validate(input);
  const { plan, arms } = input;
  const baseline = arms.find((a) => a.id === plan.baselineVariantId);
  if (baseline === undefined) throw new RangeError(`verdict: 基準のパターンが arms にありません: ${String(plan.baselineVariantId)}`);
  if (baseline.weight <= 0) throw new RangeError(`verdict: 基準のパターンの重みが 0 です: ${baseline.id}`);

  const active = arms.filter((a) => a.weight > 0);
  const m = active.length - 1;
  const threshold = m === 0 ? plan.threshold : effectiveThreshold(plan.threshold, m);
  const t = threshold / 100;

  // --- 品質 ---
  const totalN = arms.reduce((s, a) => s + a.n, 0);
  const srmP = active.length >= 2 ? srm(active.map((a) => a.n), active.map((a) => a.weight)) : null;
  const mixedRate = totalN === 0 ? 0 : arms.reduce((s, a) => s + a.mixed, 0) / totalN;
  const stopRatio = input.elapsedMs === 0 ? 0 : input.stopMs / input.elapsedMs;
  const stopLimit = stopRatioLimit(strictestCvCount(active, plan.baselineVariantId));
  const sends = input.failedSends + input.recordedRows;
  const failureRatio = sends === 0 ? 0 : input.failedSends / sends;

  const blockNotes: Note[] = [];
  const warnNotes: Note[] = [];
  if (srmP !== null && srmP < SRM_BLOCK_P) blockNotes.push({ key: "quality_blocked_srm", params: { p: srmP } });
  if (mixedRate > MIXED_BLOCK_RATE) blockNotes.push({ key: "quality_blocked_mixed", params: { rate: mixedRate } });
  if (stopRatio > stopLimit) {
    blockNotes.push({ key: "quality_blocked_stops", params: { ratio: stopRatio, limit: stopLimit } });
  } else if (stopRatio > 0) {
    warnNotes.push({ key: "collection_stops", params: { ratio: stopRatio, hours: input.stopMs / HOUR_MS, limit: stopLimit } });
  }
  if (failureRatio >= WARN_RATE) {
    warnNotes.push({ key: "collection_failures", params: { ratio: failureRatio, failedSends: input.failedSends } });
  }
  for (const a of active) {
    const rate = a.n === 0 ? 0 : a.applyFailed / a.n;
    if (rate >= WARN_RATE) warnNotes.push({ key: "apply_failures", params: { variantId: a.id, rate } });
  }
  const level = blockNotes.length > 0 ? "blocked" : warnNotes.length > 0 ? "warning" : "ok";
  const qualityNotes = [...blockNotes, ...warnNotes];
  const reasons = [...new Set(qualityNotes.map((n) => n.key))];

  // --- 比較 ---
  const best = active.length >= 3 ? probBest(active.map((a) => ({ n: a.n, y: a.y }))) : null;
  const bestById = new Map<string, number>();
  if (best !== null) active.forEach((a, i) => bestById.set(a.id, best[i]!));

  const comparisonNotes: Note[] = [];
  const comparisons: VerdictOutput["comparisons"] = [];
  for (const a of arms) {
    if (a === baseline) continue;
    const summary = diffSummary({ n: baseline.n, y: baseline.y }, { n: a.n, y: a.y }, plan.delta, plan.rope);
    const applyFailedRate = a.n === 0 ? 0 : a.applyFailed / a.n;
    if (a.weight <= 0) {
      comparisonNotes.push({ key: "zero_weight", params: { variantId: a.id } });
      comparisons.push({ variantId: a.id, state: "insufficient", minCountMet: false, summary, probBest: null, applyFailedRate });
      continue;
    }
    const met = minCountMet(baseline, a);
    if (!met) comparisonNotes.push({ key: "min_count_not_met", params: { variantId: a.id } });
    let state: VerdictState;
    if (level === "blocked") state = "blocked_quality";
    else if (!met) state = "insufficient";
    else if (summary.pAboveDelta >= t) state = "adopt";
    else if (summary.pBelowZero >= t) state = "worse";
    else if (summary.pWithinRope !== null && summary.pWithinRope >= t) state = "equivalent";
    else state = "insufficient";
    comparisons.push({ variantId: a.id, state, minCountMet: met, summary, probBest: bestById.get(a.id) ?? null, applyFailedRate });
  }

  // --- 定義から出す注記 ---
  const definitionNotes: Note[] = [];
  const others = active.filter((a) => a !== baseline);
  if (!baseline.hasChanges && others.some((a) => !a.hasChanges)) definitionNotes.push({ key: "aa_test" });
  if (baseline.hasChanges) definitionNotes.push({ key: "baseline_not_original" });

  return {
    quality: { srmP, mixedRate, stopRatio, stopLimit, failureRatio, level, reasons },
    comparisons,
    threshold,
    m,
    notes: [...qualityNotes, ...comparisonNotes, ...definitionNotes],
  };
}
