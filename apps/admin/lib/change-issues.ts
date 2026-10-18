import type { Variant } from "./types";

/**
 * B8(B77 K18): 保存の前に、オリジナルでないパターンの HTML の変更で `html` が空のものを探す(並びの最初の 1 件)。
 * core は `html` を 1 字以上で受けるので、見つけたら API を呼ばずにそのパターンを開き、その欄に「HTML を入力してください」を出す。
 * オリジナルは変更を送らない(保存で消える)ので見ない
 */
export function firstEmptyHtml(variants: Variant[]): { variantId: string; changeIndex: number } | null {
  for (const v of variants) {
    if (v.original) continue;
    const changeIndex = v.changes.findIndex((c) => c.type === "HTML" && (c.payload.html ?? "") === "");
    if (changeIndex >= 0) return { variantId: v.id, changeIndex };
  }
  return null;
}

/**
 * B8 の印を付けた変更(firstEmptyHtml で見つけたもの)が、まだ空の HTML のままなら今の位置を返す。
 * 利用者が HTML を入れた・種類を変えた・変更を消した・パターンをオリジナルにしたら null(印を消す)。
 * 位置ではなく変更の id で追う(前の変更を消すと位置がずれるため)
 */
export function emptyHtmlIndex(variants: Variant[], target: { variantId: string; changeId: string }): number | null {
  const v = variants.find((x) => x.id === target.variantId);
  if (!v || v.original) return null;
  const i = v.changes.findIndex((c) => c.id === target.changeId);
  const c = v.changes[i];
  return c && c.type === "HTML" && (c.payload.html ?? "") === "" ? i : null;
}
