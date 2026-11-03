import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { ADMIN_URL, controlHeaders, createExperiment, createSite, login, waitForHydration } from "./fixtures";
import { delayRsc } from "./rsc-delay";

/**
 * 操作のフィードバック(B173 第 1 段 Task 4): 遷移中の表示。
 * - 遅い遷移は、押してから 150 ms の後に本文のスケルトン(components/ui/NavGate.tsx → RouteLoading)と押したリンクの回る印(AppLink の data-nav-pending)を出す
 * - 150 ms より速い遷移では何も出さない(先読みの有無どちらも)。loading.tsx の枠が出ても、store の遷移が見せる状態になるまで隠す
 * - 別のサイトへの遷移では、上部バーを帯にして前のサイトの名前・公開のリンクを出さない(ChromeScopeGuard・SiteChromeGuard)
 * - 存在しないエクスペリエンスへの遷移は、404 の表示で終わり、打ち切りの文言を出さない
 * - 10 秒で打ち切った遷移は、読み込み中の枠の上に打ち切りの文言を出す
 *
 * 同じ pathname で検索の文字列だけが違う遷移の E2E は無い: 管理画面に、そうした本物の AppLink が無い(サイト設定の節のリンク・
 * エクスペリエンスの一覧の状態の絞り込みは replaceState だけで、ルーターを通らない)。終わりの判定は test/feedback-store.test.ts で見る。
 *
 * 時刻はページの中で測る(MutationObserver と、capture のクリックの listener の performance.now())。Playwright から 100 ms ごとに
 * 読む方法だと、往復の揺れで 100 ms・400 ms の境目が見えないため
 */

const A = { id: "site_e2e_nfa", name: "E2E Nav Alpha" };
const B = { id: "site_e2e_nfb", name: "E2E Nav Bravo" };
const EXP = { id: "exp_e2e_nfgone", name: "E2E nav gone" };
const TIMEOUT_TEXT = "画面を開けませんでした。再読み込みしてください";
const DELAY_MS = 2_000;

type Watch = { click: number | null; skeleton: number | null; pending: number | null; busy: number | null; leaks: Array<{ t: number; crumbs: string; publishHref: string | null }>; band: number | null };

/**
 * ページの中に見張りを置く。次に起きたクリックの時刻と、見える本文のスケルトン・data-nav-pending・aria-busy の要素が最初に出た時刻、
 * leakName があれば、上部バーにその名前・公開のリンク(leakHref)が出た時刻と、上部バーの帯が出た時刻を記録する
 */
async function watch(page: Page, leak?: { name: string; publishHref: string }): Promise<void> {
  await page.evaluate((leakArg) => {
    const rec: Watch = { click: null, skeleton: null, pending: null, busy: null, leaks: [], band: null };
    (window as unknown as { __watch: Watch }).__watch = rec;
    // hidden 属性(display: none)と visibility: hidden の両方を見えないとみなす
    const shown = (el: Element) => (el as HTMLElement).checkVisibility({ visibilityProperty: true });
    const check = () => {
      const t = performance.now();
      const any = (sel: string) => [...document.querySelectorAll(sel)].some(shown);
      if (rec.skeleton === null && any('[role="status"][aria-busy="true"]')) rec.skeleton = t;
      if (rec.pending === null && any("[data-nav-pending]")) rec.pending = t;
      if (rec.busy === null && any('[aria-busy="true"]')) rec.busy = t;
      if (leakArg) {
        if (rec.band === null && any('[data-testid="topbar-skeleton"]')) rec.band = t;
        const crumbs = document.querySelector('[data-testid="topbar-crumbs"]')?.textContent ?? "";
        const publishHref = document.querySelector('[data-testid="topbar-publish"]')?.getAttribute("href") ?? null;
        if (crumbs.includes(leakArg.name) || publishHref === leakArg.publishHref) rec.leaks.push({ t, crumbs, publishHref });
      }
    };
    document.addEventListener("click", () => (rec.click ??= performance.now()), { capture: true });
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }, leak ?? null);
}

const readWatch = (page: Page) => page.evaluate(() => (window as unknown as { __watch: Watch }).__watch);

/** サイドバーのサイトのメニューのリンク */
const navLink = (page: Page, label: string) => page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: label, exact: true });
const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const bodySkeleton = (page: Page) => page.locator("main").getByRole("status").filter({ hasText: "読み込み中…" });

let wid = "";
/** すべてのテストが使う 1 つのコンテキスト(ログインは 1 回。fixtures.ts の login() の予算)。テストごとに新しいページ = 新しい文書(先読みの cache・覚えた枠は持ち越さない) */
let ctx: BrowserContext;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // サイト 2 つとエクスペリエンス 1 件を作る
  const page = await ctx.newPage();
  await login(page);
  await createSite(page, A);
  wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
  await createExperiment(page, EXP);
  await createSite(page, B);
  await page.close();
});

test.afterEach(async () => {
  for (const p of ctx.pages()) await p.close();
});

test.afterAll(async () => {
  await ctx?.close();
});

const siteTop = (site: { id: string }) => `/w/${wid}/sites/${site.id}`;

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

test("slow nav shows the body skeleton and the pressed-link spinner after 150 ms", async () => {
  const page = await ctx.newPage();
  await open(page, siteTop(A));
  // 先読みは abort して(dispatchEvent で押すのでマウスも乗らない)、loading.tsx の枠の無い状態にする: 前の画面のまま止まって見える場面
  const undo = await delayRsc(page, new RegExp(`/sites/${A.id}/goals$`), DELAY_MS);
  await watch(page);
  const link = navLink(page, "目標");
  await link.dispatchEvent("click");
  await expect(link).toHaveAttribute("aria-busy", "true");
  await expect(bodySkeleton(page)).toBeVisible();
  const w = await readWatch(page);
  expect(w.click).not.toBeNull();
  expect(w.skeleton! - w.click!, "the body skeleton must not show within 100 ms").toBeGreaterThan(100);
  expect(w.skeleton! - w.click!, "the body skeleton must show by 400 ms").toBeLessThanOrEqual(400);
  expect(w.pending! - w.click!).toBeGreaterThan(100);
  expect(w.pending! - w.click!).toBeLessThanOrEqual(400);
  // 届いた後はどちらも消える
  await expect(h1(page, "目標")).toBeVisible({ timeout: 10_000 });
  await expect(bodySkeleton(page)).toHaveCount(0);
  await expect(page.locator("[data-nav-pending]")).toHaveCount(0);
  await expect(link).not.toHaveAttribute("aria-busy", "true");
  await undo();
});

test("fast nav shows nothing, with and without prefetch", async () => {
  const page = await ctx.newPage();
  await open(page, siteTop(A));
  // 各画面の最初の描画は、手元の wrangler dev の admin の Worker が画面のコードを読み込むので 300 ms ほどかかる(実測。2 回目からは 30〜40 ms)。
  // 速い遷移を確かめるため、先に 1 回ずつ開いておく(ここは見張らない)
  for (const title of ["目標", "オーディエンス", "エクスペリエンス"]) {
    await navLink(page, title).dispatchEvent("click");
    await expect(h1(page, title)).toBeVisible();
    await waitForHydration(page);
  }
  await test.step("without prefetch", async () => {
    await watch(page);
    await navLink(page, "目標").dispatchEvent("click");
    await expect(h1(page, "目標")).toBeVisible();
    // 印が出て遷移が終わった後、見せる遅らせ(150 ms)を過ぎても何も出ない
    await page.waitForTimeout(300);
    const w = await readWatch(page);
    expect({ skeleton: w.skeleton, pending: w.pending, busy: w.busy }).toEqual({ skeleton: null, pending: null, busy: null });
  });
  await test.step("after the prefetch has completed (the loading.tsx shell shows at once but stays hidden)", async () => {
    const pre = page.waitForResponse((r) => r.url().includes(`/sites/${A.id}/audiences`) && r.url().includes("_rsc"));
    await navLink(page, "オーディエンス").hover();
    await pre;
    await page.waitForTimeout(500);
    await watch(page);
    await navLink(page, "オーディエンス").click();
    await expect(h1(page, "オーディエンス")).toBeVisible();
    await page.waitForTimeout(300);
    const w = await readWatch(page);
    expect({ skeleton: w.skeleton, pending: w.pending, busy: w.busy }).toEqual({ skeleton: null, pending: null, busy: null });
  });
});

test("cross-site nav never shows the previous site's name in the top bar", async () => {
  const page = await ctx.newPage();
  await open(page, siteTop(A));
  // サイトのトップには loading.tsx が無い: 届くまで A の画面が残る(上部バーの照らし合いが store の遷移だけで決まる場面)
  const undo = await delayRsc(page, new RegExp(`/sites/${B.id}$`), DELAY_MS);
  await page.getByRole("button", { name: /^ワークスペースとサイトの切り替え/ }).click();
  const dialog = page.getByRole("dialog", { name: "ワークスペースとサイトの切り替え" });
  await watch(page, { name: A.name, publishHref: `${siteTop(A)}/publish` });
  await dialog.getByRole("link", { name: new RegExp(B.name) }).dispatchEvent("click");
  await expect(page.getByTestId("topbar-crumbs")).toContainText(B.name, { timeout: 10_000 });
  await undo();
  const w = await readWatch(page);
  expect(w.band, "the top bar must turn into the band while loading (otherwise the check below passes vacuously)").not.toBeNull();
  // 押してから 150 ms(+ 描画の余裕)までは、まだ何も変えない(速い遷移でちらつかせないため)ので A のままでよい
  const leaks = w.leaks.filter((l) => l.t - w.click! > 250);
  expect(leaks, "top bar must not show the previous site's name or publish link while loading").toEqual([]);
});

test("nav to a missing experiment ends with the not-found view and no timeout notice", async () => {
  const page = await ctx.newPage();
  test.setTimeout(60_000);
  await open(page, siteTop(A));
  const row = page.getByRole("link", { name: EXP.name, exact: true });
  await expect(row).toBeVisible();
  // 一覧を開いた後で消す(一覧の行のリンクは残る)
  expect((await page.request.delete(`${ADMIN_URL}/api/control/sites/${A.id}/experiments/${EXP.id}`, { headers: controlHeaders() })).status()).toBe(204);
  await row.click();
  await expect(page.getByRole("heading", { name: "ページが見つかりません" })).toBeVisible({ timeout: 10_000 });
  // 打ち切り(10 秒)を過ぎても文言は出ない(404 の印で遷移が終わっている)
  await page.waitForTimeout(11_000);
  await expect(page.getByText(TIMEOUT_TEXT)).toHaveCount(0);
});

test("a nav that times out shows the timeout notice on the loading view", async () => {
  const page = await ctx.newPage();
  test.setTimeout(60_000);
  await open(page, siteTop(A));
  // 先読み(loading.tsx の枠)を済ませる
  const pre = page.waitForResponse((r) => r.url().includes(`/sites/${A.id}/goals`) && r.url().includes("_rsc"));
  await navLink(page, "目標").hover();
  await pre;
  await page.waitForTimeout(500);
  // 本描画の RSC を、打ち切りの文言を確かめるまで止める(11 秒で放すと、10〜11 秒の 1 秒の窓でしか見えない)
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith(`/sites/${A.id}/goals`) || !url.search.includes("_rsc") || (await route.request().allHeaders())["next-router-prefetch"]) return route.continue();
    await released;
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  try {
    const t0 = Date.now();
    await navLink(page, "目標").click();
    await expect(page.locator("main").getByText(TIMEOUT_TEXT)).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - t0, "the notice comes from the 10 s timeout").toBeGreaterThanOrEqual(9_500);
    // 読み込み中の枠(loading.tsx)の上に出ている
    await expect(page).toHaveURL((u) => u.pathname.endsWith("/goals"));
  } finally {
    release();
    await page.unroute("**/*", handler);
  }
  // 届けば画面が描かれ、文言は消える
  await expect(h1(page, "目標")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(TIMEOUT_TEXT)).toHaveCount(0);
});
