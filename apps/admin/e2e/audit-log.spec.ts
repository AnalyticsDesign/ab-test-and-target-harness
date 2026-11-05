import { test, expect, type Page, type Request, type Response } from "@playwright/test";
import {
  BREAK_GLASS_TOKEN,
  CONTROL_URL,
  OWNER_EMAIL,
  OWNER_NAME,
  WORKSPACE_NAME,
  acceptInvite,
  controlHeaders,
  createExperiment,
  createSite,
  issueInvite,
  login,
  markSessionsAsGoogle,
  openMembers,
  pick,
  waitForHydration,
} from "./fixtures";

/**
 * 操作の記録と変更履歴(B129)。Task 10: エクスペリエンスの「変更履歴」のタブ(spec §7.1・§10.6)。
 * - タブを開くまで `GET …/history` を呼ばない(エクスペリエンスの画面の要求数を変えない)。開いたら 1 本
 * - タブを開いたまま保存したときは、タブの中で読み直す(1 本)。新しい行が出る
 * - 閲覧者にもタブが見え、メールアドレスは出ない(control が管理者未満には返さない)
 * Task 11: 設定の「操作の記録」(spec §7.2)。ワークスペースの記録(/w/:wid/audit-events)と導入全体の記録(/w/me/audit-events)
 * - ロールの変更が新しい順に出る / 「操作した人」は画面の中だけで絞る(読み直さない)/ 「パスワードのログイン・非常口だけ」は API で読み直す
 * - 101 件以上で「さらに 100 件を読み込む」/ 非常口を開いていた期間を人が入れると、すべてのログイン方法の操作が出る(Q16)
 * 招待受諾 2 回・`break-glass/reset-link` 1 回を使う(fixtures.ts の予算)
 */

const SITE = { id: "site_e2e_audit", name: "E2E Audit Log" };
const EXP = { id: "exp_e2e_audit", name: "E2E audit experience" };
const VIEWER = { email: "audit-viewer@e2e.example", name: "Audit Viewer" };
/** 非常口が開いている間に Bearer 無しで招待を受け、Google のセッションで鍵を発行する人(Q16) */
const BG_MEMBER = { email: "audit-bg@e2e.example", name: "Audit Break Glass" };

const historyPath = `/api/control/sites/${SITE.id}/experiments/${EXP.id}/history`;
const isHistory = (r: Request) => r.method() === "GET" && new URL(r.url()).pathname === historyPath;
const isHistoryResponse = (r: Response) => isHistory(r.request());

/** 変更履歴の要求を数える */
function countHistory(page: Page): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (r: Request) => {
    if (isHistory(r)) n += 1;
  };
  page.on("request", on);
  return { count: () => n, stop: () => page.off("request", on) };
}

test.describe.serial("experiment history tab and the operation log (B129)", () => {
  let page: Page;
  let expUrl: string;
  const historyTab = (p: Page) => p.getByRole("tab", { name: "変更履歴", exact: true });
  const table = (p: Page) => p.getByTestId("history-table");

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    // ログインは 1 回(fixtures.ts の login() の予算)
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("setup: a site and a draft test", async () => {
    await createSite(page, SITE);
    await createExperiment(page, EXP);
    expUrl = page.url();
  });

  test("history_not_loaded_until_opened", async () => {
    const history = countHistory(page);
    try {
      await page.goto(expUrl);
      await waitForHydration(page);
      // 基本設定・パターンを見ている間は読まない
      await page.getByRole("tab", { name: "パターン", exact: true }).click();
      await page.getByRole("tab", { name: "基本設定", exact: true }).click();
      await page.waitForLoadState("networkidle");
      expect(history.count()).toBe(0);
      // 開いたら 1 本
      const res = page.waitForResponse(isHistoryResponse);
      await historyTab(page).click();
      expect((await res).status()).toBe(200);
      await expect(table(page).locator('tr[data-op="experiment.create"]')).toContainText("エクスペリエンスを作成");
      await expect(page).toHaveURL(/\?tab=history$/);
      expect(history.count()).toBe(1);
      // 管理者以上(オーナー)にはメールアドレスも出る
      await expect(table(page)).toContainText(OWNER_EMAIL);
    } finally {
      history.stop();
    }
  });

  test("history_tab_reloads_in_tab_after_save", async () => {
    await page.goto(expUrl);
    await waitForHydration(page);
    await page.getByRole("region", { name: "基本設定" }).getByLabel("名前(100 字以内)").fill("E2E audit renamed");
    // 未保存の入力を持ったまま変更履歴のタブへ移り、そこで保存する
    await historyTab(page).click();
    await expect(table(page)).toBeVisible();
    const history = countHistory(page);
    try {
      const reloaded = page.waitForResponse(isHistoryResponse);
      await page.getByRole("button", { name: "保存(下書き)" }).click();
      await expect(page.getByTestId("save-state")).toHaveText("保存しました");
      expect((await reloaded).status()).toBe(200);
      // 表はタブの中の 1 本で読み直す(保存の router.refresh は今までどおり走る)。新しい行が出る
      const row = table(page).locator('tr[data-op="experiment.update"]').first();
      await expect(row).toContainText("基本設定を保存");
      await expect(row).toContainText("名前「E2E audit experience」→「E2E audit renamed」");
      await page.waitForLoadState("networkidle");
      expect(history.count()).toBe(1);
    } finally {
      history.stop();
    }
  });

  test("viewer_sees_history_without_email", async ({ browser }) => {
    await openMembers(page);
    const url = await issueInvite(page, VIEWER.email, /^閲覧者/);
    const { ctx, page: viewer } = await acceptInvite(browser, url, VIEWER.name);
    try {
      await viewer.goto(`${new URL(expUrl).pathname}?tab=history`);
      await waitForHydration(viewer);
      await expect(historyTab(viewer)).toHaveAttribute("aria-selected", "true");
      await expect(table(viewer).locator('tr[data-op="experiment.update"]').first()).toContainText(OWNER_NAME);
      await expect(table(viewer)).not.toContainText("@");
      await expect(viewer.getByTestId("history-tab")).not.toContainText("@");
    } finally {
      await ctx.close();
    }
  });

  // ---- Task 11: 設定の「操作の記録」 ----

  const wid = () => new URL(expUrl).pathname.split("/")[2]!;
  const wsLogPath = () => `/api/control/workspaces/${wid()}/audit-events`;
  const isWsLog = (r: Request) => r.method() === "GET" && new URL(r.url()).pathname === wsLogPath();
  const logTable = (p: Page) => p.getByTestId("audit-table");
  const menu = (p: Page) => p.getByRole("navigation", { name: "メインメニュー" });
  const kindPicker = (p: Page) => p.getByRole("combobox", { name: "種類", exact: true });

  test("role_change_appears_in_log", async () => {
    await openMembers(page);
    await waitForHydration(page);
    const row = page.getByTestId("members").getByRole("row").filter({ hasText: VIEWER.email });
    const dialog = page.getByRole("alertdialog", { name: `${VIEWER.name} のロールを変更しますか?` });
    await pick(page, `${VIEWER.name} のロール`, /^編集者/);
    // 確認を開いた直後 0.5 秒のマウスのクリックは無視される(lib/dialog-click.ts)ので、Enter で確定する(busy-scopes.spec.ts と同じ)
    await dialog.getByRole("button", { name: "変更する" }).press("Enter");
    await expect(row.getByRole("combobox")).toContainText("編集者");
    await pick(page, `${VIEWER.name} のロール`, /^閲覧者/);
    await dialog.getByRole("button", { name: "変更する" }).press("Enter");
    await expect(row.getByRole("combobox")).toContainText("閲覧者");
    // 変更の後の画面の読み直しが終わるまでは保存の途中として扱い、リンクで離れると確認が出る(B173 第 2 段)ので、終わってから移る
    await expect(page.getByTestId("members-list").getByRole("status").filter({ hasText: "ロールを変更しました" })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // 設定のメニューのワークスペースの節(「メンバーの API キー」の次)から開く。システムの節にも同じ名前があるので href で引く
    await menu(page).locator(`a[href="/w/${wid()}/audit-events"]`).click();
    await expect(page).toHaveURL(new RegExp(`/w/${wid()}/audit-events$`));
    await expect(page.getByRole("heading", { level: 1, name: "操作の記録" })).toBeVisible();
    // 同じワークスペースでほかの spec(busy-scopes)もロールを変えるので、この人の行だけを数える
    const changes = logTable(page).locator('tr[data-op="member.role_change"]').filter({ hasText: VIEWER.email });
    await expect(changes).toHaveCount(2);
    // 新しい順。対象は人(管理者以上にはメールアドレス)
    await expect(changes.nth(0)).toContainText("編集者 → 閲覧者");
    await expect(changes.nth(1)).toContainText("閲覧者 → 編集者");
    await expect(changes.nth(0)).toContainText(VIEWER.email);
    await expect(changes.nth(0)).toContainText(OWNER_NAME);
    // 画面の言葉は「操作の記録」(このテストのデータは英語の audit を含むので、日本語の旧表記だけを見る)
    await expect(page.getByTestId("audit-log")).not.toContainText("監査");
  });

  test("who_filter_is_client_side", async () => {
    await page.goto(`/w/${wid()}/audit-events`);
    await waitForHydration(page);
    await expect(logTable(page)).toBeVisible();
    let reads = 0;
    const on = (r: Request) => {
      if (isWsLog(r)) reads += 1;
    };
    page.on("request", on);
    try {
      const who = page.getByLabel("操作した人");
      await who.fill("audit viewer");
      // 招待を受けて参加した行だけ(操作した人 = 入った人)。ロールの変更はオーナーの操作なので消える
      await expect(logTable(page).locator('tr[data-testid="audit-row"]').first()).toHaveAttribute("data-op", "invitation.accept");
      await expect(logTable(page).locator('tr[data-op="member.role_change"]')).toHaveCount(0);
      await expect(page).toHaveURL(/[?&]who=audit\+viewer/);
      await who.fill("nobody-here");
      await expect(logTable(page)).toContainText("この条件に一致する記録はありません");
      await who.fill("");
      await expect(logTable(page).locator('tr[data-op="member.role_change"]').filter({ hasText: VIEWER.email })).toHaveCount(2);
      await page.waitForLoadState("networkidle");
      expect(reads).toBe(0);
    } finally {
      page.off("request", on);
    }
  });

  // レビュー M-6(I-1): 絞った後に設定のメニューから同じ画面(search なし)へ移ると、サーバーが既定の 1 ページ目を読み直す。
  // 表と絞り込みも既定に戻る(前の絞り込みの状態が残って、表・URL・選択欄が食い違わない)
  test("menu_link_to_same_screen_resets_filters", async () => {
    await page.goto(`/w/${wid()}/audit-events`);
    await waitForHydration(page);
    const reread = page.waitForResponse((r) => isWsLog(r.request()) && new URL(r.url()).searchParams.get("category") === "access");
    await pick(page, "種類", "人とアクセス権");
    expect((await reread).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]kind=access/);
    await expect(logTable(page).locator('tr[data-op="experiment.create"]')).toHaveCount(0);
    await menu(page).locator(`a[href="/w/${wid()}/audit-events"]`).click();
    await expect(page).toHaveURL(new RegExp(`/w/${wid()}/audit-events$`));
    await expect(logTable(page).locator('tr[data-op="experiment.create"]').first()).toBeVisible();
    await expect(kindPicker(page)).toContainText("すべて");
  });

  // B129 final review: 絞り込み(history.replaceState で URL に書く)→ 別の画面 → ブラウザの戻る で、表・URL・選択欄が揃う
  // (replaceSearch は vinext の履歴の控え(history.state)をそのまま残して URL だけを書き換えるので、戻ったときに古い URL の描画が出ないことを見る)
  test("back_after_filter_keeps_table_url_and_picker", async () => {
    await page.goto(`/w/${wid()}/audit-events`);
    await waitForHydration(page);
    await expect(logTable(page).locator('tr[data-op="experiment.create"]').first()).toBeVisible();
    const reread = page.waitForResponse((r) => isWsLog(r.request()) && new URL(r.url()).searchParams.get("category") === "access");
    await pick(page, "種類", "人とアクセス権");
    expect((await reread).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]kind=access/);
    await expect(logTable(page).locator('tr[data-op="experiment.create"]')).toHaveCount(0);
    // 別の画面(設定のメンバー)へ移ってから戻る
    await menu(page).getByRole("link", { name: "メンバー", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${wid()}/members$`));
    // メンバーの画面が描き終わってから戻る(移動の途中で戻る操作は、ここで見たいことの外)
    await expect(page.getByTestId("members")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/w/${wid()}/audit-events\\?kind=access$`));
    await waitForHydration(page);
    await expect(kindPicker(page)).toContainText("人とアクセス権");
    await expect(logTable(page).locator('tr[data-op="member.role_change"]').first()).toBeVisible();
    await expect(logTable(page).locator('tr[data-op="experiment.create"]')).toHaveCount(0);
    // 戻った後の絞り込みも効く(パネルが戻った URL の状態で動いている)
    const all = page.waitForResponse((r) => isWsLog(r.request()) && !new URL(r.url()).searchParams.has("category"));
    await pick(page, "種類", "すべて");
    expect((await all).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/w/${wid()}/audit-events$`));
    await expect(logTable(page).locator('tr[data-op="experiment.create"]').first()).toBeVisible();
  });

  test("elevated_filter", async () => {
    // Google のセッションの行を 1 つ作る(E2E は Google を呼べないので、ログインの後に印を書き換える。fixtures.ts の markSessionsAsGoogle)
    markSessionsAsGoogle(OWNER_EMAIL);
    const memo = await page.request.patch(`/api/control/sites/${SITE.id}/experiments/${EXP.id}`, { headers: controlHeaders(), data: { description: "google session memo" } });
    expect(memo.status()).toBe(200);
    await page.goto(`/w/${wid()}/audit-events`);
    await waitForHydration(page);
    await expect(logTable(page).locator('tr[data-via="google"]').first()).toBeVisible();
    await expect(logTable(page).locator('tr[data-via="password"]').first()).toBeVisible();
    const reread = page.waitForResponse((r) => isWsLog(r.request()) && new URL(r.url()).searchParams.get("elevated") === "true");
    await page.getByLabel("パスワードのログイン・非常口だけ").check();
    expect((await reread).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]elevated=1/);
    await expect(logTable(page).locator('tr[data-testid="audit-row"]').first()).toBeVisible();
    await expect(logTable(page).locator('tr[data-via="google"]')).toHaveCount(0);
    const vias = await logTable(page).locator('tr[data-testid="audit-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-via")));
    expect(new Set(vias)).toEqual(new Set(["password"]));
    // URL から開き直しても同じ絞り込み(サーバーの描画が URL を読む)
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByLabel("パスワードのログイン・非常口だけ")).toBeChecked();
    await expect(logTable(page).locator('tr[data-via="google"]')).toHaveCount(0);
  });

  test("load_more", async () => {
    test.setTimeout(120_000);
    // 101 件以上にする(メモだけの保存 1 回 = 記録 1 行)
    for (let i = 0; i < 101; i++) {
      const r = await page.request.patch(`/api/control/sites/${SITE.id}/experiments/${EXP.id}`, { headers: controlHeaders(), data: { description: `memo ${i}` } });
      expect(r.status()).toBe(200);
    }
    await page.goto(`/w/${wid()}/audit-events`);
    await waitForHydration(page);
    const rows = logTable(page).locator('tr[data-testid="audit-row"]');
    await expect(rows).toHaveCount(100);
    await expect(page.getByTestId("audit-count")).toHaveText("100 件以上");
    await expect(page.getByTestId("audit-end")).toHaveCount(0);
    const more = page.waitForResponse((r) => isWsLog(r.request()) && new URL(r.url()).searchParams.has("cursor"));
    await page.getByRole("button", { name: "さらに 100 件を読み込む" }).click();
    const page2 = (await (await more).json()) as { events: unknown[]; nextCursor: string | null };
    // 全件で流すと、先に動く spec の記録も同じワークスペースに積もるので、2 ページ目の後にも続きが残りうる。
    // 続きの有無は応答の nextCursor で決め、画面がそれに合うことを見る
    await expect(rows).toHaveCount(100 + page2.events.length);
    const total = await rows.count();
    expect(total).toBeGreaterThan(100);
    expect(total).toBeLessThanOrEqual(200);
    // 続きは足されるだけで重ならない(ID が一意)
    const ids = await rows.evaluateAll((rs) => rs.map((r) => r.getAttribute("data-id")));
    expect(new Set(ids).size).toBe(total);
    if (page2.nextCursor === null) {
      await expect(page.getByTestId("audit-end")).toHaveText("これより前の記録はありません");
      await expect(page.getByTestId("audit-count")).toHaveText(`${total} 件`);
    } else {
      await expect(page.getByTestId("audit-end")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "さらに 100 件を読み込む" })).toBeVisible();
      await expect(page.getByTestId("audit-count")).toHaveText(`${total} 件以上`);
    }
  });

  test("break_glass_window_shows_all_paths", async ({ browser }) => {
    // 非常口を開いた時刻の代わり(この E2E の control は非常口を開けたまま動いている)。入力は分の単位なので、分の初めに丸める
    const openedAt = Date.now();
    // 1) Bearer 無しで招待を受けてアカウントを作る(パスワードの経路)。再設定リンクの発行より前
    await openMembers(page);
    const url = await issueInvite(page, BG_MEMBER.email, /^編集者/);
    const { ctx, page: member } = await acceptInvite(browser, url, BG_MEMBER.name);
    try {
      // 2) 非常用トークンでオーナーの再設定リンクを発行する(記録からの推定の始まり。発行できるのはオーナーだけ。リンクは使わないのでパスワードは変わらない)
      const link = await page.request.post(`${CONTROL_URL}/break-glass/reset-link`, { data: { token: BREAK_GLASS_TOKEN, email: OWNER_EMAIL } });
      expect(link.status()).toBe(200);
      // 3) その人が Google のセッションで鍵を発行する(パスワード・非常口の絞り込みには出ない経路)
      markSessionsAsGoogle(BG_MEMBER.email);
      const status = await member.evaluate(
        async ([w, h]) => {
          const r = await fetch("/api/control/me/api-keys", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ name: "audit bg key", workspaceId: w, roleCap: "viewer" }) });
          return r.status;
        },
        [wid(), controlHeaders()] as const,
      );
      expect(status).toBe(201);
    } finally {
      await ctx.close();
    }

    // 導入全体の記録(システムの節の最後)
    await page.goto("/w/me/api-keys");
    await waitForHydration(page);
    await menu(page).locator('a[href="/w/me/audit-events"]').click();
    await expect(page).toHaveURL(/\/w\/me\/audit-events$/);
    await waitForHydration(page);
    const box = page.getByTestId("break-glass-window");
    const opened = box.getByLabel("開いた時刻");
    const closed = box.getByLabel("閉じた時刻(空 = 今まで)");
    // 初期値は記録からの推定: 開始 = 再設定リンクの発行(空でない)、終わり = 掃除の記録が無いので空
    await expect(opened).not.toHaveValue("");
    await expect(closed).toHaveValue("");
    // 操作する人が開いた時刻を入れる(見ている人のタイムゾーン。画面の toLocalInput と同じ形)
    const local = await page.evaluate((at) => {
      const d = new Date(at);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }, openedAt);
    await opened.fill(local);
    const reread = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/control/audit-events" && new URL(r.url()).searchParams.has("since"));
    await box.getByRole("button", { name: "この期間で絞る" }).click();
    expect((await reread).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]from=\d+/);
    const t = logTable(page);
    // 受諾(パスワード)・再設定リンク(非常口)・鍵の発行(Google)のどれも出る
    const accept = t.locator('tr[data-op="invitation.accept"]').filter({ hasText: BG_MEMBER.email });
    await expect(accept).toHaveCount(1);
    await expect(accept).toHaveAttribute("data-via", "password");
    await expect(accept).toContainText(WORKSPACE_NAME);
    await expect(t.locator('tr[data-op="break_glass.reset_link"]').first()).toHaveAttribute("data-via", "break_glass");
    const key = t.locator('tr[data-op="api_key.create"][data-via="google"]').filter({ hasText: "API キーを発行" }).filter({ hasText: BG_MEMBER.name });
    await expect(key).toHaveCount(1);
    await expect(key).toContainText("audit bg key");
  });
});
