import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, checkAnswers, checkConfigured, isConfigured, isBlank, hostProblem, hostInZone, featuresOf } from "../questions.mjs";

const ok = { features: ["ab"], daily_pv: "under_10k", image_upload: false, cloudflare_account: "none", site_on_cloudflare: "no_site", owner_email: "a@example.com" };
const ids = (issues) => issues.map((i) => i.id);

test("質問の表は 10 問で、ID の順が N1 N2 N3 E1 E1b E2 E2a E2b E2c E3", () => {
  assert.deepEqual(QUESTIONS.map((q) => q.id), ["N1", "N2", "N3", "E1", "E1b", "E2", "E2a", "E2b", "E2c", "E3"]);
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
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no", edge_host: "none" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no_site" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no", edge_host: "none", other_workers: "unknown" })), []);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "yes", install_host: "www.example.com" })), []);
  assert.deepEqual(ids(checkAnswers({ ...free, existing_plan: "paid", site_on_cloudflare: "no", edge_host: "none" })), []);
  assert.deepEqual(ids(checkAnswers({ ...ok, site_on_cloudflare: "no", edge_host: "none" })), []);
  assert.equal(checkAnswers({ ...free, site_on_cloudflare: "no", edge_host: "none", other_workers: "maybe" })[0].id, "E2b");
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

test("E2c(別のドメインのホスト)は E2 = no のときだけ聞く。値はホストか none(決定 64 (3))", () => {
  const no = { ...ok, site_on_cloudflare: "no" };
  const [blank] = checkAnswers(no);
  assert.deepEqual([blank.id, blank.key, blank.message], ["E2c", "edge_host", "未回答"]);
  assert.deepEqual(checkAnswers({ ...no, edge_host: "none" }), []);
  assert.deepEqual(checkAnswers({ ...no, edge_host: "ab.example.net" }), []);
  const [url] = checkAnswers({ ...no, edge_host: "https://ab.example.net/" });
  assert.equal(url.id, "E2c");
  assert.match(url.message, /ホストだけを書く\(候補: ab\.example\.net\)/);
  assert.deepEqual(ids(checkAnswers({ ...ok, site_on_cloudflare: "yes", cloudflare_account: "existing", existing_plan: "free", install_host: "www.example.com" })), []);
  assert.deepEqual(ids(checkAnswers({ ...ok, site_on_cloudflare: "no_site" })), []);
});

test("checkConfigured: edge_address: custom-domain(別のドメインのホストで公開。決定 64 (3))", () => {
  // install_host は custom-domain では要らない(base に無くても問題なし)
  const base = { owner_email: "a@example.com", edge_address: "custom-domain", edge_host: "ab.example.net", zone_name: "example.net", asset_public_base: "none" };
  assert.deepEqual(checkConfigured(base), []);
  const { edge_host: _h, ...noHost } = base;
  const [missing] = checkConfigured(noHost);
  assert.deepEqual([missing.id, missing.message], ["edge_host", "edge_address: custom-domain のときは必須"]);
  assert.deepEqual(ids(checkConfigured({ ...base, edge_host: "none" })), ["edge_host"]);
  assert.match(checkConfigured({ ...base, edge_host: "none" })[0].message, /ホストの形/);
  const { zone_name: _z, ...noZone } = base;
  const [zone] = checkConfigured(noZone);
  assert.deepEqual([zone.id, zone.message], ["zone_name", "edge_address: custom-domain のときは必須(auto でもよい)"]);
  assert.deepEqual(checkConfigured({ ...base, zone_name: "auto" }), []);
  const [outside] = checkConfigured({ ...base, zone_name: "example.org" });
  assert.deepEqual([outside.id, outside.message], ["zone_name", "edge_host(ab.example.net)がゾーン example.org に属していない"]);
  const [dl] = checkConfigured({ ...base, dlite_hosts: ["www.example.com"] });
  assert.equal(dl.id, "dlite_hosts");
  assert.match(dl.message, /edge_address: route のときだけ/);
  assert.deepEqual(checkConfigured({ ...base, asset_public_base: "auto" }), []);
});

test("checkConfigured: asset_public_base: auto はゾーンのある構成(route・custom-domain)だけ。edge_address の値は 3 つ", () => {
  const [auto] = checkConfigured({ owner_email: "a@example.com", edge_address: "workers-dev", asset_public_base: "auto" });
  assert.deepEqual([auto.id, auto.message], ["asset_public_base", "auto は edge_address: route か custom-domain のときだけ使える"]);
  const [other] = checkConfigured({ owner_email: "a@example.com", edge_address: "other", asset_public_base: "none" });
  assert.deepEqual([other.id, other.message], ["edge_address", "route / workers-dev / custom-domain のどれかで書く(今: other)"]);
});
