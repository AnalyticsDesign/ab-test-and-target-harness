import { test, expect, type Page } from "@playwright/test";
import { login, openSite, SITE } from "./fixtures";

/**
 * plan12 K6: 管理画面と control の版の食い違いの帯。
 * 開いている画面は /capabilities を取り直して帯を出す・消す。ここでは /api/control/capabilities の応答だけを差し替えて確かめる
 * (control の版を実際に上げると他の project に影響するため。差し替えは読み取りだけで、状態は変えない)。
 * 取り直しはタブが前に戻ったとき(visibilitychange)にも起きるので、60 秒を待たずにそれで起こす。ログインは 1 回だけ(fixtures.ts の login())
 */
const CAPS_URL = "**/api/control/capabilities";
const isCaps = (url: string) => new URL(url).pathname === "/api/control/capabilities";
const refocus = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
/**
 * 取り直しを起こし、その応答が着くまで待つ。要求ではなく応答を待つ(B146: 要求だけ待って差し替えに進むと、
 * 前の取り直しの本物の応答が差し替えた応答の後に着いて帯を消すことがあった)
 */
const refetch = async (page: Page) => {
  const done = page.waitForResponse((r) => isCaps(r.url()));
  await refocus(page);
  return done;
};

/** 本物の応答に版の 2 つの数だけ重ねて返す */
async function overrideVersions(page: Page, versions: { apiVersion: number; minClientVersion: number } | null) {
  await page.unroute(CAPS_URL);
  if (versions === null) return;
  await page.route(CAPS_URL, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, ...versions } });
  });
}

test("the version banner follows /capabilities: incompatible (red) → outdated (quiet) → control_outdated → gone", async ({ page }) => {
  await login(page);
  await openSite(page, SITE.name);
  const banner = page.getByTestId("version-banner");
  await expect(banner).toHaveCount(0);

  // 取り直しの要求は画面の版を名乗る
  const named = await refetch(page);
  expect(named.request().headers()["x-wtt-client-version"]).toMatch(/^\d+$/);
  await expect(banner).toHaveCount(0); // 本物の control とは版が合っている

  // 最低の版が上がった: 赤帯(書き込みが断られる)。別のページに移っても出る
  await overrideVersions(page, { apiVersion: 2, minClientVersion: 2 });
  await refetch(page);
  await expect(banner).toHaveAttribute("data-kind", "incompatible");
  await expect(banner).toHaveClass(/banner-warn/);
  await expect(banner).toContainText("管理画面の新しい版があります。この画面のままでは保存できません。ページを再読み込みしてください(未保存の入力は消えます)");
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "設定", exact: true }).click();
  await expect(banner).toBeVisible();

  // 新しい版はあるが書き込みは通る: 控えめな帯
  await overrideVersions(page, { apiVersion: 2, minClientVersion: 1 });
  await refetch(page);
  await expect(banner).toHaveAttribute("data-kind", "outdated");
  await expect(banner).toHaveClass(/banner-note/);
  await expect(banner).toContainText("管理画面の新しい版があります。ページを再読み込みすると反映されます");

  // control のほうが古い
  await overrideVersions(page, { apiVersion: 0, minClientVersion: 0 });
  await refetch(page);
  await expect(banner).toHaveAttribute("data-kind", "control_outdated");
  await expect(banner).toContainText("サーバー側(control)が管理画面より古い版です");

  // 差し替えをやめる(本物の応答に戻る)と、再読み込みなしで帯が消える
  await overrideVersions(page, null);
  await refetch(page);
  await expect(banner).toHaveCount(0);
});

test("a failed re-fetch keeps the banner that is showing", async ({ page }) => {
  await login(page);
  await openSite(page, SITE.name);
  const banner = page.getByTestId("version-banner");
  await overrideVersions(page, { apiVersion: 2, minClientVersion: 2 });
  await refetch(page);
  await expect(banner).toHaveAttribute("data-kind", "incompatible");

  // control が一時的に読めない(502)間は、直前の表示のまま
  await page.unroute(CAPS_URL);
  await page.route(CAPS_URL, (route) => route.fulfill({ status: 502, json: { error: "control_unreachable" } }));
  const failed = page.waitForResponse((r) => isCaps(r.url()) && r.status() === 502);
  await refocus(page);
  await failed;
  await expect(banner).toHaveAttribute("data-kind", "incompatible");
});
