import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readDataLayer } from "./helpers";

/** Mode C(BYOID): サイト Cookie から派生する ID。撤回 → 再許可で同じ ID に戻る(決定 31)ので forget の効果を直接観測できる */
async function presetSiteUser(context: BrowserContext, uid: string): Promise<void> {
  await context.addCookies([{ name: "_site_uid", value: uid, domain: "localhost", path: "/" }]);
}
const uid = () => `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function consent(page: Page, granted: boolean): Promise<void> {
  await page.evaluate((g) => (window as unknown as { AB: { consent(g: boolean): void } }).AB.consent(g), granted);
}
const isEvent = (r: import("@playwright/test").Request, kind: string) =>
  r.url().includes("/event") && r.method() === "POST" && String(r.postData()).includes(`"type":"${kind}"`);

test("visited_targeting_applies_after_pattern_page_visit", async ({ context, page }) => {
  await presetSiteUser(context, uid());
  // 1. 実験の無いパターンページ: decision は飛ぶ(履歴記録)が適用も Exposure も無い
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/v1/sites/site_profile/decision")), page.goto("/profile-pricing.html")]);
  expect((req.postDataJSON() as { visitorId: string }).visitorId).toHaveLength(43); // Mode C の派生 ID
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toEqual([]);
  // 2. 別ページで閲覧の条件(/profile-pricing.html を閲覧した)が成立
  await page.goto("/profile.html");
  await expect(page.locator(".hero-title")).toHaveText("visited B");
  await expect(page.locator(".old-banner")).toHaveText("旧バナー"); // converted はまだ偽
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure").map((e) => e.ab_experiment_id)).toEqual(["exp_visited"]);
});

test("first visit to /profile.html without history applies nothing (control for the test above)", async ({ context, page }) => {
  await presetSiteUser(context, uid());
  await page.goto("/profile.html");
  await page.waitForTimeout(300);
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  await expect(page.locator(".hero-title")).toHaveCSS("opacity", "1");
});

test("pageview_and_click_goals_reach_datalayer_and_event_endpoint", async ({ context, page }) => {
  await presetSiteUser(context, uid());
  const [pv] = await Promise.all([page.waitForRequest((r) => isEvent(r, "goal")), page.goto("/profile-pricing.html")]);
  expect(pv.postDataJSON()).toMatchObject({ type: "goal", goalId: "g_pv" });
  const [click] = await Promise.all([page.waitForRequest((r) => isEvent(r, "goal") && String(r.postData()).includes("g_buy")), page.click("#buy")]);
  expect(click.postDataJSON()).toMatchObject({ type: "goal", goalId: "g_buy" });
  await page.click("#buy"); // 決定 37 (4): 2 回目も発火
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === "ab_conversion").map((e) => e.ab_goal_id)).toEqual(["g_pv", "g_buy", "g_buy"]);
  // converted(g_buy) が別ページで成立
  await page.goto("/profile.html");
  await expect(page.locator(".old-banner")).toHaveText("converted B");
});

test("forget_on_revoke_deletes_profile", async ({ context, page }) => {
  await presetSiteUser(context, uid());
  await Promise.all([page.waitForResponse((r) => r.url().includes("/decision") && r.status() === 200), page.goto("/profile-pricing.html")]);
  await page.goto("/profile.html");
  await expect(page.locator(".hero-title")).toHaveText("visited B"); // 履歴あり
  const [forgetRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/event") && String(r.request().postData()).includes('"forget"')),
    consent(page, false),
  ]);
  expect(forgetRes.status()).toBe(204);
  const forgetId = (forgetRes.request().postDataJSON() as { visitorId: string }).visitorId;
  expect(forgetId).toHaveLength(43);
  // 再許可 = 同じ派生 ID(Mode C)。forget 済みなので decision は 200 で空割当
  const [decision] = await Promise.all([page.waitForResponse((r) => r.url().includes("/decision")), page.goto("/profile.html")]);
  expect(decision.status()).toBe(200);
  expect((decision.request().postDataJSON() as { visitorId: string }).visitorId).toBe(forgetId);
  expect(((await decision.json()) as { experiments: unknown[] }).experiments).toEqual([]);
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toEqual([]);
});

test("forget_disabled_keeps_profile_until_retention", async ({ context, page }) => {
  await presetSiteUser(context, uid());
  await Promise.all([page.waitForResponse((r) => r.url().includes("/decision") && r.status() === 200), page.goto("/profile-keep-pricing.html")]);
  await Promise.all([page.waitForResponse((r) => r.url().includes("/decision") && r.status() === 200), page.goto("/profile-keep.html")]);
  await expect(page.locator(".hero-title")).toHaveText("visited B");
  const events: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/event")) events.push(String(r.postData())); });
  await consent(page, false);
  await page.click("#buy"); // 同一ページで denied 中に click(§16: denied の間は event を送らない。Plan 3 からの繰越 consent.spec.ts:88)
  await page.waitForTimeout(300);
  expect(events).toEqual([]); // forgetOnRevoke: false なので forget も無く、denied 中の goal も無い
  // 再許可で撤回前の履歴に再接続する(Mode C の既知の挙動。管理画面の注記どおり)。page.goto は新しい読込なので implicit の既定 = granted で起動し直す
  await page.goto("/profile-keep.html");
  await expect(page.locator(".hero-title")).toHaveText("visited B");
});
