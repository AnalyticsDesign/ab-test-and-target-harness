import { kvKeys } from "@wtt/core";
import { afterEach, expect, it, vi } from "vitest";
import { CRON_JOBS } from "../src/cron/jobs";
import { countingD1, runCron, SLOT_MS, type CronJob } from "../src/cron/runner";
import { getDb } from "../src/db";
import { publishSite } from "../src/publish";
import { resetUsageCache } from "../src/usage";
import { abortingBindings } from "./abort-harness";
import { active, beforeD1BatchMatching, beforeD1Query, createSite, failingKv, fakeResultsBudget, fakeResultsHealth, setupOwner, siteRow, siteWithRunning, testEnv, testEnvWith, userActor } from "./helpers";

// UTC 0 時は偶数枠で、枠番号を 3 で割った余りも 0。候補は id 順の先頭から読む。
const T = Date.UTC(2026, 10, 20);
const recent = T - 180_000;
const old = T - 3_600_000;
const NAME = "publish-repair";
const db = testEnv.DB;
const kv = testEnv.CONFIG_KV;

afterEach(() => vi.restoreAllMocks());

async function sites(n: number, stale: number, timestamp = old) {
  const owner = await setupOwner();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = await createSite(owner.token, owner.workspaceId);
    await db.prepare("update sites set active_version = 3, last_activated_at = ?, active_kv_stale = ? where id = ?")
      .bind(timestamp + i, stale, id).run();
    await kv.put(kvKeys.config(id, 3), "{}");
    ids.push(id);
  }
  return ids;
}

async function flags(ids: string[]) {
  return Promise.all(ids.map(async id => (await siteRow(id)).active_kv_stale));
}

async function tick(now = T, env = testEnv, jobs = CRON_JOBS) {
  const report = await runCron(env, now, jobs);
  return report.find(job => job.job === NAME)?.outcome;
}

it("repair_fixes_one_site_per_run", async () => {
  const ids = (await sites(2, 1)).sort();
  expect(await tick()).toBe("ran");
  expect(await flags(ids)).toEqual([0, 1]);
  expect(await tick(T + SLOT_MS)).toBe("ran");
  expect(await flags(ids)).toEqual([0, 0]);
});

it("recent_reconcile_reads_fourth_of_four and marks only the fourth", async () => {
  const ids = await sites(4, 0, recent);
  for (const id of ids.slice(0, 3)) await kv.put(kvKeys.active(id), "3");
  await kv.put(kvKeys.active(ids[3]!), "2");
  const log = vi.spyOn(console, "log");
  await tick();
  expect(await flags(ids)).toEqual([0, 0, 0, 1]);
  expect(log).toHaveBeenCalledWith(`cron publish-repair: marked site=${ids[3]} version=3 kv=2`);
});

it("recent_reconcile_skips_one_unreadable_pointer_and_repairs_reserved_candidate", async () => {
  const ids = await sites(4, 0, recent);
  const unreadable = ids[1]!, candidate = ids[3]!;
  await db.prepare("update sites set active_kv_stale = 1, last_activated_at = ? where id = ?").bind(old, candidate).run();
  const trace = abortingBindings({ ...testEnv, CONFIG_KV: failingKv(new RegExp(`^${kvKeys.active(unreadable)}$`), "get", 1) }, null);
  const error = vi.spyOn(console, "error");

  expect(await tick(T, trace.env)).toBe("ran");
  expect(await flags(ids)).toEqual([1, 0, 1, 0]);
  expect(await active(candidate)).toBe("3");
  expect(trace.calls.filter(c => c === `kv.get ${kvKeys.active(unreadable)}`)).toHaveLength(1);
  expect(trace.calls.filter(c => c.startsWith("kv.put") && c.endsWith(":active"))).toEqual([`kv.put ${kvKeys.active(candidate)}`]);
  expect(error).toHaveBeenCalledWith(`cron publish-repair: active read failed site=${unreadable}`, expect.any(Error));
});

it.each([
  ["recent_reconcile_marks_and_repairs", "2"],
  ["recent_reconcile_marks_non_numeric_kv", "abc"],
  ["recent_reconcile_marks_empty_kv", ""],
  ["recent_reconcile_marks_leading_zero_kv", "03"],
  ["recent_reconcile_marks_decimal_kv", "3.0"],
  ["recent_reconcile_marks_hexadecimal_kv", "0x4"],
])("%s", async (_name, value) => {
  const [id] = await sites(1, 0, recent);
  await kv.put(kvKeys.active(id!), value!);
  await tick();
  expect(await flags([id!])).toEqual([1]);
  expect(await active(id!)).toBe(value);
  await tick(T + SLOT_MS);
  expect(await active(id!)).toBe("3");
  expect(await flags([id!])).toEqual([0]);
});

it("recent_reconcile_ignores_newer_kv_and_null_d1", async () => {
  const ids = await sites(2, 0, recent);
  await kv.put(kvKeys.active(ids[0]!), "4");
  await db.prepare("update sites set active_version = null where id = ?").bind(ids[1]).run();
  expect(await tick()).toBe("ran");
  expect(await flags(ids)).toEqual([0, 0]);
});

it("repair_skips_within_30s", async () => {
  const ids = await sites(1, 1, T - 29_000);
  expect(await tick()).toBe("ran");
  expect(await flags(ids)).toEqual([1]);
  expect(await active(ids[0]!)).toBeNull();
});

it("repair_lowers_flag_without_put_when_kv_matches", async () => {
  const [id] = await sites(1, 1);
  await kv.put(kvKeys.active(id!), "3");
  const trace = abortingBindings(testEnv, null);
  const log = vi.spyOn(console, "log");
  await tick(T, trace.env);
  expect(await flags([id!])).toEqual([0]);
  expect(trace.calls).not.toContain(`kv.put ${kvKeys.active(id!)}`);
  expect(log).toHaveBeenCalledWith(`cron publish-repair: lowered-without-put site=${id} version=3`);
});

it("repair_put_failure_leaves_flag_for_next_run", async () => {
  const [id] = await sites(1, 1);
  const trace = abortingBindings({ ...testEnv, CONFIG_KV: failingKv(/:active$/, "put", 1) }, null);
  expect(await tick(T, trace.env)).toBe("ran");
  expect(trace.calls.filter(c => c === `kv.put ${kvKeys.active(id!)}`)).toHaveLength(1);
  expect(await flags([id!])).toEqual([1]);
  await tick(T + SLOT_MS);
  expect(await active(id!)).toBe("3");
  expect(await flags([id!])).toEqual([0]);
});

it.each([true, false])("repair_stops_frozen after put (failed=%s)", async fail => {
  const [id] = await sites(1, 1);
  const hook = beforeD1BatchMatching(db, /update "sites" set "active_kv_stale"/i, () =>
    db.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{}', 1)").run());
  const log = vi.spyOn(console, "log");
  const trace = abortingBindings({ ...testEnv, CONFIG_KV: fail ? failingKv(/:active$/, "put", 1) : kv }, null);
  expect(await tick(T, { ...trace.env, DB: hook.db })).toBe("stopped_frozen");
  expect(hook.ran()).toBe(true);
  expect(trace.calls.filter(c => c === `kv.put ${kvKeys.active(id!)}`)).toHaveLength(1);
  expect(await active(id!)).toBe(fail ? null : "3");
  expect(log).toHaveBeenCalledWith("cron publish-repair: candidates=1 marked=0 puts=1 unresolved=1");
  expect(await flags([id!])).toEqual([1]);
});

it("recent_reconcile_same_run_when_candidates_vanished", async () => {
  const [previous, found] = await sites(2, 0, recent);
  await db.prepare("update sites set active_kv_stale = 1, last_activated_at = ? where id = ?").bind(old, previous).run();
  const hook = beforeD1Query(db, /limit 3 offset/i, () =>
    db.prepare("update sites set active_kv_stale = 0 where id = ?").bind(previous).run());
  expect(await tick(T, { ...testEnv, DB: hook.db })).toBe("ran");
  expect(hook.ran()).toBe(true);
  expect(await flags([found!])).toEqual([0]);
  expect(await active(found!)).toBe("3");
});

it("recent marking compares the version again before writing", async () => {
  const [id] = await sites(1, 0, recent);
  const hook = beforeD1BatchMatching(db, /update sites set active_kv_stale/i, () =>
    db.prepare("update sites set active_version = 4 where id = ?").bind(id).run());
  expect(await tick(T, { ...testEnv, DB: hook.db })).toBe("ran");
  expect(hook.ran()).toBe(true);
  expect(await flags([id!])).toEqual([0]);
});

it("recent marking stops when freeze starts between its check and batch", async () => {
  const ids = await sites(1, 0, recent);
  const hook = beforeD1BatchMatching(db, /update sites set active_kv_stale/i, () =>
    db.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{}', 1)").run());
  expect(await tick(T, { ...testEnv, DB: hook.db })).toBe("stopped_frozen");
  expect(hook.ran()).toBe(true);
  expect(await flags(ids)).toEqual([0]);
});

it("repair_skips_when_run_state_null", async () => {
  const [marked, unmarked] = await sites(2, 0, recent);
  await db.prepare("update sites set active_kv_stale = 1 where id = ?").bind(marked).run();
  const hook = beforeD1BatchMatching(db, /as pending/i, async () => { throw new Error("injected initial batch failure"); });
  expect(await tick(T, { ...testEnv, DB: hook.db })).toBe("ran");
  expect(hook.ran()).toBe(true);
  expect(await flags([marked!, unmarked!])).toEqual([1, 0]);
  expect(await active(marked!)).toBeNull();
});

it("repair_skips_unfixable_and_rotates", async () => {
  const ids = (await sites(3, 1)).sort();
  await kv.delete(kvKeys.config(ids[0]!, 3));
  await tick();
  expect(await flags(ids)).toEqual([1, 0, 1]);
  const trace = abortingBindings(testEnv, null);
  await tick(T + SLOT_MS, trace.env);
  expect(trace.calls.filter(c => c.startsWith("kv.get") && c.includes(":config:"))).toEqual([`kv.get ${kvKeys.config(ids[2]!, 3)}`]);
  expect(await flags(ids)).toEqual([1, 0, 0]);
});

it("recent_reconcile_marks_when_daily_due and repair_not_reserved_on_both_daily_due_daily_slot", async () => {
  const start = T + 23 * 3_600_000;
  const [id] = await sites(1, 0, start - 180_000);
  await tick(start);
  expect(await flags([id!])).toEqual([1]);
  await db.prepare("delete from cron_job_runs where job in ('results-daily', 'results-purge')").run();
  await tick(start + SLOT_MS);
  expect(await active(id!)).toBeNull();
  expect(await flags([id!])).toEqual([1]);
  await tick(start + 2 * SLOT_MS);
  expect(await active(id!)).toBe("3");
});

it.each(["registered", "both_due"] as const)("repair_three_sites_under_consecutive_both_daily_slots (%s)", async mode => {
  const ids = await sites(3, 1);
  // 本物の purge の受付は 23 時台の 4 枠。5 枠目も両方 due にする場合だけ、受付の開始時を広げる。
  const jobs = mode === "registered" ? CRON_JOBS : CRON_JOBS.map(job =>
    job.name === "results-purge" ? { ...job, cadence: { daily: { afterUtcHour: 0 } } } : job);
  const attempted: number[] = [];
  for (let slot = 0; slot < 5; slot++) {
    await db.prepare("delete from cron_job_runs where job in ('results-daily', 'results-purge')").run();
    const now = T + 23 * 3_600_000 + slot * SLOT_MS;
    const trace = abortingBindings(testEnv, null);
    await tick(now, trace.env, jobs);
    for (const call of trace.calls.filter(c => c.startsWith("kv.put") && c.endsWith(":active"))) attempted.push(slot);
  }
  expect(attempted).toEqual([0, 2, 4]);
  expect(await flags(ids)).toEqual([0, 0, 0]);
});

it("repair_more_when_budget_short", async () => {
  const ids = await sites(1, 1);
  // runner の開始時は 7 枠。確保後、修復の直前には 3 件しか残っていない境界を作る。
  const jobs = CRON_JOBS.map(job => job.name !== NAME ? job : {
    ...job, async run(ctx) {
      for (let i = 0; i < 3; i++) await ctx.env.DB.prepare("select 1").first();
      return job.run(ctx);
    },
  } satisfies CronJob);
  expect(await tick(T, testEnv, jobs)).toBe("continued");
  expect(await flags(ids)).toEqual([1]);
});

it("late_put_after_readback_is_caught", async () => {
  const { owner, sid } = await siteWithRunning();
  const actor = userActor(owner.userId);
  let reached!: () => void;
  let deliver!: () => void;
  let landed!: () => void;
  const atPut = new Promise<void>(r => { reached = r; });
  const gate = new Promise<void>(r => { deliver = r; });
  const afterPut = new Promise<void>(r => { landed = r; });
  const delayed = new Proxy(kv, { get(target, prop) {
    if (prop === "put") return async (key: string, value: string) => {
      if (key !== kvKeys.active(sid)) return target.put(key, value);
      reached();
      await gate;
      await target.put(key, value);
      landed();
      return new Promise<never>(() => {}); // A は印の更新に到達しない。
    };
    const method = Reflect.get(target, prop);
    return typeof method === "function" ? method.bind(target) : method;
  } });
  const a = { ...testEnv, CONFIG_KV: delayed };
  const first = publishSite(a, getDb(a), await siteRow(sid), actor, recent - 1);
  await Promise.race([atPut, first.then(() => { throw new Error("first publish missed delayed put"); })]);
  expect(await publishSite(testEnv, getDb(testEnv), await siteRow(sid), actor, recent)).toMatchObject({ ok: true, version: 2 });
  expect(await active(sid)).toBe("2");
  deliver();
  await afterPut;
  expect(await active(sid)).toBe("1");
  expect(await flags([sid])).toEqual([0]);
  await tick();
  expect(await flags([sid])).toEqual([1]);
  await tick(T + SLOT_MS);
  expect(await active(sid)).toBe("2");
  expect(await flags([sid])).toEqual([0]);
});

type Counts = { fetch: number; kv: number; r2: number; do: number; d1: number };

it.each([["cron_run_subrequests_within_budget", false, 16], ["repair_uses_at_most_seven_queries even when two advanced configs are missing", true, 20]] as const)("%s", async (_name, movedMissing, expectedKv) => {
  // 03:00 は cleanup が due、枠番号 % 3 = 0。直近 10 件が食い違い、うち 3 件だけが確保時の候補。
  const now = T + 3 * 3_600_000;
  const ids = (await sites(10, 0, now - 180_000)).sort();
  const candidates = ids.slice(0, 3);
  for (const id of ids) await kv.put(kvKeys.active(id), "0");
  for (const id of candidates) await db.prepare("update sites set active_kv_stale = 1 where id = ?").bind(id).run();
  if (!movedMissing) for (const id of candidates.slice(0, 2)) await kv.delete(kvKeys.config(id, 3));
  const last = candidates[2]!;
  await kv.put(kvKeys.config(last, 4), "{}");
  const first = candidates[0]!;
  await db.prepare("update sites set static_served_version = 3 where id = ?").bind(first).run();
  for (const version of [1, 2]) {
    await db.prepare("insert into publishes (id, site_id, version, status, config_hash, published_by, created_at) values (?, ?, ?, 'active', 'hash', 'owner', 1)")
      .bind(`retired-${version}`, first, version).run();
    await kv.put(kvKeys.config(first, version), "{}");
  }

  const hook = beforeD1Query(db, /select "active_version", "last_activated_at" from "sites"/i, () =>
    db.batch((movedMissing ? candidates : [last]).map(id => db.prepare("update sites set active_version = 4 where id = ?").bind(id))));
  const budget = fakeResultsBudget(), health = fakeResultsHealth();
  resetUsageCache();
  const account = { workers: [], doRequests: [], doNamespaces: [], doRows: [], doStorage: [], d1: [], d1Storage: [], kv: [], kvStorage: [] };
  const external = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ data: { viewer: { accounts: [account] } }, errors: null }));
  const base = testEnvWith({ resultsStore: true });
  let r2 = 0, resultsQueries = 0;
  const ASSETS = new Proxy(base.ASSETS!, { get(target, prop) {
    const method = Reflect.get(target, prop);
    if (typeof method !== "function") return method;
    return (...args: unknown[]) => { r2++; return method.apply(target, args); };
  } });
  const trace = abortingBindings({
    ...base, DB: hook.db, RESULTS_DB: countingD1(base.RESULTS_DB!, n => { resultsQueries += n; }),
    ASSETS, RESULTS_BUDGET: budget.ns, RESULTS_HEALTH: health.ns,
    CF_USAGE_TOKEN: "test", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  }, null);
  function counts(): Counts {
    const kv = trace.calls.filter(c => c.startsWith("kv.")).length;
    return { fetch: external.mock.calls.length, kv, r2, do: budget.calls.length + health.calls.length, d1: trace.calls.length - kv + resultsQueries };
  }
  const byJob = new Map<string, Counts>();
  const kvByJob = new Map<string, string[]>();
  for (const job of CRON_JOBS) {
    const run = job.run;
    vi.spyOn(job, "run").mockImplementation(async ctx => {
      const before = counts(), start = trace.calls.length;
      try { return await run.call(job, ctx); }
      finally {
        const after = counts();
        for (const k of Object.keys(after) as (keyof Counts)[]) after[k] -= before[k];
        byJob.set(job.name, after);
        kvByJob.set(job.name, trace.calls.slice(start).filter(c => c.startsWith("kv.")));
      }
    });
  }
  const log = vi.spyOn(console, "log");
  const reports = await runCron(trace.env, now, CRON_JOBS);
  expect(reports.filter(r => r.outcome === "failed")).toEqual([]);
  expect(hook.ran()).toBe(true);
  const entry = log.mock.calls.find(c => c[0] === "cron run")!;
  const { queries, outsideQueries, queryLimit } = JSON.parse(String(entry[1]));
  const repair = byJob.get(NAME)!;
  expect(repair.fetch).toBe(0);
  expect(repair.kv).toBe(expectedKv);
  expect(outsideQueries).toBe(2);
  expect(repair.d1 - outsideQueries).toBeLessThanOrEqual(7);
  expect(kvByJob.get(NAME)?.filter(c => c.startsWith("kv.put"))).toEqual([`kv.put ${kvKeys.active(last)}`]);
  expect(await flags(candidates)).toEqual([1, 1, 0]);
  expect(await active(last)).toBe("4");

  // cleanup は処理した各サイトの active を 1 回読み、古い 2 版を削除するだけ。
  const cleanup = kvByJob.get("config-cleanup")!;
  const reads = cleanup.filter(c => c.startsWith("kv.get"));
  expect(reads.length).toBeGreaterThan(0);
  expect(reads).toEqual(ids.slice(0, reads.length).map(id => `kv.get ${kvKeys.active(id)}`));
  expect(cleanup.filter(c => !c.startsWith("kv.get")).sort()).toEqual([1, 2].map(v => `kv.delete ${kvKeys.config(first, v)}`));
  const total = counts();
  const measuredShared = CRON_JOBS.filter(j => j.queryShare !== undefined).reduce((n, j) => n + (byJob.get(j.name)?.d1 ?? 0), 0) - outsideQueries;
  expect(queries).toBe(measuredShared);
  expect(queries).toBeLessThanOrEqual(40);
  expect(queryLimit).toBe(40);
  expect(byJob.get("results-account-guard")!.fetch).toBeGreaterThan(0);
  expect(total.fetch).toBeLessThanOrEqual(50);
  expect(total.kv + total.do + total.r2).toBeLessThanOrEqual(1_000);
  expect(total.d1).toBeLessThanOrEqual(1_000);
  console.log("cron measured subrequests", JSON.stringify({ movedMissing, total, queries, outsideQueries, byJob: Object.fromEntries(byJob) }));
});
