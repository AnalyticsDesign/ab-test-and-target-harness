import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, json, setupOwner, inviteAndJoin } from "./helpers";

type WsKey = { id: string; name: string; roleCap: string | null; revokedAt: number | null; owner: { userId: string; email: string; name: string; role: string } };
/** backlog B42: 鍵は範囲を持つ。workspaceId = null はフル(システム管理者だけ) */
const makeKey = async (token: string, name: string, workspaceId: string | null, roleCap?: string) =>
  json<{ id: string; key: string }>(await call("POST", "/me/api-keys", { token, body: { name, workspaceId, ...(roleCap ? { roleCap } : {}) } }));
const listWs = async (token: string, wid: string) => json<WsKey[]>(await call("GET", `/workspaces/${wid}/api-keys`, { token }));

/** backlog B33 / 決定 48 (8): 管理者が Workspace の Member の鍵を所有者付きで一覧し、失効させられる */
describe("workspace api keys for admins (backlog B33, decision 48)", () => {
  it("admin_lists_every_members_keys_with_owner_and_cap_and_others_are_403_or_404", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await makeKey(owner.token, "owner-key", null, "admin");
    await makeKey(editor.token, "editor-key", owner.workspaceId);
    const listed = await listWs(owner.token, owner.workspaceId);
    expect(listed.map((k) => [k.name, k.owner.email, k.owner.role, k.roleCap])).toEqual(
      expect.arrayContaining([
        ["owner-key", owner.email, "owner", "admin"],
        ["editor-key", editor.email, "editor", null],
      ]),
    );
    expect(listed.every((k) => !("key" in k))).toBe(true); // 平文は出ない
    // EDITOR は 403、非メンバーは 404
    expect((await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: editor.token })).status).toBe(403);
    // 2 つ目のワークスペース B はシステム管理者(owner)が作る。editor は B のメンバーではない → 404
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    expect((await call("GET", `/workspaces/${second.id}/api-keys`, { token: editor.token })).status).toBe(404);
    // B の一覧には B のメンバーの鍵だけが並ぶ(editor の鍵は出ない)
    const other = await inviteAndJoin(owner.token, second.id, "admin");
    const inB = await listWs(other.token, second.id);
    expect(inB.some((k) => k.owner.email === editor.email)).toBe(false);
  });

  it("admin_revokes_a_members_key_and_the_key_stops_working_and_is_listed_as_revoked", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(editor.token, "to-revoke", owner.workspaceId);
    expect((await call("GET", "/me", { token: k.key })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, { token: admin.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: k.key })).status).toBe(401);
    const row = (await listWs(admin.token, owner.workspaceId)).find((x) => x.id === k.id)!;
    expect(row.revokedAt).not.toBeNull();
    // 二度目は 404(失効済みの鍵は対象にならない)
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, { token: admin.token })).status).toBe(404);
  });

  it("admin_cannot_revoke_an_owners_key_but_owner_can_revoke_an_admins", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ownerKey = await makeKey(owner.token, "owner-key", null);
    const adminKey = await makeKey(admin.token, "admin-key", owner.workspaceId);
    const denied = await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${ownerKey.id}`, { token: admin.token });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ error: "forbidden", required: "owner" });
    expect((await call("GET", "/me", { token: ownerKey.key })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${adminKey.id}`, { token: owner.token })).status).toBe(204);
  });

  it("a_key_of_someone_outside_the_workspace_is_404_and_keys_cannot_manage_keys", async () => {
    const owner = await setupOwner();
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    const other = await inviteAndJoin(owner.token, second.id, "admin"); // other は B だけのメンバー
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor"); // editor は A だけのメンバー
    const editorKey = await makeKey(editor.token, "editor-key", owner.workspaceId);
    expect((await call("DELETE", `/workspaces/${second.id}/api-keys/${editorKey.id}`, { token: other.token })).status).toBe(404);
    // 鍵で鍵を管理させない(既存の sessionOnly と同じ)。対象は OWNER 保護に掛からない EDITOR の鍵にする(sessionOnly を外したら 204 になる形)
    const adminKey = await makeKey(other.token, "admin-key", second.id);
    const listed = await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: adminKey.key });
    expect(listed.status).toBe(403);
    expect((await json(listed)).error).toBe("session_required");
    const revoked = await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${editorKey.id}`, { token: adminKey.key });
    expect(revoked.status).toBe(403);
    expect((await json(revoked)).error).toBe("session_required");
    expect((await call("GET", "/me", { token: editorKey.key })).status).toBe(200); // 対象の鍵は生きている
  });

  it("a_full_key_appears_in_every_workspace_list_and_revoking_in_one_kills_it_everywhere", async () => {
    // backlog B42: ワークスペースの鍵はそのワークスペースの一覧にだけ出る(api-key-scope.test.ts)。全ワークスペースに効くのは
    // システム管理者のフルの鍵だけで、それは各ワークスペースの一覧に出て、どこで失効させても全体で使えなくなる
    const a = await setupOwner();
    const b = await json<{ id: string }>(await call("POST", "/workspaces", { token: a.token, body: { name: "B" } }));
    const k = await makeKey(a.token, "full-key", null);
    expect((await listWs(a.token, a.workspaceId)).find((x) => x.id === k.id)?.owner.role).toBe("owner");
    expect((await listWs(a.token, b.id)).find((x) => x.id === k.id)?.owner.role).toBe("owner");
    expect((await call("DELETE", `/workspaces/${a.workspaceId}/api-keys/${k.id}`, { token: a.token })).status).toBe(204);
    expect((await call("GET", `/workspaces/${b.id}/sites`, { token: k.key })).status).toBe(401);
  });

  it("admin_can_revoke_a_key_whose_enabled_column_is_null", async () => {
    // Better Auth は enabled を nullable で作り、NULL を無効扱いしない(認証は通る)。管理者の失効も NULL を有効として扱う
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(editor.token, "null-enabled", owner.workspaceId);
    await env.DB.prepare("update apikey set enabled = NULL where id = ?").bind(k.id).run();
    expect((await call("GET", "/me", { token: k.key })).status).toBe(200);
    expect((await listWs(owner.token, owner.workspaceId)).find((x) => x.id === k.id)?.revokedAt).toBeNull();
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${k.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: k.key })).status).toBe(401);
  });

  it("revoked_keys_stay_listed_for_30_days_and_then_drop_out_like_the_own_list", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const fresh = await makeKey(editor.token, "revoked-29d", owner.workspaceId);
    const stale = await makeKey(editor.token, "revoked-31d", owner.workspaceId);
    // 失効の時刻の正は apikey_revocations(backlog B42 / brief K15)
    const ago = (days: number) => Date.now() - days * 86_400_000;
    for (const [id, days] of [[fresh.id, 29], [stale.id, 31]] as const) {
      await env.DB.prepare("insert into apikey_revocations (key_id, revoked_at, revoked_by) values (?, ?, null)").bind(id, ago(days)).run();
      await env.DB.prepare("update apikey set enabled = 0 where id = ?").bind(id).run();
    }
    const names = (await listWs(owner.token, owner.workspaceId)).map((k) => k.name);
    expect(names).toContain("revoked-29d");
    expect(names).not.toContain("revoked-31d");
    // 自分の一覧も同じ境界(こちらは掃除も行う)
    const mine = (await json<Array<{ name: string }>>(await call("GET", "/me/api-keys", { token: editor.token }))).map((k) => k.name);
    expect(mine).toContain("revoked-29d");
    expect(mine).not.toContain("revoked-31d");
  });
});
