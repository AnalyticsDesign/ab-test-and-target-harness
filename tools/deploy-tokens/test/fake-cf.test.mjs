// 偽の Cloudflare(fake-cf.mjs)そのもののテスト(B130 Task 4)。
// 後の流れのテスト(flow-*.test.mjs)がこの偽物に頼るので、docs/dev/b130_api_shapes.md の実機の形どおりに応えるかを見る
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCf, DEFAULT_PERMISSION_GROUPS } from "./fake-cf.mjs";

const AID = "0123456789abcdef0123456789abcdef";
const OTHER_AID = "fedcba9876543210fedcba9876543210";
const ZID = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
const ZID_OTHER = "ccccccccccccccccdddddddddddddddd";
const BASE = "https://api.cloudflare.com/client/v4";
const NOW = new Date("2026-11-14T05:52:39.000Z");

const groupId = (name) => DEFAULT_PERMISSION_GROUPS.find((g) => g.name === name).id;

/** 偽物の fetch を呼び、状態コード・見出し・本文(JSON)を返す */
async function call(fake, method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fake.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON でない応答を試すテストがある */ }
  return { status: res.status, headers: res.headers, json, text };
}

function setup(opts = {}) {
  const fake = createFakeCf({
    accountId: AID,
    now: () => NOW,
    zones: [
      { id: ZID, name: "example.com", status: "active" },
      { id: ZID_OTHER, name: "example.net", status: "active", accountId: OTHER_AID },
    ],
    ...opts,
  });
  const parent = fake.addToken({
    name: "wtt-bootstrap-quiet-river-1a2b",
    permissions: ["Account API Tokens Write"],
    not_before: "2026-11-13T15:00:00Z",
    expires_on: "2026-11-15T14:59:59Z",
  });
  return { fake, parent };
}

const usageBody = (name = "wtt-usage-quiet-river-1a2b", extra = {}) => ({
  name,
  policies: [{
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${AID}`]: "*" },
    permission_groups: [{ id: groupId("Account Analytics Read") }],
  }],
  ...extra,
});

test("fake_create_list_verify_delete_roundtrip: 作成 → 一覧 → verify → DELETE → もう無い ID への DELETE", async () => {
  const { fake, parent } = setup();
  const created = await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody());
  assert.equal(created.status, 200);
  assert.equal(created.json.success, true);
  const r = created.json.result;
  assert.match(r.id, /^[0-9a-f]{32}$/);
  assert.equal(typeof r.value, "string");
  assert.equal(r.status, "active");
  assert.equal(r.name, "wtt-usage-quiet-river-1a2b");
  // 作成の本文の権限の ID から名前を戻して返す(実機と同じ形)
  assert.deepEqual(r.policies[0].permission_groups, [{ id: groupId("Account Analytics Read"), name: "Account Analytics Read" }]);
  assert.equal(r.policies[0].effect, "allow");
  assert.deepEqual(r.policies[0].resources, { [`com.cloudflare.api.account.${AID}`]: "*" });
  assert.ok("token_suffix" in r && "creator_email_at_creation" in r);
  assert.ok(!("not_before" in r) && !("expires_on" in r), "付けなかった not_before・expires_on は返らない");

  // 作成の直後の一覧に載る(実機どおり)。一覧に値は無い
  const list = await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value);
  assert.equal(list.status, 200);
  const ids = list.json.result.map((t) => t.id);
  assert.ok(ids.includes(r.id) && ids.includes(parent.id));
  assert.ok(list.json.result.every((t) => !("value" in t)));
  assert.deepEqual(Object.keys(list.json.result_info).sort(), ["count", "page", "per_page", "total_count", "total_pages"]);

  const v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, r.value);
  assert.equal(v.status, 200);
  assert.equal(v.json.result.id, r.id);
  assert.equal(v.json.result.status, "active");

  const del = await call(fake, "DELETE", `/accounts/${AID}/tokens/${r.id}`, parent.value);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.result, { id: r.id });

  // 消したトークンの値は 1000
  const v2 = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, r.value);
  assert.equal(v2.status, 401);
  assert.equal(v2.json.errors[0].code, 1000);

  // 消えた ID への DELETE は 404・1003・result: null
  const del2 = await call(fake, "DELETE", `/accounts/${AID}/tokens/${r.id}`, parent.value);
  assert.equal(del2.status, 404);
  assert.equal(del2.json.errors[0].code, 1003);
  assert.equal(del2.json.result, null);

  // 一覧から消える
  const list2 = await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value);
  assert.ok(!list2.json.result.some((t) => t.id === r.id));
});

test("fake_not_before_future_verify_is_active_with_not_before: 開始が未来でも verify は active で not_before が付く", async () => {
  const { fake, parent } = setup();
  const created = await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody(undefined, { not_before: "2026-11-14T06:52:39Z" }));
  const r = created.json.result;
  assert.equal(r.not_before, "2026-11-14T06:52:39Z");
  const v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, r.value);
  assert.equal(v.status, 200);
  assert.equal(v.json.result.status, "active");
  assert.equal(v.json.result.not_before, "2026-11-14T06:52:39Z");
  // verify 以外では使えない(実機で未確認の既定。401・1000)
  const w = await call(fake, "GET", `/accounts/${AID}/workers/scripts`, r.value);
  assert.equal(w.status, 401);
  // /user/tokens/verify は 1000
  const u = await call(fake, "GET", "/user/tokens/verify", r.value);
  assert.equal(u.json.errors[0].code, 1000);
});

test("fake_expired_after_clock_advance: 期限を過ぎると verify の status が expired", async () => {
  const fake = createFakeCf({ accountId: AID });
  const t = fake.addToken({ name: "x", permissions: ["Account Analytics Read"], expires_on: new Date(fake.now().getTime() + 180_000).toISOString() });
  let v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, t.value);
  assert.equal(v.json.result.status, "active");
  fake.advance(240_000);
  v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, t.value);
  assert.equal(v.status, 200);
  assert.equal(v.json.success, true);
  assert.equal(v.json.result.status, "expired");
  assert.equal(v.json.result.expires_on, t.expires_on);
  // sleep は時計を進め、待った時間を残す
  await fake.sleep(5000);
  assert.deepEqual(fake.sleeps, [5000]);
  assert.equal(fake.now().getTime(), new Date("2026-11-14T05:52:39.000Z").getTime() + 245_000);
});

test("fake_disabled_status: 止めたトークンの verify は status disabled", async () => {
  const { fake, parent } = setup();
  fake.setStatus(parent.id, "disabled");
  const v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
  assert.equal(v.json.result.status, "disabled");
});

test("fake_parent_deletes_self_child_cannot: 親は自分を消せる・子は自分を消せない(9109)", async () => {
  const { fake, parent } = setup();
  const child = (await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody())).json.result;
  const own = await call(fake, "DELETE", `/accounts/${AID}/tokens/${child.id}`, child.value);
  assert.equal(own.status, 403);
  assert.equal(own.json.errors[0].code, 9109);
  assert.ok(fake.token(child.id), "子は残る");

  const self = await call(fake, "DELETE", `/accounts/${AID}/tokens/${parent.id}`, parent.value);
  assert.equal(self.status, 200);
  const v = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
  assert.equal(v.json.errors[0].code, 1000);
  // 消えた後の要求の履歴にも、どのトークンかの ID が残る
  assert.equal(fake.requests.at(-1).tokenId, parent.id);
});

test("fake_user_token_on_account_verify_is_1000: User API Token は accounts の verify で 1000、user の verify で active", async () => {
  const fake = createFakeCf({ accountId: AID });
  const u = fake.addToken({ name: "manual-user", kind: "user", permissions: ["Account Analytics Read"] });
  const a = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, u.value);
  assert.equal(a.status, 401);
  assert.equal(a.json.errors[0].code, 1000);
  const b = await call(fake, "GET", "/user/tokens/verify", u.value);
  assert.equal(b.status, 200);
  assert.equal(b.json.result.status, "active");
  // 形だけ合った知らない値も 1000
  const c = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, "cfat_" + "x".repeat(40));
  assert.equal(c.json.errors[0].code, 1000);
});

test("fake_drop_post_creates_but_throws: POST の応答を落とすと、サーバーの側では作られ、呼び出しには例外", async () => {
  const { fake, parent } = setup();
  fake.dropNext("createToken");
  await assert.rejects(call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody()), TypeError);
  const names = fake.tokens().map((t) => t.name);
  assert.ok(names.includes("wtt-usage-quiet-river-1a2b"));
  // 1 回だけ。次は普通に応える
  const again = await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody("wtt-deploy-quiet-river-1a2b"));
  assert.equal(again.status, 200);
});

test("fake_drop_delete_deletes_but_throws: DELETE の応答を落とすと、消えたうえで例外", async () => {
  const { fake, parent } = setup();
  const child = (await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody())).json.result;
  fake.dropNext("deleteToken");
  await assert.rejects(call(fake, "DELETE", `/accounts/${AID}/tokens/${child.id}`, parent.value), TypeError);
  assert.equal(fake.token(child.id), null);
  assert.equal(fake.deletedToken(child.id).id, child.id);
});

test("fake_network_error_does_not_reach_server: 通信の失敗はサーバーに届かない", async () => {
  const { fake, parent } = setup();
  fake.networkErrorNext("createToken");
  await assert.rejects(call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody()), TypeError);
  assert.ok(!fake.tokens().some((t) => t.name === "wtt-usage-quiet-river-1a2b"));
});

test("fake_rate_limit_next: 次の要求を 429 にし、retry-after を付ける。times の回数だけ", async () => {
  const { fake, parent } = setup();
  fake.rateLimitNext(2, { times: 2 });
  for (let i = 0; i < 2; i++) {
    const r = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "2");
    assert.equal(r.json.success, false);
  }
  const ok = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
  assert.equal(ok.status, 200);
  // route を絞った差し込みは、ほかの宛先には効かない
  fake.rateLimitNext(3, { route: "listTokens" });
  assert.equal((await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value)).status, 200);
  assert.equal((await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value)).status, 429);
});

test("fake_list_pages_and_fail_page_n: per_page で区切り、n ページ目だけを失敗させられる", async () => {
  const { fake, parent } = setup();
  for (let i = 0; i < 119; i++) fake.addToken({ name: `other-${i}`, permissions: ["Account Analytics Read"] });
  const p1 = await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value);
  assert.equal(p1.json.result.length, 50);
  assert.deepEqual(p1.json.result_info, { page: 1, per_page: 50, total_pages: 3, count: 50, total_count: 120 });
  const p3 = await call(fake, "GET", `/accounts/${AID}/tokens?page=3&per_page=50`, parent.value);
  assert.equal(p3.json.result.length, 20);

  fake.failListPage(2);
  assert.equal((await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value)).status, 200);
  const p2 = await call(fake, "GET", `/accounts/${AID}/tokens?page=2&per_page=50`, parent.value);
  assert.equal(p2.status, 500);
  assert.equal(p2.json.success, false);
  assert.equal((await call(fake, "GET", `/accounts/${AID}/tokens?page=2&per_page=50`, parent.value)).status, 200, "1 回だけ");
});

test("fake_list_result_info_switches: total_pages を除く・result_info を除く", async () => {
  const a = setup({ listResultInfo: "no_total_pages" });
  const ra = await call(a.fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, a.parent.value);
  assert.ok(!("total_pages" in ra.json.result_info));
  assert.equal(ra.json.result_info.total_count, 1);
  const b = setup({ listResultInfo: "none" });
  const rb = await call(b.fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, b.parent.value);
  assert.ok(!("result_info" in rb.json));
});

test("fake_permission_groups_in_one_response_without_result_info", async () => {
  const { fake, parent } = setup();
  const r = await call(fake, "GET", `/accounts/${AID}/tokens/permission_groups`, parent.value);
  assert.equal(r.status, 200);
  assert.ok(!("result_info" in r.json));
  const names = r.json.result.map((g) => g.name);
  for (const n of ["Account API Tokens Write", "Zone Read", "DNS Read", "Cache Settings Write", "Zone WAF Write", "Workers Scripts Write", "Account Analytics Read"]) {
    assert.equal(names.filter((x) => x === n).length, 1, n);
  }
  // 子(Account API Tokens Write が無い)は読めない
  const child = (await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody())).json.result;
  const denied = await call(fake, "GET", `/accounts/${AID}/tokens/permission_groups`, child.value);
  assert.equal(denied.status, 403);
});

test("fake_token_details_match_recorded_shape", async () => {
  const { fake, parent } = setup();
  const r = await call(fake, "GET", `/accounts/${AID}/tokens/${parent.id}`, parent.value);
  assert.equal(r.status, 200);
  const d = r.json.result;
  for (const k of ["id", "name", "status", "issued_on", "modified_on", "last_used_on", "not_before", "expires_on", "policies", "token_prefix", "token_suffix", "creator_email_at_creation"]) {
    assert.ok(k in d, k);
  }
  assert.ok(!("value" in d));
  assert.deepEqual(d.policies[0].resources, { [`com.cloudflare.api.account.${AID}`]: "*" });
  assert.deepEqual(d.policies[0].permission_groups, [{ id: groupId("Account API Tokens Write"), name: "Account API Tokens Write" }]);
  const missing = await call(fake, "GET", `/accounts/${AID}/tokens/${"9".repeat(32)}`, parent.value);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.errors[0].code, 1003);
});

test("fake_zones_by_name_with_oauth: OAuth の値で名前で引け、account.id と status が付く", async () => {
  const { fake } = setup({
    zones: [
      { id: ZID, name: "example.com", status: "active" },
      { id: ZID_OTHER, name: "example.net", status: "pending", accountId: OTHER_AID },
    ],
  });
  const oauth = fake.addOauth();
  const r = await call(fake, "GET", "/zones?name=example.net", oauth);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result.map((z) => ({ id: z.id, name: z.name, status: z.status, account: z.account.id })), [
    { id: ZID_OTHER, name: "example.net", status: "pending", account: OTHER_AID },
  ]);
  assert.deepEqual((await call(fake, "GET", "/zones?name=nothing.example", oauth)).json.result, []);
  assert.equal(fake.requests.at(-1).auth, "oauth");
});

test("fake_ruleset_entrypoint_10003_unless_present_and_permission_10000", async () => {
  const { fake, parent } = setup();
  const setupTok = fake.addToken({ name: "wtt-setup-x", permissions: ["Zone Read", "DNS Read", "Cache Settings Write", "Zone WAF Write"], zoneIds: [ZID] });
  const path = `/zones/${ZID}/rulesets/phases/http_ratelimit/entrypoint`;
  const none = await call(fake, "GET", path, setupTok.value);
  assert.equal(none.status, 404);
  assert.equal(none.json.errors[0].code, 10003);
  fake.addEntrypoint(ZID, "http_ratelimit");
  const has = await call(fake, "GET", path, setupTok.value);
  assert.equal(has.status, 200);
  assert.equal(has.json.result.phase, "http_ratelimit");
  // 権限の無いトークン(親)は 10000
  const denied = await call(fake, "GET", path, parent.value);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.errors[0].code, 10000);
  // 対象に無いゾーンも 10000
  const other = await call(fake, "GET", `/zones/${ZID_OTHER}/rulesets/phases/http_ratelimit/entrypoint`, setupTok.value);
  assert.equal(other.json.errors[0].code, 10000);
});

test("fake_worker_scripts_and_graphql", async () => {
  const { fake, parent } = setup();
  const deploy = fake.addToken({ name: "wtt-deploy-x", permissions: ["Workers Scripts Write"] });
  const w = await call(fake, "GET", `/accounts/${AID}/workers/scripts`, deploy.value);
  assert.equal(w.status, 200);
  assert.ok(Array.isArray(w.json.result));
  assert.equal((await call(fake, "GET", `/accounts/${AID}/workers/scripts`, parent.value)).json.errors[0].code, 10000);

  const query = `{ viewer { accounts(filter: { accountTag: "${AID}" }) { x: workersInvocationsAdaptive(limit: 1, filter: { date_geq: "2026-11-14", date_leq: "2026-11-14" }) { sum { requests } } } } }`;
  // 実機どおり、使用状況の権限の無いトークンでも通る
  const g = await call(fake, "POST", "/graphql", deploy.value, { query });
  assert.equal(g.status, 200);
  assert.equal(g.json.errors, null);
  assert.deepEqual(g.json.data, { viewer: { accounts: [{ x: [] }] } });
  // 使えない値は 200 で errors(実機で未確認の既定)
  const bad = await call(fake, "POST", "/graphql", "nope", { query });
  assert.equal(bad.status, 200);
  assert.ok(bad.json.errors.length > 0);
});

test("fake_fail_reach_n_times_then_ok: 届き先を n 回だけ失敗させる", async () => {
  const { fake } = setup();
  const deploy = fake.addToken({ name: "wtt-deploy-x", permissions: ["Workers Scripts Write"] });
  fake.failReach("workerScripts", 2);
  for (let i = 0; i < 2; i++) {
    const r = await call(fake, "GET", `/accounts/${AID}/workers/scripts`, deploy.value);
    assert.equal(r.status, 403);
    assert.equal(r.json.errors[0].code, 10000);
  }
  assert.equal((await call(fake, "GET", `/accounts/${AID}/workers/scripts`, deploy.value)).status, 200);
  // graphql は 200 で errors
  fake.failReach("graphql", 1);
  const g = await call(fake, "POST", "/graphql", deploy.value, { query: `{ viewer { accounts(filter: { accountTag: "${AID}" }) { x: workersInvocationsAdaptive(limit: 1) { sum { requests } } } } }` });
  assert.equal(g.status, 200);
  assert.ok(g.json.errors.length > 0);
});

test("fake_respond_and_non_json_injection", async () => {
  const { fake, parent } = setup();
  fake.failNext("verify", { status: 502, text: "<html>bad gateway</html>" });
  const r = await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
  assert.equal(r.status, 502);
  assert.equal(r.json, null);
  fake.failNext({ route: "tokenDetails", match: (e) => e.id === parent.id }, { status: 500, body: { success: false, errors: [{ code: 10001, message: "x" }] } });
  assert.equal((await call(fake, "GET", `/accounts/${AID}/tokens/${parent.id}`, parent.value)).status, 500);
});

test("fake_history_records_method_route_path_in_order_without_values", async () => {
  const { fake, parent } = setup();
  await call(fake, "GET", `/accounts/${AID}/tokens/verify`, parent.value);
  await call(fake, "GET", `/accounts/${AID}/tokens?page=1&per_page=50`, parent.value);
  await call(fake, "POST", `/accounts/${AID}/tokens`, parent.value, usageBody());
  const h = fake.requests;
  assert.deepEqual(h.map((e) => [e.method, e.route, e.path]), [
    ["GET", "verify", `/accounts/${AID}/tokens/verify`],
    ["GET", "listTokens", `/accounts/${AID}/tokens`],
    ["POST", "createToken", `/accounts/${AID}/tokens`],
  ]);
  assert.equal(h[1].page, 1);
  assert.deepEqual(h[1].query, { page: "1", per_page: "50" });
  assert.equal(h[2].body.name, "wtt-usage-quiet-river-1a2b");
  assert.equal(h[0].tokenId, parent.id);
  assert.ok(!JSON.stringify(h).includes(parent.value), "履歴に値を残さない");
  assert.equal(fake.count("createToken"), 1);
  assert.equal(fake.count({ method: "GET" }), 2);
  fake.clearRequests();
  assert.equal(fake.requests.length, 0);
});

test("fake_truncate_next_creates_then_body_fails: 成立させたうえで、状態コード 200 の本文の読みを失敗させる(Task 6a fix)", async () => {
  const { fake, parent } = setup();
  fake.truncateNext("createToken");
  const res = await fake.fetch(`${BASE}/accounts/${AID}/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${parent.value}`, "Content-Type": "application/json" },
    body: JSON.stringify(usageBody()),
  });
  assert.equal(res.status, 200);
  await assert.rejects(() => res.text());
  assert.equal(fake.tokens().filter((x) => x.name === "wtt-usage-quiet-river-1a2b").length, 1, "サーバーの側では作られている");
});

test("fake_token_details_and_delete_ignore_other_account_tokens: 別のアカウントのトークンは詳細も DELETE も 404・1003(Task 6a)", async () => {
  const { fake, parent } = setup();
  const foreign = fake.addToken({ name: "wtt-deploy-quiet-river-1a2b", permissions: ["Workers Scripts Write"], account: OTHER_AID });
  const d = await call(fake, "GET", `/accounts/${AID}/tokens/${foreign.id}`, parent.value);
  assert.equal(d.status, 404);
  assert.equal(d.json.errors[0].code, 1003);
  const del = await call(fake, "DELETE", `/accounts/${AID}/tokens/${foreign.id}`, parent.value);
  assert.equal(del.status, 404);
  assert.equal(del.json.errors[0].code, 1003);
  assert.ok(fake.token(foreign.id), "別のアカウントのトークンは消えない");
});
