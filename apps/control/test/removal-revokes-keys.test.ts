import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, inviteAndJoin, json, setupOwner } from "./helpers";

/**
 * backlog B156(security_triage_v2 の G15・G16)。
 * ① API キーで読んだ招待の一覧は id・url を返さない(招待 ID は受諾の資格そのもの。決定 55 (9) の追補)
 * ② メンバーから外す・システム管理者から外すと、その人の鍵(そのワークスペースの鍵 / フルの鍵)を同じ batch で失効させる
 *    (要求のたびの判定 = 決定 55 (6) だけだと、メンバーに戻したときに外す前の鍵が生き返る)
 */

type Key = { id: string; key: string };
const makeKey = async (token: string, workspaceId: string | null): Promise<Key> => {
  const res = await call("POST", "/me/api-keys", { token, body: { name: "k", workspaceId } });
  expect(res.status).toBe(201);
  return json<Key>(res);
};
const newWorkspace = async (token: string, name: string) => (await json<{ id: string }>(await call("POST", "/workspaces", { token, body: { name } }))).id;
const status = async (key: string) => (await call("GET", "/me", { token: key })).status;
const revocation = (kid: string) =>
  env.DB.prepare("select r.revoked_by as revokedBy, a.enabled as enabled from apikey_revocations r join apikey a on a.id = r.key_id where r.key_id = ?")
    .bind(kid)
    .first<{ revokedBy: string | null; enabled: number }>();

describe("invitation list read with an API key (B156 ①)", () => {
  it("hides id and url from a key, keeps them for a session", async () => {
    const owner = await setupOwner();
    const inv = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: "pending@example.com", role: "editor" } });
    expect(inv.status).toBe(201);
    const { id } = await json<{ id: string }>(inv);
    const key = await makeKey(owner.token, owner.workspaceId);
    type Row = { id: string | null; url: string | null; email: string; role: string | null; status: string; expiresAt: number };
    const byKey = await json<Row[]>(await call("GET", `/workspaces/${owner.workspaceId}/invitations`, { token: key.key }));
    expect(byKey).toHaveLength(1);
    expect(byKey[0]).toMatchObject({ id: null, url: null, email: "pending@example.com", role: "editor", status: "pending" });
    const bySession = await json<Row[]>(await call("GET", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token }));
    expect(bySession[0]).toMatchObject({ id, email: "pending@example.com" });
    expect(bySession[0]!.url).toMatch(new RegExp(`/invite/${id}$`));
  });
});

describe("removing a member revokes their keys for that workspace (B156 ②)", () => {
  it("a key from before the removal stays 401 after the member is invited back", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(ed.token, owner.workspaceId);
    expect(await status(k.key)).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    expect(await revocation(k.id)).toEqual({ revokedBy: owner.userId, enabled: 0 });
    // 戻す(再招待・受諾)
    await inviteAndJoin(owner.token, owner.workspaceId, "editor", ed.email);
    expect(await status(k.key)).toBe(401);
    // 管理者の「メンバーの API キー」の一覧に失効済みとして出る(戻した後は持ち主がメンバーなので見える)
    const listed = await json<Array<{ id: string; revokedAt: number | null }>>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }));
    expect(listed.find((x) => x.id === k.id)?.revokedAt).toEqual(expect.any(Number));
  });

  it("leaves the member's keys for other workspaces and other members' keys alone", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, b, "editor", ed.email);
    const other = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const inA = await makeKey(ed.token, owner.workspaceId);
    const inB = await makeKey(ed.token, b);
    const otherInA = await makeKey(other.token, owner.workspaceId);
    const ownerFull = await makeKey(owner.token, null);
    // 読めない metadata の鍵があっても外す処理は失敗しない(その鍵は元から 401。失効の対象にもしない)
    const broken = await makeKey(ed.token, owner.workspaceId);
    await env.DB.prepare("update apikey set metadata = '{broken' where id = ?").bind(broken.id).run();
    // 二重に JSON 化された metadata(Better Auth の古い保存形式)のこのワークスペースの鍵は失効させる
    const doubled = await makeKey(ed.token, owner.workspaceId);
    await env.DB.prepare("update apikey set metadata = ? where id = ?").bind(JSON.stringify(JSON.stringify({ scope: "workspace", workspaceId: owner.workspaceId })), doubled.id).run();
    expect(await status(doubled.key)).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    expect(await revocation(inA.id)).not.toBeNull();
    expect(await revocation(doubled.id)).not.toBeNull();
    expect(await revocation(broken.id)).toBeNull();
    expect(await revocation(inB.id)).toBeNull();
    expect(await status(inB.key)).toBe(200);
    expect(await revocation(otherInA.id)).toBeNull();
    expect(await status(otherInA.key)).toBe(200);
    expect(await status(ownerFull.key)).toBe(200);
  });

  it("revokes nothing when the removal is refused", async () => {
    // 外す文の条件(対象がシステム管理者でない)で 0 行になる 409 の経路。事前の判定では断らないので batch まで届く
    const owner = await setupOwner();
    const ia = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ia.email } })).status).toBe(201);
    const k = await makeKey(ia.token, owner.workspaceId);
    const res = await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ia.memberId}`, { token: owner.token });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "instance_admin_member" });
    expect(await revocation(k.id)).toBeNull();
    expect(await status(k.key)).toBe(200);
  });
});

describe("removing an instance admin revokes their full keys (B156 ②)", () => {
  it("a full key from before the removal stays 401 after the person is made an instance admin again", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    const full = await makeKey(ed.token, null);
    const inA = await makeKey(ed.token, owner.workspaceId);
    const ownerFull = await makeKey(owner.token, null);
    expect(await status(full.key)).toBe(200);
    expect((await call("DELETE", `/instance-admins/${ed.userId}`, { token: owner.token })).status).toBe(204);
    expect(await revocation(full.id)).toEqual({ revokedBy: owner.userId, enabled: 0 });
    // 元のロール(編集者)に戻ったワークスペースの鍵はそのまま使える
    expect(await revocation(inA.id)).toBeNull();
    expect(await status(inA.key)).toBe(200);
    expect(await status(ownerFull.key)).toBe(200);
    // 再び昇格させても、外す前のフルの鍵は 401 のまま
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    expect(await status(full.key)).toBe(401);
  });

  it("revokes the workspace keys of the workspaces the person leaves, not of those where the prior role comes back", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    // 昇格の後に作ったワークスペース = 昇格の前の記録が無い(外すと Member 行が消える側)
    const b = await newWorkspace(owner.token, "B");
    const inA = await makeKey(ed.token, owner.workspaceId);
    const inB = await makeKey(ed.token, b);
    const ownerInB = await makeKey(owner.token, b);
    expect(await status(inB.key)).toBe(200);
    expect((await call("DELETE", `/instance-admins/${ed.userId}`, { token: owner.token })).status).toBe(204);
    expect(await revocation(inB.id)).toEqual({ revokedBy: owner.userId, enabled: 0 });
    // 元のロールに戻ったワークスペースの鍵と、他の人の鍵は失効しない
    expect(await revocation(inA.id)).toBeNull();
    expect(await status(inA.key)).toBe(200);
    expect(await status(ownerInB.key)).toBe(200);
    // B に招待し直して受諾しても、外す前の B の鍵は 401 のまま
    await inviteAndJoin(owner.token, b, "editor", ed.email);
    expect(await status(inB.key)).toBe(401);
  });

  it("with restore=false revokes the workspace keys of every workspace", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    const inA = await makeKey(ed.token, owner.workspaceId);
    expect((await call("DELETE", `/instance-admins/${ed.userId}?restore=false`, { token: owner.token })).status).toBe(204);
    expect(await revocation(inA.id)).not.toBeNull();
    await inviteAndJoin(owner.token, owner.workspaceId, "editor", ed.email);
    expect(await status(inA.key)).toBe(401);
  });

  it("revokes nothing when the last instance admin cannot be removed", async () => {
    const owner = await setupOwner();
    const full = await makeKey(owner.token, null);
    expect((await call("DELETE", `/instance-admins/${owner.userId}`, { token: owner.token })).status).toBe(409);
    expect(await revocation(full.id)).toBeNull();
    expect(await status(full.key)).toBe(200);
  });
});
