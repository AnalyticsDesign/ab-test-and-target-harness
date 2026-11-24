import { test, expect, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { ADMIN_URL, acceptInvite, changeStatus, controlHeaders, createExperiment, createSite, issueInvite, login, markSessionsAsGoogle, openMembers, openWithLatePopstateGuard, openWorkspace, pick, waitForHydration } from "./fixtures";

/**
 * 書き込みの範囲と確認(B173 第 2 段)。
 * Task 2: 確認を開いた直後の 0.5 秒は、マウス・タッチのクリックを無視する(ダブルクリックの 2 回目が、1 回目で開いた確認の背面・ボタンに落ちても
 * 閉じたり確定したりしない)。キーボードの押下(Enter)は無視しない。時間で狙う確かめはしない(Playwright の待ちで 100 ms を超えうるため):
 * ダブルクリックで 2 回目が無視されること・Enter が効くこと・page.clock で 0.5 秒を過ぎた後のクリックが効くこと、を見る。
 * 確認を開いたまま書き込みを待つ形(askHold)の E2E は、最初の利用者(状態の変更)と一緒に足す(Task 7)
 * Task 5: 作成・複製・終了は、書き込みの応答までは覆い、その後は移動(または読み直しの反映)まで押し直せない(二重の作成を止める)。
 * 移動の後は 150 ms で本文が読み込み中の表示に替わるので、「覆いが着くまで見える」は確かめない(覆いが出た・押し直せない・要求が 1 回、を見る)
 */

const SITE = { id: "site_e2e_busy", name: "E2E Busy Scopes" };
const EXP_RUN = { id: "exp_e2e_busy_run", name: "E2E busy running" };
/** 終了の結果を route で作る(状態は実際には変わらない)実行中のテスト */
const EXP_STOP = { id: "exp_e2e_busy_stop", name: "E2E busy stop fake" };
/** 実際に終了する実行中のテスト */
const EXP_END = { id: "exp_e2e_busy_end", name: "E2E busy end" };
/** 下書き(複製の元・終了の後の複製の行き先) */
const EXP_DEST = { id: "exp_e2e_busy_dest", name: "E2E busy dest" };
const REFRESH_TIMEOUT_NOTE = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";

/** 送った要求を数える */
function countRequests(page: Page, match: (req: Request) => boolean): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (req: Request) => {
    if (match(req)) n += 1;
  };
  page.on("request", on);
  return { count: () => n, stop: () => page.off("request", on) };
}

/** 本描画の RSC(先読みでない GET) */
const isRsc = (req: Request, pathname: string) => {
  const url = new URL(req.url());
  return req.method() === "GET" && url.pathname === pathname && url.searchParams.has("_rsc") && !req.headers()["next-router-prefetch"];
};
/** 全画面の移動で読む HTML */
const isDocument = (req: Request, pathname: string) => req.resourceType() === "document" && new URL(req.url()).pathname === pathname;

/** method と BFF の path(`/api/control` を除いたもの)が一致する要求を ms だけ遅らせる(または fulfill で差し替える)。戻り値は解除 */
async function holdApi(page: Page, method: string, path: string | RegExp, how: { delayMs?: number; fulfill?: { status: number; body: unknown } }): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const hit = typeof path === "string" ? pathname === `/api/control${path}` : path.test(pathname);
    if (req.method() !== method || !hit) return route.fallback();
    if (how.delayMs) await new Promise((r) => setTimeout(r, how.delayMs));
    if (how.fulfill) return route.fulfill({ status: how.fulfill.status, contentType: "application/json", body: JSON.stringify(how.fulfill.body) });
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}

/** pathname の読み直し(RSC)を ms だけ遅らせる。戻り値は解除 */
async function holdRefresh(page: Page, pathname: string, ms: number): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    if (!isRsc(route.request(), pathname)) return route.fallback();
    await new Promise((r) => setTimeout(r, ms));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}

/** ネイティブのダイアログ(beforeunload など)を数える。来たら閉じる(閉じないとページが止まる) */
function countNativeDialogs(page: Page): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (d: import("@playwright/test").Dialog) => {
    n += 1;
    void d.dismiss().catch(() => {});
  };
  page.on("dialog", on);
  return { count: () => n, stop: () => page.off("dialog", on) };
}

test.describe.serial("busy scopes and confirms (B173 stage 2)", () => {
  let ctx: BrowserContext;
  let page: Page;
  let siteUrl: string;

  test.beforeAll(async ({ browser }) => {
    // 1 つのコンテキスト(ログインは 1 回。fixtures.ts の login() の予算)。Task 5 の test は同じコンテキストの新しいページを使う
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await login(page);
  });
  test.afterAll(async () => {
    await ctx.close();
  });

  test("setup: a site and a running test", async () => {
    await createSite(page, SITE);
    siteUrl = page.url();
    await createExperiment(page, EXP_RUN);
    expect((await changeStatus(page, SITE.id, EXP_RUN.id, /^開始/)).publish.ok).toBe(true);
  });

  test("double-clicking a save that asks for confirmation keeps the confirm open", async () => {
    await page.goto(`${siteUrl}/experiments/${EXP_RUN.id}`);
    await waitForHydration(page);
    await page.getByRole("region", { name: "配信条件" }).getByRole("textbox", { name: "値", exact: true }).first().fill("/busy-changed");
    const patches = countRequests(page, (r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control/sites/${SITE.id}/experiments/${EXP_RUN.id}`);
    try {
      await page.evaluate(() => {
        function recordBackdropClick(event: MouseEvent) {
          const dialog = event.target;
          if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
          const bounds = dialog.getBoundingClientRect();
          if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
              event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
          dialog.dataset.e2eBackdropClick = "true";
          document.removeEventListener("click", recordBackdropClick, true);
        }
        document.addEventListener("click", recordBackdropClick, true);
      });
      // 1 回目の後に確認を描画する時間を入れ、2 回目が実際に背面へ届いたことを確かめる。
      await page.getByRole("button", { name: "保存(下書き)" }).dblclick({ delay: 75 });
      const confirm = page.getByRole("alertdialog", { name: "実行中のテストを変更しますか?" });
      await expect(confirm).toHaveAttribute("data-e2e-backdrop-click", "true");
      await expect(confirm).toBeVisible();
      expect(patches.count()).toBe(0);
      await confirm.getByRole("button", { name: "保存する", exact: true }).press("Enter");
      await expect(page.getByTestId("save-state")).toHaveText("下書きに保存しました。訪問者への反映にはサイトの公開が必要です");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect(patches.count()).toBe(1);
    } finally {
      patches.stop();
    }
  });

  test("a pointer click on confirm right after open is ignored, keyboard is not", async () => {
    // 0.5 秒を過ぎた後のクリックを、待たずに確かめるため時計を差し替える(読み込みの前に入れる)
    await page.clock.install();
    await page.goto(siteUrl);
    await waitForHydration(page);
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "目標" }).click();
    const addGoal = async (id: string, name: string) => {
      await page.fill('input[name="id"]', id);
      await page.fill('input[name="name"]', name);
      await page.fill('input[name="value"]', `/${id}`);
      await page.getByRole("button", { name: "追加" }).click();
      await expect(page.getByRole("row").filter({ hasText: id })).toHaveCount(1);
      // 覆いが外れる(結果の文が出る)まで待ってから次を入力する(覆いの間の入力は届かない)
      await expect(page.getByTestId("goal-add").getByRole("status")).toHaveText("追加しました");
    };
    await addGoal("g_busy_a", "Busy A");
    await addGoal("g_busy_b", "Busy B");
    const deletes = countRequests(page, (r) => r.method() === "DELETE" && /\/api\/control\/sites\/[^/]+\/goals\//.test(new URL(r.url()).pathname));
    try {
      // ダブルクリック: 1 回目で確認が開き、2 回目のクリックはその上に落ちるが閉じも確定もしない
      const rowA = page.getByRole("row").filter({ hasText: "g_busy_a" });
      const dialogA = page.getByRole("alertdialog", { name: "目標「Busy A」を削除しますか?" });
      await rowA.getByRole("button", { name: "削除" }).dblclick();
      await expect(dialogA).toBeVisible();
      expect(deletes.count()).toBe(0);
      // キーボードの押下は無視しない
      await dialogA.getByRole("button", { name: "削除する" }).press("Enter");
      await expect(rowA).toHaveCount(0);
      expect(deletes.count()).toBe(1);

      // 開いてから 0.5 秒を過ぎた後のクリックは効く
      const rowB = page.getByRole("row").filter({ hasText: "g_busy_b" });
      const dialogB = page.getByRole("alertdialog", { name: "目標「Busy B」を削除しますか?" });
      await rowB.getByRole("button", { name: "削除" }).click();
      await expect(dialogB).toBeVisible();
      await page.clock.fastForward(600);
      await dialogB.getByRole("button", { name: "削除する" }).click();
      await expect(rowB).toHaveCount(0);
      expect(deletes.count()).toBe(2);
    } finally {
      deletes.stop();
    }
  });
  // ---- Task 5: 作成と全画面の移動 ----
  // 上の test は page.clock を入れたので、ここからは同じログインの新しいページを使う(時計を持ち越さない)
  let p: Page;
  const sitePath = () => new URL(siteUrl).pathname;
  const expPath = (id: string) => `${sitePath()}/experiments/${id}`;
  const overlayIn = (scope: Page | import("@playwright/test").Locator, label: string) => scope.getByRole("status").filter({ hasText: label });

  test("setup: experiments for create, duplicate and stop", async () => {
    p = await ctx.newPage();
    await p.goto(siteUrl);
    await waitForHydration(p);
    for (const e of [EXP_STOP, EXP_END]) {
      await p.goto(siteUrl);
      await waitForHydration(p);
      await createExperiment(p, e);
      expect((await changeStatus(p, SITE.id, e.id, /^開始/)).publish.ok).toBe(true);
    }
    await p.goto(siteUrl);
    await waitForHydration(p);
    await createExperiment(p, EXP_DEST);
  });

  /** エクスペリエンスの作成の画面を開いて入力する */
  async function fillCreate(id: string, name: string): Promise<void> {
    await p.goto(`${siteUrl}/experiments/new`);
    await waitForHydration(p);
    await p.fill('input[name="id"]', id);
    await p.fill('input[name="name"]', name);
    await p.fill('input[name="value"]', "/");
  }

  test("create double-click sends one POST and lands without a leave confirm", async () => {
    const ID = "exp_e2e_busy_dbl";
    const NAME = "E2E busy double create";
    await fillCreate(ID, NAME);
    const undo = await holdApi(p, "POST", `/sites/${SITE.id}/experiments`, { delayMs: 1_000 });
    const posts = countRequests(p, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control/sites/${SITE.id}/experiments`);
    const docs = countRequests(p, (r) => isDocument(r, expPath(ID)));
    const natives = countNativeDialogs(p);
    try {
      await p.locator('button[type="submit"]').dblclick();
      await expect(overlayIn(p, "作成中…")).toBeVisible();
      await p.waitForURL((u) => u.pathname === expPath(ID));
      await waitForHydration(p);
      expect(posts.count()).toBe(1);
      expect(docs.count()).toBe(1);
      expect(natives.count()).toBe(0);
    } finally {
      posts.stop();
      docs.stop();
      natives.stop();
      await undo();
    }
    await p.goto(siteUrl);
    await waitForHydration(p);
    await expect(p.locator('[data-testid^="experiment-row-"]').filter({ hasText: NAME })).toHaveCount(1);
  });

  test("duplicate dialog is covered until the response and cannot be pressed again", async () => {
    await p.goto(`${siteUrl}/experiments/${EXP_DEST.id}`);
    await waitForHydration(p);
    await p.getByRole("button", { name: "複製", exact: true }).click();
    const dialog = p.getByRole("alertdialog", { name: "複製して新しいエクスペリエンスを作ります" });
    await expect(dialog).toBeVisible();
    const dupPath = `/sites/${SITE.id}/experiments/${EXP_DEST.id}/duplicate`;
    const undo = await holdApi(p, "POST", dupPath, { delayMs: 1_000 });
    const posts = countRequests(p, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control${dupPath}`);
    try {
      const create = dialog.getByRole("button", { name: "下書きを作成" });
      await create.press("Enter");
      await expect(overlayIn(dialog, "作成中…")).toBeVisible();
      // 覆いの間に確定・戻るを押しても、要求は増えず、閉じない
      for (const name of ["下書きを作成", "戻る"]) {
        const box = await dialog.getByRole("button", { name, exact: true }).boundingBox();
        if (box) await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await create.press("Enter").catch(() => {});
      expect(posts.count()).toBe(1);
      // 応答の後は本文が読み込み中の表示になり、移った先に着く(時間で狙わず、着いたことを待つ)
      await p.waitForURL((u) => /\/experiments\/[^/]+$/.test(u.pathname) && u.pathname !== expPath(EXP_DEST.id));
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }
  });

  test("a failed create releases the overlay and keeps the input", async () => {
    await openWorkspace(p);
    await waitForHydration(p);
    const name = p.locator('input[name="name"]');
    if (!(await name.isVisible())) await p.getByRole("button", { name: "新しいサイト" }).click();
    await name.fill("E2E busy failed site");
    await p.fill('input[name="domain"]', "busy-fail.example.com");
    await p.fill('input[name="id"]', "site_e2e_busy_fail");
    const sitesPath = /^\/api\/control\/workspaces\/[^/]+\/sites$/;
    const undo = await holdApi(p, "POST", sitesPath, { delayMs: 500, fulfill: { status: 409, body: { error: "conflict", message: "E2E の作成の失敗です" } } });
    const posts = countRequests(p, (r) => r.method() === "POST" && sitesPath.test(new URL(r.url()).pathname));
    try {
      await p.locator('button[type="submit"]').click();
      await expect(overlayIn(p, "作成中…")).toBeVisible();
      await expect(p.getByRole("alert").filter({ hasText: "E2E の作成の失敗です" })).toBeVisible();
      await expect(overlayIn(p, "作成中…")).toHaveCount(0);
      await expect(name).toHaveValue("E2E busy failed site");
      await expect(p.locator('input[name="domain"]')).toHaveValue("busy-fail.example.com");
      await p.locator('button[type="submit"]').click();
      await expect.poll(() => posts.count()).toBe(2);
      // 2 回目の失敗が返るまで待つ(書き込みの途中で離れると、離れる前の確認が移動を止める)
      await expect(overlayIn(p, "作成中…")).toHaveCount(0);
    } finally {
      posts.stop();
      await undo();
    }
  });

  /** 実行中のテストの見出しの「終了して結果を記録」を開く */
  async function openStop(id: string) {
    await p.goto(`${siteUrl}/experiments/${id}`);
    await waitForHydration(p);
    await p.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
    const dialog = p.getByRole("alertdialog", { name: "終了して結果を記録します" });
    await expect(dialog.getByTestId("stop-options")).toBeVisible();
    return dialog;
  }

  test("stop picks navigate or refresh once from the stop result", async () => {
    const statusPath = `/sites/${SITE.id}/experiments/${EXP_STOP.id}/status`;
    const dupPath = `/sites/${SITE.id}/experiments/${EXP_STOP.id}/duplicate`;
    const ok = { ok: true, version: 7 };
    const failedPublish = { ok: false, version: null, error: "deploy_failed", message: "E2E の公開の失敗" };
    type Case = { name: string; publish: unknown; recorded?: boolean; warnings?: Array<{ message: string }>; dup: "none" | "ok" | "fail"; navigate: boolean; texts: string[]; link: boolean };
    const cases: Case[] = [
      { name: "no duplicate", publish: ok, dup: "none", navigate: false, texts: ["終了しました。公開 v7 を反映しました"], link: false },
      { name: "duplicate ok", publish: ok, dup: "ok", navigate: true, texts: [], link: false },
      { name: "duplicate failed", publish: ok, dup: "fail", navigate: false, texts: ["下書きの作成に失敗しました"], link: false },
      { name: "publish failed", publish: failedPublish, dup: "ok", navigate: false, texts: ["公開に失敗しました"], link: true },
      { name: "not recorded", publish: ok, recorded: false, dup: "ok", navigate: false, texts: ["結果を記録できませんでした"], link: true },
      { name: "warnings", publish: ok, warnings: [{ message: "E2E の終了の警告" }], dup: "ok", navigate: false, texts: ["E2E の終了の警告"], link: true },
    ];
    for (const c of cases) {
      await test.step(c.name, async () => {
        const dialog = await openStop(EXP_STOP.id);
        const statusBody = { experiment: { id: EXP_STOP.id }, publish: c.publish, ...(c.recorded !== undefined ? { results: { recorded: c.recorded } } : {}), ...(c.warnings ? { warnings: c.warnings } : {}) };
        const undos = [await holdApi(p, "POST", statusPath, { fulfill: { status: 200, body: statusBody } })];
        if (c.dup === "ok") undos.push(await holdApi(p, "POST", dupPath, { fulfill: { status: 201, body: { id: EXP_DEST.id } } }));
        if (c.dup === "fail") undos.push(await holdApi(p, "POST", dupPath, { fulfill: { status: 409, body: { error: "conflict", message: "E2E の複製の失敗" } } }));
        const statusPosts = countRequests(p, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control${statusPath}`);
        const rsc = countRequests(p, (r) => isRsc(r, expPath(EXP_STOP.id)));
        const docs = countRequests(p, (r) => isDocument(r, expPath(EXP_DEST.id)));
        try {
          if (c.dup !== "none") {
            await dialog.getByRole("radio", { name: /^B を採用/ }).check();
            await dialog.getByTestId("stop-duplicate").getByRole("checkbox").check();
          }
          await dialog.getByRole("button", { name: "終了して記録" }).press("Enter");
          if (c.navigate) {
            await p.waitForURL((u) => u.pathname === expPath(EXP_DEST.id));
            await waitForHydration(p);
            expect(docs.count()).toBe(1);
            expect(rsc.count()).toBe(0);
          } else {
            await expect(dialog).toBeHidden();
            for (const t of c.texts) await expect(p.getByTestId("stop-notice").filter({ hasText: t })).toBeVisible();
            await expect(p.getByTestId("stop-created-link")).toHaveCount(c.link ? 1 : 0);
            expect(docs.count()).toBe(0);
            expect(rsc.count()).toBe(1);
            expect(p.url()).toContain(expPath(EXP_STOP.id));
          }
          expect(statusPosts.count()).toBe(1);
        } finally {
          statusPosts.stop();
          rsc.stop();
          docs.stop();
          for (const u of undos) await u();
        }
      });
    }
  });

  test("stop without duplicate keeps the dialog until the refresh shows the ended state", async () => {
    const dialog = await openStop(EXP_END.id);
    await expect(dialog.getByRole("radio", { name: /^採用なし/ })).toBeChecked();
    const undo = await holdRefresh(p, expPath(EXP_END.id), 1_000);
    const rsc = countRequests(p, (r) => isRsc(r, expPath(EXP_END.id)));
    try {
      const stopped = p.waitForResponse((r) => r.url().includes(`/experiments/${EXP_END.id}/status`) && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "終了して記録" }).press("Enter");
      expect((await stopped).status()).toBe(200);
      // 読み直しの反映までは開いたまま「記録中…」
      await expect(overlayIn(dialog, "記録中…")).toBeVisible();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      await expect(dialog).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "archived");
      await expect(p.getByTestId("stop-notice").first()).toBeVisible();
      expect(rsc.count()).toBe(1);
    } finally {
      rsc.stop();
      await undo();
    }
  });

  // ---- Task 6: カードと一覧のカード ----
  // 成功の文・失敗の文は範囲の中の 1 行。目標の追加はボタンの横、目標の保存・削除と一覧の操作は一覧のカードの先頭(card-notice)
  const GOAL = { id: "g_busy_card", name: "Busy card" };
  const goalsPath = `/sites/${SITE.id}/goals`;
  const goalList = () => p.getByTestId("goals-list");
  const goalAdd = () => p.getByTestId("goal-add");
  /** カードの先頭(直下の最初の子)の 1 行 */
  const cardTop = (card: import("@playwright/test").Locator) => card.locator(':scope > [data-testid="card-notice"]');
  /** 範囲の中身(inert が付く要素)のうち、その要素を含むもの */
  const inertAround = (el: import("@playwright/test").Locator) => p.locator("[inert]").filter({ has: el });

  async function openGoals() {
    await p.goto(`${siteUrl}/goals`);
    await waitForHydration(p);
  }
  /** 目標の行の編集のパネルを開いて名前を変える */
  async function renameGoal(name: string) {
    await goalList().getByRole("row").filter({ hasText: GOAL.id }).getByRole("button", { name: /^編集/ }).click();
    const input = goalList().getByLabel(/^名前/);
    await input.fill(name);
  }

  test("goal add double-click sends one POST and shows 追加しました", async () => {
    await openGoals();
    await goalAdd().locator('input[name="id"]').fill(GOAL.id);
    await goalAdd().locator('input[name="name"]').fill(GOAL.name);
    await goalAdd().locator('input[name="value"]').fill(`/${GOAL.id}`);
    const undo = await holdApi(p, "POST", goalsPath, { delayMs: 1_000 });
    const posts = countRequests(p, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control${goalsPath}`);
    try {
      await goalAdd().getByRole("button", { name: "追加", exact: true }).dblclick();
      await expect(overlayIn(p, "追加中…")).toBeVisible();
      // ボタンの横(追加のフォームのカードの中)に出て、一覧のカードには出ない
      await expect(goalAdd().getByTestId("goal-add-actions").getByRole("status")).toHaveText("追加しました");
      await expect(goalList().getByRole("status")).toHaveCount(0);
      await expect(goalList().getByRole("row").filter({ hasText: GOAL.id })).toHaveCount(1);
      expect(posts.count()).toBe(1);
      // 入力は空に戻る
      await expect(goalAdd().locator('input[name="id"]')).toHaveValue("");
    } finally {
      posts.stop();
      await undo();
    }
  });

  test("goal save shows 保存しました at the top of the list card", async () => {
    await openGoals();
    await renameGoal("Busy card renamed");
    await goalList().getByRole("button", { name: "保存", exact: true }).click();
    await expect(cardTop(goalList()).getByRole("status")).toHaveText("保存しました");
    await expect(goalAdd().getByRole("status")).toHaveCount(0);
    await expect(goalList().getByRole("row").filter({ hasText: GOAL.id })).toContainText("Busy card renamed");
    // 編集のパネルは閉じる
    await expect(goalList().getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  });

  test("a goal save whose refresh is held past the limit keeps the write and says the view may be old", async () => {
    await openGoals();
    await renameGoal("Busy card slow");
    const undo = await holdRefresh(p, `${sitePath()}/goals`, 12_000);
    const patches = countRequests(p, (r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control${goalsPath}/${GOAL.id}`);
    try {
      await goalList().getByRole("button", { name: "保存", exact: true }).click();
      await expect(overlayIn(p, "保存中…")).toBeVisible();
      await expect(cardTop(goalList()).getByRole("status")).toHaveText(REFRESH_TIMEOUT_NOTE, { timeout: 15_000 });
      await expect(overlayIn(p, "保存中…")).toHaveCount(0);
      await expect(goalList().getByRole("alert")).toHaveCount(0);
      expect(patches.count()).toBe(1);
    } finally {
      patches.stop();
      await undo();
    }
    // 送り直さない(止めた読み直しが届いた後も PATCH は 1 回のまま)
    await openGoals();
    await expect(goalList().getByRole("row").filter({ hasText: GOAL.id })).toContainText("Busy card slow");
    expect(patches.count()).toBe(1);
  });

  test("goal delete covers the list card and shows 削除しました", async () => {
    await openGoals();
    const row = goalList().getByRole("row").filter({ hasText: GOAL.id });
    await row.getByRole("button", { name: "削除", exact: true }).click();
    const dialog = p.getByRole("alertdialog", { name: "目標「Busy card slow」を削除しますか?" });
    await expect(dialog).toBeVisible();
    const undo = await holdApi(p, "DELETE", `${goalsPath}/${GOAL.id}`, { delayMs: 1_000 });
    try {
      await dialog.getByRole("button", { name: "削除する" }).press("Enter");
      await expect(overlayIn(p, "削除中…")).toBeVisible();
      // 覆うのは一覧のカードだけ。追加のフォームは別の範囲なので押せるまま
      await expect(inertAround(goalList())).toHaveCount(1);
      await expect(inertAround(goalAdd())).toHaveCount(0);
      await expect(cardTop(goalList()).getByRole("status")).toHaveText("削除しました");
      await expect(row).toHaveCount(0);
      await expect(goalAdd().getByRole("status")).toHaveCount(0);
    } finally {
      await undo();
    }
  });

  test("member role change shows ロールを変更しました on the list card", async ({ browser }) => {
    const EMAIL = "busy-member@e2e.example";
    await openMembers(p);
    await waitForHydration(p);
    const url = await issueInvite(p, EMAIL, /^編集者/);
    const invited = await acceptInvite(browser, url, "Busy Member");
    await invited.ctx.close();
    await openMembers(p);
    await waitForHydration(p);
    const list = p.getByTestId("members-list");
    const patches = countRequests(p, (r) => r.method() === "PATCH" && /\/api\/control\/workspaces\/[^/]+\/members\//.test(new URL(r.url()).pathname));
    try {
      await pick(p, "Busy Member のロール", /^閲覧者/);
      await p.getByRole("alertdialog", { name: "Busy Member のロールを変更しますか?" }).getByRole("button", { name: "変更する" }).press("Enter");
      await expect(cardTop(list).getByRole("status")).toHaveText("ロールを変更しました");
      await expect(list.getByRole("row").filter({ hasText: EMAIL }).getByRole("combobox")).toContainText("閲覧者");
      await expect(list.getByRole("row").getByRole("status")).toHaveCount(0);
      // 招待のカード(発行のフォーム・招待中の一覧)には出ない
      await expect(p.locator(".invite-section")).toBeVisible();
      await expect(p.locator(".invite-section").getByRole("status")).toHaveCount(0);
      await expect(p.getByTestId("invitations").getByRole("status")).toHaveCount(0);
      expect(patches.count()).toBe(1);
    } finally {
      patches.stop();
    }
  });

  test("revoking a key shows 失効させました and a failure keeps the row", async () => {
    // パスワードのログインのセッションでは鍵を発行できない(B112)ので、印を Google に書き換えてから API で 1 本作る
    markSessionsAsGoogle();
    const created = await p.request.post(`${ADMIN_URL}/api/control/me/api-keys`, { headers: controlHeaders(), data: { name: "e2e-busy-revoke", workspaceId: null, roleCap: "viewer" } });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    await p.goto(`${ADMIN_URL}/w/me/api-keys`);
    await waitForHydration(p);
    const list = p.getByTestId("api-keys-list");
    const row = list.getByRole("row").filter({ hasText: "e2e-busy-revoke" });
    const dialog = p.getByRole("alertdialog", { name: "キー「e2e-busy-revoke」を失効しますか?" });
    // 失敗: カードの先頭に ErrorBox、行は残る
    const undo = await holdApi(p, "DELETE", `/me/api-keys/${id}`, { fulfill: { status: 500, body: { error: "internal", message: "E2E の失効の失敗" } } });
    try {
      await row.getByRole("button", { name: "失効", exact: true }).click();
      await dialog.getByRole("button", { name: "失効する" }).press("Enter");
      await expect(cardTop(list).getByRole("alert")).toContainText("E2E の失効の失敗");
      await expect(row).toHaveCount(1);
    } finally {
      await undo();
    }
    // 成功: カードの先頭に成功の文(失敗の文は消える)、行は失効済みへ移る
    await row.getByRole("button", { name: "失効", exact: true }).click();
    await dialog.getByRole("button", { name: "失効する" }).press("Enter");
    await expect(cardTop(list).getByRole("status")).toHaveText("失効させました");
    await expect(cardTop(list).getByRole("alert")).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(p.getByTestId("revoked-api-keys").getByRole("row").filter({ hasText: "e2e-busy-revoke" })).toHaveCount(1);
  });

  test("going back during the create POST stays on the page it went to (lateInstall)", async () => {
    const q = await ctx.newPage();
    try {
      await openWithLatePopstateGuard(q, siteUrl);
      // 同じ文書の中で作成の画面へ移る(戻る先の履歴を積む)
      await q.getByRole("link", { name: "新しいエクスペリエンス" }).dispatchEvent("click");
      await expect(q.getByRole("heading", { level: 1, name: "新しいエクスペリエンス" })).toBeVisible();
      await waitForHydration(q);
      const ID = "exp_e2e_busy_late";
      await q.fill('input[name="id"]', ID);
      await q.fill('input[name="name"]', "E2E busy late");
      await q.fill('input[name="value"]', "/");
      const undo = await holdApi(q, "POST", `/sites/${SITE.id}/experiments`, { delayMs: 2_000 });
      const natives = countNativeDialogs(q);
      const docs = countRequests(q, (r) => isDocument(r, expPath(ID)));
      try {
        const created = q.waitForResponse((r) => r.url().endsWith(`/api/control/sites/${SITE.id}/experiments`) && r.request().method() === "POST");
        await q.locator('button[type="submit"]').click();
        await expect(overlayIn(q, "作成中…")).toBeVisible();
        await q.evaluate(() => history.back());
        await expect(q.getByRole("heading", { level: 1, name: "エクスペリエンス", exact: true })).toBeVisible();
        expect((await created).ok()).toBe(true);
        // 遅れた応答の後も移らない(移るなら応答の直後に HTML を読みに行く)
        await q.waitForTimeout(1_500);
        expect(new URL(q.url()).pathname).toBe(sitePath());
        expect(docs.count()).toBe(0);
        await expect(q.getByRole("alertdialog")).toHaveCount(0);
        expect(natives.count()).toBe(0);
      } finally {
        natives.stop();
        docs.stop();
        await undo();
      }
    } finally {
      await q.close();
    }
  });

  // ---- Task 7: 状態の変更・公開・配信ファイルの作り直し ----
  // 状態の変更の最後の確認は askHold(確定の後も開いたまま、中に「開始中…」など)。最後の確認の無い開始・再開はボタンの並びを覆う。
  // 状態の変更の確認は、ほかのエクスペリエンスに未公開の変更があると必ず出る(B66 b)。確認の無い経路は publish-preview を空の応答に差し替えて作る
  const SITE7 = { id: "site_e2e_busy_status", name: "E2E Busy Status" };
  const site7Path = () => new URL(site7Url).pathname;
  const exp7Path = (id: string) => `${site7Path()}/experiments/${id}`;
  let site7Url: string;
  const statusApi = (id: string) => `/sites/${SITE7.id}/experiments/${id}/status`;
  const previewApi = `/sites/${SITE7.id}/publish-preview`;
  const EMPTY_PREVIEW = { digest: "a".repeat(64), transitionDigest: "a".repeat(64), experiments: [], audienceChanges: [], siteLevelChanged: false, overlaps: [], droppedPageConditions: [], viewportExperiments: [], compileError: null, lastActivatedAt: null };
  // 一覧だけ空にする。実際の状態の API を呼ぶため digest は同じ仮の入力から取得する。
  const emptyPreviewFor = async (id: string) => {
    const res = await p.request.get(`${ADMIN_URL}/api/control${previewApi}?transition=${id}:running`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    return { ...EMPTY_PREVIEW, digest: body.digest, transitionDigest: body.transitionDigest };
  };
  const WRITE_UNKNOWN_NOTE = "保存できたか分かりません。再読み込みして確かめてください";
  const statusRow = () => p.getByTestId("status-buttons");
  /** ボタンの並びの範囲の覆い(覆いは中身(inert)の外の兄弟なので、並びが inert になっていることと合わせて見る) */
  const rowOverlay = (label: string) => p.locator("div").filter({ has: p.locator("[inert]").filter({ has: statusRow() }) }).getByRole("status").filter({ hasText: label }).first();
  const startDialog = () => p.getByRole("alertdialog", { name: "開始しますか?" });
  const countStatusPosts = (page: Page, id: string) => countRequests(page, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control${statusApi(id)}`);

  /** BFF でエクスペリエンスを作る(状態を進めるときは status も送る) */
  async function seedExperiment(id: string, kind: "test" | "single", statuses: Array<"running" | "paused"> = []) {
    const created = await p.request.post(`${ADMIN_URL}/api/control/sites/${SITE7.id}/experiments`, { headers: controlHeaders(), data: { id, name: id, kind, urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    expect(created.status(), `create ${id}`).toBe(201);
    for (const status of statuses) {
      const r = await p.request.post(`${ADMIN_URL}/api/control${statusApi(id)}`, { headers: controlHeaders(), data: { status } });
      expect(r.status(), `${id} → ${status}`).toBe(200);
    }
  }
  async function openExp7(id: string) {
    await p.goto(`${site7Url}/experiments/${id}`);
    await waitForHydration(p);
  }
  /** 1 回目(から n 回目まで)だけ差し替える。それより後は素通し。戻り値は解除と数 */
  async function holdFirst(page: Page, method: string, path: string, n: number, how: (route: Route) => Promise<void>): Promise<{ undo: () => Promise<void>; hits: () => number }> {
    let hits = 0;
    const handler = async (route: Route) => {
      const req = route.request();
      if (req.method() !== method || new URL(req.url()).pathname !== `/api/control${path}`) return route.fallback();
      hits += 1;
      if (hits > n) return route.continue().catch(() => {});
      return how(route);
    };
    await page.route("**/*", handler);
    return { undo: () => page.unroute("**/*", handler), hits: () => hits };
  }

  test("setup: a site for status changes", async () => {
    p = await ctx.newPage();
    await createSite(p, SITE7);
    site7Url = p.url();
    await seedExperiment("exp_busy7_start", "test");
    await seedExperiment("exp_busy7_esc", "test");
    await seedExperiment("exp_busy7_fail", "test");
    await seedExperiment("exp_busy7_fail_cancel", "test");
    await seedExperiment("exp_busy7_unknown", "test");
    await seedExperiment("exp_busy7_unknown_cancel", "test");
    await seedExperiment("exp_busy7_resume", "test", ["running", "paused"]);
    await seedExperiment("exp_busy7_pause", "test", ["running"]);
    await seedExperiment("exp_busy7_pers", "single");
    await seedExperiment("exp_busy7_slow", "test");
    await seedExperiment("exp_busy7_late", "test");
  });

  test("start keeps the confirm open with 開始中… until the page shows running", async () => {
    const ID = "exp_busy7_start";
    await openExp7(ID);
    const undo = await holdApi(p, "POST", statusApi(ID), { delayMs: 1_000 });
    const posts = countStatusPosts(p, ID);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).dblclick();
      await expect(startDialog()).toBeVisible();
      await expect(p.getByRole("alertdialog")).toHaveCount(1);
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(overlayIn(startDialog(), "開始中…")).toBeVisible();
      await p.keyboard.press("Escape");
      await expect(startDialog()).toBeVisible();
      await expect(startDialog()).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      await expect(statusRow().getByRole("status").filter({ hasText: "を反映しました" })).toBeVisible();
      await expect(statusRow().getByRole("alert")).toHaveCount(0);
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }
  });

  test("two Escapes while 開始中… do not close the confirm", async () => {
    const ID = "exp_busy7_esc";
    await openExp7(ID);
    const undo = await holdApi(p, "POST", statusApi(ID), { delayMs: 2_000 });
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(overlayIn(startDialog(), "開始中…")).toBeVisible();
      await p.keyboard.press("Escape");
      await p.keyboard.press("Escape");
      // 2 回目の Esc はブラウザが閉じうる(閉じたら開き直す)。開いたまま・覆いのまま
      await expect(startDialog()).toBeVisible();
      await expect(overlayIn(startDialog(), "開始中…")).toBeVisible();
      await expect(startDialog()).toBeHidden({ timeout: 10_000 });
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    } finally {
      await undo();
    }
  });

  test("a failed start shows the error inside the confirm and can be retried", async () => {
    const ID = "exp_busy7_fail";
    await openExp7(ID);
    const conflict = (route: Route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "invalid_transition", message: "E2E の開始の失敗" }) });
    const first = await holdFirst(p, "POST", statusApi(ID), 1, conflict);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog().getByRole("alert")).toContainText("E2E の開始の失敗");
      await expect(startDialog()).toBeVisible();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
      // もう一度の確定で送り直し、成功で閉じる
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog()).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      expect(first.hits()).toBe(2);
    } finally {
      await first.undo();
    }

    // 別の回: 失敗の後に取り消すと閉じ、状態は変わらない
    const CANCEL = "exp_busy7_fail_cancel";
    await openExp7(CANCEL);
    const always = await holdFirst(p, "POST", statusApi(CANCEL), 99, conflict);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog().getByRole("alert")).toContainText("E2E の開始の失敗");
      await startDialog().getByRole("button", { name: "キャンセル", exact: true }).press("Enter"); // 覆いが外れた直後 0.5 秒のマウスのクリックは無視される
      await expect(startDialog()).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
      expect(always.hits()).toBe(1);
      // ボタンはまた押せる
      await expect(statusRow().getByRole("button", { name: /^開始/ })).toBeEnabled();
    } finally {
      await always.undo();
    }
  });

  test("an unknown start can be retried or cancelled inside the confirm", async () => {
    test.setTimeout(150_000);
    // 30 秒の上限を超えて止める(上限で fetch が中止されるので、止めた要求は control に届かない)
    const stall = async (route: Route) => {
      await new Promise((r) => setTimeout(r, 35_000));
      await route.abort().catch(() => {});
    };
    const ID = "exp_busy7_unknown";
    await openExp7(ID);
    const first = await holdFirst(p, "POST", statusApi(ID), 1, stall);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog().getByRole("alert")).toContainText(WRITE_UNKNOWN_NOTE, { timeout: 40_000 });
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog()).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      expect(first.hits()).toBe(2);
    } finally {
      await first.undo();
    }

    const CANCEL = "exp_busy7_unknown_cancel";
    await openExp7(CANCEL);
    const second = await holdFirst(p, "POST", statusApi(CANCEL), 1, stall);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(startDialog().getByRole("alert")).toContainText(WRITE_UNKNOWN_NOTE, { timeout: 40_000 });
      await startDialog().getByRole("button", { name: "キャンセル", exact: true }).press("Enter"); // 覆いが外れた直後 0.5 秒のマウスのクリックは無視される
      await expect(startDialog()).toBeHidden();
      // 自動で送り直さない
      await p.waitForTimeout(1_500);
      expect(second.hits()).toBe(1);
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
    } finally {
      await second.undo();
    }
  });

  test("a resume without a caution covers the buttons and a double click sends one POST", async () => {
    const ID = "exp_busy7_resume";
    await openExp7(ID);
    const undos = [await holdApi(p, "GET", previewApi, { fulfill: { status: 200, body: await emptyPreviewFor(ID) } }), await holdApi(p, "POST", statusApi(ID), { delayMs: 1_000 })];
    const posts = countStatusPosts(p, ID);
    try {
      await statusRow().getByRole("button", { name: "再開", exact: true }).dblclick();
      await expect(rowOverlay("再開中…")).toBeVisible();
      await expect(p.getByRole("alertdialog")).toHaveCount(0);
      await expect(statusRow().getByRole("status").filter({ hasText: "を反映しました" })).toBeVisible();
      await expect(rowOverlay("再開中…")).toHaveCount(0);
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      for (const u of undos) await u();
    }
  });

  test("pause and personalization start and end use the table", async () => {
    // 一時停止: 確認の中に「一時停止中…」
    const PAUSE = "exp_busy7_pause";
    await openExp7(PAUSE);
    let undo = await holdApi(p, "POST", statusApi(PAUSE), { delayMs: 1_000 });
    let posts = countStatusPosts(p, PAUSE);
    try {
      await statusRow().getByRole("button", { name: "一時停止", exact: true }).click();
      const dialog = p.getByRole("alertdialog", { name: "一時停止しますか?" });
      await dialog.getByRole("button", { name: "一時停止する", exact: true }).press("Enter");
      await expect(overlayIn(dialog, "一時停止中…")).toBeVisible();
      await expect(p.getByRole("alertdialog")).toHaveCount(1);
      await expect(dialog).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "paused");
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }

    // パーソナライズの開始(確認の無い経路): ボタンの並びに「開始中…」
    const PERS = "exp_busy7_pers";
    await openExp7(PERS);
    const preview = await holdApi(p, "GET", previewApi, { fulfill: { status: 200, body: await emptyPreviewFor(PERS) } });
    undo = await holdApi(p, "POST", statusApi(PERS), { delayMs: 1_000 });
    posts = countStatusPosts(p, PERS);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await expect(rowOverlay("開始中…")).toBeVisible();
      await expect(p.getByRole("alertdialog")).toHaveCount(0);
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      await expect(rowOverlay("開始中…")).toHaveCount(0);
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await preview();
      await undo();
    }

    // パーソナライズの終了: 確認の中に「変更中…」
    undo = await holdApi(p, "POST", statusApi(PERS), { delayMs: 1_000 });
    posts = countStatusPosts(p, PERS);
    try {
      await statusRow().getByRole("button", { name: /^終了/ }).click();
      const dialog = p.getByRole("alertdialog", { name: "エクスペリエンスを終了しますか?" });
      await dialog.getByRole("button", { name: "終了する", exact: true }).press("Enter");
      await expect(overlayIn(dialog, "変更中…")).toBeVisible();
      await expect(p.getByRole("alertdialog")).toHaveCount(1);
      await expect(dialog).toBeHidden();
      await expect(p.getByTestId("status-banner")).toHaveAttribute("data-status", "archived");
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }
  });

  test("a status change whose refresh is held past the limit keeps the change and says the view may be old", async () => {
    const ID = "exp_busy7_slow";
    await openExp7(ID);
    const undo = await holdRefresh(p, exp7Path(ID), 12_000);
    const posts = countStatusPosts(p, ID);
    try {
      await statusRow().getByRole("button", { name: /^開始/ }).click();
      await startDialog().getByRole("button", { name: "開始する", exact: true }).press("Enter");
      await expect(overlayIn(startDialog(), "開始中…")).toBeVisible();
      await expect(startDialog()).toBeHidden({ timeout: 15_000 });
      await expect(statusRow().getByRole("status").filter({ hasText: REFRESH_TIMEOUT_NOTE })).toBeVisible();
      await expect(statusRow().getByRole("alert")).toHaveCount(0);
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }
  });

  test("going back during the start's GET does not open the confirm on the next page (lateInstall)", async () => {
    const ID = "exp_busy7_late";
    const q = await ctx.newPage();
    try {
      await openWithLatePopstateGuard(q, site7Url);
      // 同じ文書の中でエクスペリエンスの画面へ移る(戻る先の履歴を積む)
      await q.locator(`[data-testid="experiment-row-${ID}"]`).getByRole("link").first().dispatchEvent("click");
      await q.waitForURL((u) => u.pathname === exp7Path(ID));
      await waitForHydration(q);
      const undo = await holdApi(q, "GET", previewApi, { delayMs: 2_000 });
      const posts = countStatusPosts(q, ID);
      try {
        const previewed = q.waitForResponse((r) => new URL(r.url()).pathname === `/api/control${previewApi}`);
        await q.getByTestId("status-buttons").getByRole("button", { name: /^開始/ }).click();
        await q.evaluate(() => history.back());
        await expect(q.getByRole("heading", { level: 1, name: "エクスペリエンス", exact: true })).toBeVisible();
        await previewed;
        await q.waitForTimeout(1_500);
        expect(new URL(q.url()).pathname).toBe(site7Path());
        await expect(q.getByRole("alertdialog")).toHaveCount(0);
        expect(posts.count()).toBe(0);
      } finally {
        posts.stop();
        await undo();
      }
    } finally {
      await q.close();
    }
  });

  test("publish double-click advances one version", async () => {
    await p.goto(`${site7Url}/publish`);
    await waitForHydration(p);
    const publishApi = `/sites/${SITE7.id}/publish`;
    const undo = await holdApi(p, "POST", publishApi, { delayMs: 1_000 });
    const posts = countRequests(p, (r) => r.method() === "POST" && new URL(r.url()).pathname === `/api/control${publishApi}`);
    try {
      const aside = p.locator("aside");
      await aside.getByRole("button", { name: /^公開する/ }).dblclick();
      await expect(overlayIn(aside, "公開中…")).toBeVisible();
      await expect(p.getByTestId("publish-result")).toHaveRole("status");
      await expect(p.getByTestId("publish-result")).toContainText("を配信に載せました");
      await expect(overlayIn(aside, "公開中…")).toHaveCount(0);
      expect(posts.count()).toBe(1);
    } finally {
      posts.stop();
      await undo();
    }
  });

  const STATIC_STATUS = "/api/control/static/status";
  const STATIC_REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
  const REBUILD_OK = { requested: 1, removed: 0, skippedRemoving: 0, failed: [], next: null };

  test("static rebuild covers the card and reloads without a refresh", async () => {
    await p.goto(`${ADMIN_URL}/w/me/static-delivery`);
    await waitForHydration(p);
    const undo = await holdApi(p, "POST", "/static/rebuild", { delayMs: 1_000, fulfill: { status: 200, body: REBUILD_OK } });
    const rsc = countRequests(p, (r) => new URL(r.url()).searchParams.has("_rsc") && !r.headers()["next-router-prefetch"]);
    const statusGets = countRequests(p, (r) => r.method() === "GET" && new URL(r.url()).pathname === STATIC_STATUS);
    try {
      const card = p.getByTestId("static-rebuild");
      await card.getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true }).click();
      const dialog = p.getByRole("alertdialog", { name: "公開中の全サイトの配信ファイルを作り直しますか" });
      await dialog.getByRole("button", { name: "作り直す", exact: true }).press("Enter");
      await expect(dialog).toBeHidden();
      // 覆いはボタンのあるカードの範囲(ダイアログの中ではない)
      await expect(inertAround(card)).toHaveCount(1);
      await expect(p.getByRole("status").filter({ hasText: "作り直し中…" })).toBeVisible();
      await expect(p.getByTestId("static-rebuild-result")).toBeVisible();
      await expect(p.getByRole("status").filter({ hasText: "作り直し中…" })).toHaveCount(0);
      await p.waitForTimeout(1_000);
      expect(rsc.count()).toBe(0);
      // パネルの取り直し 1 + 帯の取り直し 1(10 秒後の取り直しは待たない)
      expect(statusGets.count()).toBe(2);
    } finally {
      rsc.stop();
      statusGets.stop();
      await undo();
    }
  });

  test("static rebuild: the POST succeeds but the reload never settles", async () => {
    test.setTimeout(90_000);
    await p.goto(`${ADMIN_URL}/w/me/static-delivery`);
    await waitForHydration(p);
    const undo = await holdApi(p, "POST", "/static/rebuild", { fulfill: { status: 200, body: REBUILD_OK } });
    // 作り直しの後の状態の GET を解決させない(終わりに素通しで放す)
    const parked: Route[] = [];
    const park = async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET" || new URL(req.url()).pathname !== STATIC_STATUS) return route.fallback();
      parked.push(route);
    };
    await p.route("**/*", park);
    try {
      const card = p.getByTestId("static-rebuild");
      await card.getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true }).click();
      const dialog = p.getByRole("alertdialog", { name: "公開中の全サイトの配信ファイルを作り直しますか" });
      await dialog.getByRole("button", { name: "作り直す", exact: true }).press("Enter");
      await expect(p.getByRole("status").filter({ hasText: "作り直し中…" })).toBeVisible();
      await expect(p.getByTestId("static-rebuild-result")).toBeVisible();
      await expect(p.getByRole("status").filter({ hasText: "作り直し中…" })).toHaveCount(0, { timeout: 15_000 });
      await expect(p.getByTestId("static-rebuild-result")).toBeVisible();
      // 結果のカードの下に、表示が古い可能性の案内(書き込みの失敗としては出さない)
      await expect(p.getByRole("status").filter({ hasText: STATIC_REFRESH_TIMEOUT })).toBeVisible();
      await expect(card.getByRole("alert")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true })).toBeEnabled();
    } finally {
      await p.unroute("**/*", park);
      for (const r of parked) await r.continue().catch(() => {});
      await undo();
    }
  });

  // 最終レビュー I2: 作り直しは受け付けたが、状態の取り直しが 503 → 結果のカードを保ち、表示が古い可能性の案内を出す(失敗の文は出さない)
  test("static rebuild: the POST succeeds but the status GET fails", async () => {
    // 開いたときの帯の取得が済んでから、状態の GET を 503 にする(開いた直後の帯の取得は対象にしない)
    const firstStatus = p.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === STATIC_STATUS);
    await p.goto(`${ADMIN_URL}/w/me/static-delivery`);
    await waitForHydration(p);
    await firstStatus;
    const undo = await holdApi(p, "POST", "/static/rebuild", { fulfill: { status: 200, body: REBUILD_OK } });
    const failStatus = async (route: Route) => {
      const req = route.request();
      if (req.method() !== "GET" || new URL(req.url()).pathname !== STATIC_STATUS) return route.fallback();
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "E2E の状態の取得の失敗" }) });
    };
    await p.route("**/*", failStatus);
    const statusGets = countRequests(p, (r) => r.method() === "GET" && new URL(r.url()).pathname === STATIC_STATUS);
    try {
      const card = p.getByTestId("static-rebuild");
      await card.getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true }).click();
      const dialog = p.getByRole("alertdialog", { name: "公開中の全サイトの配信ファイルを作り直しますか" });
      await dialog.getByRole("button", { name: "作り直す", exact: true }).press("Enter");
      await expect(p.getByTestId("static-rebuild-result")).toBeVisible();
      await expect(p.getByRole("status").filter({ hasText: STATIC_REFRESH_TIMEOUT })).toBeVisible();
      await expect(p.getByRole("status").filter({ hasText: "作り直し中…" })).toHaveCount(0);
      await expect(p.getByTestId("static-rebuild-result")).toBeVisible();
      await expect(card.getByRole("alert")).toHaveCount(0);
      await expect(p.getByText("E2E の状態の取得の失敗")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true })).toBeEnabled();
      // パネルの取り直し 1 + 帯の取り直し 1(取り直しの失敗で、取り直しを重ねない。10 秒後の取り直しは待たない)
      await p.waitForTimeout(1_000);
      expect(statusGets.count()).toBe(2);
    } finally {
      statusGets.stop();
      await p.unroute("**/*", failStatus);
      await undo();
    }
  });
});
