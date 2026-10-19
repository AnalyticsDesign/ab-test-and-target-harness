// 説明(ヘルプ)の原稿 docs/experiment-results.md を読む純粋関数(D9 plan ③ K22)。ファイルには触れない。
// 使う側: scripts/embed-help.mjs(generated/help.ja.ts を作る)・tools/docs-check.mjs(印の検査)・test/help.test.ts。
// 検査を 1 か所に置き、docs:check と生成が同じ規則で原稿を読むようにする
//
// 原稿の形: 項目ごとに印 `<!-- help: <key> -->` を置き、印の次の行(空行を挟まない)を `### <題>` にする。
// 題の後の最初の段落が吹き出しの要点(1〜160 字。字数はコードポイントで数える)、残りがヘルプパネルの本文。
// 本文は次の印か、次の `#`〜`###` の見出しの前まで

export const HELP_KEY_RE = /^[a-z0-9-]+$/;
export const SUMMARY_MAX = 160;

const MARKER_RE = /^<!--\s*help:\s*(\S*)\s*-->\s*$/;
const ITEM_HEADING_RE = /^###\s+(.+?)\s*#*\s*$/;
const SECTION_END_RE = /^#{1,3}\s/;
const FENCE_RE = /^\s*(```|~~~)/;

/** 原稿を項目に分け、印の検査の問題を返す。problems が空でなければ生成しない */
export function parseHelp(md) {
  const lines = md.split("\n");
  const entries = [];
  const problems = [];
  const seen = new Map();
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const ln = i + 1;
    const key = m[1];
    if (!HELP_KEY_RE.test(key)) problems.push({ line: ln, message: `印の鍵「${key}」は [a-z0-9-]+ の形にする` });
    if (seen.has(key)) problems.push({ line: ln, message: `印の鍵「${key}」が重複している(${seen.get(key)} 行目と同じ)` });
    else seen.set(key, ln);
    const heading = ITEM_HEADING_RE.exec(lines[i + 1] ?? "");
    if (!heading) {
      problems.push({ line: ln, message: `印の直後(次の行。空行を挟まない)が ### の見出しではない` });
      continue;
    }
    // 題の後ろから、次の印か次の # 〜 ### の見出しの前まで(コードフェンスの中は区切りにしない)
    let end = i + 2;
    let inFence = false;
    for (; end < lines.length; end++) {
      if (FENCE_RE.test(lines[end])) inFence = !inFence;
      if (!inFence && (MARKER_RE.test(lines[end]) || SECTION_END_RE.test(lines[end]))) break;
    }
    const block = lines.slice(i + 2, end);
    // 要点 = 題の後の最初の段落(空行で区切る)。箇条書き・表・見出しで始まるものは段落ではない
    let s = 0;
    while (s < block.length && block[s].trim() === "") s++;
    let e = s;
    while (e < block.length && block[e].trim() !== "") e++;
    const first = block.slice(s, e);
    const summary = plainInline(first.map((l) => l.trim()).join(""));
    if (first.length === 0 || !isParagraph(first[0])) {
      problems.push({ line: ln, message: "題の後に要点(最初の段落)が無い" });
    } else if ([...summary].length > SUMMARY_MAX) {
      problems.push({ line: ln, message: `要点(最初の段落)が ${[...summary].length} 字で、${SUMMARY_MAX} 字を超える` });
    }
    const body = block.slice(e).join("\n").trim();
    entries.push({ key, title: plainInline(heading[1]), summary, body, line: ln });
    i = end - 1;
  }
  return { entries, problems };
}

const isListItem = (line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line);
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line) => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
const isBodyHeading = (line) => /^#{4,6}\s+/.test(line);
const isParagraph = (line) => !isListItem(line) && !isTableRow(line) && !/^#{1,6}\s/.test(line);

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 行の中の書式: インラインコード・強調・リンク。HTML を先に文字として逃がしてから書式を当てる(生の HTML は文字として出る)。
 * リンクは外部(http / https)だけを新しいタブで開く <a> にし、それ以外(原稿の中の相対リンク・その他の scheme)は文字だけを出す
 * (管理画面の中では相対パスが解決できないため)
 */
export function renderInline(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
          /^https?:\/\//.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label,
        )
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
}

/** 行の中の書式を外した文字(吹き出しの要点・題に使う。画面では文字として出す) */
export function plainInline(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part.slice(1, -1) : part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")))
    .join("");
}

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * 本文の Markdown を HTML にする。許すのは段落・箇条書き(- / * / 1.)・表・本文の見出し(#### 〜 ###### を h5 / h6 に)・
 * 強調・インラインコード・リンクだけ。それ以外の記法(引用・コードフェンス・画像など)と生の HTML は文字として段落に出す
 */
export function renderMarkdown(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (isBodyHeading(line)) {
      const level = Math.min(6, line.match(/^#+/)[0].length + 1);
      out.push(`<h${level}>${renderInline(line.replace(/^#+\s+/, "").trim())}</h${level}>`);
      i++;
      continue;
    }
    if (isTableRow(line) && isTableSep(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (isListItem(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && lines[i].trim() !== "") {
        if (isListItem(lines[i])) items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim());
        else items[items.length - 1] += lines[i].trim(); // 字下げした続きの行は前の項目に詰める
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && (para.length === 0 || (isParagraph(lines[i]) && !isTableRow(lines[i])))) para.push(lines[i++].trim());
    out.push(`<p>${renderInline(para.join(""))}</p>`);
  }
  return out.join("\n");
}

/** generated/help.<locale>.ts の中身。原稿の順に並べる(パネルはこの順に全項目を出す) */
export function renderHelpModule(entries, source = "docs/experiment-results.md") {
  const help = Object.fromEntries(entries.map((e) => [e.key, { title: e.title, summary: e.summary, bodyHtml: renderMarkdown(e.body) }]));
  return [
    `// GENERATED — \`node scripts/embed-help.mjs\`(admin の test / build が実行する)で ${source} から再生成する。直接編集しない`,
    "export type HelpEntry = { title: string; summary: string; bodyHtml: string };",
    `export const HELP_KEYS = ${JSON.stringify(entries.map((e) => e.key))} as const;`,
    "export type HelpKey = (typeof HELP_KEYS)[number];",
    `export const HELP: Record<string, HelpEntry> = ${JSON.stringify(help, null, 2)};`,
    "export const isHelpKey = (key: string): key is HelpKey => Object.prototype.hasOwnProperty.call(HELP, key);",
    "",
  ].join("\n");
}
