/** Code Change の textarea: Tab キーでフォーカスを移さず 2 スペースを挿入する(決定 38 (4)。CodeMirror は入れない) */
export const INDENT = "  ";

export function insertIndent(value: string, start: number, end: number): { value: string; cursor: number } {
  return { value: value.slice(0, start) + INDENT + value.slice(end), cursor: start + INDENT.length };
}
