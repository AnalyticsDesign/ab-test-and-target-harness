import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, checkAnswers, checkConfigured, isConfigured, isBlank, hostProblem, hostInZone, featuresOf } from "../questions.mjs";

const ok = { features: ["ab"], daily_pv: "under_10k", image_upload: false, cloudflare_account: "none", site_on_cloudflare: "no_site", owner_email: "a@example.com" };
const ids = (issues) => issues.map((i) => i.id);

test("質問の表は 9 問で、ID の順が N1 N2 N3 E1 E1b E2 E2a E2b E3", () => {
  assert.deepEqual(QUESTIONS.map((q) => q.id), ["N1", "N2", "N3", "E1", "E1b", "E2", "E2a", "E2b", "E3"]);
});

test("すべて答えていれば問題なし", () => {
  assert.deepEqual(checkAnswers(ok), []);
});

test("未記入(無い・空・プレースホルダ・空の配列)は未回答として ID を返す", () => {
  const issues = checkAnswers({ ...ok, features: [], daily_pv: "<under_10k / …>", image_upload: null, owner_email: undefined });
  assert.deepEqual(ids(issues), ["N1", "N2", "N3", "E3"]);
  assert.ok(issues.every((i) => i.message === "未回答"));
});

test("条件付きの問い: E1b は existing のときだけ、E2a は yes のときだけ聞く", () => {
  assert.deepEqual(ids(checkAnswers({ ...ok, cloudflare_account: "existing" })), ["E1b"]);
  assert.deepEqual(ids(checkAnswers({ ...ok, cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes" })), ["E2a"]);
});

test("E2b(止まると困る Worker)は、既存の Free のアカウント × ドメインなし(no / no_site)のときだけ聞く", () => {
  const free = { ...ok, cloudflare_account: "existing", existing_plan: "free" };
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no_site" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no", other_workers: "unknown" })), []);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "yes", install_host: "www.example.com" })), []);
  assert.deepEqual(ids(checkAnswers({ ...free, existing_plan: "paid", site_on_cloudflare: "no" })), []);
  assert.deepEqual(ids(checkAnswers({ ...ok, site_on_cloudflare: "no" })), []);
  assert.equal(checkAnswers({ ...free, site_on_cloudflare: "no", other_workers: "maybe" })[0].id, "E2b");
});

test("選択肢に無い値は、選べる値を添えて返す", () => {
  const [i] = checkAnswers({ ...ok, daily_pv: "lots" });
  assert.equal(i.id, "N2");
  assert.match(i.message, /under_10k/);
  assert.deepEqual(ids(checkAnswers({ ...ok, features: ["ab", "seo"] })), ["N1"]);
  assert.deepEqual(ids(checkAnswers({ ...ok, image_upload: "yes" })), ["N3"]);
});

test("URL をそのまま貼ったホストは、候補を示して聞き直す", () => {
  const [i] = checkAnswers({ ...ok, cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "https://www.Example.com/path?q=1" });
  assert.equal(i.id, "E2a");
  assert.match(i.message, /候補: www\.example\.com/);
  assert.equal(hostProblem("www.example.com"), null);
  assert.match(hostProblem("example"), /ホストの形/);
});

test("features をカンマ区切りの文字列で書いたら、複数の書き方を示す", () => {
  const [i] = checkAnswers({ ...ok, features: "ab, history" });
  assert.equal(i.id, "N1");
  assert.match(i.message, /複数は \[ab, history\] の形で書く/);
});

test("国際化ドメイン名のホストは、punycode の形を候補に示す", () => {
  assert.match(hostProblem("www.例え.jp"), /候補: www\.xn--r8jz45g\.jp/);
  assert.match(hostProblem("https://www.例え.jp/path"), /候補: www\.xn--r8jz45g\.jp/);
  assert.match(hostProblem("例え"), /ホストの形/);
});

test("メールアドレスの形でなければ E3", () => {
  assert.deepEqual(ids(checkAnswers({ ...ok, owner_email: "a@b" })), ["E3"]);
});

test("ドメインを管理しているのに新しいアカウント → E1 と E2 を聞き直す", () => {
  for (const acct of ["none", "separate"]) {
    const issues = checkAnswers({ ...ok, cloudflare_account: acct, site_on_cloudflare: "yes", install_host: "www.example.com" });
    assert.deepEqual(ids(issues), ["E1", "E2"]);
  }
});

test("featuresOf は ab を必ず含める", () => {
  assert.deepEqual([...featuresOf({ features: ["history"] })].sort(), ["ab", "history"]);
  assert.deepEqual([...featuresOf({ features: "itp" })].sort(), ["ab", "itp"]);
  assert.deepEqual([...featuresOf({ features: "<ab / history / itp>" })], ["ab"]);
});

test("isBlank と hostInZone", () => {
  for (const v of [null, undefined, "", "<x>", []]) assert.equal(isBlank(v), true);
  for (const v of [false, "x", ["ab"]]) assert.equal(isBlank(v), false);
  assert.equal(hostInZone("www.example.com", "example.com"), true);
  assert.equal(hostInZone("example.com", "example.com"), true);
  assert.equal(hostInZone("www.badexample.com", "example.com"), false);
});

test("isConfigured: 構成のキーか accepted が 1 つでもあれば構成の検査に回る", () => {
  assert.equal(isConfigured(ok), false);
  assert.equal(isConfigured({ ...ok, edge_address: "workers-dev" }), true);
  assert.equal(isConfigured({ accepted: "manual" }), true);
});

test("checkConfigured: 手で書いた構成の矛盾", () => {
  const base = { owner_email: "a@example.com", edge_address: "workers-dev", asset_public_base: "none" };
  assert.deepEqual(checkConfigured(base), []);
  assert.deepEqual(ids(checkConfigured({ ...base, edge_address: "route" })), ["install_host", "zone_name"]);
  assert.deepEqual(checkConfigured({ ...base, edge_address: "route", install_host: "www.example.com", zone_name: "auto", asset_public_base: "auto" }), []);
  assert.deepEqual(ids(checkConfigured({ ...base, edge_address: "route", install_host: "www.example.com", zone_name: "other.com" })), ["zone_name"]);
  assert.deepEqual(ids(checkConfigured({ ...base, asset_public_base: "auto" })), ["asset_public_base"]);
  assert.deepEqual(ids(checkConfigured({ ...base, asset_public_base: "http://assets.example.com" })), ["asset_public_base"]);
  assert.deepEqual(checkConfigured({ ...base, asset_public_base: "https://assets.example.com" }), []);
  assert.deepEqual(ids(checkConfigured({ ...base, dlite_hosts: ["www.example.com"] })), ["dlite_hosts"]);
  assert.deepEqual(ids(checkConfigured({ ...base, plan: "pro" })), ["plan"]);
  assert.deepEqual(ids(checkConfigured({ ...base, accepted: "yes" })), ["accepted"]);
  assert.deepEqual(ids(checkConfigured({ edge_address: "workers-dev", asset_public_base: "none" })), ["owner_email"]);
  assert.deepEqual(ids(checkConfigured({ owner_email: "a@example.com", edge_address: "workers-dev" })), ["asset_public_base"]);
});

test("dlite_hosts の各要素はホストの形。accepted が空の行は未了承として扱う", () => {
  const base = { owner_email: "a@example.com", edge_address: "route", install_host: "www.example.com", zone_name: "example.com", asset_public_base: "none" };
  assert.deepEqual(ids(checkConfigured({ ...base, dlite_hosts: ["https://other.com/path"] })), ["dlite_hosts"]);
  assert.deepEqual(checkConfigured({ ...base, dlite_hosts: ["www.example.com"], accepted: null }), []);
  assert.equal(isConfigured({ accepted: null, edge_address: null }), false);
});

test("checkConfigured: 上段で既存の Paid のアカウントと答えたのに plan: free(既定を含む)なら plan の問い", () => {
  const base = { owner_email: "a@example.com", edge_address: "workers-dev", asset_public_base: "none", cloudflare_account: "existing", existing_plan: "paid" };
  assert.deepEqual(ids(checkConfigured(base)), ["plan"]);
  assert.deepEqual(ids(checkConfigured({ ...base, plan: "free" })), ["plan"]);
  assert.match(checkConfigured(base)[0].message, /cloudflare_account: separate/);
  assert.deepEqual(checkConfigured({ ...base, plan: "paid" }), []);
  assert.deepEqual(checkConfigured({ ...base, cloudflare_account: "separate" }), []);
  assert.deepEqual(checkConfigured({ ...base, existing_plan: "free" }), []);
});
