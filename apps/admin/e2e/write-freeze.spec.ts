import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { EXPERIMENT, HERO_TEXT, SITE, appAlert, login, openSite, waitForHydration } from "./fixtures";

/**
 * backlog D13 / 決定 56: 凍結中の管理画面。スイッチは運用者と同じく wrangler d1 execute で入れる(--local・E2E の状態ディレクトリ)。
 * 動いている wrangler dev と同じ sqlite に書く。終わったら必ず外す(後の project に凍結を残さない)。
 * 保存はサイト設定の外部計測の欄(1 回の要求で保存する画面の代表。publish-flow と同じ操作)と、エクスペリエンスの編集画面(3 段の保存)で確かめる。
 * ログインは 1 回だけ(sign-in の予算。fixtures.ts の login() のコメント)
 */
const control = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../control");
const d1 = (sql: string) =>
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "wtt-control", "--local", "--persist-to", ".e2e-state", "--command", sql], { cwd: control, stdio: "pipe" });
const FREEZE =
  "insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', json_object('reason', 'E2E の更新', 'until', '2099-01-01T12:00:00+09:00'), 1, null) on conflict(key) do update set value = excluded.value";
const UNFREEZE = "delete from instance_settings where key = 'writeFreeze'";

test.afterEach(() => {
  d1(UNFREEZE);
});

/** タブが前に戻ったときの取り直し(P17)を起こす。60 秒の取り直しを待たずに確かめるため */
const refocus = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const FROZEN_503 = {
  error: "write_frozen",
  message: "メンテナンス中のため、変更を保存できません",
  hint: "理由: E2E の更新。メンテナンスが終わってから、もう一度実行してください",
  reason: "E2E の更新",
  until: null,
  retryAfter: 300,
};

test("the banner follows freeze and thaw without a reload; a save shows the reason; a partly saved editor keeps the input and saves the rest later", async ({ page }) => {
  await login(page);
  await openSite(page, SITE.name);
  const banner = page.getByTestId("write-freeze-banner");
  await expect(banner).toHaveCount(0);

  // 凍結を入れる前から開いていた画面にも、再読み込みせずに帯が出る(P17。レビュー r1 CL-High-1)
  d1(FREEZE);
  await refocus(page);
  await expect(banner).toContainText("メンテナンス中のため、変更は保存できません。理由: E2E の更新");
  await expect(banner).toContainText("再開の見込み: "); // 時刻の表記はブラウザのタイムゾーンで変わるので、項目があることだけを見る
  await page.getByRole("link", { name: "設定" }).click();
  await expect(banner).toBeVisible(); // 別のページでも出る
  await page.getByTestId("section-external").click();
  await waitForHydration(page);
  const ga4 = page.locator('input[name="ga4PropertyId"]');
  await ga4.fill("987654321");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(appAlert(page)).toContainText("メンテナンス中のため、変更を保存できません");
  await expect(appAlert(page)).toContainText("理由: E2E の更新");
  await expect(ga4).toHaveValue("987654321"); // 入力は消えない

  // 外すと、再読み込みせずに帯が消え、同じ入力で保存できる
  d1(UNFREEZE);
  await refocus(page);
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();
  await expect(ga4).toHaveValue("987654321");
  // 後の project のために空に戻す(publish-flow の終わりと同じ状態)
  await ga4.fill("");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();

  // エクスペリエンスの編集画面: 3 段の保存の途中(パターン b の変更)で凍結に当たる(決定 56 (5)。レビュー r1 CX-Medium-3)。
  // 凍結の判定の時刻を選べないので、b の変更の PUT だけを Playwright で 503 write_frozen にする(概要の PATCH と a の変更は control に届く)。
  // EXPERIMENT は running なのでパターンの一覧の PUT は送られない(variantsLocked)
  await openSite(page, SITE.name);
  await page.getByRole("link", { name: EXPERIMENT.name }).click();
  await page.getByRole("tab", { name: "パターン" }).click();
  await page.getByTestId("variant-pick-b").click();
  const text = page.getByTestId("variant-b").getByTestId("change-TEXT").locator("textarea");
  await text.fill("E2E 凍結の確認");
  const bChanges = `**/api/control/sites/${SITE.id}/experiments/${EXPERIMENT.id}/variants/b/changes`;
  await page.route(bChanges, (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(FROZEN_503) }) : route.continue(),
  );
  await page.getByRole("button", { name: "保存(下書き)" }).click();
  await expect(appAlert(page)).toContainText("一部は保存されています。入力はそのまま残っています。メンテナンスが終わってからもう一度保存すると、残りも保存されます");
  await expect(appAlert(page)).not.toContainText("再読み込み");
  await expect(text).toHaveValue("E2E 凍結の確認"); // 再読み込みしていないので入力が残っている
  // 凍結が外れた後に押し直すと、残り(b の変更)も保存される
  await page.unroute(bChanges);
  const saved = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE.id}/experiments/${EXPERIMENT.id}/variants/b/changes`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "保存(下書き)" }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await waitForHydration(page); // 次のタブの切替(React の onClick)の前に
  await page.getByRole("tab", { name: "パターン" }).click();
  await page.getByTestId("variant-pick-b").click();
  await expect(text).toHaveValue("E2E 凍結の確認"); // 保存された内容が読み直しても同じ
  // 後の project のために元の文に戻す
  await text.fill(HERO_TEXT);
  const restored = page.waitForResponse((r) => r.url().includes(`/api/control/sites/${SITE.id}/experiments/${EXPERIMENT.id}/variants/b/changes`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "保存(下書き)" }).click();
  expect((await restored).status()).toBe(200);
});
