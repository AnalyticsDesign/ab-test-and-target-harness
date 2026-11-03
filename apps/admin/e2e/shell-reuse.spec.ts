import { test, expect, type Page } from "@playwright/test";
import { ADMIN_URL, WORKSPACE_NAME, controlHeaders, createSite, login, waitForHydration } from "./fixtures";
import { delayRsc } from "./rsc-delay";

/**
 * 管理画面の速さ(最終レビュー CX-R1): 読み込み中の枠(vinext の optimistic route shell)が、別のサイト・ワークスペースで覚えた
 * layout(上部バーのパンくず・公開のリンク)を出さないことを確かめる。直しは components/ui/SiteChromeGuard.tsx
 * (描いたときの wid・sid と useParams() が違えば、上部バーを同じ高さの空の帯にする)。
 *
 * vinext(1.0.0-beta.10)は枠を経路の定義だけを鍵に覚え、params を照らさない。そのため、サイト A で覚えたオーディエンスの枠が、
 * サイト B のオーディエンスへの遷移で、B の応答が届くまで出る(直す前は、上部バーに A の名前と A の公開のリンクが出た)。
 *
 * 流れ: 1 回の文書の中でクライアント遷移だけで動く(page.goto / reload は先読みの cache と覚えた枠を消す)。
 * 移動先の本描画の RSC を page.route で 2 秒遅らせ、その間 100 ms ごとに上部バーを読む。場面ごとに次を表明する:
 * - 読み込み中の表示が 1 回以上出た(出なければ、下の表明が素通りする)
 * - 読み込み中の間、パンくずに移動先以外のサイト・ワークスペースの名前が出ない。公開のリンクは移動先のサイトのものだけ
 * - 枠を描いた時点で useParams() が移動先の wid・sid を返す(別のサイトの枠なら、上部バーの帯の data-current-site が移動先)
 * 先読みを止めたい場面は dispatchEvent("click") で押す(マウスが乗らないので先読みが走らない)。
 * 表明は soft にして、ある場面で漏れても残りの場面まで確かめる(どの場面で漏れたかを 1 回の実行で出す)
 */

const A = { id: "site_e2e_sha", name: "E2E Shell Alpha" };
const B = { id: "site_e2e_shb", name: "E2E Shell Bravo" };
const C = { id: "site_e2e_shc", name: "E2E Shell Charlie" };
const D = { id: "site_e2e_shd", name: "E2E Shell Delta" };
const SITES = [A, B, C, D];
const WS2_NAME = "E2E Shell Other WS";
const DELAY_MS = 2_000;

type Snap = { crumbs: string | null; publishHref: string | null; loading: boolean; skeleton: { rendered: string | null; current: string | null } | null };

/** 上部バーと読み込み中の表示を 1 回で読む */
async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const sk = document.querySelector('[data-testid="topbar-skeleton"]');
    return {
      crumbs: document.querySelector('[data-testid="topbar-crumbs"]')?.textContent ?? null,
      publishHref: document.querySelector('[data-testid="topbar-publish"]')?.getAttribute("href") ?? null,
      loading: document.querySelector('[role="status"][aria-busy="true"]') !== null,
      skeleton: sk ? { rendered: sk.getAttribute("data-rendered-site"), current: sk.getAttribute("data-current-site") } : null,
    };
  });
}

/** 押した直後から、遅らせた本描画が届いた後まで 100 ms ごとに読む */
async function observe(page: Page, act: () => Promise<void>, done: () => Promise<void>): Promise<Snap[]> {
  const t0 = Date.now();
  const snaps: Snap[] = [];
  await act();
  while (Date.now() - t0 < DELAY_MS + 1_000) {
    snaps.push(await snap(page));
    await page.waitForTimeout(100);
  }
  await done();
  snaps.push(await snap(page));
  return snaps;
}

/**
 * 1 つの場面の表明。dest = 移動先、wsName = 移動先のワークスペースの名前、otherWsName = もう一方のワークスペースの名前。
 * expectSkeleton = 別のサイトで覚えた枠が使われる場面(上部バーが帯になり、data-current-site が移動先であること)
 */
function expectNoLeak(snaps: Snap[], dest: { wid: string; site: { id: string; name: string } }, otherWsName: string, expectSkeleton: boolean): void {
  const loading = snaps.filter((s) => s.loading);
  expect.soft(loading.length, "the loading shell must appear (otherwise the checks below pass vacuously)").toBeGreaterThan(0);
  if (loading.length === 0) return;
  // 読み込み中の読み取りのうち、移動先以外の名前・公開のリンクが出たもの(場面ごとに 1 つの表明にまとめる)
  const otherNames = [...SITES.filter((s) => s.id !== dest.site.id).map((s) => s.name), otherWsName];
  const publishHref = `/w/${dest.wid}/sites/${dest.site.id}/publish`;
  const leaks = loading.filter((s) => otherNames.some((n) => (s.crumbs ?? "").includes(n)) || (s.publishHref !== null && s.publishHref !== publishHref));
  expect.soft(leaks.map((s) => ({ crumbs: s.crumbs, publishHref: s.publishHref })), "top bar must not show another site's / workspace's name or publish link while loading").toEqual([]);
  if (expectSkeleton) {
    // 枠を描いた時点(読み込み中の最初の読み取り)で、上部バーは帯になっていて、useParams() は移動先を返している
    expect.soft(loading[0]!.skeleton, "top bar must be the skeleton band in another site's shell").not.toBeNull();
    expect.soft(loading.flatMap((s) => (s.skeleton ? [s.skeleton.current] : [])).filter((c) => c !== `${dest.wid}/${dest.site.id}`), "useParams() must return the destination").toEqual([]);
  } else {
    // 移動先のサイトで覚えた枠: 上部バーは移動先の値のまま(同じサイトの中の遷移と同じ)
    expect.soft(loading[0]!.crumbs ?? "").toContain(dest.site.name);
  }
  // 届いた後(最後の読み取り)は移動先の上部バー
  expect.soft(snaps.at(-1)!.skeleton).toBeNull();
  expect.soft(snaps.at(-1)!.crumbs ?? "").toContain(dest.site.name);
}

/** サイドバーのサイトのメニューのリンク */
const navLink = (page: Page, label: string) => page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: label, exact: true });

/** クライアント遷移(window.next.router.push)。page.goto と違い先読みの cache と覚えた枠を消さない */
async function push(page: Page, href: string, name: string): Promise<void> {
  await page.evaluate((h) => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push(h), href);
  await expect(page).toHaveURL(new RegExp(`${href.replace(/[/]/g, "\\/")}$`));
  await expect(page.getByTestId("topbar-crumbs")).toContainText(name);
  await waitForHydration(page);
}

/** 本描画が届いた(読み込み中の表示が消え、上部バーが移動先のサイト) */
const settled = (page: Page, name: string) => async () => {
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("topbar-crumbs")).toContainText(name, { timeout: 10_000 });
};

test("the loading shell never shows another site's or workspace's top bar", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await createSite(page, A);
  const wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
  await createSite(page, B);

  // 別のワークスペースとそのサイト C、オーディエンスをまだ一度も開いていないサイト D(BFF から作る。オーナーはシステム管理者)
  const ws = await page.request.post(`${ADMIN_URL}/api/control/workspaces`, { headers: controlHeaders(), data: { name: WS2_NAME } });
  expect(ws.status()).toBe(201);
  const wid2 = ((await ws.json()) as { id: string }).id;
  for (const [w, s] of [[wid2, C], [wid, D]] as const) {
    expect((await page.request.post(`${ADMIN_URL}/api/control/workspaces/${w}/sites`, { headers: controlHeaders(), data: { name: s.name, domains: ["localhost"], id: s.id } })).status()).toBe(201);
    expect((await page.request.patch(`${ADMIN_URL}/api/control/sites/${s.id}`, { headers: controlHeaders(), data: { resultsEnabled: false } })).status()).toBe(200);
  }

  // ここから先は 1 回の文書の中。A のオーディエンスを先読みして、枠を覚えさせる
  await page.goto(`/w/${wid}/sites/${A.id}`);
  await waitForHydration(page);
  {
    const res = page.waitForResponse((r) => r.url().includes(`/w/${wid}/sites/${A.id}/audiences`) && r.url().includes("_rsc"));
    await navLink(page, "オーディエンス").hover();
    await res;
    await page.waitForTimeout(500);
  }

  await test.step("same workspace, another site, no prefetch of the destination", async () => {
    await push(page, `/w/${wid}/sites/${B.id}`, B.name);
    const undo = await delayRsc(page, new RegExp(`/sites/${B.id}/audiences$`), DELAY_MS);
    const snaps = await observe(page, () => navLink(page, "オーディエンス").dispatchEvent("click"), settled(page, B.name));
    await undo();
    expectNoLeak(snaps, { wid, site: B }, WS2_NAME, true);
  });

  await test.step("hover then click at once (the prefetch is not registered yet)", async () => {
    await push(page, `/w/${wid}/sites/${D.id}`, D.name);
    const undo = await delayRsc(page, new RegExp(`/sites/${D.id}/audiences$`), DELAY_MS, true);
    const snaps = await observe(page, () => navLink(page, "オーディエンス").click(), settled(page, D.name));
    await undo();
    expectNoLeak(snaps, { wid, site: D }, WS2_NAME, true);
  });

  await test.step("a site in another workspace", async () => {
    await push(page, `/w/${wid2}/sites/${C.id}`, C.name);
    const undo = await delayRsc(page, new RegExp(`/sites/${C.id}/audiences$`), DELAY_MS);
    const snaps = await observe(page, () => navLink(page, "オーディエンス").dispatchEvent("click"), settled(page, C.name));
    await undo();
    expectNoLeak(snaps, { wid: wid2, site: C }, WORKSPACE_NAME, true);
  });

  await test.step("prefetch of the destination completed, then click", async () => {
    await push(page, `/w/${wid}/sites/${B.id}`, B.name);
    const undo = await delayRsc(page, new RegExp(`/sites/${B.id}/goals$`), DELAY_MS, true);
    const pre = page.waitForResponse((r) => r.url().includes(`/sites/${B.id}/goals`) && r.url().includes("_rsc"));
    await navLink(page, "目標").hover();
    await pre;
    await page.waitForTimeout(500);
    const snaps = await observe(page, () => navLink(page, "目標").click(), settled(page, B.name));
    await undo();
    expectNoLeak(snaps, { wid, site: B }, WS2_NAME, false);
  });

  await test.step("back to the first site after the shell was remembered on another site", async () => {
    // 目標の枠は直前に B で覚えた(枠は経路の形ごとに 1 つ = 最後に覚えたものが使われる)
    await push(page, `/w/${wid}/sites/${A.id}`, A.name);
    const undo = await delayRsc(page, new RegExp(`/sites/${A.id}/goals$`), DELAY_MS);
    const snaps = await observe(page, () => navLink(page, "目標").dispatchEvent("click"), settled(page, A.name));
    await undo();
    expectNoLeak(snaps, { wid, site: A }, WS2_NAME, true);
  });
});
