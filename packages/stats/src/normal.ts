// 標準正規分布の関数(依存なし・乱数なし)。
// compare.ts(正規近似・probBest)と sample-size.ts(逆正規)が使う。

const SQRT_2PI = 2.5066282746310002;

/** 標準正規分布の密度。 */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * 標準正規分布の累積分布 Φ(x)。
 * Graeme West, "Better approximations to cumulative normal functions"(Hart 1968 の有理近似)。
 * 倍精度でほぼ 1e-15 の誤差。裾(x < -8 など)も相対誤差で正しく 0 に近づく。
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const xabs = Math.abs(x);
  let c: number;
  if (xabs > 37) {
    c = 0;
  } else {
    const e = Math.exp(-xabs * xabs / 2);
    if (xabs < 7.07106781186547) {
      let b = 3.52624965998911e-2 * xabs + 0.700383064443688;
      b = b * xabs + 6.37396220353165;
      b = b * xabs + 33.912866078383;
      b = b * xabs + 112.079291497871;
      b = b * xabs + 221.213596169931;
      b = b * xabs + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * xabs + 1.75566716318264;
      b = b * xabs + 16.064177579207;
      b = b * xabs + 86.7807322029461;
      b = b * xabs + 296.564248779674;
      b = b * xabs + 637.333633378831;
      b = b * xabs + 793.826512519948;
      b = b * xabs + 440.413735824752;
      c = c / b;
    } else {
      let b = xabs + 0.65;
      b = xabs + 4 / b;
      b = xabs + 3 / b;
      b = xabs + 2 / b;
      b = xabs + 1 / b;
      c = e / b / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - c : c;
}

// Acklam の逆正規分布の係数
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const P_LOW = 0.02425;

/**
 * 標準正規分布の分位点 Φ⁻¹(p)(Acklam の近似 + Halley 法 1 回の精緻化で ≈1e-15)。
 * p が 0 以下なら -Infinity、1 以上なら Infinity。
 */
export function inverseNormalCdf(p: number): number {
  if (Number.isNaN(p)) return Number.NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  // Halley 法で 1 回精緻化(近似の相対誤差 1.15e-9 を倍精度の誤差まで縮める)
  const e = normalCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
