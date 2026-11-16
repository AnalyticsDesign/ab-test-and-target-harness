// 作るトークンの表と要るゾーン・POST の本文・親の詳細の照合のテスト(B130 Task 5)。純粋な関数だけで、API は呼ばない
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswers } from "../../deploy-answers/parse.mjs";
import {
  ROLES, ENV_KEY, PERMISSIONS, PARENT_MAX_LIFETIME_MS,
  tokenName, zoneHostsOf, zoneCandidates, createBody, checkParentDetails,
} from "../lib/spec.mjs";

const AID = "0123456789abcdef0123456789abcdef";
const ZID = "fedcba9876543210fedcba9876543210";
const ZID2 = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
const IDENT = "quiet-river-1a2b";
const NOW = new Date("2026-11-14T05:52:39.123Z");

/** 答えファイルの文字列から値を読む(parseAnswers を通して、本物の形で試す) */
const answers = (text) => {
  const { values, errors } = parseAnswers(text);
  assert.deepEqual(errors, []);
  return values;
};

const GROUP_IDS = {
  "Account API Tokens Write": "g-parent",
  "Zone Read": "g-zone-read",
  "DNS Read": "g-dns-read",
  "Cache Settings Write": "g-cache",
  "Zone WAF Write": "g-waf",
  "Workers Scripts Write": "g-workers",
  "Account Analytics Read": "g-analytics",
};

/** 通りの親の詳細(GET /accounts/<ID>/tokens/<id> の result の形) */
const goodParent = (over = {}) => ({
  id: "p1",
  name: `wtt-bootstrap-${IDENT}`,
  status: "active",
  not_before: "2026-11-14T00:00:00Z",
  expires_on: "2026-11-15T14:59:59Z",
  policies: [
    {
      effect: "allow",
      permission_groups: [{ id: "g-parent", name: "Account API Tokens Write" }],
      resources: { [`com.cloudflare.api.account.${AID}`]: "*" },
    },
  ],
  ...over,
});

test("constants_match_the_table", () => {
  assert.deepEqual(ROLES, ["setup", "deploy", "usage"]);
  assert.deepEqual(ENV_KEY, { parent: "CF_BOOTSTRAP_TOKEN", setup: "CF_TOKEN", deploy: "CF_DEPLOY_TOKEN", usage: "CF_USAGE_TOKEN" });
  assert.equal(PARENT_MAX_LIFETIME_MS, 48 * 60 * 60 * 1000);
  assert.deepEqual(PERMISSIONS.parent, [["Account API Tokens Write", "com.cloudflare.api.account"]]);
  assert.deepEqual(PERMISSIONS.setup.map(([n]) => n), ["Zone Read", "DNS Read", "Cache Settings Write", "Zone WAF Write"]);
  assert.ok(PERMISSIONS.setup.every(([, scope]) => scope === "com.cloudflare.api.account.zone"));
  assert.deepEqual(PERMISSIONS.deploy, [["Workers Scripts Write", "com.cloudflare.api.account"]]);
  assert.deepEqual(PERMISSIONS.usage, [["Account Analytics Read", "com.cloudflare.api.account"]]);
});

test("token_name_per_role", () => {
  assert.equal(tokenName("parent", IDENT), "wtt-bootstrap-quiet-river-1a2b");
  assert.equal(tokenName("setup", IDENT), "wtt-setup-quiet-river-1a2b");
  assert.equal(tokenName("deploy", IDENT), "wtt-deploy-quiet-river-1a2b");
  assert.equal(tokenName("usage", IDENT), "wtt-usage-quiet-river-1a2b");
  assert.throws(() => tokenName("admin", IDENT), /役割/);
});

test("ident_rejects_dots_and_upper", () => {
  for (const bad of ["example.com", "Quiet-River", "", "a".repeat(64), "a b", "a_b", undefined, 12]) {
    assert.throws(() => tokenName("deploy", bad), /識別子/, `${String(bad)} は断る`);
  }
  assert.equal(tokenName("deploy", "a".repeat(63)), `wtt-deploy-${"a".repeat(63)}`);
  assert.equal(tokenName("deploy", "0"), "wtt-deploy-0");
});

test("route_needs_zone_name_only", () => {
  const v = answers("edge_address: route\nzone_name: example.com\ncontrol_address: workers-dev\nadmin_address: workers-dev\n");
  assert.deepEqual(zoneHostsOf(v), ["example.com"]);
  assert.deepEqual(zoneHostsOf(answers("edge_address: custom-domain\nzone_name: example.co.jp\n")), ["example.co.jp"]);
  // control_address / admin_address の行が無くても workers-dev 扱い
  assert.deepEqual(zoneHostsOf(answers("edge_address: route\nzone_name: example.com\n")), ["example.com"]);
});

test("workers_dev_without_custom_needs_no_setup", () => {
  assert.deepEqual(zoneHostsOf(answers("edge_address: workers-dev\n")), []);
  // workers-dev のとき、残っている zone_name は見ない
  assert.deepEqual(zoneHostsOf(answers("edge_address: workers-dev\nzone_name: example.com\ncontrol_address: workers-dev\nadmin_address: workers-dev\n")), []);
});

test("custom_control_in_other_zone_adds_host", () => {
  const v = answers("edge_address: route\nzone_name: example.com\ncontrol_address: custom\ncontrol_host: control.example.net\nadmin_address: custom\nadmin_host: admin.example.co.jp\n");
  assert.deepEqual(zoneHostsOf(v), ["example.com", "control.example.net", "admin.example.co.jp"]);
  // workers-dev の構成で、control だけ自分のドメインに置く
  const w = answers("edge_address: workers-dev\ncontrol_address: custom\ncontrol_host: control.example.net\nadmin_address: workers-dev\n");
  assert.deepEqual(zoneHostsOf(w), ["control.example.net"]);
});

test("duplicate_hosts_are_removed", () => {
  const v = answers("edge_address: route\nzone_name: example.com\ncontrol_address: custom\ncontrol_host: example.com\nadmin_address: custom\nadmin_host: example.com\n");
  assert.deepEqual(zoneHostsOf(v), ["example.com"]);
});

test("unconfigured_answers_throw", () => {
  for (const text of ["", "edge_address:\n", "edge_address: <未記入>\n"]) {
    assert.throws(() => zoneHostsOf(answers(text)), /--accept/, JSON.stringify(text));
  }
  assert.throws(() => zoneHostsOf(answers("edge_address: elsewhere\n")), /edge_address/);
  // route なのに zone_name が空
  assert.throws(() => zoneHostsOf(answers("edge_address: route\n")), /zone_name/);
});

test("zone_name_auto_throws_with_resolve_hint", () => {
  assert.throws(() => zoneHostsOf(answers("edge_address: route\nzone_name: auto\n")), /--resolve-zone/);
  assert.throws(() => zoneHostsOf(answers("edge_address: custom-domain\nzone_name: auto\n")), /--resolve-zone/);
  // workers-dev のとき auto の行は見ない(ゾーンを使わない)
  assert.deepEqual(zoneHostsOf(answers("edge_address: workers-dev\nzone_name: auto\n")), []);
});

test("custom_host_missing_or_malformed_throws", () => {
  const base = "edge_address: route\nzone_name: example.com\n";
  for (const [addr, host] of [["control_address", "control_host"], ["admin_address", "admin_host"]]) {
    assert.throws(() => zoneHostsOf(answers(`${base}${addr}: custom\n`)), new RegExp(host), `${host} が無い`);
    assert.throws(() => zoneHostsOf(answers(`${base}${addr}: custom\n${host}:\n`)), new RegExp(host), `${host} が空`);
    assert.throws(() => zoneHostsOf(answers(`${base}${addr}: custom\n${host}: https://x.example.com/\n`)), new RegExp(host), `${host} が URL`);
    assert.throws(() => zoneHostsOf(answers(`${base}${addr}: custom\n${host}: Control.Example.com\n`)), new RegExp(host), `${host} が大文字`);
    // workers-dev のときの余った host の行は見ない
    assert.deepEqual(zoneHostsOf(answers(`${base}${addr}: workers-dev\n${host}: not a host\n`)), ["example.com"]);
  }
  assert.throws(() => zoneHostsOf(answers("edge_address: route\nzone_name: not a zone\n")), /zone_name/);
  assert.throws(() => zoneHostsOf(answers(`${base}control_address: both\n`)), /control_address/);
});

test("zone_candidates_longest_first", () => {
  assert.deepEqual(zoneCandidates("admin.example.co.jp"), ["admin.example.co.jp", "example.co.jp", "co.jp"]);
  assert.deepEqual(zoneCandidates("a.b.example.com"), ["a.b.example.com", "b.example.com", "example.com"]);
});

test("zone_candidates_prefer_host_itself", () => {
  // ホスト自身が先。呼ぶ側は最初に当たった(最も長い)名前を採るので、委譲されたサブドメインのゾーンが親のゾーンより先に採られる
  const c = zoneCandidates("control.example.com");
  assert.equal(c[0], "control.example.com");
  assert.equal(c[1], "example.com");
});

test("custom_control_at_zone_apex_resolves", () => {
  // ホストがゾーンの名前そのもの。候補は 1 つ(最後の 1 ラベル = TLD だけの名前は引かない)
  assert.deepEqual(zoneCandidates("example.com"), ["example.com"]);
  assert.deepEqual(zoneCandidates("example.co.jp"), ["example.co.jp", "co.jp"]);
  // 決まった zone_name は完全一致で 1 回だけ引く
  assert.deepEqual(zoneCandidates("example.co.jp", { exact: true }), ["example.co.jp"]);
  const v = answers("edge_address: workers-dev\ncontrol_address: custom\ncontrol_host: example.com\n");
  assert.deepEqual(zoneHostsOf(v).flatMap((h) => zoneCandidates(h)), ["example.com"]);
});

test("zone_candidates_reject_non_hosts", () => {
  assert.throws(() => zoneCandidates("com"), /ホスト/);
  assert.throws(() => zoneCandidates("Example.com"), /ホスト/);
  assert.throws(() => zoneCandidates(""), /ホスト/);
});

test("setup_body_expires_24h", () => {
  const body = createBody("setup", { ident: IDENT, accountId: AID, zoneIds: [ZID, ZID2], groupIds: GROUP_IDS, now: NOW });
  assert.equal(body.name, `wtt-setup-${IDENT}`);
  assert.equal(body.expires_on, "2026-11-15T05:52:39Z");
  assert.equal(body.policies.length, 1);
  const [p] = body.policies;
  assert.equal(p.effect, "allow");
  assert.deepEqual(p.resources, {
    [`com.cloudflare.api.account.zone.${ZID}`]: "*",
    [`com.cloudflare.api.account.zone.${ZID2}`]: "*",
  });
  assert.deepEqual(p.permission_groups, [{ id: "g-zone-read" }, { id: "g-dns-read" }, { id: "g-cache" }, { id: "g-waf" }]);
  // ゾーン ID の重複は 1 つにする
  const dup = createBody("setup", { ident: IDENT, accountId: AID, zoneIds: [ZID, ZID], groupIds: GROUP_IDS, now: NOW });
  assert.deepEqual(Object.keys(dup.policies[0].resources), [`com.cloudflare.api.account.zone.${ZID}`]);
  // now は ISO 文字列・ミリ秒でも同じ
  const s = createBody("setup", { ident: IDENT, accountId: AID, zoneIds: [ZID], groupIds: GROUP_IDS, now: NOW.toISOString() });
  assert.equal(s.expires_on, "2026-11-15T05:52:39Z");
  const n = createBody("setup", { ident: IDENT, accountId: AID, zoneIds: [ZID], groupIds: GROUP_IDS, now: NOW.getTime() });
  assert.equal(n.expires_on, "2026-11-15T05:52:39Z");
});

test("deploy_body_has_no_expiry_and_account_resource", () => {
  const d = createBody("deploy", { ident: IDENT, accountId: AID, zoneIds: [], groupIds: GROUP_IDS, now: NOW });
  assert.equal(d.name, `wtt-deploy-${IDENT}`);
  assert.equal("expires_on" in d, false);
  assert.deepEqual(d.policies, [{
    effect: "allow",
    resources: { [`com.cloudflare.api.account.${AID}`]: "*" },
    permission_groups: [{ id: "g-workers" }],
  }]);
  const u = createBody("usage", { ident: IDENT, accountId: AID, zoneIds: [ZID], groupIds: GROUP_IDS, now: NOW });
  assert.equal(u.name, `wtt-usage-${IDENT}`);
  assert.equal("expires_on" in u, false);
  // アカウント対象の権限にゾーン ID は混ざらない
  assert.deepEqual(u.policies[0].resources, { [`com.cloudflare.api.account.${AID}`]: "*" });
  assert.deepEqual(u.policies[0].permission_groups, [{ id: "g-analytics" }]);
});

test("create_body_rejects_bad_input", () => {
  const ok = { ident: IDENT, accountId: AID, zoneIds: [ZID], groupIds: GROUP_IDS, now: NOW };
  assert.throws(() => createBody("parent", ok), /役割/);
  assert.throws(() => createBody("setup", { ...ok, zoneIds: [] }), /ゾーン/);
  assert.throws(() => createBody("setup", { ...ok, groupIds: { ...GROUP_IDS, "Zone WAF Write": undefined } }), /Zone WAF Write/);
  assert.throws(() => createBody("deploy", { ...ok, groupIds: {} }), /Workers Scripts Write/);
  assert.throws(() => createBody("deploy", { ...ok, ident: "Bad.Ident" }), /識別子/);
  assert.throws(() => createBody("deploy", { ...ok, accountId: "" }), /アカウント/);
  assert.throws(() => createBody("setup", { ...ok, now: "not a date" }), /now/);
});

test("parent_details_ok", () => {
  assert.deepEqual(checkParentDetails(goodParent(), { ident: IDENT, accountId: AID, now: NOW }), []);
  // ちょうど上限の期限も通る
  const edge = new Date(NOW.getTime() + PARENT_MAX_LIFETIME_MS).toISOString();
  assert.deepEqual(checkParentDetails(goodParent({ expires_on: edge }), { ident: IDENT, accountId: AID, now: NOW }), []);
  // 権限が 2 つのポリシーに分かれていても、名前の集合と対象が合えば通る
  const split = goodParent({
    policies: [
      { effect: "allow", permission_groups: [{ name: "Account API Tokens Write" }], resources: { [`com.cloudflare.api.account.${AID}`]: "*" } },
      { effect: "allow", permission_groups: [{ name: "Account API Tokens Write" }], resources: { [`com.cloudflare.api.account.${AID}`]: "*" } },
    ],
  });
  assert.deepEqual(checkParentDetails(split, { ident: IDENT, accountId: AID, now: NOW }), []);
});

const check = (details) => checkParentDetails(details, { ident: IDENT, accountId: AID, now: NOW });

test("parent_details_extra_permission", () => {
  const d = goodParent();
  d.policies[0].permission_groups.push({ id: "g-x", name: "Zone Read" });
  const out = check(d);
  assert.equal(out.length, 1);
  assert.match(out[0], /権限/);
  assert.match(out[0], /Zone Read/);
});

test("parent_details_missing_permission", () => {
  const d = goodParent();
  d.policies[0].permission_groups = [];
  const out = check(d);
  assert.equal(out.length, 1);
  assert.match(out[0], /権限/);
});

test("parent_details_wrong_name", () => {
  const out = check(goodParent({ name: "wtt-bootstrap-someone-else" }));
  assert.equal(out.length, 1);
  assert.match(out[0], /名前/);
  assert.match(out[0], new RegExp(`wtt-bootstrap-${IDENT}`));
});

test("parent_details_other_account", () => {
  const d = goodParent();
  d.policies[0].resources = { "com.cloudflare.api.account.ffffffffffffffffffffffffffffffff": "*" };
  const out = check(d);
  assert.equal(out.length, 1);
  assert.match(out[0], /対象/);
  // 自分のアカウントのほかにゾーンも持つ
  const e = goodParent();
  e.policies[0].resources[`com.cloudflare.api.account.zone.${ZID}`] = "*";
  assert.equal(check(e).length, 1);
  // 対象が空・値が "*" でない
  const f = goodParent();
  f.policies[0].resources = {};
  assert.equal(check(f).length, 1);
  const g = goodParent();
  g.policies[0].resources[`com.cloudflare.api.account.${AID}`] = "x";
  assert.equal(check(g).length, 1);
});

test("parent_details_no_expiry", () => {
  for (const exp of [undefined, null, ""]) {
    const out = check(goodParent({ expires_on: exp }));
    assert.equal(out.length, 1, String(exp));
    assert.match(out[0], /期限/);
  }
});

test("parent_details_expiry_too_long", () => {
  const out = check(goodParent({ expires_on: new Date(NOW.getTime() + PARENT_MAX_LIFETIME_MS + 1000).toISOString() }));
  assert.equal(out.length, 1);
  assert.match(out[0], /期限/);
  assert.match(out[0], /48 時間/);
  assert.equal(check(goodParent({ expires_on: "garbage" })).length, 1);
});

test("parent_not_yet_valid_message_mentions_start", () => {
  const out = check(goodParent({ not_before: "2026-11-15T00:00:00Z" }));
  assert.equal(out.length, 1);
  assert.match(out[0], /開始/);
  // 開始が過去・無しは差ではない
  assert.deepEqual(check(goodParent({ not_before: undefined })), []);
  assert.deepEqual(check(goodParent({ not_before: "2026-11-14T05:52:39Z" })), []);
});

test("parent_details_multiple_differences_are_separate_lines", () => {
  const d = goodParent({ name: "x", expires_on: null, not_before: "2026-11-20T00:00:00Z" });
  d.policies[0].permission_groups.push({ name: "DNS Read" });
  assert.equal(check(d).length, 4);
  assert.ok(check(null).length >= 1);
  assert.ok(check({}).length >= 1);
});

test("parent_details_messages_carry_no_secret_shaped_values", () => {
  // 文に入れてよいのは名前・権限の名前・ID・期限だけ。詳細にトークンの値のような項目があっても写さない
  const d = goodParent({ name: "x", value: "SECRET-TOKEN-VALUE", secret: "SECRET-TOKEN-VALUE" });
  assert.ok(check(d).every((line) => !line.includes("SECRET-TOKEN-VALUE")));
});

test("parent_details_unreadable_parts_are_not_passed", () => {
  const second = (over) => ({ effect: "allow", permission_groups: [{ id: "g-parent", name: "Account API Tokens Write" }], resources: { [`com.cloudflare.api.account.${AID}`]: "*" }, ...over });
  const cases = {
    name_less_group: () => { const d = goodParent(); d.policies[0].permission_groups.push({ id: "g-extra" }); return d; },
    resources_is_string: () => goodParent({ policies: [...goodParent().policies, second({ resources: "com.cloudflare.api.account.*" })] }),
    resources_missing: () => { const s = second({}); delete s.resources; return goodParent({ policies: [...goodParent().policies, s] }); },
    resources_is_array: () => goodParent({ policies: [...goodParent().policies, second({ resources: [] })] }),
    permission_groups_is_object: () => goodParent({ policies: [...goodParent().policies, second({ permission_groups: { name: "Zone Read" } })] }),
    effect_missing: () => { const d = goodParent(); delete d.policies[0].effect; return d; },
    policies_has_string: () => goodParent({ policies: [...goodParent().policies, "x"] }),
    policies_has_null: () => goodParent({ policies: [...goodParent().policies, null] }),
    group_is_null: () => { const d = goodParent(); d.policies[0].permission_groups.push(null); return d; },
  };
  for (const [label, make] of Object.entries(cases)) {
    const out = check(make());
    assert.ok(out.some((line) => /読めない/.test(line)), `${label}: 読めない部分を出す(今: ${JSON.stringify(out)})`);
  }
  // 読めない部分の文は値を含めない
  const d = goodParent({ policies: [...goodParent().policies, second({ resources: "SECRET-TOKEN-VALUE" })] });
  assert.ok(check(d).every((line) => !line.includes("SECRET-TOKEN-VALUE")));
});

test("parent_details_deny_policy_is_reported", () => {
  const d = goodParent();
  d.policies.push({ ...d.policies[0], effect: "deny" });
  const out = check(d);
  assert.equal(out.length, 1);
  assert.match(out[0], /allow/);
});

test("create_body_rejects_non_array_zone_ids", () => {
  const ok = { ident: IDENT, accountId: AID, groupIds: GROUP_IDS, now: NOW };
  assert.throws(() => createBody("setup", { ...ok, zoneIds: ZID }), /ゾーン/);
  assert.throws(() => createBody("setup", { ...ok, zoneIds: undefined }), /ゾーン/);
  assert.throws(() => createBody("setup", { ...ok, zoneIds: null }), /ゾーン/);
  // アカウント対象だけの役割は zoneIds を見ない
  assert.equal(createBody("deploy", { ...ok, zoneIds: undefined }).name, `wtt-deploy-${IDENT}`);
});
