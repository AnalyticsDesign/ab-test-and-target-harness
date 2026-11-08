import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { ADMIN_URL, WORKSPACE_NAME, changeStatus, createExperiment, createSite, login, markSessionsAsGoogle, pick, waitForHydration } from "./fixtures";

/**
 * 離れる前の確認(B173 第 1 段 Task 8)。
 * - 未保存の変更・保存の途中で、サイドバーのリンク・ログアウト・再読み込み・ブラウザの戻る・進むを止めて確認を出す(components/ui/PageLeaveGuard.tsx)
 * - 戻る・進むは root layout の <head> のスクリプト(lib/popstate-guard.ts)が vinext より先に受けて止める。addInitScript は使わない(本番と同じ読み込みで確かめる)
 * - CSS が遅い読み込みでは vinext のモジュールが先に走り、その文書では戻る・進むを止めない(素通りして画面が壊れないこと)。リンクの確認は効く
 * - 状態の変更(開始・終了など)の前に、未保存の変更があれば「先に保存してください」だけの確認で止める(lib/status-guard.ts)
 *
 * 戻る・進むは page.goBack() ではなく history.back() などをページの中で呼ぶ(守りが戻すので、goBack が待つ遷移の確定が来ないことがある)
 */

const SITE = { id: "site_e2e_leave", name: "E2E Leave Guard" };
const EXP = { id: "exp_e2e_leave", name: "E2E leave draft" };
const EXP_RUN = { id: "exp_e2e_leave_run", name: "E2E leave running" };
const TIMEOUT_TEXT = "画面を開けませんでした。再読み込みしてください";
const SAVED = "保存しました";

let wid = "";
/** すべてのテストが使う 1 つのコンテキスト(ログインは 1 回。fixtures.ts の login() の予算)。テストごとに新しいページ = 新しい文書 */
let ctx: BrowserContext;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await createSite(page, SITE);
  wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
  await createExperiment(page, EXP_RUN);
  expect((await changeStatus(page, SITE.id, EXP_RUN.id, /^開始/)).publish.ok).toBe(true);
  await page.goto(sitePath());
  await waitForHydration(page);
  await createExperiment(page, EXP);
  await page.close();
});

test.afterEach(async () => {
  for (const p of ctx.pages()) await p.close();
});

test.afterAll(async () => {
  await ctx?.close();
});

const sitePath = () => `/w/${wid}/sites/${SITE.id}`;
const expPath = (id: string) => `${sitePath()}/experiments/${id}`;
const apiPath = (id: string) => `/api/control/sites/${SITE.id}/experiments/${id}`;

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

const navLink = (page: Page, label: string) => page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: label, exact: true });
const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const nameInput = (page: Page) => page.getByRole("region", { name: "基本", exact: true }).getByLabel("名前(100 字以内)");
const leaveConfirm = (page: Page) => page.getByRole("alertdialog", { name: "保存していない変更があります" });
const busyConfirm = (page: Page) => page.getByRole("alertdialog", { name: "保存の途中です" });
const pathname = (page: Page) => new URL(page.url()).pathname;
const back = (page: Page) => page.evaluate(() => history.back());
const forward = (page: Page) => page.evaluate(() => history.forward());

/** サイドバーのリンクを押す(dispatchEvent: マウスを乗せないので先読みが走らない) */
const clickNav = (page: Page, label: string) => navLink(page, label).dispatchEvent("click");

/**
 * 一覧の行のリンク。名前ではなく行き先で探す: 保存の途中で離れる場面のテストは、書き込みそのものはサーバーに届くので、名前が変わる
 */
const rowLink = (page: Page, exp: { id: string }) => page.locator(`main a[href="${expPath(exp.id)}"]`).first();

/** 一覧(サイトのトップ)→ エクスペリエンスの詳細へ、クリックで移る(同じ文書の中に履歴を積む) */
async function listToDetail(page: Page, exp: { id: string }): Promise<void> {
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  await rowLink(page, exp).dispatchEvent("click");
  await expect(nameInput(page)).toBeVisible();
  await expect(page).toHaveURL((u) => u.pathname === expPath(exp.id));
}

const isRsc = (req: Request, path: string) => {
  const url = new URL(req.url());
  return req.method() === "GET" && url.pathname === path && url.searchParams.has("_rsc") && !req.headers()["next-router-prefetch"];
};

/** 送った要求を数える */
function countRequests(page: Page, match: (req: Request) => boolean): { count: () => number; list: () => string[]; stop: () => void } {
  const seen: string[] = [];
  const on = (req: Request) => {
    if (match(req)) seen.push(`${req.method()} ${req.url()}`);
  };
  page.on("request", on);
  return { count: () => seen.length, list: () => [...seen], stop: () => page.off("request", on) };
}

/**
 * admin への要求(画面の取得・API)。版の帯の定期の取り直しは時刻しだいで入るので除く。
 * 静的なファイル(/_next/static/)も除く: 確認のダイアログの見出しで初めて使う太さのフォントを、ブラウザがその時に読むため(遷移の要求ではない)
 */
const adminRequests = (page: Page) =>
  countRequests(page, (r) => r.url().startsWith(ADMIN_URL) && !r.url().includes("/capabilities") && !new URL(r.url()).pathname.startsWith("/_next/static/"));

/** 書き込みの API(method と path が一致するもの)を ms だけ遅らせる */
async function holdApi(page: Page, method: string, path: string, delayMs: number): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== method || new URL(req.url()).pathname !== path) return route.continue();
    await new Promise((r) => setTimeout(r, delayMs));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}

/** path の本描画の RSC を ms だけ(ms が null なら release まで)止める。先読みは abort する(先読みの結果で遷移が済まないように) */
async function holdRsc(page: Page, path: string, ms: number | null): Promise<{ release: () => void; undo: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname !== path || !url.searchParams.has("_rsc")) return route.continue();
    if ((await req.allHeaders())["next-router-prefetch"]) return route.abort();
    await (ms === null ? released : Promise.race([released, new Promise((r) => setTimeout(r, ms))]));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return { release, undo: () => page.unroute("**/*", handler) };
}

/** 止めた移動の後: 確認が出たまま、URL・入力が残り、admin への要求が 0 件。最後に「とどまる」で閉じる */
async function expectStopped(page: Page, action: () => Promise<unknown>, value: string, path: string): Promise<void> {
  const reqs = adminRequests(page);
  try {
    await action();
    await expect(leaveConfirm(page)).toBeVisible();
    // 画面が移った扱い(pathname の変化)で確認が閉じないこと。少し置いて見直す
    await page.waitForTimeout(500);
    await expect(leaveConfirm(page)).toBeVisible();
    expect(pathname(page)).toBe(path);
    await expect(nameInput(page)).toHaveValue(value);
    expect(reqs.list()).toEqual([]);
  } finally {
    reqs.stop();
  }
  await leaveConfirm(page).getByRole("button", { name: "とどまる", exact: true }).press("Enter");
  await expect(leaveConfirm(page)).toHaveCount(0);
}

test("unsaved changes stop a sidebar click and logout", async () => {
  const page = await ctx.newPage();
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 1");
  await clickNav(page, "目標");
  await expect(leaveConfirm(page)).toBeVisible();
  await expect(leaveConfirm(page)).toContainText("移動すると変更は失われます");
  await leaveConfirm(page).getByRole("button", { name: "とどまる", exact: true }).press("Enter");
  await expect(leaveConfirm(page)).toHaveCount(0);
  expect(pathname(page)).toBe(expPath(EXP.id));
  await expect(nameInput(page)).toHaveValue("E2E leave 1");
  // ログアウトも止まり、「とどまる」でメニューが閉じる
  const menu = page.getByTestId("user-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "ログアウト" }).click();
  await expect(leaveConfirm(page)).toBeVisible();
  await leaveConfirm(page).getByRole("button", { name: "とどまる", exact: true }).press("Enter");
  await expect(menu).not.toHaveAttribute("open", /.*/);
  expect(pathname(page)).toBe(expPath(EXP.id));
  await expect(nameInput(page)).toHaveValue("E2E leave 1");
});

test("unsaved changes stop back, two-step back and forward without any request", async () => {
  const page = await ctx.newPage();
  // 目標 → 一覧 → 詳細(同じ文書の中に 3 つの項目)
  await open(page, `${sitePath()}/goals`);
  await clickNav(page, "エクスペリエンス");
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave 2");
  await expectStopped(page, () => back(page), "E2E leave 2", expPath(EXP.id));
  await expectStopped(page, () => page.evaluate(() => history.go(-2)), "E2E leave 2", expPath(EXP.id));
  // 進む: 破棄して目標へ移り、戻って(詳細)入力してから進む
  await page.getByRole("button", { name: "破棄", exact: true }).click();
  await clickNav(page, "目標");
  await expect(h1(page, "目標")).toBeVisible();
  await back(page);
  await expect(nameInput(page)).toBeVisible();
  await waitForHydration(page);
  await nameInput(page).fill("E2E leave 3");
  await expectStopped(page, () => forward(page), "E2E leave 3", expPath(EXP.id));
});

test("a load with slow CSS does not break the page, and back passes through without the confirm", async () => {
  const page = await ctx.newPage();
  // 管理画面の CSS だけを 1.5 秒遅らせる: インラインのスクリプトは先の stylesheet を待つので、vinext のモジュールが先に走る(2026-11-02 のスパイク)
  await page.route(
    (u) => u.href.startsWith(ADMIN_URL) && u.pathname.endsWith(".css"),
    async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      return route.continue().catch(() => {});
    },
  );
  await open(page, sitePath());
  const late = await page.evaluate(() => (window as unknown as { __wttPopstateGuard?: { lateInstall: boolean } }).__wttPopstateGuard?.lateInstall ?? null);
  expect(late, "this load must run vinext before the guard script (otherwise the test checks nothing)").toBe(true);
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave slow");
  await back(page);
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  await expect(rowLink(page, EXP)).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(pathname(page)).toBe(sitePath());
  // その後の遷移・戻る・進むでも URL と本文が合う
  await forward(page);
  await expect(nameInput(page)).toBeVisible();
  expect(pathname(page)).toBe(expPath(EXP.id));
  await back(page);
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  await clickNav(page, "目標");
  await expect(h1(page, "目標")).toBeVisible();
  await back(page);
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  // リンクの確認(click の守り)は効く
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave slow 2");
  await clickNav(page, "目標");
  await expect(leaveConfirm(page)).toBeVisible();
  await leaveConfirm(page).getByRole("button", { name: "とどまる", exact: true }).press("Enter");
  expect(pathname(page)).toBe(expPath(EXP.id));
});

test("back is stopped after branching history", async () => {
  const page = await ctx.newPage();
  // A = 目標 → B = 一覧 → C = オーディエンス → B に戻る → D = 詳細(C が D に置き換わる。vinext の番号なら D は 3、実際の位置は 2)
  await open(page, `${sitePath()}/goals`);
  await clickNav(page, "エクスペリエンス");
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  await clickNav(page, "オーディエンス");
  await expect(h1(page, "オーディエンス")).toBeVisible();
  await back(page);
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave 4");
  await expectStopped(page, () => back(page), "E2E leave 4", expPath(EXP.id));
  // 「とどまる」の直後の戻るも止まる(閉じた確認の close イベントが、開き直した確認を取り消さない。components/ui/ConfirmDialog.tsx)。
  // 「移動する」で B(一覧)に着く(2 つ戻って A に行かない)
  await back(page);
  await expect(leaveConfirm(page)).toBeVisible();
  await leaveConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  expect(pathname(page)).toBe(sitePath());
});

test("choosing 移動する on back goes back", async () => {
  const page = await ctx.newPage();
  await open(page, sitePath());
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave 5");
  await back(page);
  await leaveConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
  await expect(h1(page, "エクスペリエンス")).toBeVisible();
  await expect(rowLink(page, EXP)).toBeVisible();
  expect(pathname(page)).toBe(sitePath());
});

test("a click during a save, before the write returns: moving lands on the destination with no extra refresh", async () => {
  const page = await ctx.newPage();
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 6");
  const undo = await holdApi(page, "PATCH", apiPath(EXP.id), 2_000);
  const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === apiPath(EXP.id));
  const rsc = countRequests(page, (r) => isRsc(r, expPath(EXP.id)));
  try {
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    await expect(page.getByRole("status").filter({ hasText: "保存中…" })).toBeVisible();
    await clickNav(page, "目標");
    await expect(busyConfirm(page)).toBeVisible();
    await expect(busyConfirm(page)).toContainText("移動すると、保存できたかをこの画面では確かめられません");
    await busyConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
    await expect(h1(page, "目標")).toBeVisible();
    await patched;
    await page.waitForTimeout(1_000);
    expect(rsc.count(), "no refresh of the editor after the write returns").toBe(0);
    await expect(page.getByText(SAVED, { exact: true })).toHaveCount(0);
    expect(pathname(page)).toBe(`${sitePath()}/goals`);
  } finally {
    rsc.stop();
    await undo();
  }
});

test("a click during the post-save refresh: moving lands on the destination without the timeout notice", async () => {
  const page = await ctx.newPage();
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 7");
  const held = await holdRsc(page, expPath(EXP.id), 1_500);
  try {
    const refreshing = page.waitForRequest((r) => isRsc(r, expPath(EXP.id)));
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    await refreshing;
    await clickNav(page, "目標");
    await expect(busyConfirm(page)).toBeVisible();
    await busyConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
    await expect(h1(page, "目標")).toBeVisible({ timeout: 10_000 });
    expect(pathname(page)).toBe(`${sitePath()}/goals`);
    await page.waitForTimeout(500);
    await expect(page.getByText(TIMEOUT_TEXT)).toHaveCount(0);
    await expect(page.getByText(SAVED, { exact: true })).toHaveCount(0);
  } finally {
    await held.undo();
  }
});

test("back during a save, before the write returns: moving goes back with no extra refresh", async () => {
  const page = await ctx.newPage();
  await open(page, sitePath());
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave 8");
  const undo = await holdApi(page, "PATCH", apiPath(EXP.id), 2_000);
  const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === apiPath(EXP.id));
  const rsc = countRequests(page, (r) => isRsc(r, expPath(EXP.id)));
  try {
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    await expect(page.getByRole("status").filter({ hasText: "保存中…" })).toBeVisible();
    await back(page);
    await expect(busyConfirm(page)).toBeVisible();
    await busyConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
    await expect(h1(page, "エクスペリエンス")).toBeVisible();
    expect(pathname(page)).toBe(sitePath());
    await patched;
    await page.waitForTimeout(1_000);
    expect(rsc.count(), "no refresh of the editor after the write returns").toBe(0);
    // 後回しの待ちが残っていない: サイドバーを押すとすぐ移る
    await clickNav(page, "目標");
    await expect(h1(page, "目標")).toBeVisible({ timeout: 3_000 });
  } finally {
    rsc.stop();
    await undo();
  }
});

test("back during the post-save refresh: moving lands on the previous page", async () => {
  const page = await ctx.newPage();
  await open(page, sitePath());
  await listToDetail(page, EXP);
  await nameInput(page).fill("E2E leave 9");
  const held = await holdRsc(page, expPath(EXP.id), 1_500);
  try {
    const refreshing = page.waitForRequest((r) => isRsc(r, expPath(EXP.id)));
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    await refreshing;
    await back(page);
    await expect(busyConfirm(page)).toBeVisible();
    await busyConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
    // URL だけ移って本文が止まることがない
    await expect(h1(page, "エクスペリエンス")).toBeVisible({ timeout: 10_000 });
    await expect(rowLink(page, EXP)).toBeVisible();
    expect(pathname(page)).toBe(sitePath());
  } finally {
    await held.undo();
  }
});

test("after a timed-out navigation on a page without loading.tsx, the leave guard is armed again", async () => {
  test.setTimeout(60_000);
  const page = await ctx.newPage();
  // サイト設定は第 1 段では PageLeaveGuard に載っていないので、エクスペリエンスの詳細から loading.tsx の無い行き先(サイトのトップ)へ移る形にした。
  // 打ち切りの後も元の画面(入力)が残る
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 10");
  const held = await holdRsc(page, sitePath(), null);
  try {
    await clickNav(page, "エクスペリエンス");
    await expect(leaveConfirm(page)).toBeVisible();
    await leaveConfirm(page).getByRole("button", { name: "移動する", exact: true }).press("Enter");
    await expect(page.locator("main").getByText(TIMEOUT_TEXT)).toBeVisible({ timeout: 15_000 });
    // 守りが付け直されている: もう一度押すと確認が出る
    await clickNav(page, "エクスペリエンス");
    await expect(leaveConfirm(page)).toBeVisible();
    await leaveConfirm(page).getByRole("button", { name: "とどまる", exact: true }).press("Enter");
    // 再読み込みでも beforeunload の確認が来る
    const dialog = page.waitForEvent("dialog");
    void page.reload().catch(() => {});
    const d = await dialog;
    expect(d.type()).toBe("beforeunload");
    await d.dismiss();
  } finally {
    held.release();
    await held.undo();
  }
});

test("status change with unsaved changes is stopped before the dialog", async () => {
  const page = await ctx.newPage();
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 11");
  const statusReqs = countRequests(page, (r) => r.method() === "POST" && new URL(r.url()).pathname === `${apiPath(EXP.id)}/status`);
  try {
    await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
    const dialog = leaveConfirm(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("先に保存してください");
    await expect(dialog.getByRole("button")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(1);
    await dialog.getByRole("button", { name: "閉じる", exact: true }).press("Enter");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(statusReqs.count()).toBe(0);
    await expect(page.getByRole("button", { name: "開始(公開して配信を始める)" })).toBeVisible();
  } finally {
    statusReqs.stop();
  }
});

test("ending from the results tab with unsaved changes is stopped before the dialog", async () => {
  const page = await ctx.newPage();
  const statusReqs = countRequests(page, (r) => r.method() === "POST" && new URL(r.url()).pathname === `${apiPath(EXP_RUN.id)}/status`);
  try {
    // 結果の API の応答を、評価時点を過ぎた結果(test/fixtures/results)に差し替えて、帯の終了のボタンを出す
    for (const [fixture, label] of [
      ["adopt", "終了して採用を記録"],
      ["insufficient", "採用なしで終了"],
    ] as const) {
      const body = readFileSync(new URL(`../test/fixtures/results/${fixture}.json`, import.meta.url), "utf8");
      const handler = (route: Route) =>
        route.request().method() === "GET" && new URL(route.request().url()).pathname === `${apiPath(EXP_RUN.id)}/results`
          ? route.fulfill({ status: 200, contentType: "application/json", body })
          : route.continue();
      await page.route("**/*", handler);
      try {
        await open(page, expPath(EXP_RUN.id));
        await nameInput(page).fill(`E2E leave ${fixture}`);
        await page.getByRole("tab", { name: "結果" }).click();
        const primary = page.getByTestId("results-primary");
        await expect(primary).toHaveText(label);
        await primary.click();
        const dialog = leaveConfirm(page);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("先に保存してください");
        // 終了のモーダルは開かない(確認は 1 つだけ)
        await expect(page.getByRole("alertdialog")).toHaveCount(1);
        await dialog.getByRole("button", { name: "閉じる", exact: true }).press("Enter");
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
      } finally {
        await page.unroute("**/*", handler);
      }
    }
    expect(statusReqs.count()).toBe(0);
  } finally {
    statusReqs.stop();
  }
});

test("reload with unsaved changes triggers beforeunload", async () => {
  const page = await ctx.newPage();
  await open(page, expPath(EXP.id));
  await nameInput(page).fill("E2E leave 12");
  const dialog = page.waitForEvent("dialog");
  void page.reload().catch(() => {});
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  await d.dismiss();
  await expect(nameInput(page)).toHaveValue("E2E leave 12");
});

test("an issued key stops a sidebar click and back, and 戻って控える keeps the key", async () => {
  // B173 第 2 段 Task 3: 発行したキーを控えずに離れる確認は PageLeaveGuard が出す(リンク・ログアウト・再読み込みに加えて、戻る・進むも止める)
  markSessionsAsGoogle(); // B112: パスワードのセッションからは発行できない
  const page = await ctx.newPage();
  // 画面表示 → API キー(同じ文書の中に履歴を積む。戻るが守りに当たるように)
  await open(page, "/w/me/display");
  await clickNav(page, "API キー");
  await expect(page.getByRole("button", { name: "発行する" })).toBeVisible();
  await page.fill('input[name="name"]', "e2e-leave-guard-key");
  await pick(page, "範囲", new RegExp(`^${WORKSPACE_NAME}`));
  await pick(page, "権限", /^閲覧者/);
  await pick(page, "有効期限", /^1 日/);
  await page.getByRole("button", { name: "発行する" }).click();
  const title = page.getByRole("heading", { name: "API キーを発行しました" });
  await expect(title).toBeFocused();
  const key = page.getByTestId("issued-key");
  await expect(key).toContainText(/wtt_/);
  const leave = page.getByRole("alertdialog", { name: "キーをまだ控えていません" });
  const stay = leave.getByRole("button", { name: "戻って控える", exact: true });

  // サイドバーのリンク: 確認が出て、「戻って控える」でキーが見えたまま、フォーカスは結果の見出し
  await navLink(page, "画面表示").click();
  await expect(leave).toBeVisible();
  await expect(leave).toContainText("移動すると、このキーは二度と表示できません");
  await expect(stay).toBeFocused();
  await stay.press("Enter");
  await expect(leave).toHaveCount(0);
  expect(pathname(page)).toBe("/w/me/api-keys");
  await expect(key).toContainText(/wtt_/);
  await expect(title).toBeFocused();

  // 戻る: 同じ確認が出て、出ている間は admin への要求が 0 件
  const reqs = adminRequests(page);
  try {
    await back(page);
    await expect(leave).toBeVisible();
    await page.waitForTimeout(500);
    await expect(leave).toBeVisible();
    expect(pathname(page)).toBe("/w/me/api-keys");
    expect(reqs.list()).toEqual([]);
  } finally {
    reqs.stop();
  }
  await stay.press("Enter");
  await expect(leave).toHaveCount(0);
  expect(pathname(page)).toBe("/w/me/api-keys");
  await expect(key).toContainText(/wtt_/);

  // 「移動する」で移る
  await clickNav(page, "画面表示");
  await leave.getByRole("button", { name: "移動する", exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/w\/me\/display$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
