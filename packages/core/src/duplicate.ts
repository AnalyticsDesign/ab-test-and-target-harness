/**
 * 決定 51(設計書 §4.1): 複製の ID と名前の既定。control(API の省略時)と admin(複製の画面の初期値)が共有する。zod を使わない
 */
export type DuplicateMode = "same" | "variant";

/** エクスペリエンス ID(スラッグ)の長さの上限。control の SLUG_RE と同じ */
export const DUPLICATE_ID_MAX = 64;
const VARIANT_NAME_IN_COPY_MAX = 30;

/** n 字に収める。超えるときは末尾を「…」にする */
function fit(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function duplicateName(mode: DuplicateMode, sourceName: string, variantName = "", max = 100): string {
  const suffix = mode === "same" ? " のコピー" : `(${fit(variantName, VARIANT_NAME_IN_COPY_MAX)} だけを表示)`;
  return fit(sourceName, max - suffix.length) + suffix;
}

/** `<元の ID>-copy`、`-copy-2` … の候補。64 字に収まらなければ元の ID の末尾を詰める(空いている最初のものを呼び手が選ぶ) */
export function duplicateIdCandidates(sourceId: string, limit = 99): string[] {
  const out: string[] = [];
  for (let n = 1; n <= limit; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    out.push(sourceId.slice(0, DUPLICATE_ID_MAX - suffix.length) + suffix);
  }
  return out;
}
