import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { API_CONTRACT_VERSION, CLIENT_VERSION_HEADER } from "@wtt/core";

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

/**
 * BFF(`/api/control/*`)を画面を通さずに直接叩く E2E の補助が付けるヘッダー(plan12 K3)。
 * 管理画面の JS(lib/client.ts の api())と同じく版を名乗る。名乗らない書き込みは、BFF が版 0 を名乗るので control が 426 にする。
 * `page.evaluate` の中(ブラウザ)では呼べないので、Node 側で呼んだ値を引数で渡す
 */
export function controlHeaders(): Record<string, string> {
  return { [CLIENT_VERSION_HEADER]: String(API_CONTRACT_VERSION) };
}
export const CONTROL_URL = "http://localhost:8799";
export const EDGE_URL = "http://127.0.0.1:8787";
/** 設置タグの配信ファイル(/s/*)を配う場所 = 偽の Cloudflare API(e2e/fake-cf-api.mjs)。本番では配信専用の Worker */
export const STATIC_URL = "http://127.0.0.1:8791";
/**
 * B148: 偽の edge(e2e/fake-edge-ping.mjs)。control の AB_PROBE_ORIGIN_OVERRIDE(playwright.config.ts の --var。AB_E2E_PROBE_OVERRIDE_ENABLED=1 と一緒に置いたときだけ効く)がここを指し、
 * `.test` のドメインの確かめ(/__ab/ping)がここに届く。ポートはほかの E2E の偽のサーバー(8791)・wrangler(8787 / 8799)・admin(3000)と分ける
 */
export const FAKE_EDGE_URL = "http://127.0.0.1:8812";
/**
 * B148: E2E の導入の印(テスト専用の固定値)。global-setup.ts が D1 の instance_settings(install_marker。値は JSON の文字列)と
 * KV の meta:install に置き、偽の edge はその SHA-256 を返す(control の判定が「Cloudflare 経由」になる)
 */
export const E2E_INSTALL_MARKER = "e2e00000-b148-4000-8000-000000000001";

export const SETUP_TOKEN = "e2e-setup-token";
export const AUTH_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";
/** control を「非常用のパスワードログインが開いた状態」で起動するためのテスト用トークン(16 文字以上) */
export const BREAK_GLASS_TOKEN = "e2e-break-glass-token-0123456789";

/**
 * edge に `--var` で渡す訪問者の鍵(RESULTS_VISITOR_KEY。D9 ③ plan ③ の K26)。無いと edge は結果の参加・CV を書かない(fail-closed)。
 * 32 バイトの ASCII("wtt-e2e-admin-results-key-000001")の base64。テスト専用で、本番の鍵ではない
 */
export const E2E_RESULTS_VISITOR_KEY = "d3R0LWUyZS1hZG1pbi1yZXN1bHRzLWtleS0wMDAwMDE=";

/**
 * E2E の状態ディレクトリ(control と edge が `--persist-to` で共有する。global-setup.ts が実行のたびに消して作り直す)
 * と、その中に置く wrangler の dev registry・ログ(D9 ③ Task 17 の修正 1)。
 *
 * control の RESULTS_BUDGET / RESULTS_HEALTH は edge の Durable Object を dev registry 経由で呼ぶ(script_name: "wtt-edge")。
 * 既定の registry はマシン全体で 1 つ(~/Library/Preferences/.wrangler/registry)で、ほかのセッション・worktree の wrangler dev や
 * 強制終了で残った古い登録(wtt-edge など)と混ざる。この実行の wrangler だけが使う registry を状態ディレクトリに置く
 */
export const E2E_STATE_DIR = fileURLToPath(new URL("../../control/.e2e-state", import.meta.url));
export const E2E_REGISTRY_DIR = `${E2E_STATE_DIR}/registry`;
export const e2eLogDir = (name: "control" | "edge" | "admin"): string => `${E2E_STATE_DIR}/logs/${name}`;
/** wrangler の webServer の環境変数(registry とログの置き場所) */
export function e2eWranglerEnv(name: "control" | "edge" | "admin"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, WRANGLER_REGISTRY_PATH: E2E_REGISTRY_DIR, WRANGLER_LOG_PATH: e2eLogDir(name) };
}

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

/** 設置タグの配信ファイルの帯・全サイトの作り直しの確認専用の Site(static-delivery.spec.ts。偽の API を失敗にしてから初めて公開する) */
export const SITE_STATIC = { id: "site_e2e_static", name: "E2E Static Delivery" };

export const EXPERIMENT = { id: "exp_e2e_hero", name: "E2E hero" };
export const EXPERIMENT_PAUSED = { id: "exp_e2e_pause", name: "E2E pause" };
export const EXPERIMENT_FAILED = { id: "exp_e2e_fail", name: "E2E fail" };
/** 公開履歴・Publish 確認画面の相乗り確認(上部バーの副 → 主)専用。下書きのまま残り、以後のテストは触らない */
export const EXPERIMENT_SECOND = { id: "exp_e2e_second", name: "E2E second" };
/** SITE_STATIC の公開に使う実験(BFF から作って開始する) */
export const EXPERIMENT_STATIC = { id: "exp_e2e_static", name: "E2E static" };

/** Variant B に入れる TEXT Change(edge の bootstrap にこの文字列が現れることが DoD 3 の確認になる) */
export const HERO_SELECTOR = ".hero-title";
export const HERO_TEXT = "E2E から書き換え";

/**
 * ログイン。BFF(`/api/session/login`)が HttpOnly Cookie を張り、`/w` に着地するところまでを 1 単位にする。
 *
 * control の無認証 POST(sign-in / setup / 招待受諾)は **経路ごとに** IP 単位で 30 回 / 10 秒(決定 35 (3))。
 * admin BFF は接続元 IP を転送しないので(決定 35 (4))、この E2E のすべての無認証 POST は control からは
 * 同じ IP に見え、経路ごとに 1 枠を共有する(apps/control/src/app.ts)。
 *
 * **テストを足すときはこの予算を数えること。** 現在 1 実行あたり sign-in 43 回(`login(` の呼び出しの実数。publish-flow 10 / audience-flow 10 /
 * version-banner 2 / request-count 3 / experiment-kind-flow 1 / login-screen 1 / results-flow 1 / invite-flow 1 / static-delivery 1 / results-settings 1 /
 * variant-ui 1 / write-freeze 1 / refresh-race 1 / shell-reuse 1 / domains-flow 1 / experiment-save 1 / leave-guard 1 / nav-feedback 1 / busy-scopes 1 / audit-log 1 / images-flow 1 / product-version 1、うち publish-flow の 1 回は非常口の手順 `setOwnerPassword()` の後の初回ログイン)/ setup 1 回 /
 * 招待受諾 7 回(invite-flow 1 / static-delivery 1 / busy-scopes 1 / audit-log 2 / images-flow 1 / product-version 1。`acceptInvite()` は受諾でセッションを得るので、招待されたメンバーの sign-in は数えない)/
 * `break-glass/reset-link` 2 回(publish-flow 1 / audit-log 1)/ `reset-password` 1 回。
 * 1 実行の sign-in の合計(43)は上限(30 回 / 10 秒。`apps/control/wrangler.jsonc` の AUTH_RATE_LIMITER)を超えていて、合計だけでは
 * 10 秒窓に収まるとは言えない。今は `workers: 1` で直列に走り、各 `login()` の間に画面の遷移とテストの操作が入るので、1 つの 10 秒窓に
 * 入る sign-in は合計よりずっと少ない(窓ごとの実数は測っていない)。これ以上ログインを増やすなら、
 * 各テストでログインし直すのをやめて `storageState` でセッションを引き回すこと(ログインの検証は 1 本残せばよい)。
 * API キーの失効の確認(`publish-flow.spec.ts` の "a site without a publish is refused by the edge")は
 * 新しい login() を足さず、既にログイン済みのこのテストに相乗りしている(予算は変わらない)。
 *
 * 決定 46: E2E は Google を呼べないので、control を break-glass を開いた状態(`BREAK_GLASS_TOKEN`)で起動し、
 * 非常用のパスワード欄から入る。**閉じた状態(本番の既定)の画面は E2E では通らない** — 出し分けは
 * `test/login-view.test.ts` / `test/capabilities.test.ts` が固定し、実画面は本番切り替えの確認項目で見る。
 * パスワードのセッションからは API キーを発行できない(B112)。鍵の発行を確かめるテストは、ログインの後に
 * `markSessionsAsGoogle()` で印を書き換える
 */
export async function login(page: Page, email = OWNER_EMAIL, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await waitForHydration(page);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // login() の最後の 1 行: 着地はホーム(/w。参加の数に関わらず自動では移らない。決定 54 (8))
  await expect(page).toHaveURL(/\/w(\/[^/]+)?$/);
}

/** control のディレクトリ(wrangler d1 execute をここで流す。write-freeze.spec.ts と同じ求め方) */
const controlDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../control");

/**
 * B112: その人のセッションを「Google で作った」印に書き換える(control はパスワードのセッションからの API キーの発行を 403 で断る。
 * E2E は Google を呼べないので、パスワードでログインした後に印だけ変えて発行の画面を確かめる)。
 * 動いている wrangler dev と同じ sqlite(--local・E2E の状態ディレクトリ)に書く。write-freeze.spec.ts の d1() と同じ流し方
 */
export function markSessionsAsGoogle(email: string = OWNER_EMAIL): void {
  const sql = `update session set "loginMethod" = 'google' where "userId" = (select id from "user" where email = '${email.replace(/'/g, "''")}')`;
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "wtt-control", "--local", "--persist-to", ".e2e-state", "--command", sql], { cwd: controlDir, stdio: "pipe" });
}

/** 非常口の手順そのもの: reset-link → パスワード設定。以後 login() が使う PASSWORD になる */
export async function setOwnerPassword(request: APIRequestContext): Promise<void> {
  const link = await request.post(`${CONTROL_URL}/break-glass/reset-link`, { data: { token: BREAK_GLASS_TOKEN, email: OWNER_EMAIL } });
  expect(link.status()).toBe(200);
  const token = new URL(((await link.json()) as { url: string }).url).searchParams.get("token");
  // token が無いまま送ると reset-password の 400 で落ち、原因が読みにくい。ここで止めて理由を出す(B23 ⑧)
  expect(token, "break-glass/reset-link の URL に token が無い").toBeTruthy();
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

/**
 * 左メニューの最下部の「設定」を押して設定を開く(B60)。行き先は開いた場所で変わる(サイト = サイト設定の一般、
 * 管理者以上のワークスペース = メンバー、ほか = 個人の API キー)ので、URL ではなく「設定」が選択中になったことを待つ。
 * メインメニューに絞り exact にする(getByRole の name は部分一致で、「サイト設定」などと取り違えないため)。
 *
 * 前提: 設定の外の画面にいること。設定の中では「設定」が最初から選択中なので、押した後の確認が何も確かめずに通ってしまう。
 * それを見落とさないよう、押す前に選択中でないことを確かめる(設定の中で別の画面へ移るときは、設定のメニューの項目を押す)
 */
export async function openSettings(page: Page): Promise<void> {
  const link = page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "設定", exact: true });
  await expect(link, "openSettings は設定の外の画面から呼ぶ").not.toHaveAttribute("aria-current", /.*/);
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

/** WORKSPACE_NAME のメンバーの画面を開く(ワークスペースのトップ →「設定」→ 設定のメニューの「メンバー」)。管理者以上のログインで使う */
export async function openMembers(page: Page): Promise<void> {
  await openWorkspace(page);
  await openSettings(page);
  // exact: 「メンバーの API キー」と区別する
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "メンバー", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/members$/);
}

/**
 * メンバーの画面(`openMembers()` の後)で招待リンクを発行し、その URL を返す(メールは自動送信しないので、画面の結果のカードから拾う。spec §13.3)。
 * 結果のカード(`issued-invite`)は開いたまま返す(カードの見た目・フォーカス・閉じ方は invite-flow.spec.ts が確かめる)。
 * role はロールの選択肢の名前(説明が付くので正規表現。例 `/^編集者/`)。セッションの API なので無認証 POST の予算は使わない
 */
export async function issueInvite(page: Page, email: string, role: RegExp): Promise<string> {
  await page.fill('input[name="email"]', email);
  await pick(page, "ロール", role);
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  const card = page.getByTestId("issued-invite");
  await expect(card.getByRole("heading", { name: "招待リンクを発行しました" })).toBeVisible();
  const url = await card.getByTestId("code-block").textContent();
  expect(url, "招待リンクのカードに URL が無い").toMatch(/\/invite\//);
  return url!;
}

/**
 * 未ログインの別のコンテキストで招待を受け、パスワードでアカウントを作って参加する(ワークスペースの画面に着くまで)。
 * 受諾がセッションを張るので、このコンテキストはログイン済みになる(sign-in の予算は使わず、招待受諾の予算を 1 回使う)。
 * 閉じるのは呼ぶ側(`ctx.close()`)
 */
export async function acceptInvite(browser: Browser, url: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: ADMIN_URL });
  const page = await ctx.newPage();
  await page.goto(url);
  // break-glass が開いているので非常用のパスワードフォームも出る。まず通常経路(Google)の導線を確認する
  await expect(page.getByRole("link", { name: "Google でログインして参加" })).toHaveAttribute("href", /\/api\/session\/google\?next=%2Finvite%2F/);
  await waitForHydration(page);
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="password"]', PASSWORD);
  await page.getByRole("button", { name: "参加する" }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  return { ctx, page };
}

/**
 * ログイン後の Workspace 画面から Site を作る(名前 / ドメイン / Site ID を指定)。
 *
 * D9 ③: E2E の control には計測用のデータベース(RESULTS_DB)があるので、新しい Site は結果を記録する設定で作られる
 * (= テストの開始に判定に使う目標が要る)。結果を扱わない spec の Site はこれまでどおり記録しない設定にそろえる
 * (`results: false` が既定。作成の直後に BFF 経由で `resultsEnabled: false` を保存する)。
 * 結果を扱う spec(results-flow / results-settings)は `results: true` で作る
 */
export async function createSite(page: Page, site: { id: string; name: string }, opts: { results?: boolean } = {}): Promise<void> {
  await openWorkspace(page);
  // 作成フォームは「新しいサイト」で開く(Site が 1 つも無いときは最初から開いている)
  const nameInput = page.locator('input[name="name"]');
  if (!(await nameInput.isVisible())) await page.getByRole("button", { name: "新しいサイト" }).click();
  await page.fill('input[name="name"]', site.name);
  await page.fill('input[name="domain"]', "localhost");
  await page.fill('input[name="id"]', site.id);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`/sites/${site.id}$`));
  // SITE ナビが出ている = Site 一覧が更新された(最下部の「設定」はどこにでもあるので、サイトの印にならない。サイトのメニューの項目を見る)
  await expect(page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "エクスペリエンス", exact: true })).toBeVisible();
  if (opts.results !== true) {
    const status = await page.evaluate(async ([id, h]) => {
      const r = await fetch(`/api/control/sites/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ resultsEnabled: false }) });
      return r.status;
    }, [site.id, controlHeaders()] as const);
    expect(status).toBe(200);
    // 画面(Site の設定・開始の確認)が新しい値を読むように、読み直す
    await page.reload();
    await waitForHydration(page);
  }
}

/** Workspace 画面から Site 画面へ */
export async function openSite(page: Page, name: string): Promise<void> {
  await openWorkspace(page);
  await page.getByRole("link", { name }).click();
}

/** Site 画面から実験を作る(A パターン(オリジナル)/ B パターンが 50:50 で用意される。B77) */
export async function createExperiment(page: Page, experiment: { id: string; name: string }): Promise<void> {
  await page.getByRole("link", { name: "新しいエクスペリエンス" }).click();
  await page.fill('input[name="id"]', experiment.id);
  await page.fill('input[name="name"]', experiment.name);
  await page.fill('input[name="value"]', "/");
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(new RegExp(`/experiments/${experiment.id}$`));
  // 作成の後は全画面の遷移(ExperimentCreateForm)なので、続けて入力する前にハイドレーションを待つ
  // (本文は loading.tsx の境界の中で外枠より後にハイドレーションされ、その前の入力は React に届かない)
  await waitForHydration(page);
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
  // 押す前から出ている知らせ(前の操作の「公開 vN を反映しました」など)は、押した後の止めと区別するために控える
  const before = new Set(await appAlert(page).allTextContents());
  // 文字列は完全一致: サイドバーの切替の枠の名前にサイト名が入る(例「E2E Pause Site」が「Pause」に部分一致する)
  await page.getByRole("button", typeof button === "string" ? { name: button, exact: true } : { name: button }).click();
  // D9 ③: 下書きのテストの開始は必ず確認のモーダルを出す(結果を記録しない Site では「開始しますか?」と記録しない文)。
  // パーソナライズの開始・再開は重なりが無ければ確認を出さないので、要求とモーダルのどちらが先に来るかで分ける(一時停止は必ず確認する。B107)。
  // 画面が要求を送らずに止めたとき(評価計画の目標が無い開始など。新しい role="alert" が出る)は、60 秒待たずに名前の付いたエラーで落とす
  const dialog = page.getByRole("alertdialog", { name: /^(開始|再開|一時停止)/ });
  const first = await firstOf(page, done, dialog, before);
  if (first.kind === "dialog") {
    await dialog.getByRole("button", { name: /^(開始|再開|一時停止)する$/ }).press("Enter");
    const second = await firstOf(page, done, null, before);
    if (second.kind === "alert") throw new Error(`changeStatus: the screen stopped after the confirmation without sending the status request: ${second.text}`);
  } else if (first.kind === "alert") {
    throw new Error(`changeStatus: the screen stopped without sending the status request: ${first.text}`);
  }
  const res = await done;
  expect(res.status()).toBe(200);
  // B173 第 2 段: 最後の確認は読み直しの反映まで開いたまま(中を「開始中…」などで覆う)。続けて画面を触る呼び出し元のため、閉じるまで待つ
  if (first.kind === "dialog") await expect(dialog).toBeHidden({ timeout: 15_000 });
  return (await res.json()) as StatusResponse;
}

/** 状態の要求・確認のモーダル・新しい知らせ(押す前に無かった role="alert")のうち、先に来たもの。どれも 15 秒来なければ要求を待つ */
async function firstOf(
  page: Page,
  done: Promise<unknown>,
  dialog: Locator | null,
  before: ReadonlySet<string>,
): Promise<{ kind: "sent" } | { kind: "dialog" } | { kind: "alert"; text: string } | { kind: "none" }> {
  let settled = false;
  const newAlert = (async () => {
    const until = Date.now() + 15_000;
    while (!settled && Date.now() < until) {
      const text = (await appAlert(page).allTextContents().catch(() => [] as string[])).find((t) => t.trim() !== "" && !before.has(t));
      if (text !== undefined) return { kind: "alert" as const, text };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { kind: "none" as const };
  })();
  const racers: Array<Promise<{ kind: "sent" } | { kind: "dialog" } | { kind: "alert"; text: string } | { kind: "none" }>> = [
    done.then(() => ({ kind: "sent" as const })),
    newAlert,
  ];
  if (dialog) racers.push(dialog.waitFor({ timeout: 15_000 }).then(() => ({ kind: "dialog" as const }), () => ({ kind: "none" as const })));
  try {
    // 要求が先に来たら(成功の知らせはその後に描かれる)知らせは見ない
    return await Promise.race(racers);
  } finally {
    settled = true;
  }
}

/**
 * React のハイドレーションが終わるまで待つ(app/layout.tsx の HydrationMark が <html data-hydrated> を付ける)。
 * `page.reload()` / `page.goto()` の直後、最初の操作(クリック・フォーカス)の前に呼ぶ。SSR の HTML が見えていても
 * onClick / onFocus がまだ付いていないので、待たずに押すと何も起きない(Combo は onFocus でしか開かず、押し直しでは回復しない)。
 * 画面内の遷移(Link のクリック)ではハイドレーション済みのまま。属性は再読み込みのたびに消える
 */
export async function waitForHydration(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "1");
  // 本文のハイドレーションも待つ: 画面のフォルダの loading.tsx があると本文は Suspense の境界の中にあり、React は外枠を先にハイドレーションして
  // (HydrationMark の effect はここで走る)、境界の中は後の別の処理で行う。その間の本文は onClick が付いていない。
  // React はハイドレーションした要素に `__reactFiber$…` のプロパティを付けるので、<main> の中の要素すべてに付くまで待つ。
  // dangerouslySetInnerHTML で入れた中身(ヘルプの本文など)には付かないので、その下は見ない。<main> の無い画面(ログインなど)は見ない
  await page.waitForFunction(() => {
    const has = (el: Element, prefix: string) => Object.keys(el).find((k) => k.startsWith(prefix));
    const insideRawHtml = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const key = has(p, "__reactProps$");
        if (key && (p as unknown as Record<string, { dangerouslySetInnerHTML?: unknown }>)[key]?.dangerouslySetInnerHTML) return true;
      }
      return false;
    };
    return [...document.querySelectorAll("main, main *")].every((el) => has(el, "__reactFiber$") || insideRawHtml(el));
  });
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

/**
 * D9 ③(設計書 §5.5): 実行中・一時停止中のテストの変更(Change・対象 URL・配信条件)を保存するときの確認を通す。
 * 「保存(下書き)」を押した直後に呼ぶ
 */
export async function confirmRunningTestSave(page: Page): Promise<void> {
  await page.getByRole("alertdialog", { name: "実行中のテストを変更しますか?" }).getByRole("button", { name: "保存する", exact: true }).press("Enter");
}

// ---- B68: サイトの画像のライブラリ(images-flow.spec.ts) ----

/**
 * 1x1 の PNG(テスト専用の固定値)。control はアップロードで宣言の形式と先頭のバイトの両方を確かめるので、本物の PNG のバイト列を使う。
 * 同じ中身を何度上げてもよい(画像は ID と名前で別の行になる)
 */
export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** `setInputFiles` に渡す 1 枚 */
export const pngFile = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") });

/** アップロードの 201 のうち、テストが使う分 */
export type UploadedImage = { id: string; name: string; publicUrl: string; renamedFrom?: string };

/**
 * 画面を通さずに BFF でサイトに画像を 1 枚上げる(`POST /api/control/sites/:sid/assets`。multipart で file と name)。
 * name を省くと control がファイル名から名前を作る(重なれば番号を付ける)
 */
export async function uploadImage(page: Page, siteId: string, opts: { fileName?: string; name?: string } = {}): Promise<UploadedImage> {
  const fileName = opts.fileName ?? "image.png";
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = { file: pngFile(fileName) };
  if (opts.name !== undefined) multipart.name = opts.name;
  const res = await page.request.post(`/api/control/sites/${siteId}/assets`, { headers: controlHeaders(), multipart });
  expect(res.status(), `画像のアップロード(${fileName})が 201`).toBe(201);
  return (await res.json()) as UploadedImage;
}

/**
 * パターンの変更を IMAGE の変更だけにする fixture(srcs = 画像の公開 URL。空配列 = IMAGE の変更が 0 のパターン)。
 * B77: 作成の既定で a はオリジナル(変更を送れない)なので、既定は b に置く。セレクタは変更ごとに別の img にする
 */
export async function putImageChanges(page: Page, siteId: string, experimentId: string, srcs: string[], variantId = "b"): Promise<void> {
  const changes = srcs.map((src, i) => ({ id: `c_img${i}`, type: "IMAGE", selector: `img.e2e-img-${i}`, payload: { src } }));
  const res = await page.request.put(`/api/control/sites/${siteId}/experiments/${experimentId}/variants/${variantId}/changes`, { headers: controlHeaders(), data: changes });
  expect(res.status(), `IMAGE の変更 ${srcs.length} 件の保存が 200`).toBe(200);
}

/**
 * 動いている wrangler dev と同じ sqlite(E2E の状態ディレクトリ)に SQL を流す。Cron を待たずに画像の行の状態
 * (消す途中の印・Cron が戻した時刻・公開したときの定義の使い方)を作るために使う。markSessionsAsGoogle と同じ流し方
 */
export function d1Local(sql: string): void {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "wtt-control", "--local", "--persist-to", ".e2e-state", "--command", sql], { cwd: controlDir, stdio: "pipe" });
}

/**
 * ファイルのドラッグ&ドロップ(dragenter → dragover → drop)を target に送る。DataTransfer に File を入れるので types は ["Files"] になる。
 * target = null なら <main>(一覧の画面の DropOverlay は window で受ける)。IMAGE の欄・選ぶ窓は React の要素の handler なので、その要素に送る
 */
export async function dropImages(page: Page, target: Locator | null, names: string[]): Promise<void> {
  await (target ?? page.locator("main")).evaluate(
    (node, [b64, files]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      for (const n of files) dt.items.add(new File([bytes], n, { type: "image/png" }));
      for (const type of ["dragenter", "dragover", "drop"]) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    [PNG_1X1_BASE64, names] as const,
  );
}
