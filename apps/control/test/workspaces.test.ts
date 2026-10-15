import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys } from "@wtt/core";
import { BREAK_GLASS, call, googleSignIn, json, setupOwner, inviteAndJoin, uniqueEmail, expectEnvelope, failingD1Insert, createSite, createExperiment, runDirect } from "./helpers";

/** `POST /workspaces/:wid/invitations` の応答(B28 で `extended` が増えた) */
type InvitationResult = { id: string; url: string; expiresAt: number; extended: boolean };

const invite = (token: string, wid: string, email: string, role: string) =>
  call("POST", `/workspaces/${wid}/invitations`, { token, body: { email, role } });

const listInvitations = async (token: string, wid: string) =>
  json<Array<{ id: string; role: string | null; status: string; expiresAt: number }>>(await call("GET", `/workspaces/${wid}/invitations`, { token }));

/** 招待の期限を直接書き換える(期限切れ・もうすぐ切れる、を作る)。列は date 型で ISO 文字列が入っている */
const setExpiry = async (id: string, at: number) => {
  await env.DB.prepare(`update invitation set "expiresAt" = ?1 where id = ?2`).bind(new Date(at).toISOString(), id).run();
};

const invitationRow = async (id: string) =>
  (await env.DB.prepare(`select status, "expiresAt" from invitation where id = ?1`).bind(id).first<{ status: string; expiresAt: string }>())!;

/** システム管理者の居ないワークスペースを SQL で作る(不変条件が崩れた状態での守りを確かめる) */
const rawWorkspace = async (id: string, owners: string[]) => {
  const now = new Date().toISOString();
  await env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values (?1, ?1, ?2, ?3)`).bind(id, `ws-${id}`, now).run();
  for (const userId of owners) {
    await env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'owner', ?4)`).bind(`m-${id}-${userId}`, id, userId, now).run();
  }
};

describe("workspaces / invitations / members", () => {
  it("lists memberships with role and lets an owner create another workspace", async () => {
    const { token, workspaceId } = await setupOwner();
    const created = await call("POST", "/workspaces", { token, body: { name: "Second" } });
    expect(created.status).toBe(201);
    const list = await json<Array<{ id: string; role: string }>>(await call("GET", "/workspaces", { token }));
    expect(list.map((w) => w.role)).toEqual(["owner", "owner"]);
    expect(list.some((w) => w.id === workspaceId)).toBe(true);
  });
  it("invitation link flow creates the user with the invited role", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("editor");
    const inv = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } });
    expect(inv.status).toBe(201);
    const { id, url, expiresAt } = await json<{ id: string; url: string; expiresAt: number }>(inv);
    expect(url).toBe(`http://localhost:3000/invite/${id}`);
    expect(expiresAt).toBeGreaterThan(Date.now()); // 時刻は epoch ミリ秒(Global Constraints)
    const pub = await json<{ expiresAt: number }>(await call("GET", `/invitations/${id}`));
    expect(pub).toMatchObject({ email, role: "editor", status: "pending", workspaceName: "Workspace A" });
    expect(pub.expiresAt).toBeGreaterThan(Date.now());
    const acc = await call("POST", `/invitations/${id}/accept`, { body: { name: "Ed", password: "password123" }, envOverride: BREAK_GLASS });
    expect(acc.status).toBe(200);
    const { token } = await json<{ token: string }>(acc);
    const mine = await json<Array<{ id: string; role: string }>>(await call("GET", "/workspaces", { token }));
    expect(mine).toEqual([{ id: owner.workspaceId, name: "Workspace A", role: "editor" }]);
    // 使用済みの招待は再利用できない
    expect((await call("POST", `/invitations/${id}/accept`, { body: { name: "Ed", password: "password123" }, envOverride: BREAK_GLASS })).status).toBe(410);
  });
  it("an existing user accepts with a bearer session and the email must match", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second.id}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: ed.token })).status).toBe(200);
    const stranger = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const inv2 = await json<{ id: string }>(await call("POST", `/workspaces/${second.id}/invitations`, { token: owner.token, body: { email: uniqueEmail("other"), role: "viewer" } }));
    expect((await call("POST", `/invitations/${inv2.id}/accept`, { token: stranger.token })).status).toBe(403);
  });
  it("member management is admin-only and viewer/editor get 403, non-member 404", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: ed.token })).status).toBe(403);
    expect((await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: ed.token, body: { email: uniqueEmail(), role: "viewer" } })).status).toBe(403);
    const members = await json<Array<{ memberId: string; email: string; role: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }));
    const edRow = members.find((m) => m.email === ed.email)!;
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${edRow.memberId}`, { token: owner.token, body: { role: "admin" } })).status).toBe(200);
    expect((await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: ed.token })).status).toBe(200);
    // 他 Workspace の非メンバーには存在を漏らさない
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    expect((await call("GET", `/workspaces/${second.id}/members`, { token: ed.token })).status).toBe(404);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: ed.token })).status).toBe(403); // ワークスペースの削除はシステム管理者のみ(B36)
  });
  it("reset link is issued by an admin and lets the member set a new password", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const members = await json<Array<{ memberId: string; email: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }));
    const edRow = members.find((m) => m.email === ed.email)!;
    const res = await call("POST", `/workspaces/${owner.workspaceId}/members/${edRow.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS });
    expect(res.status).toBe(200);
    const { url } = await json<{ url: string }>(res);
    // 決定 35 (2): 配るのは管理画面のリセットページ。control の GET は通らない
    const link = new URL(url);
    expect(`${link.origin}${link.pathname}`).toBe("http://localhost:3000/reset"); // wrangler.jsonc の AB_ADMIN_URL
    const token = link.searchParams.get("token");
    expect(token).toBeTruthy();
    expect((await call("GET", `/auth/reset-password/${token}?callbackURL=http://localhost:3000/reset`, { envOverride: BREAK_GLASS })).status).toBe(404);
    const reset = await call("POST", "/auth/reset-password", { body: { newPassword: "newpassword123", token }, envOverride: BREAK_GLASS });
    expect(reset.status).toBe(200);
    const signin = await call("POST", "/auth/sign-in/email", { body: { email: ed.email, password: "newpassword123" }, envOverride: BREAK_GLASS });
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-auth-token")).toBeTruthy();
    // 再設定で、それまでのセッションは切れる(乗っ取られた側が気づく前に居座られない。本人がリセットした場合も盗まれた旧セッションが死ぬ)
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(401);
    const fresh = signin.headers.get("set-auth-token")!;
    expect((await call("GET", "/me", { token: fresh })).status).toBe(200);
  }, 15_000); // パスワードの hash が重く、全体実行の負荷で 5 秒の既定に迫る(5031 ms を観測)
  it("admin cannot issue a reset link for an owner", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const members = await json<Array<{ memberId: string; email: string; role: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }));
    const ownerRow = members.find((m) => m.email === owner.email)!;
    const res = await call("POST", `/workspaces/${owner.workspaceId}/members/${ownerRow.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner" });
  });

  /**
   * 他のワークスペースの所属を作る: setupOwner(システム管理者)が 2 つ目のワークスペースを作り、そこへ招待して受諾する。
   * `inviteAndJoin` は新しい user を作るので、既存の user を別のワークスペースに入れるにはこの形で呼ぶ。
   * 招待の Role に owner は無い(`INVITABLE_ROLES`)ので、owner にするときは admin で入れてから PATCH で上げる
   */
  const joinOther = async (adminToken: string, otherWid: string, user: { token: string; email: string }, role: "owner" | "admin" | "editor" | "viewer") => {
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${otherWid}/invitations`, { token: adminToken, body: { email: user.email, role: role === "owner" ? "admin" : role } }));
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: user.token })).status).toBe(200);
    if (role === "owner") {
      const members = await json<Array<{ memberId: string; email: string }>>(await call("GET", `/workspaces/${otherWid}/members`, { token: adminToken }));
      const row = members.find((m) => m.email === user.email)!;
      expect((await call("PATCH", `/workspaces/${otherWid}/members/${row.memberId}`, { token: adminToken, body: { role: "owner" } })).status).toBe(200);
    }
  };
  /** システム管理者でない OWNER(B36 以後、ワークスペースの OWNER とシステム管理者は別の概念) */
  const plainOwner = async (owner: Awaited<ReturnType<typeof setupOwner>>) => {
    const o = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${o.memberId}`, { token: owner.token, body: { role: "owner" } })).status).toBe(200);
    return o;
  };

  it("reset link: an admin cannot reset a member who holds a role in another workspace (account takeover path)", async () => {
    // Codex Security F2: 発行者の権限は Workspace 単位、効果はアカウント全体。対象が他所で OWNER なら、そこを乗っ取れてしまう
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await joinOther(owner.token, other.id, ed, "owner");
    const res = await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner_of_other_workspaces" });
    // 他所の所属が viewer でも同じ(どの Role でも、そのワークスペースのデータに届く)
    const ed2 = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await joinOther(owner.token, other.id, ed2, "viewer");
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed2.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS })).status).toBe(403);
  });

  it("reset link: a plain owner can reset a member only if the owner also owns every other workspace of that member", async () => {
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const po = await plainOwner(owner);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await joinOther(owner.token, other.id, ed, "editor");
    // po は other の OWNER ではない → 403
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: po.token, envOverride: BREAK_GLASS })).status).toBe(403);
    // po を other の OWNER にすると発行できる
    await joinOther(owner.token, other.id, po, "owner");
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: po.token, envOverride: BREAK_GLASS })).status).toBe(200);
  });

  it("reset link: an instance admin can reset anyone except through the owner / instance-admin gates", async () => {
    // システム管理者は全ワークスペースの OWNER 相当(決定 53)なので、他所の所属があっても発行できる
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await joinOther(owner.token, other.id, ed, "owner");
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS })).status).toBe(200);
  });

  it("reset link: a pending invitation elsewhere is not a membership", async () => {
    // Review Focus 1: 招待は member 行を作らないので、他所に招待だけされている人には発行できる
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", `/workspaces/${other.id}/invitations`, { token: owner.token, body: { email: ed.email, role: "admin" } })).status).toBe(201); // 招待に owner は無い(INVITABLE_ROLES)ので admin で代える。未受諾の招待が所属にならないことの確認に Role は関係ない
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS })).status).toBe(200);
  });

  it("reset link: anyone may issue their own reset link regardless of other memberships", async () => {
    // Review Focus 2: 自分の認証情報を自分で変えるのは乗っ取りではない
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await joinOther(owner.token, other.id, admin, "viewer");
    expect((await call("POST", `/workspaces/${owner.workspaceId}/members/${admin.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS })).status).toBe(200);
  });

  /** 再設定リンクの token で実際にパスワードを変え、新しいパスワードでログインできるかを返す(失効していれば false) */
  const resetWorks = async (url: string, email: string) => {
    const token = new URL(url).searchParams.get("token")!;
    const reset = await call("POST", "/auth/reset-password", { body: { newPassword: "changed-by-link-123", token }, envOverride: BREAK_GLASS });
    if (reset.status !== 200) return false;
    const signin = await call("POST", "/auth/sign-in/email", { body: { email, password: "changed-by-link-123" }, envOverride: BREAK_GLASS });
    return signin.status === 200;
  };

  it("reset link: a link issued before the target joins another workspace stops working", async () => {
    // レビュー r1 CX-High-1: 発行時の判定だけでは、1 時間の有効期間の中で対象が他所に参加すると同じ乗っ取りになる。受諾で消す
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const issued = await json<{ url: string }>(await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS }));
    await joinOther(owner.token, other.id, ed, "viewer"); // Bearer ありの受諾
    expect(await resetWorks(issued.url, ed.email)).toBe(false);
    // 受諾の後に発行し直せば(他所の所属があるので admin は 403、owner = システム管理者なら 200)使える
    const again = await json<{ url: string }>(await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS }));
    expect(await resetWorks(again.url, ed.email)).toBe(true);
}, 15_000);

  it("reset link: a role change for the target invalidates links issued before it", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const issued = await json<{ url: string }>(await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: BREAK_GLASS }));
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "admin" } })).status).toBe(200);
    expect(await resetWorks(issued.url, ed.email)).toBe(false);
  });

  it("reset link: a membership added between the authorization read and the token issue leaves no usable token", async () => {
    // 発行の読み取り(所属なし)→ 受諾の書き込み → token の作成、の順でも、発行の直後の読み直しが他所の所属を見て token を消す
    const owner = await setupOwner();
    const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }));
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${other.id}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    // Better Auth が token を verification に insert する直前に、受諾を済ませる。kysely-d1 は `prepare(sql).bind(...).all()` で実行する
    // (kysely-d1/dist/index.js:78-80。run() ではない)ので、bind が返した statement の all() を包む(helpers の failingD1Query と同じ流儀)
    const db = env.DB;
    const original = db.prepare.bind(db);
    let hookRuns = 0;
    const wrapped = Object.create(db, {
      prepare: {
        value: (q: string) => {
          const stmt = original(q);
          if (!/insert into "?verification"?/i.test(q)) return stmt;
          const bind = stmt.bind.bind(stmt);
          stmt.bind = ((...args: unknown[]) => {
            const bound = bind(...args);
            const all = bound.all.bind(bound);
            bound.all = (async () => {
              hookRuns += 1;
              expect((await call("POST", `/invitations/${inv.id}/accept`, { token: ed.token })).status).toBe(200); // 受諾 = 他所の member 行が増える
              return all();
            }) as typeof bound.all;
            return bound;
          }) as typeof stmt.bind;
          return stmt;
        },
      },
    }) as D1Database;
    const res = await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: { ...BREAK_GLASS, DB: wrapped } });
    expect(hookRuns).toBe(1); // 競合が実際に起きた(token の insert の直前に受諾が走った)
    const joined = await env.DB.prepare(`select count(*) as n from member where "organizationId" = ?1 and "userId" = ?2`).bind(other.id, ed.userId).first<{ n: number }>();
    expect(joined?.n).toBe(1); // 受諾は成功している
    expect(res.status).toBe(403); // 読み直しで他所の所属を見て断る
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner_of_other_workspaces" });
    const left = await env.DB.prepare(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?1`).bind(ed.userId).first<{ n: number }>();
    expect(left?.n).toBe(0); // 発行した token は消えている
  });

  it("reset link: a target promoted to owner between the authorization read and the token issue leaves no usable token", async () => {
    // 最終レビュー: 事前の assertCanTouchOwner の後に OWNER が対象を owner へ昇格し、その PATCH の batch より後に token が入ると、
    // ADMIN が OWNER のアカウントの有効なリンクを持つ。発行の直後の読み直しで発行先での Role も見て token を消す
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const db = env.DB;
    const original = db.prepare.bind(db);
    let hookRuns = 0;
    const wrapped = Object.create(db, {
      prepare: {
        value: (q: string) => {
          const stmt = original(q);
          if (!/insert into "?verification"?/i.test(q)) return stmt;
          const bind = stmt.bind.bind(stmt);
          stmt.bind = ((...args: unknown[]) => {
            const bound = bind(...args);
            const all = bound.all.bind(bound);
            bound.all = (async () => {
              hookRuns += 1;
              // token の insert の直前に昇格を済ませる(PATCH の batch が消せる token はまだ無い)
              expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "owner" } })).status).toBe(200);
              return all();
            }) as typeof bound.all;
            return bound;
          }) as typeof stmt.bind;
          return stmt;
        },
      },
    }) as D1Database;
    const res = await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: admin.token, envOverride: { ...BREAK_GLASS, DB: wrapped } });
    expect(hookRuns).toBe(1); // 競合が実際に起きた
    const now = await env.DB.prepare(`select role from member where id = ?1`).bind(ed.memberId).first<{ role: string }>();
    expect(now?.role).toBe("owner"); // 昇格は成功している
    expect(res.status).toBe(403); // 読み直しで owner への昇格を見て断る
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "owner" });
    const left = await env.DB.prepare(`select count(*) as n from verification where identifier like 'reset-password:%' and value = ?1`).bind(ed.userId).first<{ n: number }>();
    expect(left?.n).toBe(0); // 発行した token は消えている
  }, 15_000);

  it("reset: a token invalidated after it was read does not change the password", async () => {
    // レビュー r2 CX-High-1 (b): Better Auth の /reset-password は token を読んだ後に hash してから account を更新し、更新の直前に token を再照合しない。
    // 読み取り(verification の select)の直後に失効させ、パスワードが変わらないことを確かめる
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const issued = await json<{ url: string }>(await call("POST", `/workspaces/${owner.workspaceId}/members/${ed.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS }));
    const token = new URL(issued.url).searchParams.get("token")!;
    const db = env.DB;
    const original = db.prepare.bind(db);
    let reads = 0;
    const wrapped = Object.create(db, {
      prepare: {
        value: (q: string) => {
          const stmt = original(q);
          if (!/select .* from "?verification"?/i.test(q)) return stmt;
          const bind = stmt.bind.bind(stmt);
          stmt.bind = ((...args: unknown[]) => {
            const bound = bind(...args);
            const all = bound.all.bind(bound);
            bound.all = (async () => {
              const r = await all(); // token を読む
              reads += 1;
              await env.DB.prepare(`delete from verification where identifier = ?1`).bind(`reset-password:${token}`).run(); // 読んだ直後に失効
              return r;
            }) as typeof bound.all;
            return bound;
          }) as typeof stmt.bind;
          return stmt;
        },
      },
    }) as D1Database;
    const reset = await call("POST", "/auth/reset-password", { body: { newPassword: "changed-by-link-123", token }, envOverride: { ...BREAK_GLASS, DB: wrapped } });
    expect(reads).toBeGreaterThan(0);
    expect(reset.status).toBe(400); // INVALID_TOKEN
    expect((await call("POST", "/auth/sign-in/email", { body: { email: ed.email, password: "changed-by-link-123" }, envOverride: BREAK_GLASS })).status).toBe(401); // パスワードは変わっていない
}, 15_000);

  it("better auth organization endpoints are not exposed", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/auth/organization/update-member-role", { token: ed.token, body: { organizationId: owner.workspaceId, role: "owner" } })).status).toBe(404);
    expect((await call("POST", "/auth/organization/delete", { token: ed.token, body: { organizationId: owner.workspaceId } })).status).toBe(404);
  });
  it("session token endpoints stay closed and the reset-password GET is not exposed", async () => {
    // AUTH_ALLOW は完全一致のみ(決定 35 (2))。list-sessions / token はセッショントークンを返すので開けない
    const owner = await setupOwner();
    expect((await call("GET", "/auth/list-sessions", { token: owner.token })).status).toBe(404);
    expect((await call("GET", "/auth/token", { token: owner.token })).status).toBe(404);
    expect((await call("GET", "/auth/reset-password/some-token")).status).toBe(404);
    expect((await call("POST", "/auth/reset-password/some-token", { body: {} })).status).toBe(404);
    expect((await call("GET", "/auth/reset-password/a/b")).status).toBe(404); // セグメントは 1 つだけ
  });
  it("an instance admin's row cannot be changed from the workspace and the last owner guard still holds", async () => {
    // backlog B36: setup のオーナーはシステム管理者なので、ワークスペース側からは変えられない(409 instance_admin_member)
    const owner = await setupOwner();
    const members = await json<Array<{ memberId: string; email: string }>>(await call("GET", `/workspaces/${owner.workspaceId}/members`, { token: owner.token }));
    const ownerRow = members.find((m) => m.email === owner.email)!;
    const demote = await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ownerRow.memberId}`, { token: owner.token, body: { role: "admin" } });
    expect(demote.status).toBe(409);
    expect(await expectEnvelope(demote)).toMatchObject({ error: "instance_admin_member" });
    // 最後のオーナーの守り(K17)は、システム管理者の居ないワークスペース(不変条件が崩れた状態)で確かめる
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await rawWorkspace("w-x", [ed.userId]);
    const edRow = (await env.DB.prepare(`select id from member where "organizationId" = 'w-x' and "userId" = ?1`).bind(ed.userId).first<{ id: string }>())!;
    const last = await call("PATCH", `/workspaces/w-x/members/${edRow.id}`, { token: ed.token, body: { role: "admin" } });
    expect(last.status).toBe(409);
    const lastBody = (await expectEnvelope(last)) as { error: string; message: string };
    expect(lastBody.error).toBe("last_owner");
    expect(lastBody.message).not.toBe("last_owner");
  });
  it("two owners cannot both be demoted concurrently", async () => {
    // システム管理者でないオーナー 2 人だけのワークスペースで、互いを同時に降格する
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const ad = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await rawWorkspace("w-y", [ed.userId, ad.userId]);
    const rowOf = async (userId: string) =>
      (await env.DB.prepare(`select id from member where "organizationId" = 'w-y' and "userId" = ?1`).bind(userId).first<{ id: string }>())!.id;
    const [a, b] = await Promise.all([
      call("PATCH", `/workspaces/w-y/members/${await rowOf(ed.userId)}`, { token: ad.token, body: { role: "admin" } }),
      call("PATCH", `/workspaces/w-y/members/${await rowOf(ad.userId)}`, { token: ed.token, body: { role: "admin" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
  it("accepting without a session rejects a browser Origin that is not the admin (login CSRF via text/plain form)", async () => {
    // Codex Security F8: この経路は Better Auth の handler を通らず(signUpEmail をサーバー内部で呼ぶ)、trustedOrigins の照合が働かない。
    // BFF が転送する Origin を受け側で見る。Origin 無し(エージェントの直叩き)は従来どおり通す
    const owner = await setupOwner();
    const email = uniqueEmail("ed");
    const inv = await json<{ id: string }>(await invite(owner.token, owner.workspaceId, email, "editor"));
    const bad = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, headers: { origin: "https://www.example.com" }, envOverride: BREAK_GLASS });
    expect(bad.status).toBe(403);
    expect(await json(bad)).toMatchObject({ error: "bad_origin" });
    const nul = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, headers: { origin: "null" }, envOverride: BREAK_GLASS });
    expect(nul.status).toBe(403);
    // 招待はまだ使われていない
    expect((await invitationRow(inv.id)).status).toBe("pending");
    // admin のオリジン(末尾スラッシュの違いは吸収する。Review Focus 4)は通る
    const ok = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, headers: { origin: "http://localhost:3000" }, envOverride: { ...BREAK_GLASS, AB_ADMIN_URL: "http://localhost:3000/" } });
    expect(ok.status).toBe(200);
  });
  it("accepting an invitation for an existing email without a session returns 409", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const inv = await json<{ id: string }>(await call("POST", `/workspaces/${second.id}/invitations`, { token: owner.token, body: { email: ed.email, role: "viewer" } }));
    const res = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Ed", password: "password123" }, envOverride: BREAK_GLASS });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("account_exists");
  });
  it("a sign-up fault while accepting is a 5xx, not a 409 account_exists", async () => {
    // 本物の障害(D1 の user への insert が失敗)を「よくある衝突」に丸めない。丸めると監視に出ない
    const owner = await setupOwner();
    const email = uniqueEmail("editor");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } }),
    );
    const res = await call("POST", `/invitations/${inv.id}/accept`, {
      body: { name: "Ed", password: "password123" },
      envOverride: { ...BREAK_GLASS, DB: failingD1Insert(env.DB, "user") },
    });
    // Better Auth は「既存メール」と「user 作成失敗」の両方を UNPROCESSABLE_ENTITY で投げる。
    // 見分けは body.code(FAILED_TO_CREATE_USER / USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL)で行う
    expect(res.status).toBe(500);
    expect((await expectEnvelope(res)).error).toBe("internal");
  });
  it("deleting a workspace removes its sites from d1 and kv", async () => {
    const owner = await setupOwner();
    // 最後の 1 つは消せないので、消される側とは別にもう 1 つ作っておく
    await call("POST", "/workspaces", { token: owner.token, body: { name: "Keeper" } });
    const { id } = await createSite(owner.token, owner.workspaceId, { id: "site_ws", mode: "B", domain: "ws.example.com" });
    expect(await env.CONFIG_KV.get(kvKeys.settings(id))).not.toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.host("ws.example.com"))).toBe(id);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token })).status).toBe(204);
    // KV は organization の FK CASCADE では消えないので、Workspace 削除が自分で消す
    expect(await env.CONFIG_KV.get(kvKeys.settings(id))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.host("ws.example.com"))).toBeNull();
    expect((await env.DB.prepare("select count(*) as n from sites").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("select count(*) as n from site_hosts").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("select count(*) as n from organization where id = ?").bind(owner.workspaceId).first<{ n: number }>())?.n).toBe(0);
    expect(await json<Array<{ name: string }>>(await call("GET", "/workspaces", { token: owner.token }))).toMatchObject([{ name: "Keeper" }]);
  });

  it("an admin cancels a pending invitation: the link stops working and the row leaves the list (B24)", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const email = uniqueEmail("pending");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } }),
    );
    // 取り消しの巻き添えにならず一覧に残り続ける、もう 1 件の pending
    const kept = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: uniqueEmail("kept"), role: "viewer" } }),
    );
    const del = (wid: string, id: string, token: string) => call("DELETE", `/workspaces/${wid}/invitations/${id}`, { token });
    expect((await del(owner.workspaceId, inv.id, editor.token)).status).toBe(403);
    // 別 Workspace の ID・存在しない ID は、どちらも 404(区別させない)
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    expect((await del(second.id, inv.id, owner.token)).status).toBe(404);
    expect((await del(owner.workspaceId, "does-not-exist", owner.token)).status).toBe(404);
    expect((await del(owner.workspaceId, inv.id, admin.token)).status).toBe(204);
    expect((await del(owner.workspaceId, inv.id, admin.token)).status).toBe(404); // 2 回目
    // 一覧は pending だけ(取り消し済みも受諾済みもリンク付きで並べない)
    const list = await json<Array<{ id: string; email: string; status: string }>>(
      await call("GET", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token }),
    );
    expect(list.map((i) => i.id)).toEqual([kept.id]); // 取り消した招待は消え、他の pending は残る
    expect(list.map((i) => i.status)).toEqual(["pending"]);
    expect(list.map((i) => i.email)).not.toContain(admin.email); // 受諾済み
    // 取り消した招待は受諾できず、受諾画面は pending でない状態として読む
    const acc = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "X", password: "password123" }, envOverride: BREAK_GLASS });
    expect(acc.status).toBe(410);
    expect((await expectEnvelope(acc)).error).toBe("invitation_used");
    expect((await json<{ status: string }>(await call("GET", `/invitations/${inv.id}`))).status).toBe("canceled");
    // 取り消した後で初めて Google ログインしても user 行はできない
    const late = await googleSignIn(email);
    expect(late.token).toBeNull();
    expect(new URL(late.location).searchParams.get("error")).toBe("not_invited");
    expect((await env.DB.prepare(`select count(*) as n from "user" where email = ?`).bind(email).first<{ n: number }>())?.n).toBe(0);
  });

  it("an accepted invitation can no longer be canceled", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("joined");
    const inv = await json<{ id: string }>(
      await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } }),
    );
    const { token } = await googleSignIn(email);
    expect((await call("POST", `/invitations/${inv.id}/accept`, { token: token! })).status).toBe(200);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${inv.id}`, { token: owner.token })).status).toBe(404);
  });

  it("re-inviting the same address with a different role is refused and changes nothing (B28)", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("dup");
    const first = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "editor"));
    expect(first.extended).toBe(false);
    const res = await invite(owner.token, owner.workspaceId, email, "admin");
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("already_invited");
    expect(body.message).toContain("編集者"); // 現在のロールを画面の語で示す
    expect(typeof body.hint).toBe("string");
    // Role も期限も変わっていない(断った招待には触らない)
    const rows = await listInvitations(owner.token, owner.workspaceId);
    expect(rows).toMatchObject([{ id: first.id, role: "editor", status: "pending", expiresAt: first.expiresAt }]);
    // メールの大文字小文字は同じ宛先として扱う
    const upper = await invite(owner.token, owner.workspaceId, email.toUpperCase(), "viewer");
    expect(upper.status).toBe(409);
    expect((await expectEnvelope(upper)).error).toBe("already_invited");
  });

  it("re-inviting with the same role extends the existing invitation and keeps the link (B28)", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("extend");
    const first = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "editor"));
    // 期限を「まだ切れていないが短い」状態にしてから延ばす(同じミリ秒で発行すると差が出ないため)
    await setExpiry(first.id, Date.now() + 60_000);
    const again = await invite(owner.token, owner.workspaceId, email.toUpperCase(), "editor");
    expect(again.status).toBe(201);
    const extended = await json<InvitationResult>(again);
    expect(extended).toMatchObject({ id: first.id, url: first.url, extended: true });
    expect(extended.expiresAt).toBeGreaterThan(Date.now() + 60_000);
    const rows = await listInvitations(owner.token, owner.workspaceId);
    expect(rows).toMatchObject([{ id: first.id, role: "editor", expiresAt: extended.expiresAt }]);
    // 期限が延びているあいだはログインの資格も生きている(access.ts の hasLiveInvitation)
    expect((await googleSignIn(email)).token).toBeTruthy();
  });

  it("a pending row whose role is null is extended, not reported as a conflict (B28)", async () => {
    // role は Better Auth 側で null になり得る。null を「違う Role」と見なすと、
    // 「既に 不明 で招待済みです」と断られて取り消すまで何もできなくなる
    const owner = await setupOwner();
    const email = uniqueEmail("norole");
    const first = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "viewer"));
    await env.DB.prepare(`update invitation set role = null where id = ?1`).bind(first.id).run();
    const again = await invite(owner.token, owner.workspaceId, email, "admin");
    expect(again.status).toBe(201);
    expect(await json<InvitationResult>(again)).toMatchObject({ id: first.id, extended: true });
  });

  it("an expired pending invitation is replaced by a new one and tidied away (B28)", async () => {
    const owner = await setupOwner();
    for (const role of ["editor", "viewer"] as const) {
      const email = uniqueEmail("expired");
      const old = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "editor"));
      await setExpiry(old.id, Date.now() - 60_000);
      // 巻き添えにしてはいけない行: 同じ Workspace の別アドレス(未失効)と、別 Workspace の同じアドレス
      const other = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, uniqueEmail("other"), "viewer"));
      const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
      const elsewhere = await json<InvitationResult>(await invite(owner.token, second.id, email, "viewer"));
      expect(elsewhere.extended).toBe(false);

      const fresh = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, role));
      expect(fresh.extended).toBe(false);
      expect(fresh.id).not.toBe(old.id);
      expect((await invitationRow(old.id)).status).toBe("canceled"); // 死んだ行は一覧に並べない
      expect((await invitationRow(elsewhere.id)).status).toBe("pending"); // 別 Workspace の行は無傷
      expect((await invitationRow(other.id)).status).toBe("pending"); // 未失効の行も無傷
      const ids = (await listInvitations(owner.token, owner.workspaceId)).map((r) => r.id);
      expect(ids).toContain(fresh.id);
      expect(ids).toContain(other.id);
      expect(ids).not.toContain(old.id);
    }
  });

  it("a canceled invitation is re-issued as a new one (B28)", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("recall");
    const first = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "viewer"));
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${first.id}`, { token: owner.token })).status).toBe(204);
    const again = await json<InvitationResult>(await invite(owner.token, owner.workspaceId, email, "admin"));
    expect(again.extended).toBe(false);
    expect(again.id).not.toBe(first.id);
    expect((await listInvitations(owner.token, owner.workspaceId)).map((r) => r.id)).toEqual([again.id]);
  });

  it("the invitation accept route publishes its request body in the openapi document", async () => {
    // 決定 34: 外部エージェントがアカウントを作る唯一の入口。body の契約が無言だと使えない
    const doc = (await (await call("GET", "/openapi.json")).json()) as {
      paths: Record<string, Record<string, { requestBody?: { required?: boolean; content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }> } }>>;
    };
    const body = doc.paths["/invitations/{id}/accept"]!.post!.requestBody!;
    const schema = body.content["application/json"]!.schema;
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["name", "password"]);
    expect(schema.required?.sort()).toEqual(["name", "password"]);
    expect(body.required).toBe(false); // Bearer あり(既存ユーザーの参加)なら body を送らない
  });
});

describe("workspace summary (backlog B35)", () => {
  it("summarizes each workspace with the role, member count and running experiments per site", async () => {
    const owner = await setupOwner();
    const a = await createSite(owner.token, owner.workspaceId, { name: "A", domain: "a.example.com" });
    const b = await createSite(owner.token, owner.workspaceId, { name: "B", domain: "b.example.com" });
    const running = await createExperiment(owner.token, a.id);
    const publishedOnly = await createExperiment(owner.token, a.id);
    await createExperiment(owner.token, a.id); // 下書きのまま = 数えない
    await runDirect(a.id, running.id); // Desired が running
    // 公開済みだけが running(一時停止の自動公開が失敗した状態)も数える = ワークスペース・サイトの削除を断る条件と同じ
    await env.DB.prepare("update experiments set status = 'paused', published_status = 'running' where site_id = ?1 and id = ?2").bind(a.id, publishedOnly.id).run();
    await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await call("GET", "/workspaces/summary", { token: owner.token });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([
      {
        id: owner.workspaceId,
        name: "Workspace A",
        role: "owner",
        memberCount: 2,
        sites: [
          { id: a.id, name: "A", domain: "a.example.com", runningCount: 2 },
          { id: b.id, name: "B", domain: "b.example.com", runningCount: 0 },
        ],
      },
    ]);
  });

  it("shows a workspace without sites and each member's own role", async () => {
    const owner = await setupOwner();
    const second = (await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }))).id;
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const mine = await json<Array<{ id: string; role: string; memberCount: number; sites: unknown[] }>>(await call("GET", "/workspaces/summary", { token: owner.token }));
    expect(mine.map((w) => [w.id, w.role, w.memberCount, w.sites.length])).toEqual([
      [owner.workspaceId, "owner", 2, 0],
      [second, "owner", 1, 0],
    ]);
    // 編集者には所属するワークスペースだけが、自分のロールで出る。メンバー数は管理者以上だけ(K22。メンバーの一覧と同じ範囲)
    const theirs = await json<Array<{ id: string; role: string; memberCount: number | null }>>(await call("GET", "/workspaces/summary", { token: editor.token }));
    expect(theirs.map((w) => [w.id, w.role, w.memberCount])).toEqual([[owner.workspaceId, "editor", null]]);
  });

  it("a workspace key sees only its workspace with the capped role", async () => {
    const owner = await setupOwner();
    const other = (await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }))).id;
    const created = await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId, roleCap: "viewer" } });
    expect(created.status).toBe(201);
    const { key } = await json<{ key: string }>(created);
    const res = await call("GET", "/workspaces/summary", { token: key });
    expect(res.status).toBe(200);
    const body = await json<Array<{ id: string; role: string; memberCount: number | null }>>(res);
    // 上限で閲覧者に絞った鍵は、持ち主がオーナーでもメンバー数を見られない(実効のロールで判定する)
    expect(body.map((w) => [w.id, w.role, w.memberCount])).toEqual([[owner.workspaceId, "viewer", null]]);
    expect(body.some((w) => w.id === other)).toBe(false);
  });

  it("requires a session", async () => {
    expect((await call("GET", "/workspaces/summary")).status).toBe(401);
  });
});
