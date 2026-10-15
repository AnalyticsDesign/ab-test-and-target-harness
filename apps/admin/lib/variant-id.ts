/** control の `SLUG_RE`(apps/control/src/ids.ts)と同じ規則。受理なら null、拒否なら画面に出す理由文を返す(Plan 10 B1) */
export const VARIANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function variantIdIssue(id: string, existing: string[]): string | null {
  if (id === "") return null; // 未入力は理由を出さない(ボタンだけ無効)
  if (!VARIANT_ID_RE.test(id)) return "英小文字・数字で始まり、英小文字・数字・_・- のみ、64 文字以内で入力してください";
  if (existing.includes(id)) return `パターン ID "${id}" は既に使われています`;
  return null;
}
