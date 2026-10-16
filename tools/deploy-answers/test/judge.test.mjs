import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend, LIGHTEST, configOf, sameConfig, exceedsFree, summaryOf, placementOf, reasonsOf, cannotOf, tasksOf, billingOf, notesOf, accountChangeOf, answersFor } from "../judge.mjs";

const base = { features: ["ab"], daily_pv: "under_10k", image_upload: false, cloudflare_account: "none", site_on_cloudflare: "no_site", owner_email: "a@example.com" };
const zone = { cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" };
const has = (xs, re) => xs.some((x) => re.test(x));

test("ab だけ・試すだけ → 推奨 = 最軽量(ドメインなし × Free × 画像なし)", () => {
  const r = recommend(base);
  assert.deepEqual(r, { ...LIGHTEST });
  assert.ok(sameConfig(r, LIGHTEST));
  assert.ok(has(reasonsOf(base, r), /ブラウザの中で完結/));
});

test("ab だけなら PV が多くても Free(Workers のリクエストを使わない)", () => {
  assert.equal(recommend({ ...base, ...zone, daily_pv: "over_70k" }).plan, "free");
  assert.equal(exceedsFree(new Set(["ab"]), "over_70k", LIGHTEST), false);
});

test("history × 3〜7 万 × ドメインあり → route × Paid、zone_name は auto", () => {
  const v = { ...base, ...zone, features: ["ab", "history"], daily_pv: "30k_70k" };
  const r = recommend(v);
  assert.deepEqual(r, { edge_address: "route", zone_name: "auto", asset_public_base: "none", dlite_hosts: [], plan: "paid" });
  assert.ok(has(reasonsOf(v, r), /約 5 万 PV\/日/));
  assert.ok(has(tasksOf(v, r), /Workers Paid に切り替える/));
  assert.ok(has(tasksOf(v, r), /ゾーンの設定用\(期限 = 翌日\)/));
  assert.ok(has(tasksOf(v, r), /デプロイ用・使用状況の表示用\(どちらも期限なし\)/));
});

test("history × 1〜3 万 → Free(上限の 7 割に届かない)", () => {
  assert.equal(recommend({ ...base, ...zone, features: ["history"], daily_pv: "10k_30k" }).plan, "free");
});

test("history × 7 万以上 × ドメインなし → Free のまま。できないこと・注意に上限とドメインへの移行", () => {
  const v = { ...base, features: ["history"], daily_pv: "over_70k", site_on_cloudflare: "no" };
  const r = recommend(v);
  assert.equal(r.edge_address, "workers-dev");
  assert.equal(r.plan, "free");
  assert.ok(has(cannotOf(v, r), /Free の上限に達しうる/));
  assert.ok(has(notesOf(v, r), /ドメインを Cloudflare に追加してから Workers Paid/));
});

test("itp × ドメインあり → dlite_hosts に install_host。7 万以上だけ Paid", () => {
  const v = { ...base, ...zone, features: ["itp"], daily_pv: "30k_70k" };
  const r = recommend(v);
  assert.deepEqual(r.dlite_hosts, ["www.example.com"]);
  assert.equal(r.plan, "free");
  assert.equal(recommend({ ...v, daily_pv: "over_70k" }).plan, "paid");
  assert.deepEqual(cannotOf(v, r), []);
});

test("itp × ドメインなし → 推奨でもできないことに Mode B", () => {
  const v = { ...base, features: ["itp"], site_on_cloudflare: "no" };
  const r = recommend(v);
  assert.deepEqual(r.dlite_hosts, []);
  assert.ok(has(cannotOf(v, r), /Mode B: サーバー発行 Cookie/));
});

test("画像のアップロード: route → auto、workers-dev → dev-assets、最軽量ではできないことに出る", () => {
  assert.equal(recommend({ ...base, ...zone, image_upload: true }).asset_public_base, "auto");
  const v = { ...base, image_upload: true };
  assert.equal(recommend(v).asset_public_base, "dev-assets");
  assert.ok(has(cannotOf(v, LIGHTEST), /アップロードできない/));
  assert.ok(has(tasksOf(v, recommend(v)), /R2/));
  assert.ok(!has(tasksOf(v, LIGHTEST), /R2/));
});

test("既存の Paid のアカウント × ドメインなし → 推奨・最軽量とも、新しく作る Free のアカウントに入れる", () => {
  const v = { ...base, cloudflare_account: "existing", existing_plan: "paid", site_on_cloudflare: "no" };
  const r = recommend(v);
  assert.equal(r.edge_address, "workers-dev");
  assert.equal(r.plan, "free");
  assert.equal(accountChangeOf(v, r), "paid");
  assert.equal(accountChangeOf(v, LIGHTEST), "paid");
  const vr = answersFor(v, r);
  assert.equal(vr.cloudflare_account, "separate");
  assert.match(tasksOf(vr, r)[0], /Free の Cloudflare アカウントを新しく作る/);
  // 入れ替えの理由は提示の確認の段落に書くので、理由の一覧には出さない
  assert.ok(!has(reasonsOf(vr, r), /アカウント/));
  assert.ok(!has(reasonsOf(vr, r), /Paid として扱う/));
  assert.ok(!has(notesOf(vr, r), /Free のアカウントを別に作り/));
  assert.ok(!has(billingOf(r), /そのまま課金/));
});

test("既存の Paid のアカウント × ドメインあり → 入れ替えず Paid として扱う", () => {
  const v = { ...base, ...zone, existing_plan: "paid" };
  const r = recommend(v);
  assert.equal(r.plan, "paid");
  assert.equal(accountChangeOf(v, r), null);
  assert.ok(has(reasonsOf(answersFor(v, r), r), /Paid として扱う/));
  assert.ok(!has(tasksOf(v, r), /Workers Paid に切り替える/));
  assert.ok(!has(tasksOf(v, r), /アカウントを/));
});

test("既存の Free のアカウント × ドメインなし: 止まると困る Worker が no なら同じアカウント、yes / unknown なら新しいアカウント", () => {
  const v = { ...base, cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "no" };
  const keep = { ...v, other_workers: "no" };
  assert.equal(accountChangeOf(keep, recommend(keep)), null);
  assert.equal(accountChangeOf(keep, LIGHTEST), null);
  assert.match(cannotOf(keep, LIGHTEST).find((x) => /WAF/.test(x)), /同じアカウントのほかの Worker も止まる/);
  for (const other_workers of ["yes", "unknown"]) {
    const w = { ...v, other_workers };
    assert.equal(accountChangeOf(w, recommend(w)), "other_workers", other_workers);
    const vw = answersFor(w, LIGHTEST);
    assert.ok(!has(reasonsOf(vw, LIGHTEST), /ほかの Worker/));
    assert.ok(!has(cannotOf(vw, LIGHTEST), /同じアカウントのほかの Worker も止まる。/));
  }
});

test("ドメインありと答えた既存の Free のアカウント: 推奨(route)は入れ替えず、最軽量(聞いていない)は新しいアカウント", () => {
  const v = { ...base, ...zone };
  assert.equal(accountChangeOf(v, recommend(v)), null);
  assert.equal(accountChangeOf(v, LIGHTEST), "other_workers");
});

test("新しいアカウントと答えた人と、E1b が未記入の答え(手で書いた構成)は入れ替えない", () => {
  assert.equal(accountChangeOf(base, LIGHTEST), null);
  assert.equal(accountChangeOf({ ...base, cloudflare_account: "separate" }, LIGHTEST), null);
  assert.equal(accountChangeOf({ cloudflare_account: "existing" }, LIGHTEST), null);
});

test("新しいアカウント → アカウントを作る作業が最初に入る", () => {
  assert.match(tasksOf(base, recommend(base))[0], /アカウントを作る/);
  assert.match(tasksOf({ ...base, cloudflare_account: "separate" }, LIGHTEST)[0], /アカウントを作る/);
});

test("ドメインなしの構成には WAF が無いことを常に出す", () => {
  assert.ok(has(cannotOf(base, LIGHTEST), /WAF/));
  assert.ok(!has(cannotOf({ ...base, ...zone }, recommend({ ...base, ...zone })), /WAF/));
});

test("PV が分からない → Free と、使用状況で様子を見る注意", () => {
  const v = { ...base, features: ["history"], daily_pv: "unknown" };
  assert.equal(recommend(v).plan, "free");
  assert.ok(has(notesOf(v, recommend(v)), /使用状況/));
});

test("注意には、後から履歴の条件・割り当ての固定を使うと上限が変わることが入る(履歴を選んでいれば入らない)", () => {
  assert.ok(has(notesOf(base, recommend(base)), /割り当ての固定/));
  const vh = { ...base, features: ["ab", "history"] };
  assert.ok(!has(notesOf(vh, recommend(vh)), /割り当ての固定/));
});

test("configOf は下段の値から構成を作る(既定 = route・Free・Mode B なし)", () => {
  assert.deepEqual(configOf({ asset_public_base: "none", install_host: "www.example.com", zone_name: "example.com" }), {
    edge_address: "route", zone_name: "example.com", asset_public_base: "none", dlite_hosts: [], plan: "free",
  });
});

test("summaryOf", () => {
  assert.equal(summaryOf(LIGHTEST), "ドメインなし(*.workers.dev) × Free × 画像のアップロードなし");
  assert.equal(
    summaryOf({ edge_address: "route", zone_name: "auto", asset_public_base: "auto", dlite_hosts: ["www.example.com"], plan: "paid" }, "www.example.com"),
    "ドメインあり(www.example.com) × Workers Paid × 画像のアップロードあり(R2 から配信) × Safari 対策(Mode B)あり",
  );
});

test("placementOf: 管理画面と control の置き場所(ドメインありなら自分のドメインは任意)", () => {
  assert.equal(placementOf(LIGHTEST), "管理画面と control(管理用の Worker)も *.workers.dev に置く");
  assert.equal(
    placementOf({ ...LIGHTEST, edge_address: "route", zone_name: "example.com" }),
    "管理画面と control(管理用の Worker)は *.workers.dev に置く(自分のドメインに載せるのは任意。デプロイガイド 3.6・4.2)",
  );
});

test("Safari 対策を選んでもドメインなしなら Mode B の上限は効かない(7 万以上でも上限の話を出さない)", () => {
  const v = { ...base, features: ["itp"], daily_pv: "over_70k", site_on_cloudflare: "no" };
  const r = recommend(v);
  assert.ok(!has(cannotOf(v, r), /上限に達しうる/));
  assert.ok(has(reasonsOf(v, r), /Safari 対策\(Mode B: サーバー発行 Cookie\)を使えないので/));
  assert.ok(!has(notesOf(v, r), /多い日に止めたくない/));
});

test("文言は構成に合わせる: 手で書いたドメインなしの Paid では「Free で始める」を出さず、止まらず課金と書く", () => {
  const v = { cloudflare_account: "existing", existing_plan: "paid", features: ["history"], daily_pv: "unknown", owner_email: "a@example.com" };
  const c = configOf({ edge_address: "workers-dev", asset_public_base: "none", plan: "paid" });
  assert.ok(!has(notesOf(v, c), /Free で始める/));
  assert.ok(has(notesOf(v, c), /Free のアカウントを別に作り、そこに入れることを勧める/));
  assert.ok(has(billingOf(c), /悪意のある人がプログラムで大量のアクセスを送ってきた場合.*そのアクセスの分もすべて請求に含まれる/));
  const waf = cannotOf(v, c).find((x) => /WAF/.test(x));
  assert.match(waf, /そのアクセスの分もすべて請求に含まれる/);
  assert.doesNotMatch(waf, /無料枠を使い切られる/);
});

test("PV が分からない: ドメインなしは「ドメインを追加してから Paid」、ドメインありは Paid に切り替えるだけ", () => {
  const v = { ...base, features: ["history"], daily_pv: "unknown", site_on_cloudflare: "no" };
  assert.ok(has(notesOf(v, recommend(v)), /ドメインを Cloudflare に追加してから Workers Paid/));
  const vr = { ...base, ...zone, features: ["history"], daily_pv: "unknown" };
  assert.ok(!has(notesOf(vr, recommend(vr)), /ドメインを Cloudflare に追加/));
});

test("A/B テストだけなら、無料枠を使い切られても出し分けは止まらない(止まるのは管理画面)", () => {
  const waf = cannotOf(base, LIGHTEST).find((x) => /WAF/.test(x));
  assert.match(waf, /ブラウザの中で続く/);
  assert.doesNotMatch(waf, /出し分けと計測が止まり/);
  assert.match(cannotOf({ ...base, features: ["history"] }, LIGHTEST).find((x) => /WAF/.test(x)), /出し分けと計測が止まり/);
});
