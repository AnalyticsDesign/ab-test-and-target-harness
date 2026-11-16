// 人に頼む文は、一覧の名前と作成日で見分ける形にする(一覧に ID の列は無い)。偽の Cloudflare と一時ディレクトリだけを使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { stage, scene, joined, childName, LIST_PLACE } from "./flow-stage.mjs";

// ID で見分けてもらう頼み方(「その ID のトークンを消す」など)
const BY_ID = /(その|上の|記録の子の|記録の) ?ID のトークンを(確かめ|消す|人が消)/;

test("human_exit_asks_by_name_and_created_date_not_by_id", async (t) => {
  const s = stage(t);
  s.fake.networkErrorNext("createToken");
  assert.equal((await s.run()).status, "error");
  // POST が遅れて成立し、記録に無い同名が一覧に見える(人の出口になる)
  const late = s.fake.addToken({ name: childName("setup"), permissions: ["Zone Read"] });
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(childName("setup")), "名前を出す");
  assert.ok(text.includes(late.id), "ID は上の行に出す(エージェントが照らす)");
  assert.match(text, /Created\(作成日\)/, "Created(作成日)で見分ける");
  assert.match(text, /同じ Name\(名前\)のトークンが 2 本以上あって、Created\(作成日\)でも見分けられないときは、消さずにエージェントに伝える/);
  assert.ok(!BY_ID.test(text), `ID での見分けの頼み方が無い: ${text}`);
});

test("human_facing_sentences_in_lib_do_not_ask_to_find_a_token_by_id", () => {
  const dir = new URL("../lib/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!BY_ID.test(src), `${f} に ID で見分けてもらう文がある`);
    // 前の親・今の親は名前が同じなので、「前の親 ${P} を消し」のような ID 入りのラベルで消す方を指す形も戻さない
    assert.ok(!/前の親 \$\{P\} を消|記録の親 \$\{P\} が\$\{LIST_PLACE\}|\$\{LIST_PLACE\}に記録の親 \$\{P\}/.test(src), `${f} に ID 入りのラベルで消す方を指す文がある`);
  }
});

// ---- 前の親と今の親(名前が同じ)を一覧で書き分ける ----

// 一覧を見て消す・探す文(LIST_PLACE を含む行)に、ID の入ったラベル「名前(ID …)」で指す形が戻らないこと
const LIST_LINE_WITH_ID_LABEL = new RegExp(`${LIST_PLACE.replace(/[()]/g, "\\$&")}[^\\n]*\\(ID [0-9a-f]+\\)`);

for (const [name, cfg, args] of [
  ["before_other_plain", { rec: "before", value: "other" }, {}],
  ["before_none_plain", { rec: "before", value: "none" }, {}],
  ["before_none_reset", { rec: "before", value: "none" }, { reset: true }],
  ["checked_none_plain", { rec: "checked", value: "none" }, {}],
]) {
  test(`parent_exit_${name}_tells_old_and_new_parent_apart_by_created`, async (t) => {
    const s = scene(t, cfg);
    const out = await s.run(args);
    assert.equal(out.status, "human", joined(out));
    const text = joined(out);
    assert.match(text, /Created\(作成日\)が古い方\(前の親\)/);
    if (cfg.value === "other") {
      assert.match(text, /Created\(作成日\)が新しい方/);
      assert.match(text, /新しい方\(今の親\)は消さない/);
      // 人が先に前の親を消していると、一覧の同じ名前は今の親 1 本だけになる(最終レビュー Minor 1)
      assert.match(text, /一覧にその Name\(名前\)のトークンが 1 本だけなら、それは今の親なので消さない/);
    } else {
      // 値が無いマスでは、一覧の 1 本が今の親とは言えないので、この文を付けない
      assert.ok(!/1 本だけなら、それは今の親/.test(text), text);
    }
    assert.ok(text.includes(s.P.id), "ID は上の行に出す(エージェントが照らす)");
    for (const line of text.split("\n")) assert.ok(!LIST_LINE_WITH_ID_LABEL.test(line), `一覧で ID のラベルで指さない: ${line}`);
    assert.ok(!BY_ID.test(text));
  });
}
