import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { ADMIN_URL, CONTROL_URL, appAlert, controlHeaders, issueInvite, login, openMembers, openWorkspace } from "./fixtures";

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

  await page.goto("/login?error=oauth_failed");
  await expect(appAlert(page)).toContainText("ログインを完了できませんでした");
  // control を直接開いても管理画面のアドレスは返さない。
  const direct = await request.get(`${CONTROL_URL}/auth/google/start`, { maxRedirects: 0 });
  expect(direct.status()).toBe(400);
  expect(direct.headers().location).toBeUndefined();
  const html = await direct.text();
  expect(html).toContain("ログインできませんでした");
  expect(html).not.toContain(ADMIN_URL);
  expect(html).not.toContain(new URL(ADMIN_URL).host);
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
  expect(before?.path).toBe("/"); // https では __Host- の条件(Path=/)。http もそろえている
  await page.goto(`/api/session/oauth?flow=${before!.value}`); // code なし → 失敗の着地。Cookie は消費される
  await expect(page).toHaveURL(/\/login\?error=oauth_failed$/);
  expect((await context.cookies()).some((c) => c.name === "wtt_oauth_flow")).toBe(false);
});

test("while the emergency door is open, the login screen shows the emergency form and every signed-in page shows the banner", async ({ page, browser }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "非常用: メールアドレスとパスワード" })).toBeVisible();
  await login(page);
  await expect(page.getByTestId("break-glass-banner")).toBeVisible();
  // B223: 既存のログインを使い、JS を止めた API キー発行フォームも同じ手順で検査する。
  await assertNativeFormSafety(browser, {
    path: "/w/me/api-keys",
    selector: 'section[aria-labelledby="issue-title"] form',
    values: { name: "B223_NATIVE_KEY_NAME_f61a" },
    storageState: await page.context().storageState(),
  });
  await openWorkspace(page);
  await expect(page.getByTestId("break-glass-banner")).toBeVisible();

  // 既存のログインに相乗りし、認証の回数を増やさない。招待の作成だけ行い、受諾はしない。
  await openMembers(page);
  const membersPath = new URL(page.url()).pathname;
  const inviteUrl = await issueInvite(page, "b202-invite@e2e.example", /^閲覧者/);
  const invitationId = new URL(inviteUrl).pathname.split("/").at(-1)!;
  const wid = membersPath.split("/")[2];
  try {
    await assertNativeFormSafety(browser, {
      path: new URL(inviteUrl).pathname,
      values: { name: "B202_NATIVE_NAME_f61a", password: "B202_NATIVE_PASSWORD_f61a" },
    });
    await assertNativeFormSafety(browser, {
      path: membersPath,
      selector: ".invite-section form",
      values: { email: "b202-native-member-f61a@example.test" },
      storageState: await page.context().storageState(),
    });
  } finally {
    const removed = await page.request.delete(`/api/control/workspaces/${wid}/invitations/${invitationId}`, { headers: controlHeaders() });
    expect(removed.status()).toBe(204);
  }
});

// B157: 枠への埋め込みを禁じるヘッダー(next.config の headers())が、Workers で動く build の応答に実際に付くこと。
// HTML(/login)と Route Handler(BFF の GET。未ログインなので 401 の封筒)の両方で確かめる
test("the HTML and the Route Handler responses forbid framing", async ({ request }) => {
  for (const path of ["/login", "/api/control/me"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'");
    expect(res.headers()["x-frame-options"], path).toBe("DENY");
  }
});

// B202: 外部の JS を止め、SSR の form をブラウザそのもので送る。evaluate はアプリの hydration を起動しない。
async function assertNativeFormSafety(browser: Browser, {
  path, values, selector = "form", storageState,
}: {
  path: string;
  values: Record<string, string>;
  selector?: string;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
}) {
  const context = await browser.newContext({ baseURL: ADMIN_URL, storageState });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().resourceType() === "script" ? route.abort() : route.continue());
    await page.goto(path);
    await expect(page.locator("html")).not.toHaveAttribute("data-hydrated", "1");
    const form = page.locator(selector).first();
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("method", "post");
    const button = form.locator('button[type="submit"]');
    await expect(button).toBeDisabled();
    for (const [name, value] of Object.entries(values)) await form.locator(`input[name="${name}"]`).fill(value);

    const before = page.url();
    const navigations: Array<{ url: string; method: string }> = [];
    page.on("request", (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push({ url: r.url(), method: r.method() });
    });
    await form.locator("input").first().press("Enter");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe(before);
    expect(navigations).toEqual([]);

    // disabled の抑止を迂回する submit() でも、email / password / token は query にならない。
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      form.evaluate((node) => (node as HTMLFormElement).submit()),
    ]);
    expect(response?.status()).toBe(200);
    expect(navigations).toEqual([{ url: before, method: "POST" }]);
    expect(page.url()).toBe(before);
    const body = await response!.text();
    const headers = await response!.allHeaders();
    expect(headers.location).toBeUndefined();
    for (const value of Object.values(values)) {
      expect(page.url()).not.toContain(value);
      expect(page.url()).not.toContain(encodeURIComponent(value));
      expect(body).not.toContain(value);
      expect(body).not.toContain(encodeURIComponent(value));
      expect(JSON.stringify(headers)).not.toContain(value);
    }
  } finally {
    await context.close();
  }
}

for (const [label, path, values] of [
  ["login", "/login", { email: "b202-native-login-f61a@example.test", password: "B202_NATIVE_PASSWORD_f61a" }],
  ["setup", "/setup", { setupToken: "B202_NATIVE_SETUP_TOKEN_f61a", workspaceName: "B202_NATIVE_WORKSPACE_f61a", name: "B202_NATIVE_NAME_f61a", email: "b202-native-setup-f61a@example.test" }],
  ["reset", "/reset?token=b202-existing-link-token", { password: "B202_NATIVE_PASSWORD_f61a" }],
] as const) {
  test(`native credentials stay out of the URL before hydration: ${label}`, async ({ browser }) => {
    await assertNativeFormSafety(browser, { path, values });
  });
}
