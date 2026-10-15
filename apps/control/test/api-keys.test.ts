import { describe, expect, it } from "vitest";
import { call, json, setupOwner, inviteAndJoin } from "./helpers";

describe("api keys (decision 34, spec §13.3)", () => {
  it("api_key_inherits_user_role_and_revoked_key_is_401", async () => {
    const { token: ownerToken, workspaceId: wid } = await setupOwner();
    const editor = await inviteAndJoin(ownerToken, wid, "editor");
    const created = await call("POST", "/me/api-keys", { token: editor.token, body: { name: "ci", workspaceId: wid } });
    expect(created.status).toBe(201);
    const { id: kid, key } = (await json(created)) as { id: string; key: string };
    // 鍵 = 所有者の Role(EDITOR)。GET /me は通る
    expect((await call("GET", "/me", { token: key })).status).toBe(200);
    // ADMIN 操作(Site の作成)は 403 forbidden + required: "admin"
    const denied = await call("POST", `/workspaces/${wid}/sites`, { token: key, body: { name: "x", domain: "x.example.com" } });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({ error: "forbidden", required: "admin" });
    // 失効後は 401
    expect((await call("DELETE", `/me/api-keys/${kid}`, { token: editor.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: key })).status).toBe(401);
  });

  it("api_key_is_not_rate_limited_per_key", async () => {
    // 決定 34: エージェントは 1 鍵で多数のリクエストを送る。Better Auth apiKey プラグインの既定(1 鍵 10 req / 24h)を
    // 無効化していないと 11 回目から 401 になる(2026-09-07 本番で実測)。DoS 抑止は経路 + IP の AUTH_RATE_LIMITER が担う(決定 35)
    const { token } = await setupOwner();
    const { key } = (await json(await call("POST", "/me/api-keys", { token, body: { name: "agent", workspaceId: null } }))) as { key: string };
    for (let i = 0; i < 12; i++) {
      expect((await call("GET", "/me", { token: key })).status, `request #${i + 1}`).toBe(200);
    }
  });

  it("api keys cannot be managed with an api key", async () => {
    const { token } = await setupOwner();
    const { key } = (await json(await call("POST", "/me/api-keys", { token, body: { name: "a", workspaceId: null } }))) as { key: string };
    const res = await call("POST", "/me/api-keys", { token: key, body: { name: "b", workspaceId: null } });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("session_required");
    expect((await call("GET", "/me/api-keys", { token: key })).status).toBe(403);
  });

  it("a key is accepted from x-api-key as well and another user's key is 404", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const mine = (await json(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "owner-key", workspaceId: null } }))) as { id: string; key: string };
    // 決定 34: 鍵は Authorization: Bearer wtt_… と x-api-key の両方で受ける
    const viaHeader = await call("GET", "/me", { headers: { "x-api-key": mine.key } });
    expect(viaHeader.status).toBe(200);
    expect((await json(viaHeader)).email).toBe(owner.email);
    // 他人の鍵は存在を漏らさない(404)
    const listed = await json<Array<{ id: string; name: string; createdAt: number; key?: string }>>(await call("GET", "/me/api-keys", { token: owner.token }));
    expect(listed.map((k) => k.name)).toEqual(["owner-key"]);
    expect(listed[0]!.key).toBeUndefined(); // 平文は発行応答限り(Global Constraints)
    expect(typeof listed[0]!.createdAt).toBe("number"); // 時刻は epoch ミリ秒
    expect((await call("GET", "/me/api-keys", { token: editor.token })).status).toBe(200);
    expect((await call("DELETE", `/me/api-keys/${mine.id}`, { token: editor.token })).status).toBe(404);
  });

  it("revoked_at_is_the_revocation_time_not_the_creation_time, and the key stays listed and unusable (B14)", async () => {
    const owner = await setupOwner();
    const made = await json<{ id: string; key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "to-revoke", workspaceId: null } }));
    const { env } = await import("cloudflare:workers");
    const db = (env as { DB: D1Database }).DB;
    // 31 日前に発行した鍵にする(失効時刻と発行時刻を取り違えていると、失効直後の一覧で消える)
    const current = await db.prepare(`select createdAt from apikey where id = ?`).bind(made.id).first<{ createdAt: string | number }>();
    const old = Date.now() - 31 * 86_400_000;
    const oldValue = typeof current!.createdAt === "number" ? old : new Date(old).toISOString();
    await db.prepare(`update apikey set createdAt = ?, updatedAt = ? where id = ?`).bind(oldValue, oldValue, made.id).run();

    const before = Date.now();
    expect((await call("DELETE", `/me/api-keys/${made.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("GET", "/me", { token: made.key })).status).toBe(401);
    const listed = await json<Array<{ id: string; createdAt: number; revokedAt: number | null }>>(await call("GET", "/me/api-keys", { token: owner.token }));
    const row = listed.find((k) => k.id === made.id)!;
    expect(row).toBeTruthy(); // 古い鍵でも、失効直後は一覧に残る
    expect(row.revokedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(row.createdAt).toBeLessThan(before - 30 * 86_400_000);
    // 失効済みをもう一度失効させようとしても 404(有効な鍵だけが対象)
    expect((await call("DELETE", `/me/api-keys/${made.id}`, { token: owner.token })).status).toBe(404);
  });

  it("a revoked key is purged on the first listing after 30 days from the revocation (B14)", async () => {
    const owner = await setupOwner();
    const made = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "old-revoked", workspaceId: null } }));
    expect((await call("DELETE", `/me/api-keys/${made.id}`, { token: owner.token })).status).toBe(204);
    const { env } = await import("cloudflare:workers");
    const db = (env as { DB: D1Database }).DB;
    // 失効の時刻の正は apikey_revocations(backlog B42 / brief K15)
    await db.prepare(`update apikey_revocations set revoked_at = ? where key_id = ?`).bind(Date.now() - 31 * 86_400_000, made.id).run();
    const after = await json<Array<{ id: string }>>(await call("GET", "/me/api-keys", { token: owner.token }));
    expect(after.some((k) => k.id === made.id)).toBe(false);
    // 掃除の削除に失敗しても、保持期間を過ぎた鍵は一覧に出さない(差分レビュー r2 の B3)
    const again = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "old-revoked-2", workspaceId: null } }));
    expect((await call("DELETE", `/me/api-keys/${again.id}`, { token: owner.token })).status).toBe(204);
    await db.prepare(`update apikey_revocations set revoked_at = ? where key_id = ?`).bind(Date.now() - 31 * 86_400_000, again.id).run();
    const failingDelete = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            const stmt = target.prepare(q);
            if (!/^delete from apikey/i.test(q.trim())) return stmt;
            return new Proxy(stmt, {
              get(s, p) {
                if (p === "run") return async () => { throw new Error("injected purge failure"); };
                if (p === "bind") return (...args: unknown[]) => {
                  const bound = s.bind(...args);
                  return new Proxy(bound, { get(b, q2) { if (q2 === "run") return async () => { throw new Error("injected purge failure"); }; const v = Reflect.get(b, q2); return typeof v === "function" ? v.bind(b) : v; } });
                };
                const v = Reflect.get(s, p);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const listed = await json<Array<{ id: string }>>(await call("GET", "/me/api-keys", { token: owner.token, envOverride: { DB: failingDelete } }));
    expect(listed.some((k) => k.id === again.id)).toBe(false);
    expect((await db.prepare(`select count(*) as n from apikey where id = ?`).bind(made.id).first<{ n: number }>())?.n).toBe(0);
  });

  it("an active key is never purged, however old", async () => {
    const owner = await setupOwner();
    const made = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "old-active", workspaceId: null } }));
    const { env } = await import("cloudflare:workers");
    const db = (env as { DB: D1Database }).DB;
    const current = await db.prepare(`select updatedAt from apikey where id = ?`).bind(made.id).first<{ updatedAt: string | number }>();
    const old = Date.now() - 400 * 86_400_000;
    await db.prepare(`update apikey set updatedAt = ? where id = ?`).bind(typeof current!.updatedAt === "number" ? old : new Date(old).toISOString(), made.id).run();
    const listed = await json<Array<{ id: string; revokedAt: number | null }>>(await call("GET", "/me/api-keys", { token: owner.token }));
    expect(listed.find((k) => k.id === made.id)?.revokedAt).toBeNull();
  });
});
