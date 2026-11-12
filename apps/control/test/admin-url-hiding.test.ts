import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "../src/auth";
import type { Env } from "../src/env";
import { BREAK_GLASS, BREAK_GLASS_PASSWORD, call, countingD1, failingD1Insert, failingD1Query, googleCallback, googleStart, inviteAndJoin, joinWithPassword, json, loginFailureOf, setupOwner, TEST_FLOW, uniqueEmail } from "./helpers";

const config = env as unknown as Env;
const ADMIN = config.AB_ADMIN_URL;
const needles = [ADMIN, encodeURIComponent(ADMIN), new URL(ADMIN).host];
const db = () => config.DB;
const handoffs = () => db().prepare("select count(*) as n from verification where identifier like 'handoff:%'").first<number>("n");

/** 本文・全ヘッダー・Cookie・状態のいずれにも実際の管理画面 URL が無いこと。 */
async function expectNoAdminUrl(label: string, res: Response) {
  const text = `${res.status} ${res.statusText}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${res.headers.getSetCookie().join("\n")}\n${await res.clone().text()}`;
  for (const needle of needles) expect(text, `${label}: ${needle}`).not.toContain(needle);
}
async function failure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("set-auth-token")).toBeNull();
  expect(await loginFailureOf(res)).toBe(code);
  await expectNoAdminUrl(code, res);
}
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), b => b.toString(16).padStart(2, "0")).join("");
async function invite(owner: { token: string; workspaceId: string }, email: string) {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } });
  expect(res.status).toBe(201);
}
afterEach(() => vi.restoreAllMocks());

describe("anonymous control responses never disclose the admin URL (B231)", () => {
  it("the same detector catches an invited user's successful callback (positive control)", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("invited");
    await invite(owner, email);
    const res = await googleCallback(email);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(new RegExp(`^${ADMIN}/api/session/oauth`));
    await expect(expectNoAdminUrl("positive control", res)).rejects.toThrow();
  });

  it.each(["", "?flow=short", "?flow=has%20space-0123456789", "?next=/invite/abc", "?flow=%3Cscript%3E&next=reflected-sentinel"])("invalid start %s", async q => {
    const res = await call("GET", `/auth/google/start${q}`);
    await failure(res, 400, "oauth_failed");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).not.toContain("reflected-sentinel");
  });
  it("valid start redirects only to Google and hides plaintext in every header", async () => {
    const res = await call("GET", `/auth/google/start?flow=${TEST_FLOW}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    await expectNoAdminUrl("valid start", res);
  });
  it("unconfigured Google returns a 503 page", async () => {
    await failure(await call("GET", `/auth/google/start?flow=${TEST_FLOW}`, { envOverride: { AB_GOOGLE_CLIENT_ID: "" } }), 503, "google_not_configured");
  });
  it.each(["url", "state"])("incomplete signInSocial response (%s) returns a 503 page", async missing => {
    const auth = getAuth(config);
    const result = await auth.api.signInSocial({ body: { provider: "google", callbackURL: `${ADMIN}/api/session/oauth?flow=${TEST_FLOW}`, disableRedirect: true }, returnHeaders: true });
    if (missing === "url") result.response.url = "";
    else result.response.url = "https://accounts.google.com/o/oauth2/v2/auth";
    // vi.spyOn は generic の既定(ヘッダーなし)だけを推論する。実際の呼び出しは returnHeaders: true。
    vi.spyOn(auth.api, "signInSocial").mockResolvedValueOnce(result as never);
    await failure(await call("GET", `/auth/google/start?flow=${TEST_FLOW}`), 503, "google_not_configured");
  });
  it.each(["/auth/google/start", "/auth/callback/google"])("rate limited %s is HTML, while POST stays JSON", async path => {
    const envOverride = { AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    await failure(await call("GET", `${path}?flow=${TEST_FLOW}&code=x&state=y`, { envOverride }), 429, "rate_limited");
    const post = await call("POST", "/auth/handoff/exchange", { body: { code: "invalid-code-0123456789" }, envOverride });
    expect(post.status).toBe(429);
    expect(post.headers.get("content-type")).toContain("application/json");
    expect(await json(post)).toMatchObject({ error: "rate_limited" });
  });
  it("start_sign_in_social_exception_returns_failure_html", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(getAuth(config).api, "signInSocial").mockRejectedValue(new Error("boom"));
    await failure(await call("GET", `/auth/google/start?flow=${TEST_FLOW}`), 500, "oauth_failed");
    expect(err).toHaveBeenCalled();
  });
  it("HEAD start has no admin URL", async () => {
    await expectNoAdminUrl("HEAD", await call("HEAD", "/auth/google/start"));
  });
  it("missing state expires the binding cookie and performs no D1 queries", async () => {
    const counting = countingD1(db());
    const res = await call("GET", "/auth/callback/google?code=x", { envOverride: { DB: counting.db } });
    await failure(res, 400, "oauth_failed");
    expect(res.headers.getSetCookie().some(v => /^wtt_oauth_state=;.*Max-Age=0/i.test(v))).toBe(true);
    expect(counting.counts().trips).toHaveLength(0);
  });
  it.each(["mismatch", "missing-binding", "no-cookie"])("invalid state: %s", async kind => {
    const { state, cookie } = await googleStart();
    const counting = countingD1(db());
    const before = await handoffs();
    const res = await call("GET", `/auth/callback/google?code=x&state=${kind === "mismatch" ? "other-state" : encodeURIComponent(state)}`, {
      headers: { cookie: kind === "no-cookie" ? "" : kind === "missing-binding" ? cookie.split("; ").filter(v => !v.startsWith("wtt_oauth_state=")).join("; ") : cookie },
      envOverride: { DB: counting.db },
    });
    await failure(res, 400, "oauth_failed");
    expect(counting.counts().trips).toHaveLength(0);
    expect(await handoffs()).toBe(before);
  });
  it.each(["", "; better-auth.oauth_state=garbage"])("forged binding without a valid Better Auth state: %s", async extra => {
    const state = "forged-state-0123";
    await failure(await call("GET", `/auth/callback/google?code=x&state=${state}`, { headers: { cookie: `wtt_oauth_state=${await hash(state)}${extra}` } }), 400, "oauth_failed");
  });
  it.each([
    ["&error=access_denied", "access_denied"],
    ["", "oauth_failed"],
    ["&error=%3Cscript%3E&error_description=reflected-sentinel", "oauth_failed"],
  ])("Google callback error %s", async (query, code) => {
    const { state, cookie } = await googleStart();
    const res = await call("GET", `/auth/callback/google?state=${encodeURIComponent(state)}${query}`, { headers: { cookie } });
    await failure(res, 400, code);
    const html = await res.text();
    expect(html).not.toMatch(/<script|reflected-sentinel/);
  });
  it("failed token exchange creates no handoff", async () => {
    const { state, cookie } = await googleStart();
    const before = await handoffs();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://oauth2.googleapis.com/token") ? Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })) : real(input, init);
    });
    await failure(await call("GET", `/auth/callback/google?code=bad&state=${encodeURIComponent(state)}`, { headers: { cookie } }), 400, "oauth_failed");
    expect(await handoffs()).toBe(before);
  });
  it("in-flight state cookie from the old control never sends the browser to admin", async () => {
    const { headers, response } = await getAuth(config).api.signInSocial({ body: { provider: "google", callbackURL: `${ADMIN}/api/session/oauth?flow=${TEST_FLOW}`, errorCallbackURL: `${ADMIN}/login`, disableRedirect: true }, returnHeaders: true });
    const state = new URL(response.url!).searchParams.get("state")!;
    const cookie = [...headers.getSetCookie().map(v => v.split(";")[0]), `wtt_oauth_state=${await hash(state)}`].join("; ");
    await failure(await call("GET", `/auth/callback/google?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { cookie } }), 400, "access_denied");
  });
  it("a stranger is refused with no user row", async () => {
    await setupOwner();
    const email = uniqueEmail("stranger");
    await failure(await googleCallback(email), 403, "not_invited");
    expect(await db().prepare('select count(*) as n from "user" where email = ?').bind(email).first<number>("n")).toBe(0);
  });
  it("a removed member is refused", async () => {
    const owner = await setupOwner();
    const removed = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${removed.memberId}`, { token: owner.token })).status).toBe(204);
    await failure(await googleCallback(removed.email), 403, "not_invited");
  });
  it("an invited but unverified Google email is refused", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("unverified");
    await invite(owner, email);
    await failure(await googleCallback(email, { emailVerified: false }), 403, "email_not_verified");
  });
  it("a password account is refused on the same control page", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await failure(await googleCallback(pw.email), 403, "account_not_linked");
  });
  it.each(["verification", "user", "account"])("D1 insert failure in %s is a server fault", async table => {
    const owner = await setupOwner();
    const email = table === "verification" ? owner.email : uniqueEmail("insert-fault");
    if (table !== "verification") await invite(owner, email);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await failure(await googleCallback(email, { envOverride: { DB: failingD1Insert(db(), table) } }), 500, "oauth_failed");
    expect(err).toHaveBeenCalled();
  });
  it("Better Auth account lookup failure is a server fault", async () => {
    const owner = await setupOwner();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await failure(await googleCallback(owner.email, { envOverride: { DB: failingD1Query(db(), /from "?account"?/i) } }), 500, "oauth_failed");
    expect(err).toHaveBeenCalled();
  });
  it.each(["5xx", "throw", "no-token", "wrong-target", "invalid-location", "non-302-redirect"])("callback handler fault: %s", async kind => {
    const { state, cookie } = await googleStart();
    const before = await handoffs();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.spyOn(getAuth(config), "handler");
    if (kind === "throw") handler.mockRejectedValue(new Error("boom"));
    else if (kind === "5xx") handler.mockResolvedValue(Response.json({ message: "boom" }, { status: 500 }));
    else handler.mockResolvedValue(new Response(null, { status: kind === "non-302-redirect" ? 303 : 302, headers: {
      location: kind === "invalid-location" ? "http://[" : kind === "wrong-target" ? `${ADMIN}/somewhere-else` : `${ADMIN}/api/session/oauth?flow=${TEST_FLOW}`,
      ...(kind === "wrong-target" ? { "set-auth-token": "x" } : {}),
      "set-cookie": "better-auth.session_token=secret; Path=/; HttpOnly",
    } }));
    const res = await call("GET", `/auth/callback/google?code=x&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    // 302 以外の転送(303 など)は成功の形でないので、Location を写さず 400 で止まる
    const clientError = kind === "invalid-location" || kind === "non-302-redirect";
    await failure(res, clientError ? 400 : 500, "oauth_failed");
    expect(res.headers.getSetCookie().every(v => /max-age=0/i.test(v))).toBe(true);
    expect(await handoffs()).toBe(before);
    if (!clientError) expect(err).toHaveBeenCalled();
  });
  it.each(["/auth/google/start", "/auth/callback/google"])("HEAD %s without flow or state ends on the failure page", async path => {
    // Hono は HEAD を GET の handler で処理する。本文は空でも、状態とヘッダーで管理画面へ戻さないことを見る
    const res = await call("HEAD", path);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("location")).toBeNull();
    await expectNoAdminUrl(`HEAD ${path}`, res);
  });
  it("Better Auth's own failure destination is never the admin origin", () => {
    expect(new URL(getAuth(config).options.onAPIError!.errorURL!).origin).toBe(new URL(config.AB_CONTROL_URL).origin);
  });
  it.each([
    ["POST", "/auth/callback/google"], ["GET", "/auth/callback/github"],
    ["GET", "/"], ["GET", "/llms.txt"], ["GET", "/openapi.json"], ["GET", "/login-options"], ["GET", "/capabilities"], ["GET", "/me"],
    ["GET", "/auth/error"], ["GET", "/auth/reset-password/x"], ["GET", "/invitations/x"],
    ["POST", "/auth/handoff/exchange"], ["POST", "/break-glass/reset-link"], ["POST", "/setup"], ["POST", "/invitations/x/accept"],
  ])("other anonymous entry %s %s", async (method, path) => {
    await setupOwner();
    const res = await call(method, path, { body: method === "POST" ? { code: "bogus-code-0123456789", token: "wrong", email: "x@example.com", name: "x" } : undefined });
    await expectNoAdminUrl(`${method} ${path}`, res);
    // /auth/error は Better Auth の失敗の行き先(onAPIError.errorURL)だが公開しない。公開すると自分自身への転送が続く
    if (path === "/auth/callback/google" || path === "/auth/callback/github" || path === "/auth/error") expect(res.status).toBe(404);
  });
  for (const open of [false, true]) for (const origin of [undefined, "https://evil.example"]) {
    const entries: [string, string, object?][] = open ? [
      ["POST", "/auth/sign-in/email", { email: "x@example.com", password: BREAK_GLASS_PASSWORD, callbackURL: "https://evil.example/" }],
      ["POST", "/auth/sign-up/email", { email: "x@example.com", password: BREAK_GLASS_PASSWORD, name: "x" }],
      ["POST", "/auth/request-password-reset", { email: "x@example.com" }],
      ["POST", "/auth/request-password-reset", { email: "x@example.com", redirectTo: "https://evil.example/" }],
      ["POST", "/auth/reset-password", { token: "bogus", newPassword: BREAK_GLASS_PASSWORD }],
      ["GET", "/auth/get-session"], ["POST", "/auth/sign-out", {}], ["POST", "/auth/sign-out", { callbackURL: "https://evil.example/" }],
    ] : [["GET", "/auth/get-session"], ["POST", "/auth/sign-out", {}], ["POST", "/auth/sign-out", { callbackURL: "https://evil.example/" }]];
    it.each(entries)(`passthrough break-glass=${open} origin=${origin}: %s %s %j`, async (method, path, body) => {
      const res = await call(method, path, { body, headers: origin ? { origin } : {}, envOverride: open ? BREAK_GLASS : {} });
      await expectNoAdminUrl(`${method} ${path}`, res);
    });
  }
  it("OpenAPI advertises HTML failures on both Google routes", async () => {
    const doc = await json<{ paths: Record<string, { get: { responses: Record<string, { content?: Record<string, unknown> }> } }> }>(await call("GET", "/openapi.json"));
    for (const [path, statuses] of [["/auth/google/start", [400, 429, 500, 503]], ["/auth/callback/google", [400, 403, 429, 500]]] as const) {
      for (const status of statuses) expect(doc.paths[path]!.get.responses[status]!.content?.["text/html"], `${path} ${status}`).toBeDefined();
    }
  });
});
