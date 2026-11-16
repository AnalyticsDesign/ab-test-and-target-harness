import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, TOKEN_MODES, tokenModeOf, checkAnswers, checkConfigured, isConfigured, isBlank, hostProblem, hostInZone, featuresOf, approxZoneOf, extraHostsOf } from "../questions.mjs";

const ok = { features: ["ab"], daily_pv: "under_10k", image_upload: false, cloudflare_account: "none", site_on_cloudflare: "no_site", owner_email: "a@example.com" };
const ids = (issues) => issues.map((i) => i.id);

test("質問の表は 12 問で、ID の順が N1 N2 N3 E1 E1b E1c E2 E2a E2d E2b E2c E3", () => {
  assert.deepEqual(QUESTIONS.map((q) => q.id), ["N1", "N2", "N3", "E1", "E1b", "E1c", "E2", "E2a", "E2d", "E2b", "E2c", "E3"]);
});

test("すべて答えていれば問題なし", () => {
  assert.deepEqual(checkAnswers(ok), []);
});

test("未記入(無い・空・プレースホルダ・空の配列)は未回答として ID を返す", () => {
  const issues = checkAnswers({ ...ok, features: [], daily_pv: "<under_10k / …>", image_upload: null, owner_email: undefined });
  assert.deepEqual(ids(issues), ["N1", "N2", "N3", "E3"]);
  assert.ok(issues.every((i) => i.message === "未回答"));
});

test("条件付きの問い: E1b・E1c は existing のときだけ、E2a は yes のときだけ聞く", () => {
  assert.deepEqual(ids(checkAnswers({ ...ok, cloudflare_account: "existing" })), ["E1b", "E1c"]);
  assert.deepEqual(ids(checkAnswers({ ...ok, cloudflare_account: "existing", existing_plan: "free", cloudflare_tokens: "manual-account", site_on_cloudflare: "yes" })), ["E2a", "E2d"]);
});

test("E2b(止まると困る Worker)は、既存の Free のアカウント × ドメインなし(no / no_site)のときだけ聞く", () => {
  const free = { ...ok, cloudflare_account: "existing", existing_plan: "free", cloudflare_tokens: "manual-account" };
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no", edge_host: "none" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no_site" })), ["E2b"]);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "no", edge_host: "none", other_workers: "unknown" })), []);
  assert.deepEqual(ids(checkAnswers({ ...free, site_on_cloudflare: "yes", install_host: "www.example.com", extra_hosts: "none" })), []);
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
  const [i] = checkAnswers({ ...ok, cloudflare_account: "existing", existing_plan: "free", cloudflare_tokens: "manual-account", site_on_cloudflare: "yes", install_host: "https://www.Example.com/path?q=1", extra_hosts: "none" });
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
    const issues = checkAnswers({ ...ok, cloudflare_account: acct, site_on_cloudflare: "yes", install_host: "www.example.com", extra_hosts: "none" });
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
  assert.deepEqual(ids(checkAnswers({ ...ok, site_on_cloudflare: "yes", cloudflare_account: "existing", existing_plan: "free", cloudflare_tokens: "manual-account", install_host: "www.example.com", extra_hosts: "none" })), []);
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

// B138: タグを置くほかのホスト(E2d)と、Mode B の Route を作るホスト(dlite_hosts)
const yes = { ...ok, cloudflare_account: "existing", existing_plan: "free", cloudflare_tokens: "manual-account", site_on_cloudflare: "yes", install_host: "www.example.com" };

test("E2d asked only when site is on Cloudflare", () => {
  const [blank] = checkAnswers(yes);
  assert.deepEqual([blank.id, blank.key, blank.message], ["E2d", "extra_hosts", "未回答"]);
  assert.deepEqual(checkAnswers({ ...yes, extra_hosts: "none" }), []);
  assert.deepEqual(checkAnswers({ ...yes, extra_hosts: ["form.example.com", "shop.example.net"] }), []);
  // 1 つだけなら配列の括弧が無くても読む
  assert.deepEqual(checkAnswers({ ...yes, extra_hosts: "form.example.com" }), []);
  for (const site of ["no", "no_site"]) assert.ok(!ids(checkAnswers({ ...ok, site_on_cloudflare: site, edge_host: "none" })).includes("E2d"), site);
  // 条件は前の答え(E2)だけで決まる
  assert.equal(QUESTIONS.find((q) => q.id === "E2d").when({ site_on_cloudflare: "yes" }), true);
});

test("extra_hosts rejects urls with a candidate", () => {
  const [i] = checkAnswers({ ...yes, extra_hosts: ["https://form.example.com/"] });
  assert.deepEqual([i.id, i.key], ["E2d", "extra_hosts"]);
  assert.match(i.message, /ホストだけを書く\(候補: form\.example\.com\)/);
  assert.match(i.message, /^https:\/\/form\.example\.com\/: /);
  const [comma] = checkAnswers({ ...yes, extra_hosts: "form.example.com, shop.example.net" });
  assert.equal(comma.id, "E2d");
  assert.match(comma.message, /\[form\.example\.com, shop\.example\.net\] の形で書く/);
});

test("extraHostsOf: none・未記入は空。1 つの文字列は 1 件の配列", () => {
  assert.deepEqual(extraHostsOf({ extra_hosts: "none" }), []);
  assert.deepEqual(extraHostsOf({}), []);
  assert.deepEqual(extraHostsOf({ extra_hosts: "<form.example.com / none>" }), []);
  assert.deepEqual(extraHostsOf({ extra_hosts: "form.example.com" }), ["form.example.com"]);
  assert.deepEqual(extraHostsOf({ extra_hosts: ["a.example.com", "b.example.net"] }), ["a.example.com", "b.example.net"]);
  // 重ねて書いたホストと install_host(E2a)の繰り返しは 1 つにする(理由の行・知らせ・タグを置くドメインに 1 回だけ出す)
  assert.deepEqual(
    extraHostsOf({ install_host: "www.example.com", extra_hosts: ["form.example.com", "www.example.com", "form.example.com", "shop.example.net"] }),
    ["form.example.com", "shop.example.net"],
  );
  assert.deepEqual(extraHostsOf({ install_host: "www.example.com", extra_hosts: "www.example.com" }), []);
});

test("approxZoneOf: 末尾 2 ラベル。2 段の接尾辞なら 3 ラベル(近似。--resolve-zone で確かめ直す)", () => {
  assert.equal(approxZoneOf("www.example.com"), "example.com");
  assert.equal(approxZoneOf("example.com"), "example.com");
  assert.equal(approxZoneOf("www.example.co.jp"), "example.co.jp");
  assert.equal(approxZoneOf("shop.example.com.au"), "example.com.au");
  assert.equal(approxZoneOf("www.example.co.uk"), "example.co.uk");
  assert.equal(approxZoneOf("www.example.com.br"), "example.com.br");
  assert.equal(approxZoneOf("www.example.co.in"), "example.co.in");
  // 委譲されたサブドメインのゾーンは近似では分からない(--resolve-zone で導き直す)
  assert.equal(approxZoneOf("www.shop.example.com"), "example.com");
});

test("configured dlite host outside zone is reported", () => {
  const base = { owner_email: "a@example.com", edge_address: "route", install_host: "www.example.com", zone_name: "example.com", asset_public_base: "none" };
  const [i] = checkConfigured({ ...base, dlite_hosts: ["www.example.com", "form.example.net"] });
  assert.deepEqual([i.id, i.message], ["dlite_hosts", "form.example.net はゾーン example.com に属していない。Route を作れないので dlite_hosts から外す(タグを置くドメインには残す)"]);
  assert.deepEqual(checkConfigured({ ...base, dlite_hosts: ["www.example.com", "form.example.com"] }), []);
  // ゾーンが auto の間は確かめない(--resolve-zone で確かめる)
  assert.deepEqual(checkConfigured({ ...base, zone_name: "auto", dlite_hosts: ["form.example.net"] }), []);
});

test("delegated subdomain zone and hand-written dlite_hosts", () => {
  // shop.example.com を独立したゾーンとして Cloudflare に置いている(サブドメインの委譲)
  const base = { owner_email: "a@example.com", edge_address: "route", install_host: "www.shop.example.com", zone_name: "shop.example.com", asset_public_base: "none" };
  assert.deepEqual(checkConfigured({ ...base, dlite_hosts: ["www.shop.example.com", "form.shop.example.com"] }), []);
  const [i] = checkConfigured({ ...base, dlite_hosts: ["www.shop.example.com", "www.example.com"] });
  assert.equal(i.id, "dlite_hosts");
  assert.match(i.message, /^www\.example\.com はゾーン shop\.example\.com に属していない/);
});

// B130: API トークンの用意の仕方(E1c)
const configuredRoute = { edge_address: "workers-dev", asset_public_base: "none" };

test("cloudflare_tokens: existing のときだけ聞き、値は 3 つ", () => {
  const q = QUESTIONS.find((x) => x.key === "cloudflare_tokens");
  assert.equal(q.id, "E1c");
  assert.deepEqual(q.values, ["manual-account", "bootstrap", "manual-user"]);   // 並びは質問の (1)(2)(3)
  assert.deepEqual(TOKEN_MODES, ["bootstrap", "manual-account", "manual-user"]);
  assert.equal(q.when({ cloudflare_account: "existing" }), true);
  assert.equal(q.when({ cloudflare_account: "none" }), false);
});

test("tokenModeOf: 新しいアカウントは bootstrap、既存は manual-account、書いてあればその値", () => {
  assert.equal(tokenModeOf({ cloudflare_account: "none" }), "bootstrap");
  assert.equal(tokenModeOf({ cloudflare_account: "separate" }), "bootstrap");
  assert.equal(tokenModeOf({ cloudflare_account: "existing" }), "manual-account");
  assert.equal(tokenModeOf({ cloudflare_account: "none", cloudflare_tokens: "manual-user" }), "manual-user");
  assert.throws(() => tokenModeOf({ cloudflare_account: "none", cloudflare_tokens: "manual" }));
});

test("checkAnswers: 聞かない構成でも、書いた cloudflare_tokens の値が 3 つのどれでもなければ断る", () => {
  const issues = checkAnswers({ ...ok, cloudflare_tokens: "manual" });
  assert.ok(issues.some((i) => i.key === "cloudflare_tokens"));
  assert.deepEqual(checkAnswers({ ...ok, cloudflare_tokens: "manual-user" }), []);
});

test("checkConfigured: 構成を書いた後も cloudflare_tokens の値を断る", () => {
  const issues = checkConfigured({ ...ok, ...configuredRoute, cloudflare_tokens: "manual" });
  assert.ok(issues.some((i) => i.key === "cloudflare_tokens"));
  assert.deepEqual(checkConfigured({ ...ok, ...configuredRoute, cloudflare_tokens: "bootstrap" }), []);
});

test("cloudflare_tokens: existing で未回答なら E1c を聞き直す", () => {
  assert.deepEqual(ids(checkAnswers({ ...ok, cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "no_site", other_workers: "no" })), ["E1c"]);
});
