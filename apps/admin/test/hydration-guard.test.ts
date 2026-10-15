import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backlog B44 / B45 の再発防止(ソースの静的な検査)。
 * - B44: 時刻を描画の中で文字にすると、サーバー(Workers = UTC)とブラウザ(見ている人のタイムゾーン)で食い違い、
 *   ハイドレーションの不一致で root が描き直されて <html data-theme> が外れる。時刻は <LocalTime> / <ExpiryLabel>
 *   (マウントの後にブラウザで描く)を通す。`Date.now()` も描画の中で使わない(useNow を使う)
 * - B45: 確認はブラウザ標準の confirm() ではなく、共通の確認モーダル(useConfirm)を使う
 */
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components"];

/** コメントを除く(glossary.test.ts と同じ考え方。改行は残して行番号をずらさない) */
const stripComments = (src: string) =>
  src
    .replace(/(^[ \t]*|\{)\/\*[\s\S]*?\*\/\}?/gm, (m: string, head: string) => head + m.slice(head.length).replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f).split(path.sep).join("/"));
}

/** 許してよい行(ファイル + その行に含まれる文字列)。ファイルごと許すと、後から足した行も通ってしまうので行で許す */
type Allow = { file: string; line: RegExp; why: string };
const RULES: Array<{ re: RegExp; use: string; allow: Allow[] }> = [
  {
    re: /\.toLocale(?:Date|Time)?String\(|Intl\.DateTimeFormat/,
    use: "<LocalTime> / <ExpiryLabel>(マウントの後にブラウザで描く)",
    allow: [],
  },
  {
    re: /\bDate\.now\(\)|new Date\(\)|performance\.now\(\)/,
    use: "useNow()(マウント前は null)",
    allow: [
      { file: "components/LocalTime.tsx", line: /setNow\(Date\.now\(\)\)/, why: "useNow の effect の中だけで読む" },
      { file: "components/api-keys/IssueKeyForm.tsx", line: /setChosenAt\(Date\.now\(\)\)/, why: "期限を選んだイベントの中で読む" },
    ],
  },
  {
    // 時刻を文字にする関数(lib)を描画の中で直接呼ぶと、サーバーの描画でも動いてしまう
    re: /\b(?:formatLocalTime|formatDeadline|expiryLabel)\(/,
    use: "<LocalTime> / <ExpiryLabel>",
    allow: [
      { file: "components/LocalTime.tsx", line: /formatLocalTime\(at, kind\)|expiryLabel\((?:null, 0|expiresAt, now)\)/, why: "時刻の描画を引き受ける部品そのもの" },
      { file: "components/MembersPanel.tsx", line: /const deadline = /, why: "招待の期限の書式。呼ぶのはマウント後(now !== null)と発行の後だけ" },
      { file: "components/MembersPanel.tsx", line: /now === null \? null : .*expiryLabel\(i\.expiresAt, now\)/, why: "now(useNow)が入った後だけ描く" },
      { file: "components/api-keys/IssueKeyForm.tsx", line: /formatDeadline\(deadline\)/, why: "deadline は期限を選んだ後(= マウントの後)にだけ値を持つ" },
    ],
  },
  { re: /(?<![\w$.])confirm\(|window\.confirm\(/, use: "useConfirm()(共通の確認モーダル)", allow: [] },
];

describe("hydration guard and confirm dialog (B44 / B45)", () => {
  for (const rule of RULES) {
    it(`no ${rule.re} in app/ and components/ (use ${rule.use})`, () => {
      const hits: string[] = [];
      for (const file of DIRS.flatMap(files)) {
        const lines = stripComments(readFileSync(path.join(ROOT, file), "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (!rule.re.test(line)) return;
          if (rule.allow.some((a) => a.file === file && a.line.test(line))) return;
          hits.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  it("every allowed line still exists (a stale allowance would hide nothing but mislead)", () => {
    const stale: string[] = [];
    for (const rule of RULES) {
      for (const a of rule.allow) {
        const src = stripComments(readFileSync(path.join(ROOT, a.file), "utf8"));
        if (!src.split("\n").some((l) => rule.re.test(l) && a.line.test(l))) stale.push(`${a.file}: ${a.line}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
