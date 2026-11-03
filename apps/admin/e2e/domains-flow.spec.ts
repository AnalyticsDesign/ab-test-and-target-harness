import { test, expect, type Page } from "@playwright/test";
import { FAKE_EDGE_URL, controlHeaders, createSite, login, pick, waitForHydration } from "./fixtures";

/**
 * B148: サイト設定の「ドメイン」の節。control の確かめ(/__ab/ping)は、E2E では AB_PROBE_ORIGIN_OVERRIDE(と有効にする AB_E2E_PROBE_OVERRIDE_ENABLED)で偽の edge(e2e/fake-edge-ping.mjs)に届く:
 * edge.example.test = この導入の edge / slow.example.test = 4 秒待つ(control は 3 秒で打ち切る)/ ほか = 404(Cloudflare 外)。
 * 専用のサイトを作るので、ほかの project の状態には触らない。ログインは 1 回(fixtures.ts の login() の予算)
 */
const SITE_DOM = { id: "site_e2e_domains", name: "E2E Domains" };

/** 偽の edge が起動から受けた /__ab/ping の数 */
async function fakeEdgeCount(): Promise<number> {
  const res = await fetch(`${FAKE_EDGE_URL}/__e2e/requests`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

const section = (page: Page) => page.getByTestId("domains-section");
const rowInput = (page: Page, i: number) => section(page).locator(`input[name="domains.${i}"]`);
const verdict = (page: Page, i: number) => section(page).getByTestId("domain-verdict").nth(i);
const saveState = (page: Page) => page.getByTestId("save-state");

/** 保存を押して PATCH の応答を待つ(状態を返す) */
async function save(page: Page): Promise<number> {
  const done = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE_DOM.id}`) && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  return (await done).status();
}

test("domains section: verdicts from the fake edge, normalizing preview, row errors, timeouts, deferred rows and no probes from other sections", async ({ page }) => {
  // slow の 3 秒の打ち切り・41 行の確かめ(2 回)・再読み込みが入るので、既定の 60 秒では足りない
  test.setTimeout(180_000);
  await login(page);
  await createSite(page, SITE_DOM);
  const settingsUrl = page.url().replace(/[?#].*$/, "") + "/settings";

  await test.step("Mode B with an edge domain and an outside domain", async () => {
    await page.goto(`${settingsUrl}?section=domains`);
    await waitForHydration(page);
    await expect(page.getByTestId("section-domains")).toHaveAttribute("aria-current", "page");
    await pick(page, "導入の形", /^B: サーバー発行 Cookie/);
    await rowInput(page, 0).fill("edge.example.test");
    await section(page).getByRole("button", { name: "ドメインを足す" }).click();
    await rowInput(page, 1).fill("form.example.test");
    expect(await save(page)).toBe(200);
    await expect(page.getByText("保存しました")).toBeVisible();
    // 札と決まる値は保存の後の読み直し(router.refresh)が届いてから変わる
    await expect(verdict(page, 0)).toContainText("Cloudflare 経由", { timeout: 15_000 });
    await expect(verdict(page, 1)).toContainText("Cloudflare 外");
    const derived = page.getByTestId("domains-derived");
    // 決まる値: Cloudflare 外 = form.example.test、共有の範囲 = example.test のまとまり
    await expect(derived.locator("dt", { hasText: /^Cloudflare 外のドメイン$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("form.example.test");
    await expect(derived).toContainText("example.test: edge.example.test・form.example.test で共有");
  });

  await test.step("normalizing preview for a scheme / upper case / trailing slash", async () => {
    await section(page).getByRole("button", { name: "ドメインを足す" }).click();
    await rowInput(page, 2).fill("HTTPS://Edge.Example.test/");
    await expect(section(page)).toContainText("保存すると edge.example.test になります");
    await section(page).getByRole("button", { name: "3 行目を削除" }).click();
  });

  await test.step("a row with a path is refused with a Japanese message and the domains section stays open", async () => {
    await section(page).getByRole("button", { name: "ドメインを足す" }).click();
    await rowInput(page, 2).fill("www.example.test/form");
    expect(await save(page)).toBe(422);
    await expect(section(page).getByRole("alert").filter({ hasText: "パス(/ より後ろ)・?・# は書けません" })).toBeVisible();
    await expect(section(page)).toBeVisible();
    await expect(page.getByTestId("section-domains")).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/[?&]section=domains/);
  });

  await test.step("a slow edge is cut off at 3 seconds and shown as not checked; the save bar says the domains are being checked", async () => {
    await rowInput(page, 2).fill("slow.example.test");
    const started = Date.now();
    const done = save(page);
    await expect(saveState(page)).toHaveText("保存しています。ドメインを確かめています");
    expect(await done).toBe(200);
    // 偽の edge は 4 秒後に edge として答えるので、「確かめられませんでした」は 3 秒の打ち切りが効いた印
    await expect(verdict(page, 2)).toContainText("確かめられませんでした", { timeout: 15_000 });
    await expect(verdict(page, 0)).toContainText("Cloudflare 経由");
    console.log(`[domains-flow] save with slow.example.test took ${Date.now() - started} ms`);
  });

  await test.step("saving only the general section sends no probe to the edge", async () => {
    // 前の保存の読み直しが済んでから(未保存の変更が無い状態から)。前の段の verdict(page, 2) の表明が、読み直しが画面に届いた印
    // (届く前は保存済みの一覧が古く、一覧を変えた扱いになって domains を送る)。この段を前の段より前に動かさないこと
    await expect(saveState(page)).not.toHaveText("保存しています。ドメインを確かめています");
    await page.getByTestId("section-general").click();
    const before = await fakeEdgeCount();
    await page.locator('input[name="name"]').fill(`${SITE_DOM.name} renamed`);
    expect(await save(page)).toBe(200);
    await expect(page.getByText("保存しました")).toBeVisible();
    expect(await fakeEdgeCount()).toBe(before);
    // 戻す(同じく一般の節だけ)
    await page.locator('input[name="name"]').fill(SITE_DOM.name);
    expect(await save(page)).toBe(200);
    expect(await fakeEdgeCount()).toBe(before);
  });

  await test.step("the install tag section points at the domains section", async () => {
    await page.getByTestId("section-tag").click();
    await expect(page.getByTestId("code-block")).toBeVisible();
    await expect(page.locator("main")).toContainText("手順はドメインの節");
    await page.getByRole("link", { name: "ドメインで変える" }).click();
    await expect(page).toHaveURL(/[?&]section=domains/);
    await expect(section(page)).toBeVisible();
    await expect(page.getByTestId("section-domains")).toHaveAttribute("aria-current", "page");
  });

  await test.step("rows over the Free limit are deferred and the note stays after the refresh that follows the save", async () => {
    // Free(E2E の既定のプラン)は 1 回の保存で 40 行まで確かめる。41 行にすると 1 行が次の保存に回る
    const rows = Array.from({ length: 41 }, (_, i) => `h${i + 1}.example.test`);
    const put = await page.request.patch(`/api/control/sites/${SITE_DOM.id}`, { headers: controlHeaders(), data: { domains: rows } });
    expect(put.status()).toBe(200);
    await page.goto(`${settingsUrl}?section=domains`);
    await waitForHydration(page);
    await expect(rowInput(page, 40)).toHaveValue("h41.example.test");
    // 保存の後の読み直し(RSC)の応答まで待ってから見る
    const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/settings") && new URL(r.url()).searchParams.has("_rsc"));
    expect(await save(page)).toBe(200);
    await refreshed;
    const deferred = section(page).getByTestId("domain-verdict").filter({ hasText: "次の保存で確かめます" });
    await expect(deferred).toHaveCount(1);
    // 読み直しの反映を待ってからもう一度(反映で消えないこと)
    await page.waitForTimeout(1_000);
    await expect(deferred).toHaveCount(1);
    await expect(section(page).getByTestId("domain-verdict").filter({ hasText: "Cloudflare 外" })).toHaveCount(41);
  });
});
