// docs-check-rules.mjs — docs-check.mjs の規則のうち、テストで確かめるもの(純粋関数。ファイルを読まない)
// 問題は { line, kind, text } の配列で返し、docs-check.mjs が `<file>:<line> <kind>: <text>` で出す

/**
 * 行ごとに「コードフェンスの一部か」を返す(開始・終了の行と中身の行が true)。
 * CommonMark のとおり、開始の記号(` か ~)と長さを覚え、同じ記号で同じ長さ以上の行だけで閉じる
 * (4 本のバッククォートの中の 3 本の行では閉じない)。閉じないまま終わったら、文書の最後までをフェンスとする。
 * 字下げの上限は置かない(箇条書きの中のフェンスは 4 文字以上字下げされる。字下げしたコードをフェンスと見ても、中を検査しない側に倒れるだけ)
 */
export function fenceMask(lines) {
  const mask = [];
  let open = null; // { ch, len }
  for (const line of lines) {
    if (open === null) {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      // バッククォートのフェンスの情報文字列にはバッククォートを含められない
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) { open = { ch: m[1][0], len: m[1].length }; mask.push(true); continue; }
      mask.push(false);
    } else {
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) open = null;
      mask.push(true);
    }
  }
  return mask;
}

/** 文の中のインラインのリンクの先(`[x](先 "タイトル")` と `[x](<先>)`)。改行を詰めた文を渡す */
function linkTargets(text) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)]*)\)/g)) {
    const t = m[1].trim().split(/\s+/)[0]?.replace(/^<|>$/g, "");
    if (t) out.push(t);
  }
  return out;
}
// 参照の形のリンクの使用(`[x][ref]`・`[x][]`)と定義(`[ref]: 先`)
const REF_USE = /\[[^\]]*\]\[[^\]]*\]/;
const REF_DEF = /^\s*\[[^\]]+\]:/;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s/;

/**
 * CHANGELOG.md の、これから公開する節(「## 未リリース」と一番上の「## v…」の節)だけを見る。
 * 公開済みの古い節は当時の書き方のまま残す(書き換えない)ので見ない。
 * 箇条書きの 1 項目・1 段落を、行の改行を詰めてつないだ文として読む(見出し・別の項目・空行はまたがない)。
 * - changelog-link: 相対パス・アンカーのリンク。GitHub の Release の本文はこの節を写すので、そこでは相対リンクが壊れる。
 *   改行をまたぐリンクも、つないだ文で見る
 * - changelog-ref-link: 参照の形のリンク(`[x][1]` と `[1]: …`)。この節では使わない(定義が節の外にあると Release の本文で壊れ、
 *   使用と定義を対応づけて照らすより、使わない決まりのほうが単純で漏れが無い)
 * - changelog-plan: 同じ文の中に版(vN.N)と「予定」がある。前の版の名残の予定の書き方が、公開した後も残る
 */
export function changelogReleaseProblems(text) {
  const problems = [];
  const lines = text.split("\n");
  const mask = fenceMask(lines);
  let inScope = false;
  let versionSections = 0;
  let unit = null; // { line, text }
  const linkProblems = (line, t) => {
    for (const target of linkTargets(t)) {
      if (!/^(https?:|mailto:)/.test(target)) problems.push({ line, kind: "changelog-link", text: `${target} は Release の本文で壊れる。https://github.com/… の絶対 URL にするか、リンクにしない` });
    }
    if (REF_USE.test(t)) problems.push({ line, kind: "changelog-ref-link", text: `参照の形のリンク(${REF_USE.exec(t)[0]})はこの節では使わない。[x](https://…) の形で書く` });
  };
  const flush = () => {
    if (!unit) return;
    linkProblems(unit.line, unit.text);
    for (const sentence of unit.text.split("。")) {
      const v = /v\d+\.\d+(?:\.\d+)?/.exec(sentence);
      if (v && /予定/.test(sentence)) problems.push({ line: unit.line, kind: "changelog-plan", text: `「${v[0]} … 予定」は公開の後に古くなる。予定は README の「まだできないこと」に書き、変更履歴には入ったことだけを書く` });
    }
    unit = null;
  };
  lines.forEach((line, i) => {
    if (mask[i]) { flush(); return; }
    if (/^## /.test(line)) {
      flush();
      if (/^## 未リリース/.test(line)) inScope = true;
      else if (/^## v\d/.test(line)) inScope = ++versionSections === 1;
      else inScope = false;
      return;
    }
    if (!inScope) return;
    if (REF_DEF.test(line)) { flush(); problems.push({ line: i + 1, kind: "changelog-ref-link", text: "参照の形のリンクの定義はこの節では使わない。[x](https://…) の形で書く" }); return; }
    if (line.trim() === "" || HEADING.test(line)) { flush(); if (HEADING.test(line)) linkProblems(i + 1, line); return; }
    if (LIST_ITEM.test(line) || unit === null) { flush(); unit = { line: i + 1, text: line }; }
    else unit.text += line.trim();
  });
  flush();
  return problems;
}

/** どの版を指すか読み手に分からない言い方(文書は版をまたいで読まれる)。版の名前(vN.N)で書く */
export const VERSION_WORDING_RE = /この更新の前|この更新より前|この版から|この版より前|この版以降/;

/**
 * 許す行。file と、その行に含まれる文字列(snippet)と理由。どの行にも当たらなくなった許可は version-wording-allow-stale で出す
 * (文書を直した後に許可だけが残らないように)
 */
export const VERSION_WORDING_ALLOW = [
  {
    file: "docs/deploy.md",
    snippet: "CHANGELOG の目印「この版より前に開いたタブは再読み込みが要る」",
    reason: "CHANGELOG の目印の文言そのものの引用(目印で該当のリリースを探すので、文言を変えられない)",
  },
  {
    file: "docs/deploy.md",
    snippet: "CHANGELOG の目印「データベースの形が変わる」「配る設定の版(`schemaVersion`)が上がる」「この版より前に開いたタブは再読み込みが要る」",
    reason: "対象 URL の更新を見分ける複数の目印の引用。CHANGELOG の文言と並びを保つ必要があるため、この引用だけを許す",
  },
];

/**
 * 公開文書(CHANGELOG.md を除く。CHANGELOG の版の節の「この版」は、その節の版を指すので曖昧でない)の、版の分からない言い方。
 * コードフェンスの中は見ない
 */
export function versionWordingProblems(rel, text, allow = VERSION_WORDING_ALLOW) {
  const problems = [];
  const mine = allow.filter((a) => a.file === rel);
  const used = new Set();
  const lines = text.split("\n");
  const mask = fenceMask(lines);
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const m = VERSION_WORDING_RE.exec(line);
    if (!m) return;
    const a = mine.find((x) => line.includes(x.snippet));
    if (a) { used.add(a); return; }
    problems.push({ line: i + 1, kind: "version-wording", text: `「${m[0]}」はどの版か分からない。「v0.11 より前に」のように版の名前で書く(許すなら tools/docs-check-rules.mjs の VERSION_WORDING_ALLOW に理由と足す)` });
  });
  for (const a of mine) if (!used.has(a)) problems.push({ line: 0, kind: "version-wording-allow-stale", text: `許可「${a.snippet}」に当たる行が無い。VERSION_WORDING_ALLOW から外す` });
  return problems;
}

/** 公開文書のうち apps/<名前>/README.md(公開物の apps/ に入る。docs-check.mjs とテストが同じ一覧を使う) */
export const appReadmes = (appNames) => appNames.slice().sort().map((n) => `apps/${n}/README.md`);
