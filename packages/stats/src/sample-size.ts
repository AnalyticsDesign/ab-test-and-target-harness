// 補助計算: 評価計画のタブで「何人集めればよいか」の目安を出す。

import { inverseNormalCdf } from "./normal";

/** 検出力(固定)。 */
const POWER = 0.8;

/**
 * 比較の回数 m に合わせて引き上げたしきい値(%)。`100 − (100 − threshold) / m`。
 * 例: しきい値 95%・比較 2 回 → 97.5%。
 */
export function effectiveThreshold(threshold: number, m: number): number {
  return 100 - (100 - threshold) / m;
}

/**
 * パターンごとに必要な参加者数(基準側もパターン側も同じ人数)。
 * 2 群の割合の差の検定の標準的な式。検出力 80%、有意水準は 2 群(m = 1)・しきい値 95% なら 5% 両側、
 * m 回の比較なら引き上げたしきい値に対応する片側あたり (100 − t') / 100 を両側として使う。
 *
 *   n = (z_{1−α/2} · √(2 p̄ q̄) + z_{power} · √(p₁q₁ + p₂q₂))² / (p₂ − p₁)²
 *
 * @param cvr 基準の CVR(0〜1。0.05 = 5%)
 * @param diffPoints 検出したい差(ポイント。1 = +1 ポイント)
 * @param m 比較の回数(基準以外のパターンの数)
 * @param threshold しきい値(%。95 など)
 * @throws RangeError cvr が 0〜1 の外、差が 0 以下、cvr + 差が 1 以上、m が 1 未満、しきい値が 50〜100 の外
 */
export function sampleSize(cvr: number, diffPoints: number, m: number, threshold: number): number {
  const p1 = cvr, p2 = cvr + diffPoints / 100;
  if (!(p1 > 0 && p1 < 1)) throw new RangeError(`sampleSize: cvr は 0 より大きく 1 より小さい値です: ${cvr}`);
  if (!(diffPoints > 0)) throw new RangeError(`sampleSize: 差は 0 より大きい値です: ${diffPoints}`);
  if (!(p2 < 1)) throw new RangeError(`sampleSize: cvr + 差 が 100% 以上です: ${cvr} + ${diffPoints} ポイント`);
  if (!(m >= 1)) throw new RangeError(`sampleSize: m は 1 以上です: ${m}`);
  if (!(threshold >= 50 && threshold < 100)) throw new RangeError(`sampleSize: しきい値は 50 以上 100 未満です: ${threshold}`);
  const alphaTwoSided = (100 - effectiveThreshold(threshold, m)) / 100;
  const zAlpha = inverseNormalCdf(1 - alphaTwoSided / 2);
  const zPower = inverseNormalCdf(POWER);
  const pBar = (p1 + p2) / 2;
  const root = zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zPower * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((root * root) / ((p2 - p1) ** 2));
}
