import { test, expect, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import {
  ADMIN_URL,
  CONTROL_URL,
  controlHeaders,
  STATIC_URL,
  EXPERIMENT,
  EXPERIMENT_FAILED,
  EXPERIMENT_PAUSED,
  EXPERIMENT_SECOND,
  HERO_SELECTOR,
  HERO_TEXT,
  OWNER_EMAIL,
  OWNER_NAME,
  pick,
  waitForHydration,
  SETUP_TOKEN,
  SITE,
  SITE_FAILED,
  SITE_PAGE_MATCH,
  SITE_PAUSED,
  SITE_UNPUBLISHED,
  WORKSPACE_NAME,
  appAlert,
  changeStatus,
  confirmRunningTestSave,
  createExperiment,
  createSite,
  login,
  markSessionsAsGoogle,
  openSettings,
  openSite,
  openWorkspace,
  setOwnerPassword,
} from "./fixtures";
import type { PublishRow } from "../lib/types";

/**
 * 初回セットアップから「control の Publish が edge の bootstrap に現れる」までを実際のブラウザで通す。
 * 直列(describe.serial)で、前のテストが作った Workspace / Site / 実験に後のテストが乗る。
 */
test.describe.serial("setup → site → experiment → start → edge bootstrap", () => {
  test("owner setup finishes without a password; the emergency path signs in", async ({ page }) => {
    await page.goto("/setup");
    await page.fill('input[name="setupToken"]', SETUP_TOKEN);
    await page.fill('input[name="workspaceName"]', WORKSPACE_NAME);
    await page.fill('input[name="name"]', OWNER_NAME);
    await page.fill('input[name="email"]', OWNER_EMAIL);
    // 使用状況を見られる人(backlog D10 K7)。既定は「すべてのメンバー」が選択済み
    await expect(page.getByRole("radio", { name: /すべてのメンバー/ })).toBeChecked();
    await page.click('button[type="submit"]');
    await expect(page.getByRole("heading", { name: "セットアップが完了しました" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Google でログイン" })).toHaveAttribute("href", "/api/session/google");

    // E2E は Google を呼べないので、非常口(break-glass のパスワード再設定)からログインする
    await setOwnerPassword(page.request);
    await login(page);

    // ホームの使用状況(backlog D10 K5)。E2E の control は Cloudflare のトークンを持たないので「未設定」の案内が出る。
    // システム管理者には設定の 1 行と変更へのリンクが出る
    const summary = page.getByTestId("usage-summary");
    await expect(summary).toContainText("見られる人: すべてのメンバー · プラン: Free");
    await expect(summary).toContainText("使用状況の取得が設定されていません");
    await summary.getByRole("link", { name: "変更" }).click();
    await expect(page).toHaveURL(/\/w\/me\/usage$/);
    await waitForHydration(page);
    // B186: Free では見出しごと隠す。入力中・保存後とも、Paid に戻すと以前の比較の値を使う。
    // 既存のログイン済みの流れで true/false を確かめ、新しい sign-in は増やさない。
    const settings = page.getByTestId("usage-settings");
    const comparison = settings.getByRole("checkbox", { name: /月額 \$5 に含まれる量と比べる/ });
    const expectFree = async () => {
      await expect(settings.getByRole("radio", { name: /^Free/ })).toBeChecked();
      await expect(settings.getByText("Paid の比較", { exact: true })).toHaveCount(0);
      await expect(comparison).toHaveCount(0);
    };
    await expectFree();
    for (const checked of [false, true]) {
      await test.step(`Paid の比較を ${checked} にして Free でも保持する`, async () => {
        await settings.getByRole("radio", { name: /^Paid/ }).check();
        await expect(comparison).toBeEnabled();
        await comparison.setChecked(checked);
        // 保存前の往復でも選択を失わない。
        await settings.getByRole("radio", { name: /^Free/ }).check();
        await expectFree();
        await settings.getByRole("radio", { name: /^Paid/ }).check();
        await expect(comparison).toBeChecked({ checked });
        await settings.getByRole("button", { name: "保存" }).click();
        await expect(settings.getByRole("status")).toHaveText("保存しました");
        await page.reload();
        await waitForHydration(page);
        await expect(comparison).toBeChecked({ checked });

        await settings.getByRole("radio", { name: /^Free/ }).check();
        const sent = page.waitForRequest((r) => r.method() === "PATCH" && new URL(r.url()).pathname === "/api/control/usage/settings");
        await settings.getByRole("button", { name: "保存" }).click();
        expect((await sent).postDataJSON()).toEqual({ usageVisibility: "members", cloudflarePlan: "free", showPaidReference: checked });
        await expect(settings.getByRole("status")).toHaveText("保存しました");
        await page.reload();
        await waitForHydration(page);
        await expectFree();
        await settings.getByRole("radio", { name: /^Paid/ }).check();
        await expect(comparison).toBeChecked({ checked });
        await settings.getByRole("radio", { name: /^Free/ }).check();
        await expectFree();
      });
    }
    await expect(page.getByTestId("usage-unavailable")).toContainText("CF_USAGE_TOKEN");
    await page.goto("/w");
    await openWorkspace(page);

    // 画面表示(決定 54 (7)・B60): ワークスペースのトップから左メニューの最下部の「設定」→ 設定のメニューの「API キー」→「画面表示」。
    // ダークを選ぶ → 再読み込み後も残る → システムに戻す。
    // 管理者以上がワークスペースから開くと、設定のメニューの先頭(メンバー)に着く
    await openSettings(page);
    await expect(page).toHaveURL(/\/w\/[^/]+\/members$/);
    // exact: 「メンバーの API キー」と区別する
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "API キー", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/me\/api-keys$/);
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "画面表示" }).click();
    await expect(page).toHaveURL(/\/w\/me\/display$/);
    await waitForHydration(page);
    await page.getByRole("radio", { name: "ダーク" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // 初期描画は「システムに合わせる」が選択中(サーバーの描画)。ハイドレーション後に保存値(ダーク)へ切り替わるのを待ってから戻す
    // (待たずに check すると、サーバーの描画で既に選択中のラジオに当たって何も起きない)
    await waitForHydration(page);
    await expect(page.getByRole("radio", { name: "ダーク" })).toBeChecked();
    await page.getByRole("radio", { name: "システムに合わせる" }).check();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("a site without a publish is refused by the edge", async ({ page }) => {
    await login(page);
    await createSite(page, SITE);
    await createSite(page, SITE_UNPUBLISHED);
    // settings record は Site 作成で KV に書かれるが config はまだ無いので bootstrap は 404(spec §9.4 fail-closed)。
    // 未公開の確認を `SITE` ではなく専用の Site で行うのは、edge が 404(= settings / active の null)も
    // 60 秒 isolate キャッシュに載せるため。`SITE` に対して先に 404 を取ると、直後の Publish が同じ 60 秒に隠れる
    expect((await fetch(`${STATIC_URL}/s/${SITE_UNPUBLISHED.id}.js`)).status).toBe(404);

    // Plan 10 B1: サイト一覧の「サイト ID」列、パンくずのラベル、サイト設定の「分析(外部 ID)」節(サインイン予算を増やさないためこのテストに相乗り)
    await openWorkspace(page);
    // B35: ホーム → ワークスペース(上の openWorkspace)→ 切替の検索でサイトへ。サインイン予算を増やさないためこのテストに相乗り
    const nav = page.getByRole("navigation", { name: "メインメニュー" });
    await waitForHydration(page); // 切替の枠は React の onClick で開く(ホームのカードのリンクが全画面の遷移だった場合に備える)
    await nav.getByRole("button", { name: /^ワークスペースとサイトの切り替え/ }).click();
    const switcher = page.getByRole("dialog", { name: "ワークスペースとサイトの切り替え" });
    await switcher.getByRole("textbox", { name: "ワークスペース・サイトを検索" }).fill(SITE_UNPUBLISHED.id);
    await switcher.getByRole("link", { name: new RegExp(SITE_UNPUBLISHED.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}$`));
    await expect(switcher).toHaveCount(0); // 移ったら閉じる
    await page.keyboard.press("Escape");
    // B60: 一度も公開していないサイトの版の札は「未公開」(緑の点なし)。開くと「まだ公開していません」
    {
      const chip = page.getByTestId("version-chip");
      await expect(chip).toHaveAccessibleName("未公開。公開履歴を開く");
      await expect(chip).toHaveText("未公開");
      await chip.click();
      const recent = page.getByTestId("version-popover");
      await expect(recent).toHaveAccessibleName("直近の公開");
      await expect(recent).toContainText("まだ公開していません");
      await expect(recent.getByRole("link", { name: "すべての公開履歴 →" })).toHaveAttribute("href", new RegExp(`/sites/${SITE_UNPUBLISHED.id}/history$`));
      await page.keyboard.press("Escape");
      await expect(recent).toHaveCount(0);
      await expect(chip).toBeFocused(); // Esc は札へフォーカスを戻す
    }
    // 2 列: 左 = ワークスペース、右 = サイト。「一覧」はホーム / サイト一覧へ
    await nav.getByRole("button", { name: /^ワークスペースとサイトの切り替え/ }).click();
    await expect(switcher.getByRole("link", { name: "ワークスペース一覧" })).toHaveAttribute("href", "/w");
    await switcher.getByRole("link", { name: "サイト一覧" }).click();
    await expect(page).toHaveURL(/\/w\/[^/]+$/);
    await expect(page.getByRole("columnheader", { name: "サイト ID" })).toBeVisible();
    await expect(page.getByRole("cell", { name: SITE.id, exact: true })).toBeVisible();
    await page.getByRole("link", { name: SITE.name }).click();
    await expect(page.getByText(`サイト ID: ${SITE.id}`)).toBeVisible(); // パンくずのラベル
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "primary"); // 一度も公開していないサイトは、作成直後から「未公開の編集あり」
    // 最下部の「設定」。サイトから開くとサイト設定の一般へ
    await openSettings(page);
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}/settings$`));
    // B35 / r1 CX-Medium-1・r2 CX-Medium-1: プルダウンを 1 つだけ変えても「未保存の変更あり」になり、保存して再読み込みしても残る。
    // 1 つずつ、変更の無い状態から確かめる(先に別の欄を変えて dirty にしておくと、確かめたい欄の setDirty が欠けても通ってしまう)
    const saveState = page.getByTestId("save-state");
    const saveAndReload = async () => {
      await page.getByRole("button", { name: "保存" }).click();
      await expect(page.getByText("保存しました")).toBeVisible();
      await page.reload();
      await waitForHydration(page); // 以降の最初の操作(Picker / Combo のクリック・節の切替)は、ハイドレーションの後でないと効かない
      await expect(saveState).toHaveText("変更はありません");
    };
    const tzCombo = () => page.getByRole("combobox", { name: "タイムゾーン", exact: true });
    // 検索語を打たずに候補を選ぶ経路(Combo は onFocus で開く)
    const chooseTz = (tz: string) => pick(page, "タイムゾーン", tz);
    // (1) 同意の扱い(一般の節)
    await expect(saveState).toHaveText("変更はありません");
    await pick(page, "同意の扱い", /^訪問者が同意するまで/);
    await expect(saveState).toHaveText("未保存の変更あり");
    await saveAndReload();
    await expect(page.getByRole("combobox", { name: "同意の扱い", exact: true })).toContainText("訪問者が同意するまで");
    await pick(page, "同意の扱い", /^同意を待たずに/); // 後続のテストが既定に頼るので戻す
    await saveAndReload();
    // (2) タイムゾーン(一般の節。Combo)。候補は Intl.supportedValuesOf("timeZone") と今の値なので、UTC は無い(r2 で実測)
    await chooseTz("America/New_York");
    await expect(saveState).toHaveText("未保存の変更あり");
    await saveAndReload();
    await expect(tzCombo()).toHaveValue("America/New_York");
    await chooseTz("Asia/Tokyo");
    await saveAndReload();
    // (3) Deployment Mode(ドメインの節。B148)。Mode B の保存はドメインを確かめに行くので保存はせず、dirty になることと、再読み込みで捨てられることだけを見る
    // (Mode B の保存と判定は domains-flow.spec.ts)
    await page.getByTestId("section-domains").click();
    await expect(saveState).toHaveText("変更はありません");
    await pick(page, "導入の形", /^B: サーバー発行 Cookie/);
    await expect(saveState).toHaveText("未保存の変更あり");
    // B60: 未保存のまま再読み込みすると beforeunload の確認が出る(受けないと再読み込みが止まる)。受けて捨てる
    page.once("dialog", (d) => void d.accept());
    await page.reload();
    await waitForHydration(page); // 次の節の切替(React の onClick)の前に
    await expect(page.getByRole("combobox", { name: "導入の形", exact: true })).toContainText("A: JS Cookie");
    // 外部 ID は「設定」のサブメニューの節にある(相乗りで確認)
    await page.getByTestId("section-external").click();
    await page.fill('input[name="ga4PropertyId"]', "123456789");
    await page.fill('input[name="bigqueryDataset"]', "my-project.analytics_123456789");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await page.reload();
    await waitForHydration(page); // 以降の fill / クリックはハイドレーションの後でないと効かない(下の toHaveValue はサーバーの描画でも通る)
    // 節の選択は URL(?section=external)に残るので、reload 後も同じ節が開いたまま
    await expect(page.locator('input[name="ga4PropertyId"]')).toHaveValue("123456789");
    await expect(page.locator('input[name="bigqueryDataset"]')).toHaveValue("my-project.analytics_123456789");
    // 空にして保存 = null で解除(control の nullable)
    await page.fill('input[name="ga4PropertyId"]', "");
    await page.fill('input[name="bigqueryDataset"]', "");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await page.reload();
    await waitForHydration(page);
    await expect(page.locator('input[name="ga4PropertyId"]')).toHaveValue("");
    await expect(page.locator('input[name="bigqueryDataset"]')).toHaveValue(""); // 2 項目とも解除される(r2 CX-Low-2)

    // 導入タグ: フォームの外。コピー用のコード枠に Site ID が入っている
    await page.getByTestId("section-tag").click();
    await expect(page.getByTestId("code-block")).toContainText(`/s/${SITE.id}.js`);
    // B60 B123: モードとドメインの横のリンクで、変える節へ移る(同じ画面のまま URL の ?section= が変わる)。
    // B148: 導入の形とドメインの一覧はドメインの節に移った(「ドメインで変える」の行き先)
    await page.getByRole("link", { name: "訪問者 ID で変える" }).click();
    await expect(page).toHaveURL(/[?&]section=identity/);
    await expect(page.locator('input[name="visitorCookieName"]')).toBeVisible();
    await page.getByTestId("section-tag").click();
    await page.getByRole("link", { name: "ドメインで変える" }).click();
    await expect(page).toHaveURL(/[?&]section=domains/);
    await expect(page.getByRole("combobox", { name: "導入の形", exact: true })).toBeVisible();
    await expect(page.locator('input[name="domains.0"]')).toBeVisible();
    await page.getByTestId("section-tag").click();
    await expect(page.getByTestId("code-block")).toBeVisible();

    // B60 A10: フォームに入らない節(導入タグ)では保存の帯を出さない。一般の節に戻すと出る。
    // 戻すのは最下部の「設定」(行き先は同じ画面の一般の節)。ルーターで同じ画面へ移らず節だけを切り替えるので、
    // 表示と URL がそろって一般になる(URL だけ一般で表示が導入タグのまま、にならない)
    const settingsUrl = page.url().replace(/[?#].*$/, "");
    await expect(saveState).toHaveCount(0);
    await nav.getByRole("link", { name: "設定", exact: true }).click();
    await expect(saveState).toBeVisible();
    await expect(page.locator('input[name="name"]')).toBeVisible(); // 一般の節(B148 でドメインの欄はドメインの節に移った)
    await expect(page.getByTestId("code-block")).toHaveCount(0);
    await expect(page).toHaveURL(settingsUrl);
    await expect(page.getByTestId("section-general")).toHaveAttribute("aria-current", "page");
    // B60 B31 ⑥: 節の見出しは SECTIONS の heading(文字は今のまま)
    await page.getByTestId("section-external").click();
    await expect(page.getByRole("heading", { name: "分析(外部 ID)", level: 2 })).toBeVisible();
    // B60 離脱の確認: 未保存のまま設定のメニューのサイト設定の節(と最下部の「設定」= 同じ画面の一般)で節を移っても確認は出ない
    // (入力はフォームに残る)。サイト設定の外の画面へ移ろうとすると確認が出て、キャンセルなら同じ URL に残り、「保存せずに移動」で移る
    await page.getByTestId("section-general").click();
    await chooseTz("America/New_York");
    await expect(saveState).toHaveText("未保存の変更あり");
    await page.getByTestId("section-identity").click();
    await expect(page).toHaveURL(`${settingsUrl}?section=identity`);
    await nav.getByRole("link", { name: "設定", exact: true }).click();
    await expect(page.getByTestId("section-general")).toHaveAttribute("aria-current", "page");
    const settingsLeave = page.getByRole("alertdialog", { name: "サイト設定の変更を保存していません" });
    await expect(settingsLeave).toHaveCount(0);
    await expect(tzCombo()).toHaveValue("America/New_York");
    await expect(page).toHaveURL(settingsUrl);
    // 設定のメニューの「メンバー」(サイト設定の外の画面)は確認が出る。キャンセルなら残り、入力も残る
    await nav.getByRole("link", { name: "メンバー", exact: true }).click();
    await expect(settingsLeave).toBeVisible();
    await settingsLeave.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(settingsLeave).toBeHidden();
    await expect(page).toHaveURL(settingsUrl);
    await expect(tzCombo()).toHaveValue("America/New_York");
    // B60: 別の画面へ移るのは「戻る」も同じ(再読み込みの後なので、戻り先はサイトのトップ)
    const backLink = nav.getByRole("link", { name: /^戻る/ });
    await backLink.click();
    await expect(settingsLeave).toBeVisible();
    await settingsLeave.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(settingsLeave).toBeHidden();
    await expect(page).toHaveURL(settingsUrl);
    await expect(tzCombo()).toHaveValue("America/New_York"); // 入力は残る
    await backLink.click();
    await settingsLeave.getByRole("button", { name: "保存せずに移動" }).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}$`));
    // 存在しない節は一般の節で開く
    await page.goto(`${settingsUrl}?section=bogus`);
    await waitForHydration(page);
    await expect(page.locator('input[name="name"]')).toBeVisible(); // 一般の節(B148 でドメインの欄はドメインの節に移った)
    // 再描画で節が戻らない: ?section=tag で開いてから一般の節へ切り替え、入力する(入力で再描画される)。
    // 入力の後も、保存の後(router.refresh)も一般の節のまま(initialSection の入れ直しで導入タグへ戻らない)。
    // 1 字打って消す(同じ値の fill は入力のイベントを出さない)。名前は元のまま保存し、変更の無い状態で次へ進む
    await page.goto(`${settingsUrl}?section=tag`);
    await waitForHydration(page);
    await expect(page.getByTestId("code-block")).toBeVisible();
    await page.getByTestId("section-general").click();
    const siteName = page.locator('input[name="name"]');
    await siteName.press("End");
    await siteName.press("x");
    await siteName.press("Backspace");
    await expect(siteName).toHaveValue(SITE.name);
    await expect(saveState).toHaveText("未保存の変更あり");
    await expect(page.locator('input[name="name"]')).toBeVisible(); // 一般の節(B148 でドメインの欄はドメインの節に移った)
    await expect(page.getByTestId("code-block")).toHaveCount(0);
    // 保存の直後(読み直しの反映を待たずに)次の節へ切り替える。読み直しの反映の前の切り替えは、反映の後に回る(lib/refresh-wait.ts)ので、
    // 下の「切り替えの枠の href が ?section=tag で終わる」が、保存の直後の節の切り替えの見張りになる(以前は refresh の応答を待っていた。管理画面の速さの記録 4 節)
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await expect(page.locator('input[name="name"]')).toBeVisible(); // 一般の節(B148 でドメインの欄はドメインの節に移った)
    await expect(page.getByTestId("code-block")).toHaveCount(0);

    // B60 Task 5(ユーザーの決定 5): 設定のメニューの切り替えの枠でサイトを選ぶと、サイト設定の画面では同じ節のまま別のサイトへ移る。
    // 変更の無い状態(上で保存済み)から始める(未保存だと離脱の確認が挟まる)
    const switcherButton = nav.getByRole("button", { name: /^ワークスペースとサイトの切り替え/ });
    await page.getByTestId("section-tag").click();
    await expect(page.getByTestId("code-block")).toBeVisible();
    await switcherButton.click();
    const unpubLink = switcher.getByRole("link", { name: new RegExp(`^${SITE_UNPUBLISHED.name}`) });
    await expect(unpubLink).toHaveAttribute("href", /\/settings\?section=tag$/); // 押す前に、今の節(導入タグ)が href に入っていること
    await unpubLink.click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}/settings\\?section=tag$`));
    await expect(page.getByTestId("code-block")).toContainText(`/s/${SITE_UNPUBLISHED.id}.js`);
    // 見ているのは「サイトを切り替えたあと、前のサイトの値が残らない」という見えるふるまい(key による再マウントそのものの証明ではない。
    // App Router が [sid] 配下を作り直す場合もある)。名前の欄は制御されない input(defaultValue)で、前提は上で SITE の欄に
    // 1 字打って消して DOM の入力済みフラグを立てていること(保存は form.reset() をしない)。作り直されないと SITE の名前が残って落ちる
    // ので、この確認はその手順より後に置く。隠れた節の欄でも値は読めるので、節を切り替える前に見る
    await expect(page.locator('input[name="name"]')).toHaveValue(SITE_UNPUBLISHED.name);
    // 同じ値を、一般の節へ切り替えた後(欄が見える状態)でも見る: 節の切り替えで前の値に戻らない
    await page.getByTestId("section-general").click();
    await expect(page.locator('input[name="name"]')).toHaveValue(SITE_UNPUBLISHED.name);
    // サイト設定の外の設定の画面(個人の「API キー」)からは、選んだサイトのサイト設定の一般へ。
    // 設定のメニューの中のリンクで移る(page.goto の読み込み直しでは開いた場所がホームに戻り、枠が出ない)
    await nav.getByRole("link", { name: "API キー", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/me\/api-keys$/);
    await switcherButton.click();
    await switcher.getByRole("link", { name: new RegExp(`^${SITE.name}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}/settings$`));
    const switchedHeading = nav.getByText("サイト設定", { exact: true });
    await expect(switchedHeading.locator("..")).toContainText(SITE.name);
    await expect(page.locator('input[name="name"]')).toHaveValue(SITE.name);
    // 普段のメニュー(エクスペリエンスの画面)の枠のサイトは、今どおりサイトのトップを指す(検索の結果からの移動は上の B35 の確認が見ている)
    await nav.getByRole("link", { name: /^戻る/ }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}$`));
    await switcherButton.click();
    await expect(switcher.getByRole("link", { name: new RegExp(`^${SITE_UNPUBLISHED.name}`) })).toHaveAttribute("href", new RegExp(`/w/[^/]+/sites/${SITE_UNPUBLISHED.id}$`));
    await switcher.getByRole("link", { name: new RegExp(`^${SITE_UNPUBLISHED.name}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}$`));

    // B60 Task 8: 空の一覧から導入タグへ(遠くなる導線を埋める)。SITE_UNPUBLISHED はエクスペリエンスが 0 件。
    // 設定の中の節(外部計測の名前)から「戻る」でクライアント遷移して一覧へ戻り、そこから導入タグを開く。
    // 前の画面の節(naming)が残らず、再読み込みなしで導入タグの節が開く
    const emptyListPath = new URL(page.url()).pathname;
    await openSettings(page);
    await page.getByTestId("section-naming").click();
    await expect(page.getByTestId("section-naming")).toHaveAttribute("aria-current", "page");
    // ログインを増やさず、設定を開いたページでプレビューを確かめる。
    await test.step("site analytics preview follows unsaved input and stacks on narrow screens", () => verifySiteNamingPreview(page, SITE_UNPUBLISHED.id));
    await nav.getByRole("link", { name: /^戻る/ }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}$`));
    await expect(page.getByText("エクスペリエンスはまだありません")).toBeVisible();
    await page.getByTestId("empty-install-tag").click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}/settings\\?section=tag$`));
    await expect(page.getByTestId("code-block")).toContainText(`/s/${SITE_UNPUBLISHED.id}.js`);
    await expect(page.getByRole("heading", { name: "導入タグ", level: 2 })).toBeVisible();
    await expect(page.getByTestId("section-tag")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("section-naming")).not.toHaveAttribute("aria-current", /.*/); // 前の画面の節が残らない
    // 「戻る」は押す前の一覧を指す
    await expect(nav.getByRole("link", { name: /^戻る/ })).toHaveAttribute("href", emptyListPath);
    await nav.getByRole("link", { name: /^戻る/ }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE_UNPUBLISHED.id}$`));

    // B14 / B42 / 決定 54 (11): 発行フォーム → 結果の置き換え → 移動時の確認 → 失効済みへ移る(サインイン予算を増やさないためこのテストに相乗り)
    const wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
    await page.goto("/w/me/api-keys");
    await waitForHydration(page);
    const issueBtn = page.getByRole("button", { name: "発行する" });
    // 名前・範囲・権限・有効期限を入れて発行を押す(パスワードのセッションでの 403 と、印を書き換えた後の成功で共用する。
    // 再読み込みでフォームは空に戻る = IssueKeyForm は名前が空、権限・期限が未選択で始まるので、途中の案内は 2 回とも同じに出る)
    const fillAndIssue = async () => {
      await expect(issueBtn).toBeDisabled();
      await expect(page.getByText("名前を入れてください", { exact: true })).toBeVisible();
      await page.fill('input[name="name"]', "e2e-revoke-me");
      // 範囲: システム管理者には「すべてのワークスペース」とワークスペースが出るので、選ぶまで発行できない
      await expect(page.getByText("範囲を選んでください", { exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "権限", exact: true })).toHaveAttribute("aria-disabled", "true");
      await pick(page, "範囲", new RegExp(`^${WORKSPACE_NAME}`));
      await expect(page.getByText("権限を選んでください", { exact: true })).toBeVisible(); // 既定は未選択
      await pick(page, "権限", /^閲覧者/);
      // B43: 有効期限は必須・既定は未選択。選ぶと実際の期限の日時が横に出る
      await expect(page.getByText("有効期限を選んでください", { exact: true })).toBeVisible();
      await pick(page, "有効期限", /^1 日/);
      await expect(page.getByTestId("expiry-preview")).toHaveText(/^\d{1,2}\/\d{1,2} \d{2}:\d{2} まで$/);
      await issueBtn.click();
    };
    // B112: 非常用のパスワードログインのセッション(E2E のログインはこれ)では発行できない。エラーの表示に理由が出て、結果カードは出ない
    await fillAndIssue();
    await expect(appAlert(page).filter({ hasText: "非常用のパスワードログインでは API キーを発行できません" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toHaveCount(0);
    // セッションの印を Google に書き換えると発行できる(E2E は Google を呼べないので印だけ変える)
    markSessionsAsGoogle();
    await page.reload();
    await waitForHydration(page);
    await fillAndIssue();
    // 結果が発行カードの場所に出て、見出しにフォーカスが移る
    await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toBeFocused();
    await expect(page.getByTestId("issued-key")).toContainText(/wtt_/);
    await expect(page.getByRole("button", { name: "発行する" })).toHaveCount(0); // 閉じるまで次の発行はできない
    const activeRow = page.getByTestId("api-keys").locator("tr", { hasText: "e2e-revoke-me" });
    await expect(activeRow.locator("td").nth(3)).toHaveText("閲覧者");
    await expect(activeRow.locator("td").nth(2)).toHaveText(WORKSPACE_NAME); // 範囲 = このワークスペースの名前
    await expect(activeRow.locator("td").nth(4)).toHaveText(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/); // 期限(1 日後の日時)
    // 控えずに移動しようとすると確認(Esc = 戻る)。「移動する」で移る(クライアントの遷移なので beforeunload はもともと起きない。
    // beforeunload とログアウトの経路は「logout revokes the control session…」で確かめる)
    const side = page.getByRole("navigation", { name: "メインメニュー" });
    await side.getByRole("link", { name: "画面表示" }).click();
    const leave = page.getByRole("alertdialog", { name: "キーをまだ控えていません" });
    await expect(leave).toBeVisible();
    await expect(leave.getByRole("button", { name: "戻って控える" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/\/w\/me\/api-keys$/);
    // 戻った後は結果の見出しにフォーカスがある(ダイアログが閉じた後に移す。リンクに戻らない)
    await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toBeFocused();
    await side.getByRole("link", { name: "画面表示" }).click();
    await leave.getByRole("button", { name: "移動する" }).press("Enter");
    await expect(page).toHaveURL(/\/w\/me\/display$/);
    // 管理者以上は「メンバーの API キー」で、このワークスペースで使えるキーを持ち主付きで見られる
    await page.goto("/w/me/api-keys");
    await page.getByRole("link", { name: `${WORKSPACE_NAME} のメンバーの API キー` }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${wid}/api-keys$`));
    const wsKeyRow = page.getByTestId("workspace-api-keys").locator("tr", { hasText: "e2e-revoke-me" });
    await expect(wsKeyRow.locator("td").nth(3)).toHaveText("閲覧者");
    // B44: 画面でライトを選び、OS はダーク、ブラウザのタイムゾーンはサーバーと違う(UTC でも JST でもない)。
    // 時刻の列がある API キーの画面を全画面で読み込んでも、ハイドレーションの不一致が出ず、ライトのまま
    {
      const ctx = await page.context().browser()!.newContext({
        baseURL: ADMIN_URL,
        storageState: await page.context().storageState(),
        timezoneId: "Pacific/Honolulu",
        colorScheme: "dark",
      });
      await ctx.addInitScript(() => localStorage.setItem("wtt-theme", "light"));
      const tz = await ctx.newPage();
      const hydrationErrors: string[] = [];
      tz.on("pageerror", (e) => hydrationErrors.push(e.message)); // 本番ビルドの React は回復できる不一致を reportError で投げる
      tz.on("console", (m: ConsoleMessage) => {
        if (m.type() === "error" && /hydrat|#418|#423|#425/i.test(m.text())) hydrationErrors.push(m.text());
      });
      await tz.goto("/w/me/api-keys");
      await waitForHydration(tz);
      const tzRow = tz.getByTestId("api-keys").locator("tr", { hasText: "e2e-revoke-me" });
      await expect(tzRow.locator("td").nth(5)).toHaveText(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/); // 作成の列はマウントの後に描く
      await expect(tz.locator("html")).toHaveAttribute("data-theme", "light");
      expect(hydrationErrors).toEqual([]);
      await ctx.close();
    }
    await page.goto("/w/me/api-keys");
    await waitForHydration(page);
    // B45: 失効は確認のモーダルを挟む。Esc とキャンセルでは失効しない(押し間違いの防御)→「失効する」で失効する
    let revokeRequests = 0;
    const onRequest = (r: Request) => {
      if (r.method() === "DELETE" && new URL(r.url()).pathname.startsWith("/api/control/me/api-keys/")) revokeRequests += 1;
    };
    page.on("request", onRequest);
    const revokeDialog = page.getByRole("alertdialog", { name: "キー「e2e-revoke-me」を失効しますか?" });
    await activeRow.getByRole("button", { name: "失効" }).click();
    await expect(revokeDialog).toBeVisible();
    await expect(revokeDialog.getByRole("button", { name: "キャンセル" })).toBeFocused(); // 初期のフォーカスはキャンセル側(Enter の押し間違いで実行しない)
    // 画面の中央に出る(上下左右の余白の差が 2px 以内)
    const box = (await revokeDialog.boundingBox())!;
    const view = page.viewportSize()!;
    expect(Math.abs(box.y - (view.height - box.y - box.height))).toBeLessThanOrEqual(2);
    expect(Math.abs(box.x - (view.width - box.x - box.width))).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(revokeDialog).toBeHidden();
    // 外(背面)のクリックもキャンセル。中で押し始めて外で離した(文字の選択など)ときは閉じない
    await activeRow.getByRole("button", { name: "失効" }).click();
    await expect(revokeDialog).toBeVisible();
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(revokeDialog).toBeVisible();
    // 開いてから 0.5 秒の間のクリックは無視する(ダブルクリックの 2 回目で閉じないため。lib/dialog-click.ts)ので、閉じるまで背面を押し直す
    await expect(async () => {
      await page.mouse.click(5, 5);
      await expect(revokeDialog).toBeHidden({ timeout: 200 });
    }).toPass({ timeout: 5_000 });
    await activeRow.getByRole("button", { name: "失効" }).click();
    await revokeDialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(revokeDialog).toBeHidden();
    await expect(activeRow.getByRole("button", { name: "失効" })).toBeEnabled(); // 有効な鍵の表に残る
    expect(revokeRequests).toBe(0); // キャンセルでは失効の要求を送らない
    await activeRow.getByRole("button", { name: "失効" }).click();
    await revokeDialog.getByRole("button", { name: "失効する" }).press("Enter");
    await expect.poll(() => revokeRequests).toBe(1);
    page.off("request", onRequest);
    const revokedTable = page.getByTestId("revoked-api-keys");
    await expect(revokedTable.locator("tr", { hasText: "e2e-revoke-me" })).toBeVisible();
    await expect(revokedTable.getByRole("button")).toHaveCount(0); // 失効済みに操作は無い
    // 有効な鍵の表からは消えている(同じ名前の行は失効済みの 1 行だけ)
    await expect(page.locator("tr", { hasText: "e2e-revoke-me" })).toHaveCount(1);
    // 失効日の列(名前・接頭辞・範囲・権限・発行・失効の 6 列目)が空でない
    await expect(revokedTable.locator("tr", { hasText: "e2e-revoke-me" }).locator("td").nth(5)).not.toBeEmpty();
  });

  test("create an experiment with a TEXT change, start it, and the edge serves it", async ({ page }) => {
    await login(page);
    await openSite(page, SITE.name);
    await createExperiment(page, EXPERIMENT);
    await expect(page.locator("main").getByText("未公開の編集あり")).toBeVisible();
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "primary"); // Publish 前なので主ボタンのまま

    // タブを移っても入力が残る / 「破棄」で初期値に戻る(どちらも control を呼ばない)
    const nameInput = page.getByLabel("名前(100 字以内)");
    await nameInput.fill("E2E hero (edited)");
    await expect(page.getByTestId("save-state")).toHaveText("未保存の変更あり");
    await page.getByRole("tab", { name: "パターン" }).click();
    await page.getByRole("tab", { name: "基本設定" }).click();
    await expect(nameInput).toHaveValue("E2E hero (edited)");
    await page.getByRole("button", { name: "破棄" }).click();
    await expect(nameInput).toHaveValue(EXPERIMENT.name);
    await expect(page.getByTestId("save-state")).toHaveText("変更はありません");

    await openVariant(page, "b");
    const variantB = page.getByTestId("variant-b");
    // B77: パターンの外部計測は詳細の 3 枚目のカード。設定の無いパターンでは畳んだ状態で出る(開閉は variant-ui.spec.ts が見る)
    await expect(variantB.getByRole("button", { name: /^外部計測\(dataLayer 出力\)/ })).toHaveAttribute("aria-expanded", "false");
    // ID は自動の採番(入力欄は無い)。空いている最初の文字 `c`、名前の既定は ID の大文字化 `C`。足したパターンがそのまま開く
    await expect(page.getByTestId("new-variant-id")).toHaveCount(0);
    await page.getByRole("button", { name: "パターンを追加" }).click();
    await expect(page.getByTestId("variant-c")).toBeVisible();
    await expect(page.getByTestId("variant-c").locator("strong code")).toHaveText("c");
    await expect(page.getByTestId("variant-c").getByLabel("名前(100 字以内)")).toHaveValue("C");
    await page.getByTestId("variant-c").getByRole("button", { name: "パターンを削除" }).click();
    await expect(page.getByTestId("variant-c")).toHaveCount(0); // 以降の手順は A / B の 2 パターンのまま(重みも 50 / 50 に戻る)
    await expect(page.getByTestId("variant-weight-b")).toHaveValue("50");
    await openVariant(page, "b"); // 削除後は先頭の a が開くので b を開き直す

    // Variant B に TEXT Change を 1 件足して保存する
    await variantB.getByRole("button", { name: "変更を追加", exact: true }).click();
    const change = variantB.getByTestId("change-TEXT");
    await change.locator('input[maxlength="500"]').fill(HERO_SELECTOR);
    await change.locator("textarea").fill(HERO_TEXT);
    expect((await saveDraft(page, SITE.id, EXPERIMENT.id)).status()).toBe(200);
    // 保存の後の読み直しの反映 = 保存バーが「保存しました」になる。それを待ってから見る
    // (待たずに見ると、保存前から出ている要素で通ってしまい、保持を証明しない)
    await expect(page.getByTestId("save-state")).toHaveText("下書きに保存しました。訪問者への反映にはサイトの公開が必要です");
    await expect(page.getByRole("tab", { name: "パターン" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("variant-b").getByTestId("change-TEXT")).toBeVisible(); // 保存後も Variant タブの b のまま

    // 再読込しても残っている = 画面の state ではなく D1 に入っている
    await page.reload();
    await waitForHydration(page);
    const saved = page.getByTestId("variant-b").getByTestId("change-TEXT");
    await expect(saved.locator('input[maxlength="500"]')).toHaveValue(HERO_SELECTOR);
    await expect(saved.locator("textarea")).toHaveValue(HERO_TEXT);

    // 既存 Change を持つ実験の「2 回目の保存」。GET が返す Change には updatedBy / updatedAt が付いており、
    // それをそのまま PUT すると core の strictObject が 422 invalid_change で全件を拒否する
    // (lib/change-wire.ts が落とす。Task 12 で実地確認された壊れ方のリグレッション)。
    // B77 K17: 保存は変わった段だけを送るので、読み込んだ変更の文を直して送り、元の文に戻してもう一度送る(どちらも読み込んだ変更の PUT)
    await saved.locator("textarea").fill(`${HERO_TEXT}(2 回目)`);
    expect((await saveDraft(page, SITE.id, EXPERIMENT.id)).status()).toBe(200);
    await expect(page.getByTestId("save-state")).toHaveText("下書きに保存しました。訪問者への反映にはサイトの公開が必要です");
    await saved.locator("textarea").fill(HERO_TEXT);
    expect((await saveDraft(page, SITE.id, EXPERIMENT.id)).status()).toBe(200);
    await expect(page.getByTestId("save-state")).toHaveText("下書きに保存しました。訪問者への反映にはサイトの公開が必要です");
    await expect(appAlert(page)).toHaveCount(0);

    // B60: 設定を開いた場所の記憶。下書きのテストの画面に相乗りする(sign-in の予算を増やさない)
    await test.step("settings menu remembers where it was opened", async () => {
      const nav = page.getByRole("navigation", { name: "メインメニュー" });
      const backLink = nav.getByRole("link", { name: /^戻る/ });
      // 評価計画のタブで未保存の入力を作る(タブは replaceParam で URL の search に写る)
      await page.getByRole("tab", { name: "評価計画" }).click();
      await expect(page).toHaveURL(/[?&]tab=plan(&|$)/);
      await page.getByRole("spinbutton", { name: "最大期間", exact: true }).fill("9");
      const opened = new URL(page.url());
      const experimentHref = `${opened.pathname}${opened.search}`;
      // 最下部の「設定」は離脱の確認(PageLeaveGuard)に止められ(onClick は走らない)、「移動する」の後に移る。
      // それでも provider は画面の移動から開いた場所を覚え、「戻る」は search まで含めた元の画面を指す。
      // openSettings は押した直後に選択中を待つので、確認を挟むここでは使わない
      await nav.getByRole("link", { name: "設定", exact: true }).click();
      const leave = page.getByRole("alertdialog", { name: "保存していない変更があります" });
      await leave.getByRole("button", { name: "移動する", exact: true }).press("Enter");
      await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}/settings$`));
      await expect(backLink).toHaveAttribute("href", experimentHref);
      // サイトから開いたので、メニューの先頭は「サイト設定」の節(見出しの下の行にサイト名。切り替えの枠にもサイト名が出るので、見出しの塊で見る)
      const siteGroupHeading = nav.getByText("サイト設定", { exact: true });
      await expect(siteGroupHeading).toBeVisible();
      await expect(siteGroupHeading.locator("..")).toContainText(SITE.name);
      // 同じメニューの中で「メンバー」へ移っても、メニューの形(サイト設定の節)と戻り先は変わらない。
      // サイト設定の画面にいないので、サイト設定の項目はどれも選択中にならない
      await nav.getByRole("link", { name: "メンバー", exact: true }).click();
      await expect(page).toHaveURL(/\/w\/[^/]+\/members$/);
      await expect(siteGroupHeading).toBeVisible();
      await expect(nav.locator('[data-testid^="section-"]')).toHaveCount(7); // オーナーには危険な操作も出る(B148 でドメインの節が増えて 7)
      await expect(nav.locator('[data-testid^="section-"][aria-current]')).toHaveCount(0);
      await expect(backLink).toHaveAttribute("href", experimentHref);
      // 「戻る」で設定を開く前の画面(評価計画のタブ)へ
      await backLink.click();
      await expect.poll(() => {
        const u = new URL(page.url());
        return `${u.pathname}${u.search}`;
      }).toBe(experimentHref);
      await expect(page.getByRole("tab", { name: "評価計画" })).toHaveAttribute("aria-selected", "true");
    });
    await page.getByRole("tab", { name: "パターン" }).click(); // 以降の手順は元のタブのまま

    // Start は必ず自動 Publish を伴う(spec §13.8 / 決定 17)
    const started = await changeStatus(page, SITE.id, EXPERIMENT.id, /^開始/);
    expect(started.publish).toMatchObject({ ok: true, version: 1 });
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-published-status", "running");

    // B60: 公開履歴は左メニューに無く、上部バーの版の札から開く。札を押すと直近の公開が開き、いま配信中の 1 行は activeVersion で決まる
    await expect(page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "公開履歴", exact: true })).toHaveCount(0);
    const chip = page.getByTestId("version-chip");
    const recent = page.getByTestId("version-popover");
    const publishesPath = `**/api/control/sites/${SITE.id}/publishes`;
    await expect(chip).toHaveAccessibleName("配信中 v1。公開履歴を開く"); // Start 後の router.refresh() で上部バーも v1 になる
    await test.step("version chip shows recent publishes and load failures", async () => {
      // 取得の失敗(HTTP 500)は状態コードを添えた文。Esc で閉じて開き直すと読み直す
      await page.route(publishesPath, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, json: { error: "internal" } }) : r.continue()));
      await chip.click();
      await expect(recent).toContainText("公開履歴を取得できませんでした(HTTP 500)");
      await expect(recent.locator('[data-testid^="recent-publish-"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(recent).toHaveCount(0);
      await page.unroute(publishesPath);
      await chip.click();
      await expect(recent.getByTestId("recent-publish-1")).toContainText("配信中");
      await expect(recent).not.toContainText("取得できませんでした");
      await page.keyboard.press("Escape");
      // 失敗した公開の行は「失敗」の赤い札(エラーの文は一覧に出さない)。control の応答を差し替えて見る
      const at = Date.UTC(2026, 9, 20, 8, 40);
      const rows: PublishRow[] = [
        { version: 2, status: "failed", createdAt: at, activatedAt: null, needsProfile: null, error: "e2e_failed_reason", publishedBy: { id: "u1", name: OWNER_NAME } },
        { version: 1, status: "active", createdAt: at - 60_000, activatedAt: at - 60_000, needsProfile: false, error: null, publishedBy: { id: "u1", name: OWNER_NAME } },
      ];
      await page.route(publishesPath, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 200, json: rows }) : r.continue()));
      await chip.click();
      const failedRow = recent.getByTestId("recent-publish-2");
      await expect(failedRow).toContainText("失敗");
      await expect(failedRow).toContainText(OWNER_NAME);
      await expect(failedRow.getByText("失敗", { exact: true })).toHaveAttribute("style", /color: var\(--danger\)/);
      await expect(recent).not.toContainText("e2e_failed_reason");
      await expect(recent.getByTestId("recent-publish-1")).toContainText("配信中");
      await page.keyboard.press("Escape");
      await expect(recent).toHaveCount(0);
      await page.unroute(publishesPath);
    });
    // 「すべての公開履歴 →」で公開履歴の画面へ(移ったら閉じる)
    await chip.click();
    await expect(recent.getByTestId("recent-publish-1")).toContainText("配信中");
    await recent.getByRole("link", { name: "すべての公開履歴 →" }).click();
    await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}/history$`));
    await expect(recent).toHaveCount(0);
    await expect(page.getByTestId("publish-row-1")).toContainText("配信中");
    // Publish の確認画面: 変更が無くても開ける。上部バーの Publish は副ボタンに戻っている。
    // この secondary は Start 後に StatusButtons が呼ぶ「同じ経路での router.refresh()」の結果でしかありえない:
    // ここまでの 2 回の遷移(版の札から開いた「すべての公開履歴」のリンクと上部バーの Publish リンク)はどちらもクライアント遷移で、
    // 共有の Site layout を描き直さない。つまり同じ経路の refresh は共有 layout を確かに取り直す、という実地の証拠になっている
    await page.getByTestId("topbar-publish").click();
    await expect(page.getByRole("heading", { name: "公開", exact: true })).toBeVisible();
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "secondary");
    // 副 → 主: Publish 済みの Site で実験を作ると、上部バーが「未公開の編集あり」+ 主ボタンに変わる。
    // 実験の作成は router.push + router.refresh() では共有 layout(上部バー)が確実には更新されなかったため、
    // 全画面の遷移(window.location.assign。components/ExperimentCreateForm.tsx)で終わる。
    // だからここで見ているのは、その全画面の遷移で描き直された上部バー
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, EXPERIMENT_SECOND);
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "primary");
    await expect(page.locator("header")).toContainText("未公開の編集あり");

    // 管理画面で行った Publish が設置タグの配信ファイルに現れる(control → デプロイ専用の Worker → 偽の API)
    const res = await fetch(`${STATIC_URL}/s/${SITE.id}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.text();
    expect(body).toContain("config v1, runtime ");
    expect(body).toContain(`"id":"${EXPERIMENT.id}"`);
    expect(body).toContain(HERO_SELECTOR);
    expect(body).toContain(HERO_TEXT);
    // B77: 名前は訪問者に届けない。dataLayer の名前は外部計測の指定 ?? ID なので、指定の無い b はパターン ID のまま(exposurePayloads)
    expect(body).toContain('"variantName":"b"');
    expect(body).not.toContain('"name":');

    // B60: 開いた場所は画面の中の state だけに持つので、再読み込みすると今の画面から決まる縮んだ形になる
    // (メンバーの画面 = ワークスペースから開いた形。「サイト設定」の節は消え、「戻る」はワークスペースのトップへ)
    await test.step("settings menu shrinks on reload", async () => {
      const nav = page.getByRole("navigation", { name: "メインメニュー" });
      const wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
      await waitForHydration(page); // 直前の実験の作成は全画面の遷移で終わる
      await openSettings(page);
      await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}/settings$`));
      await nav.getByRole("link", { name: "メンバー", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${wid}/members$`));
      await expect(nav.getByText("サイト設定", { exact: true })).toBeVisible();
      await page.reload();
      await waitForHydration(page);
      await expect(nav.getByRole("link", { name: "メンバー", exact: true })).toHaveAttribute("aria-current", "page"); // 描き終わってから無いことを見る
      await expect(nav.getByText("サイト設定", { exact: true })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: /^戻る/ })).toHaveAttribute("href", `/w/${wid}`);
    });
  });

  test("attribute_not_allowed shows a Japanese message and the HTML switch hint", async ({ page }) => {
    await login(page);
    await openSite(page, SITE.name);
    // B188: 既存のログイン済みの流れに相乗りし、URL の復元と再取得なしを確かめる。
    await test.step("一覧の既定と明示したすべてを URL から復元する", async () => {
      await expect(page).toHaveURL(new RegExp(`/sites/${SITE.id}$`));
      await waitForHydration(page);
      await expect(page.getByTestId("filter-not_archived")).toHaveAttribute("aria-pressed", "true");
      const listUrl = new URL(page.url());
      await page.getByTestId("filter-all").click();
      await expect(page).toHaveURL(`${listUrl.href}?status=all`);
      await page.reload();
      await waitForHydration(page);
      await expect(page.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "true");
      for (const status of ["not_archived", "unknown"]) {
        await page.goto(`${listUrl.href}?status=${status}&extra=keep#list`);
        await waitForHydration(page);
        await expect(page.getByTestId("filter-not_archived")).toHaveAttribute("aria-pressed", "true");
      }

      // 切替に伴う HTML / RSC / 一覧の取得は 0 件。共通の帯の polling はこの操作の取得と分ける。
      const requests: string[] = [];
      const onRequest = (request: Request) => {
        const u = new URL(request.url());
        if (request.isNavigationRequest() || u.searchParams.has("_rsc") || u.pathname.endsWith(`/sites/${SITE.id}/experiments`)) requests.push(request.url());
      };
      page.on("request", onRequest);
      try {
        for (const status of ["all", "draft", "running", "paused", "archived", "not_archived"]) {
          await page.getByTestId(`filter-${status}`).click();
          await expect(page.getByTestId(`filter-${status}`)).toHaveAttribute("aria-pressed", "true");
          await expect(page.getByRole("group", { name: "状態で絞り込む" }).locator('[aria-pressed="true"]')).toHaveCount(1);
          // replaceParam は既存の query/hash を残す（status は既存の先頭位置を保つ）。
          await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe(status === "not_archived" ? null : status);
          expect(new URL(page.url()).searchParams.get("extra")).toBe("keep");
          expect(new URL(page.url()).hash).toBe("#list");
          await expect(page.getByTestId(`experiment-row-${EXPERIMENT.id}`)).toHaveCount(["all", "running", "not_archived"].includes(status) ? 1 : 0);
        }
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(requests).toEqual([]);
      } finally {
        page.off("request", onRequest);
      }
      // A21: ライト/ダークで、hover しても選択の色と固定の余白を保つ。
      const previousTheme = await page.getAttribute("html", "data-theme");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
        const selected = page.getByTestId("filter-not_archived");
        await selected.focus();
        await selected.hover();
        // テーマ・選択の切替直後は .btn の背景色が遷移中なので、最終色を待つ。
        await expect.poll(() => selected.evaluate((button) => {
          const style = getComputedStyle(button);
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--nav-active)";
          button.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return style.backgroundColor === expected;
        })).toBe(true);
        const group = page.getByRole("group", { name: "状態で絞り込む" });
        expect(await group.evaluate((el) => ({ gap: getComputedStyle(el).gap, margin: getComputedStyle(el).marginBottom }))).toEqual({ gap: "4px", margin: "12px" });
        await test.info().attach(`experience-filters-${theme}`, { body: await group.screenshot(), contentType: "image/png" });
      }
      await page.evaluate((value) => {
        if (value === null) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = value;
      }, previousTheme);
    });
    await page.getByRole("link", { name: EXPERIMENT.name }).click();
    // B77: a はオリジナル(変更を持てない)なので、変更のある b で確かめる。b には保存済みの TEXT が 1 件あるので、足した方(最後)を変える
    await openVariant(page, "b");
    const variantB = page.getByTestId("variant-b");
    await variantB.getByRole("button", { name: "変更を追加", exact: true }).click();
    await pick(variantB.getByTestId("change-TEXT").last(), "変更の種類", /^ATTRIBUTE/);
    const attribute = variantB.getByTestId("change-ATTRIBUTE");
    await attribute.locator('input[maxlength="500"]').fill("a.cta");
    await attribute.locator('input[list="attr-allow"]').fill("onclick");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    // D9 ③(設計書 §5.5): 実行中のテストの変更を保存するときは 1 回確認する
    await confirmRunningTestSave(page);
    // 封筒の message は control が出す日本語(機械可読コードをそのまま画面に出さない。spec §13.5)
    await expect(appAlert(page)).toContainText("属性 onclick は ATTRIBUTE では設定できません");
    await expect(page.getByRole("button", { name: "HTML タイプに切り替える" })).toBeVisible();
  });

  test("a failed start keeps the draft and explains the preparation failure in the confirmation", async ({ page }) => {
    await login(page);
    await createSite(page, SITE_FAILED);
    await createExperiment(page, EXPERIMENT_FAILED);

    // compile を config_too_large(512KiB 超)で落とす。1 件あたりは 64KiB 未満なので保存時検証は通り、
    // 束ねたときだけ落ちる。60KiB のテキストを 10 回 UI に打ち込む意味は無いので、画面と同じ BFF に直接置く。
    // B77: 作成の既定で a はオリジナル(変更を 1 件以上送ると 422 variant_original)なので、10 件とも b に置く
    // (かつては `PUT …/changes` が 1 行 12 個の bind 変数を使う単一の複数行 INSERT で、9 件以上が D1 の
    // 「1 クエリ 100 変数」上限に当たって 500 になっていた。d51c5db で 8 行ずつに分割して解消済み。10 件はその分割も通る)
    const bigChanges = Array.from({ length: 10 }, (_, i) => ({ id: `c_big${i}`, type: "TEXT", selector: `.c_big${i}`, payload: { text: "x".repeat(60_000) } }));
    const seeded = await page.request.put(`/api/control/sites/${SITE_FAILED.id}/experiments/${EXPERIMENT_FAILED.id}/variants/b/changes`, { headers: controlHeaders(), data: bigChanges });
    expect(seeded.status()).toBe(200);

    await page.getByRole("button", { name: /^開始/ }).click();
    const dialog = page.getByRole("alertdialog", { name: /^開始/ });
    const rejected = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/experiments/${EXPERIMENT_FAILED.id}/status`));
    await dialog.getByRole("button", { name: "開始する" }).press("Enter");
    const res = await rejected;
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ error: "config_too_large" });
    await expect(dialog.getByRole("alert")).toContainText("開始できませんでした(状態は変わっていません)。compiled config が大きすぎます");
    await dialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    // 読み直しても下書きのままで、配信済みの版は無い。
    await page.reload();
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-published-status", "none");
    // B31 ③: 一覧の「未反映」の下に、本番の状態を見える文で出す(title だけにしない)。一度も公開していないので「まだ公開していません」
    await page.getByRole("banner").getByRole("link", { name: SITE_FAILED.name }).click();
    await expect(page.getByTestId(`experiment-pending-${EXPERIMENT_FAILED.id}`)).toHaveText("まだ公開していません");
  });

  test("pausing an experiment removes it from the edge bootstrap", async ({ page }) => {
    // edge は 1 つの Site の settings / active / config を 60 秒 isolate キャッシュするため、
    // v1 を確認済みの `SITE` では v2 を観測できない。Pause 専用の Site を作り、bootstrap を 1 度だけ取る
    await login(page);
    await createSite(page, SITE_PAUSED);
    await createExperiment(page, EXPERIMENT_PAUSED);
    expect((await changeStatus(page, SITE_PAUSED.id, EXPERIMENT_PAUSED.id, /^開始/)).publish).toMatchObject({ ok: true, version: 1 });
    // B107・B66 b: 一時停止は確認を挟み、サイト全体を公開することを言う。キャンセルなら状態の要求を送らない
    let statusPosts = 0;
    const countPosts = (r: Request) => {
      if (r.method() === "POST" && r.url().includes(`/experiments/${EXPERIMENT_PAUSED.id}/status`)) statusPosts += 1;
    };
    page.on("request", countPosts);
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    const pauseDialog = page.getByRole("alertdialog", { name: "一時停止しますか?" });
    await expect(pauseDialog).toContainText("訪問者への配信がすぐに止まります");
    await expect(pauseDialog).toContainText("このサイト全体を公開します");
    await pauseDialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(pauseDialog).toHaveCount(0);
    page.off("request", countPosts);
    expect(statusPosts).toBe(0);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    expect((await changeStatus(page, SITE_PAUSED.id, EXPERIMENT_PAUSED.id, "一時停止")).publish).toMatchObject({ ok: true, version: 2 });
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "paused");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-published-status", "paused");

    const res = await fetch(`${STATIC_URL}/s/${SITE_PAUSED.id}.js`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("config v2, runtime ");
    expect(body).not.toContain(EXPERIMENT_PAUSED.id); // paused は compile の対象外(publish.ts の buildCompileInput)
  });

  test("goal_and_url_match_forms_save_page_match", async ({ page }) => {
    // 決定 49: 目標の PAGEVIEW と対象 URL は同じ「ページの一致」(既定 = パスで始まる)で保存する
    await login(page);
    await createSite(page, SITE_PAGE_MATCH);
    const nav = page.getByRole("navigation", { name: "メインメニュー" });
    await nav.getByRole("link", { name: "目標" }).click();
    await page.fill('input[name="id"]', "g_thanks");
    await page.fill('input[name="name"]', "Thanks");
    await page.fill('input[name="value"]', "/thanks");
    await page.getByRole("button", { name: "追加" }).click();
    await expect(page.getByRole("cell", { name: "パス が「/thanks」で始まる" })).toBeVisible();
    // 追加のフォームは読み直しの反映の後も最短の表示の間は覆われている(B173 第 2 段)。結果の文が出て覆いが外れてから次を入力する
    await expect(page.getByTestId("goal-add").getByRole("status")).toHaveText("追加しました");

    // B45: 目標の削除は押した瞬間に消えるので確認を挟む(キャンセルなら残る →「削除する」で消える)
    await page.fill('input[name="id"]', "g_tmp");
    await page.fill('input[name="name"]', "Temp goal");
    await page.fill('input[name="value"]', "/tmp");
    await page.getByRole("button", { name: "追加" }).click();
    const tmpRow = page.getByRole("row").filter({ hasText: "g_tmp" });
    await expect(tmpRow).toHaveCount(1);
    const goalDialog = page.getByRole("alertdialog", { name: "目標「Temp goal」を削除しますか?" });
    let goalDeletes = 0;
    const onRequest = (r: Request) => {
      if (r.method() === "DELETE" && /\/api\/control\/sites\/[^/]+\/goals\//.test(new URL(r.url()).pathname)) goalDeletes += 1;
    };
    page.on("request", onRequest);
    await tmpRow.getByRole("button", { name: "削除" }).click();
    await goalDialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(goalDialog).toBeHidden();
    await expect(tmpRow).toHaveCount(1);
    expect(goalDeletes).toBe(0); // キャンセルでは削除の要求を送らない
    await tmpRow.getByRole("button", { name: "削除" }).click();
    await goalDialog.getByRole("button", { name: "削除する" }).press("Enter");
    await expect(tmpRow).toHaveCount(0);
    // 覆いが外れる(一覧のカードの先頭に結果の文が出る)まで待ってから移る(覆いの間の移動は離れる前の確認で止まる。B173 第 2 段)
    await expect(page.getByTestId("goals-list").getByRole("status")).toHaveText("削除しました");
    expect(goalDeletes).toBe(1);
    page.off("request", onRequest);

    await nav.getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, { id: "exp_page_match", name: "Page match" });
    await nav.getByRole("link", { name: "エクスペリエンス" }).click();
    // B69: 編集画面にも対象 URL の要約(動かすページ・配信する相手)が同じ文で出るので、一覧の行で確かめる
    await expect(page.getByTestId("experiment-row-exp_page_match")).toContainText("パス が「/」で始まる");
  });

  test("regex_input_replaces_yen_and_notifies", async ({ page }) => {
    // 設計書 §10.4 の 4 / §15: 正規表現の値の ¥ と全角は入力のたびに置き換え、入力欄の下に知らせる
    await login(page);
    await openSite(page, SITE_PAGE_MATCH.name);
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "目標" }).click();
    await page.getByRole("combobox", { name: "一致の仕方" }).click();
    await page.getByRole("option", { name: "に一致(正規表現)" }).click();
    await page.fill('input[name="value"]', "^/thanks/¥d＋$");
    await expect(page.locator('input[name="value"]')).toHaveValue("^/thanks/\\d+$");
    await expect(page.getByRole("status").filter({ hasText: "¥ を \\ に置き換えました" })).toBeVisible();
  });

  test("picker_keyboard_and_regex_assist", async ({ page }) => {
    // 設計書 §12 のプルダウン部品(キーボードの ↓↑・Enter・Esc)と、§10.4 の 1〜3(箇所と書き換えの例・使える書き方・試す欄)
    await login(page);
    await openSite(page, SITE_PAGE_MATCH.name);
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "目標" }).click();
    const part = page.getByRole("combobox", { name: "照合する部分" });
    await part.focus();
    await page.keyboard.press("ArrowDown"); // 開く(選択中 = パス)
    await expect(page.getByRole("listbox", { name: "照合する部分" })).toBeVisible();
    await page.keyboard.press("ArrowDown"); // ホスト
    await page.keyboard.press("Enter");
    await expect(part).toHaveText(/ホスト/);
    await part.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox", { name: "照合する部分" })).toHaveCount(0);
    await part.click();
    await page.getByRole("option", { name: "パス" }).click();
    await page.getByRole("combobox", { name: "一致の仕方" }).click();
    await page.getByRole("option", { name: "に一致(正規表現)" }).click();
    await page.fill('input[name="value"]', "^/a{2,}");
    const alert = page.getByRole("alert").filter({ hasText: "上限の無い" });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "この形にする" }).click();
    await expect(page.locator('input[name="value"]')).toHaveValue("^/a{2,10}");
    await page.getByRole("button", { name: /使える書き方/ }).click();
    await page.getByLabel("試すパス").fill("/aa/b");
    await expect(page.getByRole("status").filter({ hasText: "一致します" })).toBeVisible();
    await page.getByLabel("試すパス").fill("/ab");
    await expect(page.getByRole("status").filter({ hasText: "一致しません" })).toBeVisible();
  });

  async function digestPublishSite(page: Page, id: string) {
    await login(page);
    await createSite(page, { id, name: id });
    await createExperiment(page, { id: "digest_exp", name: "Digest experience" });
    const res = await page.request.post(`/api/control/sites/${id}/experiments/digest_exp/status`, { headers: controlHeaders(), data: { status: "running" } });
    expect(res.status()).toBe(200);
    return page.url().replace(/\/experiments\/digest_exp$/, "");
  }

  test("publish sends the preview digest", async ({ page }) => {
    const sid = "site_digest_publish";
    const base = await digestPublishSite(page, sid);
    const preview = await (await page.request.get(`/api/control/sites/${sid}/publish-preview`)).json();
    await page.goto(`${base}/publish`);
    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/sites/${sid}/publish`));
    await page.getByRole("button", { name: /^公開する/ }).click();
    expect((await sent).postDataJSON()).toEqual({ expectDigest: preview.digest });
  });

  test("publish shows stale_preview and reloads", async ({ page }) => {
    const sid = "site_digest_stale";
    const base = await digestPublishSite(page, sid);
    await page.goto(`${base}/publish`);
    await waitForHydration(page);
    const saved = await page.request.patch(`/api/control/sites/${sid}/experiments/digest_exp`, { headers: controlHeaders(), data: { name: "Saved after preview" } });
    expect(saved.status()).toBe(200);
    await page.getByRole("button", { name: /^公開する/ }).click();
    await expect(page.getByTestId("publish-result")).toContainText("確認した後に、公開する内容が変わりました");
    await expect(page.getByTestId("publish-exp-digest_exp")).toContainText("Saved after preview");
  });

  test("external url mark is shown", async ({ page }) => {
    const sid = "site_digest_external";
    const base = await digestPublishSite(page, sid);
    const res = await page.request.put(`/api/control/sites/${sid}/experiments/digest_exp/variants/b/changes`, { headers: controlHeaders(), data: [{ id: "href", type: "ATTRIBUTE", selector: "a", payload: { name: "href", value: "https://external.example/path" } }] });
    expect(res.status()).toBe(200);
    await page.goto(`${base}/publish`);
    await expect(page.getByTestId("publish-exp-digest_exp")).toContainText("外部の URL を含む");
  });

  async function statusPair(page: Page, sid: string) {
    const base = await digestPublishSite(page, sid);
    expect((await page.request.post(`/api/control/sites/${sid}/experiments`, { headers: controlHeaders(), data: { id: "other", name: "Other experience", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } })).status()).toBe(201);
    expect((await page.request.post(`/api/control/sites/${sid}/experiments/other/status`, { headers: controlHeaders(), data: { status: "running" } })).status()).toBe(200);
    await page.goto(`${base}/experiments/other`);
    await waitForHydration(page);
    return base;
  }
  async function saveOtherCode(page: Page, sid: string) {
    expect((await page.request.put(`/api/control/sites/${sid}/experiments/digest_exp/variants/b/changes`, { headers: controlHeaders(), data: [{ id: "js", type: "CUSTOM_JS", selector: "body", payload: { code: "window.concurrent = true" } }] })).status()).toBe(200);
  }
  const pauseDialog = (page: Page) => page.getByRole("alertdialog", { name: "一時停止しますか?" });
  const stopDialog = (page: Page) => page.getByRole("alertdialog", { name: "終了して結果を記録します" });

  test("pause lists other unpublished changes and sends the digest", async ({ page }) => {
    const sid = "site_digest_pause";
    await statusPair(page, sid);
    await saveOtherCode(page, sid);
    const preview = page.waitForResponse((r) => r.url().includes(`/sites/${sid}/publish-preview?transition=other:paused`));
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    const digest = (await (await preview).json()).transitionDigest;
    await expect(pauseDialog(page)).toContainText("Digest experience");
    await expect(pauseDialog(page)).toContainText("コードを含む");
    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/experiments/other/status`));
    await pauseDialog(page).getByRole("button", { name: "一時停止する" }).press("Enter");
    expect((await sent).postDataJSON()).toEqual({ status: "paused", expectDigest: digest });
  });

  test("pause after a concurrent save asks again", async ({ page }) => {
    const sid = "site_digest_pause_stale";
    await statusPair(page, sid);
    let posts = 0, previews = 0;
    page.on("request", (r) => {
      if (r.url().includes(`/sites/${sid}/publish-preview`)) previews++;
      if (r.method() === "POST" && r.url().endsWith("/experiments/other/status")) posts++;
    });
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    await expect(pauseDialog(page)).toBeVisible();
    await saveOtherCode(page, sid);
    const rejected = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/experiments/other/status"));
    await pauseDialog(page).getByRole("button", { name: "一時停止する" }).press("Enter");
    expect((await rejected).status()).toBe(409);
    await expect(pauseDialog(page)).toContainText("確認の後に内容が変わりました。一覧を確かめて、もう一度押してください");
    await expect(pauseDialog(page)).toContainText("コードを含む");
    await pauseDialog(page).getByRole("button", { name: "一時停止する" }).press("Enter");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "paused");
    expect(posts).toBe(2); expect(previews).toBe(2);
  });

  test("stop after a concurrent save keeps the adoption input", async ({ page }) => {
    const sid = "site_digest_stop_stale";
    await statusPair(page, sid);
    await page.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
    const dialog = stopDialog(page);
    await expect(dialog.getByTestId("stop-options")).toBeVisible();
    await dialog.getByRole("radio", { name: /^B を採用/ }).check();
    await dialog.getByLabel("メモ(任意)").fill("keep this note");
    await saveOtherCode(page, sid);
    const rejected = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/experiments/other/status"));
    await dialog.getByRole("button", { name: "終了して記録" }).press("Enter");
    expect((await rejected).status()).toBe(409);
    await expect(dialog).toContainText("確認の後に内容が変わりました");
    await expect(dialog.getByRole("radio", { name: /^B を採用/ })).toBeChecked();
    await expect(dialog.getByLabel("メモ(任意)")).toHaveValue("keep this note");
    await expect(dialog).toContainText("コードを含む");
    await dialog.getByRole("button", { name: "終了して記録" }).press("Enter");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "archived");
  });

  test("status race shows not published banner", async ({ page }) => {
    const sid = "site_digest_status_race";
    const base = await statusPair(page, sid);
    await page.route("**/api/control/sites/*/experiments/other/status", async (route) => {
      const res = await route.fetch(); const body = await res.json();
      body.publish = { ok: false, version: null, error: "stale_preview", message: "確認した後に、公開する内容が変わりました" };
      await route.fulfill({ response: res, json: body });
    });
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    await pauseDialog(page).getByRole("button", { name: "一時停止する" }).press("Enter");
    const result = page.getByTestId("status-result");
    await expect(result).toContainText("状態は変わりましたが、確認の後に内容が変わったため公開していません");
    await expect(result.getByRole("link")).toHaveAttribute("href", `${new URL(base).pathname}/publish`);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("status change refuses to send without preview", async ({ page }) => {
    const sid = "site_digest_status_block";
    await statusPair(page, sid);
    let posts = 0;
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/experiments/other/status")) posts++; });
    await page.route("**/api/control/sites/*/publish-preview*", (route) => route.fulfill({ status: 500, json: {} }));
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    await expect(page.getByTestId("status-result")).toContainText("公開の確認を読み込めませんでした");
    expect(posts).toBe(0);
  });

  for (const from of ["header", "results tab"] as const) {
    test(`stop from the ${from} sends the digest`, async ({ page }) => {
      const sid = from === "header" ? "site_digest_stop_header" : "site_digest_stop_results";
      await statusPair(page, sid);
      if (from === "results tab") {
        await page.route("**/api/control/sites/*/experiments/other/results", async (route) => {
          const res = await route.fetch(); const body = await res.json();
          Object.assign(body, { phase: "fixed", collection: "enabled", quality: "ok", notes: [], variants: ["a", "b"].map((id) => ({ id, name: id.toUpperCase(), original: id === "a", weight: 50, n: 100, y: 10, cvr: 0.1, cvrCi95: [0, 1], diff: null, state: null, probBest: null, applyFailed: 0, applyRecovered: 0, minCountMet: null })) });
          await route.fulfill({ response: res, json: body });
        });
        await page.getByRole("tab", { name: /^結果/ }).click();
        await expect(page.getByTestId("results-tab")).toBeVisible();
      }
      let previews = 0;
      page.on("request", (r) => { if (r.url().includes(`/sites/${sid}/publish-preview`)) previews++; });
      if (from === "header") await page.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
      else await page.getByRole("button", { name: "採用なしで終了", exact: true }).click();
      const dialog = stopDialog(page);
      await expect(dialog.getByRole("button", { name: "終了して記録" })).toBeEnabled();
      const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/experiments/other/status"));
      await dialog.getByRole("button", { name: "終了して記録" }).press("Enter");
      expect((await sent).postDataJSON().expectDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(previews).toBe(1);
      await expect(dialog).toHaveCount(0);
      // 採用だけを変更するときは公開の確認を読まない。
      await page.getByRole("tab", { name: /^結果/ }).click();
      const adopt = page.getByTestId("results-adopt");
      await expect(adopt).toBeVisible();
      previews = 0;
      await adopt.click();
      const adoptionDialog = page.getByRole("alertdialog", { name: "採用を記録します" });
      await expect(adoptionDialog).toBeVisible();
      const adopted = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/experiments/other/adoption"));
      await adoptionDialog.getByRole("button", { name: "採用を記録", exact: true }).press("Enter");
      expect((await adopted).status()).toBe(200);
      await expect(adoptionDialog).toHaveCount(0);
      expect(previews).toBe(0);
      await page.unrouteAll({ behavior: "wait" });
    });
  }
  test("a start without an initial confirmation asks again after stale preview", async ({ page }) => {
    const sid = "site_digest_force_start";
    await login(page);
    await createSite(page, { id: sid, name: sid });
    const base = page.url();
    expect((await page.request.post(`/api/control/sites/${sid}/experiments`, { headers: controlHeaders(), data: { id: "solo", name: "Solo", kind: "single", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } })).status()).toBe(201);
    expect((await page.request.post(`/api/control/sites/${sid}/publish`, { headers: controlHeaders(), data: {} })).status()).toBe(200);
    await page.goto(`${base}/experiments/solo`);
    await waitForHydration(page);
    let posts = 0;
    await page.route(`**/api/control/sites/${sid}/experiments/solo/status`, async (route) => {
      posts++;
      if (posts === 1) await route.fulfill({ status: 409, json: { error: "stale_preview", message: "確認した後に、公開する内容が変わりました" } });
      else await route.continue();
    });
    await page.getByRole("button", { name: /^開始/ }).click();
    const dialog = page.getByRole("alertdialog", { name: "開始しますか?" });
    await expect(dialog).toContainText("確認の後に内容が変わりました");
    await dialog.getByRole("button", { name: "開始する", exact: true }).press("Enter");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    expect(posts).toBe(2);
    await page.unrouteAll({ behavior: "wait" });
  });

  test("stop refuses to send without preview", async ({ page }) => {
    const sid = "site_digest_stop_block";
    await statusPair(page, sid);
    await page.route("**/api/control/sites/*/publish-preview*", (route) => route.fulfill({ status: 500, json: {} }));
    await page.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
    const dialog = stopDialog(page);
    await expect(dialog).toContainText("公開の確認を読み込めませんでした");
    await expect(dialog.getByRole("button", { name: "終了して記録" })).toBeDisabled();
  });

  test("logout revokes the control session, not just the browser cookie", async ({ page, context }) => {
    await login(page);
    markSessionsAsGoogle(); // B112: 下でキーを発行する(パスワードのセッションからは発行できない)
    const session = (await context.cookies()).find((c) => c.name === "wtt_session");
    expect(session).toBeTruthy();

    // 決定 54 (11) / Review Focus 1: 発行したキーを控えずにログアウトしようとすると確認を挟む
    const issue = async (name: string) => {
      await page.goto("/w/me/api-keys");
      await waitForHydration(page);
      await page.fill('input[name="name"]', name);
      await pick(page, "範囲", new RegExp(`^${WORKSPACE_NAME}`));
      await pick(page, "権限", /^閲覧者/);
      await pick(page, "有効期限", /^1 日/);
      await page.getByRole("button", { name: "発行する" }).click();
      await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toBeFocused();
    };
    // 再読み込み・タブを閉じるの確認(beforeunload)が有効かを、取り消せる beforeunload を送って確かめる(ブラウザの確認の出方に依らない)
    const unloadIsCancelled = () =>
      page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    let unloadPrompts = 0;
    page.on("dialog", (d) => {
      if (d.type() === "beforeunload") unloadPrompts += 1;
      void d.accept();
    });
    let logoutPosts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/session/logout") logoutPosts += 1;
    });
    const logout = async () => {
      await page.getByTestId("user-menu").locator("summary").click();
      await page.getByRole("button", { name: "ログアウト" }).click();
    };
    const leave = page.getByRole("alertdialog", { name: "キーをまだ控えていません" });

    await issue("e2e-logout-guard-1");
    // 結果を出している間は再読み込み・タブを閉じるで確認が出る(リスナーは React の effect で付け外しするので、付くまで待つ)
    await expect.poll(unloadIsCancelled).toBe(true);
    await logout();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "戻って控える" }).press("Enter");
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/\/w\/me\/api-keys$/);
    // 戻った後は結果の見出しにフォーカスがある(ダイアログが閉じた後に移す。リンクに戻らない)
    await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toBeFocused();
    expect(logoutPosts).toBe(0); // 戻ればログアウトは送られない
    await page.getByRole("button", { name: "保管したので閉じる" }).click();
    await expect.poll(unloadIsCancelled).toBe(false); // 閉じれば確認は外れる

    await issue("e2e-logout-guard-2");
    await logout();
    await leave.getByRole("button", { name: "移動する" }).press("Enter");
    await expect(page).toHaveURL(/\/login$/);
    expect(logoutPosts).toBe(1); // 「移動する」で 1 回だけ送られる
    expect(unloadPrompts).toBe(0); // ログアウトの全画面の遷移で、ブラウザ標準の確認が二重に出ない

    // 盗まれたトークンを持っている状態を再現する: Cookie を戻しても control 側のセッションが失効していれば入れない
    // (Task 10 で見つかった「Cookie は消えるが control のセッションは 7 日間生きたまま」のリグレッション)
    await context.addCookies([session!]);
    await page.goto("/w");
    await expect(page).toHaveURL(/\/login$/);
  });
});

/**
 * 「保存(下書き)」を押し、Variant B の Change 全置換(`PUT …/variants/b/changes`)の応答を待つ。
 * 画面のバナーではなく BFF の応答を見るのは、成功時に `router.refresh()` が編集画面を作り直して
 * 一時メッセージを消してしまうため(= バナーを待つと競合する)
 */
async function saveDraft(page: Page, siteId: string, experimentId: string): Promise<Response> {
  const done = page.waitForResponse(
    (r) => r.url().includes(`/api/control/sites/${siteId}/experiments/${experimentId}/variants/b/changes`) && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存(下書き)" }).click();
  return done;
}

/** 実験の編集で Variant タブを開き、左の一覧から Variant を選ぶ(右に出るのは選んだ 1 つだけ) */
async function openVariant(page: Page, id: string): Promise<void> {
  await page.getByRole("tab", { name: "パターン" }).click();
  await page.getByTestId(`variant-pick-${id}`).click();
  await expect(page.getByTestId(`variant-${id}`)).toBeVisible();
}

async function verifySiteNamingPreview(page: Page, siteId: string) {
  await waitForHydration(page);
  const input = (name: string) => page.locator(`input[name="analytics.${name}"]`);
  const dataLayerName = input("dataLayerName");
  const extraKey = input("extraKey");
  const variantId = input("exposure.keys.variantId");
  const goalId = input("conversion.keys.goalId");
  const goalName = input("conversion.keys.goalName");
  const pushes = page.getByTestId("datalayer-preview");
  await expect(pushes).toHaveCount(4);

  const requests: string[] = [];
  const onRequest = (request: Request) => {
    if ([ADMIN_URL, CONTROL_URL].includes(new URL(request.url()).origin)) requests.push(request.url());
  };
  const rows = (index: number) => pushes.nth(index).locator(":scope > div");
  const expectBlankExtra = async (index: number, line: RegExp) => {
    const contents = await rows(index).allTextContents();
    expect(contents).toContainEqual(expect.stringMatching(line));
  };
  page.on("request", onRequest);
  try {
    await dataLayerName.fill("customLayer");
    await extraKey.fill("ab_info");
    await variantId.fill("ab_vid");
    for (let index = 0; index < 4; index += 1) {
      await expect(rows(index).first()).toHaveText("window.customLayer.push({");
    }
    await expect(pushes.nth(0)).toContainText("ab_info: null");
    await expect(pushes.nth(1)).toContainText("ab_vid:");
    await expect(pushes.nth(1)).toContainText("ab_info: {");
    await expect(pushes.nth(2)).toContainText("ab_info: null");
    await expect(pushes.nth(3)).toContainText('ab_error_type: "rate_limited"');

    await extraKey.fill("");
    await expect(pushes).toHaveCount(4);
    await expectBlankExtra(0, /^: null(?:\s|$)/);
    await expectBlankExtra(1, /^: \{$/);
    await expectBlankExtra(2, /^: null(?:\s|$)/);
    for (const push of await pushes.all()) {
      await expect(push).not.toContainText(/ab_info|ab_extra/);
    }
    await extraKey.fill("ab_info");

    await goalId.fill("x");
    await goalName.fill("x");
    await expect(rows(2).filter({ hasText: /^x:/ })).toHaveCount(2);
    await goalId.fill("ab_goal_id");
    await goalName.fill("ab_goal_name");
  } finally {
    page.off("request", onRequest);
  }
  expect(requests, "外部計測の名前を入力している間の admin・control への要求").toEqual([]);

  await test.step("wide preview stays on screen, narrow preview scrolls with the form", async () => {
    const viewport = page.viewportSize()!;
    const main = page.locator("main");
    const heading = page.getByRole("heading", { level: 3, name: /^出力される内容/ });
    const preview = heading.locator("../..");
    const layout = preview.locator("..");
    const scrollTo = (top: number) => main.evaluate((element, y) => (element.scrollTop = y, element.scrollTop), top);
    try {
      await page.setViewportSize({ width: 1400, height: 630 });
      await scrollTo(0);
      await expect(preview).toHaveCSS("position", "sticky");
      const original = (await heading.boundingBox())!;
      const previewStart = (await preview.boundingBox())!;
      const mainTop = (await main.boundingBox())!.y;
      expect(original.x).toBeGreaterThan((await dataLayerName.boundingBox())!.x);

      // 通常の配置なら見出しが隠れ、右の列が配置の下端に達する前の位置で確かめる。
      const wideScroll = await scrollTo(original.y - mainTop + 8);
      const afterScroll = (await layout.boundingBox())!;
      expect(original.y - wideScroll).toBeLessThan(mainTop);
      const stickyTop = mainTop + 16;
      expect(afterScroll.y + afterScroll.height).toBeGreaterThan(stickyTop + previewStart.height);
      await expect.poll(async () => Math.abs((await preview.boundingBox())!.y - stickyTop)).toBeLessThan(2);
      await expect(heading).toBeInViewport();

      const tip = heading.getByRole("button", { name: "出力される内容の補足" });
      // locator.hover() による自動スクロールを避け、固定された位置のまま吹き出しを開く。
      const trigger = (await tip.boundingBox())!;
      await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
      const tooltip = tip.getByRole("tooltip");
      await expect(tooltip).toHaveCSS("opacity", "1");
      expect(await main.evaluate((element) => element.scrollTop)).toBe(wideScroll);
      const bounds = (await main.boundingBox())!;
      const bubble = (await tooltip.boundingBox())!;
      expect(bubble.y, "固定された右列の補足の上端").toBeGreaterThanOrEqual(bounds.y);
      expect(bubble.y + bubble.height, "固定された右列の補足の下端").toBeLessThanOrEqual(bounds.y + bounds.height);

      await page.setViewportSize({ width: 550, height: 630 });
      await scrollTo(0);
      await expect(preview).toHaveCSS("position", "static");
      const stacked = (await heading.boundingBox())!;
      expect(stacked.y).toBeGreaterThan((await goalName.boundingBox())!.y);
      const start = await scrollTo(stacked.y - (await main.boundingBox())!.y - 30);
      await expect(heading).toBeInViewport();
      const before = (await heading.boundingBox())!.y;
      const end = await scrollTo(start + 200);
      expect(end - start).toBeGreaterThan(120);
      await expect.poll(async () => Math.abs((await heading.boundingBox())!.y - before + end - start)).toBeLessThan(2);
      await expect(heading).not.toBeInViewport();
    } finally {
      await page.setViewportSize(viewport);
    }
  });

  const patchPath = `/api/control/sites/${siteId}`;
  const settingsPath = new URL(page.url()).pathname;
  const save = page.getByRole("button", { name: "保存", exact: true });
  const isPatch = (request: Request) => request.method() === "PATCH" && new URL(request.url()).pathname === patchPath;
  const isRefresh = (request: Request) => {
    const url = new URL(request.url());
    return request.method() === "GET" && url.pathname === settingsPath && url.searchParams.has("_rsc") && !request.headers()["next-router-prefetch"];
  };

  await test.step("keep the draft during PATCH and after a delayed refresh", async () => {
    const patch = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<void>();
    const patchUrl = (url: URL) => url.pathname === patchPath;
    const refreshUrl = (url: URL) => url.pathname === settingsPath && url.searchParams.has("_rsc");
    await page.route(patchUrl, async (route) => {
      if (!isPatch(route.request())) return route.fallback();
      const response = await route.fetch();
      await patch.promise;
      await route.fulfill({ response });
    });
    await page.route(refreshUrl, async (route) => {
      if (!isRefresh(route.request())) return route.fallback();
      await refresh.promise;
      await route.continue();
    });

    try {
      await extraKey.fill("ab_b");
      const patchSent = page.waitForRequest(isPatch);
      const patchResponse = page.waitForResponse((response) => isPatch(response.request()));
      await save.click();
      await patchSent;
      await expect(extraKey).toBeDisabled();
      await expect(pushes.nth(0)).toContainText("ab_b: null");

      // PATCH 応答前に節を往復しても、無効な欄とプレビューに同じ名前が残る。
      const general = page.getByTestId("section-general");
      const naming = page.getByTestId("section-naming");
      await general.click();
      await expect(general).toHaveAttribute("aria-current", "page");
      await expect(pushes).toHaveCount(0);
      await naming.click();
      await expect(naming).toHaveAttribute("aria-current", "page");
      await expect(extraKey).toBeDisabled();
      await expect(extraKey).toHaveValue("ab_b");
      await expect(pushes.nth(0)).toContainText("ab_b: null");

      const refreshSent = page.waitForRequest(isRefresh);
      patch.resolve();
      expect((await patchResponse).status()).toBe(200);
      await refreshSent;
      await expect(extraKey).toBeEnabled();
      await extraKey.fill("ab_c");
      await expect(pushes.nth(0)).toContainText("ab_c: null");
      refresh.resolve();
      // value 属性(defaultValue)に B が届くまで待って、RSC が反映された後の欄とプレビューを確認する。
      await expect(extraKey).toHaveAttribute("value", "ab_b");
      await expect(extraKey).toHaveValue("ab_c");
      await expect(pushes.nth(0)).toContainText("ab_c: null");

      const second = page.waitForRequest(isPatch);
      const secondResponse = page.waitForResponse((response) => isPatch(response.request()));
      await save.click();
      expect((await second).postDataJSON()).toMatchObject({ analytics: { extraKey: "ab_c" } });
      expect((await secondResponse).status()).toBe(200);
      await expect(extraKey).toHaveAttribute("value", "ab_c");
    } finally {
      patch.resolve();
      refresh.resolve();
      await page.unroute(patchUrl);
      await page.unroute(refreshUrl);
    }
  });

  await dataLayerName.fill("dataLayer");
  await extraKey.fill("ab_extra");
  await variantId.fill("ab_variant_id");
  const restored = page.waitForResponse((response) => isPatch(response.request()));
  await save.click();
  expect((await restored).status()).toBe(200);
  await expect(extraKey).toHaveAttribute("value", "ab_extra");
}
