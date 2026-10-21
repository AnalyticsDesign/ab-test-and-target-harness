import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { breakGlassSweep } from "../src/cron/break-glass-sweep";
import { runCron } from "../src/cron/runner";
import type { Env } from "../src/env";
import { BREAK_GLASS, BREAK_GLASS_PASSWORD as PASSWORD, call, googleSignIn, inviteAndJoin, joinWithPassword, json, pausingD1Insert, setupOwner, signInWithPassword, testEnv } from "./helpers";

// plan12 K13(決定 63 (9)・(13)(h)): 非常口が閉じている間、パスワードの記録とその持ち主のセッションを 15 分ごとに消す

const ORIGIN = { origin: "http://localhost:3000" };
const open = { envOverride: BREAK_GLASS };
const OPEN_ENV = { ...testEnv, ...BREAK_GLASS } as Env;
/** パスワードの hash と Google の往復を何度も通すので、全体を流す負荷の下では既定の 5 秒を超えうる */
const TIMEOUT = 20_000;

const count = async (q: string, ...binds: unknown[]) => Number((await env.DB.prepare(q).bind(...binds).first<{ n: number }>())?.n ?? 0);
const sessionsOf = (userId: string) => count(`select count(*) as n from session where "userId" = ?`, userId);
const credentials = () => count(`select count(*) as n from account where "providerId" = 'credential'`);
const credentialOf = (userId: string) => count(`select count(*) as n from account where "providerId" = 'credential' and "userId" = ?`, userId);
/** 1 回の実行(非常口の開け閉めは env の AB_BREAK_GLASS_TOKEN の有無) */
const sweep = (e: Env = testEnv) => runCron(e, Date.now(), [breakGlassSweep]);
const meStatus = async (token: string) => (await call("GET", "/me", { token })).status;

describe("break-glass sweep (plan12 K13)", () => {
  it("break_glass_sweep_removes_passwords_and_password_sessions_when_closed", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const pwPassword = await signInWithPassword(pw.email);
    const pwGoogle = (await googleSignIn(pw.email)).token!;
    // パスワードの記録を持たない人(Google だけ)
    const other = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect(await sessionsOf(pw.userId)).toBe(3); // 登録・パスワードのログイン・Google のログイン
    expect(await credentials()).toBe(1);

    // トークンを外して動かす
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    expect(await sessionsOf(pw.userId)).toBe(0); // Google のものも含めて全部
    expect(await credentials()).toBe(0);
    expect(await meStatus(pwPassword)).toBe(401);
    expect(await meStatus(pwGoogle)).toBe(401);
    // パスワードの記録を持たない人の Google のセッションは残る(オーナーも /setup で記録を消してあるので残る)
    expect(await meStatus(other.token)).toBe(200);
    expect(await meStatus(owner.token)).toBe(200);
    // 消した後に Google でログインし直したセッションは、次の掃除でも残る
    const again = (await googleSignIn(pw.email)).token!;
    await sweep();
    expect(await meStatus(again)).toBe(200);
  }, TIMEOUT);

  it("非常口が開いている間はジョブが何も消さない", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const token = await signInWithPassword(pw.email);
    expect(await sweep(OPEN_ENV)).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    expect(await sessionsOf(pw.userId)).toBe(2);
    expect(await credentials()).toBe(1);
    expect(await meStatus(token)).toBe(200);
  }, TIMEOUT);

  it("password_session_created_during_upgrade_is_removed_after_close", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    // この版より前の control が作った形: 記録の表も印も無い、パスワードの記録を持つ人のセッション(登録のセッションを写して作る)
    const legacy = `legacy-session-token-${Date.now()}`;
    await env.DB.prepare(
      `insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "activeOrganizationId")
       select 'legacy-session', "expiresAt", ?1, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "activeOrganizationId" from session where "userId" = ?2 limit 1`,
    )
      .bind(legacy, pw.userId)
      .run();
    expect(await count(`select count(*) as n from session where id = 'legacy-session'`)).toBe(1);

    await sweep(OPEN_ENV); // 開いている間は残る
    expect(await count(`select count(*) as n from session where id = 'legacy-session'`)).toBe(1);
    await sweep(); // 閉じた後の最初の掃除で消える
    expect(await sessionsOf(pw.userId)).toBe(0);
    expect(await credentialOf(pw.userId)).toBe(0);
    // Google でログインし直したセッションは次のジョブでも残る(パスワードの記録はもう無い)
    const google = (await googleSignIn(pw.email)).token!;
    await sweep();
    expect(await meStatus(google)).toBe(200);
    expect(await sessionsOf(pw.userId)).toBe(1);
  }, TIMEOUT);

  it("password_sign_in_inflight_during_sweep_does_not_leave_a_session", async () => {
    const owner = await setupOwner();

    // 順 1: パスワードの記録を読んだ後・セッションを保存する前で止め、その間に掃除の batch が走る → 保存の後の確かめが断る
    const a = await joinWithPassword(owner);
    const before = pausingD1Insert(env.DB, "session", "before");
    const pendingA = call("POST", "/auth/sign-in/email", { body: { email: a.email, password: PASSWORD }, headers: ORIGIN, envOverride: { ...BREAK_GLASS, DB: before.db } });
    await before.reached;
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    before.release();
    const resA = await pendingA;
    expect(resA.status).toBe(401);
    expect(resA.headers.get("set-auth-token")).toBeNull();
    expect(await sessionsOf(a.userId)).toBe(0);
    expect(await credentialOf(a.userId)).toBe(0);

    // 順 2: セッションの保存が掃除の batch より前(保存の後・確かめの前で止める)→ batch がそのセッションを消し、確かめも断る
    const b = await joinWithPassword(owner);
    const after = pausingD1Insert(env.DB, "session", "after");
    const pendingB = call("POST", "/auth/sign-in/email", { body: { email: b.email, password: PASSWORD }, headers: ORIGIN, envOverride: { ...BREAK_GLASS, DB: after.db } });
    await after.reached;
    expect(await sessionsOf(b.userId)).toBe(2); // 登録のセッション + 今保存したセッション
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    after.release();
    const resB = await pendingB;
    expect(resB.status).toBe(401);
    expect(resB.headers.get("set-auth-token")).toBeNull();
    expect(await sessionsOf(b.userId)).toBe(0);
    // オーナー(パスワードの記録なし)は巻き込まれない
    expect(await meStatus(owner.token)).toBe(200);
  }, TIMEOUT);

  it("開く → 閉じる(掃除)→ 開く の後も、オーナーの再設定リンクでパスワードを作り直してログインできる", async () => {
    const owner = await setupOwner();
    const resetOwner = async (newPassword: string) => {
      const link = await call("POST", "/break-glass/reset-link", { body: { token: BREAK_GLASS.AB_BREAK_GLASS_TOKEN, email: owner.email }, ...open });
      expect(link.status).toBe(200);
      const token = new URL((await json<{ url: string }>(link)).url).searchParams.get("token")!;
      expect((await call("POST", "/auth/reset-password", { body: { token, newPassword }, headers: ORIGIN, ...open })).status).toBe(200);
    };
    await resetOwner("emergency-password-1");
    expect(await credentialOf(owner.userId)).toBe(1);
    await sweep();
    expect(await credentialOf(owner.userId)).toBe(0);
    await resetOwner("emergency-password-2");
    expect(await credentialOf(owner.userId)).toBe(1);
    const signin = await call("POST", "/auth/sign-in/email", { body: { email: owner.email, password: "emergency-password-2" }, headers: ORIGIN, ...open });
    expect(signin.status).toBe(200);
    expect(await meStatus(signin.headers.get("set-auth-token")!)).toBe(200);
  }, TIMEOUT);

  it("凍結中は見送る", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "skipped_frozen" }]);
    expect(await credentialOf(pw.userId)).toBe(1);
    expect(await sessionsOf(pw.userId)).toBe(1);
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    expect(await credentialOf(pw.userId)).toBe(0);
  }, TIMEOUT);
});

