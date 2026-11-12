import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseHelp, renderHelpModule, renderMarkdown } from "../scripts/help-lib.mjs";
import { HELP, HELP_KEYS, isHelpKey } from "../generated/help.ja";

/**
 * D9 plan ③ Task 13(K22): 説明(ヘルプ)の原稿 docs/experiment-results.md を管理画面に同梱する。
 * 原稿の検査(印・要点・鍵)と Markdown の変換は scripts/help-lib.mjs、生成物は generated/help.ja.ts
 */
const ROOT = path.join(import.meta.dirname, "..");
const MANUSCRIPT = path.join(ROOT, "../../docs/experiment-results.md");

/** 設計書 §11.4 の鍵(画面とエージェントが引く項目)。原稿にすべてあること */
const SPEC_KEYS = [
  // 評価計画
  "plan", "why-plan", "primary-goal", "baseline", "min-period", "evaluation-point", "sample-size", "min-improvement", "equivalence", "threshold", "multiple-variants", "observation-window", "participants", "model",
  // 結果
  "verdicts", "probability", "difference", "cvr", "expected-loss", "best", "quality", "srm", "mixed", "apply-failures", "collection-failures", "collection-stops", "test-changes", "overlap", "ga4-differences", "segments", "plan-changes", "retention", "adopt", "enable", "data-integrity",
];

/** app/ と components/ の .tsx から helpKey="…"(helpKey={"…"} / {'…'} も)を集める */
function usedHelpKeys(): Array<{ file: string; key: string }> {
  const out: Array<{ file: string; key: string }> = [];
  for (const dir of ["app", "components"]) {
    const files = readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"));
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, dir, f), "utf8");
      for (const m of src.matchAll(/helpKey=(?:"([^"]*)"|\{\s*["'`]([^"'`]*)["'`]\s*\})/g)) out.push({ file: `${dir}/${f}`, key: m[1] ?? m[2] ?? "" });
    }
  }
  return out;
}

const item = (key: string, heading: string, summary: string, body = "") => `<!-- help: ${key} -->\n${heading}\n\n${summary}\n${body ? `\n${body}\n` : ""}`;

describe("説明の原稿と画面の鍵", () => {
  test("help_keys_exist_in_manuscript", () => {
    const missingSpec = SPEC_KEYS.filter((k) => !(k in HELP));
    expect(missingSpec).toEqual([]);
    const missingUsed = usedHelpKeys().filter(({ key }) => !(key in HELP));
    expect(missingUsed).toEqual([]);
    // HELP_KEYS は HELP の鍵と同じ並び(パネルは原稿の順に並べる)
    expect([...HELP_KEYS]).toEqual(Object.keys(HELP));
    expect(isHelpKey("plan")).toBe(true);
    expect(isHelpKey("no-such-key")).toBe(false);
  });

  test("generated/help.ja.ts は原稿から作り直した結果と同じ(生成物のコミット漏れが無い)", () => {
    const md = readFileSync(MANUSCRIPT, "utf8");
    const { entries, problems } = parseHelp(md);
    expect(problems).toEqual([]);
    expect(readFileSync(path.join(ROOT, "generated/help.ja.ts"), "utf8")).toBe(renderHelpModule(entries));
  });

  test("各項目は題・要点(1〜160 字)・本文を持つ", () => {
    for (const [key, h] of Object.entries(HELP)) {
      expect(h.title, key).not.toBe("");
      expect([...h.summary].length, key).toBeGreaterThan(0);
      expect([...h.summary].length, key).toBeLessThanOrEqual(160);
      expect(typeof h.bodyHtml, key).toBe("string");
    }
  });

  test("本文は「この文書の N 節」を指さない(印の無い節は管理画面に入らず、相対リンクは文字になるため行き止まりになる)", () => {
    // 印の無い節(6 節の計算の方法など)を指すときは、公開文書を名前で指す(B104 のレビュー CL-Medium-1)
    for (const [key, h] of Object.entries(HELP)) {
      expect(h.bodyHtml, key).not.toMatch(/この文書の\s*\d+\s*節/);
    }
  });

  test("版の表示: 開発では dev、公開物では版の文字列", () => {
    const generated = readFileSync(path.join(ROOT, "generated/release.ts"), "utf8");
    const version = generated.match(/export const RELEASE_VERSION = "([^"]+)";/)?.[1];
    expect(version).toMatch(/^(dev|v\d+\.\d+(\.\d+)?)$/);
  });
});

describe("embed-help の検査", () => {
  test("embed-help: 印の直後が ### でない・要点が 160 字超・鍵の重複は失敗", () => {
    // 正しい原稿は問題なし。題・要点・本文に分かれる
    const ok = parseHelp(`# 題\n\n${item("plan", "### 評価計画", "開始前に決めるものです。", "- 1 つ目\n- 2 つ目")}`);
    expect(ok.problems).toEqual([]);
    expect(ok.entries).toEqual([{ key: "plan", title: "評価計画", summary: "開始前に決めるものです。", body: "- 1 つ目\n- 2 つ目", line: 3 }]);

    // 印の直後(次の行)が ### の見出しでない(空行を挟む・## の見出し・本文)
    for (const bad of [`<!-- help: plan -->\n\n### 評価計画\n\n要点。\n`, `<!-- help: plan -->\n## 評価計画\n\n要点。\n`, `<!-- help: plan -->\n要点。\n`]) {
      const r = parseHelp(bad);
      expect(r.problems.map((p) => p.message).join("\n"), bad).toMatch(/直後/);
    }
    // 要点が 160 字を超える(161 字)・空
    expect(parseHelp(item("plan", "### 評価計画", "あ".repeat(161))).problems.map((p) => p.message).join("\n")).toMatch(/160/);
    expect(parseHelp(item("plan", "### 評価計画", "あ".repeat(160))).problems).toEqual([]);
    expect(parseHelp(`<!-- help: plan -->\n### 評価計画\n\n- 箇条書きは要点にならない\n`).problems.map((p) => p.message).join("\n")).toMatch(/要点/);
    expect(parseHelp(`<!-- help: plan -->\n### 評価計画\n`).problems.map((p) => p.message).join("\n")).toMatch(/要点/);
    // 鍵の重複
    const dup = parseHelp(`${item("plan", "### A", "要点。")}\n${item("plan", "### B", "要点。")}`);
    expect(dup.problems.map((p) => p.message).join("\n")).toMatch(/重複/);
    // 鍵の形は [a-z0-9-]+
    expect(parseHelp(item("Plan_1", "### A", "要点。")).problems.map((p) => p.message).join("\n")).toMatch(/\[a-z0-9-\]/);
  });

  test("本文は次の印か、次の ### 以上の見出しの前まで。要点の書式は文字にする", () => {
    const md = `${item("a", "### A", "**太字**と \`code\` と [リンク](https://example.com/)。", "本文 A。")}\n## 次のまとまり\n\n前置き。\n\n${item("b", "### B", "要点 B。", "本文 B。")}`;
    const { entries, problems } = parseHelp(md);
    expect(problems).toEqual([]);
    expect(entries.map((e) => [e.key, e.summary, e.body])).toEqual([
      ["a", "太字と code と リンク。", "本文 A。"],
      ["b", "要点 B。", "本文 B。"],
    ]);
  });
});

describe("Markdown の変換", () => {
  test("Markdown の変換: 許した書式だけ HTML、<script> は文字として出る、外部リンクは新しいタブ", () => {
    // 段落・強調・インラインコード
    expect(renderMarkdown("**強調** と `x < 1` の段落。")).toBe("<p><strong>強調</strong> と <code>x &lt; 1</code> の段落。</p>");
    // 段落は空行で分かれ、段落の中の改行は詰める
    expect(renderMarkdown("1 行目\n2 行目\n\n次の段落")).toBe("<p>1 行目2 行目</p>\n<p>次の段落</p>");
    // 箇条書き(- と 1.)
    expect(renderMarkdown("- 一つ\n- 二つ")).toBe("<ul><li>一つ</li><li>二つ</li></ul>");
    expect(renderMarkdown("1. 一つ\n2. 二つ")).toBe("<ol><li>一つ</li><li>二つ</li></ol>");
    // 表
    expect(renderMarkdown("| 名前 | 値 |\n|---|---|\n| a | **1** |")).toBe("<table><thead><tr><th>名前</th><th>値</th></tr></thead><tbody><tr><td>a</td><td><strong>1</strong></td></tr></tbody></table>");
    // 本文の見出し(####)
    expect(renderMarkdown("#### 小見出し")).toBe("<h5>小見出し</h5>");
    // 外部リンクは新しいタブ。それ以外(相対パス・javascript:)はリンクにせず文字だけ
    expect(renderMarkdown("[GA4](https://example.com/a?b=1&c=2)")).toBe('<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">GA4</a></p>');
    expect(renderMarkdown("[運用ガイド](operations.md#1-x)")).toBe("<p>運用ガイド</p>");
    expect(renderMarkdown("[x](javascript:alert)")).toBe("<p>x</p>");
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
    // 生の HTML・許していない記法は文字として出る
    expect(renderMarkdown("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(renderMarkdown('<img src="x" onerror="y">')).toBe("<p>&lt;img src=&quot;x&quot; onerror=&quot;y&quot;&gt;</p>");
    expect(renderMarkdown("> 引用")).toBe("<p>&gt; 引用</p>");
    expect(renderMarkdown("![画像](https://example.com/a.png)")).toBe('<p>!<a href="https://example.com/a.png" target="_blank" rel="noopener">画像</a></p>');
    // インラインコードの中は書式にしない
    expect(renderMarkdown("`**そのまま**`")).toBe("<p><code>**そのまま**</code></p>");
  });
});
