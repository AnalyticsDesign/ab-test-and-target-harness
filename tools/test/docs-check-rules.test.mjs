import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { appReadmes, changelogReleaseProblems, fenceMask, versionWordingProblems, VERSION_WORDING_ALLOW } from "../docs-check-rules.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const kinds = (ps) => ps.map((p) => `${p.line}:${p.kind}`);

const changelog = (body) => ["# 変更履歴", "", "前書き [deploy](docs/deploy.md)", "", ...body, ""].join("\n");

test("changelog_relative_link_in_release_sections", () => {
  const text = changelog([
    "## 未リリース", "", "- [デプロイガイド](docs/deploy.md) と [節](#v011)", "",
    "## v0.12 — 2026-11-10", "", "- [ガイド](docs/operations.md#6) / [外](https://github.com/a/b/blob/main/docs/deploy.md) / [m](mailto:a@example.com)", "",
    "## v0.11 — 2026-11-03", "", "- [古い節](docs/deploy.md)",
  ]);
  // 前書きと v0.11(公開済みの古い節)は見ない。未リリースと一番上の版の節の相対リンクとアンカーだけ
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["7:changelog-link", "7:changelog-link", "11:changelog-link"]);
});

test("changelog_plan_with_version", () => {
  const text = changelog([
    "## v0.12 — 2026-11-10", "",
    "- **既知の事項**: v1.0 で、名前を設置タグから外す予定。それまでは名前に書かない",
    "- **予定の書き方**: 分析ガイドの予定の書き方を直した",
    "- v0.11 で入れた機能を直した。結果の表示は予定どおり",
    "",
    "## v0.11 — 2026-11-03", "", "- v1.0 で入れる予定",
  ]);
  // 版と「予定」が同じ文にあるのは 7 行目だけ(9 行目は文が分かれている、13 行目は公開済みの節)
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["7:changelog-plan"]);
});

test("changelog_skips_code_fences", () => {
  const text = changelog(["## 未リリース", "", "```md", "- [x](docs/deploy.md) v1.0 で入れる予定", "```"]);
  assert.deepEqual(changelogReleaseProblems(text), []);
});

test("fence_mask_keeps_opening_char_and_length", () => {
  // 4 本で開いたフェンスは 3 本の行では閉じない。~~~ でも閉じない。4 本以上の ` で閉じる
  const lines = ["本文", "````md", "```", "~~~", "````", "後の本文", "~~~", "```", "~~~~", "最後"];
  assert.deepEqual(fenceMask(lines), [false, true, true, true, true, false, true, true, true, false]);
  // 閉じないまま終わったら最後までフェンス。情報文字列にバッククォートのある行は開始にならない
  assert.deepEqual(fenceMask(["```", "a"]), [true, true]);
  assert.deepEqual(fenceMask(["``` a`b", "本文"]), [false, false]);
});

test("fence_inside_a_list_item_with_deep_indent", () => {
  // 箇条書きの中で 4 文字以上字下げしたフェンス(deploy.md にある書き方)も、中を見ずに閉じた後を見る
  const body = ["1. 例:", "", "    ```md", "    [例](docs/deploy.md) この版から v1.0 で入れる予定", "    ```", "", "- [後](docs/operations.md) この版から"];
  assert.deepEqual(fenceMask(body), [false, false, true, true, true, false, false]);
  assert.deepEqual(kinds(changelogReleaseProblems(changelog(["## 未リリース", "", ...body]))), ["13:changelog-link"]);
  assert.deepEqual(versionWordingProblems("docs/deploy.md", body.join("\n"), []).map((p) => p.line), [7]);
});

test("changelog_long_fence_inside_and_text_after", () => {
  const text = changelog([
    "## 未リリース", "",
    "````md", "```", "- [x](docs/deploy.md) この版から v1.0 で入れる予定", "```", "````",
    "- [後](docs/operations.md)",
  ]);
  // フェンスの中は見ず、閉じた後の本文の相対リンク(12 行目)は見る
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["12:changelog-link"]);
  assert.deepEqual(versionWordingProblems("docs/site-install.md", ["````md", "```", "この版から", "```", "````", "この版から"].join("\n"), []).map((p) => p.line), [6]);
});

test("changelog_link_with_title_and_angle_brackets", () => {
  const text = changelog([
    "## 未リリース", "",
    '- [ガイド](docs/deploy.md "ガイド") / [絶対](https://github.com/a/b "t") / [角](<docs/site-install.md>)',
  ]);
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["7:changelog-link", "7:changelog-link"]);
});

test("changelog_inline_link_across_a_line_break", () => {
  // 改行を詰めてから照らす(項目の先頭の行で出す)
  const text = changelog(["## 未リリース", "", "- [ガイド](", '  docs/deploy.md "title")', "- [絶対](", "  https://github.com/a/b)"]);
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["7:changelog-link"]);
});

test("changelog_reference_links_are_not_allowed_in_release_sections", () => {
  // 使用・定義のどちらも止める(定義が前書きにあっても、使っていない定義だけでも)。前書きと公開済みの節では見ない
  const text = changelog([
    "## 未リリース", "",
    "- [ガイド][guide] と [空][]",
    "",
    "[unused]: https://github.com/a/b",
    "",
    "## v0.12 — 2026-11-10", "", "- 版の節", "",
    "## v0.11 — 2026-11-03", "", "- [古い][r]", "", "[r]: docs/deploy.md",
  ]).replace("前書き", "[guide]: docs/deploy.md\n\n前書き");
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["9:changelog-ref-link", "11:changelog-ref-link"]);
});

test("changelog_plan_sentence_spans_wrapped_lines_only_within_an_item", () => {
  const text = changelog([
    "## 未リリース", "",
    "- v1.0 で機能を",
    "  入れる予定。",
    "- v1.0 の名前を直した",
    "- 予定の書き方を直した",
    "",
    "v0.12 では",
    "",
    "予定は別の段落",
  ]);
  // 同じ項目の中で行をまたぐ文(7〜8 行目)は当たる。別の項目・別の段落に分かれた版と「予定」は当たらない
  assert.deepEqual(kinds(changelogReleaseProblems(text)), ["7:changelog-plan"]);
});

test("version_wording_flags_unclear_phrases", () => {
  const text = [
    "新しいサイトの既定は `_wtt_vid`、この更新の前に作ったサイトは `_ab_vid`",
    "この版から、オーナーは Google でログインする",
    "v0.11 より前に作ったサイトは `_ab_vid`",
    "今の版は当日の消費だけを出す",
    "```sh",
    "# この版から使える",
    "```",
  ].join("\n");
  assert.deepEqual(kinds(versionWordingProblems("docs/site-install.md", text, [])), ["1:version-wording", "2:version-wording"]);
});

test("version_wording_allow_and_stale_allow", () => {
  const allow = [
    { file: "docs/deploy.md", snippet: "この版より前に開いたタブ", reason: "目印のリリースの段落" },
    { file: "docs/deploy.md", snippet: "消えた行", reason: "古い" },
    { file: "docs/operations.md", snippet: "別のファイル", reason: "このファイルでは見ない" },
  ];
  const text = ["- この版より前に開いたタブは再読み込み", "- この版以降は別"].join("\n");
  assert.deepEqual(kinds(versionWordingProblems("docs/deploy.md", text, allow)), ["2:version-wording", "0:version-wording-allow-stale"]);
});

test("version_wording_allows_only_the_specific_multiple_release_markers", () => {
  const markers = "CHANGELOG の目印「データベースの形が変わる」「配る設定の版(`schemaVersion`)が上がる」「この版より前に開いたタブは再読み込みが要る」";
  const text = [
    `**ページの条件を対象 URL にまとめるリリースの更新**(${markers})`,
    "CHANGELOG の目印「この版より前に開いたタブは再読み込みが要る」",
    "この版より前に開いた管理画面のタブは再読み込みが要る",
    "CHANGELOG の目印を確認する。この版より前の操作は記録に無い",
    "CHANGELOG の目印「データベースの形が変わる」「この版より前に開いたタブは再読み込みが要る」",
  ].join("\n");
  // 許すのは既存の単独の引用と、この複数の目印の引用だけ。本文や別の引用の並びを広く許さない。
  assert.deepEqual(kinds(versionWordingProblems("docs/deploy.md", text)), ["3:version-wording", "4:version-wording", "5:version-wording"]);
  // 同じ引用でも、許可したファイル以外では検出する。
  assert.deepEqual(kinds(versionWordingProblems("docs/operations.md", markers)), ["1:version-wording"]);
});

// 今の公開文書で誤検知が出ないこと(出たら文書を直すか、理由を付けて VERSION_WORDING_ALLOW に足す)
test("current_public_docs_have_no_hits", () => {
  assert.deepEqual(changelogReleaseProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8")), []);
  const manifestPath = join(root, "release/manifest.json");
  if (!existsSync(manifestPath)) return; // 公開リポジトリには release/ が無い(docs-check.mjs 自身が全文書を見る)
  const { include } = JSON.parse(readFileSync(manifestPath, "utf8"));
  // docs-check.mjs と同じ一覧(apps/ の下で README.md を持つものすべて)
  const readmes = appReadmes(readdirSync(join(root, "apps")).filter((n) => existsSync(join(root, "apps", n, "README.md"))));
  assert.ok(readmes.includes("apps/deployer/README.md"));
  const docs = [...include.filter((p) => p.endsWith(".md") && p !== "CHANGELOG.md"), ...readmes].filter((p) => existsSync(join(root, p)));
  const hits = docs.flatMap((rel) => versionWordingProblems(rel, readFileSync(join(root, rel), "utf8")).map((p) => `${rel}:${p.line} ${p.text}`));
  assert.deepEqual(hits, []);
  assert.ok(VERSION_WORDING_ALLOW.every((a) => docs.includes(a.file)), "許可のファイルは公開文書");
});
