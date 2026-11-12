import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { getAuth } from "../src/auth";
import { FLOW_RE, NEXT_RE } from "../src/routes/oauth";
import type { Env } from "../src/env";
import {
  TEST_FLOW,
  call,
  expectEnvelope,
  failingD1Insert,
  googleCallback,
  loginFailureOf,
  googleSignIn,
  googleStart,
  inviteAndJoin,
  joinWithPassword,
  json,
  setupOwner,
  setupReq,
  uniqueEmail,
} from "./helpers";

const ADMIN = "http://localhost:3000"; // vitest.config.ts の AB_ADMIN_URL
const db = () => (env as unknown as Env).DB;
const count = async (sql: string, ...binds: unknown[]) => Number((await db().prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);

/** Google でまだ一度もログインしていない(= account が結びついていない)OWNER */
async function unlinkedOwner(): Promise<string> {
  const email = uniqueEmail("owner");
  const res = await app.request(setupReq(email), undefined, env);
  expect(res.status).toBe(201);
  return email;
}

describe("Google sign-in and the hand-off to admin (決定 46)", () => {
  it("start redirects to Google with a state cookie on the control origin and writes nothing to D1", async () => {
    const before = await count(`select count(*) as n from verification`);
    let res!: Response;
    for (let i = 0; i < 3; i++) res = await call("GET", `/auth/google/start?flow=${TEST_FLOW}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:8788/auth/callback/google");
    expect(to.searchParams.get("client_id")).toBe("test-google-client-id");
    // Cookie は名前で見る(`state=` を含むかだけだと、どちらか一方が消えても通る)。Better Auth の state Cookie(R15)と、control の結びつけ Cookie の 2 つ
    expect(res.headers.getSetCookie().map((v) => v.split("=")[0]).sort()).toEqual(["better-auth.oauth_state", "wtt_oauth_state"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await count(`select count(*) as n from verification`)).toBe(before); // R15: state は Cookie
  });

  it("start without a valid flow ends on the control failure page", async () => {
    for (const q of ["", "?flow=short", "?flow=has%20space-0123456789", "?next=/invite/abc"]) {
      const res = await call("GET", `/auth/google/start${q}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await loginFailureOf(res)).toBe("oauth_failed");
    }
  });

  it("an existing user that never used Google is linked by verified email and gets a session", async () => {
    const email = await unlinkedOwner();
    const { token, location } = await googleSignIn(email);
    const back = new URL(location!);
    expect(back.origin + back.pathname).toBe(`${ADMIN}/api/session/oauth`);
    expect(back.searchParams.get("flow")).toBe(TEST_FLOW);
    expect(token).toBeTruthy();
    expect(await json(await call("GET", "/me", { token: token! }))).toMatchObject({ email });
    // もう一度ログインしても同じ user(account は 1 つ)
    const again = await googleSignIn(email);
    expect(again.token).toBeTruthy();
    expect(await count(`select count(*) as n from account where providerId = 'google' and userId = (select id from "user" where email = ?)`, email)).toBe(1);
  });

  it("the callback never leaves a session cookie on the control origin, and expires the state cookie", async () => {
    const email = await unlinkedOwner();
    const cb = await googleCallback(email);
    const cookies = cb.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0); // state Cookie の失効
    for (const v of cookies) expect(v).toMatch(/max-age=0/i);
    expect(cb.headers.get("set-auth-token")).toBeNull();
    expect(cb.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("the hand-off code is single-use even under concurrent exchange (exactly one 200)", async () => {
    const email = await unlinkedOwner();
    const code = new URL((await googleCallback(email)).headers.get("location")!).searchParams.get("code")!;
    const results = await Promise.all([1, 2, 3].map(() => call("POST", "/auth/handoff/exchange", { body: { code } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const ok = results.find((r) => r.status === 200)!;
    expect(await json(await call("GET", "/me", { token: (await json<{ token: string }>(ok)).token }))).toMatchObject({ email });
    // 逐次の再利用も 400(行はもう無い)
    const again = await call("POST", "/auth/handoff/exchange", { body: { code } });
    expect(again.status).toBe(400);
    expect((await expectEnvelope(again)).error).toBe("invalid_handoff");
  });

  it("the hand-off row never holds the raw code, lives about a minute, and an expired code is consumed without a session", async () => {
    const email = await unlinkedOwner();
    const before = Date.now();
    const code = new URL((await googleCallback(email)).headers.get("location")!).searchParams.get("code")!;
    const row = await db().prepare(`select id, identifier, expiresAt from verification where identifier like 'handoff:%'`).first<{ id: string; identifier: string; expiresAt: string | number }>();
    expect(row!.identifier).not.toContain(code);
    const ttl = new Date(row!.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(50_000);
    expect(ttl).toBeLessThan(70_000);
    const past = Date.now() - 1000;
    await db().prepare(`update verification set expiresAt = ? where id = ?`).bind(typeof row!.expiresAt === "number" ? past : new Date(past).toISOString(), row!.id).run();
    expect((await call("POST", "/auth/handoff/exchange", { body: { code } })).status).toBe(400);
    expect(await count(`select count(*) as n from verification where identifier like 'handoff:%'`)).toBe(0);
  });

  it("Google tokens are not kept readable in the account table (R13)", async () => {
    const email = await unlinkedOwner();
    await googleSignIn(email);
    const row = await db().prepare(`select accessToken, idToken, refreshToken from account where providerId = 'google' and userId = (select id from "user" where email = ?)`).bind(email).first<Record<string, string | null>>();
    expect(row?.accessToken ?? "").not.toContain("test-access-token");
    expect(row?.accessToken).toBeNull();
    expect(row?.idToken).toBeNull();
  });

  it("an invited email is created on first Google sign-in; next=/invite/<id> survives the round trip", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("invited");
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } }));
    const { token, location } = await googleSignIn(email, { next: `/invite/${inv.id}` });
    expect(new URL(location!).searchParams.get("next")).toBe(`/invite/${inv.id}`);
    expect(token).toBeTruthy();
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: token! })).status).toBe(200);
  });

  it("a Google account that is neither a user nor invited is refused on the control failure page with no user row", async () => {
    await setupOwner();
    const email = uniqueEmail("stranger");
    const { token, error } = await googleSignIn(email);
    expect(token).toBeNull();
    // auth.ts のフックが投げる APIError の message が error= に載る(1.4.21 は Better Auth の link-account の catch が 302 に、
    // 1.7 は 403 の封筒で上がり、callback の deniedCode が同じ code にする。B179 D14)
    expect(error).toBe("not_invited");
    expect(await count(`select count(*) as n from "user" where email = ?`, email)).toBe(0);
  });

  it("an unverified Google email cannot be linked to an existing user", async () => {
    const email = await unlinkedOwner();
    const { token, error } = await googleSignIn(email, { emailVerified: false });
    expect(token).toBeNull();
    expect(error).toBe("account_not_linked");
    expect(await count(`select count(*) as n from account where providerId = 'google'`)).toBe(0);
  });

  it("an unverified Google email cannot create a user even when invited", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("unverified");
    await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } });
    expect((await googleSignIn(email, { emailVerified: false })).token).toBeNull();
    expect(await count(`select count(*) as n from "user" where email = ?`, email)).toBe(0);
  });

  it("an expired invitation does not let a new Google account in", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("late");
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } }));
    const current = await db().prepare(`select expiresAt from invitation where id = ?`).bind(inv.id).first<{ expiresAt: string | number }>();
    const past = Date.now() - 1000;
    await db().prepare(`update invitation set expiresAt = ? where id = ?`).bind(typeof current!.expiresAt === "number" ? past : new Date(past).toISOString(), inv.id).run();
    // 行を残さない: user が残ると、次回は「新規作成」ではなく「既存 user への linking」になり招待の期限をすり抜ける。
    // account の検査はこの Google アカウント(固定の sub)に限る — Task 4 以降の setupOwner() は Google に link 済みの OWNER を返すので、
    // 全件 0 件とは書けない。OWNER の account 数(Task 1〜3 では 0、Task 4 以降は 1)が変わらないことも見る
    const sub = `g-late-${Date.now()}`;
    const ownerAccounts = () => count(`select count(*) as n from account where providerId = 'google' and userId = ?`, owner.userId);
    const before = await ownerAccounts();
    for (let i = 0; i < 2; i++) {
      expect((await googleSignIn(email, { sub })).token).toBeNull();
      expect(await count(`select count(*) as n from "user" where email = ?`, email)).toBe(0);
      expect(await count(`select count(*) as n from account where providerId = 'google' and accountId = ?`, sub)).toBe(0);
    }
    expect(await ownerAccounts()).toBe(before);
  });

  it("user creation is denied when the endpoint context is unavailable (the hook is an allowlist)", async () => {
    const email = uniqueEmail("no-context");
    const ctx = await getAuth(env as unknown as Env).$context;
    // 文脈が無い呼び出しは「招待が無い」で弾かれる。どんな throw でも通ってしまわないよう理由まで固定する
    // B179: 1.7 の createUser は作成の経路(source)を 2 つ目の引数に取る。経路は hook の判定に使わない(hook が見るのは endpoint の文脈)
    await expect(ctx.internalAdapter.createUser({ email, name: "x", emailVerified: true }, { method: "oauth" })).rejects.toThrow(/not_invited/);
    expect(await count(`select count(*) as n from "user" where email = ?`, email)).toBe(0);
  });

  it("next is dropped unless it is /invite/<id>", async () => {
    const email = await unlinkedOwner();
    const { location } = await googleSignIn(email, { next: "https://evil.example/" });
    expect(new URL(location!).searchParams.get("next")).toBeNull();
  });

  it("a callback without state ends on the control failure page", async () => {
    const res = await call("GET", "/auth/callback/google?code=x");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await loginFailureOf(res)).toBe("oauth_failed");
  });

  it("start binds the state to this browser, and the callback refuses a state that is not the one it issued", async () => {
    // Better Auth 1.4.21 は state を Cookie に持たせる構成だと `state` クエリを照合しなかった(dist/state.mjs の cookie 分岐)。1.7.15 は照合する
    // (parseGenericState が oauthState と state クエリの不一致を state_security_mismatch で断る)が、control 自身も start の state のハッシュを
    // Cookie に置き、callback で一致を必須にする(PKCE・Better Auth の照合と二重)。「結びつけ Cookie が無い」の行は control だけが断る
    const before = await count(`select count(*) as n from verification where identifier like 'handoff:%'`);
    const { state, cookie } = await googleStart();
    const bound = cookie.split("; ").find((v) => v.startsWith("wtt_oauth_state="))!;
    expect(bound).toBeTruthy();
    for (const [name, req] of [
      ["攻撃者の state(結びつけ Cookie はある)", { q: "someone-elses-state", cookie }],
      ["結びつけ Cookie が無い", { q: state, cookie: cookie.split("; ").filter((v) => !v.startsWith("wtt_oauth_state=")).join("; ") }],
      ["Cookie がまったく無い", { q: state, cookie: "" }],
    ] as const) {
      const res = await call("GET", `/auth/callback/google?code=test-code&state=${encodeURIComponent(req.q)}`, { headers: { cookie: req.cookie } });
      expect(res.status, name).toBe(400);
      expect(res.headers.get("location"), name).toBeNull();
      expect(await loginFailureOf(res), name).toBe("oauth_failed");
      expect(res.headers.get("set-auth-token"), name).toBeNull();
    }
    // 使い捨てコードは 1 件も発行されない
    expect(await count(`select count(*) as n from verification where identifier like 'handoff:%'`)).toBe(before);
  });

  it("the binding cookie is expired on every callback, and only expiring cookies leave the control origin", async () => {
    const email = await unlinkedOwner();
    const cb = await googleCallback(email);
    const expired = cb.headers.getSetCookie().filter((v) => v.startsWith("wtt_oauth_state="));
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatch(/max-age=0/i);
    expect(expired[0]).toMatch(/path=\/auth\/callback\/google/i);
    expect(expired[0]).toMatch(/httponly/i);
  });

  it("a hand-off code that cannot be issued returns the control failure HTML", async () => {
    const email = await unlinkedOwner();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // helpers: verification への insert だけ throw する D1 ラッパ(使い捨てコードの保存先)
      const cb = await googleCallback(email, { envOverride: { DB: failingD1Insert(db(), "verification") } });
      expect(cb.status).toBe(500);
      expect(cb.headers.get("location")).toBeNull();
      expect(await loginFailureOf(cb)).toBe("oauth_failed");
      expect(cb.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("issuing a hand-off code sweeps expired hand-off rows and leaves other verification rows alone", async () => {
    const email = await unlinkedOwner();
    await googleCallback(email); // 引き換えられないまま残る行
    const stale = await db().prepare(`select id, expiresAt from verification where identifier like 'handoff:%'`).first<{ id: string; expiresAt: string | number }>();
    const past = Date.now() - 1000;
    await db().prepare(`update verification set expiresAt = ? where id = ?`).bind(typeof stale!.expiresAt === "number" ? past : new Date(past).toISOString(), stale!.id).run();
    // この module の行ではない期限切れ(Better Auth などの行)は消さない
    await db().prepare(`insert into verification (id, identifier, value, expiresAt, createdAt, updatedAt) values (?, 'other-owner-row', 'v', ?, ?, ?)`)
      .bind(crypto.randomUUID(), new Date(past).toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    await googleCallback(email); // 次の発行で掃除される
    expect(await count(`select count(*) as n from verification where id = ?`, stale!.id)).toBe(0);
    expect(await count(`select count(*) as n from verification where identifier = 'other-owner-row'`)).toBe(1);
    await db().prepare(`delete from verification where identifier = 'other-owner-row'`).run();
  });

  it("Better Auth endpoints that would bypass the hand-off stay closed", async () => {
    expect((await call("POST", "/auth/sign-in/social", { body: { provider: "google" } })).status).toBe(404);
    expect((await call("POST", "/auth/one-time-token/verify", { body: { token: "x" } })).status).toBe(404);
    expect((await call("GET", "/auth/one-time-token/generate")).status).toBe(404);
    expect((await call("GET", "/auth/error")).status).toBe(404);
  });

  it("NEXT_RE and FLOW_RE stay the same literals as admin's copies (B21)", () => {
    // 別デプロイなので共有せず、両側の literal をテストで固定する。片方の式だけを変えると、その側のこのテストが落ちて相手に気づける。
    // 相手: admin の lib/safe-next.ts(NEXT_RE)/ lib/oauth-flow.ts(FLOW_RE)。テストは admin の test/safe-next.test.ts / test/oauth-flow.test.ts。
    // 式を変えるときは 4 か所(両側の定義とテスト)を同時に変える
    expect([NEXT_RE.source, NEXT_RE.flags]).toEqual(["^\\/invite\\/[A-Za-z0-9_-]{1,64}$", ""]);
    expect([FLOW_RE.source, FLOW_RE.flags]).toEqual(["^[A-Za-z0-9_-]{16,64}$", ""]);
  });

  it("start answers 503 google_not_configured when the client is not set", async () => {
    const res = await call("GET", `/auth/google/start?flow=${TEST_FLOW}`, { envOverride: { AB_GOOGLE_CLIENT_ID: "" } });
    expect(res.status).toBe(503);
    expect(await loginFailureOf(res)).toBe("google_not_configured");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("Google sign-in failure codes on better-auth 1.7 (B179 D14)", () => {
  /** Better Auth の 302・封筒のどちらの失敗も、control の画面で理由だけを返す。 */
  const loginErrorOf = async (email: string, opts: { emailVerified?: boolean } = {}): Promise<string | null> => {
    const cb = await googleCallback(email, opts);
    expect(cb.headers.get("set-auth-token")).toBeNull();
    expect(cb.headers.get("location")).toBeNull();
    expect(await cb.clone().text()).not.toContain("error_description");
    return loginFailureOf(cb);
  };

  it("oauth_error_codes_stay_lowercase_b179", async () => {
    // Better Auth の封筒・302 のどちらも control の同じ画面にそろえる。内部の error_description は出さない
    const owner = await setupOwner();
    // 1. 招待の無い新しい人(user.create.before)
    expect(await loginErrorOf(uniqueEmail("stranger"))).toBe("not_invited");
    // 2. Member から外された既存の人(session.create.before)
    const removed = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${removed.memberId}`, { token: owner.token })).status).toBe(204);
    expect(await loginErrorOf(removed.email)).toBe("not_invited");
    // 3. 招待はあるが Google 側でメールが未確認の新しい人(user.create.before)
    const unverified = uniqueEmail("unverified");
    expect((await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: unverified, role: "viewer" } })).status).toBe(201);
    expect(await loginErrorOf(unverified, { emailVerified: false })).toBe("email_not_verified");
    // 4. 非常口のパスワードで作った人(未確認。1.7 の accountLinking.requireLocalEmailVerified)
    const pw = await joinWithPassword(owner);
    expect(await loginErrorOf(pw.email)).toBe("account_not_linked");
  }, 30_000);


});

// B231: failure helper は callback の応答を消費せず、形から理由を読む。
describe("loginFailureOf", () => {
  it("reads a failure page without consuming its body", async () => {
    const page = new Response('<main data-code="account_not_linked">failure</main>', { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
    expect(await loginFailureOf(page)).toBe("account_not_linked");
    expect(await page.text()).toContain("failure");
    expect(await loginFailureOf(Response.json({ error: "other" }))).toBeNull();
  });
});
