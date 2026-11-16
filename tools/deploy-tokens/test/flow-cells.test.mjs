// 「記録の状態 × 親の値 × 引数」の表のマスごとのテスト(B130 Task 6b)。名前は cell_<記録>_<親の値>_<引数>_<結果>。
// 表の「起きない」と「―」のマス(なし × 別・消、後 × 同)は飛ばす。どのマスでも、DELETE を送った ID が、
// 始めの記録の allowedDeleteIds(restart)と確かめを通った親の ID の中にあることを見る。
// 偽の Cloudflare と一時ディレクトリだけを使い、本物にはつながない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { scene, assertDeletesAllowed, joined, childName, parentName, LIST_PLACE, ROLES, WORKERS_DEV } from "./flow-stage.mjs";
import { ENV_KEY } from "../lib/spec.mjs";

const PD_IGNORED = /値があったので、--parent-deleted は使わなかった/;

/** マスを 1 つ流す。始めの記録・値のファイルを残し、DELETE の集合を見る */
async function runCell(t, cfg, args = {}) {
  const s = scene(t, cfg);
  const rec0 = existsSync(s.files.record) ? s.record() : null;
  const recText0 = s.recordText();
  const secText0 = s.secretsText();
  const out = await s.run(args);
  const parentOk = cfg.value === "same" ? s.P.id : cfg.value === "other" ? s.Q.id : null;
  return { s, out, rec0, recText0, secText0, parentOk };
}

const PD = { parentDeleted: true };
const RESET = { reset: true };
const posts = (s) => s.count("createToken");
const listsOf = (s) => s.count("listTokens");

// ---- 記録が「なし」 ----

test("cell_none_none_plain_asks_for_parent", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "none", value: "none" });
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assert.equal(s.fake.requests.length, 0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_none_same_plain_creates", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "none", value: "same" });
  assert.equal(out.status, "done", joined(out));
  assert.equal(posts(s), 3);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_none_none_reset_nothing_to_delete_done", async (t) => {
  const { s, out } = await runCell(t, { rec: "none", value: "none" }, RESET);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), /消すものは無い/);
  assert.match(joined(out), /cloudflare_tokens/);
  assert.equal(s.fake.requests.length, 0);
  assert.equal(existsSync(s.files.record), false);
});

test("cell_none_same_reset_deletes_parent_done", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "none", value: "same" }, RESET);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), /cloudflare_tokens/);
  assert.equal(s.fake.token(s.P.id), null, "親を消した");
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(existsSync(s.files.record), false, "記録を作らない");
  assert.equal(posts(s), 0);
  assert.equal(listsOf(s), 0, "記録が無ければ解く印も無いので、一覧を読まない");
  assert.equal(s.fake.requests.length, 4, "親の verify・詳細・削除・削除の後の verify");
  assert.equal(out.parent.state, "deleted");
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_none_none_pd_usage_error", async (t) => {
  const { s, out } = await runCell(t, { rec: "none", value: "none" }, PD);
  assert.equal(out.status, "error", joined(out));
  assert.match(joined(out), /記録に親が無い/);
  assert.equal(s.fake.requests.length, 0);
});

test("cell_none_same_pd_ignores_flag_and_creates", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "none", value: "same" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(posts(s), 3);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

// ---- 記録が「前」 ----

test("cell_before_none_plain_human_with_recorded_parent", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "before", value: "none" });
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.P.id), "記録の親の ID");
  for (const role of ROLES) assert.ok(text.includes(s.kids[role].id), `記録の子 ${role} の ID`);
  assert.match(text, /貼り直して/);
  assert.match(text, /--parent-deleted/);
  assert.ok(text.includes(LIST_PLACE));
  assert.equal(s.recordText(), recText0, "記録を変えない");
  assert.equal(posts(s), 0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_none_plain_without_parent_id_asks_for_parent", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "before", value: "none", parentIdInRecord: false });
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assert.ok(!/--parent-deleted/.test(joined(out)), "記録に親が無ければ --parent-deleted を勧めない");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_same_plain_restarts", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "before", value: "same" });
  assert.equal(out.status, "done", joined(out));
  for (const role of ROLES) assert.equal(s.fake.token(s.kids[role].id), null, `前の子 ${role} を消した`);
  const rec = s.record();
  for (const role of ROLES) assert.notEqual(rec.children[role].id, s.kids[role].id, `${role} を作り直した`);
  assert.equal(posts(s), 3);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 4 });
});

test("cell_before_other_plain_human_exit", async (t) => {
  const { s, out, rec0, recText0, secText0 } = await runCell(t, { rec: "before", value: "other" });
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.P.id) && text.includes(s.Q.id), "前の親と今の親の ID");
  assert.match(text, /--parent-deleted/);
  assert.match(text, /貼り直して打ち直す/);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.secretsText(), secText0);
  assert.equal(posts(s), 0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_gone_plain_clears_parent_then_as_none", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "before", value: "gone" });
  assert.equal(out.status, "human", joined(out));
  const rec = s.record();
  assert.equal(rec.parent_id, null);
  assert.equal(rec.parent_fp, null);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "", "消えた親の値を消した");
  for (const role of ROLES) assert.equal(rec.children[role].id, s.kids[role].id, "子は記録に残す");
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_none_reset_nothing_left_deletes_record", async (t) => {
  const { s, out } = await runCell(t, { rec: "before", value: "none", roles: [], parentIdInRecord: false }, RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  assert.match(joined(out), /cloudflare_tokens/);
  assert.equal(s.fake.requests.length, 0);
});

test("cell_before_none_reset_with_children_human", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "before", value: "none" }, RESET);
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  for (const role of ROLES) assert.ok(text.includes(s.kids[role].id));
  assert.ok(text.includes(s.P.id));
  assert.match(text, /--reset を付けて打ち直す/);
  assert.match(text, /先に --parent-deleted/);
  assert.equal(s.recordText(), recText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_same_reset_switches", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "before", value: "same" }, RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false, "記録を消した");
  for (const role of ROLES) {
    assert.equal(s.fake.token(s.kids[role].id), null);
    assert.equal(s.secrets().get(ENV_KEY[role]), "", `${role} の行を空にした`);
  }
  assert.equal(s.fake.token(s.P.id), null);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.match(joined(out), /cloudflare_tokens/);
  // 親の verify 1・詳細 1・一覧 2L・子の DELETE 3・親の削除 1・削除の後の verify 1
  assert.equal(s.count("verify"), 2);
  assert.equal(s.count("tokenDetails"), 1);
  assert.equal(listsOf(s), 2);
  assert.equal(s.count("permissionGroups"), 0);
  assert.equal(s.count("zones"), 0);
  assert.equal(posts(s), 0);
  assert.equal(s.fake.requests.length, 9);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 4 });
});

test("cell_before_other_reset_human_exit", async (t) => {
  const { s, out, rec0, recText0, secText0 } = await runCell(t, { rec: "before", value: "other" }, RESET);
  assert.equal(out.status, "human", joined(out));
  assert.ok(joined(out).includes(s.P.id) && joined(out).includes(s.Q.id));
  assert.equal(s.recordText(), recText0, "前の親が解けるまで消さない");
  assert.equal(s.secretsText(), secText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_gone_reset_clears_parent_then_as_none_reset", async (t) => {
  {
    // 子が残っている → 無の --reset と同じ(生きた親を求める)
    const { s, out, rec0 } = await runCell(t, { rec: "before", value: "gone" }, RESET);
    assert.equal(out.status, "human", joined(out));
    assert.equal(s.record().parent_id, null);
    assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
    assert.match(joined(out), /--reset を付けて打ち直す/);
    assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
  }
  {
    // 何も残っていない → 記録を消して done
    const { s, out, rec0 } = await runCell(t, { rec: "before", value: "gone", roles: [] }, RESET);
    assert.equal(out.status, "done", joined(out));
    assert.equal(existsSync(s.files.record), false);
    assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
    assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
  }
});

test("cell_before_none_pd_clears_parent_id_human", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "before", value: "none" }, PD);
  assert.equal(out.status, "human", joined(out));
  const rec = s.record();
  assert.equal(rec.parent_id, null);
  assert.equal(rec.parent_fp, null);
  for (const role of ROLES) assert.equal(rec.children[role].id, s.kids[role].id);
  assert.match(joined(out), /新しく作って貼る/);
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_none_pd_without_parent_id_usage_error", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "before", value: "none", parentIdInRecord: false }, PD);
  assert.equal(out.status, "error", joined(out));
  assert.match(joined(out), /記録に親が無い/);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.fake.requests.length, 0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_same_pd_value_decides_restart", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "before", value: "same" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 4 });
});

test("cell_before_other_pd_value_decides_human_exit", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "before", value: "other" }, PD);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.ok(joined(out).includes(s.Q.id));
  assert.equal(s.recordText(), recText0, "--parent-deleted で親を外さない");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_before_gone_pd_value_decides_clears_parent", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "before", value: "gone" }, PD);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.record().parent_id, null);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

// ---- 記録が「確」 ----

test("cell_checked_none_plain_human_exit", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "checked", value: "none" });
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.P.id));
  assert.match(text, /消えたかを確かめられない/);
  assert.match(text, /値を空のまま --parent-deleted/);
  assert.equal(s.recordText(), recText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_same_plain_deletes_parent_then_checks_children", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "checked", value: "same" });
  assert.equal(out.status, "done", joined(out));
  assert.ok(s.record().parent_deleted_at);
  assert.equal(s.fake.token(s.P.id), null);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(listsOf(s), 0);
  assert.equal(posts(s), 0);
  // 親の verify 1・詳細 1・削除 1・削除の後の verify 1・子の verify 3
  assert.equal(s.fake.requests.length, 7);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_checked_other_plain_human_exit", async (t) => {
  const { s, out, rec0, recText0, secText0 } = await runCell(t, { rec: "checked", value: "other" });
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.P.id) && text.includes(s.Q.id), "記録の親と今の親");
  assert.match(text, /--parent-deleted/);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.secretsText(), secText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_gone_plain_marks_deleted_then_checks_children", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "checked", value: "gone" });
  assert.equal(out.status, "done", joined(out));
  assert.ok(s.record().parent_deleted_at);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  const deletedAt = s.calls.findIndex((x) => x.op === "writeRecord" && x.rec.parent_deleted_at);
  const clearedAt = s.calls.findIndex((x) => x.op === "clearSecret" && x.key === "CF_BOOTSTRAP_TOKEN");
  assert.ok(deletedAt >= 0 && clearedAt > deletedAt, "parent_deleted_at を書いてから値を消す");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_none_reset_human_exit", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "checked", value: "none" }, RESET);
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  for (const role of ROLES) assert.ok(text.includes(s.kids[role].id));
  assert.match(text, /--reset を付けて打ち直す/);
  assert.match(text, /deploy-tokens\.json を消/);
  assert.match(text, /--parent-deleted は使わない/);
  assert.equal(s.recordText(), recText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_same_reset_switches", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "checked", value: "same" }, RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  for (const role of ROLES) assert.equal(s.fake.token(s.kids[role].id), null);
  assert.equal(s.fake.token(s.P.id), null);
  // 最初の DELETE の前に children_checked_at を外した
  const unchecked = s.calls.find((x) => x.op === "writeRecord" && x.rec.children_checked_at === null);
  const firstDelete = s.fake.requests.findIndex((r) => r.route === "deleteToken");
  assert.ok(unchecked && firstDelete >= 0 && unchecked.at <= firstDelete, "最初の DELETE の前に children_checked_at を外す");
  assert.ok(!s.calls.some((x) => x.op === "writeRecord" && x.rec.parent_deleted_at), "--reset は parent_deleted_at を書かない");
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 4 });
});

test("cell_checked_other_reset_human_exit", async (t) => {
  const { s, out, rec0, recText0, secText0 } = await runCell(t, { rec: "checked", value: "other" }, RESET);
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.P.id) && text.includes(s.Q.id));
  assert.match(text, /--parent-deleted は使わない/);
  assert.match(text, /CF_BOOTSTRAP_TOKEN を空にする/);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.secretsText(), secText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_gone_reset_human_exit_record_unchanged", async (t) => {
  const { s, out, rec0, recText0, secText0 } = await runCell(t, { rec: "checked", value: "gone" }, RESET);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /もう消えた/);
  assert.match(joined(out), /--reset では/);
  assert.equal(s.recordText(), recText0, "記録は変えない");
  assert.equal(s.secretsText(), secText0, "値も変えない");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_none_pd_marks_deleted_then_checks_children", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "checked", value: "none" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.ok(s.record().parent_deleted_at);
  assert.equal(s.count("verify"), 3, "子の verify だけ");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_same_pd_value_decides_deletes_parent", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "checked", value: "same" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.fake.token(s.P.id), null);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_checked_other_pd_value_decides_human_exit", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "checked", value: "other" }, PD);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.recordText(), recText0, "parent_deleted_at を書かない");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_checked_gone_pd_value_decides_marks_deleted", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "checked", value: "gone" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.ok(s.record().parent_deleted_at);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

// ---- 記録が「後」 ----

test("cell_after_none_plain_checks_children", async (t) => {
  const { s, out, rec0, recText0 } = await runCell(t, { rec: "after", value: "none" });
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.count("verify"), 3, "子の verify だけ");
  assert.equal(s.fake.requests.length, 3);
  assert.equal(s.recordText(), recText0);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_after_other_plain_deletes_pasted_parent_then_checks", async (t) => {
  const { s, out, rec0, recText0, parentOk } = await runCell(t, { rec: "after", value: "other" });
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.fake.token(s.Q.id), null, "貼り直された親を消した");
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(s.record().parent_deleted_at, JSON.parse(recText0).parent_deleted_at, "記録の親を消した時刻は変えない");
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_after_gone_plain_clears_value_then_checks_children", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "after", value: "gone" });
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

for (const value of ["none", "other", "gone"]) {
  test(`cell_after_${value}_reset_usage_error_changes_nothing`, async (t) => {
    const { s, out, recText0, secText0 } = await runCell(t, { rec: "after", value }, RESET);
    assert.equal(out.status, "error", joined(out));
    assert.match(joined(out), /--reset は使えない/);
    assert.equal(s.recordText(), recText0);
    assert.equal(s.secretsText(), secText0);
    assert.equal(s.fake.requests.length, 0);
  });
}

test("cell_after_none_pd_flag_not_needed_checks_children", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "after", value: "none" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), /--parent-deleted は要らない/);
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("cell_after_other_pd_value_decides_deletes_pasted_parent", async (t) => {
  const { s, out, rec0, parentOk } = await runCell(t, { rec: "after", value: "other" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.fake.token(s.Q.id), null);
  assertDeletesAllowed(s, rec0, parentOk, { expectDeletes: 1 });
});

test("cell_after_gone_pd_value_decides_clears_value", async (t) => {
  const { s, out, rec0 } = await runCell(t, { rec: "after", value: "gone" }, PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

// ---- どのマスよりも先に当てる規則 ----

test("gone_value_for_other_parent_does_not_mark_recorded_parent_deleted", async (t) => {
  // 記録は「確」(記録の親 P は生きている)。値は消えた別のトークン(指紋が記録と違う)
  const s = scene(t, { rec: "checked", value: "none" });
  const dead = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"] });
  s.fake.removeToken(dead.id);
  s.setSecrets({ CF_BOOTSTRAP_TOKEN: dead.value, ...Object.fromEntries(ROLES.map((r) => [ENV_KEY[r], s.kids[r].value])) });
  const rec0 = s.record();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /使えない親の値を消した/);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(s.record().parent_deleted_at, null, "記録の親が消えたとは書かない");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("parent_deleted_flag_with_active_value_deletes_instead_of_trusting", async (t) => {
  const s = scene(t, { rec: "checked", value: "same" });
  const rec0 = s.record();
  const out = await s.run(PD);
  assert.equal(out.status, "done", joined(out));
  assert.match(joined(out), PD_IGNORED);
  const deleteAt = s.fake.requests.findIndex((r) => r.route === "deleteToken" && r.id === s.P.id);
  const verifyAfter = s.fake.requests.findIndex((r, i) => i > deleteAt && r.route === "verify" && r.tokenId === s.P.id);
  assert.ok(deleteAt >= 0 && verifyAfter > deleteAt, "DELETE して、消えたことを verify で確かめた");
  assert.ok(s.record().parent_deleted_at);
  assertDeletesAllowed(s, rec0, s.P.id, { expectDeletes: 1 });
});

test("parent_deleted_flag_never_yields_done_while_value_remains", async (t) => {
  // 値があるどのマスでも、--parent-deleted だけでは done にならない(親の DELETE が通らなければ止まる)
  const cases = [
    { rec: "none", value: "same" },
    { rec: "before", value: "same" },
    { rec: "checked", value: "same" },
    { rec: "after", value: "other" },
  ];
  for (const cfg of cases) {
    const s = scene(t, cfg);
    const rec0 = existsSync(s.files.record) ? s.record() : null;
    const parentId = cfg.value === "same" ? s.P.id : s.Q.id;
    s.fake.failNext({ route: "deleteToken", match: (e) => e.id === parentId }, { status: 500 });
    const out = await s.run(PD);
    assert.notEqual(out.status, "done", `${cfg.rec}/${cfg.value}: ${joined(out)}`);
    assert.match(joined(out), PD_IGNORED);
    assert.ok(s.secrets().get("CF_BOOTSTRAP_TOKEN"), `${cfg.rec}: 値は残る`);
    assert.ok(s.fake.token(parentId), `${cfg.rec}: 親は生きている`);
    if (cfg.rec === "checked") assert.equal(s.record().parent_deleted_at, null, "parent_deleted_at を書かない");
    assertDeletesAllowed(s, rec0, parentId);
  }
  // 値が他(消えた別のトークン)でも、値があったので引数を受けない
  const s = scene(t, { rec: "checked", value: "none" });
  const dead = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"] });
  s.fake.removeToken(dead.id);
  s.setSecrets({ CF_BOOTSTRAP_TOKEN: dead.value, ...Object.fromEntries(ROLES.map((r) => [ENV_KEY[r], s.kids[r].value])) });
  const out = await s.run(PD);
  assert.notEqual(out.status, "done", joined(out));
});

test("bad_parent_message_says_delete_and_clear_value", async (t) => {
  for (const rec of ["none", "before", "checked"]) {
    const s = scene(t, { rec, value: "none" });
    const bad = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write", "Zone Read"] });
    s.setSecrets({ CF_BOOTSTRAP_TOKEN: bad.value, ...Object.fromEntries(Object.entries(s.kids).map(([r, k]) => [ENV_KEY[r], k.value])) });
    const recText0 = s.recordText();
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.ok(joined(out).includes(LIST_PLACE));
    assert.match(joined(out), /一覧で消し、deploy-secrets\.env の CF_BOOTSTRAP_TOKEN の値を消す/);
    assert.equal(s.recordText(), recText0, `${rec}: 記録を変えない`);
    assert.equal(s.deleteIds().length, 0);
    assert.equal(posts(s), 0);
  }
});

test("checked_with_foreign_value_and_parent_deleted_does_not_mark_parent_deleted", async (t) => {
  const s = scene(t, { rec: "checked", value: "none" });
  const dead = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"] });
  s.fake.removeToken(dead.id);
  s.setSecrets({ CF_BOOTSTRAP_TOKEN: dead.value, ...Object.fromEntries(ROLES.map((r) => [ENV_KEY[r], s.kids[r].value])) });
  const rec0 = s.record();
  const out = await s.run(PD);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /使えない親の値を消した/);
  assert.match(joined(out), PD_IGNORED);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(s.record().parent_deleted_at, null);
  assert.ok(s.fake.token(s.P.id), "記録の親は生きたまま");
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

test("before_record_non_bootstrap_mode_is_usage_error", async (t) => {
  const s = scene(t, { rec: "before", value: "same", answers: { ...WORKERS_DEV, cloudflare_account: "existing", cloudflare_tokens: "manual-account" } });
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  assert.match(joined(out), /--reset/);
  assert.equal(s.deleteIds().length, 0);
  assert.equal(posts(s), 0);
});

test("cell_child_names_in_human_exit_lines", async (t) => {
  // 人の出口は記録の子の名前も出す
  const { s, out, rec0 } = await runCell(t, { rec: "checked", value: "none" });
  for (const role of ROLES) assert.ok(joined(out).includes(childName(role)));
  assertDeletesAllowed(s, rec0, null, { expectDeletes: 0 });
});

// ---- 値があるときの --parent-deleted は、値で決める(引数で使い方の誤りに落ちない。B130 Task 6c の確かめ) ----

/** ID(16 進 32 文字)と時刻を伏せた文(別の舞台の実行どうしを比べるため) */
const normalized = (out) => out.lines.map((l) => l.replace(/[0-9a-f]{32}/g, "<id>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>"));

for (const rec of ["before", "checked", "after"]) {
  test(`cell_${rec}_gone_pd_same_as_plain_not_usage_error`, async (t) => {
    // 消(記録の親の値が残り、指紋が記録と同じ)× --parent-deleted → 引数なしの 消 と同じ進み方
    // (前では parent_id を外した後に「記録に親が無い」で使い方の誤りに落ちず、引数なしの 無 の出口に入る)
    const plain = await runCell(t, { rec, value: "gone" });
    const pd = await runCell(t, { rec, value: "gone" }, PD);
    assert.notEqual(pd.out.status, "error", joined(pd.out));
    assert.equal(pd.out.status, plain.out.status, joined(pd.out));
    assert.ok(!/--parent-deleted は使えない/.test(joined(pd.out)), "使い方の誤りの文を出さない");
    const pl = normalized(pd.out);
    assert.match(pl[0], PD_IGNORED, "先頭に「使わなかった」");
    assert.deepEqual(pl.slice(1), normalized(plain.out), "ほかの文は引数なしと同じ");
    assert.equal(pd.s.secrets().get("CF_BOOTSTRAP_TOKEN"), "", "値を消した");
    const r = pd.s.record();
    if (rec === "before") {
      assert.equal(r.parent_id, null);
      assert.equal(r.parent_fp, null);
      assert.equal(pd.out.status, "human");
      assert.match(joined(pd.out), /CF_BOOTSTRAP_TOKEN に貼ってから、同じコマンドを打ち直す/, "引数なしの 無 の出口(親を作って貼る)");
    } else {
      assert.equal(pd.out.status, "done");
      assert.ok(r.parent_deleted_at);
    }
    assertDeletesAllowed(pd.s, pd.rec0, null, { expectDeletes: 0 });
  });
}
