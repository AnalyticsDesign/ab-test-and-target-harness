// Cloudflare API の呼び出し(lib/cf.mjs)のテスト(B130 Task 4)。本物の Cloudflare にはつながない。
// 偽物(fake-cf.mjs)か、その場の小さな stub の fetch だけを使う
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCf } from "../lib/cf.mjs";
import { allowedDeleteIds } from "../lib/record.mjs";
import { createFakeCf } from "./fake-cf.mjs";

const AID = "0123456789abcdef0123456789abcdef";
const ZID = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
const NOW = new Date("2026-11-14T05:52:39.000Z");
const VALUE = "secret-token-value-do-not-print-0123456789";

/** sleep を記録するだけ(待たない) */
function recordingSleep() {
  const calls = [];
  const sleep = async (ms) => { calls.push(ms); };
  return { sleep, calls };
}

/** 応答の並びを順に返す stub の fetch。要素は { status, body, text, headers } か、例外を投げる関数 */
function stubFetch(seq) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const step = seq.length > 1 ? seq.shift() : seq[0];
    if (typeof step === "function") return step(url, init);
    const text = step.text ?? JSON.stringify(step.body ?? {});
    return new Response(text, { status: step.status ?? 200, headers: step.headers ?? {} });
  };
  return { fetch, calls };
}

const okEnv = (result, extra = {}) => ({ status: 200, body: { success: true, errors: [], messages: [], result, ...extra } });
const errEnv = (status, code, message) => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });

function withFake(opts = {}) {
  const fake = createFakeCf({ accountId: AID, now: () => NOW, zones: [{ id: ZID, name: "example.com", status: "active" }], ...opts });
  const parent = fake.addToken({
    name: "wtt-bootstrap-quiet-river-1a2b",
    permissions: ["Account API Tokens Write"],
    not_before: "2026-11-13T15:00:00Z",
    expires_on: "2026-11-15T14:59:59Z",
  });
  const { sleep, calls } = recordingSleep();
  const cf = createCf({ fetch: fake.fetch, sleep, accountId: AID, now: fake.now });
  return { fake, parent, cf, sleeps: calls };
}

const usageBody = (name = "wtt-usage-quiet-river-1a2b") => ({
  name,
  policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${AID}`]: "*" }, permission_groups: [{ id: "b89a480218d04ceb98b4fe57ca29dc1f" }] }],
});

test("retries_429_once_with_retry_after: 1 回目 429(retry-after: 2)→ sleep(2000) を 1 回、2 回目の成功を返す", async () => {
  const { fake, parent, cf, sleeps } = withFake();
  fake.rateLimitNext(2);
  const r = await cf.verify(parent.value);
  assert.equal(r.ok, true);
  assert.equal(r.state, "active");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fake.count("verify"), 2);
});

test("retries_429_once_with_retry_after: 2 回とも 429 なら ok: false・code 429", async () => {
  const { fake, parent, cf, sleeps } = withFake();
  fake.rateLimitNext(2, { times: 2 });
  const r = await cf.listTokens(parent.value);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 429);
  assert.match(r.errors[0].message, /2 秒後/);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fake.count("listTokens"), 2, "再試行は 1 回だけ");
});

test("retry_after_over_cap_is_error_without_sleep: retry-after: 61 → sleep を呼ばずに ok: false・code 429、message に何秒後か", async () => {
  const { fake, parent, cf, sleeps } = withFake();
  fake.rateLimitNext(61);
  const r = await cf.tokenDetails(parent.value, parent.id);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 429);
  assert.match(r.errors[0].message, /61 秒後に打ち直す/);
  assert.deepEqual(sleeps, []);
  assert.equal(fake.count("tokenDetails"), 1);
});

test("retry_after_missing_is_error_without_sleep: retry-after が無い 429 は待たずに ok: false", async () => {
  const { fetch } = stubFetch([{ status: 429, body: { success: false, errors: [{ code: 971, message: "slow down" }] } }]);
  const { sleep, calls } = recordingSleep();
  const cf = createCf({ fetch, sleep, accountId: AID, now: () => NOW });
  const r = await cf.workerScripts(VALUE);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 429);
  assert.deepEqual(calls, []);
});

test("verify_states: active・not_yet_valid・gone(1000・expired・disabled)・unknown(429 が続く・通信の失敗・JSON でない)", async () => {
  // active。戻り値に id・not_before・expires_on
  {
    const { parent, cf } = withFake();
    const r = await cf.verify(parent.value);
    assert.equal(r.state, "active");
    assert.equal(r.id, parent.id);
    assert.equal(r.not_before, "2026-11-13T15:00:00Z");
    assert.equal(r.expires_on, "2026-11-15T14:59:59Z");
  }
  // 開始が未来 → status は active でも not_yet_valid(今の時刻と比べる)
  {
    const { fake, cf } = withFake();
    const t = fake.addToken({ name: "later", permissions: ["Account Analytics Read"], not_before: "2026-11-14T06:52:39Z" });
    const r = await cf.verify(t.value);
    assert.equal(r.state, "not_yet_valid");
    assert.equal(r.not_before, "2026-11-14T06:52:39Z");
    fake.advance(2 * 3600_000);
    const cf2 = createCf({ fetch: fake.fetch, sleep: async () => {}, accountId: AID, now: fake.now });
    assert.equal((await cf2.verify(t.value)).state, "active", "開始を過ぎれば active");
  }
  // 消した値 → 1000 → gone
  {
    const { fake, parent, cf } = withFake();
    fake.removeToken(parent.id);
    const r = await cf.verify(parent.value);
    assert.equal(r.state, "gone");
    assert.equal(r.errors[0].code, 1000);
  }
  // expired・disabled → gone
  {
    const { fake, cf } = withFake();
    const t = fake.addToken({ name: "short", permissions: ["Account Analytics Read"], expires_on: "2026-11-14T05:55:39Z" });
    fake.advance(240_000);
    const r = await cf.verify(t.value);
    assert.equal(r.state, "gone");
    assert.equal(r.tokenStatus, "expired");
    assert.equal(r.expires_on, "2026-11-14T05:55:39Z");
    const d = fake.addToken({ name: "off", permissions: ["Account Analytics Read"] });
    fake.setStatus(d.id, "disabled");
    assert.equal((await cf.verify(d.value)).state, "gone");
  }
  // 429 が続く → unknown
  {
    const { fake, parent, cf } = withFake();
    fake.rateLimitNext(1, { times: 2 });
    const r = await cf.verify(parent.value);
    assert.equal(r.state, "unknown");
    assert.equal(r.ok, false);
  }
  // 通信の失敗 → unknown
  {
    const { fake, parent, cf } = withFake();
    fake.networkErrorNext("verify");
    const r = await cf.verify(parent.value);
    assert.equal(r.state, "unknown");
    assert.equal(r.errors[0].code, "network");
  }
  // JSON でない → unknown・code non_json
  {
    const { fake, parent, cf } = withFake();
    fake.failNext("verify", { status: 200, text: "<html>ok?</html>" });
    const r = await cf.verify(parent.value);
    assert.equal(r.state, "unknown");
    assert.equal(r.errors[0].code, "non_json");
  }
  // どちらとも決められない形(成功だが status が知らない値・開始を日時として読めない)→ unknown
  {
    const { fetch } = stubFetch([okEnv({ id: "abc", status: "weird" }), okEnv({ id: "abc", status: "active", not_before: "not-a-date" })]);
    const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
    assert.equal((await cf.verify(VALUE)).state, "unknown");
    assert.equal((await cf.verify(VALUE + "2")).state, "unknown");
  }
  // User API Token は accounts の verify で 1000 → gone
  {
    const { fake, cf } = withFake();
    const u = fake.addToken({ name: "manual-user", kind: "user", permissions: ["Account Analytics Read"] });
    assert.equal((await cf.verify(u.value)).state, "gone");
  }
});

test("verify_caches_only_active_and_drops_on_delete: active だけを値ごとに使い回し、その ID を DELETE したら捨てる", async () => {
  const { fake, parent, cf } = withFake();
  const child = (await cf.createToken(parent.value, usageBody())).result;
  await cf.verify(child.value);
  const again = await cf.verify(child.value);
  assert.equal(again.state, "active");
  assert.equal(fake.count("verify"), 1, "2 回目は送らない");

  // not_yet_valid は使い回さない
  const later = fake.addToken({ name: "later", permissions: ["Account Analytics Read"], not_before: "2026-11-15T00:00:00Z" });
  await cf.verify(later.value);
  await cf.verify(later.value);
  assert.equal(fake.count("verify"), 3);

  // DELETE したら捨てる(応答が落ちても、送る前に捨てる)
  fake.dropNext("deleteToken");
  const del = await cf.deleteToken(parent.value, child.id, allowedDeleteIds(null, "parent", child.id));
  assert.equal(del.ok, false);
  const after = await cf.verify(child.value);
  assert.equal(after.state, "gone");
  assert.equal(fake.count("verify"), 4);

  // 親が自分を消した後も、親の verify は送り直す
  await cf.verify(parent.value);
  const before = fake.count("verify");
  assert.equal((await cf.deleteToken(parent.value, parent.id, allowedDeleteIds(null, "parent", parent.id))).ok, true);
  assert.equal((await cf.verify(parent.value)).state, "gone");
  assert.equal(fake.count("verify"), before + 1);
});

test("verify_cache_expires_with_clock: 使い回した active も、期限を過ぎたら送り直す", async () => {
  const { fake, cf } = withFake();
  const t = fake.addToken({ name: "short", permissions: ["Account Analytics Read"], expires_on: "2026-11-14T05:55:39Z" });
  assert.equal((await cf.verify(t.value)).state, "active");
  fake.advance(240_000);
  assert.equal((await cf.verify(t.value)).state, "gone");
  assert.equal(fake.count("verify"), 2);
});

test("delete_refuses_unbranded_or_missing_id: 印の無い集合・集合に無い ID → fetch を呼ばずに例外", async () => {
  const { fake, parent, cf } = withFake();
  await assert.rejects(cf.deleteToken(parent.value, parent.id, new Set([parent.id])), /DELETE を許す/);
  await assert.rejects(cf.deleteToken(parent.value, parent.id, { purpose: "parent", ids: [parent.id] }), /DELETE を許す/);
  await assert.rejects(cf.deleteToken(parent.value, parent.id, Object.freeze({ purpose: "parent", ids: Object.freeze([parent.id]) })), /DELETE を許す/);
  const other = "9".repeat(32);
  await assert.rejects(cf.deleteToken(parent.value, other, allowedDeleteIds(null, "parent", parent.id)), new RegExp(other));
  await assert.rejects(cf.deleteToken(parent.value, parent.id, allowedDeleteIds(null, "restart")), /DELETE を許す集合に無い/);
  assert.equal(fake.requests.length, 0, "1 つも送らない");
  // 例外の文に値を入れない
  try {
    await cf.deleteToken(parent.value, parent.id, new Set([parent.id]));
  } catch (e) {
    assert.ok(!String(e.message).includes(parent.value));
  }
});

test("delete_already_gone_is_reported_as_gone: もう無い ID への DELETE(404・1003)→ gone: true", async () => {
  const { fake, parent, cf } = withFake();
  const child = (await cf.createToken(parent.value, usageBody())).result;
  const allow = allowedDeleteIds({ version: 1, children: { usage: { id: child.id } }, children_checked_at: null, parent_deleted_at: null }, "restart");
  const first = await cf.deleteToken(parent.value, child.id, allow);
  assert.equal(first.ok, true);
  assert.equal(first.gone, false);
  const second = await cf.deleteToken(parent.value, child.id, allow);
  assert.equal(second.ok, false);
  assert.equal(second.gone, true);
  assert.equal(second.errors[0].code, 1003);
  assert.deepEqual(fake.requests.filter((e) => e.route === "deleteToken").map((e) => e.id), [child.id, child.id]);
});

test("delete_404_without_1003_is_not_gone・権限の無い 9109 も gone ではない", async () => {
  const { fetch } = stubFetch([errEnv(404, 7003, "No route for that URI"), errEnv(403, 9109, "Unauthorized to access requested resource")]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const id = "1".repeat(32);
  const allow = allowedDeleteIds(null, "parent", id);
  const a = await cf.deleteToken(VALUE, id, allow);
  assert.equal(a.gone, false);
  assert.equal(a.ok, false);
  const b = await cf.deleteToken(VALUE, id, allow);
  assert.equal(b.gone, false);
  assert.equal(b.errors[0].code, 9109);
});

test("list_tokens_reads_all_pages_without_total_pages: total_pages の無い応答で 120 本 → 3 ページ読んで 120 本", async () => {
  const { fake, parent, cf } = withFake({ listResultInfo: "no_total_pages" });
  for (let i = 0; i < 118; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
  // 3 ページ目(101 本目以降)にだけある、親と同じ名前のトークン
  const dup = fake.addToken({ name: "wtt-bootstrap-quiet-river-1a2b", permissions: ["Account Analytics Read"] });
  const r = await cf.listTokens(parent.value);
  assert.equal(r.ok, true);
  assert.equal(r.result.length, 120);
  assert.ok(r.result.some((t) => t.id === dup.id));
  assert.equal(r.result.filter((t) => t.name === "wtt-bootstrap-quiet-river-1a2b").length, 2);
  assert.deepEqual(fake.requests.filter((e) => e.route === "listTokens").map((e) => [e.query.page, e.query.per_page]), [["1", "50"], ["2", "50"], ["3", "50"]]);
});

test("list_tokens_ends_at_total_count: ちょうど 100 本で total_count に届けば、3 ページ目を読まない", async () => {
  const { fake, parent, cf } = withFake({ listResultInfo: "no_total_pages" });
  for (let i = 0; i < 99; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
  const r = await cf.listTokens(parent.value);
  assert.equal(r.ok, true);
  assert.equal(r.result.length, 100);
  assert.equal(fake.count("listTokens"), 2);
});

test("list_tokens_incomplete_on_page_failure: 途中のページの失敗 → ok: false・incomplete: true", async () => {
  const { fake, parent, cf } = withFake();
  for (let i = 0; i < 119; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
  fake.failListPage(2);
  const r = await cf.listTokens(parent.value);
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(r.result, undefined, "途中までの一覧は返さない");
  assert.equal(fake.count("listTokens"), 2);
});

test("list_tokens_incomplete_without_result_info_at_exact_page_size", async () => {
  // result_info が無く、件数が per_page ちょうど → 続きがあるか分からないので incomplete
  {
    const { fake, parent, cf } = withFake({ listResultInfo: "none" });
    for (let i = 0; i < 49; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
    const r = await cf.listTokens(parent.value);
    assert.equal(r.ok, false);
    assert.equal(r.incomplete, true);
  }
  // result_info が無くても per_page より少なければ終わり
  {
    const { fake, parent, cf } = withFake({ listResultInfo: "none" });
    for (let i = 0; i < 48; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
    const r = await cf.listTokens(parent.value);
    assert.equal(r.ok, true);
    assert.equal(r.result.length, 49);
  }
});

test("list_tokens_incomplete_at_page_cap: 20 ページで終わらなければ incomplete", async () => {
  const page = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: `t${i}` }));
  const { fetch, calls } = stubFetch([okEnv(page, { result_info: { page: 1, per_page: 50, count: 50 } })]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const r = await cf.listTokens(VALUE);
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
  assert.equal(calls.length, 20);
});

test("list_tokens_incomplete_on_bad_shape: result が配列でない", async () => {
  const { fetch } = stubFetch([okEnv({ not: "array" })]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const r = await cf.listTokens(VALUE);
  assert.equal(r.ok, false);
  assert.equal(r.incomplete, true);
});

test("permission_groups_without_result_info_is_one_call: ページを付けずに 1 回で全部", async () => {
  const { fake, parent, cf } = withFake();
  const r = await cf.permissionGroups(parent.value);
  assert.equal(r.ok, true);
  assert.ok(r.result.some((g) => g.name === "Workers Scripts Write"));
  const h = fake.requests.filter((e) => e.route === "permissionGroups");
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].query, {});
});

test("permission_groups_reads_total_pages_when_present・途中の失敗は incomplete", async () => {
  {
    const { fetch, calls } = stubFetch([
      okEnv([{ id: "a", name: "A" }], { result_info: { page: 1, per_page: 1, total_pages: 2, count: 1, total_count: 2 } }),
      okEnv([{ id: "b", name: "B" }], { result_info: { page: 2, per_page: 1, total_pages: 2, count: 1, total_count: 2 } }),
    ]);
    const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
    const r = await cf.permissionGroups(VALUE);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.map((g) => g.id), ["a", "b"]);
    assert.equal(new URL(calls[0].url).search, "");
    assert.equal(new URL(calls[1].url).searchParams.get("page"), "2");
  }
  {
    const { fetch } = stubFetch([
      okEnv([{ id: "a", name: "A" }], { result_info: { page: 1, per_page: 1, total_pages: 2, count: 1, total_count: 2 } }),
      errEnv(500, 10001, "boom"),
    ]);
    const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
    const r = await cf.permissionGroups(VALUE);
    assert.equal(r.ok, false);
    assert.equal(r.incomplete, true);
  }
});

test("create_token_returns_value_and_policy_names: 作成の応答の policies に権限の名前が入る", async () => {
  const { fake, parent, cf } = withFake();
  const r = await cf.createToken(parent.value, usageBody());
  assert.equal(r.ok, true);
  assert.equal(typeof r.result.value, "string");
  assert.equal(r.result.policies[0].permission_groups[0].name, "Account Analytics Read");
  const sent = fake.requests.at(-1);
  assert.equal(sent.method, "POST");
  assert.equal(sent.body.name, "wtt-usage-quiet-river-1a2b");
});

test("dropped_post_is_not_retried: POST の応答が落ちたら再試行せず ok: false。サーバーの側では作られている", async () => {
  const { fake, parent, cf, sleeps } = withFake();
  fake.dropNext("createToken");
  const r = await cf.createToken(parent.value, usageBody());
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "network");
  assert.equal(fake.count("createToken"), 1);
  assert.deepEqual(sleeps, []);
  const list = await cf.listTokens(parent.value);
  assert.ok(list.result.some((t) => t.name === "wtt-usage-quiet-river-1a2b"));
});

test("graphql_errors_are_not_ok: 200 で errors: [{message}] → ok: false", async () => {
  const { fetch } = stubFetch([{ status: 200, body: { data: null, errors: [{ message: "not authorized for that account" }] } }]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const r = await cf.analyticsProbe(VALUE);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].message, "not authorized for that account");
});

test("analytics_probe_query_and_success: errors が null・空なら ok。照会は今日の 1 日のアカウントの照会", async () => {
  const { fetch, calls } = stubFetch([
    { status: 200, body: { data: { viewer: { accounts: [{ x: [] }] } }, errors: null } },
    { status: 200, body: { data: { viewer: { accounts: [{ x: [] }] } }, errors: [] } },
    { status: 200, body: { data: { viewer: { accounts: [{ x: [] }] } } } },
  ]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  for (let i = 0; i < 3; i++) assert.equal((await cf.analyticsProbe(VALUE)).ok, true);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(calls[0].method, "POST");
  const q = JSON.parse(calls[0].body).query;
  assert.match(q, new RegExp(`accounts\\(filter: \\{ accountTag: "${AID}" \\}\\)`));
  assert.match(q, /workersInvocationsAdaptive\(limit: 1, filter: \{ date_geq: "2026-11-14", date_leq: "2026-11-14" \}\)/);
  assert.match(q, /sum \{ requests \}/);
});

test("analytics_probe_via_fake_passes_even_without_analytics_permission(実機の記録どおり)", async () => {
  const { fake, cf } = withFake();
  const deploy = fake.addToken({ name: "wtt-deploy-x", permissions: ["Workers Scripts Write"] });
  assert.equal((await cf.analyticsProbe(deploy.value)).ok, true);
  fake.failReach("graphql", 1);
  assert.equal((await cf.analyticsProbe(deploy.value)).ok, false);
});

test("zones_ruleset_workers_paths_and_shapes", async () => {
  const { fake, parent, cf } = withFake({ zones: [{ id: ZID, name: "example.com", status: "active" }, { id: "c".repeat(32), name: "example.net", status: "pending", accountId: "f".repeat(32) }] });
  const oauth = fake.addOauth();
  const z = await cf.zonesByName(oauth, "example.net");
  assert.equal(z.ok, true);
  assert.deepEqual(z.zones, [{ id: "c".repeat(32), name: "example.net", status: "pending", accountId: "f".repeat(32) }]);
  assert.deepEqual(fake.requests.at(-1).query, { name: "example.net" });

  const setupTok = fake.addToken({ name: "wtt-setup-x", permissions: ["Zone Read", "DNS Read", "Cache Settings Write", "Zone WAF Write"], zoneIds: [ZID] });
  const none = await cf.rulesetEntrypoint(setupTok.value, ZID, "http_ratelimit");
  assert.equal(none.ok, false);
  assert.equal(none.errors[0].code, 10003);
  assert.equal(fake.requests.at(-1).path, `/zones/${ZID}/rulesets/phases/http_ratelimit/entrypoint`);
  const denied = await cf.rulesetEntrypoint(parent.value, ZID, "http_ratelimit");
  assert.equal(denied.errors[0].code, 10000);

  const deploy = fake.addToken({ name: "wtt-deploy-x", permissions: ["Workers Scripts Write"] });
  const w = await cf.workerScripts(deploy.value);
  assert.equal(w.ok, true);
  assert.equal(fake.requests.at(-1).path, `/accounts/${AID}/workers/scripts`);
});

test("non_json_is_code_non_json・errors の空な失敗にも code が入る", async () => {
  const { fetch } = stubFetch([{ status: 502, text: "<html>bad gateway</html>" }, { status: 500, body: { success: false, errors: [] } }]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const a = await cf.workerScripts(VALUE);
  assert.equal(a.ok, false);
  assert.equal(a.errors[0].code, "non_json");
  assert.ok(!a.errors[0].message.includes("bad gateway"), "本文を文に入れない");
  const b = await cf.workerScripts(VALUE);
  assert.equal(b.ok, false);
  assert.equal(b.errors.length, 1);
  assert.equal(b.status, 500);
});

test("errors_never_contain_token_value: 失敗の応答の文に Authorization の値が入らない", async () => {
  // サーバーが値を errors の文にそのまま返す・通信の例外の文に値が入る・JSON でない本文に値が入る
  const { fetch } = stubFetch([
    (_url, init) => new Response(JSON.stringify({ success: false, errors: [{ code: 6111, message: `Invalid header: ${init.headers.Authorization}` }] }), { status: 400 }),
    (_url, init) => { throw new TypeError(`fetch failed for ${init.headers.Authorization}`); },
    (_url, init) => new Response(`oops ${init.headers.Authorization}`, { status: 500 }),
    (_url, init) => new Response(JSON.stringify({ data: null, errors: [{ message: `bad ${init.headers.Authorization}` }] }), { status: 200 }),
    (_url, init) => new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: `bad ${init.headers.Authorization}` }] }), { status: 401 }),
  ]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  const results = [
    await cf.workerScripts(VALUE),
    await cf.listTokens(VALUE),
    await cf.zonesByName(VALUE, "example.com"),
    await cf.analyticsProbe(VALUE),
    await cf.verify(VALUE),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    const text = JSON.stringify(r.errors);
    assert.ok(!text.includes(VALUE), text);
    assert.ok(r.errors.length > 0);
    assert.equal(r.cause, undefined);
  }
  assert.equal(results[4].state, "gone");
});

test("authorization_header_and_base_url: Bearer で送り、宛先は API の根", async () => {
  const { fetch, calls } = stubFetch([okEnv({ id: "x", status: "active" })]);
  const cf = createCf({ fetch, sleep: async () => {}, accountId: AID, now: () => NOW });
  await cf.verify(VALUE);
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${AID}/tokens/verify`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${VALUE}`);
});

test("create_cf_rejects_bad_inputs_without_echoing_values", async () => {
  assert.throws(() => createCf({ fetch: async () => {}, sleep: async () => {}, accountId: "" }), /アカウントの ID/);
  assert.throws(() => createCf({ fetch: async () => {}, sleep: async () => {}, accountId: "../x" }), /アカウントの ID/);
  const cf = createCf({ fetch: async () => { throw new Error("must not be called"); }, sleep: async () => {}, accountId: AID, now: () => NOW });
  await assert.rejects(cf.verify(""), /トークンの値/);
  await assert.rejects(cf.verify("ab\ncd"), (e) => !e.message.includes("ab\ncd"));
  await assert.rejects(cf.tokenDetails(VALUE, "../x"), /ID/);
  await assert.rejects(cf.rulesetEntrypoint(VALUE, "../x", "http_ratelimit"), /ゾーン/);
});
