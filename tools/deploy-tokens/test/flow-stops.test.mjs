// 止まりうる点ごとのテスト(B130 Task 6b)。前の実行を偽物の失敗(差し込み・fsOps の例外)で止め、同じ記録で execute を打ち直す。
// テスト名の前の stopN は、止まりうる点の表の番号。偽の Cloudflare と一時ディレクトリだけを使い、本物にはつながない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { stage, assertDeletesAllowed, AID, joined, childName, parentName, LIST_PLACE, ROLES, WORKERS_DEV, EXPIRES, AUTH_ERROR, reachStopped, parentDeleteUnknown } from "./flow-stage.mjs";
import { ENV_KEY } from "../lib/spec.mjs";
import { fingerprint } from "../lib/record.mjs";

const RESET = { reset: true };
const PD = { parentDeleted: true };
const recordedIds = (rec) => ROLES.filter((r) => rec.children[r]).map((r) => rec.children[r].id);

// ---- 1: 作る前 ----

test("stop1_before_create_starts_over", async (t) => {
  {
    // 一覧で止まった(記録なし)→ 最初から
    const s = stage(t);
    s.fake.failListPage(1, { status: 500 });
    assert.equal((await s.run()).status, "human");
    assert.equal(existsSync(s.files.record), false);
    const out = await s.run();
    assert.equal(out.status, "done", joined(out));
    assert.equal(s.count("createToken"), 3);
  }
  {
    // 1 本目の作成を断られた(子の無い記録)→ 最初から。消すのは親だけ
    const s = stage(t);
    s.fake.failNext("createToken", { status: 400 });
    assert.equal((await s.run()).status, "human");
    const rec0 = s.record();
    assert.deepEqual(rec0.children, {});
    assert.equal(rec0.pending, null);
    const seq = s.lastSeq();
    const out = await s.run();
    assert.equal(out.status, "done", joined(out));
    assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 1 });
  }
});

// ---- 2: 作成の印 ----

test("stop2_pending_with_unrecorded_same_name_goes_to_human_exit", async (t) => {
  const s = stage(t);
  s.fake.networkErrorNext("createToken");
  assert.equal((await s.run()).status, "error");
  assert.equal(s.record().pending, "setup");
  // POST が遅れて成立し、一覧に見えるようになった
  const late = s.fake.addToken({ name: childName("setup"), permissions: ["Zone Read"] });
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(childName("setup")) && text.includes(late.id), "名前と ID");
  assert.ok(text.includes(LIST_PLACE));
  assert.equal(s.count("createToken", seq), 0);
  assert.equal(s.deleteIds(seq).length, 0);
  assert.ok(s.fake.token(late.id), "同名を消さない");
  assert.equal(s.recordText(), recText0, "印を残す");
});

test("stop2_pending_without_same_name_creates", async (t) => {
  const s = stage(t);
  s.fake.networkErrorNext("createToken"); // サーバーに届かなかった
  assert.equal((await s.run()).status, "error");
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.record().pending, null);
  assert.equal(s.count("createToken", seq), 3);
  assert.equal(s.deleteIds(seq).length, 1, "消すのは親だけ");
  // 印は一覧で解いてから外す(最初の POST の前に、印の無い記録を書く)
  const firstPost = s.fake.requests.findIndex((r) => r.seq > seq && r.route === "createToken");
  const cleared = s.calls.find((x) => x.op === "writeRecord" && x.at >= seq && x.rec.pending === null);
  assert.ok(cleared && cleared.at <= firstPost, "印を外してから作る");
});

for (const [label, inject] of [["drop", (f) => f.dropNext("createToken")], ["truncate", (f) => f.truncateNext("createToken")]]) {
  test(`stop2_post_lost_then_rerun_stops_on_same_name (${label})`, async (t) => {
    // POST はサーバーの側で成立した(応答が落ちた / 200 の後に本文が切れた)→ 印が残る
    // → 打ち直しは印の時刻から 60 秒待って一覧を読み、記録に無い同名で人の出口
    const s = stage(t);
    inject(s.fake);
    assert.equal((await s.run()).status, "error");
    const made = s.fake.tokens().find((x) => x.name === childName("setup"));
    assert.ok(made, "偽物の側では作られている");
    const seq = s.lastSeq();
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.ok(joined(out).includes(made.id));
    const wait = s.sleepLog.find((x) => x.ms === 60000);
    assert.ok(wait, `60 秒待つ: ${JSON.stringify(s.sleepLog)}`);
    const firstList = s.fake.requests.findIndex((r) => r.seq > seq && r.route === "listTokens");
    assert.ok(firstList >= wait.at, "待ってから一覧を読む");
    assert.equal(s.count("createToken", seq), 0);
    assert.equal(s.deleteIds(seq).length, 0);
    assert.equal(s.record().pending, "setup");
  });
}

test("stop2_pending_waits_until_60s_after_pending_at", async (t) => {
  const s = stage(t);
  s.fake.networkErrorNext("createToken");
  assert.equal((await s.run()).status, "error");
  s.fake.advance(20000); // 印の時刻から 20 秒後に打ち直す
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  const waits = s.sleepLog.filter((x) => x.at >= seq);
  assert.equal(waits[0].ms, 40000, `残りの 40 秒だけ待つ: ${JSON.stringify(waits)}`);
  const firstList = s.fake.requests.findIndex((r) => r.seq > seq && r.route === "listTokens");
  assert.ok(firstList >= waits[0].at, "待ってから一覧を読む");
  assert.ok(!s.sleepLog.some((x) => x.ms === 60000), "60 秒まるごとは待たない");
});

// ---- 3〜4: 子の途中・やり直しの削除の途中 ----

test("stop3_half_made_children_are_deleted_by_id_then_recreated", async (t) => {
  const s = stage(t);
  // 作業用は値まで書け、デプロイ用は ID を書いた後・値の前で止まる
  s.failFs("setSecret", (e) => e.key === "CF_DEPLOY_TOKEN" && !e.empty);
  await assert.rejects(() => s.run(), /テストの差し込み/);
  assert.equal(existsSync(s.files.lock), false, "ロックは外れている");
  const rec0 = s.record();
  assert.deepEqual(Object.keys(rec0.children).sort(), ["deploy", "setup"]);
  assert.ok(s.secrets().get("CF_TOKEN"), "作業用の値はある");
  assert.equal(s.secrets().get("CF_DEPLOY_TOKEN"), "", "デプロイ用の値は無い");
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  const dels = s.deleteIds(seq);
  assert.deepEqual(dels.slice(0, 2), [rec0.children.setup.id, rec0.children.deploy.id], "記録の ID だけを消す");
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 3 });
  assert.ok(!/記録に無い同名/.test(joined(out)), "自分の子を同名として止まらない");
  assert.equal(s.count("listTokens", seq), 2, "一覧は始めと済む前の 2 回だけ");
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 17 + 2, "新規の 17 回 + 記録の子の DELETE 2 回");
});

test("stop4_delete_failure_during_restart_creates_nothing", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  s.fake.failNext("deleteToken", { status: 500 });
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.ok(joined(out).includes(rec0.children.setup.id), "消せなかった子の ID");
  assert.equal(s.count("createToken", seq), 0, "作らない");
  assert.deepEqual(recordedIds(s.record()), recordedIds(rec0), "記録の子は残す");
  assert.ok(s.fake.token(s.parent.id), "親は消さない");
  assertDeletesAllowed(s, rec0, null, { fromSeq: seq, expectDeletes: 1 });
});

test("stop4_partial_delete_then_rerun_deletes_only_remaining", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  s.fake.failNext({ route: "deleteToken", match: (e) => e.id === rec0.children.deploy.id }, { status: 500 });
  assert.equal((await s.run()).status, "human");
  const rec1 = s.record();
  assert.deepEqual(Object.keys(rec1.children).sort(), ["deploy", "usage"], "1 本目は記録から外した");
  assert.equal(s.secrets().get("CF_TOKEN"), "", "1 本目の値の行を空にした");
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.deepEqual(s.deleteIds(seq).slice(0, 2), [rec0.children.deploy.id, rec0.children.usage.id], "残りの ID だけ");
  assertDeletesAllowed(s, rec1, s.parent.id, { fromSeq: seq, expectDeletes: 3 });
});

test("stop4_deleted_but_record_not_cleared_then_rerun_treats_missing_as_deleted", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  // DELETE はサーバーで通ったが、応答が落ちた → 記録から外す前に止まる
  s.fake.dropNext({ route: "deleteToken", match: (e) => e.id === rec0.children.setup.id });
  const out1 = await s.run();
  assert.notEqual(out1.status, "done");
  assert.equal(s.fake.token(rec0.children.setup.id), null, "サーバーでは消えている");
  assert.equal(s.record().children.setup.id, rec0.children.setup.id, "記録には残る");
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  const first = s.fake.requests.find((r) => r.seq > seq && r.route === "deleteToken");
  assert.equal(first.id, rec0.children.setup.id, "記録の ID に DELETE を送り直す(もう無い → 消えた扱い)");
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
});

test("restart_never_deletes_ids_outside_record", async (t) => {
  const s = stage(t);
  // 使用状況用の作成を断られ、作業用とデプロイ用だけが記録にある
  s.fake.failNext({ route: "createToken", match: (e) => e.body?.name === childName("usage") }, { status: 400 });
  assert.equal((await s.run()).status, "human");
  const rec0 = s.record();
  assert.deepEqual(Object.keys(rec0.children).sort(), ["deploy", "setup"]);
  const otherTool = s.fake.addToken({ name: "other-tool", permissions: ["Workers Scripts Write"] });
  const stray = s.fake.addToken({ name: "hand-made", permissions: ["Account Analytics Read"] });
  const sec = s.secrets();
  s.setSecrets({ CF_BOOTSTRAP_TOKEN: sec.get("CF_BOOTSTRAP_TOKEN"), CF_TOKEN: sec.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: stray.value });
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /CF_USAGE_TOKEN に値があるが、記録 deploy-tokens\.json に無い/);
  assert.deepEqual(s.deleteIds(seq), [rec0.children.setup.id, rec0.children.deploy.id], "記録の ID だけ");
  assert.ok(s.fake.token(otherTool.id) && s.fake.token(stray.id), "記録に無いトークンは消さない");
  assert.equal(s.secrets().get("CF_USAGE_TOKEN"), stray.value, "記録に無い子の行の値は消さない");
  assert.equal(s.count("createToken", seq), 0);
  assert.ok(!/何も消していない/.test(joined(out)), "記録の子を消した後なので「何も消していない」と書かない");
});

test("restart_with_unrecorded_same_name_deletes_only_record_then_stops", async (t) => {
  // 印の無いやり直しで、一覧に記録に無い同名がある → 記録の子だけを ID で消し、同名は消さずに人の出口(一覧は読み直さない)
  const s = await reachStopped(t);
  const rec0 = s.record();
  const other = s.fake.addToken({ name: childName("deploy"), permissions: ["Workers Scripts Write"] });
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.ok(joined(out).includes(other.id), "同名の ID");
  assert.deepEqual(s.deleteIds(seq), recordedIds(rec0), "記録の ID だけを消す");
  assert.ok(s.fake.token(other.id), "同名は消さない");
  assert.ok(s.fake.token(s.parent.id), "親も消さない");
  assert.equal(s.count("createToken", seq), 0);
  assert.equal(s.count("listTokens", seq), 1, "一覧は読み直さない");
});

// ---- 5: 届き先 ----

test("stop5_reach_failure_keeps_parent_then_rerun_restarts", async (t) => {
  const s = stage(t);
  s.fake.failReach("ruleset", 4, AUTH_ERROR);
  const out1 = await s.run();
  assert.equal(out1.status, "human", joined(out1));
  assert.deepEqual(s.fake.sleeps.filter((x) => x === 5000), [5000, 5000, 5000]);
  assert.equal(s.deleteIds().length, 0, "親の DELETE は 0 回");
  const text = joined(out1);
  assert.ok(text.includes(parentName) && text.includes(EXPIRES), "親と期限");
  assert.match(text, /--reset/);
  const rec0 = s.record();
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  for (const role of ROLES) {
    assert.equal(s.fake.token(rec0.children[role].id), null, `${role} の前の子を消した`);
    assert.notEqual(s.record().children[role].id, rec0.children[role].id, `${role} を作り直した`);
  }
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
  assert.equal(s.count("listTokens", seq), 2);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 17 + 3, "新規 + 記録の子の DELETE 3 回");
});

// ---- 6: 親の DELETE を送った後 ----

test("stop6_delete_lost_then_rerun_gone_completes", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: false });
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.ok(s.record().parent_deleted_at);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(s.deleteIds(seq).length, 0);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 1 + 3, "親の verify 1 + 子の verify 3");
});

test("stop6_rerun_active_deletes_again", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: true });
  const rec0 = s.record();
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.fake.token(s.parent.id), null);
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 1 });
  assert.equal(s.count("listTokens", seq), 0);
  // 親の verify 1・詳細 1・削除 1・削除の後の verify 1・子の verify 3
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 7);
});

test("stop6_rerun_unknown_is_error_and_changes_nothing", async (t) => {
  for (const alive of [true, false]) {
    const s = await parentDeleteUnknown(t, { alive });
    const recText0 = s.recordText();
    const secText0 = s.secretsText();
    s.fake.networkErrorNext("verify");
    const seq = s.lastSeq();
    const out = await s.run();
    assert.equal(out.status, "error", joined(out));
    assert.equal(s.recordText(), recText0);
    assert.equal(s.secretsText(), secText0);
    assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 1, "verify のほかは呼ばない");
  }
});

// ---- 7: 親が消えたと書いた後・値を消す前 ----

async function valueLeftAfterDeleted(t) {
  const s = stage(t);
  s.failFs("clearSecret", (e) => e.key === "CF_BOOTSTRAP_TOKEN");
  await assert.rejects(() => s.run(), /テストの差し込み/);
  const rec = s.record();
  assert.ok(rec.children_checked_at && rec.parent_deleted_at);
  assert.ok(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "値は残る");
  return s;
}

test("stop7_recorded_deleted_value_left_then_rerun_clears_value_and_done", async (t) => {
  const s = await valueLeftAfterDeleted(t);
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(s.deleteIds(seq).length, 0);
  assert.equal(s.count("createToken", seq), 0);
});

test("stop7_rerun_unknown_is_error_and_changes_nothing", async (t) => {
  const s = await valueLeftAfterDeleted(t);
  const recText0 = s.recordText();
  const secText0 = s.secretsText();
  s.fake.networkErrorNext("verify");
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  assert.equal(s.recordText(), recText0);
  assert.equal(s.secretsText(), secText0);
});

// ---- 親の値が無い・違う ----

test("checked_children_without_parent_value_needs_parent_deleted", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: false });
  // 人が一覧で親が消えたのを見て、値を消した
  const sec = s.secrets();
  s.setSecrets({ CF_TOKEN: sec.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec.get("CF_USAGE_TOKEN") });
  const out1 = await s.run();
  assert.equal(out1.status, "human", joined(out1));
  assert.match(joined(out1), /--parent-deleted/);
  assert.equal(s.record().parent_deleted_at, null);
  const out = await s.run(PD);
  assert.equal(out.status, "done", joined(out));
  assert.ok(s.record().parent_deleted_at);
});

test("different_parent_than_record_needs_parent_deleted", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  const P = s.parent;
  const Q = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"], not_before: "2026-11-13T15:00:00Z", expires_on: EXPIRES });
  const sec = () => s.secrets();
  const keep = () => ({ CF_TOKEN: sec().get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec().get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec().get("CF_USAGE_TOKEN") });
  s.setSecrets({ ...keep(), CF_BOOTSTRAP_TOKEN: Q.value });
  const seq = s.lastSeq();
  const out1 = await s.run();
  assert.equal(out1.status, "human", joined(out1));
  assert.ok(joined(out1).includes(P.id) && joined(out1).includes(Q.id));
  assert.equal(s.deleteIds(seq).length, 0);
  // 案内どおり: 一覧で前の親を消し、値を空にして --parent-deleted
  s.fake.removeToken(P.id);
  s.setSecrets(keep());
  const out2 = await s.run(PD);
  assert.equal(out2.status, "human", joined(out2));
  assert.equal(s.record().parent_id, null);
  // 今の親の値を貼り直して打ち直す → 記録の子を消して作り直す
  s.setSecrets({ ...keep(), CF_BOOTSTRAP_TOKEN: Q.value });
  const seq3 = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.record().parent_id, Q.id);
  assertDeletesAllowed(s, rec0, Q.id, { fromSeq: seq3, expectDeletes: 4 });
});

// ---- --reset ----

test("reset_before_done_deletes_record_children_and_parent", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  for (const role of ROLES) {
    assert.equal(s.fake.token(rec0.children[role].id), null);
    assert.equal(s.secrets().get(ENV_KEY[role]), "");
  }
  assert.equal(s.fake.token(s.parent.id), null);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 9, "親の verify 1・詳細 1・一覧 2・DELETE 3・親の削除 1・verify 1");
  assert.deepEqual(out.tokens, []);
});

/** --parent-deleted の出口の文が、--reset の途中なら --reset を付けて打つことを伝えるか(review fix round 1) */
function assertPdExitKeepsResetIntent(out) {
  const text = joined(out);
  assert.match(text, /引数を付けずに打ち直す/, "ふだんは引数なしで打ち直す");
  assert.match(text, /--reset を打って止まった後[^。]*--reset を付けて打つ/, "--reset の途中なら --reset を付けて打つ");
  assert.match(text, /貼り直/, "今の親の値を貼り直してもよい");
}

test("reset_without_parent_via_parent_deleted_then_new_parent_reset_completes", async (t) => {
  // 前 × 無 × --reset → 案内どおり <P> を一覧で消して --parent-deleted → 新しい親を貼って --reset → done
  const s = await reachStopped(t);
  const rec0 = s.record();
  const sec = s.secrets();
  const kids = { CF_TOKEN: sec.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec.get("CF_USAGE_TOKEN") };
  s.setSecrets(kids);
  const out1 = await s.run(RESET);
  assert.equal(out1.status, "human", joined(out1));
  assert.match(joined(out1), /先に --parent-deleted/);
  s.fake.removeToken(s.parent.id);
  const out2 = await s.run(PD);
  assert.equal(out2.status, "human", joined(out2));
  assertPdExitKeepsResetIntent(out2);
  const R = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"], not_before: "2026-11-13T15:00:00Z", expires_on: EXPIRES });
  s.setSecrets({ ...kids, CF_BOOTSTRAP_TOKEN: R.value });
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false, "記録を消した");
  for (const role of ROLES) assert.equal(s.fake.token(rec0.children[role].id), null, `${role} を消した`);
  assert.equal(s.fake.token(R.id), null);
  assertDeletesAllowed(s, rec0, R.id, { fromSeq: seq, expectDeletes: 4 });
  assert.ok(!s.calls.some((x) => x.op === "writeRecord" && x.rec.parent_deleted_at), "記録が「後」にならない");
});

test("reset_other_parent_via_parent_deleted_then_repaste_reset_completes", async (t) => {
  // 前 × 別 × --reset → 案内どおり <P> を消して値を空にし --parent-deleted → 今の親を貼り直して --reset → done
  const s = await reachStopped(t);
  const rec0 = s.record();
  const sec = s.secrets();
  const kids = { CF_TOKEN: sec.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec.get("CF_USAGE_TOKEN") };
  const Q = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"], not_before: "2026-11-13T15:00:00Z", expires_on: EXPIRES });
  s.setSecrets({ ...kids, CF_BOOTSTRAP_TOKEN: Q.value });
  const out1 = await s.run(RESET);
  assert.equal(out1.status, "human", joined(out1));
  s.fake.removeToken(s.parent.id);
  s.setSecrets(kids);
  const out2 = await s.run(PD);
  assert.equal(out2.status, "human", joined(out2));
  assertPdExitKeepsResetIntent(out2);
  s.setSecrets({ ...kids, CF_BOOTSTRAP_TOKEN: Q.value });
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  for (const role of ROLES) assert.equal(s.fake.token(rec0.children[role].id), null);
  assert.equal(s.fake.token(Q.id), null);
  assertDeletesAllowed(s, rec0, Q.id, { fromSeq: seq, expectDeletes: 4 });
  assert.ok(!s.calls.some((x) => x.op === "writeRecord" && x.rec.parent_deleted_at), "記録が「後」にならない");
});

test("reset_without_live_parent_lists_names_and_ids", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  const sec = s.secrets();
  s.setSecrets({ CF_TOKEN: sec.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec.get("CF_USAGE_TOKEN") });
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  for (const role of ROLES) assert.ok(text.includes(rec0.children[role].name) && text.includes(rec0.children[role].id));
  assert.ok(text.includes(s.parent.id));
  assert.equal(s.recordText(), recText0);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 0);
});

test("reset_after_lost_post_preserves_pending_and_stops", async (t) => {
  const s = stage(t);
  s.fake.dropNext("createToken");
  assert.equal((await s.run()).status, "error");
  const made = s.fake.tokens().find((x) => x.name === childName("setup"));
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "human", joined(out));
  assert.ok(joined(out).includes(made.id));
  assert.ok(s.sleepLog.some((x) => x.ms === 60000 && x.at >= seq), "印の時刻から 60 秒待つ");
  assert.equal(s.recordText(), recText0, "記録を残す");
  assert.equal(s.deleteIds(seq).length, 0);
  assert.ok(s.fake.token(s.parent.id));
});

test("reset_incomplete_list_keeps_record", async (t) => {
  const s = await reachStopped(t);
  const recText0 = s.recordText();
  s.fake.failListPage(1, { status: 500 });
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /一覧を読み切れなかった/);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.deleteIds(seq).length, 0);
});

test("reset_after_children_checked_before_parent_delete", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: true });
  const rec0 = s.record();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  for (const role of ROLES) assert.equal(s.fake.token(rec0.children[role].id), null);
  assert.equal(s.fake.token(s.parent.id), null);
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
});

test("reset_after_parent_delete_lost_goes_to_human_exit", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: false });
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /もう消えた/);
  assert.equal(s.recordText(), recText0, "記録を変えない");
  assert.equal(s.deleteIds(seq).length, 0);
});

test("reset_clears_only_recorded_child_values", async (t) => {
  const s = await reachStopped(t, { answers: WORKERS_DEV, zones: [] });
  assert.deepEqual(Object.keys(s.record().children).sort(), ["deploy", "usage"]);
  const sec = s.secrets();
  s.setSecrets({ CF_BOOTSTRAP_TOKEN: sec.get("CF_BOOTSTRAP_TOKEN"), CF_TOKEN: "keep-this-value", CF_DEPLOY_TOKEN: sec.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec.get("CF_USAGE_TOKEN") });
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(s.secrets().get("CF_TOKEN"), "keep-this-value", "記録に無い子の行は消さない");
  assert.equal(s.secrets().get("CF_DEPLOY_TOKEN"), "");
  assert.equal(s.secrets().get("CF_USAGE_TOKEN"), "");
});

test("checked_reset_exit_never_leads_to_done_with_children", async (t) => {
  for (const variant of ["other", "none"]) {
    const s = await parentDeleteUnknown(t, { alive: true });
    const rec0 = s.record();
    const sec0 = s.secrets();
    const kids = { CF_TOKEN: sec0.get("CF_TOKEN"), CF_DEPLOY_TOKEN: sec0.get("CF_DEPLOY_TOKEN"), CF_USAGE_TOKEN: sec0.get("CF_USAGE_TOKEN") };
    let Q = null;
    if (variant === "other") {
      Q = s.fake.addToken({ name: parentName, permissions: ["Account API Tokens Write"], not_before: "2026-11-13T15:00:00Z", expires_on: EXPIRES });
      s.setSecrets({ ...kids, CF_BOOTSTRAP_TOKEN: Q.value });
    } else {
      s.setSecrets(kids);
    }
    const out1 = await s.run(RESET);
    assert.equal(out1.status, "human", `${variant}: ${joined(out1)}`);
    assert.match(joined(out1), /--parent-deleted は使わない/);
    // 案内どおりの人の操作: 記録の子・記録の親(・今の親)を一覧で消し、エージェントが記録を消して子の行(と親の値)を空にする
    for (const role of ROLES) s.fake.removeToken(rec0.children[role].id);
    s.fake.removeToken(s.parent.id);
    if (Q) s.fake.removeToken(Q.id);
    unlinkSync(s.files.record);
    s.setSecrets({});
    const out = await s.run();
    assert.notEqual(out.status, "done", `${variant}: 子を残した done にならない`);
    assert.ok(!existsSync(s.files.record) || !s.record().parent_deleted_at, `${variant}: 記録が「後」にならない`);
    assert.ok(!s.calls.some((x) => x.op === "writeRecord" && x.rec.parent_deleted_at), `${variant}: parent_deleted_at を書かない`);
  }
});

test("restart_stopped_after_value_cleared_before_record_update_recovers", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  // 子の値の行を空にした直後の、記録から外す書き込みで止める
  s.failFs("writeRecord", (_e, prev) => prev && prev.op === "clearSecret" && prev.key === "CF_TOKEN");
  await assert.rejects(() => s.run(), /テストの差し込み/);
  assert.equal(s.secrets().get("CF_TOKEN"), "");
  assert.equal(s.record().children.setup.id, rec0.children.setup.id, "記録には残る");
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.ok(!/記録 deploy-tokens\.json に無い/.test(joined(out)), "値の取り込みの止まり方に入らない");
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
});

test("reset_stopped_after_value_cleared_before_record_update_recovers", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  s.failFs("writeRecord", (_e, prev) => prev && prev.op === "clearSecret" && prev.key === "CF_TOKEN");
  await assert.rejects(() => s.run(RESET), /テストの差し込み/);
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
});

// ---- 遅れて成立した POST ----

test("late_post_found_by_final_list_goes_to_human_exit", async (t) => {
  const s = stage(t);
  let late = null;
  s.beforeList(2, () => { late = s.fake.addToken({ name: childName("deploy"), permissions: ["Workers Scripts Write"] }); });
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(late.id), "名前と ID");
  assert.ok(text.includes(parentName) && text.includes(EXPIRES), "親が生きていることと期限");
  assert.equal(s.deleteIds().length, 0, "親は消さない");
  assert.ok(s.fake.token(late.id));
  assert.equal(s.record().children_checked_at, null);
});

test("reset_final_list_finds_late_post_and_keeps_parent", async (t) => {
  const s = await reachStopped(t);
  const rec0 = s.record();
  let late = null;
  s.beforeList(2, () => { late = s.fake.addToken({ name: childName("usage"), permissions: ["Account Analytics Read"] }); });
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "human", joined(out));
  assert.ok(joined(out).includes(late.id));
  assert.match(joined(out), /--reset を付けて打ち直す/);
  assert.ok(s.fake.token(s.parent.id), "親はまだ消さない");
  assert.ok(existsSync(s.files.record), "記録は残す");
  assert.deepEqual(s.record().children, {}, "記録の子は消した");
  assertDeletesAllowed(s, rec0, null, { fromSeq: seq, expectDeletes: 3 });
});

// ---- 8: --reset の途中 ----

test("stop8_reset_interrupted_after_children_deleted_then_rerun_deletes_parent_and_record", async (t) => {
  const s = await parentDeleteUnknown(t, { alive: true }); // 記録は「確」
  const rec0 = s.record();
  const base = s.count("listTokens");
  s.fake.inject({ route: "listTokens", match: () => s.fake.count("listTokens") === base + 2, action: { type: "respond", status: 500 } });
  const out1 = await s.run(RESET);
  assert.equal(out1.status, "human", joined(out1));
  const rec1 = s.record();
  assert.equal(rec1.children_checked_at, null, "記録は「前」になっている");
  assert.deepEqual(rec1.children, {});
  assert.equal(rec1.parent_id, s.parent.id);
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  assert.equal(s.fake.token(s.parent.id), null);
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 1 });
});

test("stop8_reset_with_no_children_unchecks_before_parent_delete", async (t) => {
  // 子が 0 本の「確」の記録でも、親の DELETE の前に children_checked_at を外す(止まっても記録が「前」で、打ち直しの --reset が通る)
  const s = stage(t);
  const rec = { version: 1, account_id: AID, parent_id: s.parent.id, parent_fp: fingerprint(s.parent.value), pending: null, pending_at: null, children: {}, children_checked_at: "2026-11-14T05:10:00Z", parent_deleted_at: null };
  s.writeRecordFile(rec);
  s.failFs("removeRecord");
  await assert.rejects(() => s.run(RESET), /テストの差し込み/);
  const rec1 = s.record();
  assert.equal(rec1.children_checked_at, null, "記録は「前」");
  assert.equal(rec1.parent_id, null);
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
});

test("stop8_reset_interrupted_after_parent_deleted_then_rerun_clears_record", async (t) => {
  const s = await reachStopped(t);
  s.failFs("removeRecord");
  await assert.rejects(() => s.run(RESET), /テストの差し込み/);
  const rec1 = s.record();
  assert.equal(rec1.parent_id, null);
  assert.equal(rec1.parent_fp, null);
  assert.equal(rec1.parent_deleted_at, null, "--reset は parent_deleted_at を書かない");
  assert.deepEqual(rec1.children, {});
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "done", joined(out));
  assert.equal(existsSync(s.files.record), false);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 0, "記録を消すだけ");
});
