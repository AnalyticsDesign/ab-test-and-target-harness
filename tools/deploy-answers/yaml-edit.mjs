// deploy-answers.yaml の書き戻し(--accept / --resolve-zone)。行の並び・コメント・改行コード・先頭の BOM を残し、値のある行は上書きしない。
// 「値がある」「auto である」の判定は、読み込み(parseScalar)と検査(isBlank)と同じ規則で行う(空の引用符・プレースホルダ・空の配列は未記入)
import { stripComment, parseScalar } from "./parse.mjs";
import { isBlank } from "./questions.mjs";

const BOM = "\uFEFF";
const formatValue = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 先頭の BOM を外して行に分け、書き戻すときに改行コードと BOM を元に戻す */
function splitLines(text) {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return { lines: body.split(/\r?\n/), join: (lines) => (bom ? BOM : "") + lines.join(eol) };
}

/** 行末の説明のコメント(`# …`)。無ければ null */
const noteOf = (rest) => /\s(#.*)$/.exec(rest)?.[1] ?? null;

/** `key:` の後ろ(rest)を読んだ値。書式の誤りなら undefined */
const valueOf = (rest) => {
  const p = parseScalar(stripComment(rest));
  return p.error === undefined ? p.value : undefined;
};

/**
 * entries のキーを有効な行として書く(値が null / undefined のものは書かない)。
 * 値のある有効な行(`key: 値`)があるキーは触らない。値が空の有効な行(`key:`)とコメントアウトされた行(`# key: …`)は
 * 置き換え、行末の説明のコメントは残す。どれも無ければ末尾(末尾の空行の手前)に足す
 */
export function writeKeys(text, entries) {
  const { lines, join } = splitLines(text);
  const written = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    const k = escapeRe(key);
    const line = `${key}: ${formatValue(value)}`;
    const activeRe = new RegExp(`^${k}:(.*)$`);
    const active = lines.findIndex((l) => activeRe.test(l));
    if (active >= 0) {
      const rest = activeRe.exec(lines[active])[1];
      const v = valueOf(rest);
      if (v === undefined || !isBlank(v)) continue;
      const note = noteOf(rest);
      lines[active] = note ? `${line}   ${note}` : line;
    } else {
      const commentedRe = new RegExp(`^#[ \\t]?${k}:(.*)$`);
      const idx = lines.findIndex((l) => commentedRe.test(l));
      if (idx >= 0) {
        const note = noteOf(commentedRe.exec(lines[idx])[1]);
        lines[idx] = note ? `${line}   ${note}` : line;
      } else {
        let end = lines.length;
        while (end > 0 && lines[end - 1] === "") end--;
        lines.splice(end, 0, line);
      }
    }
    written.push(line);
  }
  return { text: join(lines), written };
}

/** 上段の答えの行(`key: …`)を値と行末のコメントごと書き換える(アカウントの入れ替えの了承で使う)。行が無ければ末尾に足す */
export function replaceAnswer(text, key, value, note) {
  const { lines, join } = splitLines(text);
  const line = `${key}: ${value}   # ${note}`;
  const re = new RegExp(`^${escapeRe(key)}:`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = line;
  else {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    lines.splice(end, 0, line);
  }
  return { text: join(lines), written: [line] };
}

/** zone_name: auto → ゾーン名、asset_public_base: auto → https://wtt-assets.<ゾーン名>。auto が無ければ何もしない */
export function resolveZone(text, zone) {
  const { lines, join } = splitLines(text);
  const written = [];
  const swap = (key, value) => {
    const re = new RegExp(`^${key}:(.*)$`);
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return;
    const rest = re.exec(lines[i])[1];
    if (valueOf(rest) !== "auto") return;
    const note = noteOf(rest);
    lines[i] = note ? `${key}: ${value}   ${note}` : `${key}: ${value}`;
    written.push(`${key}: ${value}`);
  };
  swap("zone_name", zone);
  swap("asset_public_base", `https://wtt-assets.${zone}`);
  return { text: join(lines), written };
}
