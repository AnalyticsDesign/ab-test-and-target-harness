// Beta 分布まわりの基礎関数(依存なし・乱数なし)。
// 事前分布は Beta(1, 1)。CV した人数 y、参加者 n の群の事後分布は Beta(1 + y, 1 + n − y)。

export type Arm = { n: number; y: number };

// Lanczos 近似(g = 7, 9 項)
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const HALF_LN_2PI = 0.9189385332046727;

/** ln Γ(x)(x > 0)。x ≥ 20 は Stirling 級数、それ未満は Lanczos 近似。 */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  if (x >= 20) {
    const x2 = x * x;
    return (x - 0.5) * Math.log(x) - x + HALF_LN_2PI +
      1 / (12 * x) - 1 / (360 * x * x2) + 1 / (1260 * x2 * x2 * x) - 1 / (1680 * x2 * x2 * x2 * x);
  }
  const z = x - 1;
  let a = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return HALF_LN_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln B(a, b)。 */
export function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Beta(α, β) の平均と分散。 */
export function betaMoments(alpha: number, beta: number): { mean: number; variance: number } {
  const s = alpha + beta;
  return { mean: alpha / s, variance: (alpha * beta) / (s * s * (s + 1)) };
}

/** 事後分布の (α, β)。入力を検査する(不正な値は握りつぶさず RangeError)。 */
export function posterior(arm: Arm): { alpha: number; beta: number } {
  const { n, y } = arm;
  if (!Number.isInteger(n) || !Number.isInteger(y) || n < 0 || y < 0 || y > n) {
    throw new RangeError(`invalid arm: n=${n}, y=${y} (n と y は 0 ≤ y ≤ n の整数)`);
  }
  return { alpha: 1 + y, beta: 1 + n - y };
}

/** 閉形式の項数 = 1 + min(CV, 非 CV) を 2 群のうち小さい側で取った値。 */
export function closedFormTerms(a: Arm, b: Arm): number {
  const pa = posterior(a), pb = posterior(b);
  return Math.min(pa.alpha, pa.beta, pb.alpha, pb.beta);
}

/**
 * P(Y > X)。X ~ Beta(aX, bX)、Y ~ Beta(aY, bY)、aY は整数。
 * Evan Miller の和 Σ_{i=0}^{aY-1} B(aX + i, bX + bY) / ((bY + i) B(1 + i, bY) B(aX, bX)) を、
 * 隣り合う項の比
 *   t_{i+1} / t_i = (aX + i)(bY + i) / ((aX + i + bX + bY)(i + 1))
 * で回す(項ごとに対数ガンマを呼ばない = 1 項あたり乗除算だけ)。
 * 初項 t_0 = B(aX, bX + bY) / B(aX, bX) が桁あふれ / 桁落ちしても壊れないよう、
 * 初項を 1 に置いた尺度で和を取り、尺度の対数 L を別に持つ(項が 1e100 を超えたら縮める)。
 */
function core(aX: number, bX: number, aY: number, bY: number): number {
  const s = bX + bY;
  let logScale = lnBeta(aX, s) - lnBeta(aX, bX);
  let t = 1, sum = 1;
  for (let i = 0; i < aY - 1; i++) {
    t *= ((aX + i) * (bY + i)) / ((aX + i + s) * (i + 1));
    sum += t;
    if (t > 1e100) { t *= 1e-100; sum *= 1e-100; logScale += 230.25850929940458; } // ln(1e100)
  }
  return Math.min(1, Math.exp(logScale + Math.log(sum)));
}

/**
 * P(θ_b > θ_a) の閉形式(項数の上限なし)。
 * Beta の対称性(θ → 1 − θ で α と β が入れ替わる、P(B>A) = 1 − P(A>B))で、
 * α_a・β_a・α_b・β_b のうち最小のものを項数にする和を選ぶ(= min(CV, 非 CV) で項数が決まる)。
 */
export function probBeatClosedForm(a: Arm, b: Arm): number {
  const pa = posterior(a), pb = posterior(b);
  const aA = pa.alpha, bA = pa.beta, aB = pb.alpha, bB = pb.beta;
  const m = Math.min(aA, bA, aB, bB);
  let p: number;
  if (m === aB) p = core(aA, bA, aB, bB);                 // P(B > A) を直接
  else if (m === aA) p = 1 - core(aB, bB, aA, bA);        // 1 − P(A > B)
  else if (m === bA) p = core(bB, aB, bA, aA);            // 1 − θ で見た P(A' > B')
  else p = 1 - core(bA, aA, bB, aB);                      // 1 − P(B' > A')
  return Math.min(1, Math.max(0, p));
}
