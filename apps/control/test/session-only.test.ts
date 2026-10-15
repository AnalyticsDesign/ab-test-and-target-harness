import { describe, expect, it } from "vitest";
import app from "../src/index";
import { SESSION_ONLY } from "../src/session-only";
import { BREAK_GLASS, call, expectEnvelope, inviteAndJoin, json, setupOwner } from "./helpers";

/**
 * backlog B42 / brief K17(大原則): 人とアクセス権の書き込みは、人が管理画面から行う(API キーでは 403 `session_required`)。
 * API キーはサイト・エクスペリエンスの運用(作る・直す・公開する・読む)に使う。
 */

/** 人とアクセス権の口(パスの前方一致)。ここに当たる書き込みは、すべて SESSION_ONLY に宣言されていなければならない */
const PEOPLE_AND_ACCESS = ["/me/api-keys", "/workspaces/:wid/api-keys", "/workspaces/:wid/members", "/workspaces/:wid/invitations", "/instance-admins", "/invitations", "/usage/settings"];
/** ワークスペースそのものの作成・削除(配下の /sites などは運用なので含めない) */
const WORKSPACE_ITSELF = new Set(["/workspaces", "/workspaces/:wid"]);

const declared = (method: string, path: string) => SESSION_ONLY.some((r) => r.method === method && r.path === path);
const fill = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, "x").replace("/*", "/get-session");

/**
 * 宣言とは独立に、必ず守る口(差分レビュー r2 の B2: 掃引は GET と ALL を見ないので、ここで別に固定する)。
 * 宣言から消すとこのテストが落ちる
 */
const MUST_REFUSE_KEYS = ["GET /me/api-keys", "POST /me/api-keys", "GET /workspaces/:wid/api-keys", "ALL /auth/*", "POST /invitations/:id/accept", "PATCH /usage/settings"];

describe("session-only routes (B42 brief K17)", () => {
  it("the routes that must refuse keys stay declared, independently of the sweep", () => {
    for (const r of MUST_REFUSE_KEYS) {
      const [method, path] = r.split(" ") as [string, string];
      expect(declared(method, path), r).toBe(true);
    }
  });

  it("a key is refused in every header shape, with or without Bearer (review r2 B1)", async () => {
    const owner = await setupOwner();
    const key = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: null } }))).key;
    const shapes: Array<Record<string, string>> = [
      { authorization: `Bearer ${key}` },
      { authorization: `bearer   ${key}` },
      { authorization: key },
      { authorization: ` ${key} ` },
      { "x-api-key": key },
    ];
    for (const headers of shapes) {
      const res = await call("GET", "/me/api-keys", { headers });
      expect(res.status, JSON.stringify(Object.keys(headers))).toBe(403);
      expect((await json(res)).error).toBe("session_required");
    }
  });

  it("every write on people and access is declared session-only (sweep of the mounted routes)", () => {
    const missing: string[] = [];
    for (const r of app.routes) {
      if (r.method === "ALL" || r.method === "GET") continue;
      const people = PEOPLE_AND_ACCESS.some((p) => r.path === p || r.path.startsWith(`${p}/`)) || WORKSPACE_ITSELF.has(r.path);
      if (people && !declared(r.method, r.path)) missing.push(`${r.method} ${r.path}`);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("every declared route refuses an api key with 403 session_required before anything else", async () => {
    // 有効なフルの鍵(システム管理者・上限なし)= 鍵として最も強い。それでも断る
    const owner = await setupOwner();
    const key = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: null } }))).key;
    for (const r of SESSION_ONLY) {
      const method = r.method === "ALL" ? "GET" : r.method;
      const res = await call(method, fill(r.path), { token: key, body: method === "GET" || method === "DELETE" ? undefined : {}, envOverride: BREAK_GLASS });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(await expectEnvelope(res), `${r.method} ${r.path}`).toMatchObject({ error: "session_required", hint: r.hint });
    }
  });

  it("a leaked admin key cannot invite, change members, reset passwords or accept invitations", async () => {
    // 招待を鍵で発行できると、攻撃者が自分を招待して受諾し、鍵を失効させた後も居座れる
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const adminKey = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: admin.token, body: { name: "k", workspaceId: owner.workspaceId } }))).key;
    const wid = owner.workspaceId;
    for (const res of [
      await call("POST", `/workspaces/${wid}/invitations`, { token: adminKey, body: { email: "attacker@example.com", role: "admin" } }),
      await call("PATCH", `/workspaces/${wid}/members/${ed.memberId}`, { token: adminKey, body: { role: "viewer" } }),
      await call("DELETE", `/workspaces/${wid}/members/${ed.memberId}`, { token: adminKey }),
      await call("POST", `/workspaces/${wid}/members/${ed.memberId}/reset-link`, { token: adminKey, envOverride: BREAK_GLASS }),
    ]) {
      expect(res.status).toBe(403);
      expect((await json(res)).error).toBe("session_required");
    }
    // 読み取りは鍵でも使える(エージェントの点検・レポート)
    expect((await call("GET", `/workspaces/${wid}/members`, { token: adminKey })).status).toBe(200);
    expect((await call("GET", `/workspaces/${wid}/invitations`, { token: adminKey })).status).toBe(200);
    // 本人宛ての招待も、鍵では受諾できない(範囲外のワークスペースに鍵で入る経路)
    const inv = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "B" } }));
    const invB = await json<{ id: string }>(await call("POST", `/workspaces/${inv.id}/invitations`, { token: owner.token, body: { email: admin.email, role: "admin" } }));
    const accepted = await call("POST", `/invitations/${invB.id}/accept`, { token: adminKey });
    expect(accepted.status).toBe(403);
    expect((await json(accepted)).error).toBe("session_required");
    // Bearer を付けない形でも断る(差分レビュー r2 の B1: 受諾のハンドラが Authorization の値をそのまま使っていた)
    const bare = await call("POST", `/invitations/${invB.id}/accept`, { headers: { authorization: adminKey } });
    expect(bare.status).toBe(403);
    expect((await json(bare)).error).toBe("session_required");
    // Bearer の形でない Authorization は、受諾では 401(トークンとして読まない)
    const malformed = await call("POST", `/invitations/${invB.id}/accept`, { headers: { authorization: `Token ${admin.token}` } });
    expect(malformed.status).toBe(401);
    // セッションでは今までどおり使える
    expect((await call("PATCH", `/workspaces/${wid}/members/${ed.memberId}`, { token: admin.token, body: { role: "viewer" } })).status).toBe(200);
  });
});
