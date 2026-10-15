import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswers, stripComment, parseScalar } from "../parse.mjs";

test("平らな key: value・真偽値・インラインの配列・空の値を読む", () => {
  const { values, errors } = parseAnswers("features: [ab, history]\nimage_upload: false\ndaily_pv: unknown\nowner_email:\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { features: ["ab", "history"], image_upload: false, daily_pv: "unknown", owner_email: null });
});

test("行末のコメント・コメントだけの行・空行を無視する", () => {
  const { values, errors } = parseAnswers("# 見出し\n\ndaily_pv: under_10k   # N2\n# edge_address: route\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { daily_pv: "under_10k" });
});

test("CRLF と先頭の BOM を読める(Windows のメモ帳で保存したファイル)", () => {
  const { values, errors } = parseAnswers("\uFEFFdaily_pv: unknown\r\nimage_upload: true\r\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { daily_pv: "unknown", image_upload: true });
});

test("引用符の中の # はコメントとして扱わない", () => {
  assert.equal(stripComment('workspace_name: "A #1"  # 名前'), 'workspace_name: "A #1"  ');
  assert.deepEqual(parseAnswers('workspace_name: "A #1"\n').values, { workspace_name: "A #1" });
});

test("プレースホルダ(<…>)は文字列のまま返す(未記入かどうかは検査の側で判断する)", () => {
  assert.deepEqual(parseAnswers("features: <ab / history / itp>\n").values, { features: "<ab / history / itp>" });
});

test("空の配列と引用符付きの要素", () => {
  assert.deepEqual(parseScalar("[]"), { value: [] });
  assert.deepEqual(parseScalar('["a.example.com", b.example.com]'), { value: ["a.example.com", "b.example.com"] });
});

test("書式の誤りは行番号付きで返す(入れ子・複数行・閉じない配列・重複・key: value でない行)", () => {
  const { errors } = parseAnswers("a: 1\n  b: 2\nc: [x, y\nd: |\na: 3\nこれは行\n");
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5, 6]);
  for (const e of errors) assert.equal(typeof e.message, "string");
});
