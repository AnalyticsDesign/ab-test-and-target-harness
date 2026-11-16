// 済んだ後の確かめ(checkChildrenAfter)と、経路ごとの往復の回数のテスト(B130 Task 6c)。
// 済んだ後の確かめは何も作らず、子を消さない(後ろの手順で使った後の子を消さないため。Review Focus 1・4)。
// 文: 値のファイルが無い(D1)・子の値が無い / 使えない(Q638)・作業用の期限切れ(D2)・人が作り直した値(D7)。
// 偽の Cloudflare と一時ディレクトリだけを使い、本物にはつながない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import {
  stage, scene, assertDeletesAllowed, joined, childName, LIST_PLACE, ROLES, WORKERS_DEV, AUTH_ERROR, ZID,
  reachStopped, parentDeleteUnknown,
} from "./flow-stage.mjs";
import { createCf } from "../lib/cf.mjs";
import { checkChildrenAfter, DEFAULT_FS_OPS } from "../lib/flow.mjs";
import { PERMISSIONS } from "../lib/spec.mjs";

const RESET = { reset: true };
const HOUR = 60 * 60 * 1000;

// 済んだ後の確かめの文(どれかが変わったら、ここを直す)
const NOTHING_IF_DONE = /導入が済んでいれば、何もしなくてよい/;
const MISSING_USED = /後ろの手順でこの値を使った後なら、何もしなくてよい/;
const MISSING_DIRECT = /まだなら、その 1 本を人が直接作り\(救済の手順と同じ\)、/;
const MISSING_DELETE = new RegExp(`${LIST_PLACE.replace(/[()]/g, "\\$&")}で、Name\\(名前\\)が記録の子と同じトークン\\(Created\\(作成日\\)が導入のころのもの\\)を消す`);
const RECREATED = /案内どおり人が作り直した後なら、このままでよい。このスクリプトの確かめは済んでいる。/;
const EXPIRED_SETUP = /導入の途中で作業用が切れたら、作業用 1 本を人が直接作る\(docs\/deploy\.md の 0\.5 の最後の段落の手順\)/;

/** 後ろの確かめで止まったときに、何も作らず・子を消さず・記録を変えていないこと */
function assertNothingChanged(s, recText0, { fromSeq = 0 } = {}) {
  assert.equal(s.count("createToken", fromSeq), 0, "作らない");
  assert.equal(s.count("deleteToken", fromSeq), 0, "消さない");
  assert.equal(s.recordText(), recText0, "記録を変えない");
}

/** 済んだ記録(後)と、子の値が全部そろった値のファイルを作る(親の値は空) */
function doneScene(t, opts = {}) {
  const s = scene(t, { rec: "after", value: "none", ...opts });
  return { ...s, recText0: s.recordText(), secText0: s.secretsText() };
}

/** 偽物に、人が画面で作り直した子と同じ形のトークンを置く */
function personMade(s, role) {
  return s.fake.addToken({ name: childName(role), permissions: PERMISSIONS[role].map(([n]) => n), zoneIds: role === "setup" ? [ZID] : [] });
}

/** 経路の要求の数を宛先ごとに数える(seq より後) */
function routeCounts(s, fromSeq = 0) {
  const out = {};
  for (const r of s.fake.requests) if (r.seq > fromSeq) out[r.route] = (out[r.route] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ---- 済んだ後の打ち直し ----

test("rerun_after_done_needs_no_parent", async (t) => {
  // Review Focus 4: 完了の後に打ち直す → 親を求めず、何も作らず、何も消さない
  const s = stage(t);
  assert.equal((await s.run()).status, "done");
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  assert.ok(!/CF_BOOTSTRAP_TOKEN に貼/.test(joined(out)), "親を求めない");
  assert.deepEqual(routeCounts(s, seq), { verify: 3 }, "子の verify だけ");
  assertNothingChanged(s, recText0, { fromSeq: seq });
  assert.equal(out.tokens.length, 3);
});

test("rerun_after_done_without_secrets_file_stops", async (t) => {
  // D1: deploy-secrets.env を消した後の打ち直し → done とは言わない
  const s = stage(t);
  assert.equal((await s.run()).status, "done");
  unlinkSync(s.files.secrets);
  const recText0 = s.recordText();
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /deploy-secrets\.env が無い/);
  assert.match(joined(out), NOTHING_IF_DONE);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 0, "API を呼ばない");
  assertNothingChanged(s, recText0, { fromSeq: seq });
  assert.equal(existsSync(s.files.secrets), false, "値のファイルを作らない");
});

test("done_with_pasted_parent_deletes_it_then_checks_children", async (t) => {
  // 子の値がそろっていれば、貼り直された親を消して done
  {
    const s = doneScene(t, { value: "other" });
    const rec0 = s.record();
    const out = await s.run();
    assert.equal(out.status, "done", joined(out));
    assert.equal(s.fake.token(s.Q.id), null, "貼り直された親を消した");
    assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
    assertDeletesAllowed(s, rec0, s.Q.id, { expectDeletes: 1 });
    assert.equal(s.count("createToken"), 0);
  }
  // 子の値が欠けていれば、親を消したうえで human(子は消さない)
  {
    const s = doneScene(t, { value: "other" });
    const rec0 = s.record();
    s.setSecrets({ CF_BOOTSTRAP_TOKEN: s.Q.value, CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: "", CF_USAGE_TOKEN: s.kids.usage.value });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.equal(s.fake.token(s.Q.id), null, "親は消した");
    assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "", "親の値は消した");
    assert.equal(out.parent.state, "deleted");
    assert.ok(joined(out).includes(childName("deploy")) && joined(out).includes(rec0.children.deploy.id), "欠けた子の名前と ID");
    assert.match(joined(out), MISSING_USED);
    assertDeletesAllowed(s, rec0, s.Q.id, { expectDeletes: 1 });
    for (const role of ROLES) assert.ok(s.fake.token(rec0.children[role].id), `${role} は消さない`);
    assert.equal(s.count("createToken"), 0);
  }
});

test("done_with_missing_child_value_stops_without_delete", async (t) => {
  // Q638・Review Focus 1: エディタで開いたままの値のファイルが後から保存され、子の値が消えた
  {
    const s = doneScene(t);
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: "", CF_USAGE_TOKEN: s.kids.usage.value });
    const secText = s.secretsText();
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    const text = joined(out);
    assert.ok(text.includes(`デプロイ用 ${childName("deploy")}(ID ${s.kids.deploy.id})`), `役割の名前と ID: ${text}`);
    assert.match(text, /CF_DEPLOY_TOKEN に値が無い/);
    assert.match(text, MISSING_USED);
    assert.match(text, MISSING_DIRECT);
    assert.match(text, MISSING_DELETE);
    assert.ok(!text.includes(s.kids.setup.id) && !text.includes(s.kids.usage.id), "問題の無い子は出さない");
    assert.ok(!RECREATED.test(text));
    assertNothingChanged(s, s.recText0);
    assert.equal(s.secretsText(), secText, "値のファイルを変えない");
    assert.deepEqual(routeCounts(s), { verify: 2 }, "値のある子の verify だけ");
    for (const v of [s.kids.setup.value, s.kids.deploy.value, s.kids.usage.value]) assert.ok(!JSON.stringify(out).includes(v), "値を出さない");
  }
  // 値はあるが、そのトークンが消えている(active でない)→ 同じ文
  {
    const s = doneScene(t);
    s.fake.removeToken(s.kids.usage.id);
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    const text = joined(out);
    assert.ok(text.includes(`使用状況用 ${childName("usage")}(ID ${s.kids.usage.id})`), text);
    assert.match(text, /CF_USAGE_TOKEN の値の確かめ\(verify\)が gone/);
    assert.match(text, MISSING_USED);
    assert.match(text, MISSING_DIRECT);
    assertNothingChanged(s, s.recText0);
  }
  // 開始前(not_yet_valid)も active とみなさない
  {
    const s = doneScene(t);
    const later = s.fake.addToken({ name: childName("deploy"), permissions: PERMISSIONS.deploy.map(([n]) => n), not_before: "2026-11-20T00:00:00Z" });
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: later.value, CF_USAGE_TOKEN: s.kids.usage.value });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.match(joined(out), /not_yet_valid/);
    assert.match(joined(out), MISSING_DIRECT, "active でなく ID も違う値は、値が無いときと同じ文");
    assert.ok(!RECREATED.test(joined(out)));
    assertNothingChanged(s, s.recText0);
  }
  // 記録の ID のトークンそのものが開始前(not_yet_valid)でも、active とみなさない
  {
    const s = doneScene(t);
    const later = s.fake.addToken({ name: childName("deploy"), permissions: PERMISSIONS.deploy.map(([n]) => n), not_before: "2026-11-20T00:00:00Z" });
    const rec = s.record();
    rec.children.deploy.id = later.id;
    s.writeRecordFile(rec);
    const recText0 = s.recordText();
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: later.value, CF_USAGE_TOKEN: s.kids.usage.value });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.ok(joined(out).includes(later.id));
    assert.match(joined(out), /not_yet_valid/);
    assert.match(joined(out), MISSING_DIRECT);
    assertNothingChanged(s, recText0);
  }
});

test("done_with_person_recreated_value_says_no_action_needed", async (t) => {
  // D7: 案内どおり人がデプロイ用を作り直し、記録の ID のトークンを消した後
  {
    const s = doneScene(t);
    const made = personMade(s, "deploy");
    s.fake.removeToken(s.kids.deploy.id);
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: made.value, CF_USAGE_TOKEN: s.kids.usage.value });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    const text = joined(out);
    assert.ok(text.includes(`デプロイ用 ${childName("deploy")}(ID ${s.kids.deploy.id})`), text);
    assert.ok(text.includes(made.id), "値のトークンの ID");
    assert.match(text, RECREATED);
    assert.ok(!MISSING_DIRECT.test(text), "作り直しを求めない");
    assertNothingChanged(s, s.recText0);
    assert.ok(s.fake.token(made.id), "人が作ったトークンを消さない");
  }
  // active でなく ID も違う値(人が作った値も消えている)→ 値が無いときと同じ文
  {
    const s = doneScene(t);
    const made = personMade(s, "deploy");
    s.fake.removeToken(made.id);
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: made.value, CF_USAGE_TOKEN: s.kids.usage.value });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.match(joined(out), MISSING_USED);
    assert.match(joined(out), MISSING_DIRECT);
    assert.ok(!RECREATED.test(joined(out)));
    assertNothingChanged(s, s.recText0);
  }
});

test("done_with_mixed_problems_lists_each_child_with_its_own_text", async (t) => {
  // 1 本は値が欠け、1 本は人が作り直した → どちらの文も出し、human
  const s = doneScene(t);
  const made = personMade(s, "usage");
  s.fake.removeToken(s.kids.usage.id);
  s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: "", CF_USAGE_TOKEN: made.value });
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.kids.deploy.id) && text.includes(s.kids.usage.id), text);
  assert.match(text, MISSING_DIRECT);
  assert.match(text, RECREATED);
  assertNothingChanged(s, s.recText0);
});

test("done_with_expired_setup_points_to_direct_creation", async (t) => {
  // D2: 作業用は作ってから 24 時間で切れる。切れた後の打ち直し
  const s = doneScene(t);
  s.fake.advance(25 * HOUR);
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  const text = joined(out);
  assert.ok(text.includes(`作業用 ${childName("setup")}(ID ${s.kids.setup.id})`), text);
  assert.match(text, /期限が切れている/);
  assert.match(text, EXPIRED_SETUP);
  assert.match(text, NOTHING_IF_DONE);
  assert.ok(!MISSING_DIRECT.test(text), "ほかの子の文を出さない");
  assert.ok(!text.includes(s.kids.deploy.id) && !text.includes(s.kids.usage.id), "期限の無い子は通る");
  assertNothingChanged(s, s.recText0);

  // 期限の切れた別の ID の値(記録の作業用ではない)は、期限切れの文ではなく、値が使えないときの文
  {
    const s2 = doneScene(t);
    const stale = s2.fake.addToken({ name: childName("setup"), permissions: PERMISSIONS.setup.map(([n]) => n), zoneIds: [ZID], expires_on: "2026-11-14T00:00:00Z" });
    s2.setSecrets({ CF_TOKEN: stale.value, CF_DEPLOY_TOKEN: s2.kids.deploy.value, CF_USAGE_TOKEN: s2.kids.usage.value });
    const out2 = await s2.run();
    assert.equal(out2.status, "human", joined(out2));
    assert.match(joined(out2), MISSING_DIRECT);
    assert.ok(!EXPIRED_SETUP.test(joined(out2)), "記録の作業用が切れたとは言わない");
    assertNothingChanged(s2, s2.recText0);
  }
});

test("done_with_unverifiable_child_is_error_and_changes_nothing", async (t) => {
  // 429・通信の失敗で確かめられない子を、「使えない」として作り直させない
  const s = doneScene(t);
  s.fake.inject({ route: "verify", match: (e) => e.tokenId === s.kids.deploy.id, action: { type: "networkError" } });
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  const text = joined(out);
  assert.ok(text.includes(s.kids.deploy.id), text);
  assert.match(text, /確かめられなかった/);
  assert.match(text, /少し待ってから同じコマンドを打ち直す/);
  assert.ok(!MISSING_DIRECT.test(text), "作り直しを求めない");
  assert.ok(!/何も変えていない/.test(text), "親を消した後の経路もあるので「何も変えていない」とは言わない");
  assertNothingChanged(s, s.recText0);
});

test("unverifiable_child_after_parent_delete_is_error_then_rerun_done", async (t) => {
  // 止まりうる点 6 の打ち直しで親を消した直後、済んだ後の確かめで子の verify が通信の失敗 → error(親を消したことは残る)
  const s = await parentDeleteUnknown(t, { alive: true });
  const rec0 = s.record();
  const deployId = rec0.children.deploy.id;
  s.fake.inject({ route: "verify", match: (e) => e.tokenId === deployId, action: { type: "networkError" } });
  const seq = s.lastSeq();
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  assert.ok(joined(out).includes(deployId));
  assert.ok(!/何も変えていない/.test(joined(out)));
  assert.equal(s.fake.token(s.parent.id), null, "親は消えた");
  assert.ok(s.record().parent_deleted_at, "親を消した時刻は書いた");
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(out.parent.state, "deleted");
  assert.equal(s.count("createToken", seq), 0);
  assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 1 });
  for (const role of ROLES) assert.ok(s.fake.token(rec0.children[role].id), `${role} は消さない`);

  // 少し待って打ち直す → 子の verify だけで done
  const seq2 = s.lastSeq();
  const again = await s.run();
  assert.equal(again.status, "done", joined(again));
  assert.deepEqual(routeCounts(s, seq2), { verify: 3 });
});

test("after_check_with_parent_value_left_is_human", async (t) => {
  // 済んだ後の確かめの 1: CF_BOOTSTRAP_TOKEN に値が残っていれば、子を見る前に止まる(済みを出さない)
  const s = doneScene(t, { value: "other" });
  const ctx = { cf: createCf({ fetch: s.fake.fetch, sleep: s.fake.sleep, accountId: s.record().account_id, now: s.fake.now }), files: s.files, fsOps: DEFAULT_FS_OPS, now: s.fake.now };
  const r = await checkChildrenAfter(ctx, s.record());
  assert.equal(r.status, "human", r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /CF_BOOTSTRAP_TOKEN に値が残っている/);
  assert.match(r.lines.join("\n"), /済んだとは言わない/);
  assert.equal(s.fake.requests.length, 0, "子を確かめない");
  assert.ok(!r.lines.join("\n").includes(s.Q.value), "値を出さない");
});

test("reset_after_done_is_usage_error", async (t) => {
  // D4: 済んだ後の --reset は使い方の誤り。何も変えない
  const s = stage(t);
  assert.equal((await s.run()).status, "done");
  const recText0 = s.recordText();
  const secText0 = s.secretsText();
  const seq = s.lastSeq();
  const out = await s.run(RESET);
  assert.equal(out.status, "error", joined(out));
  assert.match(joined(out), /--reset は使えない/);
  assert.equal(s.fake.requests.filter((r) => r.seq > seq).length, 0);
  assert.equal(s.recordText(), recText0);
  assert.equal(s.secretsText(), secText0);
});

// ---- 経路ごとの往復の回数(性能の見積もりの一覧の正) ----

test("request_counts_by_path", async (t) => {
  // 記号: C = 作る子の数、L = トークンの一覧のページの数(ここでは 1)。宛先ごとの数で見る(合計だけでは、余分な POST・DELETE を見落とす)
  const paths = [];
  const check = (name, s, fromSeq, want, total) => {
    const got = routeCounts(s, fromSeq);
    assert.deepEqual(got, want, `${name}: ${JSON.stringify(got)}`);
    const sum = Object.values(got).reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `${name}: 合計`);
    paths.push([name, sum]);
  };

  // 新規(route): 親の verify 1・詳細 1・権限 1・ゾーン 1・一覧 2L・作成 3・子の verify 3・届き先 3・親の削除 1・削除の後の verify 1
  {
    const s = stage(t);
    assert.equal((await s.run()).status, "done");
    check("新規(route)", s, 0, { createToken: 3, deleteToken: 1, graphql: 1, listTokens: 2, permissionGroups: 1, ruleset: 1, tokenDetails: 1, verify: 5, workerScripts: 1, zones: 1 }, 17);
    assertDeletesAllowed(s, null, s.parent.id, { expectDeletes: 1 });

    // 済んだ後の打ち直し: 子の verify C だけ
    const seq = s.lastSeq();
    assert.equal((await s.run()).status, "done");
    check("済んだ後の打ち直し", s, seq, { verify: 3 }, 3);
  }

  // 新規(workers-dev): 作業用なし・ゾーンを引かない
  {
    const s = stage(t, { answers: WORKERS_DEV, zones: [] });
    assert.equal((await s.run()).status, "done");
    check("新規(workers-dev)", s, 0, { createToken: 2, deleteToken: 1, graphql: 1, listTokens: 2, permissionGroups: 1, tokenDetails: 1, verify: 4, workerScripts: 1 }, 13);
  }

  // 届き先が 1 回失敗して 2 回目で通る新規(route): 届かなかった届き先だけを呼び直す(+ 1)
  {
    const s = stage(t);
    s.fake.failReach("ruleset", 1, AUTH_ERROR);
    assert.equal((await s.run()).status, "done");
    check("届き先が 1 回失敗", s, 0, { createToken: 3, deleteToken: 1, graphql: 1, listTokens: 2, permissionGroups: 1, ruleset: 2, tokenDetails: 1, verify: 5, workerScripts: 1, zones: 1 }, 18);
    assert.deepEqual(s.sleepLog.map((x) => x.ms), [5000, 5000], "確かめ直しの 5 秒 1 回と、親の削除の後の 5 秒");
  }

  // 止まりうる点 3 からの打ち直し: 新規 + 記録の子の数の DELETE。一覧は新規と同じ 2L(作る前に読み直さない)
  {
    const s = stage(t);
    s.failFs("setSecret", (e) => e.key === "CF_DEPLOY_TOKEN" && !e.empty);
    await assert.rejects(() => s.run(), /テストの差し込み/);
    const rec0 = s.record();
    const seq = s.lastSeq();
    assert.equal((await s.run()).status, "done");
    check("止まりうる点 3 からの打ち直し", s, seq, { createToken: 3, deleteToken: 2 + 1, graphql: 1, listTokens: 2, permissionGroups: 1, ruleset: 1, tokenDetails: 1, verify: 5, workerScripts: 1, zones: 1 }, 17 + 2);
    assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 3 });
  }

  // --reset(届き先で止まった後): 親の verify 1・詳細 1・一覧 2L・記録の子の DELETE 3・親の削除 1・削除の後の verify 1
  {
    const s = await reachStopped(t);
    const rec0 = s.record();
    const seq = s.lastSeq();
    assert.equal((await s.run(RESET)).status, "done");
    check("--reset", s, seq, { deleteToken: 3 + 1, listTokens: 2, tokenDetails: 1, verify: 2 }, 9);
    assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 4 });
  }

  // 止まりうる点 6 から、親が生きていた打ち直し: 親の verify 1・詳細 1・削除 1・削除の後の verify 1・子の verify C
  {
    const s = await parentDeleteUnknown(t, { alive: true });
    const rec0 = s.record();
    const seq = s.lastSeq();
    assert.equal((await s.run()).status, "done");
    check("止まりうる点 6(親が生きていた)", s, seq, { deleteToken: 1, tokenDetails: 1, verify: 1 + 1 + 3 }, 7);
    assertDeletesAllowed(s, rec0, s.parent.id, { fromSeq: seq, expectDeletes: 1 });
  }

  // 止まりうる点 6 から、親が消えていた打ち直し: 親の verify 1・子の verify C
  {
    const s = await parentDeleteUnknown(t, { alive: false });
    const seq = s.lastSeq();
    assert.equal((await s.run()).status, "done");
    check("止まりうる点 6(親が消えていた)", s, seq, { verify: 1 + 3 }, 4);
  }

  // 済んだ後に親が貼り直されていた: 親の verify 1・詳細 1・削除 1・削除の後の verify 1・子の verify C
  {
    const s = doneScene(t, { value: "other" });
    const rec0 = s.record();
    assert.equal((await s.run()).status, "done");
    check("済んだ後に貼り直された親", s, 0, { deleteToken: 1, tokenDetails: 1, verify: 1 + 1 + 3 }, 7);
    assertDeletesAllowed(s, rec0, s.Q.id, { expectDeletes: 1 });
  }

  // 済んだ後の確かめで止まる経路も、作らない・消さない(値の無い子の verify は送らない)
  {
    const s = doneScene(t);
    s.setSecrets({ CF_TOKEN: s.kids.setup.value, CF_DEPLOY_TOKEN: "", CF_USAGE_TOKEN: s.kids.usage.value });
    assert.equal((await s.run()).status, "human");
    check("済んだ後に子の値が欠けた", s, 0, { verify: 2 }, 2);
  }

  t.diagnostic(paths.map(([n, c]) => `${n}: ${c}`).join(" / "));
});
