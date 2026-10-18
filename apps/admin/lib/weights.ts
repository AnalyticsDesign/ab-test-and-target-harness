/**
 * B77(設計書 Q9・Q10): パターンの重みの配分。計算は管理画面の中だけで、API には足さない。
 * 「均等に配分」は 100 を n で割り、端数は一覧の先頭から 1 ずつ足す(差はいつも 1 以内で、並びだけで結果が決まる)
 */
export function evenWeights(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  const rest = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/** 「均等に配分」の結果と同じか(並びも含めて) */
export function isEven(weights: number[]): boolean {
  const even = evenWeights(weights.length);
  return weights.every((w, i) => w === even[i]);
}

/**
 * パターンを末尾に足したときの重み。直前が均等なら配り直し、手で配分を変えていたら新しいパターンを 0 にする(手で決めた配分は壊さない)。
 * redistributed = 合計の横に「均等に配り直しました」を出すか
 */
export function weightsAfterAdd(weights: number[]): { weights: number[]; redistributed: boolean } {
  if (weights.length > 0 && isEven(weights)) return { weights: evenWeights(weights.length + 1), redistributed: true };
  return { weights: [...weights, 0], redistributed: false };
}

/** index のパターンを消したときの重み。直前が均等なら配り直し、そうでなければ残りをそのまま(合計の不足は画面が赤で示す) */
export function weightsAfterRemove(weights: number[], index: number): { weights: number[]; redistributed: boolean } {
  const rest = weights.filter((_, i) => i !== index);
  if (rest.length > 0 && isEven(weights)) return { weights: evenWeights(rest.length), redistributed: true };
  return { weights: rest, redistributed: false };
}
