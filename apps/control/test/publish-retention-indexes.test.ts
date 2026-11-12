import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { controlFacts } from "../src/results/report";
import { getDb } from "../src/db";
import { prunePublishBodies } from "../src/publish-body-retention";
import { cleanupOldVersions } from "../src/publish";
import { confirmDeliveries, needsDeliveryConfirmation, setDeliveredGeneration, sitesNeedingDeliveryConfirmation } from "../src/results/delivered";
import { resetStorage, applyControlMigrations } from "./apply-migrations";
import { createSite, createExperiment, siteWithRunning } from "./helpers";
import { observeRetentionDb } from "./publish-retention-observer";
import { RETENTION_INDEXES } from "./retention-indexes";

const INDEXES = [...RETENTION_INDEXES];
const NOW = 1_800_000_000_000;

/** run ごとに本番と同じ実行中のエクスペリエンスを置く。 */
async function seedExperiments(sid: string, n: number, prefix: string) {
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into experiments (site_id, id, name, status, run_id, url_match_json, created_by, updated_by, created_at, updated_at)
    select ?, ? || v, 'test', 'running', ? || v, '{}', 'u', 'u', 1, 1 from nums`)
    .bind(n, sid, prefix, prefix).run();
}

async function seed(sid: string, n: number) {
  await env.DB.prepare("delete from experiments where site_id = ? and id like 'r%'").bind(sid).run();
  await seedExperiments(sid, n, "r");
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into publishes (id, site_id, version, status, config_hash, config_json, kv_deleted, published_by, created_at)
    select ? || ':' || v, ?, v, 'superseded', 'h', case when v > ? - 20 or v = 2 then '{}' else null end,
      case when v = ? then 0 else 1 end, 'u', 1 from nums`).bind(n, sid, sid, n, n).run();
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
    select ?, 'r' || v, 'r' || v, v, '{}', 'h', case when v = 2 then null else 'delivered' end from nums`).bind(n, sid).run();
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into static_deploy_requests (site_id, epoch, seq, version, requested_at, input_digest)
    select ?, 1, v, v, 1, case when v = 3 then null else 'h' end from nums`).bind(n, sid).run();
  await env.DB.prepare("update sites set active_version = ?, static_served_version = ? where id = ?").bind(n, n, sid).run();
}

/** 1 サイトに 50 run × 60 行の届く定義(どれも確認が要る)。世代は最新の版の行だけ NULL(出し直しの前)。 */
async function seedRuns(sid: string) {
  await seed(sid, 3000);
  await env.DB.prepare("delete from experiment_delivered_definitions where site_id = ?").bind(sid).run();
  await env.DB.prepare("delete from experiments where site_id = ? and id like 'r%'").bind(sid).run();
  await seedExperiments(sid, 50, "run");
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < 3000)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash, settled)
    select ?, 'run' || ((v - 1) / 60 + 1), 'run' || ((v - 1) / 60 + 1), v, case when v = 3000 then null else '{"epoch":1,"seq":' || v || '}' end, '{}', 'h', null from nums`).bind(sid).run();
}

/** 配信の確認(外側の読み取り・run ごとの読み直し)・公開後の世代の記録・本体の掃除の rows_read と、読み直しの計画。 */
async function measureDeliveryReads(sid: string, history: Array<{generation: {epoch: number; seq: number}; digest: string; deployedAt: string}> = []) {
  const observed = observeRetentionDb(env);
  const db = getDb(observed.env);
  await confirmDeliveries(db, sid, { history, historyFrom: null, partial: true }, NOW, async () => {});
  const confirmCalls = [...observed.calls];
  const factStart = observed.calls.length;
  await controlFacts(db, sid, { id: "focus1", run_id: "focus1" });
  const factCalls = observed.calls.slice(factStart).filter((q) => q.sql.includes('from "experiment_delivery_changes"'));
  // controlFacts の文の数を決め打ちしない(B242 impl-review R7)
  const genStart = observed.calls.length;
  await setDeliveredGeneration(db, sid, 3000, { epoch: 1, seq: 3000 });
  const setGen = observed.calls.slice(genStart);
  await env.DB.prepare("delete from cron_cursors where job = 'config-cleanup:body-prune'").run();
  const before = observed.calls.length;
  await prunePublishBodies(observed.env, db, { siteId: sid, keep: [], keepCount: 20, siteCap: 500, dailyCap: 5000, runId: crypto.randomUUID(), now: NOW });
  const prune = observed.calls.slice(before).filter((q) => q.sql.startsWith("insert") || q.sql.startsWith("update"));
  const sum = (calls: typeof observed.calls) => calls.reduce((a, q) => a + q.meta.rows_read, 0);
  const isDefs = (q: { sql: string }) => /^select .* from "experiment_delivered_definitions"/.test(q.sql);
  const isOuter = (q: { sql: string }) => q.sql.includes("cross join experiment_delivered_definitions") || (isDefs(q) && q.sql.includes('"run_id" in (select'));
  const isFresh = (q: { sql: string }) => isDefs(q) && q.sql.includes('"run_id" = ?') && q.sql.includes('"delivered_until"');
  const isRequests = (q: { sql: string }) => q.sql.includes("cross join static_deploy_requests");
  const isChanges = (q: { sql: string }) => q.sql.includes('from "experiment_delivery_changes"') && q.sql.startsWith("select");
  const isPublishes = (q: { sql: string }) => /^select .* from "publishes"/.test(q.sql);
  const isWrite = (q: { sql: string }) => /^\s*(insert|update|delete)\b/.test(q.sql);
  // 字面で拾えなかった文は 0 行と数えて上限の検査を素通りするため、確認の各文がちょうど 1 つの区分に入り、
  // 外側の文が 1 本・変更履歴が run ごとに 1 本・controlFacts の変更履歴が 1 本であることを先に確かめる(B242 impl-review R1)
  const kinds = [isOuter, isFresh, isRequests, isChanges, isPublishes, isWrite];
  expect(confirmCalls.map((q) => kinds.filter((k) => k(q)).length), "every confirmation statement is classified once").toEqual(confirmCalls.map(() => 1));
  const outer = confirmCalls.filter(isOuter);
  const fresh = confirmCalls.filter(isFresh);
  const requests = confirmCalls.filter(isRequests);
  const changes = confirmCalls.filter(isChanges);
  expect(outer, "outer statement").toHaveLength(1);
  expect(changes.length, "change reads per run").toBe(fresh.length);
  expect(factCalls, "controlFacts change read").toHaveLength(1);
  const plans = async (calls: typeof observed.calls) => Promise.all(calls.map(async (q) => (await env.DB.prepare("EXPLAIN QUERY PLAN " + q.sql).bind(...q.binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n")));
  return { outer: sum(outer), requests: sum(requests), fresh: sum(fresh), changes: sum(changes), facts: sum(factCalls),
    outerPlans: await plans(outer), requestPlans: await plans(requests), changePlans: await plans(changes), factPlans: await plans(factCalls),
    requestCalls: requests.length, freshCalls: fresh.length, confirmCalls: confirmCalls.length, freshPlans: await plans(fresh), setGen: sum(setGen), pruneCalls: prune.length, prune: sum(prune) };

}

/**
 * measureDeliveryReads が書き換える列(世代の記録・本体の掃除)を測る前の値に戻す関数を返す。
 * 索引あり・なしを同じ DB で続けて測るとき、先の側の書き込みで後の側の読む行が変わらないようにする(B242 impl-review R2)。
 */
async function restorableMeasuredWrites(sid: string) {
  const gens = (await env.DB.prepare("select id from experiment_delivered_definitions where site_id = ? and static_generation is null").bind(sid).all<{ id: number }>()).results.map((r) => r.id);
  const bodies = (await env.DB.prepare("select id, config_json as c from publishes where site_id = ? and config_json is not null").bind(sid).all<{ id: string; c: string }>()).results;
  return async () => {
    await env.DB.prepare("update experiment_delivered_definitions set static_generation = null where id in (select value from json_each(?))").bind(JSON.stringify(gens)).run();
    await env.DB.prepare(`update publishes set config_json = json_extract(j.value, '$.c'), body_pruned_at = null
      from json_each(?) j where publishes.id = json_extract(j.value, '$.id')`).bind(JSON.stringify(bodies)).run();
    expect(await env.DB.prepare("select count(*) as n from experiment_delivered_definitions where site_id = ? and static_generation is null").bind(sid).first<number>("n")).toBe(gens.length);
    expect(await env.DB.prepare("select count(*) as n from publishes where site_id = ? and config_json is not null").bind(sid).first<number>("n")).toBe(bodies.length);
  };
}

/** 最初の run だけ未確定。短い履歴でも末尾の履歴点2901..3000は同じ世代を持つ。 */
async function seedFocused(sid: string, n: number, opts: { skew?: boolean; expired?: number } = {}) {
  for (const table of ["experiment_delivery_changes", "experiment_delivered_definitions", "static_deploy_requests", "publishes"]) await env.DB.prepare(`delete from ${table} where site_id = ?`).bind(sid).run();
  await env.DB.prepare("delete from experiments where site_id = ? and (id like 'focus%' or id like 'expired%')").bind(sid).run();
  const total = opts.skew ? n + 60 : n;
  await seedExperiments(sid, opts.skew ? 2 : n / 60, "focus");
  const ver = opts.skew ? "v" : "case when v <= 60 then v else v + 3000 - ? end";
  const binds = opts.skew ? [total, sid] : [total, n, sid];
  // 名前付きの CTE で、履歴の長さと世代の分布を分ける。
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?), versions as (select v, ${ver} as version from nums)
    insert into publishes (id, site_id, version, status, config_hash, config_json, kv_deleted, published_by, created_at)
    select ? || ':' || version, ?, version, 'superseded', 'h', case when v > ? - 20 or v = 2 then '{}' else null end, 1, 'u', 1 from versions`)
    .bind(...binds, sid, total).run();
  const exp = opts.skew ? "case when v <= 60 then 'focus1' else 'focus2' end" : "'focus' || ((v - 1) / 60 + 1)";
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?), versions as (select v, ${ver} as version from nums)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash, delivered_from, settled)
    select ?, ${exp}, ${exp}, version, json_object('epoch', 1, 'seq', version),
      json_object('variants', json_array(json_object('id', 'b', 'changes', json_array(json_object('text', v)))), 'urlMatch', json('{}'), 'targeting', null, 'primaryGoal', null),
      'h' || version, case when v = 60 and ? then null else v * 1000 end,
      case when v = 60 then case when ? then null else 'unknown' end else 'delivered' end from versions`)
    .bind(...binds, opts.skew ? 1 : 0, opts.skew ? 1 : 0).run();
  // 時刻を持つ確定行の区間も事前に完成させ、計測で区間補完の書き込みが起きないようにする。
  await env.DB.prepare(`update experiment_delivered_definitions as d set delivered_until =
    (select min(x.delivered_from) from experiment_delivered_definitions x where x.run_id = d.run_id and x.publish_version > d.publish_version)
    where d.site_id = ? and d.delivered_from is not null`).bind(sid).run();
  await env.DB.prepare(`insert into static_deploy_requests (site_id, epoch, seq, version, requested_at, input_digest)
    select site_id, 1, publish_version, publish_version, 1, 'd' || publish_version from experiment_delivered_definitions where site_id = ?`).bind(sid).run();
  for (let i = 1; i <= (opts.expired ?? 0); i++) {
    const id = `expired${i}`;
    await env.DB.prepare(`insert into experiments (site_id, id, name, status, run_id, stopped_at, url_match_json, created_by, updated_by, created_at, updated_at)
      values (?, ?, 'test', 'archived', ?, ?, '{}', 'u', 'u', 1, 1)`).bind(sid, id, id, NOW - 9 * 86400000).run();
    await env.DB.prepare(`insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
      values (?, ?, ?, ?, '{}', 'h', ?)`).bind(sid, id, id, 4000 + i, i % 2 ? null : "unknown").run();
  }
  await env.DB.prepare("update sites set active_version = ?, static_served_version = ? where id = ?").bind(opts.skew ? total : 3000, opts.skew ? total : 3000, sid).run();
  await env.DB.prepare("delete from cron_cursors where job = 'config-cleanup:body-prune'").run();
}

async function seedChanges(sid: string, other: string) {
  // 5,900行のうち対象runは59行。残りは同サイト2,841行・別サイト3,000行。
  await env.DB.prepare(`with recursive nums(v) as (select 2 union all select v+1 from nums where v < 60)
    insert into experiment_delivery_changes (site_id, experiment_id, run_id, publish_version, at, by, parts_json)
    select ?, 'focus1', 'focus1', v, v * 1000, 'u', '["variants.b.changes"]' from nums`).bind(sid).run();
  for (const [site, id, run, count] of [[sid, "focus2", "focus2", 2841], [other, "exp_hero", "other", 3000]] as const) {
    await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
      insert into experiment_delivery_changes (site_id, experiment_id, run_id, publish_version, at, by, parts_json)
      select ?, ?, ?, v, v, 'u', '[]' from nums`).bind(count, site, id, run).run();
  }
  expect(await env.DB.prepare("select count(*) as n from experiment_delivery_changes").first<number>("n")).toBe(5900);
}
const historyPoints = () => Array.from({ length: 100 }, (_, i) => ({ generation: { epoch: 1, seq: 2901 + i }, digest: `d${2901 + i}`, deployedAt: new Date(NOW).toISOString() }));
const readingCounts = (r: Awaited<ReturnType<typeof measureDeliveryReads>>) => ({ outer: r.outer, requests: r.requests, fresh: r.fresh, changes: r.changes, facts: r.facts });

async function expectRunOrderedUnsettledIndex() {
  const ddl = await env.DB.prepare("select sql from sqlite_master where type = 'index' and name = 'experiment_delivered_definitions_unsettled'").first<string>("sql");
  expect(ddl).toMatch(/\(site_id, run_id, publish_version\)/);
  expect(ddl).toMatch(/WHERE settled IS NULL OR settled = 'unknown'$/);
}

/** 他のrunの確定履歴だけを増やす。既存の50 runとは重ならない。 */
async function addSettledHistory(sid: string, n: number) {
  if (!n) return;
  await seedExperiments(sid, 1, "history");
  await env.DB.prepare(`with recursive nums(v) as (select 1 union all select v+1 from nums where v < ?)
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
    select ?, 'history1', 'history1', 4000+v, '{}', 'h', 'delivered' from nums`).bind(n, sid).run();
}

describe("publish retention indexes", () => {
  it("adds five indexes without changing existing rows and is repeatable", async () => {
    await resetStorage({ before: "0028" });
    const { sid } = await siteWithRunning();
    await seed(sid, 30);
    const tables = ["publishes", "experiment_delivered_definitions", "static_deploy_requests"];
    const rows = () => Promise.all(tables.map((t) => env.DB.prepare(`select * from ${t} order by rowid`).all().then((r) => r.results)));
    const before = await rows();
    await applyControlMigrations({ before: "0029" });
    const after28 = (await env.DB.prepare("select name from sqlite_master where type = 'index'").all<{name: string}>()).results.map((r) => r.name);
    expect(after28).toEqual(expect.arrayContaining([...INDEXES.filter((n) => n !== "experiment_delivery_changes_by_run"), "static_deploy_requests_without_digest"]));
    expect(after28).not.toContain("experiment_delivery_changes_by_run");
    await applyControlMigrations();
    const indexes = await env.DB.prepare("select name, sql from sqlite_master where type = 'index'").all<{ name: string; sql: string }>();
    expect(indexes.results.map((r) => r.name)).toEqual(expect.arrayContaining(INDEXES));
    expect(indexes.results.find((r) => r.name === "experiment_delivered_definitions_unsettled")!.sql).toMatch(/WHERE settled IS NULL OR settled = 'unknown'$/);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0028"))!;
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(await rows()).toEqual(before);
    await expectRunOrderedUnsettledIndex();
  });

  it.each(["previously_applied", "same_run", "repeat"])("0029 leaves the same indexes and rows: %s", async (mode) => {
    await resetStorage({ before: "0028" });
    if (mode === "previously_applied") await applyControlMigrations({ before: "0029" });
    const { sid } = await siteWithRunning();
    await seed(sid, 30);
    const snapshot = () => Promise.all(["publishes", "experiment_delivered_definitions", "static_deploy_requests", "experiment_delivery_changes"].map(async (t) => (await env.DB.prepare(`select * from ${t} order by rowid`).all()).results));
    const before = await snapshot();
    await applyControlMigrations();
    if (mode === "repeat") for (const q of env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0029"))!.queries) await env.DB.prepare(q).run();
    const names = (await env.DB.prepare("select name from sqlite_master where type = 'index'").all<{name: string}>()).results.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(INDEXES));
    expect(names).not.toContain("static_deploy_requests_without_digest");
    expect(await snapshot()).toEqual(before);
    await expectRunOrderedUnsettledIndex();
  });

  it("selects rows by evidence lifetime, preserving partial confirmations (B242 2-A)", async () => {
    const { sid } = await siteWithRunning();
    // c1..c13 + exact grace boundary. Two rows only where the case is nonlatest.
    const cases: Array<[string, string, number | null, string | null, number | null, boolean, boolean]> = [
      ["c1", "archived", NOW - 30 * 86400000, "unknown", null, false, false],
      ["c2", "archived", NOW - 30 * 86400000, null, null, false, false],
      ["c3", "archived", NOW - 86400000, null, null, false, true],
      ["c4", "archived", NOW - 86400000, "unknown", null, false, true],
      ["c5", "paused", null, null, null, false, true],
      ["c6", "paused", null, "unknown", null, false, true],
      ["c7", "running", null, null, null, true, true],
      ["c8", "running", null, "unknown", null, true, false],
      ["c9", "archived", null, null, null, false, false],
      ["c10", "running", null, null, null, false, false],
      ["c11", "archived", NOW - 30 * 86400000, null, 3000, false, true],
      ["c12", "archived", NOW - 30 * 86400000, "unknown", 3000, true, true],
      ["c13", "running", null, "unknown", 3000, true, true],
      ["boundary", "archived", NOW - 8 * 86400000, null, null, false, true],
    ];
    const expected: number[] = [];
    for (const [i, [id, status, stopped, state, from, nonlatest, wanted]] of cases.entries()) {
      const version = i * 2 + 1;
      await env.DB.prepare(`insert into experiments (site_id, id, name, status, run_id, stopped_at, url_match_json, created_by, updated_by, created_at, updated_at)
        values (?, ?, 'test', ?, ?, ?, '{}', 'u', 'u', 1, 1)`).bind(sid, id, status, id === "c10" ? "different-run" : id, stopped).run();
      await env.DB.prepare(`insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled, delivered_from)
        values (?, ?, ?, ?, '{}', 'h', ?, ?)`).bind(sid, id, id, version, state, from).run();
      if (nonlatest) await env.DB.prepare(`insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash, settled)
        values (?, ?, ?, ?, '{}', 'other', ?)`).bind(sid, id, id, version + 1, id === "c12" ? null : "delivered").run();
      if (wanted) expected.push(version);
    }
    const db = getDb(env);
    const query = () => db.selectFrom("experiment_delivered_definitions as u").select("u.publish_version").orderBy("u.publish_version");
    expect((await query().where(needsDeliveryConfirmation("u", NOW)).execute()).map((r) => r.publish_version)).toEqual(expected);
    const live = sql<boolean>`u.experiment_id in ('c5', 'c6', 'c7', 'c8', 'c13')`;
    const old = sql<boolean>`(u.settled is null or (u.settled = 'unknown' and u.publish_version = (select max(x.publish_version) from experiment_delivered_definitions x where x.run_id = u.run_id)))`;
    const before = await query().where(live).where(old).execute();
    const after = await query().where(live).where(needsDeliveryConfirmation("u", NOW)).execute();
    expect(after).toEqual([...before, { publish_version: 25 }]); // c13 alone is added
    expect(await query().where(live).where(sql<boolean>`not ${needsDeliveryConfirmation("u", NOW)}`).execute())
      .toEqual((await query().where(live).where(sql<boolean>`not ${old}`).execute()).filter((r) => r.publish_version !== 25));
  });

  it.each([false, true])("delivery predicate with L keeps the unsettled index in all three callers (analyzed: %s) (B242 2-A)", async (analyzed) => {
    const { sid } = await siteWithRunning();
    await seed(sid, 3000); // 全行対象のSCANはmatrixで不増加を検査。ここでは選択性のある索引の計画を見る。
    if (analyzed) await env.DB.prepare("analyze").run();
    const observed = observeRetentionDb(env);
    const db = getDb(observed.env);
    await sitesNeedingDeliveryConfirmation(db, { now: NOW });
    await db.selectFrom("experiment_delivered_definitions as u").select("u.run_id").distinct().where("u.site_id", "=", sid).where(needsDeliveryConfirmation("u", NOW)).execute();
    await prunePublishBodies(observed.env, db, { siteId: sid, keep: [], keepCount: 20, siteCap: 500, dailyCap: 5000, runId: crypto.randomUUID(), now: NOW });
    expect(observed.calls).toHaveLength(4); // list + inner + both pruning statements
    for (const q of observed.calls) {
      const plan = (await env.DB.prepare("EXPLAIN QUERY PLAN " + q.sql).bind(...q.binds).all<{detail: string}>()).results.map((r) => r.detail).join("\n");
      expect(plan).toContain("experiment_delivered_definitions_unsettled");
      expect(plan).toContain("sqlite_autoindex_experiments_1");
    }
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
      expect(await sitesNeedingDeliveryConfirmation(db, { now: NOW })).toEqual([sid]);
      expect((await cleanupOldVersions(observed.env, db, sid, n, NOW)).deleted).toBe(0);
      await setDeliveredGeneration(db, sid, n, { epoch: 1, seq: 1 });
      const reads = observed.calls.map((q) => q.meta.rows_read);
      // keep 20 + 固定の守る行。上限を上げるときは履歴走査の再発でない理由を記録する。
      expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(200);
      const plans = await Promise.all(observed.calls.map(async (q) => (await env.DB.prepare("EXPLAIN QUERY PLAN " + q.sql).bind(...q.binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n")));
      for (const plan of plans.slice(0, 2)) {
        expect(plan.match(/publishes_with_body/g)?.length).toBe(2);
        expect(plan).not.toContain("static_deploy_requests_without_digest");
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

  it.each([false, true])("confirmation reads follow the unsettled run, not the site history (analyzed: %s) (B242 1-A)", async (analyzed) => {
    const { sid, owner } = await siteWithRunning();
    const { id: other } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, other, { id: "exp_hero" });
    const samples = [];
    for (const n of [300, 3000]) {
      await env.DB.prepare("delete from experiment_delivery_changes").run();
      await seedFocused(sid, n);
      await seedChanges(sid, other);
      if (analyzed) await env.DB.prepare("analyze").run();
      const r = await measureDeliveryReads(sid, historyPoints());
      console.log("B242 confirmation", JSON.stringify({ analyzed, n, ...readingCounts(r), confirmCalls: r.confirmCalls }));
      samples.push(r);
    }
    expect(readingCounts(samples[1]!)).toEqual(readingCounts(samples[0]!));
    for (const r of samples) {
      expect(r.freshCalls).toBe(1);
      expect(r.confirmCalls).toBe(5); // 3 reads + 2 per run; no writes
      expect(r.requestCalls).toBe(1);
      expect(r.requestPlans).toHaveLength(1);
      expect(r.requests).toBeGreaterThan(0);
      // 行60 + 並べ替え60 + run終端1 + 候補1行×最大3 + 終端2。
      expect(r.outer).toBeLessThanOrEqual(2 * 60 + 1 + 3 * 1 + 2);
      // JSON160世代 + 主キー160行。
      expect(r.requests).toBeLessThanOrEqual(2 * 160);
      // run索引の60行 + 終端1(並べ替えなし)。
      expect(r.fresh).toBeLessThanOrEqual(60 + 1);
      // run索引の最大60行 + 終端1(並べ替えなし)。
      expect(r.changes).toBeLessThanOrEqual(60 + 1);
      // run索引の最大60行 + at順の並べ替え60行 + 終端1。
      expect(r.facts).toBeLessThanOrEqual(2 * 60 + 1);
      for (const plan of r.outerPlans) expect(plan).toContain("experiment_delivered_definitions_unsettled");
      for (const plan of [...r.outerPlans, ...r.freshPlans]) expect(plan).toContain("experiment_delivered_definitions_by_run");
      for (const plan of [...r.changePlans, ...r.factPlans]) expect(plan).toContain("experiment_delivery_changes_by_run");
      for (const plan of r.requestPlans) expect(plan).toMatch(/sqlite_autoindex_static_deploy_requests_1.*site_id=\? AND epoch=\? AND seq=\?/);
    }
  });

  it("confirmation on a site without unsettled rows reads no definition rows (B242 1-A)", async () => {
    const { sid } = await siteWithRunning();
    await seedFocused(sid, 3000);
    await env.DB.prepare("update experiment_delivered_definitions set settled = 'delivered' where site_id = ?").bind(sid).run();
    const r = await measureDeliveryReads(sid);
    expect(r.confirmCalls).toBe(1);
    expect(r.outer).toBeLessThanOrEqual(2); // 新しい部分索引でのDISTINCT終端も含む。
  });

  it.each([false, true])("expired_unsettled_rows_grow_reads_by_their_count_only (analyzed: %s) (B242 2-A)", async (analyzed) => {
    const { sid } = await siteWithRunning();
    const samples: Array<{outer: number; list: number; prune: number}> = [];
    for (const [n, expired] of [[300, 10], [3000, 10], [3000, 100]]) {
      await seedFocused(sid, n!, { skew: true, expired });
      if (analyzed) await env.DB.prepare("analyze").run();
      const observed = observeRetentionDb(env);
      expect(await sitesNeedingDeliveryConfirmation(getDb(observed.env), { now: NOW })).toEqual([sid]);
      const list = observed.calls.reduce((a, q) => a + q.meta.rows_read, 0);
      const r = await measureDeliveryReads(sid);
      const counts = { outer: r.outer, list, prune: r.prune };
      console.log("B242 expired", JSON.stringify({ analyzed, n, expired, ...counts }));
      samples.push(counts);
    }
    expect(samples[1]).toEqual(samples[0]);
    for (const [key, statements] of [["outer", 1], ["list", 1], ["prune", 2]] as const) {
      const diff = samples[2]![key] - samples[1]![key];
      expect(diff, key).toBeGreaterThan(0);
      expect(diff, key).toBeLessThanOrEqual(90 * 3 * statements);
    }
  });

  // 通常の分布では統計×索引の4組で読み取りが悪化しない。U4の限定した例外は別の件で検査。
  describe.each(["all", "one", "skew", "none", "half"] as const)("index matrix (%s)", (shape) => {
    it.each([false, true])("keeps delivery confirmation reads at or below the no-index plan (analyzed: %s)", async (analyzed) => {
      const { sid } = await siteWithRunning();
      if (shape === "skew") await seedFocused(sid, 3000, { skew: true });
      else {
        await seedRuns(sid);
        if (shape !== "all") await env.DB.prepare(`update experiment_delivered_definitions set settled = 'delivered' where site_id = ? ${shape === "one" ? "and run_id <> 'run1'" : shape === "half" ? "and publish_version > 1500" : ""}`).bind(sid).run();
      }
      if (analyzed) await env.DB.prepare("analyze").run();
      const selected = await getDb(env).selectFrom("experiment_delivered_definitions as u").select("u.run_id").distinct().where(needsDeliveryConfirmation("u", NOW)).execute();
      const count = shape === "all" ? 50 : shape === "half" ? 25 : shape === "none" ? 0 : 1;
      expect(selected).toHaveLength(count);
      const restore = await restorableMeasuredWrites(sid);
      const indexed = await measureDeliveryReads(sid);
      await restore();
      for (const name of RETENTION_INDEXES) await env.DB.prepare(`drop index if exists ${name}`).run();
      if (analyzed) await env.DB.prepare("analyze").run();
      const baseline = await measureDeliveryReads(sid);
      console.log("B242 matrix", JSON.stringify({ shape, analyzed, indexed: { ...readingCounts(indexed), prune: indexed.prune }, baseline: { ...readingCounts(baseline), prune: baseline.prune } }));
      expect(indexed.pruneCalls).toBe(2);
      expect(baseline.pruneCalls).toBe(2);
      expect(indexed.freshCalls).toBe(count);
      expect(indexed.requestCalls).toBe(count ? 1 : 0);
      expect(indexed.requestPlans).toHaveLength(count ? 1 : 0);
      for (const plan of indexed.freshPlans) expect(plan).toContain("experiment_delivered_definitions_by_run");
      expect(indexed.fresh).toBeLessThanOrEqual(count * 61);
      for (const key of ["outer", "requests", "fresh", "changes", "facts", "setGen", "prune"] as const) expect(indexed[key], key).toBeLessThanOrEqual(baseline[key]);
    });
  });

  it("early unsettled rows in every run stay within two reads per unsettled row of the no-index plan (analyzed) (B242 1-A, U4)", async () => {
    for (const k of [5, 11, 12]) {
      const samples = [];
      for (const extra of [0, 300, 3000]) {
        await resetStorage();
        const { sid } = await siteWithRunning();
        await seedRuns(sid);
        await env.DB.prepare("update experiment_delivered_definitions set settled = case when (publish_version - 1) % 60 < ? then null else 'delivered' end where site_id = ?").bind(k, sid).run();
        await addSettledHistory(sid, extra);
        await env.DB.prepare("analyze").run();
        const unsettled = await env.DB.prepare("select count(*) as n from experiment_delivered_definitions where site_id = ? and (settled is null or settled = 'unknown')").bind(sid).first<number>("n");
        expect(unsettled).toBe(50 * k);
        const restore = await restorableMeasuredWrites(sid);
        const indexed = await measureDeliveryReads(sid);
        await restore();
        for (const name of RETENTION_INDEXES) await env.DB.prepare(`drop index if exists ${name}`).run();
        await env.DB.prepare("analyze").run();
        const baseline = await measureDeliveryReads(sid);
        expect(indexed.requestCalls).toBe(1);
        expect(indexed.requestPlans).toHaveLength(1);
        expect(indexed.outer).toBeLessThanOrEqual(baseline.outer + 2 * 50 * k);
        if (k === 12 || extra === 3000) expect(indexed.outer).toBeLessThanOrEqual(baseline.outer);
        console.log("B242 U4", JSON.stringify({ k, extra, outer: indexed.outer, baseline: baseline.outer, unsettled }));
        samples.push(indexed.outer);
      }
      expect(samples).toEqual([samples[0], samples[0], samples[0]]);
    }
  });

  it.each(["all", "early11", "one"] as const)("migration keeps old table statistics without unsettled-index statistics: %s (B242 U4)", async (shape) => {
    const samples = [];
    for (const extra of [300, 3000]) {
      await resetStorage({ before: "0029" });
      const { sid } = await siteWithRunning();
      await seedRuns(sid);
      if (shape === "early11") await env.DB.prepare("update experiment_delivered_definitions set settled = case when (publish_version - 1) % 60 < 11 then null else 'delivered' end where site_id = ?").bind(sid).run();
      if (shape === "one") await env.DB.prepare("update experiment_delivered_definitions set settled = 'delivered' where site_id = ? and run_id <> 'run1'").bind(sid).run();
      await addSettledHistory(sid, extra);
      await env.DB.prepare("analyze").run();
      await applyControlMigrations();
      expect(await env.DB.prepare("select count(*) as n from sqlite_stat1 where idx = 'experiment_delivered_definitions_unsettled'").first<number>("n")).toBe(0);
      const unsettled = await env.DB.prepare("select count(*) as n from experiment_delivered_definitions where site_id = ? and (settled is null or settled = 'unknown')").bind(sid).first<number>("n");
      const restore = await restorableMeasuredWrites(sid);
      const indexed = await measureDeliveryReads(sid);
      await restore();
      for (const name of RETENTION_INDEXES) await env.DB.prepare(`drop index if exists ${name}`).run();
      await env.DB.prepare("analyze").run();
      const baseline = await measureDeliveryReads(sid);
      expect(indexed.requestCalls).toBe(1);
      expect(indexed.requestPlans).toHaveLength(1);
      expect(indexed.outer).toBeLessThanOrEqual(baseline.outer + 2 * unsettled!);
      console.log("B242 stale", JSON.stringify({ shape, extra, outer: indexed.outer, baseline: baseline.outer, unsettled }));
      samples.push(indexed.outer);
    }
    expect(samples[1]).toBe(samples[0]);
  });
});
