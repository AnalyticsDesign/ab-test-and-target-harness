// 一本道の流れの新規の導入のテスト(B130 Task 6a)。偽の Cloudflare(fake-cf.mjs)と一時ディレクトリだけを使う。
// 本物の Cloudflare にはつながない。値は偽物が作る短い偽の値だけ。
// 判定は verify の state と「ruleset の entrypoint は 10003 だけ通す」で組み、偽物の未確認の既定(使えない値で
// verify 以外 → 401/1000、権限の不足 → 403/10000)は前提にしない(届かない応答は差し込みで明示する)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createCf } from "../lib/cf.mjs";
import { reachCheck, DEFAULT_FS_OPS } from "../lib/flow.mjs";
import { tokenName, ENV_KEY } from "../lib/spec.mjs";
import { fingerprint } from "../lib/record.mjs";
import { stage as baseStage, AID, IDENT, ZID, LIST_PLACE, ROUTE, WORKERS_DEV, EXPIRES, childName, joined } from "./flow-stage.mjs";

const OTHER_AID = "fedcba9876543210fedcba9876543210";
const ZID_SUB = "ccccccccccccccccdddddddddddddddd";

/**
 * 1 つのテストの舞台。flow-stage.mjs の stage(偽物・一時ディレクトリ・答え・親トークン・fsOps の呼ばれた順の記録)を使い、
 * run(over) の形だけをこのファイルの呼び方に合わせる(over は execute の ctx を上書きする。args も over で渡す)。
 * run() は呼ぶたびに createCf を作り直す(verify の使い回しは 1 回の実行の中だけのため)
 */
function stage(t, opts) {
  const s = baseStage(t, opts);
  const runArgs = s.run;
  s.run = (over = {}) => runArgs({}, over);
  return s;
}

const posts = (fake) => fake.count("createToken");
const deletes = (fake) => fake.count("deleteToken");

/** 偽物の作成の応答(本物の作成はしない)。権限の名前を自由に書ける */
function createResponse({ id, name, value, permissionNames, resources }) {
  return {
    status: 200,
    body: {
      success: true, errors: [], messages: [],
      result: {
        id, name, status: "active", issued_on: "2026-11-14T05:52:39Z", modified_on: "2026-11-14T05:52:39Z", last_used_on: null,
        value, token_prefix: "cfat", token_suffix: value.slice(-4), creator_email_at_creation: "creator@example.com",
        policies: [{ id: "policy1", effect: "allow", resources, permission_groups: permissionNames.map((n, i) => ({ id: `${i}`.padStart(32, "e"), name: n })) }],
      },
    },
  };
}

// ---- 新規の一本道 ----

test("new_route_creates_three_children_ids_before_values", async (t) => {
  const s = stage(t);
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));

  const rec = s.record();
  const sec = s.secrets();
  assert.equal(rec.account_id, AID);
  assert.equal(rec.parent_id, s.parent.id);
  assert.equal(rec.parent_fp, fingerprint(s.parent.value));
  assert.equal(rec.pending, null);
  assert.ok(rec.children_checked_at && rec.parent_deleted_at);
  for (const role of ["setup", "deploy", "usage"]) {
    const c = rec.children[role];
    assert.equal(c.name, childName(role));
    assert.match(c.id, /^[0-9a-f]{32}$/);
    assert.ok(c.created_at, `${role} の created_at`);
    const value = sec.get(ENV_KEY[role]);
    assert.ok(value, `${role} の値が書かれた`);
    assert.equal(s.fake.tokenByValue(value).id, c.id, `${role} の値は記録の ID のトークン`);
    // 記録の書き込み(その子の ID が入ったもの)が、値の書き込みより先
    const idAt = s.calls.findIndex((x) => x.op === "writeRecord" && x.rec.children?.[role]?.id === c.id);
    const valueAt = s.calls.findIndex((x) => x.op === "setSecret" && x.key === ENV_KEY[role] && !x.empty);
    assert.ok(idAt >= 0 && valueAt > idAt, `${role}: ID(${idAt})→ 値(${valueAt})の順`);
  }
  assert.ok(rec.children.setup.expires_on, "作業用には期限がある");
  assert.equal(rec.children.deploy.expires_on, null);
  // 作業用はゾーン単位
  const setupTok = s.fake.token(rec.children.setup.id);
  assert.deepEqual(Object.keys(setupTok.policies[0].resources), [`com.cloudflare.api.account.zone.${ZID}`]);

  // 親は消え、値は空
  assert.equal(s.fake.token(s.parent.id), null);
  assert.equal(sec.get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(sec.get("GOOGLE_CLIENT_ID"), "abc", "ほかの行はそのまま");
  const deletedAt = s.calls.findIndex((x) => x.op === "writeRecord" && x.rec.parent_deleted_at);
  const clearedAt = s.calls.findIndex((x) => x.op === "clearSecret" && x.key === "CF_BOOTSTRAP_TOKEN");
  assert.ok(deletedAt >= 0 && clearedAt > deletedAt, "parent_deleted_at を書いてから親の値を消す");

  assert.deepEqual(out.tokens.map((x) => x.role), ["setup", "deploy", "usage"]);
  assert.deepEqual(Object.keys(out.tokens[0]).sort(), ["expires_on", "id", "name", "role"]);
  assert.deepEqual(out.parent, { name: tokenName("parent", IDENT), id: s.parent.id, state: "deleted" });
  assert.equal(s.oauthCalls, 1);
  assert.equal(s.fake.requests.length, 17, "ふつうの route は 17 回");
  assert.equal(s.fake.count("verify"), 5, "親の verify 2(始めと削除の後)+ 子の verify 3(済んだ後の確かめは使い回し)");
  assert.equal(existsSync(s.files.lock), false, "ロックを外した");
});

test("new_workers_dev_creates_two_children", async (t) => {
  const s = stage(t, { answers: WORKERS_DEV, zones: [] });
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  const rec = s.record();
  assert.deepEqual(Object.keys(rec.children).sort(), ["deploy", "usage"]);
  assert.equal(s.secrets().get("CF_TOKEN"), "", "作業用の行は空のまま");
  assert.equal(s.oauthCalls, 0, "要るゾーンが無ければ OAuth の値を求めない");
  assert.equal(s.fake.count("zones"), 0);
  assert.equal(posts(s.fake), 2);
  assert.equal(s.fake.requests.length, 13, "workers-dev は 13 回");
  assert.equal(s.fake.token(s.parent.id), null);
});

// ---- 親の値の読み(先に当てる規則) ----

test("parent_check_rejects_details_mismatch", async (t) => {
  const s = stage(t, { parent: { permissions: ["Account API Tokens Write", "Workers Scripts Write"] } });
  const before = readFileSync(s.files.secrets, "utf8");
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /余分: Workers Scripts Write/);
  assert.ok(joined(out).includes(LIST_PLACE), "一覧の場所を出す");
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN の値を消す/);
  assert.equal(posts(s.fake), 0);
  assert.equal(deletes(s.fake), 0);
  assert.equal(existsSync(s.files.record), false, "記録を作らない");
  assert.equal(readFileSync(s.files.secrets, "utf8"), before, "値は人が消す(スクリプトは変えない)");
  assert.equal(out.parent.state, "bad");
});

test("parent_not_yet_valid_message_mentions_start", async (t) => {
  // カレンダーで翌日だけを押した親(開始が明日の 0 時)
  const s = stage(t, { parent: { not_before: "2026-11-14T15:00:00Z", expires_on: "2026-11-15T14:59:59Z" } });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /Start\(開始\)が今日になっているか/);
  assert.match(joined(out), /開始が今より先/);
  assert.equal(posts(s.fake), 0);
  assert.equal(existsSync(s.files.record), false);
});

test("parent_details_transient_failure_is_error", async (t) => {
  // 判断 L: 詳細の 429・通信の失敗は「誤」ではなく「不明」(人に親を作り直させない)
  for (const inject of [(f) => f.networkErrorNext("tokenDetails"), (f) => f.rateLimitNext(2, { route: "tokenDetails", times: 2 })]) {
    const s = stage(t);
    inject(s.fake);
    const before = readFileSync(s.files.secrets, "utf8");
    const out = await s.run();
    assert.equal(out.status, "error", joined(out));
    assert.ok(!/作り直して貼る/.test(joined(out)), "作り直しを求めない");
    assert.equal(readFileSync(s.files.secrets, "utf8"), before);
    assert.equal(existsSync(s.files.record), false);
    assert.deepEqual(s.calls, [], "書き込みは 0 回");
    assert.equal(posts(s.fake), 0);
  }
});

for (const [name, response] of [
  ["5xx", { status: 503 }],
  ["non_json", { status: 502, text: "<html>bad gateway</html>" }],
  // 5xx の節より後ろの「JSON でない」の節だけで不明になる場面(間の proxy・WAF が 2xx・4xx で HTML を返す)
  ["non_json_403", { status: 403, text: "<html>blocked</html>" }],
  ["non_json_200", { status: 200, text: "<html>ok</html>" }],
]) {
  test(`parent_details_${name}_is_error_not_bad`, async (t) => {
    // 最終レビュー Important 1: 詳細の一時的な 5xx・間の proxy の HTML(JSON でない)は「不明」。使える親を作り直させない
    const s = stage(t);
    s.fake.failNext("tokenDetails", response);
    const before = readFileSync(s.files.secrets, "utf8");
    const out = await s.run();
    assert.equal(out.status, "error", joined(out));
    assert.equal(out.parent.state, "unknown");
    assert.match(joined(out), /何も変えていない。少し待ってから同じコマンドを打ち直す/);
    // 不明が続くときの抜け方(親は期限で切れる)
    assert.match(joined(out), /何度か打ち直しても同じなら、打ち直しを止めて人に伝える/);
    assert.ok(!/作り直して貼る/.test(joined(out)), "作り直しを求めない");
    assert.equal(readFileSync(s.files.secrets, "utf8"), before);
    assert.equal(existsSync(s.files.record), false);
    assert.deepEqual(s.calls, [], "書き込みは 0 回");
    assert.equal(posts(s.fake), 0);
    assert.equal(deletes(s.fake), 0);
  });
}

test("parent_details_unreadable_is_human", async (t) => {
  // 4xx で本文も読めた(一時的でない)ときは「誤」
  const s = stage(t);
  s.fake.failNext("tokenDetails", { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /詳細を読めない/);
  assert.equal(posts(s.fake), 0);
  assert.equal(deletes(s.fake), 0);
});

test("parent_verify_unknown_is_error_and_changes_nothing", async (t) => {
  for (const inject of [(f) => f.networkErrorNext("verify"), (f) => f.rateLimitNext(2, { route: "verify", times: 2 })]) {
    const s = stage(t);
    inject(s.fake);
    const before = readFileSync(s.files.secrets, "utf8");
    const out = await s.run();
    assert.equal(out.status, "error", joined(out));
    assert.equal(readFileSync(s.files.secrets, "utf8"), before);
    assert.equal(existsSync(s.files.record), false);
    assert.equal(s.fake.requests.filter((r) => r.route !== "verify").length, 0, "verify のほかは呼ばない");
    assert.deepEqual(s.calls, [], "書き込みは 0 回");
    assert.equal(existsSync(s.files.lock), false);
  }
});

test("foreign_gone_parent_value_is_cleared_then_treated_as_none", async (t) => {
  const s = stage(t);
  s.fake.removeToken(s.parent.id); // 消えたトークンの verify は 401・1000(実機で確かめた形)
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /使えない親の値を消した/);
  // 最終レビュー Minor 3: User API Token の取り違えも挙げ、親を作る画面を添える
  assert.match(joined(out), /User API Token\(My Profile\(マイ プロフィール\)で作ったトークン\)/);
  assert.match(joined(out), /親トークンは Account API tokens\(アカウント API トークン\)の画面で作る/);
  // User API Token の一覧は画面の言葉でクリックの順に
  assert.match(joined(out), /右上のユーザーのアイコン → Profile\(プロフィール\)→ API Tokens\(API トークン\)の一覧で消す/);
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assert.equal(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
  assert.equal(existsSync(s.files.record), false);
  assert.equal(posts(s.fake), 0);
});

test("no_parent_value_asks_to_create_parent", async (t) => {
  const s = stage(t, { noParent: true });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.ok(joined(out).includes(tokenName("parent", IDENT)));
  assert.match(joined(out), /CF_BOOTSTRAP_TOKEN に貼/);
  assert.equal(s.fake.requests.length, 0, "値が無ければ API を呼ばない");
});

test("non_bootstrap_mode_is_usage_error", async (t) => {
  const s = stage(t, { answers: { ...ROUTE, cloudflare_account: "existing", cloudflare_tokens: "manual-account" } });
  const out = await s.run();
  assert.equal(out.status, "error");
  assert.match(joined(out), /--reset/);
  assert.equal(posts(s.fake), 0);
});

test("reset_and_parent_deleted_together_is_usage_error", async (t) => {
  const s = stage(t);
  const out = await s.run({ args: { reset: true, parentDeleted: true } });
  assert.equal(out.status, "error");
  assert.equal(s.fake.requests.length, 0);
  assert.equal(existsSync(s.files.lock), false);
});

test("record_for_other_account_is_error", async (t) => {
  const s = stage(t);
  writeFileSync(s.files.record, JSON.stringify({ version: 1, account_id: OTHER_AID, parent_id: null, parent_fp: null, pending: null, pending_at: null, children: {}, children_checked_at: null, parent_deleted_at: null }));
  const out = await s.run();
  assert.equal(out.status, "error");
  assert.match(joined(out), /アカウント/);
  assert.equal(s.fake.requests.length, 0);
});

// ---- 同名・一覧・値の取り込み ----

test("stops_on_unrecorded_same_name", async (t) => {
  const s = stage(t);
  const other = s.fake.addToken({ name: childName("deploy"), permissions: ["Workers Scripts Write"] });
  const out = await s.run();
  assert.equal(out.status, "human");
  const text = joined(out);
  assert.ok(text.includes(childName("deploy")) && text.includes(other.id), "名前と ID を出す");
  assert.equal(posts(s.fake), 0);
  assert.equal(deletes(s.fake), 0);
  assert.ok(s.fake.token(other.id), "同名を消さない");
  assert.ok(s.fake.token(s.parent.id), "親も消さない");
  // 記録が無いとき: 「使っているなら消さずに何もしない」が「一覧で消す」より先
  const keepAt = out.lines.findIndex((l) => l.includes("消さずに何もしない"));
  const deleteAt = out.lines.findIndex((l) => l.includes("使っていないと分かっていれば") && l.includes(LIST_PLACE));
  assert.ok(keepAt >= 0 && deleteAt > keepAt, `順: ${keepAt} → ${deleteAt}`);
  assert.equal(existsSync(s.files.record), false);
});

test("incomplete_list_does_not_create", async (t) => {
  {
    const s = stage(t);
    s.fake.failListPage(1, { status: 500 });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.match(joined(out), /一覧を読み切れなかった/);
    assert.equal(posts(s.fake), 0);
    assert.equal(existsSync(s.files.record), false);
  }
  {
    // 429 と通信の失敗は、時間を置けば読める見込みなので error(何も変えない)
    const s = stage(t);
    s.fake.networkErrorNext("listTokens");
    const out = await s.run();
    assert.equal(out.status, "error", joined(out));
    assert.equal(posts(s.fake), 0);
  }
});

test("value_without_record_stops_without_adopting", async (t) => {
  const s = stage(t);
  const stray = s.fake.addToken({ name: "something-else", permissions: ["Workers Scripts Write"] });
  writeFileSync(s.files.secrets, `CF_BOOTSTRAP_TOKEN=${s.parent.value}\nCF_TOKEN=\nCF_DEPLOY_TOKEN=${stray.value}\nCF_USAGE_TOKEN=\n`);
  const before = readFileSync(s.files.secrets, "utf8");
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /CF_DEPLOY_TOKEN/);
  assert.match(joined(out), /確かめられない/);
  assert.equal(posts(s.fake), 0);
  assert.equal(deletes(s.fake), 0);
  assert.equal(readFileSync(s.files.secrets, "utf8"), before, "値を消さない・取り込まない");
  assert.equal(existsSync(s.files.record), false);
  assert.ok(!JSON.stringify(out).includes(stray.value));
});

test("secrets_form_rejects_export_quotes_spaces", async (t) => {
  const cases = [
    [(v) => `export CF_BOOTSTRAP_TOKEN=${v}\n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => `X=1\nCF_BOOTSTRAP_TOKEN = ${v}\n`, "CF_BOOTSTRAP_TOKEN", 2],
    [(v) => `CF_BOOTSTRAP_TOKEN="${v}"\n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => `CF_BOOTSTRAP_TOKEN='${v}'\n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => `CF_BOOTSTRAP_TOKEN=${v} \n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => `CF_BOOTSTRAP_TOKEN= ${v}\n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => ` CF_BOOTSTRAP_TOKEN=${v}\n`, "CF_BOOTSTRAP_TOKEN", 1],
    [(v) => `CF_BOOTSTRAP_TOKEN=${v}\nCF_DEPLOY_TOKEN=ab\rcd\n`, "CF_DEPLOY_TOKEN", 2],
    [(v) => `CF_BOOTSTRAP_TOKEN=${v}\n# c\nexport CF_USAGE_TOKEN=\n`, "CF_USAGE_TOKEN", 3],
  ];
  for (const [make, key, line] of cases) {
    const s = stage(t);
    const body = make(s.parent.value);
    writeFileSync(s.files.secrets, body);
    const out = await s.run();
    assert.equal(out.status, "human", `${key} ${line}: ${joined(out)}`);
    assert.ok(joined(out).includes(key), `${key} の名前を出す`);
    assert.ok(joined(out).includes(`${line} 行目`), `${line} 行目を出す: ${joined(out)}`);
    assert.ok(!JSON.stringify(out).includes(s.parent.value), "値を出さない");
    assert.equal(s.fake.requests.length, 0, "API を呼ぶ前に止まる");
    assert.equal(readFileSync(s.files.secrets, "utf8"), body, "ファイルを変えない");
  }
  // 通る形: CRLF の行・空の値・コメント・ほかのキーの自由な形
  const ok = stage(t);
  writeFileSync(ok.files.secrets, `# c\r\nexport OTHER="x y"\r\nCF_BOOTSTRAP_TOKEN=${ok.parent.value}\r\nCF_TOKEN=\r\nCF_DEPLOY_TOKEN=\r\nCF_USAGE_TOKEN=\r\n`);
  const out = await ok.run();
  assert.equal(out.status, "done", joined(out));
  assert.equal(ok.secrets().get("CF_BOOTSTRAP_TOKEN"), "");
});

test("outputs_never_contain_values", async (t) => {
  const forbidden = (s) => {
    const values = [s.parent.value, s.oauth, fingerprint(s.parent.value), "creator@example.com", "token_suffix", "creator_email_at_creation"];
    for (const v of s.fake.tokens().map((x) => x.value)) values.push(v);
    for (const [k, v] of s.secrets() ?? []) if (v && k.startsWith("CF_")) values.push(v);
    return values;
  };
  const check = (s, out, label) => {
    const text = JSON.stringify(out);
    for (const v of forbidden(s)) {
      if (v === fingerprint(s.parent.value)) assert.ok(!text.includes(v), `${label}: parent_fp を出さない`);
      else assert.ok(!text.includes(v), `${label}: 出してはいけない値が出た`);
    }
    if (existsSync(s.files.record)) {
      const recText = readFileSync(s.files.record, "utf8");
      for (const v of forbidden(s)) if (v !== fingerprint(s.parent.value)) assert.ok(!recText.includes(v), `${label}: 記録に値・メールアドレスを書かない`);
    }
  };
  {
    const s = stage(t);
    const childValues = [];
    const out = await s.run();
    for (const role of ["setup", "deploy", "usage"]) childValues.push(s.secrets().get(ENV_KEY[role]));
    assert.equal(out.status, "done");
    check(s, out, "新規");
    for (const v of childValues) assert.ok(!JSON.stringify(out).includes(v));
  }
  {
    const s = stage(t);
    s.fake.addToken({ name: childName("usage"), permissions: ["Account Analytics Read"] });
    const out = await s.run();
    assert.equal(out.status, "human");
    check(s, out, "同名で止まる");
  }
  {
    const s = stage(t, { parent: { permissions: ["Account API Tokens Write", "Zone Read"] } });
    const out = await s.run();
    assert.equal(out.status, "human");
    check(s, out, "誤の親");
  }
  {
    // OAuth の値を読む関数の例外の文に値が入っていても、出力に写さない
    const s = stage(t);
    const out = await s.run({ oauthToken: async () => { throw new SyntaxError(`Unexpected token in JSON: {"token":"${s.oauth}"}`); } });
    assert.equal(out.status, "error");
    check(s, out, "OAuth の値を読めない");
  }
  {
    const s = stage(t);
    s.fake.failReach("workerScripts", 4, { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } });
    const out = await s.run();
    assert.equal(out.status, "human");
    check(s, out, "届かない");
  }
});

// ---- 要るゾーン ----

test("zone_lookup_rejects_other_account", async (t) => {
  const s = stage(t, { zones: [{ id: ZID, name: "example.com", status: "active", accountId: OTHER_AID }] });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /example\.com/);
  assert.equal(posts(s.fake), 0);
  assert.equal(existsSync(s.files.record), false);
});

test("zone_lookup_picks_longest_candidate", async (t) => {
  const s = stage(t, {
    answers: { ...WORKERS_DEV, control_address: "custom", control_host: "ab.sub.example.com" },
    zones: [
      { id: ZID, name: "example.com", status: "active" },
      { id: ZID_SUB, name: "sub.example.com", status: "active" },
    ],
  });
  const out = await s.run();
  assert.equal(out.status, "done", joined(out));
  const zoneQueries = s.fake.requests.filter((r) => r.route === "zones").map((r) => r.query.name);
  assert.deepEqual(zoneQueries, ["ab.sub.example.com", "sub.example.com"], "長い順に、当たったところで止める");
  const setupTok = s.fake.token(s.record().children.setup.id);
  assert.deepEqual(Object.keys(setupTok.policies[0].resources), [`com.cloudflare.api.account.zone.${ZID_SUB}`]);
});

test("zone_name_is_looked_up_exactly_once", async (t) => {
  // 決まった zone_name は完全一致の 1 回だけ。短い名前のゾーンに進まない
  const s = stage(t, { answers: { ...ROUTE, zone_name: "app.example.com" } });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.deepEqual(s.fake.requests.filter((r) => r.route === "zones").map((r) => r.query.name), ["app.example.com"]);
  assert.equal(posts(s.fake), 0);
});

test("zone_lookup_stops_at_first_named_candidate", async (t) => {
  // 判断 M: 名前の合うゾーンが見えた候補で止まる。採れない(別のアカウント)なら、短い名前の自分のゾーンに進まずに human
  const s = stage(t, {
    answers: { ...WORKERS_DEV, control_address: "custom", control_host: "ab.sub.example.com" },
    zones: [
      { id: ZID_SUB, name: "sub.example.com", status: "active", accountId: OTHER_AID },
      { id: ZID, name: "example.com", status: "active" },
    ],
  });
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.deepEqual(s.fake.requests.filter((r) => r.route === "zones").map((r) => r.query.name), ["ab.sub.example.com", "sub.example.com"]);
  assert.match(joined(out), /sub\.example\.com は、このアカウントのゾーンではない/);
  assert.equal(posts(s.fake), 0);
});

test("reach_check_requires_zone_ids_for_setup", async (t) => {
  const s = stage(t);
  const rec = { version: 1, account_id: AID, parent_id: null, parent_fp: null, pending: null, pending_at: null, children: { setup: { name: childName("setup"), id: "1".repeat(32), expires_on: null, created_at: null } }, children_checked_at: null, parent_deleted_at: null };
  const ctx = { cf: createCf({ fetch: s.fake.fetch, sleep: s.fake.sleep, accountId: AID, now: s.fake.now }), files: s.files, fsOps: DEFAULT_FS_OPS, ident: IDENT, accountId: AID, now: s.fake.now, sleep: s.fake.sleep };
  await assert.rejects(() => reachCheck(ctx, rec, { zoneIds: [] }), /ゾーン/);
  await assert.rejects(() => reachCheck(ctx, rec), /ゾーン/);
  assert.equal(s.fake.requests.length, 0);
});

test("post_body_cut_after_success_keeps_pending", async (t) => {
  // Important 1: POST が 200 で成立したのに本文が切れた → 作られたかもしれない。印を残して error
  const s = stage(t);
  s.fake.truncateNext("createToken");
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  assert.match(joined(out), /結果が分からない/);
  const rec = s.record();
  assert.equal(rec.pending, "setup", "印を残す");
  assert.ok(rec.pending_at);
  assert.equal(rec.children.setup, undefined);
  assert.equal(s.fake.tokens().filter((x) => x.name === childName("setup")).length, 1, "偽物の側では作られている");
  assert.equal(s.secrets().get("CF_TOKEN"), "");
  assert.equal(posts(s.fake), 1, "ほかの子を作らない");
  assert.equal(deletes(s.fake), 0, "親を消さない");
});

test("zone_lookup_rejects_inactive_zone", async (t) => {
  const s = stage(t, { zones: [{ id: ZID, name: "example.com", status: "pending" }] });
  const out = await s.run();
  assert.equal(out.status, "human");
  assert.match(joined(out), /example\.com/);
  assert.equal(posts(s.fake), 0);
});

// ---- 届き先 ----

test("reach_accepts_10003_only", async (t) => {
  {
    // ルールの無い新しいゾーン: entrypoint の GET は 10003 → 届いた扱い
    const s = stage(t);
    const out = await s.run();
    assert.equal(out.status, "done", joined(out));
    const rs = s.fake.requests.filter((r) => r.route === "ruleset");
    assert.equal(rs.length, 1);
    assert.equal(rs[0].phase, "http_ratelimit");
    assert.equal(rs[0].zoneId, ZID);
  }
  {
    // 権限のエラー(10000)は届かない扱い。5 秒おきに 3 回だけ確かめ直し、親は消さない
    const s = stage(t);
    s.fake.failReach("ruleset", 4, { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.deepEqual(s.fake.sleeps.filter((x) => x === 5000), [5000, 5000, 5000]);
    assert.equal(s.fake.count("ruleset"), 4);
    assert.equal(s.fake.count("workerScripts"), 1, "届いた届き先は呼び直さない");
    assert.equal(deletes(s.fake), 0, "親を消さない");
    assert.ok(s.fake.token(s.parent.id));
    const text = joined(out);
    assert.ok(text.includes(childName("setup")), "どのトークンが届かないか");
    assert.ok(text.includes(tokenName("parent", IDENT)) && text.includes(EXPIRES), "親が生きていることと期限");
    assert.match(text, /--reset/);
    assert.equal(s.record().children_checked_at, null);
  }
  {
    // 10003 を通すのは作業用の ruleset の entrypoint だけ。デプロイ用の届き先が 10003 なら届かない
    const s = stage(t);
    s.fake.failReach("workerScripts", 4, { status: 404, body: { success: false, errors: [{ code: 10003, message: "could not find entrypoint ruleset" }], messages: [], result: null } });
    const out = await s.run();
    assert.equal(out.status, "human", joined(out));
    assert.equal(s.fake.count("workerScripts"), 4);
    assert.ok(joined(out).includes(childName("deploy")));
    assert.equal(deletes(s.fake), 0);
  }
  {
    // 1 回だけ失敗して 2 回目で通る → 18 回
    const s = stage(t);
    s.fake.failReach("ruleset", 1, { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } });
    const out = await s.run();
    assert.equal(out.status, "done", joined(out));
    assert.equal(s.fake.requests.length, 18);
  }
});

// ---- 作成の応答の権限を表と照らす ----

test("created_child_with_unexpected_permissions_stops", async (t) => {
  const s = stage(t);
  const fakeId = "f".repeat(32);
  const fakeValue = "fakecf_value_wrongperm_zzzz";
  s.fake.failNext("createToken", createResponse({
    id: fakeId, name: childName("setup"), value: fakeValue,
    permissionNames: ["Zone Read", "DNS Read", "Cache Settings Write", "Zone WAF Write", "Account API Tokens Write"],
    resources: { [`com.cloudflare.api.account.zone.${ZID}`]: "*" },
  }));
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  assert.match(joined(out), /余分: Account API Tokens Write/);
  assert.equal(posts(s.fake), 1, "作り直さない・ほかの子も作らない");
  const rec = s.record();
  assert.equal(rec.children.setup.id, fakeId, "ID は記録に残す(打ち直しで消せるように)");
  assert.equal(rec.pending, null);
  assert.equal(s.secrets().get("CF_TOKEN"), "", "値は書かない");
  assert.equal(deletes(s.fake), 0, "親は消さない");
  assert.ok(!JSON.stringify(out).includes(fakeValue));
});
