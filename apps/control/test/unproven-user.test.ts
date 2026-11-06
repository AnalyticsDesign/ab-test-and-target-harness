import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { breakGlassSweep } from "../src/cron/break-glass-sweep";
import { runCron } from "../src/cron/runner";
import { grantInstanceAdmin } from "../src/instance-admins";
import {
  BREAK_GLASS,
  beforeD1BatchMatching,
  beforeD1Query,
  call,
  countingD1,
  googleSignIn,
  inviteAndJoin,
  joinWithPassword,
  json,
  setupOwner,
  testEnv,
  uniqueEmail,
} from "./helpers";

/**
 * B179 Task 2(D4): 招待を出すとき、同じメールの「確かめられていないパスワードの人」の記録を消す。
 * 消す条件 = emailVerified = 0・Google の結びつき無し・どこのメンバーでもない・システム管理者でない・有効なセッションが無い。
 * 消す文は招待の前の pending の照会と同じ batch(往復は増えない)。応答は変えない
 */

/** パスワードと Google の往復・Cron を通すので、全体を流す負荷の下では既定の 5 秒を超えうる */
const TIMEOUT = 20_000;

const id = () => crypto.randomUUID().replace(/-/g, "");
const iso = (ms: number) => new Date(ms).toISOString();
const count = async (q: string, ...binds: unknown[]) => Number((await env.DB.prepare(q).bind(...binds).first<{ n: number }>())?.n ?? 0);
const usersWithEmail = (email: string) => count(`select count(*) as n from "user" where lower(email) = lower(?)`, email);
const userExists = (userId: string) => count(`select count(*) as n from "user" where id = ?`, userId);
const memberCount = (userId: string) => count(`select count(*) as n from member where "userId" = ?`, userId);
const invite = (token: string, wid: string, email: string, role: "admin" | "editor" | "viewer" = "editor", envOverride?: Record<string, unknown>) =>
  call("POST", `/workspaces/${wid}/invitations`, { token, body: { email, role }, ...(envOverride ? { envOverride } : {}) });

/**
 * パスワードで作った未確認の人を SQL で用意する(Better Auth の sign-up が作る形: emailVerified = 0・credential の account)。
 * opts で 1 つの条件だけを変える(否定のテストが条件を 1 つずつ外せるように)
 */
async function seedUnproven(email: string, opts: { verified?: boolean; google?: boolean } = {}): Promise<string> {
  const userId = id();
  const now = iso(Date.now());
  const stmts = [
    env.DB.prepare(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (?1, 'Pw', ?2, ?3, ?4, ?4)`).bind(userId, email, opts.verified ? 1 : 0, now),
    env.DB.prepare(`insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") values (?1, ?2, 'credential', ?2, 'x:y', ?3, ?3)`).bind(id(), userId, now),
  ];
  if (opts.google) {
    stmts.push(env.DB.prepare(`insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") values (?1, ?2, 'google', ?3, ?4, ?4)`).bind(id(), `g-${email}`, userId, now));
  }
  await env.DB.batch(stmts);
  return userId;
}

/** セッションを SQL で入れる(期限は expiresAt。Better Auth の date 列と同じ ISO 文字列) */
async function seedSessionRow(userId: string, expiresAt: number): Promise<void> {
  const now = iso(Date.now());
  await env.DB.prepare(
    `insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "loginMethod") values (?1, ?2, ?3, ?4, ?4, ?5, 'password')`,
  )
    .bind(id(), iso(expiresAt), id() + id(), now, userId)
    .run();
}

/** 別のワークスペースを作る(作った人 = システム管理者全員が OWNER) */
async function newWorkspace(token: string, name = "Second"): Promise<string> {
  const res = await call("POST", "/workspaces", { token, body: { name } });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** その人の Google でログインして招待を受け、受けた人の user ID を返す */
async function acceptWithGoogle(email: string, invitationId: string): Promise<string> {
  const { token } = await googleSignIn(email);
  expect(token).toBeTruthy();
  const acc = await call("POST", `/invitations/${invitationId}/accept`, { token: token! });
  expect(acc.status).toBe(200);
  return (await json<{ userId: string }>(acc)).userId;
}

/**
 * batch の結果の meta(rows_read / rows_written)を、`sqlPattern` に合う文を含む batch だけ控える D1 ラッパ。
 * batch は文の中身を直接読むので、prepare の SQL を控えて本物の文で見分ける(helpers の beforeD1BatchMatching と同じ包み方)
 */
function capturingBatchMeta(db: D1Database, sqlPattern: RegExp): { db: D1Database; metas(): Array<Array<{ rows_read?: number; rows_written?: number; changes?: number }>> } {
  const metas: Array<Array<{ rows_read?: number; rows_written?: number; changes?: number }>> = [];
  const sqlOf = new WeakMap<object, string>();
  const remember = (stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement => {
    sqlOf.set(stmt, sqlText);
    const bind = stmt.bind.bind(stmt);
    return Object.assign(stmt, { bind: (...args: unknown[]) => remember(bind(...args), sqlText) });
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (sqlText: string) => remember(target.prepare(sqlText), sqlText);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const out = await target.batch(stmts);
          if (stmts.some((s) => sqlPattern.test(sqlOf.get(s) ?? ""))) metas.push(out.map((r) => ({ rows_read: r.meta.rows_read, rows_written: r.meta.rows_written, changes: r.meta.changes })));
          return out;
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, metas: () => metas };
}

describe("unproven password user on re-invite (B179 Task 2)", () => {
  it("reinvite_after_instance_admin_revoke_without_prior_record_b179", async () => {
    const owner = await setupOwner();
    // /setup の最初の人と同じく、昇格の前の記録が無いシステム管理者(パスワードで作った未確認の人)
    const email = uniqueEmail("pw");
    const old = await seedUnproven(email);
    expect(await grantInstanceAdmin(testEnv, old, null)).toBe("granted");
    expect(await count(`select count(*) as n from instance_admin_prior_roles where user_id = ?`, old)).toBe(0);
    expect((await call("DELETE", `/instance-admins/${old}`, { token: owner.token })).status).toBe(204);
    expect(await memberCount(old)).toBe(0);
    expect(await count(`select count(*) as n from instance_admins where user_id = ?`, old)).toBe(0);
    expect(await userExists(old)).toBe(1);

    const inv = await invite(owner.token, owner.workspaceId, email);
    expect(inv.status).toBe(201);
    expect(await usersWithEmail(email)).toBe(0);
    // 本人が Google で受けて、新しい user で入れる
    const fresh = await acceptWithGoogle(email, (await json<{ id: string }>(inv)).id);
    expect(fresh).not.toBe(old);
    expect(await memberCount(fresh)).toBe(1);
  }, TIMEOUT);

  it("reinvite_after_instance_admin_revoke_restore_false_b179", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const old = await seedUnproven(email);
    // 昇格の前にこのワークスペースの編集者だった(記録がある)。restore=false で外すと、記録があってもすべてから外れる
    await env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'editor', ?4)`).bind(id(), owner.workspaceId, old, iso(Date.now())).run();
    expect(await grantInstanceAdmin(testEnv, old, null)).toBe("granted");
    expect((await call("DELETE", `/instance-admins/${old}?restore=false`, { token: owner.token })).status).toBe(204);
    expect(await memberCount(old)).toBe(0);
    expect(await userExists(old)).toBe(1);

    const inv = await invite(owner.token, owner.workspaceId, email);
    expect(inv.status).toBe(201);
    expect(await usersWithEmail(email)).toBe(0);
    const fresh = await acceptWithGoogle(email, (await json<{ id: string }>(inv)).id);
    expect(fresh).not.toBe(old);
  }, TIMEOUT);

  it("reinvite_user_without_membership_before_upgrade_b179", async () => {
    const owner = await setupOwner();
    // 更新の前から所属が 0 の未確認のパスワードの人(SQL で用意)。account・session・apikey は CASCADE で消える
    const email = uniqueEmail("pw").toUpperCase(); // 大文字で登録されていても、招待のメール(小文字)で当たる
    const old = await seedUnproven(email);
    await seedSessionRow(old, Date.now() - 60_000); // 期限切れのセッションは消す妨げにならない
    const now = iso(Date.now());
    await env.DB.prepare(`insert into apikey (id, key, "userId", "createdAt", "updatedAt") values (?1, 'k', ?2, ?3, ?3)`).bind(id(), old, now).run();

    const log = vi.spyOn(console, "log");
    let res: Response;
    let calls: unknown[][];
    try {
      res = await invite(owner.token, owner.workspaceId, email);
    } finally {
      calls = [...log.mock.calls]; // mockRestore は控えた呼び出しも消すので、先に写す
      log.mockRestore();
    }
    expect(res.status).toBe(201);
    // 消したときは件数だけをログに出す(人の数。CASCADE で消えた行は数えない。メールアドレス・ID は出さない)
    const lines = calls.map((a) => a.map(String).join(" ")).filter((l) => l.includes("unverified password user"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("removed 1 ");
    expect(lines[0]!.toLowerCase()).not.toContain(email.toLowerCase());
    expect(lines[0]).not.toContain(old);
    // 応答は今のまま(消したかどうかを出さない)
    expect(Object.keys(await json(res)).sort()).toEqual(["expiresAt", "extended", "id", "url"]);
    expect(await userExists(old)).toBe(0);
    for (const t of ["account", "session", "apikey"]) expect(await count(`select count(*) as n from ${t} where "userId" = ?`, old), t).toBe(0);
  });

  it("reinvite_reassigns_their_pending_invitations_b179", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const old = await seedUnproven(email);
    // 消える人が出していた pending の招待(user の inviterId の CASCADE で消えないよう、付け替えてから消す)
    const theirs = id();
    await env.DB.prepare(
      `insert into invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") values (?1, ?2, ?3, 'viewer', 'pending', ?4, ?5, ?6)`,
    )
      .bind(theirs, owner.workspaceId, uniqueEmail("other"), iso(Date.now() + 86_400_000), iso(Date.now()), old)
      .run();

    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(old)).toBe(0);
    expect(await env.DB.prepare(`select status, "inviterId" as inviter from invitation where id = ?`).bind(theirs).first()).toEqual({ status: "pending", inviter: owner.userId });
  });

  it("reinvite_drops_their_reset_tokens_b179", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const old = await seedUnproven(email);
    const other = await seedUnproven(uniqueEmail("keep"), { verified: true });
    const now = Date.now();
    for (const [identifier, value] of [[`reset-password:${id()}`, old], [`reset-password:${id()}`, other]] as const) {
      await env.DB.prepare(`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") values (?1, ?2, ?3, ?4, ?5, ?5)`)
        .bind(id(), identifier, value, iso(now + 3_600_000), iso(now))
        .run();
    }

    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(old)).toBe(0);
    // 再設定の token は外部キーが無く CASCADE で消えないので、同じ batch で消す。ほかの人の token には触れない
    expect(await count(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?`, old)).toBe(0);
    expect(await count(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?`, other)).toBe(1);
  });

  it("does_not_delete_user_with_google_account_b179", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const kept = await seedUnproven(email, { google: true });
    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(kept)).toBe(1);
  });

  it("does_not_delete_user_still_member_somewhere_b179", async () => {
    const owner = await setupOwner();
    // 別のワークスペースのメンバー(招待を出すワークスペースにはいない)。SQL で入れ、ほかの条件は満たしたままにする
    const second = await newWorkspace(owner.token);
    const email = uniqueEmail("pw");
    const kept = await seedUnproven(email);
    await env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'viewer', ?4)`).bind(id(), second, kept, iso(Date.now())).run();
    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(kept)).toBe(1);
  });

  it("does_not_delete_verified_user_b179", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("pw");
    const kept = await seedUnproven(email, { verified: true });
    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(kept)).toBe(1);
  });

  it("does_not_delete_instance_admin_b179", async () => {
    const owner = await setupOwner();
    // instance_admins の行だけ(member の行は入れない。ほかの条件は満たしたまま、システム管理者の条件だけで残ることを見る)
    const email = uniqueEmail("pw");
    const kept = await seedUnproven(email);
    await env.DB.prepare(`insert into instance_admins (user_id, granted_by, created_at) values (?1, null, ?2)`).bind(kept, Date.now()).run();
    expect((await invite(owner.token, owner.workspaceId, email)).status).toBe(201);
    expect(await userExists(kept)).toBe(1);
  });

  it("concurrent_accept_elsewhere_keeps_user_b179", async () => {
    const owner = await setupOwner();
    const second = await newWorkspace(owner.token);
    const email = uniqueEmail("pw");
    const kept = await seedUnproven(email);
    // 招待の batch の直前に、同じ人が別のワークスペースに入る(事前に読んで判断していれば消してしまう競合)。条件は消す文の中にあるので残る
    const hooked = beforeD1BatchMatching(env.DB, /delete from "user"/i, () =>
      env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'viewer', ?4)`).bind(id(), second, kept, iso(Date.now())).run(),
    );
    expect((await invite(owner.token, owner.workspaceId, email, "editor", { DB: hooked.db })).status).toBe(201);
    expect(hooked.ran()).toBe(true);
    expect(await userExists(kept)).toBe(1);
    expect(await memberCount(kept)).toBe(1);
  });

  it("reinvite_during_accept_keeps_user_and_accept_succeeds_b179", async () => {
    const owner = await setupOwner();
    const admin2 = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const second = await newWorkspace(owner.token);
    // 非常口を開けて、パスワードで登録した人(未確認)。owner のワークスペースに入った後、別のワークスペースへ招待し、元の所属を外す
    // → 所属 0・有効なパスワードのセッションあり・second の pending の招待あり
    const pw = await joinWithPassword(owner);
    const inv2 = await json<{ id: string }>(await invite(owner.token, second, pw.email));
    await env.DB.prepare(`delete from member where "userId" = ?`).bind(pw.userId).run();
    expect(await memberCount(pw.userId)).toBe(0);

    // 受諾の途中(招待を accepted に書いた後・member を足す前)に、別の管理者の招待し直しを差し込む
    let statusInWindow: unknown = null;
    let reinviteStatus = 0;
    // B179: 差し込む招待し直しは、受諾の外の別の要求として流す。1.7 の受諾は member の追加を runWithTransaction(AsyncLocalStorage の文脈)の中で
    // 行い、この hook の中からそのまま呼ぶと、招待し直しが受諾の文脈(受諾の adapter・「トランザクションの中」の印)を引き継いで終わらない。
    // 本番の別の要求は自分の文脈で動くので、受諾の前に取った文脈(snapshot)で走らせて、それに合わせる
    const outside = AsyncLocalStorage.snapshot();
    const hooked = beforeD1Query(env.DB, /^insert into "member"/i, () =>
      outside(async () => {
        statusInWindow = (await env.DB.prepare(`select status from invitation where id = ?`).bind(inv2.id).first<{ status: string }>())?.status;
        reinviteStatus = (await invite(admin2.token, owner.workspaceId, pw.email)).status;
      }),
    );
    const acc = await call("POST", `/invitations/${inv2.id}/accept`, { token: pw.token, envOverride: { ...BREAK_GLASS, DB: hooked.db } });
    expect(hooked.ran()).toBe(true);
    expect(statusInWindow).toBe("accepted");
    expect(reinviteStatus).toBe(201);
    // user は残り(有効なセッションがある)、受諾は 200 で member が足される(招待が accepted のまま member 0 にならない)
    expect(acc.status).toBe(200);
    expect(await userExists(pw.userId)).toBe(1);
    expect(await count(`select count(*) as n from member where "userId" = ? and "organizationId" = ?`, pw.userId, second)).toBe(1);
  }, TIMEOUT);

  it("does_not_delete_user_with_live_session_b179", async () => {
    const owner = await setupOwner();
    // Better Auth が作った本物のパスワードのセッション(日付の列の形を本物にそろえる)。所属は SQL で外す
    const pw = await joinWithPassword(owner);
    await env.DB.prepare(`delete from member where "userId" = ?`).bind(pw.userId).run();
    expect((await invite(owner.token, owner.workspaceId, pw.email)).status).toBe(201);
    expect(await userExists(pw.userId)).toBe(1);
    // 期限切れのセッションだけなら消える(同じロールの招待し直し = 期限の延長の経路でも、同じ batch が走る)
    await env.DB.prepare(`update session set "expiresAt" = ? where "userId" = ?`).bind(iso(Date.now() - 1000), pw.userId).run();
    expect((await invite(owner.token, owner.workspaceId, pw.email)).status).toBe(201);
    expect(await userExists(pw.userId)).toBe(0);
  }, TIMEOUT);

  it("reinvite_after_break_glass_sweep_deletes_user_b179", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    await env.DB.prepare(`delete from member where "userId" = ?`).bind(pw.userId).run();
    expect((await invite(owner.token, owner.workspaceId, pw.email)).status).toBe(201);
    expect(await userExists(pw.userId)).toBe(1); // 非常口を開けている間のセッションが残っている
    // 非常口を閉じた後の掃除(testEnv は AB_BREAK_GLASS_TOKEN を持たない)で、パスワードのセッションと記録が消える
    await runCron(testEnv, Date.now(), [breakGlassSweep]);
    expect(await count(`select count(*) as n from session where "userId" = ?`, pw.userId)).toBe(0);
    expect((await invite(owner.token, owner.workspaceId, pw.email)).status).toBe(201);
    expect(await userExists(pw.userId)).toBe(0);
  }, TIMEOUT);

  it("invitation_round_trips_unchanged_b179", async () => {
    const owner = await setupOwner();
    const now = Date.now();
    // 3 通り: 当たる人なし / 当たる人あり / 関連の行が多い人(期限切れのセッション 5・鍵 3 と失効 3・その人が出した招待 3・再設定の token 2)
    const plain = uniqueEmail("pw");
    await seedUnproven(plain);
    const heavy = uniqueEmail("pw");
    const heavyId = await seedUnproven(heavy);
    for (let i = 0; i < 5; i++) await seedSessionRow(heavyId, now - 60_000);
    for (let i = 0; i < 3; i++) {
      const key = id();
      await env.DB.batch([
        env.DB.prepare(`insert into apikey (id, key, "userId", "createdAt", "updatedAt") values (?1, ?1, ?2, ?3, ?3)`).bind(key, heavyId, iso(now)),
        env.DB.prepare(`insert into apikey_revocations (key_id, revoked_at, revoked_by) values (?1, ?2, null)`).bind(key, now),
        env.DB.prepare(
          `insert into invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") values (?1, ?2, ?3, 'viewer', 'pending', ?4, ?5, ?6)`,
        ).bind(id(), owner.workspaceId, uniqueEmail("by-heavy"), iso(now + 86_400_000), iso(now), heavyId),
      ]);
    }
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") values (?1, ?2, ?3, ?4, ?5, ?5)`)
        .bind(id(), `reset-password:${id()}`, heavyId, iso(now + 3_600_000), iso(now))
        .run();
    }

    const record: Record<string, unknown> = {};
    for (const [label, email] of [["none", uniqueEmail("nobody")], ["match", plain], ["heavy", heavy]] as const) {
      const capture = capturingBatchMeta(env.DB, /delete from "user"/i);
      const counting = countingD1(capture.db);
      expect((await invite(owner.token, owner.workspaceId, email, "editor", { DB: counting.db })).status, label).toBe(201);
      const c = counting.counts();
      // 足す前は 15 往復(文 15・batch 0)。pending の照会が batch に入るので、文 14・batch 1 で合計は同じ
      expect({ label, trips: c.queries + c.batches, batches: c.batches }).toEqual({ label, trips: 15, batches: 1 });
      expect(c.batchSql[0]).toHaveLength(4);
      const metas = capture.metas();
      expect(metas, label).toHaveLength(1);
      record[label] = metas[0];
      expect(await usersWithEmail(email), label).toBe(0);
    }
    // 実装の記録(## Task 2)に写す数。往復が同じことだけを合格にしないため、行の数を出しておく
    console.log("b179 task 2 rows", JSON.stringify(record));
  }, TIMEOUT);
});
