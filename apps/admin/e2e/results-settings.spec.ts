import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page, type Request } from "@playwright/test";
import { appAlert, createSite, login, waitForHydration } from "./fixtures";

/**
 * D9 ②: Site の設定の「結果を記録する」。E2E の control には計測用のデータベース(RESULTS_DB)の binding が無い(= resultsStore が偽)ので、
 * (1) 有効にできない(スイッチが押せない・案内が出る)ことと、
 * (2) すでに有効な Site で止めるとき、記録中のテストの件数入りの確認が出て、キャンセルなら保存せず、確定すれば保存されること
 * を確かめる。(2) の「有効な Site・記録中のテスト」は運用者と同じく wrangler d1 execute で作る(--local・E2E の状態ディレクトリ。write-freeze と同じ)。
 * 有効にする側の確認(実行中の件数)は計測用のデータベースが要るので、test/results-settings.test.ts の文の検査に任せる。
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

test("results recording: the switch is locked without a store; stopping asks with the recorded-test count and cancel does not save", async ({ page }) => {
  await login(page);
  await createSite(page, SITE_RES);
  const siteUrl = page.url();
  // 実行中のテスト 1 件を作る(開始の公開まで通す)
  expect(await api(page, "POST", `/sites/${SITE_RES.id}/experiments`, { id: EXP_ID, name: EXP_ID, urlMatch: { op: "contains", value: "/" } })).toBe(201);
  expect(await api(page, "PUT", `/sites/${SITE_RES.id}/experiments/${EXP_ID}/variants/b/changes`, [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "res" } }])).toBe(200);
  expect(await api(page, "POST", `/sites/${SITE_RES.id}/experiments/${EXP_ID}/status`, { status: "running" })).toBe(200);

  // (1) binding が無い導入: スイッチは押せず、案内が出る。CSP の案内は(無効なので)出ない
  await page.goto(`${siteUrl}/settings`);
  await waitForHydration(page);
  const toggle = page.locator('input[name="resultsEnabled"]');
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("計測用のデータベースが導入されていません。導入ガイドの手順で作ってください")).toBeVisible();
  await expect(page.getByTestId("results-csp-notice")).toHaveCount(0);

  try {
    // (2) すでに有効で、そのテストが記録中の状態にする(control の画面からは作れない = binding が無いため)
    d1(`update sites set results_enabled = 1 where id = '${SITE_RES.id}'`);
    d1(`update experiments set run_id = 'run_e2e_res' where site_id = '${SITE_RES.id}' and id = '${EXP_ID}'`);
    await page.reload();
    await waitForHydration(page);
    await expect(toggle).toBeEnabled(); // binding が無くても、すでに有効なら止められる
    await expect(toggle).toBeChecked();
    // サイトのドメイン(localhost)と edge のアドレスが違うので、connect-src の案内
    await expect(page.getByTestId("results-csp-notice")).toContainText("connect-src");

    let patches = 0;
    const onRequest = (r: Request) => {
      if (r.method() === "PATCH" && new URL(r.url()).pathname.endsWith(`/sites/${SITE_RES.id}`)) patches += 1;
    };
    page.on("request", onRequest);
    await toggle.uncheck();
    await page.getByRole("button", { name: "保存" }).click();
    const dialog = page.getByRole("alertdialog", { name: "結果の記録を止めますか?" });
    await expect(dialog).toContainText("記録中の 1 件のテストの記録が止まります");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    expect(patches).toBe(0); // キャンセルでは保存の要求を送らない
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(1);

    // 確定すると保存され、無効になる
    await page.getByRole("button", { name: "保存" }).click();
    await dialog.getByRole("button", { name: "止めて保存" }).click();
    await expect(page.getByText("保存しました")).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    expect(patches).toBe(1);
    expect(scalar(`select results_enabled from sites where id = '${SITE_RES.id}'`)).toBe(0);
    page.off("request", onRequest);
  } finally {
    d1(`update experiments set run_id = null where site_id = '${SITE_RES.id}'`);
    d1(`update sites set results_enabled = 0 where id = '${SITE_RES.id}'`);
  }
});
