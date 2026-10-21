import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loginMethodOf } from "../src/auth";
import { AUTH_RATE_LIMIT, BREAK_GLASS, alignToWindow, call, expectEnvelope, googleSignIn, inviteAndJoin, joinWithPassword, json, sessionTokenOf, setupOwner, signInWithPassword, uniqueEmail } from "./helpers";

const ORIGIN = { origin: "http://localhost:3000" };
const open = { envOverride: BREAK_GLASS };

describe("break-glass (決定 46 (2)(3))", () => {
  it("password routes are 404 envelopes while the secret is unset", async () => {
    for (const [path, body] of [
      ["/auth/sign-in/email", { email: "a@example.com", password: "password123" }],
      ["/auth/sign-up/email", { email: "a@example.com", name: "a", password: "password123" }],
      ["/auth/request-password-reset", { email: "a@example.com" }],
      ["/auth/reset-password", { token: "t", newPassword: "password123" }],
    ] as const) {
      const res = await call("POST", path, { body, headers: ORIGIN });
      expect(res.status, path).toBe(404);
      expect((await expectEnvelope(res)).error).toBe("not_found");
    }
  });

  it("a token shorter than 16 characters keeps everything closed", async () => {
    const short = { envOverride: { AB_BREAK_GLASS_TOKEN: "short-token" } };
    expect((await call("POST", "/auth/sign-in/email", { body: { email: "a@example.com", password: "x" }, headers: ORIGIN, ...short })).status).toBe(404);
    expect(await json(await call("GET", "/login-options", short))).toEqual({ google: true, passwordLogin: false });
  });

  it("login-options and capabilities report the state", async () => {
    const owner = await setupOwner();
    expect(await json(await call("GET", "/login-options"))).toEqual({ google: true, passwordLogin: false });
    expect(await json(await call("GET", "/login-options", open))).toEqual({ google: true, passwordLogin: true });
    expect(await json(await call("GET", "/login-options", { envOverride: { AB_GOOGLE_CLIENT_SECRET: "" } }))).toEqual({ google: false, passwordLogin: false });
    expect((await json<{ passwordLogin: boolean }>(await call("GET", "/capabilities", { token: owner.token }))).passwordLogin).toBe(false);
    expect((await json<{ passwordLogin: boolean }>(await call("GET", "/capabilities", { token: owner.token, ...open }))).passwordLogin).toBe(true);
  });

  it("the whole emergency path: reset link for the OWNER → set a password → sign in", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/break-glass/reset-link", { body: { token: BREAK_GLASS.AB_BREAK_GLASS_TOKEN, email: owner.email }, ...open });
    expect(res.status).toBe(200);
    const link = new URL((await json<{ url: string }>(res)).url);
    expect(link.origin + link.pathname).toBe("http://localhost:3000/reset");
    const token = link.searchParams.get("token")!;
    expect((await call("POST", "/auth/reset-password", { body: { token, newPassword: "emergency-password-1" }, headers: ORIGIN, ...open })).status).toBe(200);
    const signin = await call("POST", "/auth/sign-in/email", { body: { email: owner.email, password: "emergency-password-1" }, headers: ORIGIN, ...open });
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-auth-token")).toBeTruthy();
    // secret を消すと、設定したパスワードでも入れない
    expect((await call("POST", "/auth/sign-in/email", { body: { email: owner.email, password: "emergency-password-1" }, headers: ORIGIN })).status).toBe(404);
  });

  it("reset-link answers 404 for a closed door, a wrong token, a non-owner and an unknown email alike", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const good = BREAK_GLASS.AB_BREAK_GLASS_TOKEN;
    const cases: Array<[Record<string, unknown>, object]> = [
      [{ token: good, email: owner.email }, {}], // 閉じている
      [{ token: `${good}x`, email: owner.email }, open],
      [{ token: good, email: admin.email }, open],
      [{ token: good, email: uniqueEmail("nobody") }, open],
    ];
    for (const [body, opts] of cases) {
      const res = await call("POST", "/break-glass/reset-link", { body, ...opts });
      expect(res.status).toBe(404);
      expect((await expectEnvelope(res)).error).toBe("not_found");
    }
  });

  it("accepting an invitation without a Bearer needs the door open; the member reset link is 409 while closed", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } }));
    const closed = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" } });
    expect(closed.status).toBe(401);
    expect((await expectEnvelope(closed)).hint).toBeTruthy();
    expect((await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, ...open })).status).toBe(200);

    const members = await json<Array<{ memberId: string; email: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }));
    const target = members.find((m) => m.email === email)!;
    const path = `/workspaces/${owner.workspaceId}/members/${target.memberId}/reset-link`;
    const refused = await call("POST", path, { token: owner.token });
    expect(refused.status).toBe(409);
    expect((await expectEnvelope(refused)).error).toBe("password_login_disabled");
    expect((await call("POST", path, { token: owner.token, ...open })).status).toBe(200);
  });

  it("reset-link is rate limited per IP: 30 pass the limiter, the 31st is 429", async () => {
    await alignToWindow({ fresh: true }); // 10 秒の固定窓をまたぐと数え直しになるので窓の頭から始める
    // nextTestIp() が払い出す 198.18.0.0/15 の外の固定 IP(他のテストと枠を食い合わない)
    const headers = { "cf-connecting-ip": "203.0.113.88" };
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_RATE_LIMIT + 1; i++) statuses.push((await call("POST", "/break-glass/reset-link", { body: { token: "x".repeat(20), email: "a@example.com" }, headers })).status);
    expect(statuses.slice(0, AUTH_RATE_LIMIT).every((s) => s === 404)).toBe(true);
    expect(statuses[AUTH_RATE_LIMIT]).toBe(429);
  }, 25_000); // 窓の待ち(最大 10 秒)+ 31 回
});

// B112: セッションに「どの経路で作ったか」の印(session.loginMethod)を残す。パスワードのセッションからの鍵の発行を断る材料になる
describe("session login method (B112)", () => {
  it("login_method_of_is_fail_closed", () => {
    // パスワード / Google と分かる経路だけに印を付け、それ以外(path が取れない・似た名前の経路)は「分からない」= null
    for (const path of [undefined, "/change-password", "/sign-in/social", "/callbackfoo"]) expect(loginMethodOf(path), String(path)).toBeNull();
    expect(loginMethodOf("/callback/google")).toBe("google");
    expect(loginMethodOf("/sign-in/email")).toBe("password");
    expect(loginMethodOf("/sign-up/email")).toBe("password");
  });

  /** Bearer のセッションの loginMethod を引く。行が 1 つ取れたことも確かめる */
  const methodOf = async (bearer: string): Promise<string | null> => {
    const row = await env.DB.prepare(`select "loginMethod" as m from session where token = ?`).bind(sessionTokenOf(bearer)).first<{ m: string | null }>();
    expect(row, "session row").not.toBeNull();
    return row!.m;
  };

  it("session_records_login_method", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    expect(await methodOf(pw.token)).toBe("password"); // 登録(/sign-up/email)のセッション
    expect(await methodOf(await signInWithPassword(pw.email))).toBe("password"); // /sign-in/email
    expect(await methodOf((await googleSignIn(pw.email)).token!)).toBe("google"); // /callback/google
  }, 20_000);
});
