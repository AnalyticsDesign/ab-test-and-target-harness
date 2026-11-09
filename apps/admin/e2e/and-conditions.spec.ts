import { test, expect, type Page, type Request } from "@playwright/test";
import { appAlert, controlHeaders, createExperiment, createSite, login, pick, waitForHydration } from "./fixtures";

/**
 * 対象 URL の「かつ」の条件(B69 and、最終レビュー T4-c)。実際の画面で次を確かめる:
 * 1.「+ 条件(かつ)」で and の条件が足される(最初の条件がホストなら、足されるのはパスの条件)
 * 2. 保存して再読み込みしても and の条件が残る(欄の値・条件の種類・要約の文)
 * 3.「この行を消す」で行を消せる(含めるが 2 行以上のときだけ出る)
 * 4. 最初の条件の × は and の先頭を最初の条件に繰り上げる
 * 5. and の無い行で最初の条件の × を押すと、値だけが空になり、行とパラメータは残る
 * 6. 最初の条件が空のままでは保存できず、案内の文を出す(PATCH を送らない)
 *
 * 専用のサイトと下書きのエクスペリエンスを作る(実行中の確認の窓を出さないため・ほかの spec の数に触れないため)
 */

const SITE = { id: "site_e2e_and", name: "E2E And Conditions" };
const EXP = { id: "exp_e2e_and", name: "E2E and conditions" };
const HOST = "shop.example.com";
const AND_PATH = "/sale/";
const SAVED = "保存しました";
const GUIDANCE = "ページの条件を入れてください(すべてのページなら『パスが / で始まる』)";

/** 画面を通さずに BFF を呼ぶ(保存された値の確かめ) */
async function control(page: Page, path: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return page.evaluate(
    async ([p, h]) => {
      const r = await fetch(`/api/control${p}`, { headers: h });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    },
    [path, controlHeaders()] as const,
  );
}

test.describe.serial("target URL and-conditions (B69 and)", () => {
  let page: Page;
  let siteUrl: string;
  const apiPath = `/sites/${SITE.id}/experiments/${EXP.id}`;
  const openExperiment = async () => {
    await page.goto(`${siteUrl}/experiments/${EXP.id}`);
    await waitForHydration(page);
  };
  const region = () => page.getByRole("region", { name: "配信条件" });
  /** 含めるの枠(配信条件の節には訪問者の条件の「値」の欄もあるので、対象 URL の欄はこの枠の中だけで探す) */
  const include = () => region().getByRole("group", { name: "含める", exact: true });
  const values = () => include().getByRole("textbox", { name: "値", exact: true });
  const firstValue = () => include().locator('input[name="value"]');
  const kindPickers = () => include().getByRole("combobox", { name: "条件の種類", exact: true });
  const firstPart = () => include().getByRole("combobox", { name: "照合する部分", exact: true });
  const removeX = () => include().getByRole("button", { name: "この条件を消す", exact: true });
  const removeRow = () => include().getByRole("button", { name: "この行を消す", exact: true });
  const addAnd = () => include().getByRole("button", { name: "+ 条件(かつ)", exact: true });
  const paramName = () => include().getByRole("textbox", { name: "パラメータの名前", exact: true });
  const paramValue = () => include().getByRole("textbox", { name: "パラメータの値", exact: true });
  const summary = () => region().getByText("動かすページ:").locator("..");
  const saveButton = () => page.getByRole("button", { name: "保存(下書き)" });
  const saveState = () => page.getByTestId("save-state");

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("setup: a site and a draft experience", async () => {
    await createSite(page, SITE);
    siteUrl = page.url();
    await createExperiment(page, EXP);
  });

  test("+ 条件(かつ) adds a path condition after a host first condition", async () => {
    await openExperiment();
    await pick(include(), "照合する部分", "ホスト");
    await firstValue().fill(HOST);
    await expect(kindPickers()).toHaveCount(0);
    await addAnd().click();
    // 最初の条件がホストなので、足されるのはパスの条件
    await expect(kindPickers()).toHaveCount(1);
    await expect(kindPickers()).toHaveText(/^パス/);
    await expect(values()).toHaveCount(2);
    await values().nth(1).fill(AND_PATH);
    await expect(summary()).toContainText(`ホスト が「${HOST}」と完全一致 かつ パス が「${AND_PATH}」で始まる`);
  });

  test("この行を消す deletes a row and is hidden on the last include row", async () => {
    // 含めるが 1 行のときは出ない
    await expect(removeRow()).toHaveCount(0);
    await include().getByRole("button", { name: "+ 含めるページ", exact: true }).click();
    await expect(removeRow()).toHaveCount(2);
    await values().nth(2).fill("/other/");
    await expect(summary()).toContainText("または");
    await removeRow().nth(1).click();
    await expect(removeRow()).toHaveCount(0);
    await expect(values()).toHaveCount(2);
    await expect(summary()).not.toContainText("/other/");
  });

  test("save, then reload: the and condition is still there", async () => {
    await saveButton().click();
    await expect(saveState()).toHaveText(SAVED);
    const saved = await control(page, apiPath);
    expect(saved.status).toBe(200);
    const exp = saved.json as { urlMatch: unknown };
    expect(exp.urlMatch).toEqual({ include: [{ page: { part: "host", op: "equals", value: HOST }, and: [{ part: "path", op: "startsWith", value: AND_PATH }] }] });

    await page.reload();
    await waitForHydration(page);
    await expect(firstPart()).toHaveText(/^ホスト/);
    await expect(firstValue()).toHaveValue(HOST);
    await expect(kindPickers()).toHaveCount(1);
    await expect(kindPickers()).toHaveText(/^パス/);
    await expect(values().nth(1)).toHaveValue(AND_PATH);
    await expect(summary()).toContainText(`ホスト が「${HOST}」と完全一致 かつ パス が「${AND_PATH}」で始まる`);
  });

  test("the first condition's × promotes the first and condition", async () => {
    await expect(removeX()).toHaveCount(2); // 最初の条件と and の 1 つ
    await removeX().first().click();
    await expect(kindPickers()).toHaveCount(0);
    await expect(values()).toHaveCount(1);
    await expect(firstPart()).toHaveText(/^パス/);
    await expect(firstValue()).toHaveValue(AND_PATH);
    await expect(summary()).toContainText(`パス が「${AND_PATH}」で始まる`);
    await expect(summary()).not.toContainText("かつ");
  });

  test("without and, the first condition's × clears only its value; the row and params stay", async () => {
    // and の無い、パラメータだけの行を作る(足した and の条件の種類をパラメータに替えると、パラメータの並びに移る)
    await addAnd().click();
    await expect(kindPickers()).toHaveCount(1);
    await pick(include(), "条件の種類", "パラメータ");
    await expect(paramName()).toHaveCount(1);
    await expect(values()).toHaveCount(1); // and の値の欄は無くなった
    await paramName().fill("utm_source");
    await paramValue().fill("news");

    await removeX().first().click();
    await expect(firstValue()).toHaveValue("");
    await expect(firstPart()).toHaveText(/^パス/);
    await expect(paramName()).toHaveValue("utm_source");
    await expect(paramValue()).toHaveValue("news");
    await expect(include().getByRole("button", { name: "+ 条件(かつ)", exact: true })).toHaveCount(1); // 行は残る
  });

  test("an empty first condition blocks saving and shows the guidance", async () => {
    // 行の下の案内はすぐ出る
    await expect(include().getByText(GUIDANCE, { exact: true })).toBeVisible();
    let patches = 0;
    const onRequest = (r: Request) => {
      if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/control${apiPath}`) patches += 1;
    };
    page.on("request", onRequest);
    try {
      await saveButton().click();
      await expect(appAlert(page)).toContainText(`対象 URL(含める 1 行目): ${GUIDANCE}`);
      expect(patches).toBe(0);
    } finally {
      page.off("request", onRequest);
    }
    // 保存された値は前のまま(and の付いた行)
    const saved = await control(page, apiPath);
    const exp = saved.json as { urlMatch: { include: Array<{ and?: unknown }> } };
    expect(exp.urlMatch.include[0]?.and).toEqual([{ part: "path", op: "startsWith", value: AND_PATH }]);
  });
});
