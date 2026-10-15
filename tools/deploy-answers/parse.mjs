// deploy-answers.yaml の読み込み。平らな `key: value`・インラインの配列・`#` のコメント・CRLF・先頭の BOM だけを読む。
// clone の直後に Node だけで動かすため、YAML のライブラリを使わない(入力ファイルの形はこちらで決めている)

/** 引用符の外にある、行頭か空白の直後の `#` から後ろを落とす */
export function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

const unquote = (s) => (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s);

/** 値 1 つを読む。空 = null、[a, b] = 配列、true / false = 真偽値、それ以外は文字列 */
export function parseScalar(raw) {
  const s = raw.trim();
  if (s === "") return { value: null };
  if (s === "|" || s === ">" || s.startsWith("|") || s.startsWith(">")) return { error: "複数行の値は使えない。1 行で書く" };
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) return { error: "配列は 1 行で [a, b] の形に書く" };
    const inner = s.slice(1, -1).trim();
    return { value: inner === "" ? [] : inner.split(",").map((x) => unquote(x.trim())).filter((x) => x !== "") };
  }
  if (s === "true") return { value: true };
  if (s === "false") return { value: false };
  return { value: unquote(s) };
}

/** @returns {{ values: Record<string, null|boolean|string|string[]>, errors: { line: number, message: string }[] }} */
export function parseAnswers(text) {
  const values = {};
  const errors = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).trimEnd();
    if (line.trim() === "") return;
    const n = i + 1;
    if (/^\s/.test(line)) return void errors.push({ line: n, message: "字下げした行(入れ子)は使えない。行頭から key: value の形で書く" });
    const m = /^([a-z][a-z0-9_]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) return void errors.push({ line: n, message: "key: value の形になっていない" });
    const [, key, rest = ""] = m;
    if (Object.hasOwn(values, key)) return void errors.push({ line: n, message: `${key} が 2 回書かれている` });
    const r = parseScalar(rest);
    if (r.error) return void errors.push({ line: n, message: r.error });
    values[key] = r.value;
  });
  return { values, errors };
}
