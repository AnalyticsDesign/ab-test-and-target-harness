import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  ADMIN_URL,
  EXPERIMENT_STATIC,
  SITE_STATIC,
  STATIC_URL,
  acceptInvite,
  controlHeaders,
  issueInvite,
  login,
  openMembers,
  openSettings,
  waitForHydration,
} from "./fixtures";

/**
 * 7o K14: 設置タグの配信ファイルの帯(システム管理者だけ)と、設定 > システム > 配信ファイル の画面の全サイトの作り直し。
 * 偽の Cloudflare API(e2e/fake-cf-api.mjs)の `POST /__e2e/fail` でアップロードの準備を 503 Authentication error にし、
 * トークンの問題で配置が止まった状態を作る。終わりに必ず `on: false` に戻す(後の project の配置を止めない。
 * テストの時間切れでは finally が走らないので、afterEach でも戻す)。
 *
 * 帯が状態を取り直すのはマウント時・5 分ごと・タブが前に戻ったときだけで、クライアントの画面遷移では共有の layout が残って取り直さない。
 * なので確かめるたびに `page.goto` / `page.reload()` で読み直す。
 * ログインはオーナーの 1 回だけ(メンバーは招待の受諾でセッションを得る。sign-in の予算は fixtures.ts の login() のコメント)
 */

const MEMBER = { email: "static-viewer@e2e.example", name: "Sv" };
const STATUS_PATH = "/api/control/static/status";

/** 偽の API のアップロードの準備を失敗させる / 戻す */
async function setFakeApiFailing(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.post(`${STATIC_URL}/__e2e/fail`, { data: { on } });
  expect(res.status(), "偽の API の失敗の切り替え").toBe(200);
}

/** 動いている wrangler dev と同じ sqlite に SQL を流す(write-freeze.spec.ts の d1() と同じ流し方) */
const controlDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../control");
const d1 = (sql: string) =>
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "wtt-control", "--local", "--persist-to", ".e2e-state", "--command", sql], { cwd: controlDir, stdio: "pipe" });

/** 表「配置の状態」のその項目の「状態」の列 */
const stateCell = (page: Page, label: string) =>
  page
    .getByTestId("static-health-table")
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: label, exact: true }) })
    .getByRole("cell")
    .nth(1);

test.afterEach(async ({ request }) => {
  await setFakeApiFailing(request, false);
});

test("instance admins see the static delivery banner while deploys fail, members do not, and the rebuild of all sites clears it", async ({ browser, page, request }) => {
  test.setTimeout(150_000);
  await login(page);

  // メンバー(閲覧者)を招待して入れておく(失敗のあいだの確認に使う。受諾したコンテキストはログイン済み)
  await openMembers(page);
  const wid = new URL(page.url()).pathname.split("/")[2]!;
  const inviteUrl = await issueInvite(page, MEMBER.email, /^閲覧者/);
  const { ctx: memberCtx, page: member } = await acceptInvite(browser, inviteUrl, MEMBER.name);

  try {
    // 専用の Site と実験を BFF から作る(結果を記録しない設定にしてから開始する。fixtures.ts の createSite と同じ)。
    // 初めての公開なので配信ファイルの中身が変わり、配置は必ず偽の API を呼ぶ(前回と同じ中身なら API を呼ばずに済ませるため、既存の Site では失敗を起こせない)
    const ctl = (method: "POST" | "PATCH", path: string, data: unknown) => page.request.fetch(`${ADMIN_URL}/api/control${path}`, { method, headers: controlHeaders(), data });
    expect((await ctl("POST", `/workspaces/${wid}/sites`, { name: SITE_STATIC.name, domain: "static.e2e-static.example", id: SITE_STATIC.id })).status()).toBe(201); // B139: 他の spec のサイトと登録ドメインを分ける(同じ登録ドメインだと作成で訪問者 ID の Cookie 名が自動で変わる)
    expect((await ctl("PATCH", `/sites/${SITE_STATIC.id}`, { resultsEnabled: false })).status()).toBe(200);
    expect((await ctl("POST", `/sites/${SITE_STATIC.id}/experiments`, { ...EXPERIMENT_STATIC, urlMatch: { op: "contains", value: "/" } })).status()).toBe(201);

    // 偽の API を失敗にして公開する → 配置は失敗し、公開そのものは成功して配信ファイルの更新は pending
    await setFakeApiFailing(request, true);
    const started = await ctl("POST", `/sites/${SITE_STATIC.id}/experiments/${EXPERIMENT_STATIC.id}/status`, { status: "running" });
    expect(started.status()).toBe(200);
    expect(await started.json()).toMatchObject({ publish: { ok: true, staticDeploy: "pending" } });

    // システム管理者(初回セットアップのオーナー)には帯が出る。読み直して取らせる
    await page.goto("/w");
    const banner = page.getByTestId("static-health-banner");
    await expect(banner).toContainText("設置タグの配信ファイルの更新が止まっています(最後のエラー: ", { timeout: 15_000 });
    await expect(banner).toContainText("Authentication error");

    // システム管理者でないメンバーには、失敗のあいだでも帯が出ない(読み直しても)。帯の部品そのものが無いので状態の GET も送らない
    const memberStatusRequests: string[] = [];
    member.on("request", (r) => {
      if (new URL(r.url()).pathname === STATUS_PATH) memberStatusRequests.push(r.url());
    });
    await member.goto(`/w/${wid}`);
    await waitForHydration(member);
    await member.waitForLoadState("networkidle");
    await expect(member.getByTestId("static-health-banner")).toHaveCount(0);
    expect(memberStatusRequests).toEqual([]);
    // 設定のメニューに「配信ファイル」(システムの節)が無い
    await openSettings(member);
    const memberNav = member.getByRole("navigation", { name: "メインメニュー" });
    await expect(memberNav.getByRole("link", { name: "API キー", exact: true })).toBeVisible(); // 設定のメニューが描かれている
    await expect(memberNav.getByRole("link", { name: "配信ファイル" })).toHaveCount(0);
    await expect(memberNav.getByRole("link", { name: "システム管理者" })).toHaveCount(0);
    // 画面を直接開いても、API を直接叩いても見えない
    expect((await member.request.get(STATUS_PATH, { headers: controlHeaders() })).status()).toBe(403);
    await member.goto("/w/me/static-delivery");
    await expect(member.getByText("この画面はシステム管理者だけが開けます")).toBeVisible();
    await expect(member.getByTestId("static-health-banner")).toHaveCount(0);

    // サイトの警告帯の 3 つ目の文言(記録の食い違い)。データベースを過去の時点に戻した後と同じ状態を、この Site の世代を 1 つ戻して作る
    // (デプロイ専用の Worker が受け付けた世代の方が新しくなる)。この後の全サイトの作り直しが直す
    d1(`update sites set static_seq = static_seq - 1, static_stale = 1 where id = '${SITE_STATIC.id}'`);
    await page.goto(`/w/${wid}/sites/${SITE_STATIC.id}`);
    await expect(page.getByTestId("static-stale")).toContainText("このサイトの配信ファイルの記録が食い違っています");

    // 帯の「状態を見る」→ 配信ファイルの画面。表の「最後のエラー」は失敗中(エラーの本文付き)
    await expect(banner).toContainText("更新が止まっています", { timeout: 15_000 });
    await banner.getByRole("link", { name: "状態を見る" }).click();
    await expect(page).toHaveURL(/\/w\/me\/static-delivery$/);
    await expect(page.getByRole("heading", { name: "配信ファイル", level: 1 })).toBeVisible();
    // システム管理者の設定のメニューには「配信ファイル」があり、今の画面として選ばれている(メンバーに無いことの対照)
    await expect(page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "配信ファイル" })).toHaveAttribute("aria-current", "page");
    // この画面では帯に「状態を見る」を出さない
    await expect(banner.getByRole("link", { name: "状態を見る" })).toHaveCount(0);
    await expect(stateCell(page, "最後のエラー")).toContainText("失敗中");
    await expect(stateCell(page, "最後のエラー")).toContainText("Authentication error");
    await expect(stateCell(page, "記録が食い違っているサイト")).toContainText(/\d+ サイト/);

    // 偽の API を戻して、公開中の全サイトの配信ファイルを作り直す
    await setFakeApiFailing(request, false);
    await waitForHydration(page);
    await page.getByTestId("static-rebuild").getByRole("button", { name: "公開中の全サイトの配信ファイルを作り直す", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "公開中の全サイトの配信ファイルを作り直しますか" });
    await expect(dialog).toContainText(/公開中の全サイト\(\d+ サイト\)の配信ファイルを、今の公開内容で作り直します/);
    await dialog.getByRole("button", { name: "作り直す", exact: true }).click();
    const result = page.getByTestId("static-rebuild-result");
    await expect(result.getByRole("heading", { name: "作り直しを受け付けました" })).toBeFocused();
    await expect(result).toContainText(/公開中の \d+ サイトの配信ファイルの作り直しを受け付けました/);
    await expect(result).not.toContainText("受け付けられませんでした");
    await expect(result).not.toContainText("公開履歴が無いため");

    // 配置は flush: "soon" の 1 秒後。表はサーバーの描画で読むので、読み直して「最後のエラー」「記録の食い違い」が「なし」になるまで待つ
    await expect
      .poll(
        async () => {
          await page.reload();
          return [(await stateCell(page, "最後のエラー").textContent())?.trim(), (await stateCell(page, "記録が食い違っているサイト").textContent())?.trim()];
        },
        { timeout: 30_000, intervals: [1_000, 2_000] },
      )
      .toEqual(["なし", "なし"]);
    // 帯はクライアントで取るので、読み直した後の帯の状態の GET の応答とハイドレーションを待ってから、出ていないことを見る
    const fetched = page.waitForResponse((r) => new URL(r.url()).pathname === STATUS_PATH && r.status() === 200);
    await page.reload();
    await fetched;
    await waitForHydration(page);
    await expect(banner).toHaveCount(0);
    // サイトの警告帯も消える(Site の GET の自己修復が、配り終えた世代を確かめて印を下ろす)
    await expect
      .poll(
        async () => {
          await page.goto(`/w/${wid}/sites/${SITE_STATIC.id}`);
          return page.getByTestId("static-stale").count();
        },
        { timeout: 20_000, intervals: [1_000, 2_000] },
      )
      .toBe(0);
  } finally {
    await setFakeApiFailing(request, false);
    await memberCtx.close();
  }
});
