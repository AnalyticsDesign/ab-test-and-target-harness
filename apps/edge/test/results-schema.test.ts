import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

// 計測用 D1(wtt-results)の表の形と、設計書 §6.4 の書き込み SQL の振る舞いを確かめる。
// SQL は §6.4 の「participant(初回)」と「conversion」をそのまま使う(edge の実装が使う文と同じ形)
const INSERT_PARTICIPANT = `
INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied, mixed)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
ON CONFLICT (run_id, visitor_key) DO UPDATE SET mixed = 1, mixed_at = excluded.exposed_at
  WHERE participants.variant_id <> excluded.variant_id AND participants.mixed = 0`;
const INSERT_CONVERSION = `
INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at)
SELECT run_id, ?2, visitor_key, ?4 FROM participants WHERE run_id = ?1 AND visitor_key = ?3
ON CONFLICT (run_id, goal_id, visitor_key) DO NOTHING`;

const key = new Uint8Array(16).fill(7); // HMAC の先頭 16 バイトの代わり
const db = () => env.RESULTS_DB!;
const participant = (variantId: string, at: number) =>
  db().prepare(INSERT_PARTICIPANT).bind("run1", key, "site1", variantId, at, "desktop", "ok");
const count = async (table: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(db(), env.TEST_RESULTS_MIGRATIONS);
});
beforeEach(async () => {
  await db().batch([db().prepare("DELETE FROM participants"), db().prepare("DELETE FROM conversions")]);
});

describe("results D1 schema", () => {
  it("has the RESULTS_DB binding, migrations and a 32-byte base64 visitor key in the test env", () => {
    expect(env.RESULTS_DB).toBeDefined();
    expect(env.TEST_RESULTS_MIGRATIONS.length).toBeGreaterThan(0);
    expect(atob(env.RESULTS_VISITOR_KEY!).length).toBe(32);
  });

  it("keeps one participants row when the same (run_id, visitor_key) is inserted twice", async () => {
    await participant("a", 1000).run();
    await participant("a", 2000).run();
    expect(await count("participants")).toBe(1);
    const row = await db().prepare("SELECT variant_id, exposed_at, mixed, mixed_at FROM participants").first();
    // 同じパターンなら何も書かない: 初回の時刻のまま・混在にもならない
    expect(row).toEqual({ variant_id: "a", exposed_at: 1000, mixed: 0, mixed_at: null });
  });

  it("marks mixed once with mixed_at when a different variant arrives, keeping the first variant", async () => {
    await participant("a", 1000).run();
    await participant("b", 2000).run();
    await participant("b", 3000).run(); // 3 回目は mixed = 1 の後なので mixed_at を書き換えない
    const row = await db().prepare("SELECT variant_id, exposed_at, mixed, mixed_at FROM participants").first();
    expect(row).toEqual({ variant_id: "a", exposed_at: 1000, mixed: 1, mixed_at: 2000 });
  });

  it("inserts a conversion only when the participant row exists, and only once per goal", async () => {
    const convert = (at: number) => db().prepare(INSERT_CONVERSION).bind("run1", "goal1", key, at);
    await convert(5000).run();
    expect(await count("conversions")).toBe(0); // 参加者がいないので入らない
    await participant("a", 1000).run();
    await convert(5000).run();
    await convert(6000).run(); // 2 回目は DO NOTHING
    expect(await count("conversions")).toBe(1);
    const row = await db().prepare("SELECT converted_at FROM conversions").first();
    expect(row).toEqual({ converted_at: 5000 });
  });
});
