import { test, expect, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test";
import {
  ADMIN_URL,
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
  createExperiment,
  createSite,
  login,
  openSite,
  openWorkspace,
  setOwnerPassword,
} from "./fixtures";

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
    // Paid に変えて「月額 $5 に含まれる量と比べる」を外し、保存 → 再読み込み後も残る → Free に戻す
    const settings = page.getByTestId("usage-settings");
    await settings.getByRole("radio", { name: /^Paid/ }).check();
    await settings.getByRole("checkbox", { name: /月額 \$5 に含まれる量と比べる/ }).uncheck();
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.getByRole("status")).toHaveText("保存しました");
    await page.reload();
    await expect(page.getByTestId("usage-settings").getByRole("radio", { name: /^Paid/ })).toBeChecked();
    await expect(page.getByTestId("usage-settings").getByRole("checkbox", { name: /月額 \$5 に含まれる量と比べる/ })).not.toBeChecked();
    await waitForHydration(page);
    await page.getByTestId("usage-settings").getByRole("radio", { name: /^Free/ }).check();
    await page.getByTestId("usage-settings").getByRole("button", { name: "保存" }).click();
    await expect(page.getByTestId("usage-settings").getByRole("status")).toHaveText("保存しました");
    await expect(page.getByTestId("usage-unavailable")).toContainText("CF_USAGE_TOKEN");
    await page.goto("/w");
    await openWorkspace(page);

    // 画面表示(決定 54 (7)): ユーザーメニュー →「設定」→ 左ナビ「画面表示」。ダークを選ぶ → 再読み込み後も残る → システムに戻す
    // 「設定」はサイトの中のサイドバーにもあるので、ユーザーメニューの中に絞って押す
    await page.getByTestId("user-menu").locator("summary").click();
    await page.getByTestId("user-menu").getByRole("link", { name: "設定" }).click();
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
    await page.getByRole("link", { name: "設定" }).click();
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
    // (3) Deployment Mode(訪問者 ID の節)。D-lite は hosts が要るので保存はせず、dirty になることと、再読み込みで捨てられることだけを見る
    await page.getByTestId("section-identity").click();
    await expect(saveState).toHaveText("変更はありません");
    await pick(page, "導入の形", /^D-lite/);
    await expect(saveState).toHaveText("未保存の変更あり");
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

    // B14 / B42 / 決定 54 (11): 発行フォーム → 結果の置き換え → 移動時の確認 → 失効済みへ移る(サインイン予算を増やさないためこのテストに相乗り)
    const wid = page.url().match(/\/w\/([^/]+)\//)![1]!;
    await page.goto("/w/me/api-keys");
    await waitForHydration(page);
    const issueBtn = page.getByRole("button", { name: "発行する" });
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
    await leave.getByRole("button", { name: "移動する" }).click();
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
    await page.mouse.click(5, 5);
    await expect(revokeDialog).toBeHidden();
    await activeRow.getByRole("button", { name: "失効" }).click();
    await revokeDialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(revokeDialog).toBeHidden();
    await expect(activeRow.getByRole("button", { name: "失効" })).toBeEnabled(); // 有効な鍵の表に残る
    expect(revokeRequests).toBe(0); // キャンセルでは失効の要求を送らない
    await activeRow.getByRole("button", { name: "失効" }).click();
    await revokeDialog.getByRole("button", { name: "失効する" }).click();
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
    await page.getByRole("tab", { name: "外部計測" }).click();
    await page.getByRole("tab", { name: "概要" }).click();
    await expect(nameInput).toHaveValue("E2E hero (edited)");
    await page.getByRole("button", { name: "破棄" }).click();
    await expect(nameInput).toHaveValue(EXPERIMENT.name);
    await expect(page.getByTestId("save-state")).toHaveText("変更はありません");

    await openVariant(page, "b");
    const variantB = page.getByTestId("variant-b");
    // Plan 10 B1: Variant の Analytics 節は畳まれていない(見出しがクリック無しで見える)。Variant ID は prompt() ではなく inline 入力
    await expect(variantB.getByRole("heading", { name: "外部計測(このパターンの値)" })).toBeVisible();
    await expect(variantB.getByText("variantName の上書き(空 = 名前をそのまま)")).toBeVisible();
    await page.getByTestId("new-variant-id").fill("c");
    await page.getByRole("button", { name: "パターンを追加" }).click();
    await expect(page.getByTestId("variant-c")).toBeVisible();
    await expect(page.getByTestId("new-variant-id")).toHaveValue(""); // 追加後は入力欄が空に戻る
    // ID と表示名は別フィールド(r2 CX-Medium-4): ID は入力どおり `c`、名前の既定は ID の大文字化 `C`(ユーザー決定 2026-09-11)
    await expect(page.getByTestId("variant-c").locator("strong code")).toHaveText("c");
    await expect(page.getByTestId("variant-c").getByLabel("名前(100 字以内)")).toHaveValue("C");
    // 拒否経路(r1 CX-Medium-4 / CL-Medium-3): 形式違反と重複は理由を表示してボタンを無効にする
    await page.getByTestId("new-variant-id").fill("A");
    await expect(page.getByText("英小文字・数字で始まり")).toBeVisible();
    await expect(page.getByRole("button", { name: "パターンを追加" })).toBeDisabled();
    await page.getByTestId("new-variant-id").fill("b");
    await expect(page.getByText('パターン ID "b" は既に使われています')).toBeVisible();
    await expect(page.getByRole("button", { name: "パターンを追加" })).toBeDisabled();
    await page.getByTestId("new-variant-id").fill("");
    await page.getByTestId("variant-c").getByRole("button", { name: "パターンを削除" }).click();
    await expect(page.getByTestId("variant-c")).toHaveCount(0); // 以降の手順は A / B の 2 Variant のまま
    await openVariant(page, "b"); // 削除後は先頭の a が開くので b を開き直す

    // Variant B に TEXT Change を 1 件足して保存する
    await variantB.getByRole("button", { name: "変更を追加" }).click();
    const change = variantB.getByTestId("change-TEXT");
    await change.locator('input[maxlength="500"]').fill(HERO_SELECTOR);
    await change.locator("textarea").fill(HERO_TEXT);
    expect((await saveDraft(page, SITE.id, EXPERIMENT.id)).status()).toBe(200);
    // router.refresh() の着地 = 本体が作り直され、保存バーが「変更はありません」に戻る。それを待ってから見る
    // (待たずに見ると、保存前から出ている要素で通ってしまい、保持を証明しない)
    await expect(page.getByTestId("save-state")).toHaveText("変更はありません");
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
    // (lib/change-wire.ts が落とす。Task 12 で実地確認された壊れ方のリグレッション)
    expect((await saveDraft(page, SITE.id, EXPERIMENT.id)).status()).toBe(200);
    await expect(appAlert(page)).toHaveCount(0);

    // Start は必ず自動 Publish を伴う(spec §13.8 / 決定 17)
    const started = await changeStatus(page, SITE.id, EXPERIMENT.id, /^開始/);
    expect(started.publish).toMatchObject({ ok: true, version: 1 });
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-published-status", "running");

    // 公開履歴は独立した画面。いま配信中の 1 行は activeVersion で決まる
    await page.getByRole("link", { name: "公開履歴" }).click();
    await expect(page.getByTestId("publish-row-1")).toContainText("配信中");
    // Publish の確認画面: 変更が無くても開ける。上部バーの Publish は副ボタンに戻っている。
    // この secondary は Start 後に StatusButtons が呼ぶ「同じ経路での router.refresh()」の結果でしかありえない:
    // ここまでの 2 回の遷移(公開履歴のリンクと上部バーの Publish リンク)はどちらもクライアント遷移で、
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
    expect(body).toContain('"variantName":"B"'); // exposurePayloads(spec §10.9)
  });

  test("attribute_not_allowed shows a Japanese message and the HTML switch hint", async ({ page }) => {
    await login(page);
    await openSite(page, SITE.name);
    // 状態の絞り込み: 取得済みの一覧を画面の中で絞るだけ(再読み込みしない)
    await page.getByTestId("filter-draft").click();
    await expect(page.getByTestId(`experiment-row-${EXPERIMENT.id}`)).toHaveCount(0);
    await expect(page).toHaveURL(/\?status=draft$/);
    await page.getByTestId("filter-running").click();
    await expect(page.getByTestId(`experiment-row-${EXPERIMENT.id}`)).toBeVisible();
    await page.getByRole("link", { name: EXPERIMENT.name }).click();
    await openVariant(page, "a");
    const variantA = page.getByTestId("variant-a");
    await variantA.getByRole("button", { name: "変更を追加" }).click();
    await pick(variantA.getByTestId("change-TEXT"), "変更の種類", /^ATTRIBUTE/);
    const attribute = variantA.getByTestId("change-ATTRIBUTE");
    await attribute.locator('input[maxlength="500"]').fill("a.cta");
    await attribute.locator('input[list="attr-allow"]').fill("onclick");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    // 封筒の message は control が出す日本語(機械可読コードをそのまま画面に出さない。spec §13.5)
    await expect(appAlert(page)).toContainText("属性 onclick は ATTRIBUTE では設定できません");
    await expect(page.getByRole("button", { name: "HTML タイプに切り替える" })).toBeVisible();
  });

  test("a failed publish keeps its alert on screen (決定 17)", async ({ page }) => {
    // 決定 17: Publish が失敗しても status 変更は成功しているので HTTP 200 で返し、**UI がアラートで知らせる**。
    // その保証は「メッセージが読める状態で残る」ところまで含む(Task 13 で、`router.refresh()` による
    // 編集画面の再マウントがアラートを即座に消していたのを実測して修正した)
    await login(page);
    await createSite(page, SITE_FAILED);
    await createExperiment(page, EXPERIMENT_FAILED);

    // compile を config_too_large(512KiB 超)で落とす。1 件あたりは 64KiB 未満なので保存時検証は通り、
    // 束ねたときだけ落ちる。60KiB のテキストを 10 回 UI に打ち込む意味は無いので、画面と同じ BFF に直接置く。
    // Variant ごとに 5 件ずつに割るのは「A / B 両方に Change がある状態」を作るためで、件数の制約ではない
    // (かつては `PUT …/changes` が 1 行 12 個の bind 変数を使う単一の複数行 INSERT で、9 件以上が D1 の
    // 「1 クエリ 100 変数」上限に当たって 500 になっていた。d51c5db で 8 行ずつに分割して解消済み)
    const bigChanges = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => ({ id: `${prefix}${i}`, type: "TEXT", selector: `.${prefix}${i}`, payload: { text: "x".repeat(60_000) } }));
    for (const variant of ["a", "b"]) {
      const seeded = await page.request.put(`/api/control/sites/${SITE_FAILED.id}/experiments/${EXPERIMENT_FAILED.id}/variants/${variant}/changes`, { data: bigChanges(`c_big${variant}`) });
      expect(seeded.status()).toBe(200);
    }

    const started = await changeStatus(page, SITE_FAILED.id, EXPERIMENT_FAILED.id, /^開始/);
    expect(started.publish).toMatchObject({ ok: false, error: "config_too_large" });
    // status は running に進み、本番は「未反映」のまま = router.refresh() が着地したことの目印
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-published-status", "none");
    // その refresh を挟んでもアラートが残っている
    await expect(appAlert(page)).toContainText("公開に失敗しました");
    await expect(appAlert(page)).toContainText("config_too_large");
  });

  test("pausing an experiment removes it from the edge bootstrap", async ({ page }) => {
    // edge は 1 つの Site の settings / active / config を 60 秒 isolate キャッシュするため、
    // v1 を確認済みの `SITE` では v2 を観測できない。Pause 専用の Site を作り、bootstrap を 1 度だけ取る
    await login(page);
    await createSite(page, SITE_PAUSED);
    await createExperiment(page, EXPERIMENT_PAUSED);
    expect((await changeStatus(page, SITE_PAUSED.id, EXPERIMENT_PAUSED.id, /^開始/)).publish).toMatchObject({ ok: true, version: 1 });
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
    await goalDialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(goalDialog).toBeHidden();
    await expect(tmpRow).toHaveCount(1);
    expect(goalDeletes).toBe(0); // キャンセルでは削除の要求を送らない
    await tmpRow.getByRole("button", { name: "削除" }).click();
    await goalDialog.getByRole("button", { name: "削除する" }).click();
    await expect(tmpRow).toHaveCount(0);
    expect(goalDeletes).toBe(1);
    page.off("request", onRequest);

    await nav.getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, { id: "exp_page_match", name: "Page match" });
    await nav.getByRole("link", { name: "エクスペリエンス" }).click();
    await expect(page.getByText("パス が「/」で始まる")).toBeVisible();
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

  test("logout revokes the control session, not just the browser cookie", async ({ page, context }) => {
    await login(page);
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
    await leave.getByRole("button", { name: "戻って控える" }).click();
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/\/w\/me\/api-keys$/);
    // 戻った後は結果の見出しにフォーカスがある(ダイアログが閉じた後に移す。リンクに戻らない)
    await expect(page.getByRole("heading", { name: "API キーを発行しました" })).toBeFocused();
    expect(logoutPosts).toBe(0); // 戻ればログアウトは送られない
    await page.getByRole("button", { name: "保管したので閉じる" }).click();
    await expect.poll(unloadIsCancelled).toBe(false); // 閉じれば確認は外れる

    await issue("e2e-logout-guard-2");
    await logout();
    await leave.getByRole("button", { name: "移動する" }).click();
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
