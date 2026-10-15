import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * admin E2E が共有する定数とログインヘルパ。
 *
 * ここに書く値は **すべてテスト専用**(Global Constraints: 秘密情報をリポジトリに置かない)。
 * `SETUP_TOKEN` / `AUTH_SECRET` は playwright.config.ts が `wrangler dev --var` で control に渡すものと同じ値で、
 * 実運用の値ではない(ローカル開発は control の `.dev.vars`、本番は Worker Secrets)。
 *
 * ID とメールアドレスを固定値にできるのは、`global-setup.ts` が毎回 D1 / KV / R2 を消してから
 * migrations を当て直すため(= 実行のたびに「まだ誰もいない」状態から始まる)。
 */
export const ADMIN_URL = "http://localhost:3000";
export const CONTROL_URL = "http://localhost:8799";
export const EDGE_URL = "http://127.0.0.1:8787";
/** 設置タグの配信ファイル(/s/*)を配う場所 = 偽の Cloudflare API(e2e/fake-cf-api.mjs)。本番では配信専用の Worker */
export const STATIC_URL = "http://127.0.0.1:8791";

export const SETUP_TOKEN = "e2e-setup-token";
export const AUTH_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";
/** control を「非常用のパスワードログインが開いた状態」で起動するためのテスト用トークン(16 文字以上) */
export const BREAK_GLASS_TOKEN = "e2e-break-glass-token-0123456789";

export const PASSWORD = "password123";
export const OWNER_EMAIL = "owner@e2e.example";
export const OWNER_NAME = "Owner";
export const WORKSPACE_NAME = "E2E Workspace";

/** publish-flow が作り、invite-flow が読む Site / Experiment(名前は getByRole の完全一致で引くので互いに部分一致しないこと) */
export const SITE = { id: "site_e2e_ctl", name: "E2E Site" };
/** Publish しないまま置く Site。edge の bootstrap が 404(spec §9.4 fail-closed)であることの確認用 */
export const SITE_UNPUBLISHED = { id: "site_e2e_unpub", name: "E2E Unpublished" };
/**
 * Pause の確認専用の Site。edge は settings / active / config を isolate に 60 秒キャッシュするため
 * (apps/edge/src/store.ts の TTL_MS)、1 つの Site を「v1 を見てから v2 を見る」形では確認できない。
 * Site を分けて **その Site の bootstrap を 1 度だけ**(Pause 後に)取得する
 */
export const SITE_PAUSED = { id: "site_e2e_pause", name: "E2E Pause Site" };

/** Publish が compile 段階で失敗する状況を作る専用の Site(決定 17 のアラート確認用) */
export const SITE_FAILED = { id: "site_e2e_fail", name: "E2E Fail Site" };

/** ページの一致の入力欄(目標・対象 URL・正規表現の置き換えの通知)の確認専用の Site。Publish はしない */
export const SITE_PAGE_MATCH = { id: "site_e2e_pgm", name: "E2E Page Match" };

export const EXPERIMENT = { id: "exp_e2e_hero", name: "E2E hero" };
export const EXPERIMENT_PAUSED = { id: "exp_e2e_pause", name: "E2E pause" };
export const EXPERIMENT_FAILED = { id: "exp_e2e_fail", name: "E2E fail" };
/** 公開履歴・Publish 確認画面の相乗り確認(上部バーの副 → 主)専用。下書きのまま残り、以後のテストは触らない */
export const EXPERIMENT_SECOND = { id: "exp_e2e_second", name: "E2E second" };

/** Variant B に入れる TEXT Change(edge の bootstrap にこの文字列が現れることが DoD 3 の確認になる) */
export const HERO_SELECTOR = ".hero-title";
export const HERO_TEXT = "E2E から書き換え";

/**
 * ログイン。BFF(`/api/session/login`)が HttpOnly Cookie を張り、`/w` に着地するところまでを 1 単位にする。
 *
 * control の無認証 POST(sign-in / setup / 招待受諾)は **経路ごとに** IP 単位で 10 回 / 10 秒(決定 35 (3))。
 * admin BFF は接続元 IP を転送しないので(決定 35 (4))、この E2E のすべての無認証 POST は control からは
 * 同じ IP に見え、経路ごとに 1 枠を共有する(apps/control/src/app.ts)。
 *
 * **テストを足すときはこの予算を数えること。** 現在 1 実行あたり sign-in 21 回(publish-flow 10 / audience-flow 8 / invite-flow 1 / login-screen 1 / write-freeze 1、
 * うち publish-flow の 1 回は非常口の手順 `setOwnerPassword()` の後の初回ログイン)/ setup 1 回 / 招待受諾 1 回 /
 * `break-glass/reset-link` 1 回 / `reset-password` 1 回で、
 * 10 秒窓に入る sign-in は実測でも 10 回未満に収まっている。これ以上ログインを増やすなら、
 * 各テストでログインし直すのをやめて `storageState` でセッションを引き回すこと(ログインの検証は 1 本残せばよい)。
 * API キーの失効の確認(`publish-flow.spec.ts` の "a site without a publish is refused by the edge")は
 * 新しい login() を足さず、既にログイン済みのこのテストに相乗りしている(予算は変わらない)。
 *
 * 決定 46: E2E は Google を呼べないので、control を break-glass を開いた状態(`BREAK_GLASS_TOKEN`)で起動し、
 * 非常用のパスワード欄から入る。**閉じた状態(本番の既定)の画面は E2E では通らない** — 出し分けは
 * `test/login-view.test.ts` / `test/capabilities.test.ts` が固定し、実画面は本番切り替えの確認項目で見る
 */
export async function login(page: Page, email = OWNER_EMAIL, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // login() の最後の 1 行: 着地はホーム(/w。参加の数に関わらず自動では移らない。決定 54 (8))
  await expect(page).toHaveURL(/\/w(\/[^/]+)?$/);
}

/** 非常口の手順そのもの: reset-link → パスワード設定。以後 login() が使う PASSWORD になる */
export async function setOwnerPassword(request: APIRequestContext): Promise<void> {
  const link = await request.post(`${CONTROL_URL}/break-glass/reset-link`, { data: { token: BREAK_GLASS_TOKEN, email: OWNER_EMAIL } });
  expect(link.status()).toBe(200);
  const token = new URL(((await link.json()) as { url: string }).url).searchParams.get("token");
  const reset = await request.post(`${CONTROL_URL}/auth/reset-password`, { data: { token, newPassword: PASSWORD }, headers: { origin: ADMIN_URL } });
  expect(reset.status()).toBe(200);
}

/**
 * 画面が出したエラー(`components/ErrorBox.tsx` / `components/Field.tsx` の `role="alert"`)。
 * `<main>` に限るのは、`next dev` のデベロッパーオーバーレイが `<body>` 直下に空の `role="alert"` を置くため
 * (素の `getByRole("alert")` はそれを拾って常に 1 件になる)
 */
export const appAlert = (page: Page): Locator => page.locator("main").getByRole("alert");

/** ホーム(`/w`)からワークスペースに入る。ホームは参加の数に関わらず必ず出る(決定 54 (8)) */
export async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/w");
  await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toBeVisible();
  await page.getByTestId("workspace-card").getByRole("link", { name: WORKSPACE_NAME, exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  // URL だけでなく、サイドバーの切替がそのワークスペースを描いていることまで見る
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).toContainText(WORKSPACE_NAME);
}

/** ログイン後の Workspace 画面から Site を作る(名前 / ドメイン / Site ID を指定) */
export async function createSite(page: Page, site: { id: string; name: string }): Promise<void> {
  await openWorkspace(page);
  // 作成フォームは「新しいサイト」で開く(Site が 1 つも無いときは最初から開いている)
  const nameInput = page.locator('input[name="name"]');
  if (!(await nameInput.isVisible())) await page.getByRole("button", { name: "新しいサイト" }).click();
  await page.fill('input[name="name"]', site.name);
  await page.fill('input[name="domain"]', "localhost");
  await page.fill('input[name="id"]', site.id);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`/sites/${site.id}$`));
  await expect(page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "設定" })).toBeVisible(); // SITE ナビが出ている = Site 一覧が更新された
}

/** Workspace 画面から Site 画面へ */
export async function openSite(page: Page, name: string): Promise<void> {
  await openWorkspace(page);
  await page.getByRole("link", { name }).click();
}

/** Site 画面から実験を作る(Variant A / B が 50:50 で用意される) */
export async function createExperiment(page: Page, experiment: { id: string; name: string }): Promise<void> {
  await page.getByRole("link", { name: "新しいエクスペリエンス" }).click();
  await page.fill('input[name="id"]', experiment.id);
  await page.fill('input[name="name"]', experiment.name);
  await page.fill('input[name="value"]', "/");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`/experiments/${experiment.id}$`));
}

/**
 * Start / Pause / Stop を押し、`POST …/status` の応答(遷移後の Experiment と Publish の結果)を返す。
 *
 * バージョン番号は画面のバナーではなく応答から取る: バナーは `router.refresh()` の到着タイミングに依存する
 * 一過性の表示で、待ち方によっては競合する。応答は決定 17 が定義する契約そのもの(遷移は成功、Publish の可否は
 * `publish.ok`)なので、こちらを正本にする。
 * 「バナーが refresh を跨いで残ること」自体は `a failed publish keeps its alert on screen` が別に固定している
 */
export type StatusResponse = { publish: { ok: boolean; version: number | null; error?: string } };

export async function changeStatus(page: Page, siteId: string, experimentId: string, button: string | RegExp): Promise<StatusResponse> {
  const done = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${siteId}/experiments/${experimentId}/status`) && r.request().method() === "POST");
  // 文字列は完全一致: サイドバーの切替の枠の名前にサイト名が入る(例「E2E Pause Site」が「Pause」に部分一致する)
  await page.getByRole("button", typeof button === "string" ? { name: button, exact: true } : { name: button }).click();
  const res = await done;
  expect(res.status()).toBe(200);
  return (await res.json()) as StatusResponse;
}

/**
 * React のハイドレーションが終わるまで待つ(app/layout.tsx の HydrationMark が <html data-hydrated> を付ける)。
 * `page.reload()` / `page.goto()` の直後、最初の操作(クリック・フォーカス)の前に呼ぶ。SSR の HTML が見えていても
 * onClick / onFocus がまだ付いていないので、待たずに押すと何も起きない(Combo は onFocus でしか開かず、押し直しでは回復しない)。
 * 画面内の遷移(Link のクリック)ではハイドレーション済みのまま。属性は再読み込みのたびに消える
 */
export async function waitForHydration(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "1");
}

/**
 * 見た目をそろえたプルダウン(Picker / Combo)で選ぶ。label は combobox の名前(完全一致)。
 * 選択肢に説明(<small>)が付くと名前が説明まで含むので、そのときは正規表現で渡す。
 * 再読み込み・遷移の直後は先に waitForHydration を呼ぶこと。ここでは一覧が開くまで(開いていなければ)押し直すだけ
 */
export async function pick(scope: Page | Locator, label: string, option: string | RegExp): Promise<void> {
  const combo = scope.getByRole("combobox", { name: label, exact: true });
  const choice = scope.getByRole("option", typeof option === "string" ? { name: option, exact: true } : { name: option });
  await expect(async () => {
    if ((await combo.getAttribute("aria-expanded")) !== "true") await combo.click();
    await expect(choice).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await choice.click();
}
