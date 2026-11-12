import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { getDb } from "../src/db";
import { prunePublishBodies } from "../src/publish-body-retention";
import { cleanupOldVersions } from "../src/publish";
import { confirmDeliveries, needsDeliveryConfirmation, setDeliveredGeneration, sitesNeedingDeliveryConfirmation } from "../src/results/delivered";
import { resetStorage, applyControlMigrations } from "./apply-migrations";
import { siteWithRunning } from "./helpers";
import { observeRetentionDb } from "./publish-retention-observer";
import { RETENTION_INDEXES } from "./retention-indexes";

const INDEXES = [...RETENTION_INDEXES];
const NOW = 1_800_000_000_000;

async function seed(sid: string, n: number) {
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into publishes (id, site_id, version, status, config_hash, config_json, kv_deleted, published_by, created_at)
    select ? || ':' || v, ?, v, 'superseded', 'h', case when v > ? - 20 or v = 2 then '{}' else null end,
      case when v = ? then 0 else 1 end, 'u', 1 from nums`).bind(n, sid, sid, n, n).run();
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
    select ?, 'exp_hero', 'r' || v, v, '{}', 'h', case when v = 2 then null else 'delivered' end from nums`).bind(n, sid).run();
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into static_deploy_requests (site_id, epoch, seq, version, requested_at, input_digest)
    select ?, 1, v, v, 1, case when v = 3 then null else 'h' end from nums`).bind(n, sid).run();
  await env.DB.prepare("update sites set active_version = ?, static_served_version = ? where id = ?").bind(n, n, sid).run();
}

/** 1 サイトに 50 run × 60 行の届く定義(どれも確認が要る)。世代は最新の版の行だけ NULL(出し直しの前)。 */
async function seedRuns(sid: string) {
  await seed(sid, 3000);
  await env.DB.prepare("delete from experiment_delivered_definitions where site_id = ?").bind(sid).run();
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < 3000)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash, settled)
    select ?, 'exp_hero', 'run' || ((v - 1) / 60 + 1), v, case when v = 3000 then null else '{"epoch":1,"seq":' || v || '}' end, '{}', 'h', null from nums`).bind(sid).run();
}

/** 配信の確認(外側の読み取り・run ごとの読み直し)・公開後の世代の記録・本体の掃除の rows_read と、読み直しの計画。 */
async function measureDeliveryReads(sid: string) {
  const observed = observeRetentionDb(env);
  const db = getDb(observed.env);
  await confirmDeliveries(db, sid, { history: [], historyFrom: null, partial: true }, NOW, async () => {}, null);
  const confirmCalls = [...observed.calls];
  await setDeliveredGeneration(db, sid, 3000, { epoch: 1, seq: 3000 });
  const setGen = observed.calls.slice(confirmCalls.length);
  await env.DB.prepare("delete from cron_cursors where job = 'config-cleanup:body-prune'").run();
  const before = observed.calls.length;
  await prunePublishBodies(observed.env, db, { siteId: sid, keep: [], keepCount: 20, siteCap: 500, dailyCap: 5000, runId: crypto.randomUUID(), now: NOW });
  const prune = observed.calls.slice(before);
  const sum = (calls: typeof observed.calls) => calls.reduce((a, q) => a + q.meta.rows_read, 0);
  const isDefs = (q: { sql: string }) => /^select .* from "experiment_delivered_definitions"/.test(q.sql);
  const outer = confirmCalls.filter((q) => isDefs(q) && q.sql.includes('"run_id" in (select'));
  const fresh = confirmCalls.filter((q) => isDefs(q) && q.sql.includes('"run_id" = ?') && q.sql.includes('"delivered_until"'));
  const freshPlans = await Promise.all(fresh.map(async (q) => (await env.DB.prepare("EXPLAIN QUERY PLAN " + q.sql).bind(...q.binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n")));
  return { outer: sum(outer), fresh: sum(fresh), freshCalls: fresh.length, freshPlans, setGen: sum(setGen), prune: sum(prune) };
}

describe("publish retention indexes", () => {
  it("adds five indexes without changing existing rows and is repeatable", async () => {
    await resetStorage({ before: "0028" });
    const { sid } = await siteWithRunning();
    await seed(sid, 30);
    const tables = ["publishes", "experiment_delivered_definitions", "static_deploy_requests"];
    const rows = () => Promise.all(tables.map((t) => env.DB.prepare(`select * from ${t} order by rowid`).all().then((r) => r.results)));
    const before = await rows();
    await applyControlMigrations();
    const indexes = await env.DB.prepare("select name, sql from sqlite_master where type = 'index'").all<{ name: string; sql: string }>();
    expect(indexes.results.map((r) => r.name)).toEqual(expect.arrayContaining(INDEXES));
    expect(indexes.results.find((r) => r.name === INDEXES[2])!.sql).toMatch(/WHERE settled IS NULL OR settled = 'unknown'$/);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0028"))!;
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(await rows()).toEqual(before);
  });

  it("preserves the old predicate for every settled state and latest/nonlatest row", async () => {
    const { sid } = await siteWithRunning();
    for (const [i, state] of [null, "delivered", "overtaken", "unknown"].entries()) {
      for (const v of [1, 2]) await env.DB.prepare(`insert into experiment_delivered_definitions
        (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
        values (?, 'exp_hero', ?, ?, '{}', 'h', ?)`).bind(sid, `state-${i}`, i * 2 + v, state).run();
    }
    const db = getDb(env);
    const query = () => db.selectFrom("experiment_delivered_definitions as u").select("u.publish_version").orderBy("u.publish_version");
    const old = sql<boolean>`(u.settled is null or (u.settled = 'unknown' and u.publish_version = (select max(x.publish_version) from experiment_delivered_definitions x where x.run_id = u.run_id)))`;
    expect(await query().where(needsDeliveryConfirmation("u")).execute()).toEqual(await query().where(old).execute());
    expect(await query().where(needsDeliveryConfirmation("u")).execute()).toEqual([{ publish_version: 1 }, { publish_version: 2 }, { publish_version: 8 }]);
    // 断片を not や or の中に置いても、旧式と同じ行を選ぶ(外側の括弧が要る)
    expect(await query().where(sql<boolean>`not ${needsDeliveryConfirmation("u")}`).execute()).toEqual(await query().where(sql<boolean>`not ${old}`).execute());
  });

  it("bounds reads by live rows, using indexes without forcing the planner", async () => {
    const { sid } = await siteWithRunning();
    const samples = [];
    for (const n of [300, 3000]) {
      if (n !== 300) {
        for (const table of ["publishes", "experiment_delivered_definitions", "static_deploy_requests"]) await env.DB.prepare(`delete from ${table} where site_id = ?`).bind(sid).run();
      }
      await seed(sid, n);
      // カウンターの初回作成/既存更新の差も揃えて、履歴の長さだけを変える。
      await env.DB.prepare("delete from cron_cursors where job = 'config-cleanup:body-prune'").run();
      const observed = observeRetentionDb(env);
      const db = getDb(observed.env);
      const prune = await prunePublishBodies(observed.env, db, { siteId: sid, keep: [], keepCount: 20, siteCap: 500, dailyCap: 5000, runId: crypto.randomUUID(), now: NOW });
      expect(prune.pruned).toBe(0);
      expect(await sitesNeedingDeliveryConfirmation(db)).toEqual([sid]);
      expect((await cleanupOldVersions(observed.env, db, sid, n, NOW)).deleted).toBe(0);
      await setDeliveredGeneration(db, sid, n, { epoch: 1, seq: 1 });
      const reads = observed.calls.map((q) => q.meta.rows_read);
      // keep 20 + 固定の守る行。上限を上げるときは履歴走査の再発でない理由を記録する。
      expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(200);
      const plans = await Promise.all(observed.calls.map(async (q) => (await env.DB.prepare("EXPLAIN QUERY PLAN " + q.sql).bind(...q.binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n")));
      for (const plan of plans.slice(0, 2)) {
        expect(plan.match(/publishes_with_body/g)?.length).toBe(2);
        expect(plan).toContain("static_deploy_requests_without_digest");
        expect(plan).toContain("experiment_delivered_definitions_unsettled");
        expect(plan).toContain("experiment_delivered_definitions_by_run");
      }
      expect(plans[2]).toContain("experiment_delivered_definitions_unsettled");
      expect(plans[4]).toContain("publishes_kv_live");
      expect(plans[5]).toContain("experiment_delivered_definitions_without_generation");
      samples.push(reads);
    }
    expect(samples[1]).toEqual(samples[0]);
  });

  // 0028 の索引を足しても、統計の有無にかかわらず、配信の確認の読み取りが索引の無いときより増えないこと
  // (全行の索引 (site_id, publish_version) を足したときは、統計の無い DB で run ごとの読み直しがサイトの全行の読み取りになった)
  it.each([false, true])("keeps delivery confirmation reads at or below the no-index plan (analyzed: %s)", async (analyzed) => {
    const { sid } = await siteWithRunning();
    await seedRuns(sid);
    if (analyzed) await env.DB.prepare("analyze").run();
    const indexed = await measureDeliveryReads(sid);
    for (const name of RETENTION_INDEXES) await env.DB.prepare(`drop index if exists ${name}`).run();
    if (analyzed) await env.DB.prepare("analyze").run();
    const baseline = await measureDeliveryReads(sid);
    expect(indexed.freshCalls).toBe(50);
    for (const plan of indexed.freshPlans) expect(plan).toContain("experiment_delivered_definitions_by_run");
    // run ごとの読み直しは run の行(60)の程度。サイトの全行(3,000)にならない
    expect(indexed.fresh).toBeLessThanOrEqual(50 * 61);
    for (const key of ["outer", "fresh", "setGen", "prune"] as const) expect(indexed[key], key).toBeLessThanOrEqual(baseline[key]);
  });
});
