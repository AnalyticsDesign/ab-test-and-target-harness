import { describe, expect, it } from "vitest";
import { BREAK_GLASS, call, expectEnvelope, googleSignIn, inviteAndJoin, json, setupOwner, uniqueEmail } from "./helpers";

/**
 * backlog B20: セッションを作れるのは「どこかの Workspace の Member」か「有効な招待がある人」だけ
 * (auth.ts の databaseHooks.session.create.before)。
 *
 * このフックは **すべてのログイン経路**に効くので、まず「これまで通り入れること」を固定してから締め出しを見る。
 */
describe("who may hold a session (B20)", () => {
  it("keeps every existing way in open: /setup, the OWNER's Google sign-in, and the emergency password invite", async () => {
    // /setup(user 作成 → セッション → Workspace 作成の順。この時点ではまだ Member でない)と、その直後の Google ログイン
    const owner = await setupOwner();
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(200);
    // 2 回目以降の Google ログイン(user は既にあり、Member として通る)
    const again = await googleSignIn(owner.email);
    expect(again.token).toBeTruthy();
    // 非常口が開いているときの、パスワードでのアカウント作成 + 招待受諾
    const email = uniqueEmail("emergency");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } }),
    );
    const acc = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, envOverride: BREAK_GLASS });
    expect(acc.status).toBe(200);
    // その人はパスワードでもログインし直せる(Member なので)
    const signin = await call("POST", "/auth/sign-in/email", { body: { email, password: "password123" }, envOverride: BREAK_GLASS });
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-auth-token")).toBeTruthy();
  });

  it("cuts the session of someone whose only invitation is canceled, and refuses the next sign-in", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("invited");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } }),
    );
    // 受諾前に一度ログインだけしておく(user 行とセッションができる)
    const { token } = await googleSignIn(email);
    expect(token).toBeTruthy();
    expect((await call("GET", "/me", { token: token! })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${inv.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: token! })).status).toBe(401);
    const retry = await googleSignIn(email);
    expect(retry.token).toBeNull();
    expect(new URL(retry.location).searchParams.get("error")).toBe("not_invited");
  });

  it("cuts the session of a removed member and refuses the next sign-in, by Google or by password", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(200);
    // 外す前に非常用のパスワードを持たせておく(外した後に同じ経路も断たれることを見るため)
    const { url } = await json<{ url: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS }),
    );
    const resetToken = new URL(url).searchParams.get("token");
    expect((await call("POST", "/auth/reset-password", { body: { newPassword: "password123", token: resetToken }, envOverride: BREAK_GLASS })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(401);
    const retry = await googleSignIn(ed.email);
    expect(retry.token).toBeNull();
    expect(new URL(retry.location).searchParams.get("error")).toBe("not_invited");
    // 非常用のパスワード経路も断たれる(管理画面のフォームはこの応答をエラーとして出す)
    const signin = await call("POST", "/auth/sign-in/email", { body: { email: ed.email, password: "password123" }, envOverride: BREAK_GLASS });
    expect(signin.status).toBe(403);
    expect(signin.headers.get("set-auth-token")).toBeNull();
  });

  it("leaves alone someone who still belongs to another workspace", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${second.id}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }),
    );
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: ed.token })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(200);
    expect((await googleSignIn(ed.email)).token).toBeTruthy();
  });

  it("lets only an instance admin create a workspace — neither a member's key nor a removed user's key can", async () => {
    // backlog B36 / 決定 53 (5): 作成はシステム管理者だけ。鍵の認証はセッション行を作らないのでフックを通らないが、作成の口そのものがここで止まる
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const gone = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const edKey = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: ed.token, body: { name: "agent", workspaceId: owner.workspaceId } }))).key;
    const goneKey = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: gone.token, body: { name: "agent", workspaceId: owner.workspaceId } }))).key;
    // backlog B42(brief K17): ワークスペースの作成は人の操作なので、鍵では検証より前に 403 session_required
    const byMember = await call("POST", "/workspaces", { token: edKey, body: { name: "Mine" } });
    expect(byMember.status).toBe(403);
    expect(await expectEnvelope(byMember)).toMatchObject({ error: "session_required" });
    // セッションでも、システム管理者でなければ 403 required instance_admin
    const bySession = await call("POST", "/workspaces", { token: ed.token, body: { name: "Mine" } });
    expect(bySession.status).toBe(403);
    expect(await expectEnvelope(bySession)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${gone.memberId}`, { token: owner.token })).status).toBe(204);
    // backlog B42: 外された人のワークスペースの鍵は、鍵の入口で 401(範囲のワークスペースのメンバーでない)
    const denied = await call("GET", "/workspaces", { token: goneKey });
    expect(denied.status).toBe(401);
    const body = await expectEnvelope(denied);
    expect(body.error).toBe("unauthorized");
    expect(typeof body.hint).toBe("string");
  });

  it("refuses to delete the only workspace, so the install can never lose its last way in", async () => {
    // 最後の Workspace を消すと誰もどこの Member でもなくなり、POST /workspaces も次のログインも断られ、
    // /setup は閉じている = D1 を手で直すしか戻れない。その一手前で止める
    const owner = await setupOwner();
    const del = await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token });
    expect(del.status).toBe(409);
    const body = await expectEnvelope(del);
    expect(body.error).toBe("last_workspace");
    expect(body.message).not.toBe("last_workspace"); // 利用者向けの日本語
    expect(typeof body.hint).toBe("string");
    // Workspace は残り、OWNER は今までどおり使える
    expect(await json<unknown[]>(await call("GET", "/workspaces", { token: owner.token }))).toHaveLength(1);
    // 2 つ目を作れば 1 つ目は消せる
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(200); // second に残っている
    expect((await call("DELETE", `/workspaces/${second.id}`, { token: owner.token })).status).toBe(409);
  });

  it("cuts the sessions of members who only belonged to the deleted workspace", async () => {
    const owner = await setupOwner();
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const goneEd = await inviteAndJoin(owner.token, second.id, "editor");
    const bothEd = await inviteAndJoin(owner.token, second.id, "viewer");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: bothEd.email, role: "viewer" } }),
    );
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: bothEd.token })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${second.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: goneEd.token })).status).toBe(401); // second にしか居なかった
    expect((await call("GET", "/me", { token: bothEd.token })).status).toBe(200); // もう 1 つにも居る
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(200);
  });

  it("refuses a non-member before it validates the body", async () => {
    // 認可は検証より前(他のルートと同じ)。順が逆だと、断る相手に入力の直し方を返してしまう
    const owner = await setupOwner();
    const gone = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const goneKey = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: gone.token, body: { name: "agent", workspaceId: owner.workspaceId } }))).key;
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${gone.memberId}`, { token: owner.token })).status).toBe(204);
    // backlog B42(brief K17): ワークスペースの作成は鍵では検証より前に 403 session_required(外された人の鍵でも同じ)
    expect((await call("POST", "/workspaces", { token: goneKey, body: { name: "" } })).status).toBe(403);
  });
});
