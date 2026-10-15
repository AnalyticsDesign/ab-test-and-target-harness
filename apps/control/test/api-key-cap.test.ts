import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment } from "./helpers";

/** SQL が pattern に合う select だけ「0 行」を返す D1 ラッパ(kysely-d1 は prepare().bind().all() の順に呼ぶ) */
function emptyD1Select(db: D1Database, pattern: RegExp): D1Database {
  const empty = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === "all") return async () => ({ results: [], success: true, meta: {} });
        if (p === "first") return async () => null;
        if (p === "raw") return async () => [];
        if (p === "bind") return (...args: unknown[]) => empty(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (sqlText: string) => (pattern.test(sqlText) ? empty(target.prepare(sqlText)) : target.prepare(sqlText));
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/** 既定はフルの鍵(setupOwner の人はシステム管理者なので発行できる)。B42 の範囲は api-key-scope.test.ts */
const makeKey = async (token: string, name: string, roleCap?: string | null, workspaceId: string | null = null) =>
  json<{ id: string; key: string; roleCap: string | null }>(
    await call("POST", "/me/api-keys", { token, body: { name, workspaceId, ...(roleCap === undefined ? {} : { roleCap }) } }),
  );

/** backlog B33 / 決定 48: 鍵に権限の上限(roleCap)を持たせる。実効 Role = min(Member の Role, cap) */
describe("api key role cap (backlog B33, decision 48)", () => {
  it("a_key_with_roleCap_editor_is_limited_to_editor_even_for_an_owner", async () => {
    const owner = await setupOwner();
    const created = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "draft-only", workspaceId: null, roleCap: "editor" } });
    expect(created.status).toBe(201);
    const made = await json<{ key: string; roleCap: string | null }>(created);
    expect(made.roleCap).toBe("editor");
    // 実効 Role = min(OWNER, editor) = EDITOR: ADMIN 操作(Site の作成)は 403 required admin。
    // (Member の操作は B42 の大原則で鍵では行えないので、運用側の ADMIN 操作で確かめる)
    const denied = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: made.key, body: { name: "x", domain: "x.example.com" } });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ error: "forbidden", required: "admin" });
    // VIEWER 以上の操作(Site 一覧)は通る
    expect((await call("GET", `/workspaces/${owner.workspaceId}/sites`, { token: made.key })).status).toBe(200);
    // 一覧にも cap が出る
    const listed = await json<Array<{ name: string; roleCap: string | null }>>(await call("GET", "/me/api-keys", { token: owner.token }));
    expect(listed.find((k) => k.name === "draft-only")?.roleCap).toBe("editor");
  });

  it("a_key_without_roleCap_keeps_the_owner_role_and_reports_null", async () => {
    const owner = await setupOwner();
    const made = await json<{ key: string; roleCap: string | null }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "full", workspaceId: null } }));
    expect(made.roleCap).toBeNull();
    expect((await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: made.key, body: { name: "x", domain: "x.example.com" } })).status).toBe(201);
  });

  it("roleCap_above_the_users_highest_role_is_rejected_with_400", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await call("POST", "/me/api-keys", { token: editor.token, body: { name: "too-high", workspaceId: owner.workspaceId, roleCap: "admin" } });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "role_cap_too_high", highest: "editor" });
    // 同等(editor)は通る
    expect((await call("POST", "/me/api-keys", { token: editor.token, body: { name: "same", workspaceId: owner.workspaceId, roleCap: "editor" } })).status).toBe(201);
  });

  it("GET_me_reports_the_roleCap_of_the_key_in_use_and_null_for_a_session", async () => {
    // エージェントが自分の鍵の上限を確かめられるように(導入ガイドの「鍵の確認」で使う)
    const owner = await setupOwner();
    const made = await json<{ key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "capped", workspaceId: null, roleCap: "viewer" } }));
    expect(await json(await call("GET", "/me", { token: made.key }))).toMatchObject({ email: owner.email, roleCap: "viewer" });
    expect(await json(await call("GET", "/me", { token: owner.token }))).toMatchObject({ email: owner.email, roleCap: null });
  });

  it("cap_applies_on_the_site_route_too_editor_cap_can_draft_but_not_start", async () => {
    // loadSite 経路(Site 配下)は requireWorkspaceRole と独立した判定なので、そちらでも上限が効くことを固定する
    const owner = await setupOwner();
    const site = await createSite(owner.token, owner.workspaceId);
    const editorKey = await makeKey(owner.token, "editor-cap", "editor");
    const exp = await createExperiment(editorKey.key, site.id); // EDITOR: 下書きは作れる(201)
    const start = await call("POST", `/sites/${site.id}/experiments/${exp.id}/status`, { token: editorKey.key, body: { status: "running" } });
    expect(start.status).toBe(403);
    expect(await json(start)).toMatchObject({ error: "forbidden", required: "admin" });
    const viewerKey = await makeKey(owner.token, "viewer-cap", "viewer");
    const draft = await call("POST", `/sites/${site.id}/experiments`, { token: viewerKey.key, body: { id: "exp_v", name: "V", urlMatch: { op: "contains", value: "/" } } });
    expect(draft.status).toBe(403);
    expect(await json(draft)).toMatchObject({ error: "forbidden", required: "editor" });
  });

  it("GET_workspaces_reports_the_effective_role_for_a_capped_key", async () => {
    // エージェントが「自分はこの Workspace で何ができるか」を /workspaces の role で確かめられるように、生の Member Role ではなく実効 Role を返す
    const owner = await setupOwner();
    const key = await makeKey(owner.token, "editor-cap", "editor");
    const viaKey = await json<Array<{ id: string; role: string }>>(await call("GET", "/workspaces", { token: key.key }));
    expect(viaKey.find((w) => w.id === owner.workspaceId)?.role).toBe("editor");
    const viaSession = await json<Array<{ id: string; role: string }>>(await call("GET", "/workspaces", { token: owner.token }));
    expect(viaSession.find((w) => w.id === owner.workspaceId)?.role).toBe("owner");
  });

  it("demoting_the_member_after_issuing_lowers_the_key_below_its_cap", async () => {
    // 上限は発行時の Role を固定しない: Member を降格すれば鍵もそれに従う(実効 = min の「Member 側」が下がる)
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const key = await makeKey(admin.token, "admin-cap", "admin", owner.workspaceId);
    expect((await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: key.key })).status).toBe(200);
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${admin.memberId}`, { token: owner.token, body: { role: "viewer" } })).status).toBe(200);
    const denied = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: key.key, body: { name: "x", domain: "x.example.com" } });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ error: "forbidden", required: "admin" });
  });

  it("malformed_or_double_stringified_metadata_in_d1_is_read_fail_closed", async () => {
    const owner = await setupOwner();
    const setMeta = async (id: string, metadata: string) => {
      await env.DB.prepare("update apikey set metadata = ? where id = ?").bind(metadata, id).run();
    };
    const me = async (key: string) => json<{ roleCap: string | null }>(await call("GET", "/me", { token: key }));
    // 二重 JSON 化(Better Auth の一覧処理が解釈する形)= 一覧と同じく EDITOR として扱う
    const doubled = await makeKey(owner.token, "doubled", "editor");
    await setMeta(doubled.id, JSON.stringify(JSON.stringify({ scope: "full", roleCap: "editor" })));
    expect((await me(doubled.key)).roleCap).toBe("editor");
    // 不正な Role・owner・文字列以外は VIEWER に落ちる(ADMIN 操作は 403)
    const bogus = await makeKey(owner.token, "bogus", "admin");
    await setMeta(bogus.id, JSON.stringify({ scope: "full", roleCap: "owner" }));
    expect((await me(bogus.key)).roleCap).toBe("viewer");
    const denied = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: bogus.key, body: { name: "x", domain: "x.example.com" } });
    expect(denied.status).toBe(403);
    const numeric = await makeKey(owner.token, "numeric", "admin");
    await setMeta(numeric.id, JSON.stringify({ scope: "full", roleCap: 3 }));
    expect((await me(numeric.key)).roleCap).toBe("viewer");
    // backlog B42: 範囲の無い metadata(配列・NULL・B42 より前の鍵)は上限より先に鍵ごと 401(api-key-scope.test.ts)
  });

  it("a_key_whose_apikey_row_cannot_be_read_after_authentication_is_401_not_uncapped", async () => {
    // 認証は通ったのに apikey 行が読めない(= 想定外。better-auth の版上げで mock session の id の意味が変わった等)ときは、
    // 「上限なし」に倒さず 401。HTTP 経路では Better Auth が先に鍵を検証するので、上限を引く select だけを空にして再現する
    const owner = await setupOwner();
    const made = await makeKey(owner.token, "capped", "viewer");
    const DB = emptyD1Select(env.DB, /from "apikey" left join "apikey_revocations"/i);
    const res = await call("GET", "/me", { token: made.key, envOverride: { DB } });
    expect(res.status).toBe(401);
    expect((await call("GET", "/me", { token: made.key })).status).toBe(200); // 本物の DB では通る
  });

  it("roleCap_does_not_raise_a_lower_membership_role", async () => {
    // cap は上限であって付与ではない。backlog B42 の後は、ワークスペースの鍵の上限はそのワークスペースでのロール以下しか選べないので、
    // 「B で VIEWER の人が B 向けに ADMIN 上限の鍵を持つ」こと自体を発行時に断る(A 向けの ADMIN 上限の鍵は B では 404)。
    // backlog B36: setup のオーナーはシステム管理者で全ワークスペースのオーナーになるので、対象はシステム管理者でない user(A で ADMIN・B で VIEWER)にする
    const a = await setupOwner();
    const b = await json<{ id: string }>(await call("POST", "/workspaces", { token: a.token, body: { name: "B" } }));
    const u = await inviteAndJoin(a.token, a.workspaceId, "admin");
    await inviteAndJoin(a.token, b.id, "viewer", u.email);
    const forB = await call("POST", "/me/api-keys", { token: u.token, body: { name: "cap-admin", workspaceId: b.id, roleCap: "admin" } });
    expect(forB.status).toBe(400);
    expect(await json(forB)).toMatchObject({ error: "role_cap_too_high", highest: "viewer" });
    const forA = await json<{ key: string }>(await call("POST", "/me/api-keys", { token: u.token, body: { name: "cap-admin", workspaceId: a.workspaceId, roleCap: "admin" } }));
    expect((await call("POST", `/workspaces/${b.id}/sites`, { token: forA.key, body: { name: "x", domain: "x.example.com" } })).status).toBe(404);
  });
});
