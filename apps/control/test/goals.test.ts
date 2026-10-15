import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { call, json, setupOwner, inviteAndJoin, createSite } from "./helpers";

describe("goals", () => {
  it("goals validate type-specific config and enforce 100 char names", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    // spec §13.9: Goal の作成も Site を「未公開の変更」として拾う(touchSite)
    const before = (await json<{ contentUpdatedAt: number }>(await call("GET", `/sites/${sid}`, { token }))).contentUpdatedAt;
    expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_buy", name: "購入", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks" } } } })).status).toBe(201);
    const afterGoal = (await json<{ contentUpdatedAt: number }>(await call("GET", `/sites/${sid}`, { token }))).contentUpdatedAt;
    expect(afterGoal).toBeGreaterThan(before);
    // 同一 Site 内での id 重複は 409
    expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_buy", name: "dup", type: "CUSTOM", config: {} } })).status).toBe(409);
    // id は SLUG_RE
    const badGoalId = await call("POST", `/sites/${sid}/goals`, { token, body: { id: "Bad ID", name: "x", type: "CUSTOM", config: {} } });
    expect(badGoalId.status).toBe(422);
    expect((await json(badGoalId)).error).toBe("validation_failed");
    const badGoal = await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_click", name: "CTA", type: "CLICK", config: {} } });
    expect(badGoal.status).toBe(422);
    expect((await json(badGoal)).error).toBe("validation_failed");
    const long = await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_long", name: "あ".repeat(101), type: "CUSTOM", config: {} } });
    expect(long.status).toBe(422);
    const longBody = await json(long);
    expect(longBody.error).toBe("name_too_long");
    expect(longBody.path).toEqual(["name"]); // 封筒の path は配列(openapi.ts の ErrorEnvelopeSchema)
    expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_ok", name: "あ".repeat(100), type: "CUSTOM", config: {} } })).status).toBe(201); // 素の文字列長で数える(§10.9)
    expect((await call("PATCH", `/sites/${sid}/goals/g_buy`, { token, body: { name: "購入完了" } })).status).toBe(200);
    const badPatch = await call("PATCH", `/sites/${sid}/goals/g_buy`, { token, body: { type: "CLICK" } });
    expect(badPatch.status).toBe(422);
    expect((await json(badPatch)).error).toBe("validation_failed");
    expect((await call("DELETE", `/sites/${sid}/goals/g_ok`, { token })).status).toBe(204);
  });
  it("viewer cannot create goals", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const v = await inviteAndJoin(token, workspaceId, "viewer");
    expect((await call("POST", `/sites/${sid}/goals`, { token: v.token, body: { id: "g", name: "g", type: "CUSTOM", config: {} } })).status).toBe(403);
    expect((await call("GET", `/sites/${sid}/goals`, { token: v.token })).status).toBe(200);
  });
  it("goal_pageview_config_is_renamed_by_migration(0005: { urlOp, urlValue } → { page })", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const now = Date.now();
    const insert = "insert into goals (site_id, id, name, type, config_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)";
    await env.DB.prepare(insert).bind(sid, "g_old", "old", "PAGEVIEW", JSON.stringify({ urlOp: "contains", urlValue: "/thanks" }), now, now).run();
    await env.DB.prepare(insert).bind(sid, "g_click", "click", "CLICK", JSON.stringify({ selector: ".a" }), now, now).run();
    const migration = (env.TEST_MIGRATIONS as Array<{ name: string; queries: string[] }>).find((m) => m.name.startsWith("0005_"))!;
    for (const q of migration.queries) await env.DB.prepare(q).run();
    const rows = await env.DB.prepare("select id, config_json from goals where site_id = ? order by id").bind(sid).all<{ id: string; config_json: string }>();
    expect(Object.fromEntries(rows.results.map((r) => [r.id, JSON.parse(r.config_json)]))).toEqual({
      g_click: { selector: ".a" },
      g_old: { page: { op: "contains", value: "/thanks" } },
    });
  });
});
