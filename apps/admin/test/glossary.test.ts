import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backlog B35 / 決定 54 (1): 管理画面の文字列を用語表にそろえる(API・コードの識別子は英語のまま)。
 * app/・components/・lib/ のソースからコメントを除き、画面の語として英語や旧表記を使っている形を探す
 */
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];

const BANNED: Array<{ re: RegExp; use: string }> = [
  { re: /実験/, use: "エクスペリエンス" },
  { re: /バリエーション/, use: "パターン" },
  { re: /Phase \d/, use: "「今後追加します」など(開発の段階名は画面に出さない)" },
  { re: /導入パターン/, use: "導入構成(「パターン」は variant だけに使う)" },
  { re: /1 つだけ表示/, use: "パーソナライズ" },
  { re: /未公開の変更/, use: "未公開の編集あり" },
  { re: /権限の上限/, use: "権限" },
  { re: /フル[(（の]/, use: "すべてのワークスペース" }, // 半角・全角の括弧の両方
  { re: /\b(?:OWNER|ADMIN|EDITOR|VIEWER)\b/, use: "roleLabel(オーナー / 管理者 / 編集者 / 閲覧者)" },
  { re: /Code Change/, use: "コードの変更" },
  { re: /Persistent Assignment/, use: "割当の固定" },
  { re: /\b(?:Exposure|Conversion)\b/, use: "露出 / コンバージョン" },
  { re: /\b(?:Site|Variant|Change|Workspace) ID/, use: "サイト ID / パターン ID / 変更の ID" },
  { re: /ユーザーメニュー(?:の| ?→ ?)「(?:API キー|システム管理者|新しいワークスペース|ドラッグ)/, use: "ユーザーメニュー →「設定」→ …(r1 CL-Medium-2)" },
  // 英語の語の直後に日本語・「・( が続く = 画面の文の中で使っている(例: 「Site 一覧」「Variant を追加」「Stop(終了」)
  { re: /\b(?:Workspace|Site|Variant|Change|Goal|Member|Role|Experiment|Publish|Analytics|Identity|Mode|Start|Pause|Resume|Stop)\s?(?=[ぁ-んァ-ヶ一-龠「(])/u, use: "用語表の日本語" },
  // JSX のテキストやラベルに単独で置いた英語の語
  { re: />\s*(?:Publish|Start|Pause|Resume|Stop|Variant|Change|Goal|Analytics|Identity|Mode|Role|Site|Workspace)\s*[<{]/, use: "用語表の日本語" },
  { re: /\b(?:label|title|heading|placeholder|caption)\s*[=:]\s*\{?\s*["'`](?:Publish|Start|Pause|Resume|Stop|Variant|Change|Goal|Analytics|Identity|Mode|Role|Site|Workspace)["'`]/, use: "用語表の日本語" },
  { re: /\.toUpperCase\(\)/, use: "roleLabel(ロールの表示は roleLabel だけ)" },
];
/** 画面の語ではない使い方(理由を書く) */
const ALLOW: Array<{ file: string; re: RegExp; why: string }> = [
  { file: "lib/targeting-tree.ts", re: /\.toUpperCase\(\)/, why: "演算子の名前(notEquals など)を組み立てる" },
  { file: "components/experiment/VariantsTab.tsx", re: /\.toUpperCase\(\)/, why: "新しいパターンの既定の名前(ID の大文字)= データ" },
];

/**
 * コメントを除く。ブロックコメントは「行頭(字下げのみ)」か JSX の `{` の直後で始まるものだけ(文字列の中の `/__ab/*` のような
 * `/*` を開始と誤って後ろの行まで飲み込まないように)。行コメントは `//` の前が `:` のものを URL として残す。
 * 文字列の中の `//` も消えるが、検査が甘くなるだけで誤検出はしない
 */
const stripComments = (src: string) =>
  src
    .replace(/(^[ \t]*|\{)\/\*[\s\S]*?\*\/\}?/gm, (m: string, head: string) => head + m.slice(head.length).replace(/[^\n]/g, "")) // 改行は残す(行番号をずらさない)
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f));
}

/** 日本語を含む文字列リテラル("…" / '…' / `…`)の中では、大文字で始まる画面の語を単語として全面禁止(control の検査と同じ。r2 CX-Medium-6) */
const TERMS = "Workspace|Site|Variant|Change|Goal|Member|Role|Experiment|Publish|Start|Pause|Resume|Stop";
const STRICT_IN_JAPANESE = new RegExp(`\\b(?:${TERMS})\\b`);
const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** 文字列リテラルの外の JSX のテキスト(1 行の中で見つかる塊)。`=>` の `>` と、コードの記号(= ; " ' ` )を含む行は除く */
const JSX_TEXT: RegExp[] = [
  /(?<![=\-])>([^<>{}\n]+)(?=<)/g, // <p>text</p>(同じ行で閉じる)
  /(?<![=\-])>([^<>{}\n]+)$/g, // <p>text(複数行の JSX の先頭行。<Icon /> text も)
  /\}([^<>{}\n]+)(?=<|$)/g, // {expr} text
  /^\s*([^<>{}=;"'`]+)$/g, // text だけの行(複数行の JSX の途中・末尾)
];
const LONE_TERM = new RegExp(`^(?:${TERMS}|Profile|decision|version|active|on|off)[。、.,:：]*$`); // 1 語だけ置いた英語(<th>version</th> など)
/** JSX のテキストの中の旧表記: 日本語の文の中の英語の語、または 1 語だけ置いた英語の語 */
function jsxTextHits(line: string): string[] {
  const out: string[] = [];
  for (const re of JSX_TEXT) {
    for (const m of line.matchAll(re)) {
      const t = m[1]!.trim();
      if ((JAPANESE.test(t) && STRICT_IN_JAPANESE.test(t)) || LONE_TERM.test(t)) out.push(t);
    }
  }
  return out;
}

/**
 * 日本語の文の中に残る英語の語(B35 のあとの決定 (18))。日本語にして識別子は括弧で併記する
 * (Profile → 訪問者プロフィール / decision → 判定(/decision)/ on・off → オン・オフ / version・active → 版・配信中)。
 * 見るのは「日本語を含む文字列リテラル」と「日本語を含む JSX のテキスト」だけ。`<code>` の中・`${…}` / `{…}` の式・`/decision` のようなパス・
 * needsProfile や activeVersion のような識別子(語の途中)は見ない。設定のキー名(retentionDays など)は英語のまま
 */
const ENGLISH_PROSE: Array<{ re: RegExp; use: string }> = [
  { re: /(?<![\w/:.-])Profile\b/, use: "訪問者プロフィール" },
  { re: /(?<![\w/:.-])decision\b/, use: "判定(/decision)" },
  { re: /(?<![\w/:.-])(?:on|off)(?![\w/:.-])/, use: "オン / オフ" },
  { re: /(?<![\w/:.-])version(?![\w/:.-])/, use: "版" },
  { re: /(?<![\w/:.-])active(?![\w/:.-])/, use: "配信中" },
  { re: /\bPhase\b/, use: "「今後追加します」など(開発の段階名は画面に出さない)" },
];
const stripNonProse = (t: string) => t.replace(/<code>[^<]*<\/code>/g, " ").replace(/\$\{[^}]*\}/g, " ").replace(/\{[^{}]*\}/g, " ");
/** 1 行の中の、日本語を含む文字列リテラルと JSX のテキストに残る英語の語(の言い換え先) */
function englishProseIn(line: string): string[] {
  const segments: string[] = [...(line.match(LITERAL) ?? [])];
  for (const re of JSX_TEXT) for (const m of line.matchAll(re)) segments.push(m[1]!);
  const out: string[] = [];
  for (const seg of segments) {
    if (!JAPANESE.test(seg)) continue;
    const prose = stripNonProse(seg);
    for (const e of ENGLISH_PROSE) if (e.re.test(prose)) out.push(`英語の語「${prose.match(e.re)![0]}」→ ${e.use}`);
  }
  return out;
}

/** 1 行に含まれる旧表記(の言い換え先)。ALLOW は file を渡したときだけ見る */
function bannedIn(line: string, file?: string): string[] {
  const out: string[] = [];
  for (const b of BANNED) {
    if (!b.re.test(line)) continue;
    if (file && ALLOW.some((a) => a.file === file && a.re.source === b.re.source)) continue;
    out.push(b.use);
  }
  for (const t of jsxTextHits(line)) out.push(`JSX のテキスト「${t.slice(0, 40)}」→ 用語表の日本語`);
  out.push(...englishProseIn(line));
  return out;
}

describe("screen strings follow the glossary (backlog B35)", () => {
  it("the strict rule catches the known old texts and spares identifiers", () => {
    expect(STRICT_IN_JAPANESE.test("新しい Variant の ID")).toBe(true);
    expect(STRICT_IN_JAPANESE.test("Goal / オーディエンス")).toBe(true);
    expect(STRICT_IN_JAPANESE.test("variantId を指定する")).toBe(false);
    expect(STRICT_IN_JAPANESE.test("ChangeEditor の行")).toBe(false);
  });

  it("flags old wording in a line (each form is caught, identifiers and the new wording are spared)", () => {
    const bad = [
      "<p>この Site</p>", // JSX の文末の英語の語
      "<p>Publish。</p>",
      "<p>Site 一覧</p>",
      "      Publish", // 複数行の JSX の中の 1 語
      "      を Variant として追加します",
      '<Icon name="plus" /> 新しい Site',
      "<strong>{done}</strong> を OWNER として登録しました",
      "{count} 件の Change",
      "作成と編集は ADMIN 以上が行います",
      "<Field label=\"Workspace 名\">",
      '<th title="Site ID">',
      "<h1>新しい実験</h1>",
      "<span>未公開の変更あり</span>",
      "<span>{role.toUpperCase()}</span>",
      '{ label: "Code Change: HTML" }',
      "権限の上限",
      "フル(すべてのワークスペース)",
      "ユーザーメニューの「API キー」から",
      "導入パターンの選び方(docs/install-patterns.md)",
      "ロールバック操作は Phase 2(履歴の config は…)",
      "<p>Profile に達成回数が記録されます</p>",
      '<Field label="撤回時に Profile を削除(forgetOnRevoke)">',
      'hint="Mode A の decision / event はここに一致する Origin だけ受け付けます"',
      'hint="on にすると初回の割当を保存します。off では再割当されます"',
      '"(直後に新しい version が active になったため、この version は履歴のみ)"',
      "<th>version</th>",
      "      Profile は retentionDays で消えます",
    ];
    for (const line of bad) expect(bannedIn(line), line).not.toEqual([]);
    const good = [
      "<p>この サイト</p>",
      "<p>サイト ID をコピーします</p>",
      "<code>variantId</code> を指定します",
      "const site = await loadSite(siteId);",
      "const f = (a: number) => a < 3;",
      "if (a.length > 0 && b < 2) return null;",
      "<p>GA4 のプロパティ ID と Google アカウント</p>",
      "<p>オーナー / 管理者 / 編集者 / 閲覧者</p>",
      "<span>{roleLabel(role)}</span>",
      "export function ChangeEditor({ change }: Props) {",
      "      パターンを追加",
      "<Icon name=\"plus\" /> 新しいサイト",
      "  Mode C では同意の撤回で訪問者 ID は切れません。",
      "導入構成の選び方(docs/install-patterns.md)",
      "<p>訪問者プロフィールに達成回数が記録されます</p>",
      'hint="Mode A の判定(/decision)・イベント(/event)はここに一致する Origin だけ受け付けます"',
      'hint="オンにすると初回の割当を保存します。オフでは再割当されます"',
      '"(直後に新しい版が配信中になったため、この版は履歴のみ)"',
      "<th>版</th>",
      "const profile = needsProfile && site.activeVersion ? a.version : null;", // 日本語を含まないコード
      "<p><code>GET /sites/:sid/publishes/:version</code> で取得できます</p>", // <code> の中
      "{ ok: true, version: 1, active: false } // Japanese なし",
      '`公開 v${r.publish.version} を反映しました(最大約 3 分)`', // ${…} の式の中
      '訪問者プロフィール(needsProfile=${result.needsProfile})', // 識別子は語の途中
      '<input autoComplete="off" /> 有効にする', // 属性値は文字列リテラルだが日本語を含まない
      "<p>retentionDays まで保持されます</p>", // 設定のキー名は英語のまま
    ];

    for (const line of good) expect(bannedIn(line), line).toEqual([]);
  });

  it("has no capitalized screen terms inside Japanese string literals", () => {
    const hits: string[] = [];
    for (const file of DIRS.flatMap(files)) {
      const code = stripComments(readFileSync(path.join(ROOT, file), "utf8"));
      for (const m of code.matchAll(LITERAL)) {
        if (JAPANESE.test(m[0]) && STRICT_IN_JAPANESE.test(m[0])) hits.push(`${file}:${code.slice(0, m.index).split("\n").length} ${m[0].slice(0, 100)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("has no banned forms (including English terms in JSX text outside string literals)", () => {
    const hits: string[] = [];
    for (const file of DIRS.flatMap(files)) {
      const lines = stripComments(readFileSync(path.join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const use of bannedIn(line, file)) hits.push(`${file}:${i + 1} ${line.trim().slice(0, 100)} → ${use}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
