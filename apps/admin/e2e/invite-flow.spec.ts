import { test, expect, type Request } from "@playwright/test";
import { ADMIN_URL, EXPERIMENT, OWNER_EMAIL, PASSWORD, SITE, WORKSPACE_NAME, login, openWorkspace, pick, waitForHydration } from "./fixtures";

/**
 * 招待で入った EDITOR の境界(spec §13.2 決定 13)。
 * 「作成」はできて「本番化」はできない ―― UI で隠すだけでなく API 自身が 403 で断ることを確かめる。
 * publish-flow が作った owner / Workspace / Site / 実験に乗る(playwright.config.ts の projects dependencies で順序を固定)。
 * 招待の取り消し(backlog B24)と、再発行の扱い・期限の表示(backlog B28)も、同じログイン済みの流れの中で確かめる。
 * システム管理者の昇格・印・降格(backlog B36)も、同じログイン済みの流れの中で確かめる。
 * 招待リンク・リセットリンクの発行結果のカード(backlog B47)も、同じログイン済みの流れの中で確かめる。
 */
test("invited editor can edit but cannot publish; the API refuses status changes with 403", async ({ browser, page }) => {
  await login(page);
  await openWorkspace(page);
  await page.getByRole("link", { name: "メンバー", exact: true }).click(); // 「メンバーの API キー」と区別する
  await page.fill('input[name="email"]', "editor@e2e.example");
  await pick(page, "ロール", /^編集者/);
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  // メールは自動送信しないので、発行された URL を画面から拾って渡す(spec §13.3)。
  // 結果は API キーの発行結果と同じ見出し付きのカードで出し、見出しにフォーカスを移す(backlog B47)
  const issuedInvite = page.getByTestId("issued-invite");
  await expect(issuedInvite.getByRole("heading", { name: "招待リンクを発行しました" })).toBeFocused();
  await expect(issuedInvite).toContainText("メールは自動送信されません");
  await expect(issuedInvite.getByRole("button", { name: "リンクをコピー" })).toBeVisible();
  const url = await issuedInvite.getByTestId("code-block").textContent();
  expect(url).toMatch(/\/invite\//);
  // 移動の確認は付けない(B47 (a))。閉じても招待中の一覧からリンクを控えられる
  await issuedInvite.getByRole("button", { name: "閉じる" }).click();
  await expect(issuedInvite).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "editor@e2e.example" })).toContainText(url!);

  // 招待の取り消し(backlog B24)。ログイン済みのこの流れに相乗りする(sign-in の予算を増やさない。fixtures.ts の内訳参照)
  const canceled = "canceled@e2e.example";
  await page.fill('input[name="email"]', canceled);
  await pick(page, "ロール", /^閲覧者/);
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  const row = () => page.getByRole("row").filter({ hasText: canceled });
  await expect(row()).toHaveCount(1);
  await row().getByRole("button", { name: "取り消す" }).click();
  await page.getByRole("alertdialog", { name: `${canceled} への招待を取り消しますか?` }).getByRole("button", { name: "招待を取り消す" }).click();
  await expect(row()).toHaveCount(0);

  // 招待の再発行と期限の表示(backlog B28)。同じログイン済みの流れに相乗りする
  const editorRow = page.getByRole("row").filter({ hasText: "editor@e2e.example" });
  await expect(editorRow).toContainText(/\d+\/\d+ \d+:\d+ まで/); // 期限の列: 日付と時刻
  await expect(editorRow).toContainText(/あと \d+ 日/); // と残り
  await editorRow.getByRole("button", { name: "期限を延ばす" }).click();
  // 延長の結果も同じカードで、見出しだけ変える(B47 (b))
  const extendedCard = page.getByTestId("issued-invite");
  await expect(extendedCard.getByRole("heading", { name: "招待の期限を延ばしました" })).toBeFocused();
  await expect(extendedCard).toContainText("リンクは変わっていません");
  await expect(extendedCard.getByTestId("code-block")).toHaveText(url!); // リンクは変わらない
  // 違う Role での再招待は断られ、理由と直し方が招待フォームのそば(招待セクション内)に出る。
  // 上部の ErrorBox には出さない(B28: 発行に失敗したら古い「延ばしました」も消す)
  await page.fill('input[name="email"]', "editor@e2e.example");
  await pick(page, "ロール", /^閲覧者/);
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  const inviteSection = page.locator(".invite-section");
  await expect(inviteSection.getByRole("alert")).toContainText("既に編集者で招待済みです");
  await expect(inviteSection.getByRole("alert")).toContainText("取り消してから発行し直して");
  await expect(page.getByTestId("issued-invite")).toHaveCount(0);

  // メンバーのリセットリンク(非常用)の結果も同じ形のカード。移動の確認は付けない(B47 (c))。
  // セッションの API なので無認証 POST の予算(fixtures.ts)は使わない。発行するだけでパスワードは変わらない
  await page.getByRole("row").filter({ hasText: OWNER_EMAIL }).getByRole("button", { name: "リセットリンク" }).click();
  const issuedReset = page.getByTestId("issued-reset-link");
  await expect(issuedReset.getByRole("heading", { name: "リセットリンクを発行しました" })).toBeFocused();
  await expect(issuedReset).toContainText("1 回限り");
  await expect(issuedReset.getByTestId("code-block")).toContainText("/reset?token=");
  await issuedReset.getByRole("button", { name: "控えたので閉じる" }).click();
  await expect(issuedReset).toHaveCount(0);

  // 未ログインの別コンテキストで招待を受ける
  const ctx = await browser.newContext({ baseURL: ADMIN_URL });
  const editor = await ctx.newPage();
  await editor.goto(url!);
  // break-glass が開いているので非常用のパスワードフォームも出る。まず通常経路(Google)の導線を確認する
  await expect(editor.getByRole("link", { name: "Google でログインして参加" })).toHaveAttribute("href", /\/api\/session\/google\?next=%2Finvite%2F/);
  await editor.fill('input[name="name"]', "Ed");
  await editor.fill('input[name="password"]', PASSWORD);
  await editor.getByRole("button", { name: "参加する" }).click();
  await expect(editor).toHaveURL(/\/w\/[^/]+$/);

  await editor.getByRole("link", { name: SITE.name }).click();
  await editor.getByRole("link", { name: EXPERIMENT.name }).click();
  // 編集はできる(Code Change を含む下書きは EDITOR の権限)が、Start / Pause / Stop は出ない。
  // この実験は running なので、ADMIN なら「Pause」が出る位置に注記だけが出ることを見る
  await expect(editor.getByRole("button", { name: "保存(下書き)" })).toBeVisible();
  await expect(editor.getByText("開始・一時停止・終了(本番化)は管理者以上が行います")).toBeVisible();
  await expect(editor.getByRole("button", { name: "一時停止" })).toHaveCount(0);

  // UI の出し分けに頼らず、BFF 経由で直接叩いても 403(spec §13.2)
  const res = await editor.request.post(`/api/control/sites/${SITE.id}/experiments/${EXPERIMENT.id}/status`, { data: { status: "running" } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ error: "forbidden", required: "admin" });

  // 決定 54 (7): ユーザーメニュー = 設定 / ログアウト。システム管理者でない人の設定には「システム」の節が出ず、API でも作れない
  // 編集者はこの時点でサイトの中(サイドバーにもサイトの「設定」がある)にいるので、ユーザーメニューの中に絞って押す
  await editor.getByTestId("user-menu").locator("summary").click();
  await editor.getByTestId("user-menu").getByRole("link", { name: "設定" }).click();
  const editorNav = editor.getByRole("navigation", { name: "メインメニュー" });
  await expect(editorNav.getByRole("link", { name: "API キー" })).toBeVisible();
  await expect(editorNav.getByRole("link", { name: "画面表示" })).toBeVisible();
  await expect(editorNav.getByRole("link", { name: "システム管理者" })).toHaveCount(0);
  await expect(editorNav.getByRole("link", { name: "ワークスペース", exact: true })).toHaveCount(0);
  const created = await editor.request.post("/api/control/workspaces", { data: { name: "By editor" } });
  expect(created.status()).toBe(403);

  // B45: ロールは選んだ瞬間に反映されるので確認を挟む。キャンセルなら変わらない →「変更する」で変わる(この後の流れのため編集者に戻す)
  await openWorkspace(page);
  await page.getByRole("link", { name: "メンバー", exact: true }).click();
  await waitForHydration(page);
  const edRow = page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" });
  const roleDialog = page.getByRole("alertdialog", { name: "Ed のロールを変更しますか?" });
  let rolePatches = 0;
  const onRequest = (r: Request) => {
    if (r.method() === "PATCH" && /\/api\/control\/workspaces\/[^/]+\/members\//.test(new URL(r.url()).pathname)) rolePatches += 1;
  };
  page.on("request", onRequest);
  await pick(page, "Ed のロール", /^閲覧者/);
  await expect(roleDialog).toContainText("「編集者」から「閲覧者」に変更します");
  await roleDialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(roleDialog).toBeHidden();
  await expect(edRow.getByRole("combobox")).toContainText("編集者");
  expect(rolePatches).toBe(0); // キャンセルでは変更の要求を送らない
  await pick(page, "Ed のロール", /^閲覧者/);
  await roleDialog.getByRole("button", { name: "変更する" }).click();
  await expect(edRow.getByRole("combobox")).toContainText("閲覧者");
  expect(rolePatches).toBe(1);
  page.off("request", onRequest);
  await pick(page, "Ed のロール", /^編集者/);
  await roleDialog.getByRole("button", { name: "変更する" }).click();
  await expect(edRow.getByRole("combobox")).toContainText("編集者");

  // B36: オーナー(= 初回セットアップの人 = システム管理者)が editor をシステム管理者にする → メンバー画面に印 → 外す。
  // ログイン済みのこの流れに相乗りする(sign-in の予算を増やさない。fixtures.ts の内訳参照)
  await page.getByTestId("user-menu").locator("summary").click();
  await page.getByTestId("user-menu").getByRole("link", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "システム管理者" }).click();
  await expect(page).toHaveURL(/\/w\/me\/instance-admins$/);
  const adminRows = page.getByTestId("instance-admins").getByRole("row");
  await expect(adminRows.filter({ hasText: OWNER_EMAIL })).toHaveCount(1);
  await expect(adminRows.filter({ hasText: OWNER_EMAIL }).getByRole("button", { name: "システム管理者から外す" })).toBeDisabled(); // 最後の 1 人
  // B41 (2): 追加はメンバーから選ぶ(各行に参加しているワークスペースとロール)
  await expect(page.getByRole("button", { name: "システム管理者にする" })).toBeDisabled();
  await page.getByRole("combobox", { name: "追加するメンバー" }).click();
  await page.getByRole("option", { name: /editor@e2e\.example/ }).click();
  await page.getByRole("button", { name: "システム管理者にする" }).click();
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(1);

  await openWorkspace(page);
  await page.getByRole("link", { name: "メンバー", exact: true }).click(); // 「メンバーの API キー」と区別する
  const edMember = page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" });
  await expect(edMember).toContainText("システム管理者");
  await expect(edMember.getByRole("combobox")).toBeDisabled();
  await expect(edMember.getByRole("button", { name: "外す" })).toHaveCount(0);

  // B46: editor が自分のブラウザで自分を外す。開く経路は上の決定 54 (7) と同じ(ユーザーメニュー →「設定」→「システム管理者」)
  await editor.goto("/w"); // 昇格の後に開き直す(設定のメニューに「システム管理者」が出る)
  await editor.getByTestId("user-menu").locator("summary").click();
  await editor.getByTestId("user-menu").getByRole("link", { name: "設定" }).click();
  await editor.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "システム管理者" }).click();
  await expect(editor).toHaveURL(/\/w\/me\/instance-admins$/);
  await editor.getByTestId("instance-admins").getByRole("row").filter({ hasText: "editor@e2e.example" }).getByRole("button", { name: "システム管理者から外す" }).click();
  const demoteDialog = editor.getByRole("alertdialog", { name: "自分をシステム管理者から外しますか?" });
  // 戻るワークスペースとロールが出る。この時点のワークスペースは WORKSPACE_NAME だけ(E2E Temp はこの後に作る)なので、外れる側は無い
  await expect(demoteDialog).toContainText(`${WORKSPACE_NAME}(編集者)`);
  await demoteDialog.getByRole("button", { name: "外す" }).click();
  await expect(editor).toHaveURL(/\/w$/); // 全画面で /w へ移る(戻ったワークスペースがあるのでログインしたまま)
  // 昇格前に編集者だったワークスペースでは、編集者として使い続けられる(すべてを失わない)
  await openWorkspace(editor);
  await expect(editor.getByRole("link", { name: SITE.name })).toBeVisible();
  // オーナーの画面でも、editor の行は編集者に戻り、システム管理者の一覧から消えている
  await openWorkspace(page);
  await page.getByRole("link", { name: "メンバー", exact: true }).click();
  await expect(page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" }).getByRole("combobox")).toContainText("編集者");
  await page.goto(`${ADMIN_URL}/w/me/instance-admins`);
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(0);

  // B46 K11 / K12: もう一度 editor をシステム管理者にし(上の昇格と同じ手順)、チェックボックスで元のロールに戻さず完全に外す
  await page.getByTestId("user-menu").locator("summary").click();
  await page.getByTestId("user-menu").getByRole("link", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "システム管理者" }).click();
  await expect(page).toHaveURL(/\/w\/me\/instance-admins$/);
  await page.getByRole("combobox", { name: "追加するメンバー" }).click();
  await page.getByRole("option", { name: /editor@e2e\.example/ }).click();
  await page.getByRole("button", { name: "システム管理者にする" }).click();
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(1);
  await adminRows.filter({ hasText: "editor@e2e.example" }).getByRole("button", { name: "システム管理者から外す" }).click();
  const fullDialog = page.getByRole("alertdialog", { name: "editor@e2e.example をシステム管理者から外しますか?" });
  // チェックの前は元のロールに戻る説明、チェックの後は目立つ注意に差し替わり、ボタンも結果を表す文言になる
  await expect(fullDialog).toContainText("システム管理者になる前のロールに戻ります");
  await fullDialog.getByRole("checkbox", { name: "元のロールに戻さず、すべてのワークスペースから外す" }).check();
  await expect(fullDialog.getByTestId("confirm-option-warning")).toContainText("元のロールには戻さず、次のすべてのワークスペースから外れます");
  await expect(fullDialog).not.toContainText("システム管理者になる前のロールに戻ります");
  await fullDialog.getByRole("button", { name: "すべてから外す" }).click();
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(0);
  // 元のロールにも戻らない = オーナーのメンバー画面に editor の行が無い
  await openWorkspace(page);
  await page.getByRole("link", { name: "メンバー", exact: true }).click();
  await expect(page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" })).toHaveCount(0);
  // 最後の 1 人は API でも外せない
  const me = (await (await page.request.get(`${ADMIN_URL}/api/control/me`)).json()) as { id: string };
  expect((await page.request.delete(`${ADMIN_URL}/api/control/instance-admins/${me.id}`)).status()).toBe(409);

  // 決定 54 (10): 設定 > ワークスペース。ホームの「新しいワークスペース」から作成の欄へ → 作る → 削除の確認で名前を打ち込んで消す
  await page.goto(`${ADMIN_URL}/w`);
  await waitForHydration(page);
  await page.getByRole("link", { name: "新しいワークスペース" }).click();
  await expect(page).toHaveURL(/\/w\/me\/workspaces\?new=1$/);
  await expect(page.locator('form#new input[name="name"]')).toBeFocused();
  const adminTable = page.getByTestId("workspaces-admin");
  // 配信中のエクスペリエンスがあるワークスペースは消せない(理由が出る)
  await expect(adminTable.getByRole("row").filter({ hasText: WORKSPACE_NAME }).getByRole("button", { name: "削除" })).toBeDisabled();
  await expect(adminTable.getByRole("row").filter({ hasText: WORKSPACE_NAME })).toContainText("配信中のエクスペリエンスが");
  await page.locator('form#new input[name="name"]').fill("E2E Temp");
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/);
  const tempId = page.url().match(/\/w\/([^/]+)$/)![1]!;
  await page.goto(`${ADMIN_URL}/w/me/workspaces`);
  await waitForHydration(page);
  await adminTable.getByRole("row").filter({ hasText: "E2E Temp" }).getByRole("button", { name: "削除" }).click();
  const confirmBox = page.getByRole("group", { name: "「E2E Temp」の削除の確認" });
  await expect(confirmBox.getByRole("button", { name: "削除する" })).toBeDisabled();
  await confirmBox.getByRole("textbox").fill("E2E Tem"); // 1 字足りない = 押せない
  await expect(confirmBox.getByRole("button", { name: "削除する" })).toBeDisabled();
  await confirmBox.getByRole("textbox").fill("E2E Temp");
  // Review Focus 3(r1 CX-Medium-3 / CL-Medium-7): 確認欄を開いた後に、別の操作でエクスペリエンスが開始された
  // = 画面はまだ押せる状態のまま、押した時点でサーバーが 409 を返す。BFF から直接作って開始する(ログインは増やさない)
  const ctl = (path: string, data: unknown) => page.request.post(`${ADMIN_URL}/api/control${path}`, { data });
  expect((await ctl(`/workspaces/${tempId}/sites`, { name: "E2E Temp Site", domain: "temp.e2e.example", id: "site_e2e_temp" })).status()).toBe(201);
  expect((await ctl("/sites/site_e2e_temp/experiments", { id: "exp_e2e_temp", name: "E2E temp", urlMatch: { op: "contains", value: "/" } })).status()).toBe(201);
  expect((await ctl("/sites/site_e2e_temp/experiments/exp_e2e_temp/status", { status: "running" })).status()).toBe(200);
  await confirmBox.getByRole("button", { name: "削除する" }).click();
  await expect(confirmBox.getByRole("alert")).toContainText("配信中のエクスペリエンスがあります"); // サーバーの 409 の文がその行に出る
  await expect(adminTable.getByRole("row").filter({ hasText: "E2E Temp" }).first()).toBeVisible(); // 行は消えない
  // 終了させてから、同じ確認欄で削除し直す
  expect((await ctl("/sites/site_e2e_temp/experiments/exp_e2e_temp/status", { status: "archived" })).status()).toBe(200);
  await confirmBox.getByRole("button", { name: "削除する" }).click();
  await expect(adminTable.getByRole("row").filter({ hasText: "E2E Temp" })).toHaveCount(0);
  await ctx.close();
});
