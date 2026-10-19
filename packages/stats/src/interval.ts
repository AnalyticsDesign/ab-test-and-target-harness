// 1 群の CVR の信用区間。事後分布 Beta(1 + y, 1 + n − y) の分位点(乱数なし・同じ入力で同じ出力)。

import { betaMoments, lnBeta, posterior } from "./beta";
import { inverseNormalCdf } from "./normal";

/**
 * 正規近似に切り替える境目: min(CV, 非 CV) がこの値以上。
 * 決め方: 正規近似の分位点(平均 ± z × 標準偏差)を正確な累積分布 I_x(α, β) に入れたときの裾の確率のずれを、
 * min(CV, 非 CV) = m、もう一方 = m × 1〜1,000 倍で測った最大(Node v24):
 *   m   150 → 0.0047 /   500 → 0.0025 / 1,000 → 0.0018 / 2,000 → 0.0013 / 3,000 → 0.0010 /
 *   m 3,500 → 0.00094 / 4,000 → 0.00088 / 5,000 → 0.00079
 * 許す誤差は確率で 0.001(compare.ts の境目と同じ)なので 4,000 にした(差の要約の境目 NUMERIC_BELOW = 150 では
 * 偏りの大きい群で 0.0047 ずれる)。正確な分位点は 1 群 0.01 ms 前後(min 2,000 で 0.007 ms)で、境目を上げても計算は重くならない。
 * 境目より下は正確な分位点(不完全ベータ関数の連分数 + 囲い込みのニュートン法)
 */
export const INTERVAL_NORMAL_FROM = 4_000;

const MAX_CF_TERMS = 20_000;
const CF_EPS = 1e-15;
const TINY = 1e-300;

/** 正則化された不完全ベータ関数の連分数(Lentz の方法)。x < (a + 1) / (a + b + 2) で速く収束する */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_CF_TERMS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < CF_EPS) return h;
  }
  return h; // 打ち切り(項数の上限まで回した値。この範囲の α・β では上限に届かない)
}

/** 正則化された不完全ベータ関数 I_x(a, b) = Beta(a, b) の累積分布 */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b);
  if (x < (a + 1) / (a + b + 2)) return Math.exp(lnFront) * betaContinuedFraction(x, a, b) / a;
  return 1 - Math.exp(lnFront) * betaContinuedFraction(1 - x, b, a) / b;
}

/** Beta(a, b) の p 分位点。正規近似から始めて、[lo, hi] の囲い込みを保つニュートン法(外れたら二分) */
function betaQuantile(p: number, a: number, b: number): number {
  const { mean, variance } = betaMoments(a, b);
  const lnB = lnBeta(a, b);
  let lo = 0, hi = 1;
  let x = Math.min(1 - 1e-12, Math.max(1e-12, mean + Math.sqrt(variance) * inverseNormalCdf(p)));
  for (let i = 0; i < 200; i++) {
    const f = betaCdf(x, a, b) - p;
    if (f === 0) return x;
    if (f < 0) lo = x;
    else hi = x;
    const density = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lnB);
    let next = density > 0 && Number.isFinite(density) ? x - f / density : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - x) <= 1e-15 * Math.max(1, x) || hi - lo <= 1e-15) return next;
    x = next;
  }
  return x;
}

/**
 * CV した人 y・参加者 n の群の CVR の信用区間(0〜1)。事後分布 Beta(1 + y, 1 + n − y) の
 * ((1 − level) / 2, (1 + level) / 2) 分位点。min(CV, 非 CV) が INTERVAL_NORMAL_FROM 以上は平均と分散からの正規近似
 * (裾の確率のずれ 0.001 以内)、それ未満は正確な分位点
 */
export function betaInterval(n: number, y: number, level = 0.95): [number, number] {
  if (!(level > 0 && level < 1)) throw new RangeError(`betaInterval: level は 0 と 1 の間です: ${level}`);
  const { alpha, beta } = posterior({ n, y });
  const pLo = (1 - level) / 2, pHi = (1 + level) / 2;
  if (Math.min(y, n - y) >= INTERVAL_NORMAL_FROM) {
    const { mean, variance } = betaMoments(alpha, beta);
    const sd = Math.sqrt(variance);
    return [Math.max(0, mean + sd * inverseNormalCdf(pLo)), Math.min(1, mean + sd * inverseNormalCdf(pHi))];
  }
  return [betaQuantile(pLo, alpha, beta), betaQuantile(pHi, alpha, beta)];
}
