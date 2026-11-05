import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as audit from "../src/audit";
import { breakGlassSweep } from "../src/cron/break-glass-sweep";
import { runCron } from "../src/cron/runner";
import { getDb } from "../src/db";
import { isWriteFrozen } from "../src/write-freeze";
import type { Env } from "../src/env";
import {
  BREAK_GLASS,
  BREAK_GLASS_PASSWORD,
  beforeD1Batch,
  call,
  countingD1,
  failingD1Insert,
  failingD1Query,
  type D1Counts,
  googleSignIn,
  inviteAndJoin,
  joinWithPassword,
  json,
  pausingD1Insert,
  seedSession,
  seedUser,
  setupOwner,
  signInWithPassword,
  testEnv,
  uniqueEmail,
} from "./helpers";

/**
 * B129 Task 4(spec §3.1・§5.1〜§5.4・§10.1): Better Auth が書く操作の記録。
 * - 「前」(Q11): API キーの発行・再設定リンクの発行(メンバーへ・非常口)。書けなければ操作を始めず 500。操作が後で失敗したら
 *   同じ action で `detail.outcome = "failed"` の行を足す。鍵の発行は成功したら鍵の ID を持つ `outcome = "succeeded"` の行を足す(Q22)
 * - 「後」: 招待の発行・受諾・パスワードのログイン。書けなくても(組み立ての例外も)応答は変えない(Review Focus 4)
 * - 非常口の掃除: batch の先頭に記録(guard と件数は同じ文の中)
 */

const ORIGIN = { origin: "http://localhost:3000" };
const open = { envOverride: BREAK_GLASS };
const TIMEOUT = 20_000;

type Row = {
  id: number;
  category: string;
  action: string;
  workspace_id: string | null;
  via: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail_json: string;
};
const events = async (action: string): Promise<Array<Row & { detail: Record<string, unknown> }>> =>
  (await env.DB.prepare(`select * from audit_events where action = ?1 order by id`).bind(action).all<Row>()).results.map((r) => ({
    ...r,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  }));
const count = async (q: string, ...binds: unknown[]) => Number((await env.DB.prepare(q).bind(...binds).first<{ n: number }>())?.n ?? 0);
const resetTokensOf = (userId: string) => count(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?1`, userId);
const keysOf = (userId: string) => count(`select count(*) as n from apikey where "userId" = ?1`, userId);
const failingAudit = () => failingD1Insert(env.DB, "audit_events");
const freeze = () => env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
/** console.error の引数にメールアドレスが無い */
const expectNoEmailInLogs = (spy: ReturnType<typeof vi.spyOn>) => {
  for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(/@/);
};
const invite = (token: string, wid: string, email: string, role = "editor", envOverride?: Partial<Env>) =>
  call("POST", `/workspaces/${wid}/invitations`, { token, body: { email, role }, envOverride });
const resetMember = (token: string, wid: string, memberId: string, envOverride: Partial<Env> = {}) =>
  call("POST", `/workspaces/${wid}/members/${memberId}/reset-link`, { token, envOverride: { ...BREAK_GLASS, ...envOverride } });
const resetOwner = (email: string, envOverride: Partial<Env> = {}) =>
  call("POST", "/break-glass/reset-link", { body: { token: BREAK_GLASS.AB_BREAK_GLASS_TOKEN, email }, envOverride: { ...BREAK_GLASS, ...envOverride } });

const auditInserts = (n: D1Counts) => n.sql.filter((q) => /^\s*insert into audit_events/i.test(q)).length;
/**
 * 再設定リンクの token の insert の直前に、対象の人が別のワークスペースの招待を受ける(workspaces.test.ts の交錯と同じ形)。
 * 発行の後の読み直し(assertCanResetMember)が他所の所属を見て 403 で断る
 */
const acceptBeforeTokenInsert = (invitationId: string, token: string, db: D1Database = env.DB): D1Database => {
  const original = db.prepare.bind(db);
  return Object.create(db, {
    prepare: {
      value: (q: string) => {
        const stmt = original(q);
        if (!/insert into "?verification"?/i.test(q)) return stmt;
        const bind = stmt.bind.bind(stmt);
        stmt.bind = ((...args: unknown[]) => {
          const bound = bind(...args);
          const all = bound.all.bind(bound);
          bound.all = (async () => {
            expect((await call("POST", `/invitations/${invitationId}/accept`, { token })).status).toBe(200);
            return all();
          }) as typeof bound.all;
          return bound;
        }) as typeof stmt.bind;
        return stmt;
      },
    },
  }) as D1Database;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invitation.create (後)", () => {
  it("invitation_create_records_role_and_extended", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("invited");
    const first = await invite(owner.token, owner.workspaceId, email);
    expect(first.status).toBe(201);
    const { id } = await json<{ id: string }>(first);
    // 同じロールの再発行 = 期限の延長
    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    const rows = await events("invitation.create");
    expect(rows.map((r) => [r.workspace_id, r.via, r.actor_user_id, r.target_type, r.target_id, r.target_label, r.detail])).toEqual([
      [owner.workspaceId, "google", owner.userId, "invitation", id, email, { role: "editor", extended: false }],
      [owner.workspaceId, "google", owner.userId, "invitation", id, email, { role: "editor", extended: true }],
    ]);
    // 409 already_invited(違うロール)・already_member(既にメンバー)では記録しない
    expect((await invite(owner.token, owner.workspaceId, email, "viewer")).status).toBe(409);
    expect((await invite(owner.token, owner.workspaceId, owner.email)).status).toBe(409);
    expect(await events("invitation.create")).toHaveLength(2);
  });
});

describe("invitation.accept (後)", () => {
  it("accept_with_session_and_signup", async () => {
    const owner = await setupOwner();
    // Bearer あり(Google のセッション): via = 受けた人のセッションの loginMethod、signUp = false
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    // Bearer 無し(非常口が開いている): アカウントを作る。via = password、signUp = true
    const pw = await joinWithPassword(owner, "viewer");
    const rows = await events("invitation.accept");
    expect(rows.map((r) => [r.category, r.workspace_id, r.via, r.actor_user_id, r.actor_email, r.target_type, r.target_label, r.detail])).toEqual([
      ["access", owner.workspaceId, "google", ed.userId, ed.email, "invitation", ed.email, { role: "editor", signUp: false }],
      ["access", owner.workspaceId, "password", pw.userId, pw.email, "invitation", pw.email, { role: "viewer", signUp: true }],
    ]);
    // 招待の ID が対象の ID
    const invIds = (await env.DB.prepare(`select id from invitation where "organizationId" = ?1 and status = 'accepted' order by "createdAt"`).bind(owner.workspaceId).all<{ id: string }>()).results.map((r) => r.id);
    expect(rows.map((r) => r.target_id).sort()).toEqual([...invIds].sort());
    // パスワードのセッションで受けた人(Bearer あり)は password
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    const inv = await json<{ id: string }>(await invite(owner.token, other.id, pw.email));
    const pwToken = await signInWithPassword(pw.email);
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: pwToken, ...open })).status).toBe(200);
    const last = (await events("invitation.accept")).at(-1)!;
    expect([last.workspace_id, last.via, last.target_id, last.detail]).toEqual([other.id, "password", inv.id, { role: "editor", signUp: false }]);
  }, TIMEOUT);

  it("accept_records_even_when_the_cleanup_after_accept_fails (B129 final review FR-Medium-1)", async () => {
    // 受諾の後の 2 回目の再設定リンクの削除だけを失敗させる(1 回目 = 受諾の前は通す)。受諾は確定しているので、500 のまま記録は残る
    const owner = await setupOwner();
    const email = uniqueEmail("ed");
    // 招待の前にアカウントがある人(Google のセッションで受ける)。招待の無いメールは Google のログインを断られるので D1 に直接入れる
    const token = await seedSession(await seedUser(email, "Ed"));
    const inv = await json<{ id: string }>(await invite(owner.token, owner.workspaceId, email));
    const resetDelete = /^\s*delete from verification where identifier like 'reset-password:%' and value = /;
    let seen = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (q: string) => (resetDelete.test(q) && ++seen === 2 ? failingD1Query(target, resetDelete).prepare(q) : target.prepare(q));
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token, envOverride: { DB: db } })).status).toBe(500);
    expect(seen).toBe(2);
    const [e, ...rest] = await events("invitation.accept");
    expect(rest).toEqual([]);
    expect([e!.workspace_id, e!.target_id, e!.actor_email, e!.detail]).toEqual([owner.workspaceId, inv.id, email, { role: "editor", signUp: false }]);
    expect(await count(`select count(*) as n from member m join "user" u on u.id = m."userId" where m."organizationId" = ?1 and u.email = ?2`, owner.workspaceId, email)).toBe(1);
    errors.mockRestore();
  }, TIMEOUT);

  it("accept_succeeds_when_audit_fails", async () => {
    const owner = await setupOwner();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Bearer 無しのアカウント作成(Review Focus 4)
    const email = uniqueEmail("pw");
    const inv = await json<{ id: string }>(await invite(owner.token, owner.workspaceId, email));
    const acc = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Pw", password: BREAK_GLASS_PASSWORD }, envOverride: { ...BREAK_GLASS, DB: failingAudit() } });
    expect(acc.status).toBe(200);
    const { userId } = await json<{ userId: string }>(acc);
    expect(await count(`select count(*) as n from member where "organizationId" = ?1 and "userId" = ?2`, owner.workspaceId, userId)).toBe(1);
    expect(await events("invitation.accept")).toEqual([]);
    expect(errors).toHaveBeenCalled();
    expect(errors.mock.calls.some((a) => a[0] === "audit: failed to record")).toBe(true);
    expectNoEmailInLogs(errors);
    // 招待の発行でも同じ(201 のまま・招待はできている)
    errors.mockClear();
    const email2 = uniqueEmail("invited");
    const res = await invite(owner.token, owner.workspaceId, email2, "editor", { DB: failingAudit() });
    expect(res.status).toBe(201);
    expect(await count(`select count(*) as n from invitation where email = ?1 and status = 'pending'`, email2)).toBe(1);
    expect((await events("invitation.create")).map((r) => r.target_label)).toEqual([email]);
    expect(errors).toHaveBeenCalledWith("audit: failed to record", expect.anything(), expect.anything());
    expectNoEmailInLogs(errors);
  }, TIMEOUT);

  it("after_builder_failure_keeps_response", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const builder = vi.spyOn(audit, "actorFromUser").mockImplementation(() => {
      throw new Error("builder failed");
    });
    // 受諾(Bearer 無し): 200・Member 行ができる
    const email = uniqueEmail("pw");
    const inv = await json<{ id: string }>(await invite(owner.token, owner.workspaceId, email));
    const acc = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Pw", password: BREAK_GLASS_PASSWORD }, ...open });
    expect(acc.status).toBe(200);
    const { userId } = await json<{ userId: string }>(acc);
    expect(await count(`select count(*) as n from member where "organizationId" = ?1 and "userId" = ?2`, owner.workspaceId, userId)).toBe(1);
    // パスワードのログイン: セッションができる
    const before = await count(`select count(*) as n from session where "userId" = ?1`, pw.userId);
    const token = await signInWithPassword(pw.email);
    expect((await call("GET", "/me", { token })).status).toBe(200);
    expect(await count(`select count(*) as n from session where "userId" = ?1`, pw.userId)).toBe(before + 1);
    expect(builder).toHaveBeenCalledTimes(2);
    expect(await events("invitation.accept")).toHaveLength(1); // 準備の joinWithPassword の分だけ
    expect(await events("auth.password_login")).toEqual([]);
    expect(errors.mock.calls.filter((a) => a[0] === "audit: failed to record")).toHaveLength(2);
    expectNoEmailInLogs(errors);
  }, TIMEOUT);
});

describe("api_key.create (前・Q11・Q22)", () => {
  it("api_key_create_records_scope", async () => {
    const owner = await setupOwner();
    const ws = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "ws key", workspaceId: owner.workspaceId, roleCap: "editor", expiresInDays: 30 } });
    expect(ws.status).toBe(201);
    const wsKey = await json<{ id: string; expiresAt: number }>(ws);
    const full = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "full key", workspaceId: null } });
    expect(full.status).toBe(201);
    const fullKey = await json<{ id: string }>(full);
    const rows = await events("api_key.create");
    expect(rows.map((r) => [r.workspace_id, r.via, r.actor_user_id, r.target_type, r.target_id, r.target_label, r.detail])).toEqual([
      [owner.workspaceId, "google", owner.userId, "api_key", null, "ws key", { scope: "workspace", workspaceId: owner.workspaceId, roleCap: "editor", expiresAt: wsKey.expiresAt }],
      [owner.workspaceId, "google", owner.userId, "api_key", wsKey.id, "ws key", { scope: "workspace", workspaceId: owner.workspaceId, roleCap: "editor", expiresAt: wsKey.expiresAt, outcome: "succeeded" }],
      [null, "google", owner.userId, "api_key", null, "full key", { scope: "full", workspaceId: null, roleCap: null, expiresAt: null }],
      [null, "google", owner.userId, "api_key", fullKey.id, "full key", { scope: "full", workspaceId: null, roleCap: null, expiresAt: null, outcome: "succeeded" }],
    ]);
    // 403 password_session(パスワードのセッション)では記録しない
    const pw = await joinWithPassword(owner);
    const pwToken = await signInWithPassword(pw.email);
    const refused = await call("POST", "/me/api-keys", { token: pwToken, body: { name: "pw key", workspaceId: owner.workspaceId }, ...open });
    expect(refused.status).toBe(403);
    expect((await json<{ error: string }>(refused)).error).toBe("password_session");
    // 範囲の判定で断られた(非メンバーのワークスペース = 404)ときも記録しない
    expect((await call("POST", "/me/api-keys", { token: owner.token, body: { name: "x", workspaceId: "no-such-workspace" } })).status).toBe(404);
    expect(await events("api_key.create")).toHaveLength(4);
  }, TIMEOUT);

  it("api_key_create_success_row_carries_key_id", async () => {
    const owner = await setupOwner();
    const counting = countingD1(env.DB);
    const res = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId }, envOverride: { DB: counting.db } });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const [before, succeeded, ...rest] = await events("api_key.create");
    expect(rest).toEqual([]);
    expect([before!.target_id, before!.detail.outcome]).toEqual([null, undefined]);
    expect([succeeded!.target_id, succeeded!.detail.outcome]).toEqual([id, "succeeded"]);
    // 往復は「前」の 1 回 + 成功の行の 1 回(+2。Global Constraints の表)。どちらも batch ではない 1 文
    const n = counting.counts();
    expect(n.sql.filter((s) => /^\s*insert into audit_events/i.test(s))).toHaveLength(2);
    expect(n.batchSql.flat().filter((s) => /audit_events/.test(s))).toEqual([]);
    // 「前」の行は発行(apikey の insert)より前
    const order = n.sql.map((s) => (/^\s*insert into audit_events/i.test(s) ? "audit" : /^\s*insert into "?apikey"?/i.test(s) ? "apikey" : null)).filter(Boolean);
    expect(order).toEqual(["audit", "apikey", "audit"]);
  });

  it("api_key_create_before_write_failure_blocks", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId }, envOverride: { DB: failingAudit() } });
    expect(res.status).toBe(500);
    expect(await keysOf(owner.userId)).toBe(0);
    expect(await events("api_key.create")).toEqual([]);
  });

  it("api_key_create_success_row_failure_keeps_key", async () => {
    const owner = await setupOwner();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // 2 つ目の audit_events の insert(成功の行)だけを失敗させる
    let inserts = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            if (/^\s*insert into audit_events/i.test(q) && ++inserts === 2) return failingD1Insert(target, "audit_events").prepare(q);
            return target.prepare(q);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const res = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId }, envOverride: { DB: db } });
    expect(res.status).toBe(201);
    const { key } = await json<{ key: string }>(res);
    expect(await keysOf(owner.userId)).toBe(1);
    expect((await call("GET", "/me", { token: key })).status).toBe(200);
    expect((await events("api_key.create")).map((r) => r.detail.outcome ?? null)).toEqual([null]);
    expect(errors).toHaveBeenCalledWith("audit: failed to record", { action: "api_key.create", targetId: expect.any(String) }, expect.anything());
    expectNoEmailInLogs(errors);
  });
});

describe("reset links (前・Q11)", () => {
  it("reset_link_records_target", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    // メンバーへの発行
    expect((await resetMember(owner.token, owner.workspaceId, ed.memberId)).status).toBe(200);
    const [m, ...restM] = await events("member.reset_link");
    expect(restM).toEqual([]);
    expect(m).toMatchObject({ category: "access", workspace_id: owner.workspaceId, via: "google", actor_user_id: owner.userId, target_type: "user", target_id: ed.userId, target_label: ed.email, detail: {} });
    // 非常口の発行: 操作した人なし・経路 break_glass・workspace_id NULL
    expect((await resetOwner(owner.email)).status).toBe(200);
    const [b, ...restB] = await events("break_glass.reset_link");
    expect(restB).toEqual([]);
    expect(b).toMatchObject({ category: "access", workspace_id: null, via: "break_glass", actor_user_id: null, actor_email: null, target_type: "user", target_id: owner.userId, target_label: owner.email, detail: {} });
    // 404 の分岐(メンバーでない・オーナーでない・トークン違い)では記録しない
    expect((await resetMember(owner.token, owner.workspaceId, "no-such-member")).status).toBe(404);
    expect((await resetOwner(ed.email)).status).toBe(404);
    expect((await call("POST", "/break-glass/reset-link", { body: { token: "x".repeat(32), email: owner.email }, ...open })).status).toBe(404);
    // 非常口が閉じている(409 password_login_disabled)・権限が足りない(403)ときも記録しない
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token })).status).toBe(409);
    expect((await resetMember(ed.token, owner.workspaceId, ed.memberId)).status).toBe(403);
    expect(await events("member.reset_link")).toHaveLength(1);
    expect(await events("break_glass.reset_link")).toHaveLength(1);
  });
});

describe("before ops (Q11)", () => {
  it("before_ops_stop_when_audit_fails", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId }, envOverride: { DB: failingAudit() } })).status).toBe(500);
    expect(await keysOf(owner.userId)).toBe(0);
    expect((await resetMember(owner.token, owner.workspaceId, ed.memberId, { DB: failingAudit() })).status).toBe(500);
    expect(await resetTokensOf(ed.userId)).toBe(0);
    expect((await resetOwner(owner.email, { DB: failingAudit() })).status).toBe(500);
    expect(await resetTokensOf(owner.userId)).toBe(0);
    expect(await count(`select count(*) as n from audit_events where action in ('api_key.create', 'member.reset_link', 'break_glass.reset_link')`)).toBe(0);
  });

  it("before_ops_record_failed_outcome", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 記録の後に操作(ライブラリの書き込み)が失敗する。往復は失敗のときも +2(「前」の行と失敗の行の insert が 1 文ずつ。Global Constraints の表)
    const key = countingD1(failingD1Insert(env.DB, "apikey"));
    expect((await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId }, envOverride: { DB: key.db } })).status).toBe(500);
    const member = countingD1(failingD1Insert(env.DB, "verification"));
    expect((await resetMember(owner.token, owner.workspaceId, ed.memberId, { DB: member.db })).status).toBe(500);
    const glass = countingD1(failingD1Insert(env.DB, "verification"));
    expect((await resetOwner(owner.email, { DB: glass.db })).status).toBe(500);
    for (const [label, counting] of [["api key", key], ["member reset link", member], ["break-glass reset link", glass]] as const) {
      const n = counting.counts();
      expect(auditInserts(n), label).toBe(2);
      expect(n.batchSql.flat().filter((q) => /audit_events/.test(q)), label).toEqual([]);
    }
    expect(await keysOf(owner.userId)).toBe(0);
    for (const [action, via, target] of [
      ["api_key.create", "google", null],
      ["member.reset_link", "google", ed.userId],
      ["break_glass.reset_link", "break_glass", owner.userId],
    ] as const) {
      const rows = await events(action);
      expect(rows.map((r) => [r.via, r.target_id, r.detail.outcome ?? null]), action).toEqual([
        [via, target, null],
        [via, target, "failed"],
      ]);
    }
    // 発行の後の読み直しで断った(403)ときも「試みたが失敗」の行が続く
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    const inv = await json<{ id: string }>(await invite(owner.token, other.id, ed.email));
    expect((await resetMember(admin.token, owner.workspaceId, ed.memberId, { DB: acceptBeforeTokenInsert(inv.id, ed.token) })).status).toBe(403);
    expect((await events("member.reset_link")).slice(2).map((r) => [r.actor_user_id, r.detail.outcome ?? null])).toEqual([
      [admin.userId, null],
      [admin.userId, "failed"],
    ]);
  }, TIMEOUT);

  it("reset_link_token_cleanup_failure_keeps_failed_row", async () => {
    // 読み直しで断った後の token の削除が失敗しても、failed の行が残り、応答は元の 403 のまま(削除の例外に置き換わらない)
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    const inv = await json<{ id: string }>(await invite(owner.token, other.id, ed.email));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = acceptBeforeTokenInsert(inv.id, ed.token, failingD1Query(env.DB, /^\s*delete from verification where identifier = /i));
    const res = await resetMember(admin.token, owner.workspaceId, ed.memberId, { DB: db });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner_of_other_workspaces" });
    expect((await events("member.reset_link")).map((r) => [r.actor_user_id, r.target_id, r.detail.outcome ?? null])).toEqual([
      [admin.userId, ed.userId, null],
      [admin.userId, ed.userId, "failed"],
    ]);
    // 消せなかった token は残る(期限まで)。ログはそのことだけで、メールアドレスを出さない
    expect(await resetTokensOf(ed.userId)).toBe(1);
    expect(errors.mock.calls.some((a) => String(a[0]).startsWith("reset link: failed to delete the issued token"))).toBe(true);
    expectNoEmailInLogs(errors);
  }, TIMEOUT);

  it("reset_link_round_trips", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    // 成功: 1 行・+1
    const ok = countingD1(env.DB);
    expect((await resetMember(owner.token, owner.workspaceId, ed.memberId, { DB: ok.db })).status).toBe(200);
    expect(auditInserts(ok.counts())).toBe(1);
    const okOwner = countingD1(env.DB);
    expect((await resetOwner(owner.email, { DB: okOwner.db })).status).toBe(200);
    expect(auditInserts(okOwner.counts())).toBe(1);
    expect(okOwner.counts().batches).toBe(0);
  });
});

describe("auth.password_login (後)", () => {
  it("password_login_is_recorded", async () => {
    const owner = await setupOwner();
    // /auth/sign-up/email(招待の Bearer 無しの受諾)では記録しない
    const pw = await joinWithPassword(owner);
    expect(await events("auth.password_login")).toEqual([]);
    // /auth/sign-in/email で 1 行
    const counting = countingD1(env.DB);
    const res = await call("POST", "/auth/sign-in/email", { body: { email: pw.email, password: BREAK_GLASS_PASSWORD }, headers: ORIGIN, envOverride: { ...BREAK_GLASS, DB: counting.db } });
    expect(res.status).toBe(200);
    expect(counting.counts().sql.filter((s) => /^\s*insert into audit_events/i.test(s))).toHaveLength(1);
    const [e, ...rest] = await events("auth.password_login");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ category: "access", workspace_id: null, via: "password", actor_user_id: pw.userId, actor_email: pw.email, actor_name: "Pw", target_type: "user", target_id: pw.userId, target_label: pw.email, detail: {} });
    // Google のログインでは記録しない
    expect((await googleSignIn(owner.email)).token).toBeTruthy();
    // 間違ったパスワードでは記録しない
    expect((await call("POST", "/auth/sign-in/email", { body: { email: pw.email, password: "wrong-password-0" }, headers: ORIGIN, ...open })).status).toBe(401);
    expect(await events("auth.password_login")).toHaveLength(1);
  }, TIMEOUT);

  it("password_login_refused_by_sweep_is_not_recorded", async () => {
    const owner = await setupOwner();
    const a = await joinWithPassword(owner);
    // 保存の後・確かめの前で止め、その間に掃除が走る → 確かめが断る(password_login_disabled)
    const after = pausingD1Insert(env.DB, "session", "after");
    const pending = call("POST", "/auth/sign-in/email", { body: { email: a.email, password: BREAK_GLASS_PASSWORD }, headers: ORIGIN, envOverride: { ...BREAK_GLASS, DB: after.db } });
    await after.reached;
    await runCron(testEnv, Date.now(), [breakGlassSweep]);
    after.release();
    expect((await pending).status).toBe(401);
    expect(await events("auth.password_login")).toEqual([]);
  }, TIMEOUT);

  it("password_login_recorded_while_frozen", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await freeze();
    // 凍結の外の経路(/auth/*・/break-glass/*)は凍結中も記録する(spec §5.4)
    await signInWithPassword(pw.email);
    expect((await resetOwner(owner.email)).status).toBe(200);
    expect(await events("auth.password_login")).toHaveLength(1);
    expect(await events("break_glass.reset_link")).toHaveLength(1);
  }, TIMEOUT);
});

describe("break_glass.sweep (batch)", () => {
  const sweep = (e: Env = testEnv) => runCron(e, Date.now(), [breakGlassSweep]);

  it("sweep_records_counts_once", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await signInWithPassword(pw.email);
    // ジョブだけを runner の外で動かして数える(runner 自身の照会を混ぜない)
    const counting = countingD1(env.DB);
    const jobEnv = { ...testEnv, DB: counting.db } as Env;
    const jobDb = getDb(jobEnv);
    const ctx = {
      env: jobEnv,
      db: jobDb,
      now: Date.now(),
      assertNotFrozen: async () => {
        if (await isWriteFrozen(jobDb)) throw new Error("frozen");
      },
      queries: { left: () => Infinity, use: () => true },
    } as unknown as Parameters<typeof breakGlassSweep.run>[0];
    await breakGlassSweep.run(ctx);
    // クエリの配分(2 件)は変わらない: batch の外は凍結の確かめの 1 回だけ、掃除の batch は 1 つのまま(記録はその先頭の文)
    const n = counting.counts();
    expect(n.queries, n.sql.join("\n")).toBe(1);
    expect(n.sql[0]).toMatch(/instance_settings/);
    expect(n.batches).toBe(1);
    expect(n.batchSql[0]).toHaveLength(3);
    expect(n.batchSql[0]![0]).toMatch(/^\s*insert into audit_events/i);
    const [e, ...rest] = await events("break_glass.sweep");
    expect(rest).toEqual([]);
    // パスワードの記録 1(pw)・セッション 2(登録・パスワードのログイン)
    expect(e).toMatchObject({ category: "access", workspace_id: null, via: "system", actor_user_id: null, target_type: "instance", target_id: null, detail: { passwords: 1, sessions: 2 } });
    // 消すものが無い 2 回目は記録しない
    await sweep();
    expect(await events("break_glass.sweep")).toHaveLength(1);
  }, TIMEOUT);

  it("sweep_frozen_writes_no_event", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await freeze();
    expect(await sweep()).toEqual([{ job: "break-glass-sweep", outcome: "skipped_frozen" }]);
    expect(await count(`select count(*) as n from account where "providerId" = 'credential' and "userId" = ?1`, pw.userId)).toBe(1);
    expect(await events("break_glass.sweep")).toEqual([]);
    // 凍結の確かめの後・batch の前に凍結が入っても、記録も削除も無い(guard に NOT_FROZEN_SQL)
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    expect(await sweep({ ...testEnv, DB: beforeD1Batch(env.DB, freeze) })).toEqual([{ job: "break-glass-sweep", outcome: "ran" }]);
    expect(await count(`select count(*) as n from account where "providerId" = 'credential' and "userId" = ?1`, pw.userId)).toBe(1);
    expect(await events("break_glass.sweep")).toEqual([]);
  }, TIMEOUT);
});
