import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { utcDay } from "@wtt/core";
import { configCleanupJob as job } from "../src/cron/config-cleanup";
import { CronFrozen, runCron } from "../src/cron/runner";
import { getDb } from "../src/db";
import { publishSite } from "../src/publish";
import { abortingBindings, settleOrAbort } from "./abort-harness";
import { beforeD1BatchMatching, call, json, publishRes, siteRow, siteWithRunning, testEnv, userActor } from "./helpers";
import { housekeepingCtx } from "./housekeeping-helpers";

const T = Date.UTC(2026, 10, 1, 4);
const OLD = T - 600_001;
const DAY = 86_400_000;
const JOB = "config-cleanup:reserved-expiry";
const error = "interrupted: reserved row expired";
type Site = Awaited<ReturnType<typeof siteWithRunning>>;

async function reserve(f: Site, start = 1, count = 1, at = OLD) {
  const versions = Array.from({ length: count }, (_, i) => start + i);
  await env.DB.prepare(`insert into publishes(id, site_id, version, published_by, status, created_at)
    select printf('row%03d', value), ?1, value, ?2, 'reserved', ?3 from json_each(?4)`)
    .bind(f.sid, f.owner.userId, at, JSON.stringify(versions)).run();
}
const states = async () => (await env.DB.prepare("select status from publishes order by version").all<{ status: string }>()).results.map(r => r.status);
const cursor = () => env.DB.prepare("select day,cursor from cron_cursors where job=?").bind(JOB).first();
const sitesEnd = () => env.DB.prepare("insert into cron_cursors(job,day,cursor) values ('config-cleanup',?,'#end')").bind(utcDay(T)).run();
const step = (now = T, DB = env.DB) => job.run(housekeepingCtx({ DB }, now));

it.each([
  ["stopped_after_p4", null, true, [], "failed", null],
  ["stopped_after_p5", 1, true, ["activated"], "active", OLD],
  ["activated_then_superseded_by_next", 2, true, ["activated"], "active", OLD],
  ["reverted", null, true, ["activated", "reverted"], "failed", null],
  ["no_record", null, false, [], "failed", null],
  ["current_without_record", 1, true, [], "active", null],
  ["superseded_only", 2, true, ["superseded"], "failed", null],
] as const)("expiry_fixture_%s", async (_name, active, body, events, status, activatedAt) => {
  const f = await siteWithRunning();
  await reserve(f);
  if (body) await env.DB.prepare("update publishes set config_hash='hash', config_json='{}'").run();
  if (active === 2) {
    await reserve(f, 2);
    await env.DB.prepare("update publishes set status='active' where version=2").run();
  }
  await env.DB.prepare("update sites set active_version=? where id=?").bind(active, f.sid).run();
  // 同じミリ秒の別サイト・別版、時刻違い、10 分を過ぎた戻しの記録はいずれもこの行の証拠にならない。
  await env.DB.prepare(`insert into audit_events(at,category,action,site_id,via,detail_json) values
    (?1,'content','publish.publish','different-site','system','{"version":1}'),
    (?1,'content','publish.publish',?2,'system','{"version":9}'),
    (?1+1,'content','publish.publish',?2,'system','{"version":1}'),
    (?1+600001,'content','publish.publish',?2,'system','{"version":1,"reason":"reverted"}')`).bind(OLD, f.sid).run();
  for (const event of events) {
    const detail = event === "reverted" ? { version: 1, reason: "reverted" } : { version: 1, superseded: event === "superseded" };
    await env.DB.prepare("insert into audit_events(at,category,action,site_id,via,detail_json) values (?,'content','publish.publish',?,'system',?)")
      .bind(event === "reverted" ? OLD + 600_000 : OLD, f.sid, JSON.stringify(detail)).run();
  }
  await runCron(testEnv, T, [job]);
  const opts = { token: f.owner.token };
  expect(await json(await call("GET", `/sites/${f.sid}/publishes`, opts))).toContainEqual(expect.objectContaining({
    version: 1, status, activatedAt, error: status === "failed" ? error : null,
  }));
  expect(await json(await call("GET", `/sites/${f.sid}`, opts))).toMatchObject({ activeVersion: active });
});

it("head_expiry_only_reads_recent_20_versions_and_expires_strictly_after_10_minutes", async () => {
  const f = await siteWithRunning();
  await reserve(f, 1, 20);
  await reserve(f, 21, 1, T - 600_000);
  await reserve(f, 22, 1, T - 599_999);
  expect(await publishSite(testEnv, getDb(testEnv), await siteRow(f.sid), userActor(f.owner.userId), T)).toMatchObject({ ok: true, version: 23 });
  expect(await states()).toEqual(["reserved", "reserved", ...Array(18).fill("failed"), "reserved", "reserved", "active"]);
  await step();
  expect((await states()).slice(0, 2)).toEqual(["failed", "failed"]);
});

it("head_expiry_rolls_back_when_reservation_insert_fails", async () => {
  const f = await siteWithRunning();
  await reserve(f);
  const hook = beforeD1BatchMatching(env.DB, /insert into publishes \(id/i, () =>
    env.DB.prepare("create trigger reject_reservation before insert on publishes begin select raise(abort, 'interrupted insert'); end").run());
  const e = { ...testEnv, DB: hook.db };
  expect(await publishSite(e, getDb(e), await siteRow(f.sid), userActor(f.owner.userId), T)).toMatchObject({ ok: false, error: "publish_failed" });
  expect(hook.ran()).toBe(true);
  expect(await states()).toEqual(["reserved"]);
});

it("activation_rejects_expired_reservation", async () => {
  const f = await siteWithRunning();
  const hook = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, () =>
    env.DB.prepare("update publishes set status='failed',error=? where site_id=?").bind(error, f.sid).run());
  expect(await json(await publishRes(f.owner.token, f.sid, { DB: hook.db }))).toMatchObject({
    ok: false, error: "publish_reservation_expired", message: "公開の準備に時間がかかりすぎたため、この版を有効にしませんでした", hint: "もう一度公開してください",
  });
  expect(hook.ran()).toBe(true);
  expect((await siteRow(f.sid)).active_version).toBeNull();
});

it("daily_expiry_caps_100_per_utc_day_even_when_sites_done_today", async () => {
  const f = await siteWithRunning();
  await reserve(f, 1, 150);
  await sitesEnd();
  await runCron(testEnv, T, [job]);
  expect((await states()).filter(s => s === "failed")).toHaveLength(100);
  expect(await cursor()).toEqual({ day: utcDay(T), cursor: "row100" });
  const trace = abortingBindings(testEnv, null);
  await step(T + 900_000, trace.env.DB);
  expect(trace.calls).toHaveLength(1);
  await runCron(testEnv, T + DAY, [job]);
  expect(await states()).toEqual(Array(150).fill("failed"));
  expect(await cursor()).toEqual({ day: utcDay(T + DAY), cursor: "#end" });
});

it("daily_expiry_sites_end_budget_short_returns_more_and_retries_same_day", async () => {
  await reserve(await siteWithRunning());
  await sitesEnd();
  const limited = { ...job, run: (ctx: Parameters<typeof job.run>[0]) => job.run({ ...ctx, queries: { left: () => 3, use: n => n <= 3 } }) };
  expect(await runCron(testEnv, T, [limited])).toEqual([{ job: job.name, outcome: "continued" }]);
  expect(await cursor()).toBeNull();
  expect(await states()).toEqual(["reserved"]);
  expect(await runCron(testEnv, T + 900_000, [job])).toEqual([{ job: job.name, outcome: "ran" }]);
  expect(await states()).toEqual(["failed"]);
});

it("concurrent_daily_batches_with_different_candidates_share_one_daily_cap", async () => {
  const f = await siteWithRunning();
  await reserve(f, 101, 100);
  const hook = beforeD1BatchMatching(env.DB, /insert into cron_cursors/i, async () => {
    await reserve(f, 1, 100);
    await step();
  });
  await step(T, hook.db);
  expect(hook.ran()).toBe(true);
  expect(await states()).toEqual([...Array(100).fill("failed"), ...Array(100).fill("reserved")]);
  expect(await cursor()).toEqual({ day: utcDay(T), cursor: "row100" });
});

it.each(["before", "throw_after"] as const)("daily_expiry_batch_%s_preserves_cursor_and_daily_cap", async (mode) => {
  const f = await siteWithRunning();
  await reserve(f, 1, 150);
  await sitesEnd();
  // サイトが終了済みの回は、カーソル・候補・凍結の確認の後が日付を確保する batch。
  const cut = abortingBindings(testEnv, { at: 3, mode }); // housekeepingCtx の凍結確認は元の DB で流す
  const running = step(T, cut.env.DB);
  if (mode === "before") expect(await settleOrAbort(running, cut.reached)).toEqual({ aborted: true });
  else await expect(running).rejects.toThrow("injected after commit");
  expect(cut.calls[2]).toMatch(/insert into cron_cursors/i);
  expect((await states()).filter(s => s === "failed")).toHaveLength(mode === "before" ? 0 : 100);
  const retry = abortingBindings(testEnv, null);
  await step(T + 900_000, retry.env.DB);
  if (mode === "throw_after") expect(retry.calls).toHaveLength(1);
  expect((await states()).filter(s => s === "failed")).toHaveLength(100);
  await step(T + DAY);
  expect(await states()).toEqual(Array(150).fill("failed"));
});

it("daily_expiry_skips_when_frozen_between_check_and_batch", async () => {
  await reserve(await siteWithRunning());
  const hook = beforeD1BatchMatching(env.DB, /insert into cron_cursors/i, async () => {
    await env.DB.prepare("insert into instance_settings(key,value,updated_at) values ('writeFreeze','{}',1)").run();
  });
  await expect(step(T, hook.db)).rejects.toBeInstanceOf(CronFrozen);
  expect(await cursor()).toBeNull();
  expect(await states()).toEqual(["reserved"]);
});
