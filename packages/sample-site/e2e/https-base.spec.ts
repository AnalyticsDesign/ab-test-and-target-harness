import { test, expect } from "./fixtures";
import { EXAMPLE_HOST, EXAMPLE_ORIGIN, FORM_HOST, FORM_ORIGIN } from "./results-key";

// B139 Task 8: ローカルの HTTPS の土台そのものの確認(ポート無しの入口・名前の解決・edge が元のホスト名で受ける・別オリジンの CORS)。
// 経路の使い分け(www は /__ab/*、form は /v1/)は本番と同じ条件(runtime の onEdgePath)で決まる。テストのために条件は緩めない

test("cloudflare_host_reaches_edge_with_original_hostname_over_ab", async ({ page }) => {
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/__ab/decision")), page.goto(`${EXAMPLE_ORIGIN}/dlite.html`)]);
  expect(await page.evaluate(() => location.host)).toBe(EXAMPLE_HOST); // ポート無し(あると onEdgePath が偽になる)
  expect(new URL(res.url()).origin).toBe(EXAMPLE_ORIGIN);
  expect(res.status()).toBe(200); // 404 = edge が元のホスト名で受けていない(host:www.example.test を引けていない)
});

test("outside_host_calls_v1_cross_origin_and_never_ab", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/v1/sites/site_demo_dlite/decision")), page.goto(`${FORM_ORIGIN}/dlite.html`)]);
  expect(await page.evaluate(() => location.host)).toBe(FORM_HOST);
  expect(new URL(res.url()).origin).toBe(EXAMPLE_ORIGIN); // 焼いた apiBase = Cloudflare 経由のホスト
  expect((await res.request().allHeaders())["origin"]).toBe(FORM_ORIGIN);
  expect(res.status()).toBe(200); // CORS(allowedOrigins)を通った
  expect(requests.filter((u) => u.includes("/__ab/"))).toEqual([]);
});

test("outside_host_has_no_ab_route", async ({ page }) => {
  // Cloudflare の外のホストには /__ab/* の Route が無い(本番と同じ)。sample-site の転送が 404 を返す。
  // 名前の解決は Chromium だけが持つので、request フィクスチャ(Node の通信)ではなくページから呼ぶ
  await page.goto(`${FORM_ORIGIN}/dlite.html`);
  expect(await page.evaluate(async () => (await fetch("/__ab/ping")).status)).toBe(404);
  await page.goto(`${EXAMPLE_ORIGIN}/dlite.html`);
  // 対照: Cloudflare 経由のホストでは edge に届く(ローカルの KV には導入の印が無いので ping は 503。404 でないこと = Route 相当が通っていること)
  expect(await page.evaluate(async () => (await fetch("/__ab/ping")).status)).not.toBe(404);
});
