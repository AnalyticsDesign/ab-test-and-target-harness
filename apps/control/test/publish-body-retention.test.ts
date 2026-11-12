import { beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { utcDay } from "@wtt/core";
import { getDb } from "../src/db";
import { CronFrozen } from "../src/cron/runner";
import { publishBodyKeep, prunePublishBodies, readPrunedToday, PUBLISH_BODY_COUNTER_JOB, type PruneArgs } from "../src/publish-body-retention";
import { siteWithRunning } from "./helpers";
import { RETENTION_INDEXES, countRetentionIndexes } from "./retention-indexes";

describe("publishBodyKeep", () => {
  it.each([
    [undefined, 100], ["", 100], ["100", 100], ["20", 20], ["10000", 10000], [" 50 ", 50],
    ["19", 100], ["10001", 100], ["0", 100], ["-5", 100], ["1.5", 100], ["1e3", 100], ["abc", 100], ["50abc", 100],
  ])("reads %j as %i", (raw, want) => expect(publishBodyKeep(raw)).toBe(want));
});


const NOW = 1_800_000_000_000;
async function seedPublishes(siteId: string, versions: number, opts: { kvDeletedBelow?: number } = {}) {
  await env.DB.batch(Array.from({ length: versions }, (_, i) => {
    const v = i + 1;
    return env.DB.prepare(`insert into publishes (id, site_id, version, status, config_hash, config_json, kv_deleted, published_by, created_at)
      values (?, ?, ?, ?, 'hash', '{"body":true}', ?, 'u', 123)`)
      .bind(`${siteId}:${v}`, siteId, v, v === versions ? "active" : "superseded", v < (opts.kvDeletedBelow ?? versions) ? 1 : 0);
  }));
  await env.DB.prepare("update sites set active_version = ?, static_served_version = ? where id = ?").bind(versions, versions, siteId).run();
}
async function fixture() {
  const s = await siteWithRunning();
  await seedPublishes(s.sid, 25);
  return s;
}
const prune = (sid: string, opts: Partial<PruneArgs> = {}) => prunePublishBodies(env, getDb(env), { siteId: sid, keep: [25], keepCount: 20, siteCap: 500, dailyCap: 5000, runId: crypto.randomUUID(), now: NOW, ...opts });
const allRows = async (sid: string) => (await env.DB.prepare("select * from publishes where site_id = ? order by version").bind(sid).all()).results;
const prunedVersions = async (sid: string) => (await allRows(sid)).filter((r) => r.body_pruned_at !== null).map((r) => r.version);
async function counter(pruned: number) {
  await env.DB.prepare("insert into cron_cursors (job, day, cursor) values (?, ?, ?)").bind(PUBLISH_BODY_COUNTER_JOB, utcDay(NOW), JSON.stringify({ pruned, limit: 500, run: "old" })).run();
}

describe.each([true, false])("prunePublishBodies (retention indexes: %s)", (indexed) => {
  beforeEach(async () => {
    if (!indexed) {
      for (const name of RETENTION_INDEXES) await env.DB.prepare(`drop index if exists ${name}`).run();
    }
    // 毎テストの resetStorage(setupFiles の beforeEach)の後に、狙った状態になっていることを確かめる
    expect(await countRetentionIndexes()).toBe(indexed ? RETENTION_INDEXES.length : 0);
  });
  it("prunes the bodies older than the newest keep versions and keeps the rows", async () => {
    const { sid } = await fixture();
    const before = await allRows(sid);
    const r = await prune(sid);
    expect(r.pruned).toBe(5);
    expect(await allRows(sid)).toEqual(before.map((p) => Number(p.version) <= 5 ? { ...p, config_json: null, body_pruned_at: NOW } : p));
  });
  it("keeps the body of a version whose kv key is still there", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update publishes set kv_deleted = 0 where site_id = ? and version = 3").bind(sid).run();
    expect((await prune(sid)).pruned).toBe(4);
    expect(await prunedVersions(sid)).toEqual([1, 2, 4, 5]);
  });
  it("keeps every version at or above the served version", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update sites set static_served_version = 3 where id = ?").bind(sid).run();
    await prune(sid);
    expect(await prunedVersions(sid)).toEqual([1, 2]);
  });
  it("prunes nothing when the served version is unknown", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update sites set static_served_version = null where id = ?").bind(sid).run();
    expect((await prune(sid)).pruned).toBe(0);
  });
  it("keeps the versions in the keep set", async () => {
    const { sid } = await fixture();
    await prune(sid, { keep: [4, 25] });
    expect(await prunedVersions(sid)).toEqual([1, 2, 3, 5]);
  });
  it("keeps the d1 active version read at statement time", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update sites set active_version = 2 where id = ?").bind(sid).run();
    await prune(sid);
    expect(await prunedVersions(sid)).toEqual([1, 3, 4, 5]);
  });
  it("counts only versions with a body toward the keep", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update publishes set config_json = null where site_id = ? and version between 21 and 23").bind(sid).run();
    await prune(sid);
    expect(await prunedVersions(sid)).toEqual([1, 2]);
  });
  it("prunes nothing when fewer versions than the keep have a body", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("update publishes set config_json = null where site_id = ? and version between 20 and 25").bind(sid).run();
    expect((await prune(sid)).pruned).toBe(0);
  });
  it("keeps a version whose delivery still needs confirmation", async () => {
    const { sid } = await fixture();
    for (const run of ["r2", "r3", "r4", "r5"]) await env.DB.prepare(`insert into experiments (site_id, id, name, status, run_id, url_match_json, created_by, updated_by, created_at, updated_at)
      values (?, ?, 'test', 'running', ?, '{}', 'u', 'u', 1, 1)`).bind(sid, run, run).run();
    for (const [version, run, settled] of [[2, "r2", null], [3, "r3", "unknown"], [4, "r4", "unknown"], [10, "r4", "delivered"], [5, "r5", "delivered"]] as const) {
      await env.DB.prepare("insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled) values (?, ?, ?, ?, '{}', 'h', ?)").bind(sid, run, run, version, settled).run();
    }
    await prune(sid);
    expect(await prunedVersions(sid)).toEqual([1, 4, 5]);
  });
  it("prunes expired unconfirmed run bodies but keeps recent ones (B242 2-A)", async () => {
    const { sid } = await fixture();
    for (const [v, days] of [[2, 9], [3, 1]]) {
      const id = `expired-${v}`;
      await env.DB.prepare(`insert into experiments (site_id, id, name, status, run_id, stopped_at, url_match_json, created_by, updated_by, created_at, updated_at)
        values (?, ?, 'test', 'archived', ?, ?, '{}', 'u', 'u', 1, 1)`).bind(sid, id, id, NOW - days! * 86400000).run();
      await env.DB.prepare(`insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash)
        values (?, ?, ?, ?, '{}', 'h')`).bind(sid, id, id, v).run();
    }
    await prune(sid);
    expect(await prunedVersions(sid)).toEqual([1, 2, 4, 5]);
  });
  it("prunes the oldest first up to the limit", async () => {
    const { sid } = await fixture();
    await prune(sid, { siteCap: 3 });
    expect(await prunedVersions(sid)).toEqual([1, 2, 3]);
  });
  it("counts the day's total in cron_cursors", async () => {
    const { sid } = await fixture();
    await counter(7);
    expect((await prune(sid)).prunedToday).toBe(12);
    const row = await env.DB.prepare("select cursor from cron_cursors where job = ?").bind(PUBLISH_BODY_COUNTER_JOB).first<{ cursor: string }>();
    expect(JSON.parse(row!.cursor).pruned).toBe(12);
  });
  it("applies the daily cap from the stored count even when the caller's count is stale", async () => {
    const { sid } = await fixture();
    await counter(4995);
    expect(await prune(sid)).toMatchObject({ pruned: 5, prunedToday: 5000 });
    expect((await prune(sid)).pruned).toBe(0);
  });
  it("does not exceed the cap when the response is lost after commit", async () => {
    const { sid } = await fixture();
    await prune(sid, { dailyCap: 4 }); // 応答を使わず再送
    expect(await prune(sid, { dailyCap: 4 })).toMatchObject({ pruned: 0, prunedToday: 4 });
    expect(await prunedVersions(sid)).toEqual([1, 2, 3, 4]);
  });
  it("does not recount on a retry with the same now", async () => {
    const { sid } = await fixture();
    expect((await prune(sid)).pruned).toBe(5);
    expect(await prune(sid)).toMatchObject({ pruned: 0, prunedToday: 5 });
  });
  it("writes nothing and throws CronFrozen when frozen", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{}', 1)").run();
    await expect(prune(sid)).rejects.toBeInstanceOf(CronFrozen);
    expect(await prunedVersions(sid)).toEqual([]);
    expect(await env.DB.prepare("select * from cron_cursors where job = ?").bind(PUBLISH_BODY_COUNTER_JOB).first()).toBeNull();
  });
  it("returns the time of each statement", async () => {
    const { sid } = await fixture();
    const r = await prune(sid);
    expect(r.stmtMs).toHaveLength(2);
    for (const n of r.stmtMs) expect(n).toBeGreaterThanOrEqual(0);
  });
  it("returns the rows read by both statements", async () => {
    const { sid } = await fixture();
    expect((await prune(sid)).rowsRead).toBeGreaterThan(0);
  });
  it("overwrites a counter row left unreadable on an earlier day", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("insert into cron_cursors (job, day, cursor) values (?, '2000-01-01', 'x')").bind(PUBLISH_BODY_COUNTER_JOB).run();
    expect(await prune(sid)).toMatchObject({ pruned: 5, prunedToday: 5 });
  });
  it("prunes nothing when today's counter row is unreadable (only a hand edit writes one; the next day overwrites it)", async () => {
    const { sid } = await fixture();
    await env.DB.prepare("insert into cron_cursors (job, day, cursor) values (?, ?, 'x')").bind(PUBLISH_BODY_COUNTER_JOB, utcDay(NOW)).run();
    await expect(prune(sid)).rejects.toThrow(/malformed JSON/);
    expect(await prunedVersions(sid)).toEqual([]);
  });
});

describe("readPrunedToday", () => {
  it.each([
    [undefined, 0], [{ day: utcDay(NOW), cursor: '{"pruned":12}' }, 12],
    [{ day: "2000-01-01", cursor: '{"pruned":12}' }, 0], [{ day: utcDay(NOW), cursor: null }, 0],
    [{ day: utcDay(NOW), cursor: "x" }, 0], [{ day: utcDay(NOW), cursor: '{"pruned":-1}' }, 0],
  ])("reads %j as %i", (row, want) => expect(readPrunedToday(row, NOW)).toBe(want));
});
