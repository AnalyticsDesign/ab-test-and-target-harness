import { test, expect, type Locator, type Page, type Request, type Response } from "@playwright/test";
import { appAlert, changeStatus, createExperiment, createSite, login, pick, waitForHydration } from "./fixtures";

/**
 * B77(設計書 2026-10-16-b77-variant-ui-design.md・plan Task 11): パターンの「オリジナル」・重みの配分・0% の確認・メモ・目標名のプレビュー・
 * 空の HTML の検査(B8)・外部計測のカードの開閉を、実際のブラウザで確かめる。
 * 専用のサイトで行い、publish-flow の Site / 実験には触らない。ログインは最初の 1 回だけにして同じページを引き回す(fixtures.ts の sign-in の予算)
 */
const SITE_VARIANT = { id: "site_e2e_var", name: "E2E Variant Site" };
/** 1〜5 本目が使う(作成 → 配分 → オリジナル → 0% → 開始 → 終了とメモ)。最後は終了する */
const EXP_MAIN = { id: "exp_e2e_var", name: "E2E variant main" };
/** B8・カードの開閉・保存の途中の失敗が使う。下書きのまま */
const EXP_DRAFT = { id: "exp_e2e_var2", name: "E2E variant draft" };

/** write-freeze.spec.ts と同じ 503 write_frozen(凍結の判定の時刻を選べないので、1 つの要求だけをこの応答にする) */
const FROZEN_503 = {
  error: "write_frozen",
  message: "メンテナンス中のため、変更を保存できません",
  hint: "理由: E2E の更新。メンテナンスが終わってから、もう一度実行してください",
  reason: "E2E の更新",
  until: null,
  retryAfter: 300,
};

type Write = { method: string; path: string; body: unknown };
/** 管理画面が control に送った書き込み(GET 以外)を記録する。path は `/api/control` を除いたもの */
function recordWrites(page: Page): { writes: Write[]; stop: () => void } {
  const writes: Write[] = [];
  const on = (r: Request) => {
    const url = new URL(r.url());
    if (r.method() === "GET" || !url.pathname.startsWith("/api/control/")) return;
    writes.push({ method: r.method(), path: url.pathname.slice("/api/control".length), body: r.postDataJSON() });
  };
  page.on("request", on);
  return { writes, stop: () => page.off("request", on) };
}

test.describe.serial("pattern UI (B77)", () => {
  let page: Page;
  /** サイトの画面の URL(`/w/<wid>/sites/<sid>`)。サイトを作った直後に控える */
  let siteUrl: string;
  const base = (id: string) => `/sites/${SITE_VARIANT.id}/experiments/${id}`;
  const openExperiment = async (id: string, tab?: "variants") => {
    await page.goto(`${siteUrl}/experiments/${id}${tab ? `?tab=${tab}` : ""}`);
    await waitForHydration(page);
  };
  const pickVariant = async (id: string): Promise<Locator> => {
    await page.getByTestId(`variant-pick-${id}`).click();
    await expect(page.getByTestId(`variant-${id}`)).toBeVisible();
    return page.getByTestId(`variant-${id}`);
  };
  const saveState = () => page.getByTestId("save-state");
  /** 「保存(下書き)」を押し、指定の要求の応答を待つ。成功なら保存バーが「保存しました」になる(保存の後の読み直しの反映)まで待つ */
  const save = async (until: (r: Response) => boolean): Promise<Response> => {
    const done = page.waitForResponse(until);
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    const res = await done;
    if (res.ok()) await expect(saveState()).toHaveText(res.request().method() === "PATCH" ? "保存しました" : "下書きに保存しました。訪問者への反映にはサイトの公開が必要です");
    return res;
  };
  const isWrite = (method: string, path: string) => (r: Response) => r.request().method() === method && new URL(r.url()).pathname === `/api/control${path}`;
  /** 外部計測のカードの見出しのボタン(名前には印の数・「上書き」が続くので前方一致) */
  const analyticsToggle = (scope: Locator) => scope.getByRole("button", { name: /^外部計測\(dataLayer 出力\)/ });

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
    await createSite(page, SITE_VARIANT);
    siteUrl = page.url();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("new_test_has_original_a", async () => {
    // 作成のボタンが、A がオリジナルになることを先に伝える(K21)
    await page.getByRole("link", { name: "新しいエクスペリエンス" }).click();
    await page.fill('input[name="id"]', EXP_MAIN.id);
    await page.fill('input[name="name"]', EXP_MAIN.name);
    await page.fill('input[name="value"]', "/");
    await page.getByRole("button", { name: "作成(A パターン(オリジナル)/ B パターンを 50:50 で用意します)" }).click();
    await expect(page).toHaveURL(new RegExp(`/experiments/${EXP_MAIN.id}$`));
    await waitForHydration(page); // 作成は全画面の遷移で終わる
    await expect(page.getByRole("tab", { name: "基本設定" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "パターン" }).click();
    // 一覧: a にだけ「オリジナル」の印。重みは 50 / 50
    await expect(page.getByTestId("variant-pick-a")).toContainText("オリジナル");
    await expect(page.getByTestId("variant-pick-b")).not.toContainText("オリジナル");
    await expect(page.getByTestId("variant-weight-a")).toHaveValue("50");
    await expect(page.getByTestId("variant-weight-b")).toHaveValue("50");
    // 詳細: a は「オリジナル」、b は「変更あり」が選ばれている
    const a = await pickVariant("a");
    await expect(a.getByRole("radio", { name: /^オリジナル/ })).toHaveAttribute("aria-checked", "true");
    await expect(a.getByText("オリジナルのパターンは変更を持てません")).toBeVisible();
    await expect(a.getByRole("button", { name: "変更を追加", exact: true })).toHaveCount(0);
    // B68: 画像の変更を足すボタンもオリジナルには出ない
    await expect(a.getByRole("button", { name: "画像の変更を追加", exact: true })).toHaveCount(0);
    const b = await pickVariant("b");
    await expect(b.getByRole("radio", { name: /^変更あり/ })).toHaveAttribute("aria-checked", "true");
    await expect(b.getByRole("radio", { name: /^オリジナル/ })).toHaveAttribute("aria-checked", "false");
    // B86: 群の Tab 停止点は選択中の 1 枚だけ。矢印キーは選択とフォーカスを同時に移す。
    const original = b.getByRole("radio", { name: /^オリジナル/ });
    const changed = b.getByRole("radio", { name: /^変更あり/ });
    await changed.focus();
    await page.keyboard.press("Tab");
    await expect(b.getByLabel("名前(100 字以内)")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(changed).toBeFocused();
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
      const selected = key === "ArrowRight" || key === "ArrowLeft" ? original : changed;
      await page.keyboard.press(key);
      await expect(selected).toBeFocused();
      await expect(selected).toHaveAttribute("aria-checked", "true");
    }
  });

  test("even_split_and_auto_redistribute", async () => {
    await openExperiment(EXP_MAIN.id, "variants");
    const weights = () => Promise.all(["a", "b", "c"].map((id) => page.getByTestId(`variant-weight-${id}`).inputValue()));
    // 均等(50 / 50)のときに足すと、3 つに配り直して知らせる。端数は先頭から 1 ずつ。足したパターンがそのまま開く
    await page.getByRole("button", { name: "パターンを追加" }).click();
    await expect(page.getByTestId("variant-c")).toBeVisible();
    expect(await weights()).toEqual(["34", "33", "33"]);
    await expect(page.getByText("均等に配り直しました")).toBeVisible();
    await expect(page.getByText("重みの合計 100 / 100")).toBeVisible();
    // 手で直すと知らせは消え、合計が 100 でなければ保存できない
    await page.getByTestId("variant-weight-a").fill("50");
    await expect(page.getByText("均等に配り直しました")).toHaveCount(0);
    await expect(page.getByText("重みの合計 116 / 100")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存(下書き)" })).toBeDisabled();
    // 「均等に配分」で 34 / 33 / 33 に戻る(この操作の後は知らせを出さない)
    await page.getByRole("button", { name: "均等に配分" }).click();
    expect(await weights()).toEqual(["34", "33", "33"]);
    await expect(page.getByText("均等に配り直しました")).toHaveCount(0);
    // 保存はしない(後のテストは a / b の 2 つで進める)
    await page.getByRole("button", { name: "破棄" }).click();
    await expect(page.getByTestId("variant-pick-c")).toHaveCount(0);
    await expect(saveState()).toHaveText("変更はありません");
  });

  test("switch_to_original_deletes_changes_on_save", async () => {
    await openExperiment(EXP_MAIN.id, "variants");
    let b = await pickVariant("b");
    await b.getByRole("button", { name: "変更を追加", exact: true }).click();
    const change = b.getByTestId("change-TEXT");
    await expect(change.getByRole("link", { name: /要素を選ぶ/ })).toHaveCount(0);
    await expect(change.getByRole("button", { name: /要素を選ぶ/ })).toHaveCount(0);
    await expect(change.getByText("ブラウザの開発者ツールで要素を調べ、CSS セレクタを入力してください。")).toBeVisible();
    await change.locator('input[maxlength="500"]').fill(".hero-title");
    await change.locator("textarea").fill("B77 オリジナルの確認");
    expect((await save(isWrite("PUT", `${base(EXP_MAIN.id)}/variants/b/changes`))).status()).toBe(200);
    await expect(b.getByTestId("change-TEXT")).toHaveCount(1);

    // 「オリジナル」に切り替えると、保存で消える変更の件数を帯で知らせる(変更は下書きに残して隠すだけ)
    await b.getByRole("radio", { name: /^オリジナル/ }).click();
    await expect(b.getByText("保存すると、変更 1 件を削除します")).toBeVisible();
    await expect(b.getByTestId("change-TEXT")).toHaveCount(0);
    // 保存はパターンの一覧の PUT だけ(オリジナルのパターンには変更を送らない)。control が同じ処理で変更を消す
    const rec = recordWrites(page);
    expect((await save(isWrite("PUT", `${base(EXP_MAIN.id)}/variants`))).status()).toBe(200);
    rec.stop();
    expect(rec.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`PUT ${base(EXP_MAIN.id)}/variants`]);

    // 再読み込みしても b はオリジナルで、「変更あり」に戻しても変更は 0 件(D1 から消えている)
    await page.reload();
    await waitForHydration(page);
    b = await pickVariant("b");
    await expect(b.getByRole("radio", { name: /^オリジナル/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("variant-pick-b")).toContainText("オリジナル");
    await b.getByRole("radio", { name: /^変更あり/ }).click();
    await expect(b.getByText("変更はまだありません")).toBeVisible();
    await expect(b.getByTestId("change-TEXT")).toHaveCount(0);
    // 後のテストのために「変更あり」で保存し直す
    expect((await save(isWrite("PUT", `${base(EXP_MAIN.id)}/variants`))).status()).toBe(200);
    await expect(page.getByTestId("variant-pick-b")).not.toContainText("オリジナル");
  });

  test("zero_weight_start_confirm", async () => {
    await openExperiment(EXP_MAIN.id, "variants");
    await page.getByTestId("variant-weight-a").fill("100");
    await page.getByTestId("variant-weight-b").fill("0");
    await expect(page.getByTestId("variant-pick-b")).toContainText("0% = 誰にも表示されません");
    expect((await save(isWrite("PUT", `${base(EXP_MAIN.id)}/variants`))).status()).toBe(200);
    // 開始の確認は保存済みの重みで決まる(router.refresh の着地を待たず、読み直して確かめる)
    await page.reload();
    await waitForHydration(page);
    let posted = false;
    const onRequest = (r: Request) => {
      if (r.method() === "POST" && r.url().includes(`/experiments/${EXP_MAIN.id}/status`)) posted = true;
    };
    page.on("request", onRequest);
    await page.getByRole("button", { name: "開始(公開して配信を始める)" }).click();
    const dialog = page.getByRole("alertdialog", { name: "開始しますか?" });
    await expect(dialog).toContainText("重み 0% のパターンがあります。");
    await expect(dialog).toContainText("B は重み 0% のため、誰にも表示されません");
    await dialog.getByRole("button", { name: "キャンセル" }).press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "draft");
    expect(posted).toBe(false); // キャンセルでは開始の要求を送らない
    page.off("request", onRequest);
    // 50 / 50 に戻して保存する(次のテストで開始する)
    await page.getByRole("tab", { name: "パターン" }).click();
    await page.getByRole("button", { name: "均等に配分" }).click();
    expect((await save(isWrite("PUT", `${base(EXP_MAIN.id)}/variants`))).status()).toBe(200);
  });

  test("memo_on_archived_keeps_published_state", async () => {
    await openExperiment(EXP_MAIN.id);
    // 0% のパターンが無く、重なる配信中のエクスペリエンスも無い。D9 ③: 下書きのテストの開始は必ず確認を出す(このサイトは結果を記録しないので
    // 「開始しますか?」と記録しない文だけ。changeStatus が確認を通す)
    expect((await changeStatus(page, SITE_VARIANT.id, EXP_MAIN.id, "開始(公開して配信を始める)")).publish).toMatchObject({ ok: true });
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "running");
    const unpublishedBadge = page.locator("main").getByText("未公開の編集あり");
    await expect(unpublishedBadge).toHaveCount(0);
    const memoLabel = "メモ(社内用。外部には出力されません)";

    // 配信中: パターンのメモだけを直す → 送るのはそのパターンの description だけの PATCH。保存バーは「保存しました」になる
    await page.getByRole("tab", { name: "パターン" }).click();
    const b = await pickVariant("b");
    await b.getByLabel(memoLabel).fill("配信中に書いたメモ");
    await expect(saveState()).toHaveText("未保存の変更あり");
    let rec = recordWrites(page);
    expect((await save(isWrite("PATCH", `${base(EXP_MAIN.id)}/variants/b`))).status()).toBe(200);
    rec.stop();
    expect(rec.writes).toEqual([{ method: "PATCH", path: `${base(EXP_MAIN.id)}/variants/b`, body: { description: "配信中に書いたメモ" } }]);
    await page.reload();
    await waitForHydration(page);
    await expect(unpublishedBadge).toHaveCount(0); // メモの保存では「未公開の編集あり」にならない
    await expect(page.getByTestId("variant-b").getByLabel(memoLabel)).toHaveValue("配信中に書いたメモ");

    // 終了する(終了も公開を伴う)。D9 ③: テストの終了は終了のモーダル(採用の記録)で行う。このサイトは結果を記録しないので採用なしのまま終了する
    await page.getByRole("button", { name: "終了して結果を記録", exact: true }).click();
    const stopDialog = page.getByRole("alertdialog", { name: "終了して結果を記録します" });
    await expect(stopDialog.getByRole("radio", { name: /^採用なし/ })).toBeChecked();
    const done = page.waitForResponse((r) => r.url().includes(`/experiments/${EXP_MAIN.id}/status`) && r.request().method() === "POST");
    await expect(stopDialog.getByRole("button", { name: "終了して記録" })).toBeEnabled();
    await stopDialog.getByRole("button", { name: "終了して記録" }).press("Enter");
    expect((await done).status()).toBe(200);
    await expect(page.getByTestId("status-banner")).toHaveAttribute("data-status", "archived");
    await page.reload();
    await waitForHydration(page);
    await expect(unpublishedBadge).toHaveCount(0);
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "secondary"); // このサイトに未公開の編集は無い

    // 終了したエクスペリエンス: ほかの欄は読み取り専用で、メモだけを直せる。保存バーはメモを変えたときだけ出る
    await page.getByRole("tab", { name: "基本設定" }).click();
    await expect(page.getByLabel("名前(100 字以内)")).toBeDisabled();
    await expect(saveState()).toHaveCount(0);
    const memo = page.getByLabel(memoLabel);
    await expect(memo).toBeEnabled();
    await memo.fill("終了後の振り返り");
    await expect(saveState()).toHaveText("未保存の変更あり");
    rec = recordWrites(page);
    const res = page.waitForResponse(isWrite("PATCH", base(EXP_MAIN.id)));
    await page.getByRole("button", { name: "保存(メモ)" }).click();
    expect((await res).status()).toBe(200);
    // 保存の後は、帯の左に「保存しました」を出す(終了したエクスペリエンスでも、成功の文がある間は帯を残す。次に欄を変えるか破棄すると帯ごと消える)
    await expect(saveState()).toHaveText("保存しました");
    rec.stop();
    expect(rec.writes).toEqual([{ method: "PATCH", path: base(EXP_MAIN.id), body: { description: "終了後の振り返り" } }]);
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByLabel(memoLabel)).toHaveValue("終了後の振り返り");
    await expect(unpublishedBadge).toHaveCount(0);
    await expect(page.getByTestId("topbar-publish")).toHaveAttribute("data-variant", "secondary");
    await expect(page.locator("header")).not.toContainText("未公開の編集あり");
  });

  test("goal_name_preview", async () => {
    await page.goto(siteUrl);
    await waitForHydration(page);
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "目標" }).click();
    await page.fill('input[name="id"]', "g_var_signup");
    await page.fill('input[name="name"]', "社内の呼び名");
    await page.fill('input[name="value"]', "/thanks");
    await page.getByRole("button", { name: "追加" }).click();
    const row = page.getByRole("row").filter({ hasText: "g_var_signup" });
    await expect(row).toContainText("指定なし(ID を出力)");

    await row.getByRole("button", { name: /^編集/ }).click();
    const preview = page.getByTestId("datalayer-preview");
    const goalName = page.getByRole("textbox", { name: "目標名" });
    // 指定が無ければ目標 ID を出す
    await expect(goalName).toHaveValue("");
    await expect(preview).toContainText('ab_goal_name: "g_var_signup"');
    await expect(preview).toContainText("指定なし = 目標 ID");
    // 入れると、その値に変わる(管理画面の名前は出ない)
    await goalName.fill("sign_up");
    await expect(preview).toContainText('ab_goal_name: "sign_up"');
    await expect(preview).toContainText("指定した目標名");
    await expect(preview).not.toContainText("社内の呼び名");
    // 空に戻すと ID に戻る
    await goalName.fill("");
    await expect(preview).toContainText('ab_goal_name: "g_var_signup"');
    await expect(preview).toContainText("指定なし = 目標 ID");
    // 入れて保存すると一覧の「外部計測」の列に出る
    await goalName.fill("sign_up");
    const patched = page.waitForResponse(isWrite("PATCH", `/sites/${SITE_VARIANT.id}/goals/g_var_signup`));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await patched).status()).toBe(200);
    await expect(row.getByTestId("goal-name-badge")).toHaveText("目標名 sign_up");
  });

  test("empty_html_is_flagged_before_save", async () => {
    await page.goto(siteUrl);
    await waitForHydration(page);
    await createExperiment(page, EXP_DRAFT);
    await waitForHydration(page);
    await page.getByRole("tab", { name: "パターン" }).click();
    const b = await pickVariant("b");
    await b.getByRole("button", { name: "変更を追加", exact: true }).click();
    await pick(b.getByTestId("change-TEXT"), "変更の種類", /^HTML/);
    const html = b.getByTestId("change-HTML");
    await html.locator('input[maxlength="500"]').fill(".hero-title");
    // 別のパターンを開いておく(保存の前の検査が、空の HTML のあるパターンを開き直すことを見る)
    await pickVariant("a");
    const rec = recordWrites(page);
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    await expect(appAlert(page).first()).toContainText("HTML の変更に、HTML が入っていないものがあります");
    await expect(page.getByTestId("variant-b")).toBeVisible();
    await expect(html.getByRole("alert")).toHaveText("HTML を入力してください");
    await expect(html.locator("textarea").first()).toHaveAttribute("aria-invalid", "true");
    expect(rec.writes).toEqual([]); // control には何も送っていない
    rec.stop();
    // 欄に入れるとエラーが消える。保存はしない(破棄)
    await html.locator("textarea").first().fill("<p>B77</p>");
    await expect(html.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "破棄" }).click();
    await expect(saveState()).toHaveText("変更はありません");
  });

  test("analytics_card_open_state_survives_switch", async () => {
    await openExperiment(EXP_DRAFT.id, "variants");
    let b = await pickVariant("b");
    const bToggle = () => analyticsToggle(page.getByTestId("variant-b"));
    const variantName = () => page.getByTestId("variant-b").getByRole("textbox", { name: "出力するパターン名" });
    // 設定の無いパターンのカードは畳んだ状態で出る。開く
    await expect(bToggle()).toHaveAttribute("aria-expanded", "false");
    await bToggle().click();
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    // パターンの往復: a のカードは a の最初の表示の規則(畳む)、b に戻ると開いたまま
    await pickVariant("a");
    await expect(analyticsToggle(page.getByTestId("variant-a"))).toHaveAttribute("aria-expanded", "false");
    b = await pickVariant("b");
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    // タブの往復: 基本設定のエクスペリエンスのカードは別に覚える。パターンに戻ると b は開いたまま
    await page.getByRole("tab", { name: "基本設定" }).click();
    const expToggle = analyticsToggle(page.locator("main"));
    await expect(expToggle).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("tab", { name: "パターン" }).click();
    await expect(page.getByTestId("variant-b")).toBeVisible(); // 開いていたパターンのまま
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    // 保存の後(本体を作り直しても)開いたまま
    await variantName().fill("hero_b");
    expect((await save(isWrite("PUT", `${base(EXP_DRAFT.id)}/variants`))).status()).toBe(200);
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    await expect(variantName()).toHaveValue("hero_b");
    // 最後の設定を消しても勝手に閉じない(保存の後も)
    await variantName().fill("");
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    expect((await save(isWrite("PUT", `${base(EXP_DRAFT.id)}/variants`))).status()).toBe(200);
    await expect(bToggle()).toHaveAttribute("aria-expanded", "true");
    // 閉じた選択も残る(設定の無いパターンを閉じて往復しても閉じたまま)
    await bToggle().click();
    await expect(bToggle()).toHaveAttribute("aria-expanded", "false");
    await pickVariant("a");
    await pickVariant("b");
    await expect(bToggle()).toHaveAttribute("aria-expanded", "false");
  });

  test("partial_failure_at_variant_memo_keeps_input", async () => {
    // B77 K17 の (4) パターンの一覧の PUT が届いた後、(5) パターンのメモの PATCH で断られる(凍結の 503)。
    // 一部は保存されたことを知らせ、入力は残し、押し直すと残りも保存される
    await openExperiment(EXP_DRAFT.id, "variants");
    const b = await pickVariant("b");
    const memoLabel = "メモ(社内用。外部には出力されません)";
    await b.getByLabel("名前(100 字以内)").fill("B 案");
    await b.getByLabel(memoLabel).fill("途中で断られるメモ");
    // 別のパターンを開いておく(落ちたパターンを開き直すことを見る)
    await pickVariant("a");
    const memoPath = `**/api/control${base(EXP_DRAFT.id)}/variants/b`;
    await page.route(memoPath, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(FROZEN_503) }) : route.continue(),
    );
    const put = page.waitForResponse(isWrite("PUT", `${base(EXP_DRAFT.id)}/variants`));
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    expect((await put).status()).toBe(200); // (4) は control に届いている
    await expect(appAlert(page).first()).toContainText("一部は保存されています。入力はそのまま残っています");
    await expect(page.getByTestId("variant-b")).toBeVisible();
    await expect(page.getByTestId("variant-b").getByLabel(memoLabel)).toHaveValue("途中で断られるメモ");
    await expect(saveState()).toHaveText("未保存の変更あり");
    // 外れた後に押し直すと、メモも保存される
    await page.unroute(memoPath);
    expect((await save(isWrite("PATCH", `${base(EXP_DRAFT.id)}/variants/b`))).status()).toBe(200);
    await page.reload();
    await waitForHydration(page);
    await expect(page.getByTestId("variant-b").getByLabel("名前(100 字以内)")).toHaveValue("B 案");
    await expect(page.getByTestId("variant-b").getByLabel(memoLabel)).toHaveValue("途中で断られるメモ");
  });
});
