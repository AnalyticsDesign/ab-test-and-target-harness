import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import { appAlert, changeStatus, controlHeaders, createExperiment, createSite, login, waitForHydration } from "./fixtures";

/**
 * エクスペリエンスの保存(B173 第 1 段 Task 7)。
 * - 保存の間は本体と保存の帯を覆い(「保存中…」)、入力と二度押しを止める。保存の後の読み直しは 1 回
 * - 本体を key で作り直さない。保存の後に読み直しで届いた値は、未保存の印・「内容が更新されました」の注記にならない
 * - 本体の PATCH は自分が変えた欄だけを載せる(開いた後にほかの人が変えた欄を上書きしない)
 * - 評価計画は帯の「保存(下書き)」で一緒に送る(評価計画のタブに保存のボタンは無い)。破棄は本体と評価計画の両方を戻す
 *
 * 「未保存のまま新しい値が届く」(注記が出る場面)は、利用者の操作から決まって作れないので単体テスト(test/experiment-draft.test.ts の
 * reconcileServerUpdate)で見る。状態のボタン(開始など)の前の確認は Task 8 なので、ここでは状態のボタンの挙動に頼らない
 * (実行中のテストは準備で changeStatus を使って作るだけ)
 */

const SITE = { id: "site_e2e_xsave", name: "E2E Experiment Save" };
const EXP = { id: "exp_e2e_xsave", name: "E2E save experience" };
const EXP_RUN = { id: "exp_e2e_xsave_run", name: "E2E save running" };
const SAVED = "保存しました";
const SAVED_WITH_PLAN = "保存しました。評価計画は反映済みです";
const REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
const SERVER_UPDATED = "この画面を開いた後に、内容が更新されました";

/** 画面を通さずに BFF を呼ぶ(ほかの人の変更・保存された値の確かめ) */
async function control(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return page.evaluate(
    async ([m, p, b, h]) => {
      const r = await fetch(`/api/control${p}`, { method: m, headers: b === undefined ? h : { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    },
    [method, path, body, controlHeaders()] as const,
  );
}

const isRsc = (req: Request, pathname: string) => {
  const url = new URL(req.url());
  return req.method() === "GET" && url.pathname === pathname && url.searchParams.has("_rsc") && !req.headers()["next-router-prefetch"];
};

/** 送った要求を数える(method と pathname が一致するもの。RSC は先読みでない GET だけ) */
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

/** pathname の読み直し(先読みでない RSC の GET)を ms だけ止める。release() で止めを待たずに通す。ms = null は release() まで止める(自分では放さない) */
async function holdRefresh(page: Page, pathname: string, ms: number | null): Promise<{ release: () => void; undo: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const handler = async (route: Route) => {
    if (!isRsc(route.request(), pathname)) return route.continue();
    await (ms === null ? released : Promise.race([released, new Promise((r) => setTimeout(r, ms))]));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return { release, undo: () => page.unroute("**/*", handler) };
}

test.describe.serial("experiment save (B173 stage 1)", () => {
  let page: Page;
  let siteUrl: string;
  const expPath = (id: string) => `${new URL(siteUrl).pathname}/experiments/${id}`;
  const apiPath = (id: string) => `/sites/${SITE.id}/experiments/${id}`;
  const openExperiment = async (id: string, tab?: string) => {
    await page.goto(`${siteUrl}/experiments/${id}${tab ? `?tab=${tab}` : ""}`);
    await waitForHydration(page);
  };
  const nameInput = () => page.getByRole("region", { name: "基本", exact: true }).getByLabel("名前(100 字以内)");
  const saveButton = () => page.getByRole("button", { name: "保存(下書き)" });
  const saveState = () => page.getByTestId("save-state");
  const overlay = () => page.getByRole("status").filter({ hasText: "保存中…" });
  const maxWeeks = () => page.getByRole("spinbutton", { name: "最大期間", exact: true });
  /** 今の最大期間と違う値(2〜26 週の中) */
  const otherWeeks = async () => String(Number(await maxWeeks().inputValue()) === 9 ? 10 : 9);
  const patchCount = (id: string) => countRequests(page, (r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control${apiPath(id)}`);

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // ログインは 1 回(fixtures.ts の login() の予算)
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("setup: a site, a draft test and a running test", async () => {
    await createSite(page, SITE);
    siteUrl = page.url();
    await createExperiment(page, EXP_RUN);
    // 配信率は既定の 100 だと上げられないので、下書きの間に 50 にしておく(開始後にほかの人が上げる場面のため。最終レビュー FR-Medium-1)
    expect((await control(page, "PATCH", apiPath(EXP_RUN.id), { trafficPercentage: 50 })).status).toBe(200);
    expect((await changeStatus(page, SITE.id, EXP_RUN.id, /^開始/)).publish.ok).toBe(true);
    await page.goto(siteUrl);
    await waitForHydration(page);
    await createExperiment(page, EXP);
  });

  test("inputs are locked under the overlay and the double click sends one PATCH", async () => {
    await openExperiment(EXP.id);
    await nameInput().fill("E2E save 1");
    const patches = patchCount(EXP.id);
    const rsc = countRequests(page, (r) => isRsc(r, expPath(EXP.id)));
    const undo = await holdApi(page, "PATCH", apiPath(EXP.id), { delayMs: 1_000 });
    try {
      await saveButton().dblclick();
      await expect(overlay()).toBeVisible();
      // 覆いの間は名前の欄に入力できない
      await expect(nameInput()).not.toBeEditable();
      await page.keyboard.type("zz");
      await expect(nameInput()).toHaveValue("E2E save 1");
      await expect(saveState()).toHaveText(SAVED);
      await expect(overlay()).toHaveCount(0);
      expect(patches.count()).toBe(1);
      expect(rsc.count()).toBe(1);
    } finally {
      patches.stop();
      rsc.stop();
      await undo();
    }
  });

  test("a double click during the running-test confirm opens one confirm and sends one PATCH", async () => {
    await openExperiment(EXP_RUN.id);
    await page.getByRole("region", { name: "配信条件" }).getByRole("textbox", { name: "値", exact: true }).first().fill("/running-changed");
    const patches = patchCount(EXP_RUN.id);
    try {
      // 同じ処理の中で 2 回押す(dblclick だと、1 回目で開いた確認の背面を 2 回目が押して、確認がキャンセルで閉じる。
      // 第 2 段で開いた直後の 0.5 秒のクリックは無視するようにした(e2e/busy-scopes.spec.ts)。ここでは確認が 2 つ開かないこと・送るのが 1 回であることだけを見る)
      await saveButton().evaluate((el: HTMLButtonElement) => {
        el.click();
        el.click();
      });
      const confirm = page.getByRole("alertdialog", { name: "実行中のテストを変更しますか?" });
      await expect(confirm).toBeVisible();
      await expect(page.getByRole("alertdialog")).toHaveCount(1);
      expect(patches.count()).toBe(0); // 確認の前には送らない
      await confirm.getByRole("button", { name: "保存する", exact: true }).press("Enter");
      await expect(saveState()).toHaveText(SAVED);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect(patches.count()).toBe(1);
    } finally {
      patches.stop();
    }
  });

  test("two saves in a row both show 保存しました and never the update notice", async () => {
    await openExperiment(EXP.id);
    // 注記が一度でも出たかを、ページの中で見張る(出てすぐ消えても拾う)
    await page.evaluate((text) => {
      const w = window as unknown as { __noticeSeen: boolean };
      w.__noticeSeen = false;
      new MutationObserver(() => {
        if (document.body.textContent?.includes(text)) w.__noticeSeen = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    }, SERVER_UPDATED);
    await nameInput().fill("E2E save 2");
    await saveButton().click();
    await expect(saveState()).toHaveText(SAVED);
    // 2 回目は配信条件の行も足す(画面で足した行の id と、サーバーの値から作った行の id が違っても注記にならない)
    await nameInput().fill("E2E save 3");
    await page.getByRole("button", { name: "+ 条件" }).click();
    const row = page.getByTestId("condition-row").first();
    await row.getByRole("combobox", { name: "条件の種類" }).click();
    await row.getByRole("option", { name: "端末", exact: true }).click();
    await expect(saveState()).toHaveText("未保存の変更あり");
    await saveButton().click();
    await expect(saveState()).toHaveText(SAVED);
    await page.waitForTimeout(500);
    await expect(saveState()).toHaveText(SAVED);
    await expect(page.getByTestId("condition-row")).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __noticeSeen: boolean }).__noticeSeen)).toBe(false);
  });

  test("a save after a refresh timeout completes on the real refresh, not on a second timeout", async () => {
    test.setTimeout(90_000);
    await openExperiment(EXP.id);
    await nameInput().fill("E2E save 4");
    const held = await holdRefresh(page, expPath(EXP.id), 11_000);
    try {
      await saveButton().click();
      await expect(appAlert(page).filter({ hasText: REFRESH_TIMEOUT })).toBeVisible({ timeout: 15_000 });
      // 止めた読み直しを通し、届くのを待ってから次の保存をする
      const landed = page.waitForResponse((r) => isRsc(r.request(), expPath(EXP.id)));
      held.release();
      await landed;
    } finally {
      held.release();
      await held.undo();
    }
    await expect(nameInput()).toHaveValue("E2E save 4");
    await nameInput().fill("E2E save 5");
    const started = Date.now();
    await saveButton().click();
    await expect(saveState()).toHaveText(SAVED, { timeout: 10_000 });
    expect(Date.now() - started, "the second save ends on its own refresh, not on another 10 s timeout").toBeLessThan(2_000);
  });

  test("a failed save keeps the input", async () => {
    await openExperiment(EXP.id);
    await nameInput().fill("E2E save failed");
    const undo = await holdApi(page, "PATCH", apiPath(EXP.id), { fulfill: { status: 500, body: { error: "internal", message: "E2E の保存の失敗" } } });
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
    // 後のテストのために破棄する
    await page.getByRole("button", { name: "破棄" }).click();
  });

  test("plan and body saved together show the plan suffix and one refresh", async () => {
    await openExperiment(EXP.id);
    await nameInput().fill("E2E save with plan");
    await page.getByRole("tab", { name: "評価計画" }).click();
    // 評価計画のタブに保存のボタンは無い(下の帯で保存する)
    await expect(page.getByRole("button", { name: "評価計画を保存" })).toHaveCount(0);
    const weeks = await otherWeeks();
    await maxWeeks().fill(weeks);
    await expect(page.getByTestId("plan-unsaved")).toHaveText("評価計画は保存した時点で反映されます(公開は不要)");
    const patches = patchCount(EXP.id);
    const puts = countRequests(page, (r) => r.method() === "PUT" && new URL(r.url()).pathname === `/api/control${apiPath(EXP.id)}/evaluation-plan`);
    const rsc = countRequests(page, (r) => isRsc(r, expPath(EXP.id)));
    try {
      await saveButton().click();
      await expect(saveState()).toHaveText(SAVED_WITH_PLAN);
      await expect(page.getByTestId("plan-unsaved")).toHaveCount(0);
      await expect(maxWeeks()).toHaveValue(weeks);
      expect(patches.count()).toBe(1);
      expect(puts.count()).toBe(1);
      expect(rsc.count()).toBe(1);
    } finally {
      patches.stop();
      puts.stop();
      rsc.stop();
    }
    const plan = (await control(page, "GET", `${apiPath(EXP.id)}/evaluation-plan`)).json as { plan: { maxWeeks: number } };
    expect(plan.plan.maxWeeks).toBe(Number(weeks));
  });

  test("discard resets both the body and the evaluation plan", async () => {
    await openExperiment(EXP.id);
    const savedName = await nameInput().inputValue();
    await nameInput().fill("E2E discard me");
    await page.getByRole("tab", { name: "評価計画" }).click();
    const savedWeeks = await maxWeeks().inputValue();
    await maxWeeks().fill(await otherWeeks());
    await expect(saveState()).toHaveText("未保存の変更あり");
    await page.getByRole("button", { name: "破棄" }).click();
    await expect(maxWeeks()).toHaveValue(savedWeeks);
    await expect(page.getByTestId("plan-unsaved")).toHaveCount(0);
    await expect(saveState()).toHaveText("変更はありません");
    await page.getByRole("tab", { name: "基本設定" }).click();
    await expect(nameInput()).toHaveValue(savedName);
  });

  // B189(オーディエンスの I3 と同じ): A を表示 → B を保存(成功)→ 読み直しが時間切れ(props は A のまま)→ C に編集 → 破棄 = B に戻る。
  // 次の PATCH も B を基準に組む(メモだけ変えたら、名前は送らない)
  test("discard after a save whose refresh timed out goes back to the saved value", async () => {
    test.setTimeout(90_000);
    await openExperiment(EXP.id);
    const patchPath = `/api/control${apiPath(EXP.id)}`;
    const isPatch = (r: Request) => r.method() === "PATCH" && new URL(r.url()).pathname === patchPath;
    const memoInput = () => page.getByRole("region", { name: "基本", exact: true }).getByLabel("メモ(社内用。外部には出力されません)");
    // 読み直しは 2 回目の PATCH を確かめ終わるまで止める(届くと props が B になり、直す前のコードでも通ってしまう)
    const held = await holdRefresh(page, expPath(EXP.id), null);
    const memo = `disc memo ${Date.now()}`;
    try {
      await nameInput().fill("E2E disc B");
      const first = page.waitForRequest(isPatch);
      await saveButton().click();
      expect((await first).postDataJSON()).toEqual({ name: "E2E disc B" });
      await expect(appAlert(page).filter({ hasText: REFRESH_TIMEOUT })).toBeVisible({ timeout: 15_000 });
      await expect(overlay()).toHaveCount(0);
      await expect(saveState()).toHaveText("変更はありません");
      // C に編集してから破棄 → 保存した B に戻る(保存の前の値ではない)
      await nameInput().fill("E2E disc C");
      await expect(saveState()).toHaveText("未保存の変更あり");
      await page.getByRole("button", { name: "破棄" }).click();
      await expect(nameInput()).toHaveValue("E2E disc B");
      await expect(saveState()).toHaveText("変更はありません");
      // 次の保存はメモだけ: PATCH は 1 回で、名前を載せない
      await memoInput().fill(memo);
      const patches = countRequests(page, isPatch);
      try {
        const second = page.waitForRequest(isPatch);
        await saveButton().click();
        expect((await second).postDataJSON()).toEqual({ description: memo });
        await expect(appAlert(page).filter({ hasText: REFRESH_TIMEOUT })).toBeVisible({ timeout: 15_000 });
        await expect(overlay()).toHaveCount(0);
        expect(patches.count()).toBe(1);
      } finally {
        patches.stop();
      }
    } finally {
      held.release();
      await held.undo();
    }
    const after = await control(page, "GET", apiPath(EXP.id));
    expect(after.json?.name).toBe("E2E disc B");
    expect(after.json?.description).toBe(memo);
  });

  test("the open tab is not rewritten by the server value after a save", async () => {
    await openExperiment(EXP.id);
    await nameInput().fill("E2E save tab");
    await page.getByRole("tab", { name: "パターン" }).click();
    await expect(page).toHaveURL(/\?tab=variants$/);
    const held = await holdRefresh(page, expPath(EXP.id), 1_000);
    try {
      await saveButton().click();
      await expect(saveState()).toHaveText(SAVED);
    } finally {
      await held.undo();
    }
    await page.waitForTimeout(300);
    await expect(page.getByRole("tab", { name: "パターン" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?tab=variants$/);
  });

  test("name-only save keeps and shows another user's traffic", async () => {
    await openExperiment(EXP.id);
    // 画面を開いた後に、ほかの人が配信率を 20 に変える
    expect((await control(page, "PATCH", apiPath(EXP.id), { trafficPercentage: 20 })).status).toBe(200);
    await nameInput().fill("E2E save name only");
    await saveButton().click();
    await expect(saveState()).toHaveText(SAVED);
    const exp = (await control(page, "GET", apiPath(EXP.id))).json as { name: string; trafficPercentage: number };
    expect(exp).toMatchObject({ name: "E2E save name only", trafficPercentage: 20 });
    // 読み直しで届いたほかの人の変更が欄に入り、未保存の印も注記も出ない
    await expect(page.getByRole("spinbutton", { name: /^配信率/ })).toHaveValue("20");
    await expect(page.getByText(SERVER_UPDATED)).toHaveCount(0);
    // 何も変えずに保存を押しても PATCH は送らない
    const patches = patchCount(EXP.id);
    try {
      await saveButton().click();
      await page.waitForTimeout(500);
      expect(patches.count()).toBe(0);
      await expect(saveState()).toHaveText("変更はありません");
    } finally {
      patches.stop();
    }
  });

  // 最終レビュー FR-Medium-1: 未保存のまま、ほかの人が上げた配信率(50 → 75)が届いても、名前だけの保存は止めず、配信率は送らない。
  // 「未保存のまま新しい値が届く」場面は、読み直しを 10 秒の打ち切りの後まで止めて作る(打ち切りの後は入力できるので、
  // 止めた読み直しが届く前に名前を変えておける)。素直に「開く → API で上げる → 名前を変えて保存」だと、新しい値が画面に届かず検査が働かない。
  // 読み直しは自分では放さず、画面の状態(打ち切りの文言・入力の反映)を確かめてから release() で通す(打ち切りの後の操作の速さに頼らない)
  // 配信率の欄に赤字(aria-invalid と文)が出ていないこと
  const TRAFFIC_LOCKED_TEXT = "テストの開始後は配信率を下げられません";
  async function expectTrafficFieldClean() {
    await expect(page.getByRole("spinbutton", { name: /^配信率/ })).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(TRAFFIC_LOCKED_TEXT)).toHaveCount(0);
  }

  test("a name-only save on a running test is not blocked by another user's raised traffic that arrived while editing", async () => {
    test.setTimeout(90_000);
    await openExperiment(EXP_RUN.id);
    await expect(page.getByRole("spinbutton", { name: /^配信率/ })).toHaveValue("50");
    await nameInput().fill("E2E run rename 1");
    const held = await holdRefresh(page, expPath(EXP_RUN.id), null);
    try {
      await saveButton().click();
      await expect(appAlert(page).filter({ hasText: REFRESH_TIMEOUT })).toBeVisible({ timeout: 15_000 });
      // 画面を開いた後に、ほかの人が配信率を上げる。止めている読み直しは、この後にサーバーで描かれるので 75 を運ぶ
      expect((await control(page, "PATCH", apiPath(EXP_RUN.id), { trafficPercentage: 75 })).status).toBe(200);
      await nameInput().fill("E2E run rename 2");
      await expect(nameInput()).toHaveValue("E2E run rename 2");
      await expect(saveState()).toHaveText("未保存の変更あり");
      const landed = page.waitForResponse((r) => isRsc(r.request(), expPath(EXP_RUN.id)));
      held.release();
      await landed;
    } finally {
      held.release();
      await held.undo();
    }
    // 未保存のまま新しい値が届いた(注記が出る)。下書きの名前と配信率(50)は残る
    await expect(page.getByText(SERVER_UPDATED)).toBeVisible();
    await expect(nameInput()).toHaveValue("E2E run rename 2");
    // 送らない配信率の欄には、保存済みの値(75)より低くても赤字を出さない(B173 第 2 段)。保存の前
    await expectTrafficFieldClean();
    const bodies: unknown[] = [];
    const onRequest = (req: Request) => {
      if (req.method() === "PATCH" && new URL(req.url()).pathname === `/api/control${apiPath(EXP_RUN.id)}`) bodies.push(req.postDataJSON());
    };
    page.on("request", onRequest);
    try {
      await saveButton().click();
      await expect(saveState()).toHaveText(SAVED);
    } finally {
      page.off("request", onRequest);
    }
    // 送ったのは名前だけ(配信率は送らない)。保存された配信率はほかの人の 75 のまま
    expect(bodies).toEqual([{ name: "E2E run rename 2" }]);
    const exp = (await control(page, "GET", apiPath(EXP_RUN.id))).json as { name: string; trafficPercentage: number };
    expect(exp).toMatchObject({ name: "E2E run rename 2", trafficPercentage: 75 });
    // 保存の後も赤字は出ない
    await expectTrafficFieldClean();
    // 下書きの配信率を保存済みの 75 より低い 60 に変えると、送る欄になるので赤字と aria-invalid が出る
    const traffic = page.getByRole("spinbutton", { name: /^配信率/ });
    await traffic.fill("60");
    await expect(traffic).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(TRAFFIC_LOCKED_TEXT)).toBeVisible();
    // 欄の min は保存済みの値(75)のまま(送る欄の下限として使う。送らない欄では赤字にしないだけ)
    await expect(traffic).toHaveAttribute("min", "75");
  });
});
