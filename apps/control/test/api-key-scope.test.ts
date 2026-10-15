import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createSite, expectEnvelope, inviteAndJoin, json, setupOwner } from "./helpers";

/**
 * backlog B42: API キーの範囲(フル / ワークスペース)。brief = docs/superpowers/plans/2026-10-05-b41-b42-brief.md の K1〜K14。
 * フル = 全ワークスペース(システム管理者だけが発行・使える)/ ワークスペース = 指定した 1 つだけ
 */

type Created = { id: string; key: string; scope: "full" | "workspace"; workspace: { id: string; name: string | null } | null; roleCap: string | null };
const issue = (token: string, workspaceId: string | null, extra: Record<string, unknown> = {}) =>
  call("POST", "/me/api-keys", { token, body: { name: "k", workspaceId, ...extra } });
const makeKey = async (token: string, workspaceId: string | null, extra: Record<string, unknown> = {}) => {
  const res = await issue(token, workspaceId, extra);
  expect(res.status).toBe(201);
  return json<Created>(res);
};
const newWorkspace = async (token: string, name: string) => (await json<{ id: string }>(await call("POST", "/workspaces", { token, body: { name } }))).id;
const setMeta = (id: string, metadata: string | null) => env.DB.prepare("update apikey set metadata = ? where id = ?").bind(metadata, id).run();

describe("api key scope (backlog B42)", () => {
  it("a workspace key works only in its workspace and hides the others", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const siteB = await createSite(owner.token, b);
    const k = await makeKey(owner.token, owner.workspaceId);
    expect(k.scope).toBe("workspace");
    expect(k.workspace).toEqual({ id: owner.workspaceId, name: "Workspace A" });
    expect((await call("GET", `/workspaces/${owner.workspaceId}/sites`, { token: k.key })).status).toBe(200);
    // 範囲外は非メンバーと同じ 404(存在を漏らさない)
    expect((await call("GET", `/workspaces/${b}/sites`, { token: k.key })).status).toBe(404);
    expect((await call("GET", `/sites/${siteB.id}`, { token: k.key })).status).toBe(404);
    const listed = await json<Array<{ id: string; role: string }>>(await call("GET", "/workspaces", { token: k.key }));
    expect(listed.map((w) => w.id)).toEqual([owner.workspaceId]);
    expect(await json(await call("GET", "/me", { token: k.key }))).toMatchObject({ keyScope: "workspace", keyWorkspaceId: owner.workspaceId, instanceAdmin: false });
  });

  it("a workspace key of an instance admin cannot do instance admin operations", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const k = await makeKey(owner.token, owner.workspaceId);
    for (const res of [await call("GET", "/instance-admins", { token: k.key }), await call("GET", "/instance-admins/candidates", { token: k.key })]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    }
    // ワークスペースの作成・削除は、範囲に関わらず鍵では行えない(brief K17)
    for (const res of [await call("POST", "/workspaces", { token: k.key, body: { name: "C" } }), await call("DELETE", `/workspaces/${b}`, { token: k.key })]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ error: "session_required" });
    }
  });

  it("a full key is issued only by an instance admin and works everywhere", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const denied = await issue(admin.token, null);
    expect(denied.status).toBe(403);
    expect(await expectEnvelope(denied)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    const full = await makeKey(owner.token, null);
    expect(full.scope).toBe("full");
    expect(full.workspace).toBeNull();
    expect((await call("GET", `/workspaces/${b}/sites`, { token: full.key })).status).toBe(200);
    expect((await call("GET", "/instance-admins", { token: full.key })).status).toBe(200); // システム管理者としての読み取りはできる
    expect(await json(await call("GET", "/me", { token: full.key }))).toMatchObject({ keyScope: "full", keyWorkspaceId: null, instanceAdmin: true });
    // セッションは範囲を持たない
    expect(await json(await call("GET", "/me", { token: owner.token }))).toMatchObject({ keyScope: null, keyWorkspaceId: null });
  });

  it("a full key stops working once its owner is no longer an instance admin", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    const full = await makeKey(ed.token, null);
    expect((await call("GET", "/me", { token: full.key })).status).toBe(200);
    // 降格の後もどこかのメンバーに戻した状態にして、鍵の入口の判定だけで 401 になることを確かめる
    await env.DB.prepare("delete from instance_admins where user_id = ?").bind(ed.userId).run();
    const res = await call("GET", "/me", { token: full.key });
    expect(res.status).toBe(401);
    expect(await expectEnvelope(res)).toMatchObject({ error: "unauthorized" });
  });

  it("a full key may carry a role cap and is then not an instance admin", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const viewer = await makeKey(owner.token, null, { roleCap: "viewer" });
    expect((await call("GET", `/workspaces/${b}/sites`, { token: viewer.key })).status).toBe(200);
    const write = await call("POST", `/workspaces/${b}/sites`, { token: viewer.key, body: { name: "x", domain: "x.example.com" } });
    expect(write.status).toBe(403);
    expect(await json(write)).toMatchObject({ required: "admin" });
    expect((await call("GET", "/instance-admins", { token: viewer.key })).status).toBe(403);
  });

  it("issuing validates the workspace and caps against the role in that workspace", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const u = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await inviteAndJoin(owner.token, b, "viewer", u.email);
    // workspaceId は必須(省略でフルにならない)
    const missing = await call("POST", "/me/api-keys", { token: u.token, body: { name: "k" } });
    expect(missing.status).toBe(422);
    expect(await json(missing)).toMatchObject({ error: "validation_failed" });
    // メンバーでないワークスペースは 404
    const c = await newWorkspace(owner.token, "C");
    expect((await issue(u.token, c)).status).toBe(404);
    // 上限はそのワークスペースでのロール以下(A は ADMIN、B は VIEWER)
    expect((await issue(u.token, owner.workspaceId, { roleCap: "admin" })).status).toBe(201);
    const tooHigh = await issue(u.token, b, { roleCap: "editor" });
    expect(tooHigh.status).toBe(400);
    expect(await json(tooHigh)).toMatchObject({ error: "role_cap_too_high", highest: "viewer" });
    expect((await issue(u.token, b, { roleCap: "viewer" })).status).toBe(201);
  });

  it("keys without a readable scope are refused with 401", async () => {
    const owner = await setupOwner();
    const k = await makeKey(owner.token, null);
    const status = async () => (await call("GET", "/me", { token: k.key })).status;
    // 二重 JSON 化は一覧処理と同じく 1 段ほどいて読む
    await setMeta(k.id, JSON.stringify(JSON.stringify({ scope: "full" })));
    expect(await status()).toBe(200);
    for (const meta of [
      null,
      "null",
      JSON.stringify({ roleCap: "editor" }), // B42 より前の鍵
      JSON.stringify({ scope: "bogus" }),
      JSON.stringify({ scope: "workspace" }),
      JSON.stringify({ scope: "workspace", workspaceId: 5 }),
      JSON.stringify({ scope: "workspace", workspaceId: "" }),
      "[]",
      // 読めない JSON は Better Auth が鍵の検証の段階で扱う(自前の判定まで来ない)ので、ここでは並べない
    ]) {
      await setMeta(k.id, meta);
      expect(await status(), String(meta)).toBe(401);
    }
  });

  it("a workspace key is refused with 401 once its owner leaves the workspace or the workspace is deleted", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const inB = await inviteAndJoin(owner.token, b, "editor", ed.email);
    const keyB = await makeKey(ed.token, b);
    expect((await call("GET", "/me", { token: keyB.key })).status).toBe(200);
    await call("DELETE", `/workspaces/${b}/members/${inB.memberId}`, { token: owner.token });
    expect((await call("GET", "/me", { token: keyB.key })).status).toBe(401);
    // ワークスペースの削除
    const c = await newWorkspace(owner.token, "C");
    await inviteAndJoin(owner.token, c, "editor", ed.email);
    const keyC = await makeKey(ed.token, c);
    expect((await call("GET", "/me", { token: keyC.key })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${c}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: keyC.key })).status).toBe(401);
    // 自分の一覧では範囲のワークスペースが削除済み(name = null)と分かる
    const mine = await json<Created[]>(await call("GET", "/me/api-keys", { token: ed.token }));
    expect(mine.find((x) => x.id === keyC.id)?.workspace).toEqual({ id: c, name: null });
    expect(mine.find((x) => x.id === keyB.id)?.workspace).toEqual({ id: b, name: "B" });
  });

  it("the workspace key list shows this workspace's keys and instance admins' full keys only", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const both = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, b, "editor", both.email);
    const inA = await makeKey(both.token, owner.workspaceId);
    const inB = await makeKey(both.token, b);
    const full = await makeKey(owner.token, null);
    const ownerInB = await makeKey(owner.token, b);
    type Row = { id: string; scope: string; workspace: { id: string; name: string | null } | null; owner: { instanceAdmin: boolean } };
    const listA = await json<Row[]>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }));
    expect(listA.map((k) => k.id).sort()).toEqual([inA.id, full.id].sort());
    expect(listA.find((k) => k.id === full.id)).toMatchObject({ scope: "full", workspace: null, owner: { instanceAdmin: true } });
    // 他のワークスペース向けの鍵は、このワークスペースからは失効できない(404)
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${inB.id}`, { token: owner.token })).status).toBe(404);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${ownerInB.id}`, { token: owner.token })).status).toBe(404);
    // このワークスペースの鍵の失効は、B の鍵に影響しない
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${inA.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", `/workspaces/${b}/sites`, { token: inB.key })).status).toBe(200);
  });
});

/** batch の直前に fn を流す D1 ラッパ(事前の判定の後・書き込みの前に状態が変わる競合を再現する) */
function beforeBatch(db: D1Database, fn: () => Promise<unknown>): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          await fn();
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

describe("api key revocation and refusals (B42 review r1)", () => {
  it("a revoked key stays revoked even when Better Auth writes the stale row back", async () => {
    // Better Auth は鍵の検証で読み込んだ行を丸ごと書き戻す。失効とすれ違うと enabled = 1 に戻る(brief K15)
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const mine = await makeKey(ed.token, owner.workspaceId);
    const theirs = await makeKey(ed.token, owner.workspaceId);
    expect((await call("DELETE", `/me/api-keys/${mine.id}`, { token: ed.token })).status).toBe(204);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${theirs.id}`, { token: owner.token })).status).toBe(204);
    await env.DB.prepare("update apikey set enabled = 1 where id in (?, ?)").bind(mine.id, theirs.id).run(); // 書き戻しの再現
    expect((await call("GET", "/me", { token: mine.key })).status).toBe(401);
    expect((await call("GET", "/me", { token: theirs.key })).status).toBe(401);
    const listed = await json<Array<{ id: string; revokedAt: number | null }>>(await call("GET", "/me/api-keys", { token: ed.token }));
    expect(listed.filter((k) => k.revokedAt !== null).map((k) => k.id).sort()).toEqual([mine.id, theirs.id].sort());
    // 失効済みはもう一度失効できない(404)
    expect((await call("DELETE", `/me/api-keys/${mine.id}`, { token: ed.token })).status).toBe(404);
  });

  it("an admin's revocation re-checks the target's role inside the statement", async () => {
    // 事前の判定の後に対象が OWNER になったら、ADMIN は失効できない(brief K18)
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(ed.token, owner.workspaceId);
    const DB = beforeBatch(env.DB, () => env.DB.prepare(`update member set role = 'owner' where id = ?`).bind(ed.memberId).run());
    const res = await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, { token: admin.token, envOverride: { DB } });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner" });
    expect((await call("GET", "/me", { token: k.key })).status).toBe(200);
  });

  it("an admin's revocation does nothing when the target left the workspace in between", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, b, "editor", ed.email);
    const k = await makeKey(ed.token, owner.workspaceId);
    const DB = beforeBatch(env.DB, () => env.DB.prepare(`delete from member where id = ?`).bind(ed.memberId).run());
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, { token: owner.token, envOverride: { DB } })).status).toBe(404);
    expect((await env.DB.prepare("select count(*) as n from apikey_revocations where key_id = ?").bind(k.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("a key whose metadata is not valid json is refused with 401, not 500", async () => {
    const owner = await setupOwner();
    const k = await makeKey(owner.token, null);
    await setMeta(k.id, "{broken");
    const res = await call("GET", "/me", { token: k.key });
    expect(res.status).toBe(401);
    expect(await expectEnvelope(res)).toMatchObject({ error: "unauthorized" });
  });

  it("a demoted instance admin's full key leaves the workspace key list and cannot be revoked there", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    const full = await makeKey(ed.token, null);
    await env.DB.prepare("delete from instance_admins where user_id = ?").bind(ed.userId).run(); // メンバーの行は残したまま降格
    const listed = await json<Array<{ id: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }));
    expect(listed.some((x) => x.id === full.id)).toBe(false);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${full.id}`, { token: owner.token })).status).toBe(404);
  });

  it("the own key list reports scope null for a key without a scope", async () => {
    const owner = await setupOwner();
    const k = await makeKey(owner.token, owner.workspaceId);
    await setMeta(k.id, JSON.stringify({ roleCap: "editor" }));
    const listed = await json<Created[]>(await call("GET", "/me/api-keys", { token: owner.token }));
    expect(listed.find((x) => x.id === k.id)).toMatchObject({ scope: null, workspace: null });
  });

  it("migration 0009 moves revoked keys and revokes keys without a scope, leaving scoped keys alone", async () => {
    const owner = await setupOwner();
    const scoped = await makeKey(owner.token, owner.workspaceId);
    const legacy = await makeKey(owner.token, owner.workspaceId);
    const revokedBefore = await makeKey(owner.token, owner.workspaceId);
    await setMeta(legacy.id, JSON.stringify({ roleCap: "editor" }));
    const revokedAt = "2026-09-01T00:00:00.000Z";
    await env.DB.prepare("update apikey set enabled = 0, updatedAt = ? where id = ?").bind(revokedAt, revokedBefore.id).run();
    // マイグレーション前の状態に戻す(表を空にして、表の作成以外の文をもう一度流す)
    await env.DB.prepare("delete from apikey_revocations").run();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009_"))!;
    for (const q of migration.queries.filter((q) => !/^\s*CREATE TABLE/i.test(q))) await env.DB.prepare(q).run();
    const rows = (await env.DB.prepare("select key_id, revoked_at from apikey_revocations").all<{ key_id: string; revoked_at: number }>()).results;
    expect(rows.map((r) => r.key_id).sort()).toEqual([legacy.id, revokedBefore.id].sort());
    expect(rows.find((r) => r.key_id === revokedBefore.id)!.revoked_at).toBe(Date.parse(revokedAt));
    expect((await call("GET", "/me", { token: scoped.key })).status).toBe(200);
    expect((await call("GET", "/me", { token: legacy.key })).status).toBe(401);
  });
});
