import type { Page, Request, Response } from "@playwright/test";
import { test, expect } from "./fixtures";
import { freshVisitor, presetVisitor, queryResults, visitorKeySql } from "./helpers";
import { RESULTS_ORIGIN } from "./results-key";

// D9 ②(設計書 §6.1〜§6.4・K25): 結果の参加・CV が計測用 D1(ローカルの wtt-results)に入り、撤回で消えること。
// この spec は結果の E2E 用の edge と sample-site(RESULTS_ORIGIN)だけを使う(ほかの spec と状態・レート制限を共有しない。理由は results-key.ts)。
// D1 はローカルの状態が実行をまたいで残るので、毎回新しい訪問者で行を作り、行は visitor_key(E2E の鍵で計算)で絞って読む

const MODE_A = { site: "site_results", cookie: "_wttr_vid", run: "e2eResultsModeA0000001", lateRun: "e2eResultsLate00000001", goal: "g_results_buy" };
const DLITE = { site: "site_results_dlite", cookie: "_wttd_vid", run: "e2eResultsDlite0000001", goal: "g_results_dlite_buy" };

test.use({ baseURL: RESULTS_ORIGIN });

/** 結果のイベント(Mode A は /v1/sites/:siteId/event、D-lite は /__ab/event)の POST か */
function isResultsEvent(r: Request, type: "participant" | "conversion"): boolean {
  return r.method() === "POST" && /\/(v1\/sites\/[^/]+|__ab)\/event$/.test(new URL(r.url()).pathname) && String(r.postData()).includes(`"type":"${type}"`);
}
const waitResults = (page: Page, type: "participant" | "conversion"): Promise<Response> =>
  page.waitForResponse((res) => isResultsEvent(res.request(), type));

/** ページで送られた結果のイベント(参加・CV)の本文を集める(印で送らないことの確認用) */
function trackResults(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (isResultsEvent(r, "participant") || isResultsEvent(r, "conversion")) sent.push(String(r.postData()));
  });
  return sent;
}

async function revoke(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { AB: { consent(g: boolean): void } }).AB.consent(false));
}

const participantsOf = (site: string, key: string) =>
  queryResults(`SELECT run_id, variant_id, device, applied, mixed FROM participants WHERE site_id = '${site}' AND visitor_key = ${key}`);
const conversionsOf = (key: string) =>
  queryResults(`SELECT run_id, goal_id FROM conversions WHERE visitor_key = ${key}`);

test("mode_a_participant_and_conversion_reach_results_d1_once", async ({ context, page }) => {
  const vid = freshVisitor("exp_results", "B");
  await presetVisitor(context, vid, { name: MODE_A.cookie });
  const [p] = await Promise.all([waitResults(page, "participant"), page.goto("/results.html")]);
  expect(p.request().postDataJSON()).toMatchObject({ runId: MODE_A.run, variantId: "vB", device: "desktop", applied: "ok", visitorId: vid });
  expect(await p.json()).toEqual({ result: "stored" });
  await expect(page.locator(".hero-title")).toHaveText("結果 B");
  // 目標(CLICK)→ CV。edge は参加の行がある run にだけ CV を入れる
  const [c] = await Promise.all([waitResults(page, "conversion"), page.click("#buy")]);
  expect(c.request().postDataJSON()).toMatchObject({ goalId: MODE_A.goal, runIds: [MODE_A.run], visitorId: vid });
  expect(((await c.json()) as { runs: Record<string, unknown> }).runs[MODE_A.run]).toEqual({ result: "stored" });
  const key = visitorKeySql(MODE_A.site, vid);
  expect(await participantsOf(MODE_A.site, key)).toEqual([{ run_id: MODE_A.run, variant_id: "vB", device: "desktop", applied: "ok", mixed: 0 }]);
  expect(await conversionsOf(key)).toEqual([{ run_id: MODE_A.run, goal_id: MODE_A.goal }]);
  // 開き直し: 送信済みの印(localStorage)があるので、参加も同じ目標の CV も送らない(D1 の一意制約に頼らず、送信そのものが無いことを見る)
  const sent = trackResults(page);
  await page.reload();
  await expect(page.locator(".hero-title")).toHaveText("結果 B");
  await page.click("#buy");
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(await participantsOf(MODE_A.site, key)).toHaveLength(1);
  expect(await conversionsOf(key)).toHaveLength(1);
});

test("d_lite_participant_and_conversion_reach_results_d1_with_cookie_identity", async ({ context, page }) => {
  const vid = freshVisitor("exp_results_dlite", "B");
  await presetVisitor(context, vid, { name: DLITE.cookie, httpOnly: true }); // D-lite の正本は edge 所有の HttpOnly Cookie
  const [p] = await Promise.all([waitResults(page, "participant"), page.goto("/results-dlite.html")]);
  const body = p.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ runId: DLITE.run, variantId: "vB", device: "desktop", applied: "ok" });
  expect(body).not.toHaveProperty("visitorId"); // D-lite は Cookie が正(本文に ID を載せない)
  expect(await p.json()).toEqual({ result: "stored" });
  await expect(page.locator(".hero-title")).toHaveText("結果 D-lite B");
  const [c] = await Promise.all([waitResults(page, "conversion"), page.click("#buy")]);
  expect(c.request().postDataJSON()).not.toHaveProperty("visitorId");
  expect(((await c.json()) as { runs: Record<string, unknown> }).runs[DLITE.run]).toEqual({ result: "stored" });
  // 行は Cookie の ID の HMAC で入る
  const key = visitorKeySql(DLITE.site, vid);
  expect(await participantsOf(DLITE.site, key)).toEqual([{ run_id: DLITE.run, variant_id: "vB", device: "desktop", applied: "ok", mixed: 0 }]);
  expect(await conversionsOf(key)).toEqual([{ run_id: DLITE.run, goal_id: DLITE.goal }]);
  // 開き直し: 印(i = decision の応答の vh)が同じ訪問者のものなので送らない
  const sent = trackResults(page);
  await page.reload();
  await expect(page.locator(".hero-title")).toHaveText("結果 D-lite B");
  await page.click("#buy");
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(await participantsOf(DLITE.site, key)).toHaveLength(1);
  expect(await conversionsOf(key)).toHaveLength(1);
});

test("mode_a_revoke_deletes_participant_and_conversion_rows", async ({ context, page }) => {
  const vid = freshVisitor("exp_results", "B");
  await presetVisitor(context, vid, { name: MODE_A.cookie });
  await Promise.all([waitResults(page, "participant"), page.goto("/results.html")]);
  await Promise.all([waitResults(page, "conversion"), page.click("#buy")]);
  const key = visitorKeySql(MODE_A.site, vid);
  expect(await participantsOf(MODE_A.site, key)).toHaveLength(1); // 消える前に行があること(対照)
  expect(await conversionsOf(key)).toHaveLength(1);
  // 撤回 → forget(edge は Profile と計測用 D1 の行を消してから 204 を返す)
  const [f] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/event") && String(r.request().postData()).includes('"type":"forget"')),
    revoke(page),
  ]);
  expect(f.request().postDataJSON()).toMatchObject({ type: "forget", visitorId: vid });
  expect(f.status()).toBe(204);
  expect(await participantsOf(MODE_A.site, key)).toEqual([]);
  expect(await conversionsOf(key)).toEqual([]);
  expect(await page.evaluate((k) => localStorage.getItem(k), `${MODE_A.cookie}_r`)).toBeNull(); // 送信済みの印も消える
});

test("d_lite_revoke_deletes_participant_and_conversion_rows", async ({ context, page }) => {
  const vid = freshVisitor("exp_results_dlite", "B");
  await presetVisitor(context, vid, { name: DLITE.cookie, httpOnly: true });
  await Promise.all([waitResults(page, "participant"), page.goto("/results-dlite.html")]);
  await Promise.all([waitResults(page, "conversion"), page.click("#buy")]);
  const key = visitorKeySql(DLITE.site, vid);
  expect(await participantsOf(DLITE.site, key)).toHaveLength(1);
  expect(await conversionsOf(key)).toHaveLength(1);
  // 撤回 → consent の本文(edge は Cookie の ID で計測用 D1 の行を消してから、Cookie の削除を返す)
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/__ab/decision") && String(r.request().postData()).includes('"consent"')),
    revoke(page),
  ]);
  expect(res.status()).toBe(204);
  expect(await participantsOf(DLITE.site, key)).toEqual([]);
  expect(await conversionsOf(key)).toEqual([]);
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === DLITE.cookie)).toBe(false);
});

test("control_variant_visitor_participates_when_target_appears", async ({ context, page }) => {
  // 基準(変更なし)に割り当たった訪問者も、テストの対象の要素(B が変える .late-target)が出た時点で参加する(設計書 §6.1)
  const vid = freshVisitor("exp_results_late", "A");
  await presetVisitor(context, vid, { name: MODE_A.cookie });
  const sent = trackResults(page);
  await page.goto("/results-late.html");
  await page.waitForTimeout(500);
  expect(sent).toEqual([]); // 対象の要素がまだ無いので参加しない
  const [p] = await Promise.all([waitResults(page, "participant"), page.click("#show")]);
  expect(p.request().postDataJSON()).toMatchObject({ runId: MODE_A.lateRun, variantId: "vA", device: "desktop", applied: "ok" });
  expect(await p.json()).toEqual({ result: "stored" });
  await expect(page.locator(".late-target")).toHaveText("元の文言"); // 基準なので変えない
  expect(await participantsOf(MODE_A.site, visitorKeySql(MODE_A.site, vid))).toEqual([
    { run_id: MODE_A.lateRun, variant_id: "vA", device: "desktop", applied: "ok", mixed: 0 },
  ]);
});
