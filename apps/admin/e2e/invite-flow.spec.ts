import { test, expect, type Request } from "@playwright/test";
import { ADMIN_URL, EXPERIMENT, OWNER_EMAIL, SITE, WORKSPACE_NAME, acceptInvite, controlHeaders, issueInvite, login, openMembers, openSettings, openWorkspace, pick, waitForHydration } from "./fixtures";

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
  await openMembers(page);
  // メールは自動送信しないので、発行された URL を画面から拾って渡す(spec §13.3。issueInvite)。
  // 結果は API キーの発行結果と同じ見出し付きのカードで出し、見出しにフォーカスを移す(backlog B47)
  const url = await issueInvite(page, "editor@e2e.example", /^編集者/);
  const issuedInvite = page.getByTestId("issued-invite");
  await expect(issuedInvite.getByRole("heading", { name: "招待リンクを発行しました" })).toBeFocused();
  await expect(issuedInvite).toContainText("メールは自動送信されません");
  await expect(issuedInvite.getByRole("button", { name: "リンクをコピー" })).toBeVisible();
  // 移動の確認は付けない(B47 (a))。閉じても招待中の一覧からリンクを控えられる
  await issuedInvite.getByRole("button", { name: "閉じる" }).click();
  await expect(issuedInvite).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "editor@e2e.example" })).toContainText(url);

  // 招待の取り消し(backlog B24)。ログイン済みのこの流れに相乗りする(sign-in の予算を増やさない。fixtures.ts の内訳参照)
  const canceled = "canceled@e2e.example";
  await page.fill('input[name="email"]', canceled);
  await pick(page, "ロール", /^閲覧者/);
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  const row = () => page.getByRole("row").filter({ hasText: canceled });
  await expect(row()).toHaveCount(1);
  await row().getByRole("button", { name: "取り消す" }).click();
  await page.getByRole("alertdialog", { name: `${canceled} への招待を取り消しますか?` }).getByRole("button", { name: "招待を取り消す" }).press("Enter");
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
  await expect(extendedCard.getByTestId("code-block")).toHaveText(url); // リンクは変わらない
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

  // 未ログインの別コンテキストで招待を受ける(acceptInvite は、通常経路(Google)の導線が出ていることも確かめてからパスワードで参加する)
  const { ctx, page: editor } = await acceptInvite(browser, url, "Ed");

  // B60 Task 8: 編集者(管理者未満)のホームのカードには「メンバー」が出ない(数もリンクも)
  await editor.goto("/w");
  const editorCard = editor.getByTestId("workspace-card");
  await expect(editorCard.getByRole("link", { name: SITE.name })).toBeVisible();
  await expect(editorCard.getByRole("link", { name: /メンバー/ })).toHaveCount(0);
  await expect(editorCard).not.toContainText("メンバー");
  await editor.getByRole("link", { name: SITE.name }).click();
  await editor.getByRole("link", { name: EXPERIMENT.name }).click();
  // 編集はできる(Code Change を含む下書きは EDITOR の権限)が、Start / Pause / Stop は出ない。
  // この実験は running なので、ADMIN なら「Pause」が出る位置に注記だけが出ることを見る
  await expect(editor.getByRole("button", { name: "保存(下書き)" })).toBeVisible();
  await expect(editor.getByText("開始・一時停止・終了(本番化)は管理者以上が行います")).toBeVisible();
  await expect(editor.getByRole("button", { name: "一時停止" })).toHaveCount(0);
  // B31 ②: 上部バーの「公開」は押せず、理由は見える文で添える(title だけにしない)。ボタンはその文を説明として指す
  await expect(editor.locator("#topbar-publish-reason")).toHaveText("公開は管理者以上が行います");
  await expect(editor.getByTestId("topbar-publish")).toBeDisabled();
  await expect(editor.getByTestId("topbar-publish")).toHaveAttribute("aria-describedby", "topbar-publish-reason");
  // B60 D6: 狭い幅(900px)でも上部バーのパンくずと右側(版の札・理由の文・公開)が重ならない。縮むのはパンくずの側で、
  // 右端が右側の左端を越えず、パンくずの中身も箱からはみ出さない(各項目が省略表示で縮む)。
  // 編集者は理由の文が付くぶん右側が最も広いので、ここで見る
  {
    const viewport = editor.viewportSize()!;
    await editor.setViewportSize({ width: 900, height: 700 });
    const crumbs = editor.getByTestId("topbar-crumbs");
    const crumbsBox = (await crumbs.boundingBox())!;
    const stateBox = (await editor.getByTestId("topbar-state").boundingBox())!;
    expect(crumbsBox.x + crumbsBox.width).toBeLessThanOrEqual(stateBox.x);
    expect(await crumbs.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // B140: 「サイト ID」の印の中のコピーのボタン(アイコンだけ)は、狭い幅でも縮まずパンくずの箱の中に見え、
    // 押すと省略表示に関係なくサイト ID の全文が clipboard に入る。ボタンの名前は CodeBlock と同じく「〜をコピーしました」に変わる
    {
      const copy = editor.getByTestId("topbar-site-id-copy");
      await expect(copy).toHaveAccessibleName("サイト ID をコピー");
      const copyBox = (await copy.boundingBox())!;
      expect(copyBox.x).toBeGreaterThanOrEqual(crumbsBox.x);
      expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(crumbsBox.x + crumbsBox.width + 0.5);
      expect(await copy.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await editor.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ADMIN_URL });
      await copy.click();
      await expect(copy).toHaveAccessibleName("サイト ID をコピーしました");
      expect(await editor.evaluate(() => navigator.clipboard.readText())).toBe(SITE.id);
      // 押した場所で結果が分かるよう、2 秒だけアイコンがチェックの印(成功の色)に替わり、その後コピーのアイコンに戻る。
      // 状態は data-copied で見る(図柄を変えても落ちないよう、アイコンの path は照合しない。どのアイコンかは unit の copyIconName の試験)
      await expect(copy).toHaveAttribute("data-copied", "true");
      await expect(copy.locator("svg")).toBeVisible();
      await expect(copy).not.toHaveAttribute("data-copied");
      await expect(copy).toHaveAccessibleName("サイト ID をコピー");
    }
    // 版の札の一覧は、本文列(overflow: hidden)に切られず画面の内側に開き、左端は本文列より左へ出ない。開くとフォーカスは一覧へ移る
    await editor.getByTestId("version-chip").click();
    const recent = editor.getByTestId("version-popover");
    await expect(recent).toBeFocused();
    await expect(recent).toHaveAccessibleName("直近の公開");
    await expect(recent.locator('[data-testid^="recent-publish-"]').first()).toBeVisible(); // 中身が描かれてから測る
    const popBox = (await recent.boundingBox())!;
    expect(popBox.x).toBeGreaterThanOrEqual(crumbsBox.x);
    expect(popBox.y).toBeGreaterThanOrEqual(0);
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(900);
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(700);
    await editor.keyboard.press("Escape");
    await expect(recent).toHaveCount(0);
    await editor.setViewportSize(viewport);
  }

  // UI の出し分けに頼らず、BFF 経由で直接叩いても 403(spec §13.2)
  const res = await editor.request.post(`/api/control/sites/${SITE.id}/experiments/${EXPERIMENT.id}/status`, { headers: controlHeaders(), data: { status: "running" } });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ error: "forbidden", required: "admin" });

  // B60: 名前のメニューはログアウトだけ(設定の入口は左メニューの最下部の「設定」1 つ)
  const editorMenu = editor.getByTestId("user-menu");
  await editorMenu.locator("summary").click();
  await expect(editorMenu.getByRole("button", { name: "ログアウト" })).toBeVisible();
  await expect(editorMenu.getByRole("link", { name: "設定" })).toHaveCount(0);
  await editorMenu.locator("summary").click(); // 閉じる(開いたままだと下の操作に重なる)
  // 決定 54 (7)・B60: 編集者はこの時点でサイトの中にいるので、「設定」はサイト設定の一般を開く。
  // 設定のメニューは「サイト設定」と「個人」の節。管理者未満には「ワークスペース」の節を見出しごと出さず(B60 Q2)、
  // システム管理者でない人には「システム」の節が出ない。API でもワークスペースを作れない
  await openSettings(editor);
  await expect(editor).toHaveURL(new RegExp(`/sites/${SITE.id}/settings$`));
  const editorNav = editor.getByRole("navigation", { name: "メインメニュー" });
  // 見出しは役割を持たない文字なので getByText で見る(パンくずにも「サイト設定」が出るので、メニューの中に絞る)
  await expect(editorNav.getByText("サイト設定", { exact: true })).toBeVisible();
  await expect(editorNav.getByText("個人", { exact: true })).toBeVisible();
  await expect(editorNav.getByText("ワークスペース", { exact: true })).toHaveCount(0);
  await expect(editorNav.getByRole("link", { name: "API キー", exact: true })).toBeVisible();
  await expect(editorNav.getByRole("link", { name: "画面表示" })).toBeVisible();
  await expect(editorNav.getByRole("link", { name: "システム管理者" })).toHaveCount(0);
  await expect(editorNav.getByRole("link", { name: "ワークスペース", exact: true })).toHaveCount(0);
  const created = await editor.request.post("/api/control/workspaces", { headers: controlHeaders(), data: { name: "By editor" } });
  expect(created.status()).toBe(403);
  // plan12 K3: 版を名乗らない書き込み(admin の更新より前に開いたタブ)は、BFF が版 0 を名乗り、control が権限の判定より前に 426 で断る
  const unnamed = await editor.request.post("/api/control/workspaces", { data: { name: "By old tab" } });
  expect(unnamed.status()).toBe(426);
  expect(await unnamed.json()).toMatchObject({ error: "client_too_old", clientVersion: 0 });

  // B45: ロールは選んだ瞬間に反映されるので確認を挟む。キャンセルなら変わらない →「変更する」で変わる(この後の流れのため編集者に戻す)
  await openMembers(page);
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
  await roleDialog.getByRole("button", { name: "キャンセル" }).press("Enter");
  await expect(roleDialog).toBeHidden();
  await expect(edRow.getByRole("combobox")).toContainText("編集者");
  expect(rolePatches).toBe(0); // キャンセルでは変更の要求を送らない
  await pick(page, "Ed のロール", /^閲覧者/);
  await roleDialog.getByRole("button", { name: "変更する" }).press("Enter");
  await expect(edRow.getByRole("combobox")).toContainText("閲覧者");
  expect(rolePatches).toBe(1);
  page.off("request", onRequest);
  await pick(page, "Ed のロール", /^編集者/);
  await roleDialog.getByRole("button", { name: "変更する" }).press("Enter");
  await expect(edRow.getByRole("combobox")).toContainText("編集者");
  // 一覧のカードの覆いが外れる(先頭に結果の文が出る)まで待ってから移る(覆いの間の移動は離れる前の確認で止まる。B173 第 2 段)
  await expect(page.getByTestId("members-list").getByRole("status")).toHaveText("ロールを変更しました");

  // B36: オーナー(= 初回セットアップの人 = システム管理者)が editor をシステム管理者にする → メンバー画面に印 → 外す。
  // ログイン済みのこの流れに相乗りする(sign-in の予算を増やさない。fixtures.ts の内訳参照)。
  // オーナーはこの時点でメンバーの画面(設定の中)にいて、設定のメニューに「システム」の節が出ているので、そこから押す
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
  await expect(page.getByTestId("instance-admins-list").getByRole("status")).toHaveText("追加しました");

  await openMembers(page);
  const edMember = page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" });
  await expect(edMember).toContainText("システム管理者");
  await expect(edMember.getByRole("combobox")).toBeDisabled();
  await expect(edMember.getByRole("button", { name: "外す" })).toHaveCount(0);

  // B46: editor が自分のブラウザで自分を外す。開く経路は左メニューの最下部の「設定」→「システム管理者」
  await editor.goto("/w"); // 昇格の後に開き直す(設定のメニューに「システム管理者」が出る)
  await openSettings(editor);
  await editor.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "システム管理者" }).click();
  await expect(editor).toHaveURL(/\/w\/me\/instance-admins$/);
  await editor.getByTestId("instance-admins").getByRole("row").filter({ hasText: "editor@e2e.example" }).getByRole("button", { name: "システム管理者から外す" }).click();
  const demoteDialog = editor.getByRole("alertdialog", { name: "自分をシステム管理者から外しますか?" });
  // 戻るワークスペースとロールが出る。この時点のワークスペースは WORKSPACE_NAME だけ(E2E Temp はこの後に作る)なので、外れる側は無い
  await expect(demoteDialog).toContainText(`${WORKSPACE_NAME}(編集者)`);
  await demoteDialog.getByRole("button", { name: "外す" }).press("Enter");
  await expect(editor).toHaveURL(/\/w$/); // 全画面で /w へ移る(戻ったワークスペースがあるのでログインしたまま)
  // 昇格前に編集者だったワークスペースでは、編集者として使い続けられる(すべてを失わない)
  await openWorkspace(editor);
  await expect(editor.getByRole("link", { name: SITE.name })).toBeVisible();
  // オーナーの画面でも、editor の行は編集者に戻り、システム管理者の一覧から消えている
  await openMembers(page);
  await expect(page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" }).getByRole("combobox")).toContainText("編集者");
  await page.goto(`${ADMIN_URL}/w/me/instance-admins`);
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(0);

  // B46 K11 / K12: もう一度 editor をシステム管理者にし(上の昇格と同じ手順)、チェックボックスで元のロールに戻さず完全に外す。
  // オーナーはこの時点でシステム管理者の画面(設定の中)にいるので、設定のメニューの「システム管理者」から開き直す
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
  await fullDialog.getByRole("button", { name: "すべてから外す" }).press("Enter");
  await expect(adminRows.filter({ hasText: "editor@e2e.example" })).toHaveCount(0);
  await expect(page.getByTestId("instance-admins-list").getByRole("status")).toHaveText("外しました");
  // 元のロールにも戻らない = オーナーのメンバー画面に editor の行が無い
  await openMembers(page);
  await expect(page.getByTestId("members").getByRole("row").filter({ hasText: "editor@e2e.example" })).toHaveCount(0);
  // 最後の 1 人は API でも外せない
  const me = (await (await page.request.get(`${ADMIN_URL}/api/control/me`, { headers: controlHeaders() })).json()) as { id: string };
  expect((await page.request.delete(`${ADMIN_URL}/api/control/instance-admins/${me.id}`, { headers: controlHeaders() })).status()).toBe(409);

  // 決定 54 (10): 設定 > ワークスペース。ホームの「新しいワークスペース」から作成の欄へ → 作る → 削除の確認で名前を打ち込んで消す
  await page.goto(`${ADMIN_URL}/w`);
  await waitForHydration(page);
  // B60 Task 8: オーナー(管理者以上)のホームのカードの「メンバー N」は、メンバーの画面へのリンク。
  // 画面には、ロールが効く範囲(このワークスペースのサイト)の 1 文が PageHeader の下に 1 か所だけ出る
  await page.getByTestId("workspace-card").getByRole("link", { name: /メンバー \d+/ }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/members$/);
  await expect(page.getByTestId("member-scope")).toContainText("すべてに効きます");
  await expect(page.getByText(/ロールはこのワークスペース/)).toHaveCount(1);
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
  // B60 Task 2: 外枠(サイドバー)は /w の layout 1 か所。作った直後の画面のサイドバーの切り替えの枠に、新しいワークスペースが出る
  // (外枠で最初に読んだ summary には無いワークスペース。[wid] の layout の SummarySync が新しい summary に差し替えるので出る。
  // 作成の後は全画面の遷移でもあるが、router.push でもこの確認は SummarySync で通る。作成の直後に相乗りしてログインは増やさない)
  await expect(
    page.getByRole("navigation", { name: "メインメニュー" }).getByRole("button", { name: /^ワークスペースとサイトの切り替え: E2E Temp \// }),
  ).toBeVisible();
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
  const ctl = (path: string, data: unknown) => page.request.post(`${ADMIN_URL}/api/control${path}`, { headers: controlHeaders(), data });
  expect((await ctl(`/workspaces/${tempId}/sites`, { name: "E2E Temp Site", domains: ["temp.e2e-temp.example"], id: "site_e2e_temp" })).status()).toBe(201); // B139: 他の spec のサイトと登録ドメインを分ける
  // D9 ③: 計測用のデータベースがある導入の新しい Site は結果を記録する(開始に評価計画の目標が要る)ので、記録しない設定にしてから開始する(fixtures.ts の createSite と同じ)
  expect((await page.request.patch(`${ADMIN_URL}/api/control/sites/site_e2e_temp`, { headers: controlHeaders(), data: { resultsEnabled: false } })).status()).toBe(200);
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
