import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type Request } from "@playwright/test";
import { appAlert, createSite, login, waitForHydration } from "./fixtures";

/**
 * D9 ②・③: Site の設定の「結果を記録する」。E2E の control には計測用のデータベース(RESULTS_DB = ローカルの wtt-results。plan ③ の K26)があるので、
 * (1) 記録しない Site で有効にでき、実行中のテストがあれば「対象にならない」件数入りの確認が出て、キャンセルなら保存せず、確定すれば保存されること、
 * (2) 有効な Site で止めるとき、記録中のテストの件数入りの確認が出て、キャンセルなら保存せず、確定すれば保存されること、
 * (3) 計測用のデータベースの使用量が上限の 80% / 95% 以上になると、設定の画面に警告が出ること
 * を確かめる。(2) の「記録中のテスト」は運用者と同じく wrangler d1 execute で run_id を振って作る(--local・E2E の状態ディレクトリ。write-freeze と同じ)。
 * 記録する開始そのもの(評価計画の固定と run_id の発行)は results-flow.spec.ts が画面で通す。
 * ログインは 1 回だけ(sign-in の予算。fixtures.ts の login() のコメント)
 */
const control = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../control");
const d1 = (sql: string): string =>
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "wtt-control", "--local", "--persist-to", ".e2e-state", "--json", "--command", sql], { cwd: control, stdio: "pipe", encoding: "utf8" });
/** 1 行目の最初の列の値を数値で読む(select count(*) など) */
const scalar = (sql: string): number => {
  const out = d1(sql);
  const rows = JSON.parse(out.slice(out.indexOf("[\n"))) as Array<{ results: Array<Record<string, number>> }>;
  return Number(Object.values(rows[0]!.results[0]!)[0]);
};

const SITE_RES = { id: "site_e2e_res", name: "E2E Results Site" };
const EXP_ID = "exp_e2e_res";

/** 管理画面の BFF 経由で control を呼ぶ(準備だけに使い、確かめる操作は画面で行う) */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(`/api/control${p}`, { method: m, headers: b === undefined ? undefined : { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return r.status;
    },
    [method, path, body] as const,
  );
}

test("results recording: enabling asks with the running-test count; stopping asks with the recorded-test count; cancel does not save", async ({ page }) => {
  await login(page);
  await createSite(page, SITE_RES); // 記録しない設定で作る(fixtures.ts の createSite)
  const siteUrl = page.url();
  // 実行中のテスト 1 件を作る(開始の公開まで通す。記録しない Site なので評価計画は要らない)
  expect(await api(page, "POST", `/sites/${SITE_RES.id}/experiments`, { id: EXP_ID, name: EXP_ID, urlMatch: { op: "contains", value: "/" } })).toBe(201);
  expect(await api(page, "PUT", `/sites/${SITE_RES.id}/experiments/${EXP_ID}/variants/b/changes`, [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "res" } }])).toBe(200);
  expect(await api(page, "POST", `/sites/${SITE_RES.id}/experiments/${EXP_ID}/status`, { status: "running" })).toBe(200);

  let patches = 0;
  const onRequest = (r: Request) => {
    if (r.method() === "PATCH" && new URL(r.url()).pathname.endsWith(`/sites/${SITE_RES.id}`)) patches += 1;
  };
  try {
    // (1) 計測用のデータベースがある導入: 記録しない Site のスイッチは押せ、案内は出ない。CSP の案内は(無効なので)出ない
    await page.goto(`${siteUrl}/settings`);
    await waitForHydration(page);
    const toggle = page.locator('input[name="resultsEnabled"]');
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText("計測用のデータベースが導入されていません。導入ガイドの手順で作ってください")).toHaveCount(0);
    await expect(page.getByTestId("results-csp-notice")).toHaveCount(0);

    page.on("request", onRequest);
    await toggle.check();
    // サイトのドメイン(localhost)と edge のアドレスが違うので、connect-src の案内
    await expect(page.getByTestId("results-csp-notice")).toContainText("connect-src");
    await page.getByRole("button", { name: "保存" }).click();
    const enable = page.getByRole("alertdialog", { name: "結果の記録を有効にしますか?" });
    await expect(enable).toContainText("実行中の 1 件のテストは対象になりません");
    await enable.getByRole("button", { name: "キャンセル" }).click();
    await expect(enable).toBeHidden();
    expect(patches).toBe(0); // キャンセルでは保存の要求を送らない
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(0);

    await page.getByRole("button", { name: "保存" }).click();
    await enable.getByRole("button", { name: "有効にして保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    expect(patches).toBe(1);
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(1);

    // (2) そのテストが記録中の状態にする(開始の後に有効にしたテストは記録しないので、画面からは作れない)
    d1(`update experiments set run_id = 'run_e2e_res' where site_id = '${SITE_RES.id}' and id = '${EXP_ID}'`);
    await page.reload();
    await waitForHydration(page);
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole("button", { name: "保存" }).click();
    const dialog = page.getByRole("alertdialog", { name: "結果の記録を止めますか?" });
    await expect(dialog).toContainText("記録中の 1 件のテストの記録が止まります");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    expect(patches).toBe(1); // キャンセルでは保存の要求を送らない
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(1);

    // 確定すると保存され、無効になる
    await page.getByRole("button", { name: "保存" }).click();
    await dialog.getByRole("button", { name: "止めて保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    expect(patches).toBe(2);
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(0);

    // (3) 計測用のデータベースの使用量(Cron が測って results_store_status に書く値)が上限(500 MB)の 80% / 95% 以上になると、
    // 設定の画面に警告が出る(D9 ③ Task 16)。測った値は運用者と同じく wrangler d1 execute で入れる
    const capacity = page.getByTestId("results-capacity-warning");
    await expect(capacity).toHaveCount(0); // 測った値が無ければ出さない
    d1(`insert or replace into results_store_status (id, size_bytes, measured_at) values (1, 410000000, ${Date.now()})`);
    await page.reload();
    await waitForHydration(page);
    await expect(capacity).toHaveAttribute("data-level", "warning");
    await expect(capacity).toContainText("上限の 80% 以上になりました(約 410 MB / 500 MB)");
    d1(`insert or replace into results_store_status (id, size_bytes, measured_at) values (1, 480000000, ${Date.now()})`);
    await page.reload();
    await waitForHydration(page);
    await expect(capacity).toHaveAttribute("data-level", "stopped");
    await expect(capacity).toContainText("上限の 95% 以上になったため、参加と CV の記録を止めています(約 480 MB / 500 MB)");
  } finally {
    // 使用量の値は導入全体のもの(ほかの spec の開始の警告に効く)なので必ず消す
    d1("delete from results_store_status where id = 1");
    page.off("request", onRequest);
    d1(`update experiments set run_id = null where site_id = '${SITE_RES.id}'`);
    d1(`update sites set results_enabled = 0 where id = '${SITE_RES.id}'`);
  }
});
