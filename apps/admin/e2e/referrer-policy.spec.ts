import { test, expect } from "@playwright/test";
import { ADMIN_URL, CONTROL_URL } from "./fixtures";

test("HTML と BFF に same-origin を付け、OAuth の戻りの no-referrer も保つ", async ({ request }) => {
  for (const path of ["/login", "/api/control/me"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()["referrer-policy"], path).toBe("same-origin");
  }
  // vinext の headers() は302の入口には付かない。入口の漏出防止はブラウザの遷移テストで見る。
  const callback = await request.get("/api/session/oauth?flow=invalid", { maxRedirects: 0 });
  expect(callback.status()).toBe(302);
  expect(callback.headers()["referrer-policy"]).toBe("no-referrer");
});

test("管理画面内の Referer は保ち、外部の画像とリンクには送らない", async ({ page }) => {
  await page.route("https://outside.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "outside" }));
  await page.goto("/login");
  const inside = page.waitForRequest((req) => req.url() === `${ADMIN_URL}/api/control/me?referrer-test`);
  await page.evaluate(() => fetch("/api/control/me?referrer-test"));
  expect((await (await inside).allHeaders()).referer).toBe(`${ADMIN_URL}/login`);

  const imageRequest = page.waitForRequest("https://outside.example.test/image.png");
  await page.evaluate(() => { const img = new Image(); img.src = "https://outside.example.test/image.png"; document.body.append(img); });
  expect((await (await imageRequest).allHeaders()).referer).toBeUndefined();

  await page.evaluate(() => { const a = document.createElement("a"); a.href = "https://outside.example.test/link"; a.textContent = "外部リンクの検証"; document.body.append(a); });
  const linkRequest = page.waitForRequest("https://outside.example.test/link");
  await page.getByRole("link", { name: "外部リンクの検証" }).click();
  expect((await (await linkRequest).allHeaders()).referer).toBeUndefined();
});

test("Google ログインの control への遷移に Referer を送らず、flow Cookie は残す", async ({ page, context }) => {
  await page.route(`${CONTROL_URL}/auth/google/start**`, (route) => route.fulfill({ contentType: "text/html", body: "control start" }));
  await page.goto("/login");
  const start = page.waitForRequest((req) => req.url().startsWith(`${CONTROL_URL}/auth/google/start?`));
  await page.getByRole("link", { name: "Google でログイン" }).click();
  const req = await start;
  expect((await req.allHeaders()).referer).toBeUndefined();
  const flow = new URL(req.url()).searchParams.get("flow");
  expect(flow).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  const cookie = (await context.cookies(ADMIN_URL)).find((c) => c.name === "wtt_oauth_flow");
  expect(cookie?.value).toBe(flow);
});

test("同一オリジンの native form POST は Origin を保ち、ログアウトの門を通る", async ({ page }) => {
  await page.goto("/login");
  const logout = page.waitForResponse((res) => res.url() === `${ADMIN_URL}/api/session/logout` && res.request().method() === "POST");
  // UserMenu と同じ native form POST。ログイン無しでも出自の門と戻り先を検証できる。
  await page.evaluate(() => { const form = document.createElement("form"); form.action = "/api/session/logout"; form.method = "post"; document.body.append(form); form.submit(); });
  const res = await logout;
  expect((await res.request().allHeaders()).origin).toBe(ADMIN_URL);
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe("/login");
});
