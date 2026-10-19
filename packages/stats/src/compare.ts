// 2 群の比較と、複数群の「最良である確率」。乱数は使わない(同じ入力で同じ出力)。
//
// 群 = { n: 参加者, y: CV した人 }。事後分布は Beta(1 + y, 1 + n − y)。
// 差 D = θ_b − θ_a(b が比べられる側、a が基準)。diffSummary の差はポイント(割合 × 100)。

import { type Arm, betaMoments, closedFormTerms, posterior, probBeatClosedForm } from "./beta";
import { inverseNormalCdf, normalCdf, normalPdf } from "./normal";

export type { Arm } from "./beta";

/**
 * 閉形式(Evan Miller の和)の項数の上限。項数 = 1 + min(CV, 非 CV)(2 群のうち小さい側)。
 * 上限を超えたら、各群の事後分布の平均と分散から差を正規分布で近似する。
 *
 * 決め方(K20): 1 回の結果の計算(基準との比較 最大 5 回の probBeat + diffSummary + probBest)を
 * 5 ms 以下にする。Node v24(V8、Apple M 系)での probBeatClosedForm の計測(中央値、ウォームアップ後。
 * 隣り合う項の比で回すので 1 項あたり乗除算数回):
 *   項数      1,000 → 0.005 ms /  10,000 → 0.011 ms /  50,000 → 0.052 ms /  100,000 → 0.104 ms
 *   200,000 → 0.209 ms /  500,000 → 0.587 ms / 1,000,000 → 1.167 ms
 * 上限 100,000 なら probBeat は最大 0.10 ms。基準 + 5 パターンの 1 回の結果(srm + 5 回の probBeat / diffSummary
 * + probBest。CV 数がすべて上限ぎりぎり)を通しで測ると、中央値 1.1 ms・最大 1.7 ms(数値積分の側は不均衡な
 * 組を含めて 中央値 0.5〜0.7 ms・最大 1.4 ms)で、
 * Workers 実機が 3 倍遅くても 5 ms に収まる(実機の確認は Task 3)。上限を 1,000,000 にすると probBeat だけで
 * 1.2 ms × 5 になり余裕が無くなるので、100,000 にした。
 * 精度は上限に左右されない: 正規近似の誤差は項数 1,000 で 5e-5、10,000 で 5e-6、100,000 で 5e-7(確率)で、
 * 許す誤差 0.1 ポイント(0.001)より 3 桁小さい。
 */
export const CLOSED_FORM_MAX_TERMS = 100_000;

/**
 * diffSummary を数値積分で出す境目: 2 群の min(CV, 非 CV) がこの値より小さいとき。
 *
 * 決め方(K20): 初期値 30 から、正規近似と数値積分の差を min(CV, 非 CV) = 10〜300 で測った
 * (CVR 0.1〜5% 前後・人数 20 倍〜1,000 倍・2 群の差 −0.8〜+2 標準偏差・δ は 0.001 と 0.2 ポイント):
 *   min    30 → 確率の差 最大 0.0021 / ROPE 0.0028 / 区間端 0.7%(区間幅比)/ 損失 3.4%
 *   min   100 → 確率 0.0009 / ROPE 0.0011 / 区間端 0.24% / 損失 1.3%
 *   min   150 → 確率 0.0007 / ROPE 0.0007 / 区間端 0.17% / 損失 0.9%
 *   min   300 → 確率 0.0004 / ROPE 0.0002 / 区間端 0.09% / 損失 0.5%
 * 許す誤差は確率で 0.1 ポイント(0.001)なので、確率と ROPE がともにそれ以下になる 150 にした。
 * 数値積分の計算量は 2 群の刻み数の積で決まる(MAX_WORK で上限を置く)。均衡した 2 群(1 回 0.09 ms)から、
 * 上限なしだと人数の桁が違う組(基準 {1490, 149} と相手 n ≈ 64 倍で最大 0.63 ms)まで膨らむため、
 * 刻みの積が 150,000 を超えたら刻みを粗くする。粗くした後も、上限なしの細かい刻み(1 刻み 1/64 標準偏差)との差は
 * 基準 5 通り × 相手 10 通りの人数比(1〜1000 倍)× CVR 4 通り × δ 2 通りで、確率・ROPE とも最大 0.00005。
 * 1 回の計算は人数比によらず 0.09〜0.15 ms(最悪の形: 基準 {1490, 149}・相手 n ≈ 400〜1000 倍で 0.15 ms)。
 * Task 3 の CPU bench に入れる最悪の形: 基準 {1490, 149}・相手 {1490 × 64, 149 × 64}(上限なしだった頃の最悪の形)と
 * 相手 n ≈ 400 倍(上限ありでの最悪の形)。
 */
export const NUMERIC_BELOW = 150;

export type DiffSummary = {
  /** 差(b − a)の事後平均。ポイント。 */
  mean: number;
  /** 差の 95% 信用区間。ポイント。 */
  ci95: [number, number];
  /** 差の事後平均 ÷ 基準の CVR の事後平均(%)。基準の CV が 0 件なら null。 */
  relMean: number | null;
  /** 差の 95% 区間 ÷ 基準の CVR の事後平均(%)。基準の CV が 0 件なら null。 */
  relCi95: [number, number] | null;
  /** P(差 > δ)。δ = 0 は probBeat(閉形式)。 */
  pAboveDelta: number;
  /** P(差 < 0)= 1 − probBeat。 */
  pBelowZero: number;
  /** P(|差| < ROPE)。ROPE が null なら null。 */
  pWithinRope: number | null;
  /** b を採用して実は基準より悪かった場合に失う CV 数の見込み(1 万人あたり)。 */
  expectedLossPer10k: number;
};

/** P(θ_b > θ_a)。 */
export function probBeat(a: Arm, b: Arm): number {
  if (closedFormTerms(a, b) <= CLOSED_FORM_MAX_TERMS) return probBeatClosedForm(a, b);
  return normalProbBeat(a, b);
}

function normalProbBeat(a: Arm, b: Arm): number {
  const pa = posterior(a), pb = posterior(b);
  const ma = betaMoments(pa.alpha, pa.beta), mb = betaMoments(pb.alpha, pb.beta);
  return normalCdf((mb.mean - ma.mean) / Math.sqrt(ma.variance + mb.variance));
}

// ---------------------------------------------------------------------------
// diffSummary
// ---------------------------------------------------------------------------

/**
 * 差の分布の要約。delta・rope はポイント(0.2 = +0.2 ポイント)。
 *  - 各群の min(CV, 非 CV) がすべて NUMERIC_BELOW 以上: 差を正規分布で近似(平均・分散は Beta の厳密な値)
 *  - それ未満の群がある: 2 つの Beta 密度を固定の刻みで離散化してたたみ込む数値積分
 */
export function diffSummary(a: Arm, b: Arm, delta: number, rope: number | null): DiffSummary {
  const pa = posterior(a), pb = posterior(b);
  const smallest = Math.min(pa.alpha, pa.beta, pb.alpha, pb.beta) - 1; // min(CV, 非 CV)
  return diffSummaryBy(smallest < NUMERIC_BELOW ? "numeric" : "normal", a, b, delta, rope);
}

/** 近似の方法を指定して diffSummary を出す(境目の誤差の検査・計測用。普通は diffSummary を使う)。 */
export function diffSummaryBy(
  method: "numeric" | "normal", a: Arm, b: Arm, delta: number, rope: number | null, grid?: GridOptions,
): DiffSummary {
  const pa = posterior(a), pb = posterior(b);
  const ma = betaMoments(pa.alpha, pa.beta), mb = betaMoments(pb.alpha, pb.beta);
  const meanFrac = mb.mean - ma.mean;
  const d = delta / 100;
  const r = rope === null ? null : rope / 100;
  const pBeat = probBeat(a, b);

  const dist = method === "numeric"
    ? numericDifference(pa, pb, grid)
    : normalDifference(meanFrac, Math.sqrt(ma.variance + mb.variance));

  const ci: [number, number] = [dist.quantile(0.025) * 100, dist.quantile(0.975) * 100];
  // 相対(%)= 差 ÷ 基準の CVR の事後平均。基準の CV が 0 件だと分母がほぼ 0 で意味を持たないので null
  const base = a.y > 0 ? ma.mean : null;
  return {
    mean: meanFrac * 100,
    ci95: ci,
    relMean: base === null ? null : (meanFrac / base) * 100,
    relCi95: base === null ? null : [ci[0] / base, ci[1] / base],
    pAboveDelta: d === 0 ? pBeat : 1 - dist.cdf(d),
    pBelowZero: 1 - pBeat,
    pWithinRope: r === null ? null : Math.max(0, dist.cdf(r) - dist.cdf(-r)),
    expectedLossPer10k: dist.lossBelowZero() * 10_000,
  };
}

/**
 * 端末別・ほかの目標の行(判定しない参考の値)に使う差の要約。閉形式も数値積分も使わず、
 * 各群の事後分布の平均と分散から差を正規分布で近似するだけ(設計書 §7.2)。単位はポイント。
 * 人数が少ない行では diffSummary より誤差が大きい(参考値として出す)。乱数なし。
 */
export function diffNormal(a: Arm, b: Arm): { mean: number; ci95: [number, number] } {
  const pa = posterior(a), pb = posterior(b);
  const ma = betaMoments(pa.alpha, pa.beta), mb = betaMoments(pb.alpha, pb.beta);
  const mean = mb.mean - ma.mean;
  const sd = Math.sqrt(ma.variance + mb.variance);
  const dist = normalDifference(mean, sd);
  return { mean: mean * 100, ci95: [dist.quantile(0.025) * 100, dist.quantile(0.975) * 100] };
}

/** 差の分布(割合)に対する操作。 */
type Dist = {
  cdf(x: number): number;
  quantile(p: number): number;
  /** E[max(−D, 0)] */
  lossBelowZero(): number;
};

function normalDifference(mean: number, sd: number): Dist {
  return {
    cdf: (x) => normalCdf((x - mean) / sd),
    quantile: (p) => mean + sd * inverseNormalCdf(p),
    lossBelowZero: () => sd * normalPdf(mean / sd) - mean * (1 - normalCdf(mean / sd)),
  };
}

// 数値積分の設定
const RANGE_SD = 10;          // 各群の密度を平均 ± 10 標準偏差(0〜1 に切る)で打ち切る
const POINTS_PER_SD = 16;     // 狭い方の群の標準偏差あたりの刻み数
const MAX_CELLS = 2_500;      // 広い方の群の刻み数の上限(刻みが細かすぎて計算が膨らむのを防ぐ)
const MAX_WORK = 150_000;     // たたみ込みの計算量(2 群の刻み数の積)の上限。超えるなら刻みを粗くする

type Grid = { weights: Float64Array; origin: number };
/** 数値積分の刻みの設定(既定は上の定数。計測・収束の確認用に上書きできる)。 */
export type GridOptions = { pointsPerSd?: number; maxCells?: number; maxWork?: number };

/** Beta(α, β) の密度を、左端 lo から刻み step のセル(中点則)に離散化する。質量は合計 1。 */
function betaGrid(alpha: number, beta: number, step: number): Grid {
  const { mean, variance } = betaMoments(alpha, beta);
  const sd = Math.sqrt(variance);
  const lo = Math.max(0, mean - RANGE_SD * sd), hi = Math.min(1, mean + RANGE_SD * sd);
  const cells = Math.max(1, Math.ceil((hi - lo) / step - 1e-9));
  const logw = new Float64Array(cells);
  let max = -Infinity;
  for (let i = 0; i < cells; i++) {
    const cellLo = lo + i * step, cellHi = Math.min(hi, cellLo + step);
    const x = (cellLo + cellHi) / 2;                       // 0 < x < 1(端のセルも中央で評価する)
    const l = (alpha - 1) * Math.log(x) + (beta - 1) * Math.log(1 - x) + Math.log(cellHi - cellLo);
    logw[i] = l;
    if (l > max) max = l;
  }
  let total = 0;
  for (let i = 0; i < cells; i++) { logw[i] = Math.exp(logw[i]! - max); total += logw[i]!; }
  for (let i = 0; i < cells; i++) logw[i] = logw[i]! / total;
  return { weights: logw, origin: lo + step / 2 };           // 先頭セルの中央
}

/**
 * 差 D = θ_b − θ_a の分布を、2 つの密度の離散化のたたみ込みで作る(乱数なし・刻みは入力だけで決まる)。
 * 差の格子は d_k = (originB − originA) + (k − (Na − 1)) × step。各格子点の質量は幅 step のセルに一様に
 * 広がっているとして、cdf・quantile・損失を出す。
 */
function numericDifference(pa: { alpha: number; beta: number }, pb: { alpha: number; beta: number }, opts: GridOptions = {}): Dist {
  const ma = betaMoments(pa.alpha, pa.beta), mb = betaMoments(pb.alpha, pb.beta);
  const sdMin = Math.sqrt(Math.min(ma.variance, mb.variance));
  const widest = 2 * RANGE_SD * Math.sqrt(Math.max(ma.variance, mb.variance));
  let step = Math.max(sdMin / (opts.pointsPerSd ?? POINTS_PER_SD), Math.min(1, widest) / (opts.maxCells ?? MAX_CELLS));
  // 人数の桁が違う 2 群は刻み数の積が大きくなる(広い方 2,500 × 狭い方 320 など)ので、
  // 積が MAX_WORK を超える分だけ刻みを粗くして、1 回の計算量を一定以下にする
  const rangeA = Math.min(1, 2 * RANGE_SD * Math.sqrt(ma.variance)), rangeB = Math.min(1, 2 * RANGE_SD * Math.sqrt(mb.variance));
  const work = (rangeA / step + 1) * (rangeB / step + 1);
  const maxWork = opts.maxWork ?? MAX_WORK;
  if (work > maxWork) step *= Math.sqrt(work / maxWork);
  const ga = betaGrid(pa.alpha, pa.beta, step), gb = betaGrid(pb.alpha, pb.beta, step);
  const na = ga.weights.length, nb = gb.weights.length;
  const mass = new Float64Array(na + nb - 1);
  for (let i = 0; i < na; i++) {
    const wa = ga.weights[i]!;
    const base = na - 1 - i;
    for (let j = 0; j < nb; j++) mass[base + j]! += wa * gb.weights[j]!;
  }
  const origin = gb.origin - ga.origin - (na - 1) * step;    // d_0
  const cum = new Float64Array(mass.length);                 // cum[k] = セル 0..k の質量の和(セル k の右端の CDF)
  let acc = 0;
  for (let k = 0; k < mass.length; k++) { acc += mass[k]!; cum[k] = acc; }
  const total = acc;                                         // ≈ 1(丸め誤差の分だけ割り戻す)

  const cdf = (x: number): number => {
    const q = (x - origin) / step + 0.5;                     // セルの番号で見た位置(セル k の左端 = k)
    if (q <= 0) return 0;
    if (q >= mass.length) return 1;
    const k = Math.floor(q);
    const before = k > 0 ? cum[k - 1]! : 0;
    return (before + (q - k) * mass[k]!) / total;
  };
  const quantile = (p: number): number => {
    const target = p * total;
    let lo = 0, hi = mass.length - 1;                        // cum[k] ≥ target となる最小の k を二分探索
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! >= target) hi = mid; else lo = mid + 1; }
    const before = lo > 0 ? cum[lo - 1]! : 0;
    const frac = mass[lo]! > 0 ? (target - before) / mass[lo]! : 0.5;
    return origin + (lo + frac - 0.5) * step;
  };
  const lossBelowZero = (): number => {
    let loss = 0;
    for (let k = 0; k < mass.length; k++) {
      const left = origin + (k - 0.5) * step, right = left + step;
      if (right <= 0) loss += mass[k]! * -(left + right) / 2;
      else if (left < 0) loss += mass[k]! * (left * left) / (2 * step);
    }
    return loss / total;
  };
  return { cdf, quantile, lossBelowZero };
}

// ---------------------------------------------------------------------------
// probBest
// ---------------------------------------------------------------------------

const BEST_RANGE_SD = 8;
const BEST_MIN_INTERVALS = 400;
const BEST_MAX_INTERVALS = 4_000;

/**
 * 各群が最良である確率(正規近似の 1 次元の数値積分。シンプソン則)。
 * P(i が最良) = ∫ φ_i(x) Π_{j≠i} Φ_j(x) dx。刻みは最も狭い群の標準偏差の 1/4(分割数は 400〜4,000 の偶数)。
 * 合計は解析的には 1 なので、積分の誤差を割り戻して必ず 1 にする。
 */
export function probBest(arms: Arm[]): number[] {
  const k = arms.length;
  if (k === 0) return [];
  if (k === 1) { posterior(arms[0]!); return [1]; }
  const raw = probBestRaw(arms);
  const total = raw.reduce((s, v) => s + v, 0);
  return raw.map((v) => v / total);
}

/** probBest の割り戻し前の積分の値(合計が 1 からどれだけずれるかの計測用)。2 群以上。 */
export function probBestRaw(arms: Arm[]): number[] {
  const k = arms.length;
  const mu: number[] = [], sd: number[] = [];
  for (const arm of arms) {
    const p = posterior(arm);
    const m = betaMoments(p.alpha, p.beta);
    mu.push(m.mean); sd.push(Math.sqrt(m.variance));
  }
  let lo = Infinity, hi = -Infinity, sdMin = Infinity;
  for (let i = 0; i < k; i++) {
    lo = Math.min(lo, mu[i]! - BEST_RANGE_SD * sd[i]!);
    hi = Math.max(hi, mu[i]! + BEST_RANGE_SD * sd[i]!);
    sdMin = Math.min(sdMin, sd[i]!);
  }
  lo = Math.max(0, lo); hi = Math.min(1, hi); // CVR は 0〜1(正規近似の裾が範囲の外へはみ出す分は積分しない)
  let intervals = Math.ceil((hi - lo) / (sdMin / 4));
  intervals = Math.min(BEST_MAX_INTERVALS, Math.max(BEST_MIN_INTERVALS, intervals));
  if (intervals % 2 === 1) intervals++;
  const h = (hi - lo) / intervals;
  const out = new Array<number>(k).fill(0);
  const cdfs = new Array<number>(k);
  const prefix = new Array<number>(k + 1);
  const suffix = new Array<number>(k + 1);
  for (let g = 0; g <= intervals; g++) {
    const x = lo + g * h;
    const w = g === 0 || g === intervals ? 1 : g % 2 === 1 ? 4 : 2;
    for (let i = 0; i < k; i++) cdfs[i] = normalCdf((x - mu[i]!) / sd[i]!);
    prefix[0] = 1; suffix[k] = 1;
    for (let i = 0; i < k; i++) prefix[i + 1] = prefix[i]! * cdfs[i]!;
    for (let i = k - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! * cdfs[i]!;
    for (let i = 0; i < k; i++) {
      const z = (x - mu[i]!) / sd[i]!;
      out[i]! += w * (normalPdf(z) / sd[i]!) * prefix[i]! * suffix[i + 1]!;
    }
  }
  return out.map((v) => v * h / 3);
}
