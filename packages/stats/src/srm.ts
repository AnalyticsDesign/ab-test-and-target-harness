// SRM(Sample Ratio Mismatch)の検定: 参加者数が重みの比率どおりかを、カイ二乗検定の p 値で見る。

import { lnGamma } from "./beta";

/** 正則化された上側不完全ガンマ関数 Q(a, x)(Numerical Recipes の級数 / 連分数)。 */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    // 級数で P(a, x) を求めて 1 から引く
    let ap = a, del = 1 / a, sum = del;
    for (let n = 0; n < 100_000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return Math.max(0, 1 - sum * front);
  }
  // 連分数(修正 Lentz 法)で Q(a, x) を直接求める
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 100_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.min(1, front * h);
}

/**
 * 参加者数 counts が重み weights の比率どおりかのカイ二乗検定の p 値。
 * 重みは比率として扱う(合計が 100 でなくてよい)。
 *  - 全群 0 人 → 1(検定できない = ずれなし)。群が 1 つ以下 → 1
 *  - 重みが 0 以下・非有限、長さの不一致、人数が負・非有限 → RangeError
 *    (重み 0 の群を外すのは呼ぶ側 = verdict の仕事)
 */
export function srm(counts: number[], weights: number[]): number {
  if (counts.length !== weights.length) {
    throw new RangeError(`srm: counts (${counts.length}) と weights (${weights.length}) の長さが違います`);
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w <= 0) throw new RangeError(`srm: 重みは 0 より大きい有限の数です(重み 0 の群は呼ぶ側で外す): ${w}`);
  }
  for (const c of counts) {
    if (!Number.isFinite(c) || c < 0) throw new RangeError(`srm: 人数は 0 以上の有限の数です: ${c}`);
  }
  const k = counts.length;
  if (k <= 1) return 1;
  let total = 0, weightSum = 0;
  for (let i = 0; i < k; i++) { total += counts[i]!; weightSum += weights[i]!; }
  if (total === 0) return 1;
  let chi2 = 0;
  for (let i = 0; i < k; i++) {
    const expected = (total * weights[i]!) / weightSum;
    chi2 += ((counts[i]! - expected) ** 2) / expected;
  }
  return gammaQ((k - 1) / 2, chi2 / 2);
}
