import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "../src/db";
import { buildCompileInput, compileInputDigest, type StoredCompileInput } from "../src/publish";
import { call, createSite, setupOwner, siteRow } from "./helpers";

const input = (payload: unknown = { text: "before", extra: { b: 2, a: 1 } }): StoredCompileInput => ({
  siteId: "site", siteSalt: "salt", version: 1, timezone: "Asia/Tokyo", retentionDays: 30,
  goals: [], audiences: {}, experiments: [{ id: "exp", name: "Example", kind: "test", urlMatch: {},
    trafficPercentage: 100, persistAssignment: true,
    variants: [{ id: "b", name: "B", weight: 100, changes: [{ id: "change", type: "TEXT", selector: "h1", payload }] }],
  }],
});

describe("compile input digest", () => {
  it("digest_ignores_version", async () => {
    expect(await compileInputDigest(input())).toBe(await compileInputDigest({ ...input(), version: 99 }));
  });
  it("digest_ignores_key_order", async () => {
    expect(await compileInputDigest(input())).toBe(await compileInputDigest(input({ extra: { a: 1, b: 2 }, text: "before" })));
  });
  it("digest_changes_when_change_payload_changes", async () => {
    expect(await compileInputDigest(input({ text: "before" }))).not.toBe(await compileInputDigest(input({ text: "after" })));
  });
  it("digest_is_64_hex", async () => {
    expect(await compileInputDigest(input())).toMatch(/^[0-9a-f]{64}$/);
  });
  it("build_compile_input_orders_goals_and_audiences_by_id", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    for (const id of ["g_b", "g_a"]) {
      expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id, name: id, type: "CUSTOM", config: {} } })).status).toBe(201);
    }
    // 定義の内容は使わず、読みの順だけを検査する。
    const db = getDb(env);
    for (const id of ["a_b", "a_a"]) {
      await db.insertInto("audiences").values({ id, site_id: sid, name: id, definition_json: '{}', description: "", created_at: 1, updated_at: 1 }).execute();
    }
    const result = await buildCompileInput(db, await siteRow(sid), 1);
    expect(result.goals.map((g) => g.id)).toEqual(["g_a", "g_b"]);
    expect(Object.keys(result.audiences)).toEqual(["a_a", "a_b"]);
  });
});

it("select_statements_return_rows_in_a_batch", async () => {
  const { toStatement } = await import("../src/db");
  const db = getDb(env);
  const { token, workspaceId } = await setupOwner();
  const { id } = await createSite(token, workspaceId);
  const result = await env.DB.batch([toStatement(env, db.selectFrom("sites").select("id").where("id", "=", id))]);
  expect(result[0]!.results).toEqual([{ id }]);
});

it("records_digest_time_for_50_experiments_500_changes", async () => {
  const fixture = input();
  const exp = fixture.experiments[0]!;
  fixture.experiments = Array.from({ length: 50 }, (_, i) => ({ ...exp, id: `exp_${i}`, variants: exp.variants.map((v) => ({ ...v, changes: Array.from({ length: 10 }, (_, j) => ({ ...v.changes[0]!, id: `c_${j}` })) })) }));
  const start = performance.now();
  await compileInputDigest(fixture);
  console.log(`B56 digest (50 experiments, 500 changes): ${performance.now() - start} ms`);
});
