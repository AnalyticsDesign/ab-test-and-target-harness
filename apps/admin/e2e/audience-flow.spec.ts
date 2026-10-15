import { test, expect, type Locator, type Page } from "@playwright/test";
import { compileRegex, REGEX_LIMITS } from "@wtt/core";
import { COMPLETION_1_TARGETING } from "../../../packages/core/test/fixtures/completion-1";
import { changeStatus, createExperiment, createSite, login, openSite, waitForHydration } from "./fixtures";

/**
 * 決定 49(設計書 §15 の admin): オーディエンスを作る → エクスペリエンスで選ぶ → 保存 → 実行中の参照を編集して確認を挟む → Publish の確認画面で
 * 「変更あり」・数えるのをやめるページの条件・画面の幅の注意が出る。アクセシビリティ設定(ドラッグなしで追加・並べ替え・移動)と、入れ子の上限、
 * ポインタのドラッグ(グループへの移動と、同じグループの末尾への並べ替え)、期間の日数の空欄、完成の基準 1 の条件を画面で作ることも通す
 */
const SITE_AUD = { id: "site_e2e_aud", name: "E2E Audience" };
const EXP_AUD = { id: "exp_e2e_aud", name: "E2E audience exp" };
const EXP_C1 = { id: "exp_e2e_c1", name: "E2E completion 1" };
const EXP_VP = { id: "exp_e2e_vp", name: "E2E viewport" };
const nav = (page: Page) => page.getByRole("navigation", { name: "メインメニュー" });
const rows = (page: Page) => page.getByTestId("condition-row");
async function choose(scope: Page | Locator, label: string, option: string): Promise<void> {
  await scope.getByRole("combobox", { name: label }).click();
  await scope.getByRole("option", { name: option, exact: true }).click();
}
/** 左の欄の部品。「グループ」は段数のバッジを名前に含むので前方一致で引く */
const chip = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "条件の部品" }).getByRole("button", name === "グループ" ? { name: /^グループ/ } : { name, exact: true });
async function newAudience(page: Page, name: string): Promise<void> {
  await nav(page).getByRole("link", { name: "オーディエンス" }).click();
  await page.getByRole("link", { name: "新しいオーディエンス" }).click();
  await page.getByLabel("名前", { exact: true }).fill(name);
}
/** アクセシビリティ設定(設定 > 画面表示)を別のタブで切り替える。元のタブは storage イベントで追従し、画面の状態を保つ */
async function setDragAlternatives(page: Page, on: boolean): Promise<void> {
  const settings = await page.context().newPage();
  await settings.goto("/w/me/display");
  await waitForHydration(settings);
  const box = settings.getByLabel("ドラッグの代わりにボタンで操作する");
  // サーバーの描画は常にオフ。ハイドレーション後に保存値へ切り替わるのを確かめてから押す(待たずに押すと描画の差し替えで空振りする)
  if (on) {
    await expect(box).not.toBeChecked();
    await box.check();
  } else {
    await expect(box).toBeChecked();
    await box.uncheck();
  }
  await settings.close();
}
/**
 * dnd-kit のポインタ操作: つまみを押し、4px を超えて動かしてドラッグを始め、to で放す。
 * つまみを画面の中央へスクロールしてから座標を測る(to は後から測る関数)。画面の端の近くで始めると dnd-kit の自動スクロールが
 * ドラッグ中に画面を動かし、測った置き場所がずれて放した位置が外れるため
 */
async function dragTo(page: Page, handle: Locator, to: () => Promise<{ x: number; y: number }>): Promise<void> {
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const h = (await handle.boundingBox())!;
  const dest = await to();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10, h.y + h.height / 2 + 10, { steps: 5 }); // 4px を超えて動かしてドラッグを始める
  await page.mouse.move(dest.x, dest.y, { steps: 15 });
  await page.mouse.up();
}

/**
 * 上部バーの Publish から確認画面を開く。Start / Pause の直後は画面が router.refresh() で作り直されている最中で、そのときに押した
 * リンクの遷移が取り消されて編集画面に残ることがある(実測)。見出しが出るまで押し直す(遷移が済んだ後は押さない)
 */
async function openPublish(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId("topbar-publish").click();
    await expect(page.getByRole("heading", { name: "公開", exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass();
}

test.describe.serial("オーディエンス → エクスペリエンス → Publish の確認(決定 49)", () => {
  test("audience_builder_creates_audience_with_history_conditions", async ({ page }) => {
    await login(page);
    await createSite(page, SITE_AUD);
    // Goal は BFF 経由の API で作る(Goal の画面は今回の対象外)
    expect((await page.request.post(`/api/control/sites/${SITE_AUD.id}/goals`, { data: { id: "g_lead", name: "資料請求", type: "CUSTOM", config: {} } })).status()).toBe(201);
    await newAudience(page, "Pricing visitors");
    await expect(page.getByLabel("ID", { exact: true })).toHaveValue("aud_pricing_visitors");
    await chip(page, "閲覧したページ").click(); // クリックすると一番外側の末尾に入る
    await rows(page).nth(0).getByLabel("値").fill("/pricing/");
    await rows(page).nth(0).getByLabel("回数").fill("2");
    await chip(page, "目標・コンバージョン").click();
    await choose(rows(page).nth(1), "達成", "が未達成");
    await expect(page.getByTestId("audience-summary")).toHaveText("パスが「/pricing/」で始まるページを 2 回以上閲覧 かつ 目標「資料請求」が未達成");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page).toHaveURL(/\/audiences\/aud_pricing_visitors$/);
    await page.getByText("保存される JSON").click();
    await expect(page.getByTestId("audience-json")).toContainText('"min": 2');
  });

  test("period_days_left_empty_blocks_save(日数の欄を空にしても期間の指定は消えず、保存のリクエストを送らない)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await newAudience(page, "Period test");
    await chip(page, "閲覧したページ").click();
    const row = rows(page).nth(0);
    await row.getByLabel("値").fill("/pricing/");
    await choose(row, "期間", "最後の閲覧が");
    const days = row.getByLabel("日数");
    await expect(days).toHaveValue("30");
    await days.fill("");
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes(`/api/control/sites/${SITE_AUD.id}/audiences`)) posted += 1;
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "期間は 1〜3650 の整数で入力してください" })).toBeVisible();
    await expect(days).toBeVisible(); // 空欄でも「期間の指定なし」に戻らない
    await expect(days).toHaveValue("");
    expect(posted).toBe(0);
  });

  test("a11y_alternatives_add_reorder_move_without_drag(と入れ子の上限)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await setDragAlternatives(page, true);
    await newAudience(page, "Nest test");
    await chip(page, "端末").click();
    await chip(page, "OS").click();
    await expect(page.getByTestId("audience-summary")).toHaveText("端末が モバイル かつ OSが iOS");
    await rows(page).nth(0).getByRole("button", { name: "下へ" }).click(); // 並べ替え
    await expect(page.getByTestId("audience-summary")).toHaveText("OSが iOS かつ 端末が モバイル");
    await chip(page, "グループ").click(); // 追加先 = 一番外側
    await choose(rows(page).nth(0), "移動先", "入れ子 1: (空のグループ)"); // グループの間の移動
    await expect(page.getByTestId("audience-summary")).toHaveText("端末が モバイル かつ (OSが iOS)");
    // 「ここに追加」で追加先を選び、入れ子を 4 段まで作る。上限の段ではグループの部品を押せない
    for (let level = 1; level <= 3; level++) {
      await page.getByTestId("audience-group").nth(level - 1).getByRole("button", { name: "ここに追加" }).first().click();
      await chip(page, "グループ").click();
    }
    await page.getByTestId("audience-group").nth(3).getByRole("button", { name: "ここに追加" }).click();
    await expect(chip(page, "グループ")).toHaveAttribute("aria-disabled", "true");
    await expect(chip(page, "グループ")).toHaveAttribute("title", "追加先が上限の段にあるため、ここにはグループを置けません");
    // 上限に達したらキャンバスの上に警告を出す(設計書 §12)。押せない理由は部品の title と、この警告で伝える
    await expect(page.getByRole("status").filter({ hasText: "グループの入れ子が上限の 4 段に達しています" })).toBeVisible();
    // aria-disabled のボタンはキーボードでも押せるが、disabled の間は何もしない(DraggableChip の仕様)。押してもグループは増えず、押したことへの alert も出さない(上の警告は出たまま)
    // (通常の click は enabled を待つので force で押す)
    const groups = await page.getByTestId("audience-group").count();
    await chip(page, "グループ").click({ force: true });
    await expect(page.getByTestId("audience-group")).toHaveCount(groups);
    await expect(page.getByRole("alert").filter({ hasText: "一番外側の中に 4 段まで" })).toHaveCount(0);
    await setDragAlternatives(page, false);
    await expect(page.getByRole("button", { name: "ここに追加" })).toHaveCount(0); // オフなら代わりの手段は出さない
    await expect(page.getByRole("link", { name: "設定 > 画面表示" })).toHaveAttribute("href", "/w/me/display"); // 代わりに案内の 1 行が設定を指す
  });

  test("drag_moves_condition_into_group(dnd-kit のポインタ操作)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await newAudience(page, "Drag test");
    await chip(page, "グループ").click();
    await chip(page, "画面の幅").click();
    const handle = rows(page).filter({ hasText: "px" }).getByLabel("ドラッグで移動");
    await dragTo(page, handle, async () => {
      const t = (await page.getByTestId("audience-group").getByText("左の部品をここへドラッグ").boundingBox())!;
      return { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    });
    await expect(page.getByTestId("audience-summary")).toHaveText("(画面の幅が 768px 未満)");
    // dnd-kit はドラッグを放した直後の 50ms、click を握りつぶす(ドラッグの後のクリックを誤って拾わないため)。人の操作では起きないので、
    // 最初のクリックだけ「足されるまで」繰り返す(握りつぶされたら足されないので押し直す。足された後は押さない)
    await expect(async () => {
      await chip(page, "端末").click();
      await expect(page.getByTestId("audience-summary")).toContainText("端末が モバイル", { timeout: 1000 });
    }).toPass();
    await chip(page, "OS").click();
    await expect(page.getByTestId("audience-summary")).toHaveText("(画面の幅が 768px 未満) かつ 端末が モバイル かつ OSが iOS");
    // 同じグループ(一番外側)の中で末尾へ並べ替える。末尾の置き場所は最後の行のすぐ下
    await dragTo(page, rows(page).filter({ hasText: "モバイル" }).getByLabel("ドラッグで移動"), async () => {
      const last = (await rows(page).filter({ hasText: "iOS" }).boundingBox())!;
      return { x: last.x + last.width / 2, y: last.y + last.height + 6 };
    });
    await expect(page.getByTestId("audience-summary")).toHaveText("(画面の幅が 768px 未満) かつ OSが iOS かつ 端末が モバイル");
  });

  test("experiment_targeting_uses_audience_and_publish_preview_marks_it", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await nav(page).getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, EXP_AUD);
    await page.getByRole("button", { name: "+ オーディエンス" }).click();
    const combo = rows(page).nth(0).getByRole("combobox", { name: "オーディエンス" });
    await combo.click();
    await combo.fill("Pricing");
    await page.getByRole("option", { name: /^Pricing visitors/ }).click();
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(1), "条件の種類", "端末");
    await expect(page.getByTestId("targeting-summary")).toHaveText("オーディエンス「Pricing visitors」に含まれる かつ 端末が モバイル");
    await page.getByText("保存される JSON").click();
    await expect(page.getByTestId("targeting-json")).toContainText('"audience": "aud_pricing_visitors"');
    const saved = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE_AUD.id}/experiments/${EXP_AUD.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    expect((await saved).status()).toBe(200);
    expect((await changeStatus(page, SITE_AUD.id, EXP_AUD.id, /^開始/)).publish.ok).toBe(true);

    // 実行中のエクスペリエンスが参照するオーディエンスを編集すると、保存の前に確認を挟む(設計書 §5.3)
    await nav(page).getByRole("link", { name: "オーディエンス" }).click();
    await page.getByRole("link", { name: "Pricing visitors" }).click();
    await rows(page).nth(0).getByLabel("回数").fill("3");
    await rows(page).nth(0).getByLabel("値").fill("/plans/"); // ページの一致を変える = 公開中の /pricing/ の条件は次の公開で数えるのをやめる
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "実行中のエクスペリエンス 1 件の配信対象が変わります" })).toBeVisible();
    await page.getByRole("button", { name: "保存する" }).click();
    await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();

    // Publish の確認画面: オーディエンスの変更で配信対象が変わるエクスペリエンスを「変更あり」として出す
    await openPublish(page);
    const aud = page.getByTestId("publish-aud-aud_pricing_visitors");
    await expect(aud).toContainText(EXP_AUD.name);
    await expect(aud).toContainText("変更あり");
    // 数えるのをやめるページの条件(公開中の設定にあり、下書きに無い)の件数と説明
    const dropped = page.getByTestId("publish-dropped");
    await expect(dropped).toContainText("1 件");
    await expect(dropped).toContainText("「/pricing/」");
  });

  test("completion_criteria_1_conditions_built_on_screen_save_same_json(完成の基準 1 の全条件を画面で作り、保存値と再表示を確かめる)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await nav(page).getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, EXP_C1);
    // 閲覧の回数・30 日の期間
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(0), "条件の種類", "閲覧したページ");
    await rows(page).nth(0).getByLabel("値").fill("/pricing/");
    await rows(page).nth(0).getByLabel("回数").fill("2");
    await choose(rows(page).nth(0), "期間", "最後の閲覧が");
    await expect(rows(page).nth(0).getByLabel("日数")).toHaveValue("30");
    // 目標の未達成(候補の先頭 = 資料請求)
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(1), "条件の種類", "目標・コンバージョン");
    await choose(rows(page).nth(1), "達成", "が未達成");
    // 平日 9〜18 時・iOS・Safari(種類を選んだときの初期値)
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(2), "条件の種類", "曜日・時間帯");
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(3), "条件の種類", "OS");
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(4), "条件の種類", "ブラウザ");
    const summary = "パスが「/pricing/」で始まるページを 2 回以上閲覧(最後の閲覧が 30 日以内) かつ 目標「資料請求」が未達成 かつ 月〜金 の 09:00〜18:00 かつ OSが iOS かつ ブラウザが Safari";
    await expect(page.getByTestId("targeting-summary")).toHaveText(summary);
    const saved = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE_AUD.id}/experiments/${EXP_C1.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    // 送った値と保存された値が、edge・ブラウザの判定のテスト(Task 4)と同じ COMPLETION_1_TARGETING
    expect(res.request().postDataJSON().targeting).toEqual(COMPLETION_1_TARGETING);
    expect((await res.json()).targeting).toEqual(COMPLETION_1_TARGETING);
    // 再表示しても同じ条件
    await page.reload();
    await expect(page.getByTestId("targeting-summary")).toHaveText(summary);
    await expect(rows(page).nth(0).getByLabel("回数")).toHaveValue("2");
    await expect(rows(page).nth(0).getByLabel("日数")).toHaveValue("30");
  });

  test("publish_preview_warns_viewport_condition(画面の幅の条件を使う実行中のエクスペリエンス)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    await nav(page).getByRole("link", { name: "エクスペリエンス" }).click();
    await createExperiment(page, EXP_VP);
    await page.getByRole("button", { name: "+ 条件" }).click();
    await choose(rows(page).nth(0), "条件の種類", "画面の幅");
    const saved = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE_AUD.id}/experiments/${EXP_VP.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存(下書き)" }).click();
    expect((await saved).status()).toBe(200);
    expect((await changeStatus(page, SITE_AUD.id, EXP_VP.id, /^開始/)).publish.ok).toBe(true);
    await openPublish(page);
    await expect(page.getByTestId("publish-viewport")).toContainText(EXP_VP.name);
  });

  // この Site の Publish を止めたままにするので、describe の最後に置く
  test("publish_preview_shows_compile_error_for_site_regex_budget(保存は通るが、Site 全体の正規表現の命令数で Publish が止まる)", async ({ page }) => {
    await login(page);
    await openSite(page, SITE_AUD.name);
    // 1 つずつの上限(200 命令)には収まり、参照の数だけ数えると Site 全体の 500 を超える件数を core で求める
    const src = "^/item/[0-9]{1,60}$";
    const r = compileRegex(src);
    if (!r.ok) throw new Error(r.issue.code);
    expect(r.instructions).toBeGreaterThan(100); // 準備のエクスペリエンスを 5 件以下に抑える
    const n = Math.floor(REGEX_LIMITS.instructionsPerSite / r.instructions) + 1;
    expect((await page.request.post(`/api/control/sites/${SITE_AUD.id}/audiences`, { data: { id: "aud_e2e_budget", name: "E2E budget", definition: { ctx: "path", op: "regex", value: src } } })).status()).toBe(201);
    for (let i = 0; i < n; i++) {
      await nav(page).getByRole("link", { name: "エクスペリエンス" }).click(); // 2 回目以降は編集画面にいるので、毎回実験の一覧へ戻ってから作る
      const e = { id: `exp_e2e_budget_${i}`, name: `E2E budget ${i}` };
      await createExperiment(page, e);
      expect((await page.request.patch(`/api/control/sites/${SITE_AUD.id}/experiments/${e.id}`, { data: { targeting: { audience: "aud_e2e_budget" } } })).status()).toBe(200); // 保存は通る
      await changeStatus(page, SITE_AUD.id, e.id, /^開始/); // 最後の 1 件の自動 Publish は止まるが、status は running になる
    }
    await openPublish(page);
    const err = page.getByTestId("publish-compile-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("いまの下書きは公開で止まります");
    await expect(err).toContainText("オーディエンス aud_e2e_budget"); // hint の場所に原因のオーディエンス(P20)
  });
});
