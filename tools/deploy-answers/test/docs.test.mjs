import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QUESTIONS, CONFIG_KEYS, isBlank, isConfigured } from "../questions.mjs";
import { parseAnswers } from "../parse.mjs";
import { run } from "../run.mjs";

const root = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

test("質問の表の文書: 各問いの行に ID・キー・すべての値がある", () => {
  const rows = read("docs/install-questions.md").split("\n");
  for (const q of QUESTIONS) {
    const row = rows.find((l) => l.startsWith(`| ${q.id} |`));
    assert.ok(row, `${q.id} の行が無い`);
    assert.ok(row.includes(`\`${q.key}\``), `${q.id} にキー ${q.key} が無い`);
    for (const v of q.values ?? (q.kind === "bool" ? ["true", "false"] : [])) assert.ok(row.includes(`\`${v}\``), `${q.id} に値 ${v} が無い`);
  }
});

test("雛形: 読めて、上段は未記入、下段はすべてコメントアウト", () => {
  const y = read("deploy-answers.example.yaml");
  const { values, errors } = parseAnswers(y);
  assert.deepEqual(errors, []);
  for (const q of QUESTIONS) {
    assert.ok(new RegExp(`^${q.key}:`, "m").test(y), `上段に ${q.key} が無い`);
    assert.ok(isBlank(values[q.key]), `${q.key} が未記入になっていない`);
  }
  for (const k of [...CONFIG_KEYS, "accepted"]) assert.ok(new RegExp(`^# ?${k}:`, "m").test(y), `下段に ${k} が無い`);
  assert.equal(isConfigured(values), false);
});

test("雛形のまま実行すると、すべての問いが聞き直しになる(終了コード 2)", () => {
  const r = run(read("deploy-answers.example.yaml"));
  assert.equal(r.code, 2);
  for (const id of ["N1", "N2", "N3", "E1", "E2", "E3"]) assert.match(r.output, new RegExp(`- ${id}\\(`));
});
