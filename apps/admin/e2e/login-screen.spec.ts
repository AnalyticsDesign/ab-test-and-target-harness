import { test, expect } from "@playwright/test";
import { CONTROL_URL, appAlert, login, openWorkspace } from "./fixtures";

/** Google の経路のうち、Google を呼ばずに確かめられる部分(入口の行き先・失敗の表示・交換の拒否) */
test("the login screen leads to Google through the BFF and explains OAuth failures", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Google でログイン" })).toHaveAttribute("href", "/api/session/google");
  const start = await request.get("/api/session/google?next=/invite/abc", { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const toControl = new URL(start.headers().location!);
  expect(toControl.origin + toControl.pathname).toBe(`${CONTROL_URL}/auth/google/start`);
  expect(toControl.searchParams.get("flow")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(toControl.searchParams.get("next")).toBe("/invite/abc");
  // control の start は Google の認可画面へ(E2E 用のダミー client_id)
  const toGoogle = await request.get(toControl.toString(), { maxRedirects: 0 });
  expect(toGoogle.status()).toBe(302);
  expect(toGoogle.headers().location).toContain("https://accounts.google.com/o/oauth2/v2/auth");

  await page.goto("/login?error=not_invited");
  await expect(appAlert(page)).toContainText("有効な招待もありません");
  // このブラウザはログインを始めていない(flow Cookie が無い)ので、他人の戻り URL を開いてもセッションは張られない
  await page.goto("/api/session/oauth?code=bogus&flow=someone-elses-flow-0123");
  await expect(page).toHaveURL(/\/login\?error=oauth_failed$/);
});

// B141: ファビコン。app/icon.svg を vinext の build が Worker に埋め込み、head に link を足して /icon.svg?<内容のハッシュ> で配る。
// link はルートの layout が全画面に付けるので、ログインせずに開ける /login で確かめる
test("the head links the favicon and the Worker serves it as SVG", async ({ page, request }) => {
  await page.goto("/login");
  const href = await page.locator('head link[rel="icon"]').getAttribute("href");
  expect(href).toMatch(/^\/icon\.svg\?/);
  const res = await request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/svg+xml");
  expect(await res.text()).toContain('viewBox="0 0 32 32"');
});

test("the flow cookie is really gone from the browser after the return leg (same-path expiry)", async ({ page, context }) => {
  // Google へは行かず、入口の 302 だけ受けて Cookie を得る
  await page.request.get("/api/session/google", { maxRedirects: 0 });
  const before = (await context.cookies()).find((c) => c.name === "wtt_oauth_flow");
  expect(before?.path).toBe("/api/session");
  await page.goto(`/api/session/oauth?flow=${before!.value}`); // code なし → 失敗の着地。Cookie は消費される
  await expect(page).toHaveURL(/\/login\?error=oauth_failed$/);
  expect((await context.cookies()).some((c) => c.name === "wtt_oauth_flow")).toBe(false);
});

test("while the emergency door is open, the login screen shows the emergency form and every signed-in page shows the banner", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "非常用: メールアドレスとパスワード" })).toBeVisible();
  await login(page);
  await expect(page.getByTestId("break-glass-banner")).toBeVisible();
  await openWorkspace(page);
  await expect(page.getByTestId("break-glass-banner")).toBeVisible();
});
