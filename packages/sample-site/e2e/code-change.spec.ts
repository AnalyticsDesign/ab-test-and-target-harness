import { test, expect, type Page } from "@playwright/test";
import { findVisitor, presetVisitor, readDataLayer } from "./helpers";

type W = Window & { __wttRuns?: number; __wttJsRuns?: number; __wttInert?: number; __cspViolations?: number };
const runs = (page: Page) => page.evaluate(() => (window as unknown as W).__wttRuns ?? 0);
const jsRuns = (page: Page) => page.evaluate(() => (window as unknown as W).__wttJsRuns ?? 0);
const exposuresOf = async (page: Page, experimentId: string) =>
  (await readDataLayer(page)).filter((e) => e.event === "ab_exposure" && e.ab_experiment_id === experimentId);
const countViolations = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as W;
    w.__cspViolations = 0;
    document.addEventListener("securitypolicyviolation", () => {
      w.__cspViolations = (w.__cspViolations ?? 0) + 1;
    });
  });

test("css_only_experiment_exposes_both_arms_at_boot", async ({ context, page }) => {
  // spec §10.5 / 決定 38 (1): CSS だけの Variant を持つ Experiment は compile が exposureSelectors に :root を足すので、
  // 対照(vA)も処理群(vB)も起動直後に 1 回だけ Exposure する
  // exp_hero(全ページ一致)も c_css を持ち、この訪問者は exp_hero では vB なので、Experiment で絞って数える(r2 CX-High-6)
  await presetVisitor(context, findVisitor("exp_css", "B"));
  await page.goto("/code.html");
  await expect(page.locator("style[data-ab-experiment='exp_css']")).toHaveCount(1);
  await expect(page.locator(".code-title")).toHaveCSS("letter-spacing", "5px");
  await expect.poll(() => exposuresOf(page, "exp_css")).toHaveLength(1);
  expect((await exposuresOf(page, "exp_css"))[0]!.ab_variant_id).toBe("vB");

  await context.clearCookies();
  await presetVisitor(context, findVisitor("exp_css", "A"));
  await page.goto("/code.html");
  await expect.poll(() => exposuresOf(page, "exp_css")).toHaveLength(1);
  expect((await exposuresOf(page, "exp_css"))[0]!.ab_variant_id).toBe("vA");
  await expect(page.locator("style[data-ab-experiment='exp_css']")).toHaveCount(0);
});

test("custom_js_receives_ctx_and_runs_once_per_page", async ({ context, page }) => {
  // spec §11 / 決定 38 (2): function(element, ctx) の ctx は { experimentId, variantId, changeId }。§10.4: 再描画で再実行しない
  await presetVisitor(context, findVisitor("exp_code", "B"));
  await page.goto("/code.html");
  await expect(page.locator(".code-title")).toHaveAttribute("data-ctx", "exp_code/vB/c_js");
  expect(await jsRuns(page)).toBe(1);
  await page.click("#rerender");
  await expect(page.locator(".after-throw")).toHaveText("still applied"); // 再適用が済むまで待つ(TEXT は再適用される)
  expect(await jsRuns(page)).toBe(1); // CUSTOM_JS は再実行しない
  await expect(page.locator(".code-title")).not.toHaveAttribute("data-ctx", /./); // 新要素には付かない
  expect(await exposuresOf(page, "exp_code")).toHaveLength(1);
});

test("scripts_remain_once_per_page", async ({ context, page }) => {
  // spec §10.4 / §18.1: HTML runScripts:true の <script> は初回だけ実行。再描画後の再適用は DOM 挿入のみ。runScripts:false は実行されない
  await presetVisitor(context, findVisitor("exp_code", "B"));
  await page.goto("/code.html");
  await expect(page.locator(".injected-script")).toHaveCount(1);
  await expect.poll(() => runs(page)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as W).__wttInert)).toBeUndefined(); // runScripts:false(c_html_inert)は走らない
  await expect(page.locator(".slot script")).toHaveCount(2); // 不活性の <script> と作り直した <script> の 2 つが残る
  await page.click("#rerender");
  await expect(page.locator(".injected-script")).toHaveCount(1); // 新しい .slot に再挿入される
  await expect(page.locator(".slot script")).toHaveCount(2); // <script> 要素は挿入されるが…
  await page.waitForTimeout(200);
  expect(await runs(page)).toBe(1); // …実行はされない
  expect(await page.evaluate(() => (window as unknown as W).__wttInert)).toBeUndefined();
});

test("custom_js_exception_skips_only_that_change", async ({ context, page }) => {
  // spec §10.7: throw する CUSTOM_JS(c_js_throw)の後ろの TEXT(c_text_after)も適用される
  await presetVisitor(context, findVisitor("exp_code", "B"));
  await page.goto("/code.html");
  await expect(page.locator(".after-throw")).toHaveText("still applied");
  await expect(page.locator(".code-title")).toHaveAttribute("data-ctx", "exp_code/vB/c_js");
});

test("custom_js_runs_under_nonce_strict_dynamic_csp", async ({ context, page }) => {
  // spec §11 / 決定 38 (3): script-src 'nonce-…' 'strict-dynamic' のページで、runtime が nonce を引き継いだ
  // <script>(CUSTOM_JS・HTML 内)と <style>(prehide・CSS)が動き、CSP 違反が 0 件(prehide に nonce が無いとここで 1 件出る)
  await presetVisitor(context, findVisitor("exp_code", "B"));
  await countViolations(page);
  const cspHeader = page.waitForResponse((r) => r.url().endsWith("/code-csp.html"));
  await page.goto("/code-csp.html");
  expect((await cspHeader).headers()["content-security-policy"]).toContain("'strict-dynamic'"); // ヘッダが本当に効いている
  await expect(page.locator(".code-title")).toHaveAttribute("data-ctx", "exp_code/vB/c_js");
  await expect(page.locator(".injected-script")).toHaveCount(1);
  await expect.poll(() => runs(page)).toBe(1);
  await expect(page.locator(".after-throw")).toHaveText("still applied");
  expect(await page.evaluate(() => (window as unknown as W).__cspViolations)).toBe(0);
});

test("custom_js_blocked_by_csp_does_not_expose_or_retry", async ({ context, page }) => {
  // r1 CX-Medium-2: 'self' だけの CSP では生成する inline <script> がブロックされる。CUSTOM_JS だけの Variant は
  // 「適用失敗」= 処理群の Exposure なし。試行は 1 回(再試行しない)
  await presetVisitor(context, findVisitor("exp_js_only", "B"));
  await countViolations(page);
  const cspHeader = page.waitForResponse((r) => r.url().endsWith("/blocked-js.html"));
  await page.goto("/blocked-js.html");
  expect((await cspHeader).headers()["content-security-policy"]).toBe("script-src 'self'");
  await page.waitForTimeout(500);
  await expect(page.locator(".code-title")).not.toHaveAttribute("data-blocked", /./);
  expect(await exposuresOf(page, "exp_js_only")).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as W).__cspViolations)).toBe(1); // 登録用 <script> の 1 回だけ(再試行なし)
});
