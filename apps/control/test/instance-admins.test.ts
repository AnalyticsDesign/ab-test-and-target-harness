import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { grantInstanceAdmin } from "../src/instance-admins";
import { BREAK_GLASS, call, createExperiment, createSite, expectEnvelope, failingD1Insert, inviteAndJoin, json, setupOwner } from "./helpers";

/** backlog B36 / 決定 53: システム管理者(instance admin) */

const memberRole = async (wid: string, userId: string) =>
  (await env.DB.prepare(`select role from member where "organizationId" = ?1 and "userId" = ?2`).bind(wid, userId).first<{ role: string }>())?.role ?? null;

const memberRows = async (wid: string, userId: string) =>
  (await env.DB.prepare(`select count(*) as n from member where "organizationId" = ?1 and "userId" = ?2`).bind(wid, userId).first<{ n: number }>())!.n;

const instanceAdminIds = async () =>
  (await env.DB.prepare(`select user_id from instance_admins order by created_at, user_id`).all<{ user_id: string }>()).results.map((r) => r.user_id);

/** 既定はフルの鍵(setupOwner の人はシステム管理者なので発行できる)。システム管理者でない人の鍵は workspaceId を渡す */
const makeKey = async (token: string, roleCap?: string, workspaceId: string | null = null) =>
  (await json<{ key: string }>(await call("POST", "/me/api-keys", { token, body: { name: "k", workspaceId, ...(roleCap ? { roleCap } : {}) } }))).key;

const promote = (token: string, email: string) => call("POST", "/instance-admins", { token, body: { email } });
const demote = (token: string, userId: string) => call("DELETE", `/instance-admins/${userId}`, { token });
const memberCount = async (userId: string) =>
  (await env.DB.prepare(`select count(*) as n from member where "userId" = ?1`).bind(userId).first<{ n: number }>())!.n;
/** B46: 昇格前のロールの記録の数 */
const priorRoleCount = async (userId: string) =>
  (await env.DB.prepare(`select count(*) as n from instance_admin_prior_roles where user_id = ?1`).bind(userId).first<{ n: number }>())!.n;
const memberIdOf = async (wid: string, userId: string) =>
  (await env.DB.prepare(`select id from member where "organizationId" = ?1 and "userId" = ?2`).bind(wid, userId).first<{ id: string }>())!.id;
/** パスワード再設定の未使用の token の数(Better Auth は identifier = reset-password:<token>、value = user ID で保存する) */
const resetTokens = async (userId: string) =>
  (await env.DB.prepare(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?1`).bind(userId).first<{ n: number }>())!.n;
/**
 * pattern に合う select を、先頭から times 回だけ「0 行」にする D1 ラッパ(事前の判定だけを外して、競合で事前の判定を抜けた状態を作る)。
 * kysely-d1 は prepare().bind().all() の順に呼ぶ。2 回目以降は本物の DB に通す。
 * 戻り値の fired() は「0 行にした文の数」。競合のテストはこれを確かめて、外す対象が空振りしたまま通る(見かけだけ緑)のを防ぐ
 */
const blankFirstSelects = (db: D1Database, pattern: RegExp, times = 1): { db: D1Database; fired: () => number } => {
  let left = times;
  let blanked = 0;
  const empty = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(st, p) {
        if (p === "all") return async () => ({ results: [], success: true, meta: {} });
        if (p === "first") return async () => null;
        if (p === "raw") return async () => [];
        if (p === "bind") return (...args: unknown[]) => empty(st.bind(...args));
        const x = Reflect.get(st, p);
        return typeof x === "function" ? x.bind(st) : x;
      },
    });
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sqlText: string) => {
          if (left > 0 && pattern.test(sqlText)) {
            left--;
            blanked++;
            return empty(target.prepare(sqlText));
          }
          return target.prepare(sqlText);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: proxied, fired: () => blanked };
};
/** システム管理者の居ないワークスペースを SQL で作る(不変条件が崩れた状態での守りを確かめる) */
const rawWorkspace = async (id: string, owners: string[]) => {
  const now = new Date().toISOString();
  await env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values (?1, ?1, ?2, ?3)`).bind(id, `ws-${id}`, now).run();
  for (const userId of owners) {
    await env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'owner', ?4)`).bind(`m-${id}-${userId}`, id, userId, now).run();
  }
};

/** 修復 SQL(scripts/instance-admins-repair.sql)を文ごとに流す。ファイルの中のコメントに `;` を書かない約束 */
const runRepairSql = async () => {
  for (const stmt of env.TEST_REPAIR_SQL.split(";").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
};

describe("instance admin (B36)", () => {
  it("setup registers the first owner as an instance admin", async () => {
    const owner = await setupOwner();
    expect(await instanceAdminIds()).toEqual([owner.userId]);
    expect(await memberRole(owner.workspaceId, owner.userId)).toBe("owner");
    expect(await memberRows(owner.workspaceId, owner.userId)).toBe(1);
  });

  it("the instance admin list carries the roles to restore (B46 K6)", async () => {
    const owner = await setupOwner(); // owner.workspaceId が先に作られる
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    // 参加の順はワークスペースの作成順と逆にする(Second に先に参加し、後から owner.workspaceId に参加)
    const ed = await inviteAndJoin(owner.token, second, "viewer");
    await inviteAndJoin(owner.token, owner.workspaceId, "editor", ed.email);
    await promote(owner.token, ed.email);
    const list = await json<Array<{ userId: string; priorRoles: Array<{ workspaceId: string; workspaceName: string; role: string }> }>>(
      await call("GET", "/instance-admins", { token: owner.token }),
    );
    expect(list.find((a) => a.userId === owner.userId)?.priorRoles).toEqual([]); // 記録の無い最初の人
    const wsName = (await env.DB.prepare(`select name from organization where id = ?1`).bind(owner.workspaceId).first<{ name: string }>())!.name;
    // ワークスペースの作成順(参加順ではない)
    expect(list.find((a) => a.userId === ed.userId)?.priorRoles).toEqual([
      { workspaceId: owner.workspaceId, workspaceName: wsName, role: "editor" },
      { workspaceId: second, workspaceName: "Second", role: "viewer" },
    ]);
  });

  it("restore accepts only true or false (B46 K11)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    const res = await call("DELETE", `/instance-admins/${ed.userId}?restore=no`, { token: owner.token });
    // この API の validation_failed は 422(既存の POST /instance-admins と同じ)
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({ error: "validation_failed" });
    // 何も変わらない
    expect(await instanceAdminIds()).toEqual([owner.userId, ed.userId]);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner");
    expect(await priorRoleCount(ed.userId)).toBe(1);
  });

  it("demotion with restore false removes every membership even with a record (B46 K11)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    expect((await call("DELETE", `/instance-admins/${ed.userId}?restore=false`, { token: owner.token })).status).toBe(204);
    expect(await memberCount(ed.userId)).toBe(0); // 記録があっても元のロールに戻さない
    expect(await priorRoleCount(ed.userId)).toBe(0); // 記録も消える
    // 戻るワークスペースも招待も無いので、ログイン状態が切れる
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(401);
  });

  it("workspace_creation_requires_instance_admin", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    // ワークスペースの管理者でも、システム管理者でなければ作れない
    const refused = await call("POST", "/workspaces", { token: admin.token, body: { name: "Mine" } });
    expect(refused.status).toBe(403);
    const body = await json<{ error: string; required: string; message: string }>(refused);
    expect(body).toMatchObject({ error: "forbidden", required: "instance_admin" });
    expect(body.message).toContain("システム管理者");
    const created = await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } });
    expect(created.status).toBe(201);
  });

  it("a new workspace gets exactly one owner row for every instance admin", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    // 2 人目のシステム管理者を直接登録する(昇格の API は Task 2)。不変条件を手で作る
    await env.DB.prepare(`insert into instance_admins (user_id, granted_by, created_at) values (?1, null, ?2)`).bind(ed.userId, Date.now()).run();
    await env.DB.prepare(`update member set role = 'owner' where "userId" = ?1`).bind(ed.userId).run();
    const { id } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    expect(await memberRole(id, owner.userId)).toBe("owner");
    expect(await memberRole(id, ed.userId)).toBe("owner");
    expect(await memberRows(id, owner.userId)).toBe(1); // 作成者の行も 1 行だけ
    // GET /workspaces は Member 行から作るので、もう 1 人のシステム管理者にも新しいワークスペースが見える
    const list = await json<Array<{ id: string; name: string; role: string }>>(await call("GET", "/workspaces", { token: ed.token }));
    expect(list.find((w) => w.id === id)).toMatchObject({ name: "Second", role: "owner" });
  });

  it("workspace creation is all or nothing", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/workspaces", {
      token: owner.token,
      body: { name: "Broken" },
      envOverride: { DB: failingD1Insert(env.DB, "member") },
    });
    expect(res.status).toBe(500);
    expect(await json(res)).toMatchObject({ error: "workspace_create_failed" });
    const names = (await env.DB.prepare(`select name from organization`).all<{ name: string }>()).results.map((r) => r.name);
    expect(names).not.toContain("Broken");
  });

  it("capped api keys are not treated as instance admin", async () => {
    const owner = await setupOwner();
    // backlog B42: ワークスペースの作成は鍵では行えない(brief K17)ので、システム管理者の読み取り(一覧)で確かめる
    const capped = await makeKey(owner.token, "admin");
    const byCapped = await call("GET", "/instance-admins", { token: capped });
    expect(byCapped.status).toBe(403);
    expect(await json(byCapped)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    const full = await makeKey(owner.token);
    expect((await call("GET", "/instance-admins", { token: full })).status).toBe(200);
  });

  it("concurrent workspace deletions leave one workspace", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const [a, b] = await Promise.all([
      call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token }),
      call("DELETE", `/workspaces/${second}`, { token: owner.token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const left = (await env.DB.prepare(`select id from organization`).all<{ id: string }>()).results;
    expect(left).toHaveLength(1);
    expect(await memberRole(left[0]!.id, owner.userId)).toBe("owner"); // システム管理者は残ったワークスペースのオーナーのまま
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(200);
  });

  it("repair sql restores the invariant after an old control wrote without it", async () => {
    // 更新の切り替え中に古い control が書いた状態を再現する: システム管理者の居ないワークスペースと、下げられた行
    const owner = await setupOwner();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w-old', 'Old', 'ws-old', ?1)`).bind(now),
      env.DB.prepare(`update member set role = 'viewer' where "userId" = ?1 and "organizationId" = ?2`).bind(owner.userId, owner.workspaceId),
    ]);
    await runRepairSql();
    await runRepairSql(); // 冪等
    expect(await memberRole("w-old", owner.userId)).toBe("owner");
    expect(await memberRole(owner.workspaceId, owner.userId)).toBe("owner");
    expect(await memberRows("w-old", owner.userId)).toBe(1);
  });

  it("workspace deletion is for instance admins only and refuses running experiments", async () => {
    // 決定 53 (12)(13): 削除はシステム管理者だけ。配下のサイトに実行中のエクスペリエンスがあれば 409
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const wsOwner = await inviteAndJoin(owner.token, second, "admin");
    await call("PATCH", `/workspaces/${second}/members/${wsOwner.memberId}`, { token: owner.token, body: { role: "owner" } });
    const byOwner = await call("DELETE", `/workspaces/${second}`, { token: wsOwner.token });
    expect(byOwner.status).toBe(403); // ワークスペースのオーナーでも、システム管理者でなければ消せない
    expect(await json(byOwner)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    expect((await call("DELETE", "/workspaces/no-such-workspace", { token: owner.token })).status).toBe(404);
    const site = await createSite(owner.token, second, { id: "site_run", domain: "run.example.com" });
    await createExperiment(owner.token, site.id, { id: "exp_run" });
    await env.DB.prepare(`update experiments set status = 'running' where site_id = ?1`).bind(site.id).run();
    const running = await call("DELETE", `/workspaces/${second}`, { token: owner.token });
    expect(running.status).toBe(409);
    expect(await json(running)).toMatchObject({ error: "workspace_has_running_experiments", siteId: site.id, experimentId: "exp_run" });
    // 公開済みの状態だけが running でも止める(Stop の Publish が失敗して配信中のまま、を守る)
    await env.DB.prepare(`update experiments set status = 'archived', published_status = 'running' where site_id = ?1`).bind(site.id).run();
    expect((await call("DELETE", `/workspaces/${second}`, { token: owner.token })).status).toBe(409);
    await env.DB.prepare(`update experiments set published_status = 'archived' where site_id = ?1`).bind(site.id).run();
    expect((await call("DELETE", `/workspaces/${second}`, { token: owner.token })).status).toBe(204);
  });

  it("migration backfills the first workspace owners and the invariant", async () => {
    // 既存の導入を再現する: このマイグレーションより前までを当て、ワークスペース 3 つを SQL で作ってから残りを当てる
    const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_instance_admins.sql"))!.name;
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
    const [t1, t2, t3] = ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "2026-09-03T00:00:00.000Z"];
    await env.DB.batch([
      env.DB.prepare(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('u1','A','a@example.com',1,?1,?1), ('u2','B','b@example.com',1,?1,?1), ('u3','C','c@example.com',1,?1,?1)`,
      ).bind(t1),
      env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1','First','ws-1',?1), ('w2','Second','ws-2',?2), ('w3','Third','ws-3',?3)`).bind(t1, t2, t3),
      // u1 = w1 の OWNER・w2 の ADMIN・w3 には行なし。u2 = w2 の OWNER。u3 = w3 に重複した行(VIEWER と EDITOR)
      env.DB.prepare(
        `insert into member (id, "organizationId", "userId", role, "createdAt") values
         ('m1','w1','u1','owner',?1), ('m2','w2','u1','admin',?2), ('m3','w2','u2','owner',?2), ('m4','w3','u3','viewer',?3), ('m5','w3','u3','editor',?3)`,
      ).bind(t1, t2, t3),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await instanceAdminIds()).toEqual(["u1"]); // 最初のワークスペースの OWNER だけ
    expect(await memberRole("w2", "u1")).toBe("owner"); // ADMIN だった行は OWNER に上がる
    expect(await memberRole("w3", "u1")).toBe("owner"); // 行の無かったワークスペースには足される
    expect(await memberRole("w1", "u2")).toBeNull(); // ほかの人の行は増えない
    expect(await memberRole("w2", "u2")).toBe("owner");
    expect(await memberRows("w3", "u3")).toBe(1); // 重複は 1 行に
    expect(await memberRole("w3", "u3")).toBe("editor"); // Role の高い方が残る
  });

  it("promotes an existing user by email into every workspace as owner and cancels their pending invitations", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    const res = await promote(owner.token, ed.email.toUpperCase()); // メールは大文字小文字を問わない
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ userId: ed.userId });
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner"); // EDITOR だった行は OWNER に上がる
    expect(await memberRole(second, ed.userId)).toBe("owner"); // 行の無かったワークスペースにも入る
    const status = await env.DB.prepare(`select status from invitation where id = ?1`).bind(inv.id).first<{ status: string }>();
    expect(status?.status).toBe("canceled"); // 残っていた招待は取り消される
    expect((await promote(owner.token, ed.email)).status).toBe(200); // 再実行は 200
    const list = await json<Array<{ userId: string }>>(await call("GET", "/instance-admins", { token: owner.token }));
    expect(list.map((a) => a.userId)).toEqual([owner.userId, ed.userId]);
  });

  it("accepting an invitation after promotion keeps a single owner row", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    await promote(owner.token, ed.email);
    // 取り消された招待は使えない
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: ed.token })).status).toBe(410);
    // 取り消しと受諾がすれ違った場合を再現する(pending に戻す)→ 既にメンバーなので 409 で、行は増えない
    await env.DB.prepare(`update invitation set status = 'pending' where id = ?1`).bind(inv.id).run();
    const accepted = await call("POST", `/invitations/${inv.id}/accept`, { token: ed.token });
    expect(accepted.status).toBe(409);
    expect(await expectEnvelope(accepted)).toMatchObject({ error: "already_member" });
    expect(await memberRows(second, ed.userId)).toBe(1);
    expect(await memberRole(second, ed.userId)).toBe("owner");
  });

  it("refuses unknown users, non instance admins, capped keys and keys for promotion", async () => {
    const owner = await setupOwner();
    const unknown = await promote(owner.token, "nobody@example.com");
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: "user_not_found" });
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("GET", "/instance-admins", { token: admin.token })).status).toBe(403);
    expect((await promote(admin.token, admin.email)).status).toBe(403); // 自分を昇格させる経路は無い
    expect((await demote(admin.token, owner.userId)).status).toBe(403);
    // 上限付きの鍵はシステム管理者として扱わない(K1)
    const capped = await makeKey(owner.token, "admin");
    const listByCapped = await call("GET", "/instance-admins", { token: capped });
    expect(listByCapped.status).toBe(403);
    expect(await json(listByCapped)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    // 昇格・降格は鍵の種類に関わらず、鍵では 403 session_required(brief K17。検証・認可より前)
    for (const res of [await promote(capped, admin.email), await demote(capped, owner.userId)]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ error: "session_required" });
    }
    // 上限なしの鍵: 一覧は読めるが、昇格・降格はセッションのみ(決定 53 (10))
    const full = await makeKey(owner.token);
    expect((await call("GET", "/instance-admins", { token: full })).status).toBe(200);
    const byKey = await promote(full, admin.email);
    expect(byKey.status).toBe(403);
    expect(await json(byKey)).toMatchObject({ error: "session_required", hint: "システム管理者の追加・外すはセッション(管理画面)からのみ行えます" });
    const demoteByKey = await demote(full, owner.userId);
    expect(demoteByKey.status).toBe(403);
    expect(await json(demoteByKey)).toMatchObject({ error: "session_required", hint: "システム管理者の追加・外すはセッション(管理画面)からのみ行えます" });
    expect(await instanceAdminIds()).toEqual([owner.userId]);
  });

  it("demotion restores the roles held before promotion and removes the rest (B46)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    await promote(owner.token, ed.email);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner");
    expect(await memberRole(second, ed.userId)).toBe("owner");
    // システム管理者でいる間に作られたワークスペースも、昇格前には無かった行として扱う
    const { id: third } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Third" } }));
    expect(await memberRole(third, ed.userId)).toBe("owner");
    expect((await demote(owner.token, ed.userId)).status).toBe(204);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor"); // 昇格前のロールに戻る
    expect(await memberRole(second, ed.userId)).toBeNull(); // 昇格で足した行は消える
    expect(await memberRole(third, ed.userId)).toBeNull();
    expect(await priorRoleCount(ed.userId)).toBe(0); // 記録も消える
    expect(await instanceAdminIds()).toEqual([owner.userId]);
    // 元のワークスペースのメンバーのままなので、ログイン状態は残る
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(200);
  });

  it("demoting an admin without a record removes every membership and cuts the session (B46 K4)", async () => {
    const owner = await setupOwner(); // /setup で作った人 = 昇格前の記録が無い
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    expect((await demote(ed.token, owner.userId)).status).toBe(204);
    expect(await memberCount(owner.userId)).toBe(0);
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(401);
  });

  it("last_instance_admin_cannot_be_demoted", async () => {
    const owner = await setupOwner();
    const res = await demote(owner.token, owner.userId);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "last_instance_admin" });
    expect(await instanceAdminIds()).toEqual([owner.userId]);
    expect(await memberRole(owner.workspaceId, owner.userId)).toBe("owner"); // Member 行も残る
    // 2 人いれば自分の降格もできる
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    expect((await demote(owner.token, owner.userId)).status).toBe(204);
    expect(await instanceAdminIds()).toEqual([ed.userId]);
  });

  it("concurrent demotions never leave zero instance admins", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const [a, b] = await Promise.all([demote(owner.token, ed.userId), demote(ed.token, owner.userId)]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const left = await instanceAdminIds();
    expect(left).toHaveLength(1);
    // 残った人は全ワークスペースのオーナーのまま
    expect(await memberRole(owner.workspaceId, left[0]!)).toBe("owner");
    expect(await memberRole(second, left[0]!)).toBe("owner");
  });

  it("an owner before promotion stays owner after demotion (B46)", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ad = await inviteAndJoin(owner.token, second, "admin"); // inviteAndJoin は owner を受けないので、管理者で招いてからオーナーにする
    await call("PATCH", `/workspaces/${second}/members/${ad.memberId}`, { token: owner.token, body: { role: "owner" } });
    expect(await memberRole(second, ad.userId)).toBe("owner");
    await promote(owner.token, ad.email);
    expect((await demote(owner.token, ad.userId)).status).toBe(204);
    expect(await memberRole(second, ad.userId)).toBe("owner"); // 既にオーナーだった行も記録して戻す
    expect(await memberRole(owner.workspaceId, ad.userId)).toBeNull();
  });

  it("re-promoting keeps the recorded roles (B46 Review Focus 1)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await promote(owner.token, ed.email)).status).toBe(201);
    expect((await promote(owner.token, ed.email)).status).toBe(200); // 既にシステム管理者 = 記録し直さない
    await demote(owner.token, ed.userId);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor");
  });

  it("concurrent promotions record the role before promotion (B46 Review Focus 2)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const results = await Promise.all([promote(owner.token, ed.email), promote(owner.token, ed.email)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const rows = await env.DB.prepare(`select organization_id, role from instance_admin_prior_roles where user_id = ?1`).bind(ed.userId).all<{ organization_id: string; role: string }>();
    expect(rows.results).toEqual([{ organization_id: owner.workspaceId, role: "viewer" }]);
  });

  it("deleting a workspace drops its record and demotion still works (B46 Review Focus 3)", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ed = await inviteAndJoin(owner.token, second, "editor");
    await inviteAndJoin(owner.token, owner.workspaceId, "viewer", ed.email); // 同じ人が 1 つ目のワークスペースにも閲覧者で参加(第 4 引数 = メール)
    await promote(owner.token, ed.email);
    expect((await call("DELETE", `/workspaces/${second}`, { token: owner.token })).status).toBe(204);
    expect(await priorRoleCount(ed.userId)).toBe(1); // 削除したワークスペースの記録は消える(CASCADE)
    expect((await demote(owner.token, ed.userId)).status).toBe(204);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("viewer");
    expect(await priorRoleCount(ed.userId)).toBe(0);
  });

  it("last admin refusal leaves the record and memberships untouched (B46 Review Focus 4)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    expect((await demote(ed.token, owner.userId)).status).toBe(204); // 記録の無い 1 人目を外す → ed が最後の 1 人
    const res = await demote(ed.token, ed.userId);
    expect(res.status).toBe(409);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner"); // 戻していない
    expect(await priorRoleCount(ed.userId)).toBe(1); // 記録も残る
  });

  it("self demotion keeps the session when a membership is restored (B46 Review Focus 5)", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    expect((await demote(ed.token, ed.userId)).status).toBe(204); // 2 人いるので自分を外せる
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(200);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor");
  });

  it("demotion restores every workspace joined before promotion (B46)", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, second, "viewer", ed.email); // 同じ人が Second にも閲覧者で参加
    const { id: third } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Third" } })); // ed は参加しない
    await promote(owner.token, ed.email);
    expect((await demote(owner.token, ed.userId)).status).toBe(204);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor");
    expect(await memberRole(second, ed.userId)).toBe("viewer");
    expect(await memberRole(third, ed.userId)).toBeNull();
  });

  it("stale records from an earlier demotion do not survive a new promotion (B46)", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    // コードだけの巻き戻しで古い control が外した後の状態 = システム管理者でないのに記録が残っている
    await env.DB.prepare(`insert into instance_admin_prior_roles (user_id, organization_id, role, granted_at) values (?1, ?2, 'editor', 1)`).bind(ed.userId, second).run();
    await promote(owner.token, ed.email);
    expect((await demote(owner.token, ed.userId)).status).toBe(204);
    expect(await memberRole(second, ed.userId)).toBeNull(); // 残っていた記録では戻さない(昇格で作り直す)
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor");
  });

  it("a record from an earlier promotion is ignored after a rollback round trip (B46 final review)", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await promote(owner.token, ed.email)).status).toBe(201); // 記録 = owner.workspaceId / editor、granted_at = この昇格の時刻
    expect(await priorRoleCount(ed.userId)).toBe(1);
    // コードだけの巻き戻しを挟んだ状態 = 古い control が外し(記録は残る)、昇格し直した(記録は書かない)。
    // 今の昇格の時刻が変わり、記録の granted_at は最初の昇格のまま残る
    await env.DB.prepare(`update instance_admins set created_at = created_at + 1000 where user_id = ?1`).bind(ed.userId).run();
    const list = await json<Array<{ userId: string; priorRoles: unknown[] }>>(await call("GET", "/instance-admins", { token: owner.token }));
    expect(list.find((a) => a.userId === ed.userId)?.priorRoles).toEqual([]); // 古い記録は「戻る先」に出さない
    expect((await demote(owner.token, ed.userId)).status).toBe(204);
    expect(await memberCount(ed.userId)).toBe(0); // 古い記録では戻さない = どのワークスペースにも残らない
    expect(await memberRole(second, ed.userId)).toBeNull();
    expect(await priorRoleCount(ed.userId)).toBe(0); // 古い記録も一緒に消える
  });

  it("demoting a non instance admin is 404 and keeps their memberships", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await demote(owner.token, ed.userId);
    expect(res.status).toBe(404);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("editor");
  });

  it("me reports instanceAdmin and capped keys report false", async () => {
    const owner = await setupOwner();
    expect(await json(await call("GET", "/me", { token: owner.token }))).toMatchObject({ instanceAdmin: true });
    expect(await json(await call("GET", "/me", { token: await makeKey(owner.token, "admin") }))).toMatchObject({ instanceAdmin: false });
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect(await json(await call("GET", "/me", { token: ed.token }))).toMatchObject({ instanceAdmin: false });
  });

  it("workspace members mark instance admins and refuse touching them from the workspace", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    const members = await json<Array<{ memberId: string; userId: string; instanceAdmin: boolean }>>(
      await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }),
    );
    const edRow = members.find((m) => m.userId === ed.userId)!;
    expect(edRow.instanceAdmin).toBe(true);
    const patch = await call("PATCH", `/workspaces/${owner.workspaceId}/members/${edRow.memberId}`, { token: owner.token, body: { role: "viewer" } });
    expect(patch.status).toBe(409);
    expect(await json(patch)).toMatchObject({ error: "instance_admin_member" });
    const del = await call("DELETE", `/workspaces/${owner.workspaceId}/members/${edRow.memberId}`, { token: owner.token });
    expect(del.status).toBe(409);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner");
  });

  it("workspace owners cannot reach instance admins through reset links or key revocation", async () => {
    // 決定 53 (9): システム管理者でないワークスペースのオーナーは、システム管理者のリセットリンクを発行できず、鍵も失効できない
    const owner = await setupOwner();
    const wsOwner = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await call("PATCH", `/workspaces/${owner.workspaceId}/members/${wsOwner.memberId}`, { token: owner.token, body: { role: "owner" } });
    const ownerMemberId = await memberIdOf(owner.workspaceId, owner.userId);
    const reset = await call("POST", `/workspaces/${owner.workspaceId}/members/${ownerMemberId}/reset-link`, { token: wsOwner.token, envOverride: BREAK_GLASS });
    expect(reset.status).toBe(403);
    expect(await json(reset)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    const kres = await json<{ id: string; key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "admin-agent", workspaceId: null } }));
    const revoke = await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${kres.id}`, { token: wsOwner.token });
    expect(revoke.status).toBe(403);
    expect((await call("GET", "/me", { token: kres.key })).status).toBe(200); // 鍵は生きている
    // 鍵の一覧には出る(漏れたときに気づけるように)
    const listed = await json<Array<{ id: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: wsOwner.token }));
    expect(listed.some((k) => k.id === kres.id)).toBe(true);
    // システム管理者どうしなら発行できる(回帰)
    const resetByAdmin = await call("POST", `/workspaces/${owner.workspaceId}/members/${wsOwner.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS });
    expect(resetByAdmin.status).toBe(200);
  });

  it("member role changes racing with a promotion still protect the new instance admin", async () => {
    // CX-High-1: 事前チェックは置かず(0 行のときの区別だけ)、文そのものの条件で守る。したがってこの 409 は文の条件だけが出す
    // (文の条件を外すと PATCH は 200・DELETE は 204 になる)。PATCH と DELETE を同時に送っても、どちらも行を変えない
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await promote(owner.token, ed.email);
    const edMemberId = await memberIdOf(owner.workspaceId, ed.userId);
    const [patch, del] = await Promise.all([
      call("PATCH", `/workspaces/${owner.workspaceId}/members/${edMemberId}`, { token: owner.token, body: { role: "viewer" } }),
      call("DELETE", `/workspaces/${owner.workspaceId}/members/${edMemberId}`, { token: owner.token }),
    ]);
    expect([patch.status, del.status]).toEqual([409, 409]);
    expect(await memberRole(owner.workspaceId, ed.userId)).toBe("owner");
  });

  it("promotion invalidates reset links issued before it", async () => {
    // r2 CX-High-6 / K2 (e): 昇格の前にシステム管理者でない人が発行したリセットリンクは、昇格で使えなくなる
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const issued = await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS });
    expect(issued.status).toBe(200);
    expect(await resetTokens(ed.userId)).toBeGreaterThan(0);
    await promote(owner.token, ed.email);
    expect(await resetTokens(ed.userId)).toBe(0);
  });

  it("reset links and key revocation stay blocked when the pre-check misses a promotion", async () => {
    // r2 CX-High-6: 事前の判定(isInstanceAdmin の最初の 1 回)を外して「判定の後に対象が昇格した」状態を作る。
    // リセットリンクは発行の直後の読み直しで token を消して 403、鍵の失効は UPDATE の文の条件で止まる
    const owner = await setupOwner();
    const wsOwner = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await call("PATCH", `/workspaces/${owner.workspaceId}/members/${wsOwner.memberId}`, { token: owner.token, body: { role: "owner" } });
    const ownerMemberId = await memberIdOf(owner.workspaceId, owner.userId);
    const firstCheck = /^select "user_id" from "instance_admins"/i;
    const resetBlank = blankFirstSelects(env.DB, firstCheck);
    const reset = await call("POST", `/workspaces/${owner.workspaceId}/members/${ownerMemberId}/reset-link`, {
      token: wsOwner.token,
      envOverride: { ...BREAK_GLASS, DB: resetBlank.db },
    });
    expect(reset.status).toBe(403);
    expect(resetBlank.fired()).toBe(1); // 事前の判定を実際に外せた(外せていないと、事前の判定で止まっただけでも緑になる)
    expect(await resetTokens(owner.userId)).toBe(0); // 発行した token は消えている
    const k = await json<{ id: string; key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "admin-agent", workspaceId: null } }));
    const revokeBlank = blankFirstSelects(env.DB, firstCheck);
    const revoke = await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, {
      token: wsOwner.token,
      envOverride: { DB: revokeBlank.db },
    });
    expect(revoke.status).toBe(403);
    expect(revokeBlank.fired()).toBe(1);
    expect((await call("GET", "/me", { token: k.key })).status).toBe(200); // 鍵は生きている
  });

  it("an acceptance that slips past the membership check still answers 409 and keeps one owner row", async () => {
    // r2 CX-High-3 / K16: 受諾の事前チェック(既にメンバーか)を外し、Better Auth の Member の INSERT を UNIQUE 索引に当てる
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    await promote(owner.token, ed.email);
    await env.DB.prepare(`update invitation set status = 'pending' where id = ?1`).bind(inv.id).run();
    const blank = blankFirstSelects(env.DB, /^select "id" from "member" where "organizationId"/i);
    const res = await call("POST", `/invitations/${inv.id}/accept`, {
      token: ed.token,
      envOverride: { DB: blank.db },
    });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "already_member" });
    expect(blank.fired()).toBe(1); // 事前チェックを実際に外せた
    // Better Auth の受諾が実際に走った(= 409 は UNIQUE 索引の経路から来た)ときだけ、招待は accepted になる
    expect((await env.DB.prepare(`select status from invitation where id = ?1`).bind(inv.id).first<{ status: string }>())?.status).toBe("accepted");
    expect(await memberRows(second, ed.userId)).toBe(1);
    expect(await memberRole(second, ed.userId)).toBe("owner");
  });

  it("inviting an existing member (a system administrator included) answers 409 already_member and creates no invitation", async () => {
    // 最終レビュー Important 1: システム管理者はすべてのワークスペースのメンバーなので、そのメールへの招待は日常的に起こる。
    // Better Auth の createInvitation が投げる BAD_REQUEST(USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION)を 500 にしない
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const before = (await env.DB.prepare(`select count(*) as n from invitation where "organizationId" = ?1`).bind(owner.workspaceId).first<{ n: number }>())!.n;
    const res = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: admin.token, body: { email: owner.email, role: "viewer" } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "already_member" });
    const after = (await env.DB.prepare(`select count(*) as n from invitation where "organizationId" = ?1`).bind(owner.workspaceId).first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });
});

/** backlog B41: システム管理者まわりの後追い修正(B36 の穴) */
describe("instance admin follow-ups (B41)", () => {
  it("promotion refuses a user who is no longer a member of any workspace", async () => {
    // B20 の後も user 行は残るので、メンバーから外した人をメールで指定すると昇格できてしまっていた(決定 53 (3) の抜け)
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    const res = await promote(owner.token, ed.email);
    expect(res.status).toBe(404);
    expect(await expectEnvelope(res)).toMatchObject({ error: "user_not_found" });
    expect(await instanceAdminIds()).toEqual([owner.userId]);
    expect(await memberCount(ed.userId)).toBe(0); // ワークスペースへの行も足されない
  });

  it("promotion checks membership in the statement itself, not only before it", async () => {
    // 事前の確認の後・書き込みの batch の直前にメンバーから外された場合を再現する(差分レビュー r1 の CX-L7)。
    // 「先に select で確かめてから無条件に書く」実装なら、ここで登録・行の追加・招待の取り消しが起きてしまう
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await target.prepare(`delete from member where "userId" = ?`).bind(ed.userId).run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    expect(await grantInstanceAdmin({ ...env, DB }, ed.userId, owner.userId, { requireMember: true })).toBe("not_member");
    expect(await instanceAdminIds()).toEqual([owner.userId]);
    expect(await memberCount(ed.userId)).toBe(0); // どのワークスペースにも行を足さない
    const status = await env.DB.prepare(`select status from invitation where id = ?1`).bind(inv.id).first<{ status: string }>();
    expect(status?.status).toBe("pending"); // 招待も取り消さない
  });

  it("candidates list members who are not instance admins with their workspaces and roles", async () => {
    const owner = await setupOwner();
    const { id: second } = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, second, "viewer", ed.email);
    const removed = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    await call("DELETE", `/workspaces/${owner.workspaceId}/members/${removed.memberId}`, { token: owner.token });
    const res = await call("GET", "/instance-admins/candidates", { token: owner.token });
    expect(res.status).toBe(200);
    const list = await json<Array<{ userId: string; email: string; name: string; workspaces: Array<{ id: string; name: string; role: string }> }>>(res);
    // システム管理者自身・どこのメンバーでもない人は出ない
    expect(list.map((c) => c.userId)).toEqual([ed.userId]);
    expect(list[0]!.email).toBe(ed.email);
    expect(list[0]!.workspaces).toEqual([
      { id: owner.workspaceId, name: "Workspace A", role: "editor" },
      { id: second, name: "Second", role: "viewer" },
    ]);
  });

  it("candidates are for instance admins only and not for capped keys", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("GET", "/instance-admins/candidates", { token: admin.token })).status).toBe(403);
    const capped = await call("GET", "/instance-admins/candidates", { token: await makeKey(owner.token, "admin") });
    expect(capped.status).toBe(403);
    expect(await json(capped)).toMatchObject({ error: "forbidden", required: "instance_admin" });
  });

  it("workspace api key list marks keys whose owner is an instance admin", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await makeKey(owner.token);
    await makeKey(ed.token, undefined, owner.workspaceId);
    const list = await json<Array<{ owner: { userId: string; instanceAdmin: boolean } }>>(
      await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }),
    );
    expect(list.find((k) => k.owner.userId === owner.userId)?.owner.instanceAdmin).toBe(true);
    expect(list.find((k) => k.owner.userId === ed.userId)?.owner.instanceAdmin).toBe(false);
  });
});
