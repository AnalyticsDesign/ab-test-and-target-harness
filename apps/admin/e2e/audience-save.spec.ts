import { test, expect, type Dialog, type Page, type Request, type Route } from "@playwright/test";
import { appAlert, controlHeaders, createSite, login, waitForHydration } from "./fixtures";

/**
 * オーディエンスの保存(B173 第 2 段 Task 4 = S2-1)。
 * - 保存の間は画面と保存の帯を覆い(「保存中…」)、入力と二度押しを止める。保存の後の読み直しは 1 回
 * - PATCH は自分が変えた欄だけを載せる(開いた後にほかの人が変えた条件を、メモだけの保存で上書きしない)
 * - 未保存のまま新しいサーバーの値が届いたら、入力を残して帯に注記を出す。破棄は最新のサーバーの値へ戻す。
 *   届け方: 目標が 0 件のサイトで目標の条件を置くと出る「目標を読み直す」(router.refresh で画面の値を読み直す。利用者の操作で決まって起こせる)
 * - 未保存の変更があれば、サイドバーのリンクと戻るを止める(新規作成の画面も)
 * - 新規作成は詳細の画面へ移るまで覆い続け、自分の移動では離れる前の確認(native・画面の確認とも)を出さない(Task 1 の releaseGuard の決まり)
 *
 * このサイトには目標を作らない(上の「目標を読み直す」を出すため)
 */

const SITE = { id: "site_e2e_audsave", name: "E2E Audience Save" };
const DEF_A = { ctx: "device", op: "in", value: ["mobile"] };
const DEF_B = { ctx: "device", op: "in", value: ["desktop"] };
const AUD = { id: "aud_e2e_save", name: "E2E save audience" };
const AUD_MEMO = { id: "aud_e2e_save_memo", name: "E2E memo audience" };
const AUD_UPD = { id: "aud_e2e_save_upd", name: "E2E update audience" };
const AUD_DISC = { id: "aud_e2e_save_disc", name: "E2E discard audience" };
const REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
const SAVED = "保存しました。次の公開で反映されます";
const SERVER_UPDATED = "この画面を開いた後に、内容が更新されました";

const isRsc = (req: Request, pathname: string) => {
  const url = new URL(req.url());
  return req.method() === "GET" && url.pathname === pathname && url.searchParams.has("_rsc") && !req.headers()["next-router-prefetch"];
};

/** 送った要求を数える */
function countRequests(page: Page, match: (req: Request) => boolean): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (req: Request) => {
    if (match(req)) n += 1;
  };
  page.on("request", on);
  return { count: () => n, stop: () => page.off("request", on) };
}

/** method と BFF の path(`/api/control` を除いたもの)が一致する応答を ms だけ遅らせる(または fulfill で差し替える) */
async function holdApi(page: Page, method: string, path: string, how: { delayMs?: number; fulfill?: { status: number; body: unknown } }): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== method || new URL(req.url()).pathname !== `/api/control${path}`) return route.continue();
    if (how.delayMs) await new Promise((r) => setTimeout(r, how.delayMs));
    if (how.fulfill) return route.fulfill({ status: how.fulfill.status, contentType: "application/json", body: JSON.stringify(how.fulfill.body) });
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}

/** pathname の本描画の RSC を ms だけ止める(先読みは止めない) */
async function holdRsc(page: Page, pathname: string, ms: number): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    if (!isRsc(route.request(), pathname)) return route.continue();
    await new Promise((r) => setTimeout(r, ms));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}

test.describe.serial("audience save (B173 stage 2)", () => {
  let page: Page;
  let siteUrl: string;
  const sitePath = () => new URL(siteUrl).pathname;
  const audPath = (id: string) => `${sitePath()}/audiences/${id}`;
  const apiPath = (id: string) => `/sites/${SITE.id}/audiences/${id}`;
  const api = async (method: string, path: string, data?: unknown) => {
    const r = await page.request.fetch(`/api/control${path}`, { method, headers: controlHeaders(), data });
    return { status: r.status(), json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const open = async (id: string) => {
    await page.goto(audPath(id));
    await waitForHydration(page);
  };
  const nameInput = () => page.getByLabel("名前", { exact: true });
  const memoInput = () => page.getByLabel("メモ(任意)", { exact: true });
  const saveButton = () => page.getByRole("button", { name: "保存", exact: true });
  const discardButton = () => page.getByRole("button", { name: "破棄", exact: true });
  const saveState = () => page.getByTestId("save-state");
  const summary = () => page.getByTestId("audience-summary");
  const overlay = (label = "保存中…") => page.getByRole("status").filter({ hasText: label });
  const chip = (name: string) => page.getByRole("complementary", { name: "条件の部品" }).getByRole("button", { name, exact: true });
  const navLink = (label: string) => page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: label, exact: true });
  const leaveConfirm = () => page.getByRole("alertdialog", { name: "保存していない変更があります" });
  const stay = async () => {
    await leaveConfirm().getByRole("button", { name: "とどまる", exact: true }).press("Enter");
    await expect(leaveConfirm()).toHaveCount(0);
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    // ログインは 1 回(fixtures.ts の login() の予算)
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("setup: a site without goals and three audiences", async () => {
    await createSite(page, SITE);
    siteUrl = page.url();
    for (const a of [AUD, AUD_MEMO, AUD_UPD, AUD_DISC]) expect((await api("POST", `/sites/${SITE.id}/audiences`, { ...a, definition: DEF_A })).status).toBe(201);
  });

  test("overlay locks the builder and a double click sends one PATCH", async () => {
    await open(AUD.id);
    await nameInput().fill("E2E save 1");
    const patches = countRequests(page, (r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control${apiPath(AUD.id)}`);
    const rsc = countRequests(page, (r) => isRsc(r, audPath(AUD.id)));
    const undo = await holdApi(page, "PATCH", apiPath(AUD.id), { delayMs: 1_000 });
    try {
      await saveButton().dblclick();
      await expect(overlay()).toBeVisible();
      // 覆いの間は名前の欄に入力できず、部品のチップも押せない(inert の中。disabled にはしない)
      expect(await nameInput().evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
      await nameInput().click({ force: true });
      await page.keyboard.type("zz");
      await expect(nameInput()).toHaveValue("E2E save 1");
      expect(await chip("OS").evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
      await chip("OS").click({ force: true });
      await expect(saveState()).toHaveText(SAVED);
      await expect(overlay()).toHaveCount(0);
      await expect(summary()).toHaveText("端末が モバイル"); // 覆いの間のクリックで条件は増えていない
      expect(patches.count()).toBe(1);
      expect(rsc.count()).toBe(1);
    } finally {
      patches.stop();
      rsc.stop();
      await undo();
    }
  });

  test("memo-only save keeps another user's condition", async () => {
    await open(AUD_MEMO.id);
    // 開いた後に、ほかの人が条件を変える
    expect((await api("PATCH", apiPath(AUD_MEMO.id), { definition: DEF_B })).status).toBe(200);
    await memoInput().fill("自分のメモ");
    const sent = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control${apiPath(AUD_MEMO.id)}`);
    await saveButton().click();
    expect((await sent).postDataJSON()).toEqual({ description: "自分のメモ" });
    await expect(saveState()).toHaveText(SAVED);
    const after = await api("GET", apiPath(AUD_MEMO.id));
    expect(after.json?.definition).toEqual(DEF_B);
    expect(after.json?.description).toBe("自分のメモ");
    // 画面の条件も新しい値(未保存の変更は無かったので注記は出ない)
    await expect(summary()).toHaveText("端末が デスクトップ");
    await expect(page.getByTestId("server-updated")).toHaveCount(0);
  });

  test("a server update while editing keeps the draft and shows the notice; discard goes to the latest value", async () => {
    await open(AUD_UPD.id);
    await nameInput().fill("E2E editing");
    await chip("目標・コンバージョン").click();
    await expect(page.getByTestId("no-goals")).toBeVisible();
    expect((await api("PATCH", apiPath(AUD_UPD.id), { definition: DEF_B })).status).toBe(200);
    // 画面の値を読み直す(目標が 0 件のときの「目標を読み直す」)
    const landed = page.waitForResponse((r) => isRsc(r.request(), audPath(AUD_UPD.id)));
    await page.getByTestId("no-goals").getByRole("button", { name: "目標を読み直す" }).click();
    await landed;
    await expect(page.getByTestId("server-updated")).toHaveText(SERVER_UPDATED);
    await expect(nameInput()).toHaveValue("E2E editing");
    await expect(summary()).toContainText("端末が モバイル");
    await expect(saveState()).toHaveText("未保存の変更あり");
    // 破棄は最新のサーバーの値へ
    await discardButton().click();
    await expect(nameInput()).toHaveValue(AUD_UPD.name);
    await expect(summary()).toHaveText("端末が デスクトップ");
    await expect(page.getByTestId("server-updated")).toHaveCount(0);
    await expect(saveState()).toHaveText("変更はありません");
  });

  // 最終レビュー I3: A を表示 → B を保存(成功)→ 読み直しが時間切れ(props は A のまま)→ C に編集 → 破棄 = B に戻る。次の PATCH も B が基準
  test("discard after a save whose refresh timed out goes back to the saved value", async () => {
    test.setTimeout(90_000);
    await open(AUD_DISC.id);
    const patchPath = `/api/control${apiPath(AUD_DISC.id)}`;
    // 保存の後の読み直し(この画面の本描画の RSC)を、終わりまで止める(読み直しの上限 10 秒を超えさせる。届くと props が B になり、確かめにならない)
    const parked: Route[] = [];
    const park = async (route: Route) => {
      if (!isRsc(route.request(), audPath(AUD_DISC.id))) return route.fallback();
      parked.push(route);
    };
    await page.route("**/*", park);
    try {
      await nameInput().fill("E2E disc B");
      const first = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === patchPath);
      await saveButton().click();
      expect((await first).postDataJSON()).toEqual({ name: "E2E disc B" });
      await expect(page.getByText(REFRESH_TIMEOUT)).toBeVisible({ timeout: 20_000 });
      await expect(overlay()).toHaveCount(0);
      expect(parked.length).toBeGreaterThan(0); // 読み直しは止めたまま(props は A のまま)
      await expect(saveState()).toHaveText("変更はありません");
      // C に編集してから破棄 → 保存した B に戻る(A ではない)
      await nameInput().fill("E2E disc C");
      await expect(saveState()).toHaveText("未保存の変更あり");
      await discardButton().click();
      await expect(nameInput()).toHaveValue("E2E disc B");
      await expect(saveState()).toHaveText("変更はありません");
      // 次の PATCH は B を基準に組む(メモだけ変えたら名前は送らない)
      await memoInput().fill("disc memo");
      const second = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === patchPath);
      await saveButton().click();
      expect((await second).postDataJSON()).toEqual({ description: "disc memo" });
      await expect(page.getByText(REFRESH_TIMEOUT)).toBeVisible({ timeout: 20_000 });
      await expect(overlay()).toHaveCount(0);
    } finally {
      await page.unroute("**/*", park);
      for (const r of parked) await r.continue().catch(() => {});
    }
    const after = await api("GET", apiPath(AUD_DISC.id));
    expect(after.json?.name).toBe("E2E disc B");
    expect(after.json?.description).toBe("disc memo");
  });

  test("unsaved audience edits stop a sidebar click and back", async () => {
    // 一覧 → 詳細(同じ文書の中に履歴を積む)
    await page.goto(`${sitePath()}/audiences`);
    await waitForHydration(page);
    await page.locator(`main a[href="${audPath(AUD.id)}"]`).first().dispatchEvent("click");
    await expect(page).toHaveURL((u) => u.pathname === audPath(AUD.id));
    await waitForHydration(page);
    await nameInput().fill("E2E leave");
    await navLink("目標").dispatchEvent("click");
    await expect(leaveConfirm()).toBeVisible();
    await stay();
    expect(new URL(page.url()).pathname).toBe(audPath(AUD.id));
    await page.evaluate(() => history.back());
    await expect(leaveConfirm()).toBeVisible();
    await stay();
    expect(new URL(page.url()).pathname).toBe(audPath(AUD.id));
    await expect(nameInput()).toHaveValue("E2E leave");
    await discardButton().click();
    // 新規作成の画面でも同じ
    await page.goto(`${sitePath()}/audiences/new`);
    await waitForHydration(page);
    await nameInput().fill("E2E leave new");
    await navLink("目標").dispatchEvent("click");
    await expect(leaveConfirm()).toBeVisible();
    await stay();
    expect(new URL(page.url()).pathname).toBe(`${sitePath()}/audiences/new`);
    await discardButton().click();
    await expect(nameInput()).toHaveValue("");
  });

  test("creating an audience twice by double click makes one and lands on the detail", async () => {
    await page.goto(`${sitePath()}/audiences/new`);
    await waitForHydration(page);
    await nameInput().fill("E2E created twice");
    await expect(page.getByLabel("ID", { exact: true })).toHaveValue("aud_e2e_created_twice");
    await chip("端末").click();
    const detail = audPath("aud_e2e_created_twice");
    // 自分の作成の後の移動で、離れる前の確認(native の beforeunload・画面の確認)が一度も出ないこと
    const dialogs: string[] = [];
    const onDialog = (d: Dialog) => {
      dialogs.push(d.type());
      void d.dismiss();
    };
    page.on("dialog", onDialog);
    // __reexposed: 覆いが一度出た後に、新規作成の画面の入力(ID の欄 = pattern 付き)が覆いの外でまた触れる状態に戻ったか。
    // audiences/ の loading.tsx が移動の始まりで画面を読み込み中の表示に替えるので、覆いが着くまで残るとは限らない。
    // 見るのは「着くまでに作成の画面が二度押しできる状態に戻らない」こと
    await page.evaluate(() => {
      const w = window as unknown as { __leaveSeen: boolean; __overlaySeen: boolean; __reexposed: boolean };
      w.__leaveSeen = false;
      w.__overlaySeen = false;
      w.__reexposed = false;
      new MutationObserver(() => {
        if (document.querySelector("dialog[open]")) w.__leaveSeen = true;
        const idInput = document.querySelector("main input[pattern]");
        if (document.querySelector("main [inert]")) w.__overlaySeen = true;
        else if (w.__overlaySeen && location.pathname.endsWith("/audiences/new") && idInput && !(idInput as HTMLInputElement).disabled) w.__reexposed = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "inert", "disabled"] });
    });
    const posts = countRequests(page, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control/sites/${SITE.id}/audiences`);
    const undoPost = await holdApi(page, "POST", `/sites/${SITE.id}/audiences`, { delayMs: 1_000 });
    const undoRsc = await holdRsc(page, detail, 1_500);
    try {
      const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/control/sites/${SITE.id}/audiences`);
      await saveButton().dblclick();
      await expect(overlay("作成中…")).toBeVisible();
      expect((await created).status()).toBe(201);
      await expect(page).toHaveURL((u) => u.pathname === detail, { timeout: 15_000 });
      await waitForHydration(page);
      // 詳細の画面は新規作成の画面の範囲を作り直している(範囲が残ると覆いが外れない = 作成の画面と範囲を共有していない)
      await expect(overlay("作成中…")).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __overlaySeen: boolean }).__overlaySeen)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { __reexposed: boolean }).__reexposed), "the create form never became usable again before landing").toBe(false);
      await expect(nameInput()).toHaveValue("E2E created twice");
      await expect(nameInput()).toBeEditable();
      await expect(saveState()).toHaveText("変更はありません");
      expect(posts.count()).toBe(1);
      expect(dialogs).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __leaveSeen: boolean }).__leaveSeen)).toBe(false);
    } finally {
      page.off("dialog", onDialog);
      posts.stop();
      await undoPost();
      await undoRsc();
    }
  });

  test("a failed save keeps the input", async () => {
    await open(AUD.id);
    await nameInput().fill("E2E save failed");
    const undo = await holdApi(page, "PATCH", apiPath(AUD.id), { fulfill: { status: 500, body: { error: "internal", message: "E2E の保存の失敗" } } });
    try {
      await saveButton().click();
      await expect(appAlert(page).filter({ hasText: "E2E の保存の失敗" })).toBeVisible();
      await expect(overlay()).toHaveCount(0);
      await expect(nameInput()).toHaveValue("E2E save failed");
      await expect(nameInput()).toBeEditable();
      await expect(saveState()).toHaveText("未保存の変更あり");
    } finally {
      await undo();
    }
    await discardButton().click();
  });
});
