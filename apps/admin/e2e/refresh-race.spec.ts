import { test, expect, type Page, type Route } from "@playwright/test";
import { changeStatus, createExperiment, createSite, waitForHydration, login } from "./fixtures";

/**
 * 管理画面の速さ CE-R9: 書き込みの後の読み直し(router.refresh)の反映の前に押した遷移・節の切り替えが、捨てられない・戻されないこと(lib/refresh-wait.ts)。
 *
 * vinext(1.0.0-beta.10)は、遷移を始めた後に画面の版が進む(refresh の反映)と、その遷移を黙って捨てる。
 * ふつうは refresh が数十 ms で返るので、窓は短く、偶然でしか踏まない(audience-flow で 2〜5 割)。ここでは窓を決まって作るため、
 * 書き込みの後の読み直しの RSC(その画面の URL への、先読みでない GET)だけを 1.5 秒遅らせ、その間に押す。
 * 表明: (1) 押した遷移・切り替えが、読み直しの応答が届いた後に始まる(仕組みが効いている印。仕組みが無いと押した直後に始まる)、
 * (2) 最後に移動先の画面・押した節が出ている
 */

const SITE = { id: "site_e2e_rrace", name: "E2E Refresh Race" };
const EXP = { id: "exp_e2e_rrace", name: "E2E refresh race experience" };
const DELAY_MS = 1_500;

/** pathname への先読みでない RSC の GET(= 読み直し)を 1 回だけ遅らせる。遅らせた応答が届いた時刻を返す Promise と、解除の関数 */
async function delayRefreshOnce(page: Page, pathname: string): Promise<{ delivered: Promise<number>; undo: () => Promise<void> }> {
  let deliver!: (t: number) => void;
  const delivered = new Promise<number>((r) => (deliver = r));
  let done = false;
  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (done || req.method() !== "GET" || url.pathname !== pathname || !url.searchParams.has("_rsc") || (await req.allHeaders())["next-router-prefetch"]) return route.continue();
    done = true;
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const res = await route.fetch();
    await route.fulfill({ response: res });
    deliver(Date.now());
  };
  await page.route("**/*", handler);
  return { delivered, undo: () => page.unroute("**/*", handler) };
}

/** pathname への、先読みでない RSC の GET を送った時刻(最初の 1 つ) */
function navigationRequestAt(page: Page, pathname: string): Promise<number> {
  return new Promise((resolve) => {
    const onRequest = async (req: import("@playwright/test").Request) => {
      const url = new URL(req.url());
      if (req.method() !== "GET" || url.pathname !== pathname || !url.searchParams.has("_rsc")) return;
      if ((await req.allHeaders())["next-router-prefetch"]) return;
      page.off("request", onRequest);
      resolve(Date.now());
    };
    page.on("request", onRequest);
  });
}

const nav = (page: Page) => page.getByRole("navigation", { name: "メインメニュー" });

test("a click right after a write is not lost to the post-write refresh (CE-R9)", async ({ page }) => {
  test.setTimeout(120_000);
  // ログインは 1 回(fixtures.ts の login() の予算)
  await login(page);
  await createSite(page, SITE);
  const base = new URL(page.url()).pathname;
  await createExperiment(page, EXP);

  await test.step("a sidebar link clicked right after a status change opens its page", async () => {
    await page.goto(`${base}/experiments/${EXP.id}`);
    await waitForHydration(page);
    const { delivered, undo } = await delayRefreshOnce(page, `${base}/experiments/${EXP.id}`);
    try {
      expect((await changeStatus(page, SITE.id, EXP.id, /^開始/)).publish.ok).toBe(true);
      // 読み直しの応答を待たずに押す
      const navAt = navigationRequestAt(page, `${base}/audiences`);
      await nav(page).getByRole("link", { name: "オーディエンス", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "オーディエンス", exact: true })).toBeVisible({ timeout: 15_000 });
      expect(await navAt, "the navigation starts only after the refresh has landed").toBeGreaterThanOrEqual(await delivered);
      await expect(page).toHaveURL((u) => u.pathname === `${base}/audiences`);
    } finally {
      await undo();
    }
  });

  await test.step("a settings section switched right after a save stays", async () => {
    await page.goto(`${base}/settings`);
    await waitForHydration(page);
    const siteName = page.locator('input[name="name"]');
    await siteName.press("End");
    await siteName.press("x");
    await siteName.press("Backspace");
    await expect(page.getByTestId("save-state")).toHaveText("未保存の変更あり");
    const { delivered, undo } = await delayRefreshOnce(page, `${base}/settings`);
    try {
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByText("保存しました")).toBeVisible();
      // 読み直しの応答を待たずに節を切り替える。切り替えは反映の後に回るので、応答が届くまでは一般の節のまま
      await page.getByTestId("section-tag").click();
      await page.waitForTimeout(300);
      await expect(page.getByTestId("code-block"), "the switch waits for the refresh to land").toHaveCount(0);
      await delivered;
      await expect(page.getByTestId("code-block")).toBeVisible();
      // 反映の後も導入タグの節のまま(URL と、切り替えの枠の行き先にも節が残る)
      await page.waitForTimeout(500);
      await expect(page.getByTestId("code-block")).toBeVisible();
      await expect(page).toHaveURL(/\?section=tag$/);
      await nav(page).getByRole("button", { name: /^ワークスペースとサイトの切り替え/ }).click();
      const switcher = page.getByRole("dialog", { name: "ワークスペースとサイトの切り替え" });
      await expect(switcher.getByRole("link", { name: new RegExp(`^${SITE.name}`) })).toHaveAttribute("href", /\/settings\?section=tag$/);
    } finally {
      await undo();
    }
  });
});
