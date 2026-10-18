/** B77(設計書 Q23): パターン ID の自動の採番。`a`〜`z` のうち使われていない最初の文字、無ければ `aa`, `ab`, …(列の名前と同じ数え方) */
export function nextVariantId(existing: string[]): string {
  const used = new Set(existing);
  for (let n = 0; ; n++) {
    const id = idAt(n);
    if (!used.has(id)) return id;
  }
}
/** 0 → a、25 → z、26 → aa、27 → ab …(26 進の「0 の無い」数え方) */
function idAt(n: number): string {
  let s = "";
  for (let m = n + 1; m > 0; m = Math.floor((m - 1) / 26)) s = String.fromCharCode(97 + ((m - 1) % 26)) + s;
  return s;
}
