import { test, expect, type Page } from "@playwright/test";
import { appAlert, controlHeaders, createExperiment, createSite, login, openSite, waitForHydration } from "./fixtures";

/**
 * 決定 51(設計書 §3〜§4・§10、plan ① Task 9): 種別(パーソナライズ)の作成、複製の画面、開始・再開の重なりの確認、公開の確認画面の警告。
 * ログインは最初の 1 回だけにして、同じページを引き回す(fixtures.ts の sign-in の予算。テストごとに login() すると 1 実行で 7 回増える)
 */

/** 管理画面の BFF 経由で control を呼ぶ(ログイン中の Cookie を使う)。準備だけに使い、確かめる操作は画面で行う */
async function control(page: Page, method: string, path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ([m, p, b, h]) => {
      const r = await fetch(`/api/control${p}`, { method: m, headers: b === undefined ? h : { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) });
      return r.status;
    },
    [method, path, body, controlHeaders()] as const,
  );
}

const SITE_KIND = { id: "site_e2e_kind", name: "E2E Kind Site" };

test.describe.serial("experiment kind and duplicate (決定 51)", () => {
  let page: Page;
  /** サイトの画面の URL(`/w/<wid>/sites/<sid>`)。サイトを作った直後に控える */
  let siteUrl: string;
  const openExperiment = async (id: string) => {
    await page.goto(`${siteUrl}/experiments/${id}`);
    await waitForHydration(page);
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("creates a personalization with one pattern", async () => {
    await createSite(page, SITE_KIND);
    siteUrl = page.url();
    await page.getByRole("link", { name: "新しいエクスペリエンス" }).click();
    await page.fill('input[name="id"]', "exp_e2e_single");
    await page.fill('input[name="name"]', "E2E single");
    await page.fill('input[name="value"]', "/");
    await page.getByRole("radio", { name: /パーソナライズ/ }).check();
    await page.getByRole("button", { name: "作成(A パターンを 1 つ用意します)" }).click();
    await expect(page).toHaveURL(/\/experiments\/exp_e2e_single$/);
    await expect(page.getByTestId("experiment-kind")).toHaveText("パーソナライズ");
    await page.getByRole("tab", { name: "パターン" }).click();
    await expect(page.getByTestId("variant-pick-a")).toBeVisible();
    await expect(page.getByRole("button", { name: "パターンを追加" })).toHaveCount(0);
    await expect(page.getByTestId("variant-pick-a")).not.toContainText("%");
  });

  test("duplicates a test into a personalization of the chosen pattern", async () => {
    await page.goto(siteUrl);
    await waitForHydration(page);
    await createExperiment(page, { id: "exp_e2e_src", name: "E2E source" });
    await waitForHydration(page);
    await page.getByRole("button", { name: "複製" }).click();
    const dialog = page.getByRole("alertdialog", { name: "複製して新しいエクスペリエンスを作ります" });
    await dialog.getByRole("radio", { name: /選んだパターンだけを表示する/ }).check();
    await expect(dialog.locator("input").last()).toHaveValue("E2E source(B だけを表示)");
    await expect(dialog.getByText("B には変更が無いため、表示しても今のページと同じです")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "下書きを作成" })).toBeEnabled();
    await dialog.getByRole("button", { name: "下書きを作成" }).press("Enter");
    await expect(page).toHaveURL(/\/experiments\/exp_e2e_src-copy$/);
    await expect(page.getByTestId("experiment-kind")).toHaveText("パーソナライズ");
  });

  test("the duplicate dialog does not close on an outside click", async () => {
    await openSite(page, SITE_KIND.name);
    await page.getByRole("link", { name: "E2E source", exact: true }).click();
    await expect(page).toHaveURL(/\/experiments\/exp_e2e_src$/);
    await waitForHydration(page);
    await page.getByRole("button", { name: "複製" }).click();
    const dialog = page.getByRole("alertdialog", { name: "複製して新しいエクスペリエンスを作ります" });
    await expect(dialog).toBeVisible();
    // 開いた直後 0.5 秒のクリックは背面でも無視される(lib/dialog-click.ts)ので、それを過ぎてから押す(dismissOnBackdrop={false} を確かめるため。
    // このページは serial で後のテストも使うので page.clock は入れず、ここだけ時間を待つ)
    await page.waitForTimeout(600);
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "戻る" }).press("Enter");
    await expect(dialog).toBeHidden();
  });

  test("duplicate_sets_id_and_analytics_name_and_reports_the_new_draft(B37・B103・B108)", async () => {
    // 元に外部計測のエクスペリエンス名の上書きを付ける(複製はそれをそのまま写す)
    expect(await control(page, "PATCH", `/sites/${SITE_KIND.id}/experiments/exp_e2e_src`, { analytics: { overrides: { experimentName: "e2e_source" } } })).toBe(200);
    await openExperiment("exp_e2e_src");
    await page.getByRole("button", { name: "複製" }).click();
    const dialog = page.getByRole("alertdialog", { name: "複製して新しいエクスペリエンスを作ります" });
    const create = dialog.getByRole("button", { name: "下書きを作成" });
    // B103: ID の欄は <元の ID>-copy から。new は新規作成の画面と重なるので止める(B37)
    const idInput = dialog.getByLabel("エクスペリエンス ID(スラッグ)");
    await expect(idInput).toHaveValue("exp_e2e_src-copy");
    await idInput.fill("new");
    await expect(dialog.getByText("new は新規作成の画面と重なるので ID に使えません")).toBeVisible();
    await expect(create).toBeDisabled();
    await idInput.fill("exp_e2e_src_v2");
    // B103: 外部計測の名前は元の値から始め、同じままなら注意する
    const nameInput = dialog.getByLabel("外部計測のエクスペリエンス名");
    await expect(nameInput).toHaveValue("e2e_source");
    await expect(dialog.getByTestId("dup-same-analytics-name")).toBeVisible();
    await nameInput.fill("e2e_source_v2");
    await expect(dialog.getByTestId("dup-same-analytics-name")).toHaveCount(0);
    await expect(create).toBeEnabled();
    await create.press("Enter");
    // B108: 移った先で作成したことを知らせる。印は URL から消す(再読み込みで出し直さない)
    await expect(page).toHaveURL(/\/experiments\/exp_e2e_src_v2$/);
    await expect(page.getByTestId("duplicated-notice")).toContainText("複製して下書きを作りました");
    const analytics = await page.evaluate(
      async ([p, h]) => ((await (await fetch(`/api/control${p}`, { headers: h })).json()) as { analytics: unknown }).analytics,
      [`/sites/${SITE_KIND.id}/experiments/exp_e2e_src_v2`, controlHeaders()] as const,
    );
    expect(analytics).toEqual({ overrides: { experimentName: "e2e_source_v2" } });
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByTestId("duplicated-notice")).toHaveCount(0);
    // B37: 新規作成の画面でも new は送る前に止める
    await page.goto(`${siteUrl}/experiments/new`);
    await waitForHydration(page);
    await page.fill('input[name="id"]', "new");
    await page.fill('input[name="name"]', "Reserved id");
    await page.fill('input[name="value"]', "/");
    await page.getByRole("button", { name: /^作成/ }).click();
    await expect(page.getByText("new は新規作成の画面と重なるので ID に使えません")).toBeVisible();
    await expect(page).toHaveURL(/\/experiments\/new$/);
  });

  test("duplicate_reports_a_failed_analytics_name_update_on_the_new_draft(B103・B108)", async () => {
    // ID は初期値(-copy)のまま。-copy は前のテストの複製で使われているので、control は空いている -copy-2 を使う
    await openExperiment("exp_e2e_src");
    await page.getByRole("button", { name: "複製" }).click();
    const dialog = page.getByRole("alertdialog", { name: "複製して新しいエクスペリエンスを作ります" });
    await dialog.getByLabel("外部計測のエクスペリエンス名").fill("e2e_source_v3");
    // 2 回目の要求(外部計測の名前を直す PATCH)だけを失敗させる
    const target = `**/api/control/sites/${SITE_KIND.id}/experiments/exp_e2e_src-copy-2`;
    await page.route(target, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "injected" }) }) : route.continue(),
    );
    await expect(dialog.getByRole("button", { name: "下書きを作成" })).toBeEnabled();
    await dialog.getByRole("button", { name: "下書きを作成" }).press("Enter");
    await expect(page).toHaveURL(/\/experiments\/exp_e2e_src-copy-2$/);
    await page.unroute(target);
    await expect(page.getByTestId("duplicated-notice")).toBeVisible();
    const failed = page.locator("main").getByRole("alert").filter({ hasText: "外部計測のエクスペリエンス名を変えられませんでした" });
    await expect(failed).toBeVisible();
    // 帯を閉じても、失敗の知らせは残る
    await page.getByTestId("duplicated-notice").getByRole("button", { name: "閉じる" }).click();
    await expect(page.getByTestId("duplicated-notice")).toHaveCount(0);
    await expect(failed).toBeVisible();
  });

  test("start_overlap_confirmation_shows_priority_and_cancel_prevents_start", async () => {
    for (const id of ["exp_e2e_ov1", "exp_e2e_ov2"]) {
      expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments`, { id, name: id, urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } })).toBe(201);
      expect(await control(page, "PUT", `/sites/${SITE_KIND.id}/experiments/${id}/variants/b/changes`, [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: id } }])).toBe(200);
    }
    expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments/exp_e2e_ov1/status`, { status: "running" })).toBe(200);
    await openExperiment("exp_e2e_ov2");
    await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
    const dialog = page.getByRole("alertdialog", { name: "開始しますか?" });
    await expect(dialog).toContainText("「exp_e2e_ov1」(先に開始・再開)が優先され");
    await dialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
  });

  test("publish_preview_shows_overlap_warning", async () => {
    expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments/exp_e2e_ov2/status`, { status: "running" })).toBe(200);
    await page.goto(`${siteUrl}/publish`);
    await expect(page.getByTestId("publish-overlaps")).toContainText("「exp_e2e_ov1」(先に開始・再開)が優先され");
  });

  test("resume_overlap_confirmation_shows_priority_and_cancel_prevents_resume", async () => {
    // ov1 を一時停止 → ov2 は配信中のまま → ov1 を再開すると、ov2 が優先される(再開も配信に入り直す。レビュー r2 CX-Medium-2)
    expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments/exp_e2e_ov1/status`, { status: "paused" })).toBe(200);
    await openExperiment("exp_e2e_ov1");
    let posted = false;
    const onRequest = (r: import("@playwright/test").Request) => {
      if (r.method() === "POST" && r.url().includes("/experiments/exp_e2e_ov1/status")) posted = true;
    };
    page.on("request", onRequest);
    await page.getByRole("button", { name: "再開", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "再開しますか?" });
    await expect(dialog).toContainText("「exp_e2e_ov2」(先に開始・再開)が優先され");
    await dialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "paused");
    expect(posted).toBe(false);
    page.off("request", onRequest);
  });

  test("start_double_click_during_preview_sends_one_status_request", async () => {
    // 重なりの取得を待つ間もボタンは押せない(2 回目の開始が 409 になり、成功の知らせをエラーで上書きしないように)
    expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments`, { id: "exp_e2e_dbl", name: "exp_e2e_dbl", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } })).toBe(201);
    const preview = "**/api/control/sites/*/publish-preview*";
    // 取得を遅らせて、2 回目の押下が取得の途中に入るようにする
    await page.route(preview, async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    const posts: string[] = [];
    const onRequest = (r: import("@playwright/test").Request) => {
      if (r.method() === "POST" && r.url().includes("/experiments/exp_e2e_dbl/status")) posts.push(r.url());
    };
    page.on("request", onRequest);
    try {
      await openExperiment("exp_e2e_dbl");
      const done = page.waitForResponse((r) => r.url().includes("/experiments/exp_e2e_dbl/status") && r.request().method() === "POST");
      await page.getByRole("button", { name: "開始(公開して配信を始める)" }).dblclick();
      // D9 ③: 下書きのテストの開始は必ず確認を出す(このサイトは結果を記録しないので「開始しますか?」)。
      // 確認の「開始する」も二度押しして、状態の要求が 1 回だけであることを確かめる。開いた直後 0.5 秒のマウスのクリックは無視する
      // (B173 第 2 段。dblclick だと 2 回とも無視されうる)ので、同じ処理の中で 2 回押す(experiment-save.spec.ts と同じ。detail が 0 の押下は無視しない)
      const dialog = page.getByRole("alertdialog", { name: "開始しますか?" });
      await dialog.getByRole("button", { name: "開始する", exact: true }).evaluate((el: HTMLButtonElement) => {
        el.click();
        el.click();
      });
      expect((await done).status()).toBe(200);
      await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
      await expect(page.getByTestId("status-result")).toHaveRole("status");
      await expect(page.getByTestId("status-result")).toContainText("を反映しました");
      expect(posts).toHaveLength(1);
    } finally {
      page.off("request", onRequest);
      await page.unroute(preview);
    }
  });

  test("start_refuses_when_publish_preview_fails", async () => {
    expect(await control(page, "POST", `/sites/${SITE_KIND.id}/experiments`, { id: "exp_e2e_ov3", name: "exp_e2e_ov3", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } })).toBe(201);
    const preview = "**/api/control/sites/*/publish-preview*";
    await page.route(preview, (route) => route.fulfill({ status: 500, body: "{}" }));
    let posts = 0;
    const count = (r: import("@playwright/test").Request) => { if (r.method() === "POST" && r.url().includes("/experiments/exp_e2e_ov3/status")) posts++; };
    page.on("request", count);
    try {
      await openExperiment("exp_e2e_ov3");
      await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
      await expect(appAlert(page)).toContainText("公開の確認を読み込めませんでした");
      expect(posts).toBe(0);
    } finally { page.off("request", count); await page.unroute(preview); }
  });
});
