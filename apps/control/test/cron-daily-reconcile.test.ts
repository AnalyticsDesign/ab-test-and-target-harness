import { kvKeys } from "@wtt/core";
import { afterEach, expect, it, vi } from "vitest";
import { configCleanupJob } from "../src/cron/config-cleanup";
import { CronFrozen } from "../src/cron/runner";
import { isWriteFrozen } from "../src/write-freeze";
import { abortingBindings } from "./abort-harness";
import { beforeD1BatchMatching, createSite, failingKv, setupOwner, siteRow, testEnv } from "./helpers";
import { housekeepingCtx } from "./housekeeping-helpers";

const T = Date.UTC(2026, 10, 25, 3);
const db = testEnv.DB;
const kv = testEnv.CONFIG_KV;

afterEach(() => vi.restoreAllMocks());

async function seed(values: Array<string | null>, timestamp = T - 120_000) {
  const owner = await setupOwner();
  const ids: string[] = [];
  for (const value of values) {
    const { id } = await createSite(owner.token, owner.workspaceId);
    await db.prepare("update sites set active_version = 3, last_activated_at = ?, active_kv_stale = 0 where id = ?")
      .bind(timestamp, id).run();
    if (value !== null) await kv.put(kvKeys.active(id), value);
    ids.push(id);
  }
  return ids;
}

const flags = (ids: string[]) => Promise.all(ids.map(async id => (await siteRow(id)).active_kv_stale));

async function run(env = testEnv, budget = Infinity) {
  const ctx = housekeepingCtx(env, T, budget);
  ctx.assertNotFrozen = async () => {
    if (await isWriteFrozen(ctx.db)) throw new CronFrozen();
  };
  return configCleanupJob.run(ctx);
}

it("daily_reconcile_marks_older_or_missing_kv", async () => {
  const values = ["2", null, "abc"];
  const ids = await seed(values);
  const log = vi.spyOn(console, "log");
  const trace = abortingBindings(testEnv, null);
  await run(trace.env);
  expect(await flags(ids)).toEqual([1, 1, 1]);
  ids.forEach((id, i) => expect(log).toHaveBeenCalledWith(`cron config-cleanup: marked site=${id} version=3 kv=${values[i]}`));
  // 失効・一覧・位置の 6、掃除の sites 読み 2(壊れた値は早期 return)、印の 2 × 3。
  expect(trace.calls.filter(c => !c.startsWith("kv."))).toHaveLength(14);
});

it("daily_reconcile_marks_versions_the_edge_cannot_read", async () => {
  const ids = await seed(["03", "3.0", "0x4", ""]);
  await run();
  expect(await flags(ids)).toEqual([1, 1, 1, 1]);
});

it("daily_reconcile_ignores_newer_kv_and_null_d1_and_unreadable_kv", async () => {
  const ids = await seed(["4", null, null]);
  await db.prepare("update sites set active_version = null where id = ?").bind(ids[1]).run();
  await run({ ...testEnv, CONFIG_KV: failingKv(new RegExp(kvKeys.active(ids[2]!) + "$"), "get") });
  expect(await flags(ids)).toEqual([0, 0, 0]);
});

it("daily_reconcile_skips_recent_publish", async () => {
  const ids = await seed(["1"], T - 60_000);
  await run();
  expect(await flags(ids)).toEqual([0]);
});

it("daily_reconcile_adds_no_kv_call", async () => {
  const ids = await seed(["3", "3", "3"]);
  const trace = abortingBindings(testEnv, null);
  await run(trace.env);
  expect(trace.calls.filter(c => c.startsWith("kv."))).toEqual(ids.sort().map(id => `kv.get ${kvKeys.active(id)}`));
  // 位置の読み・一覧・位置の保存、日次の失効 3、サイトごとの掃除の sites 読み 3。
  expect(trace.calls.filter(c => !c.startsWith("kv."))).toHaveLength(9);
  expect(await flags(ids)).toEqual([0, 0, 0]);
});

it("daily_reconcile_keeps_position_when_budget_short", async () => {
  const [id] = await seed([null]);
  await db.prepare("update sites set active_version = 52, static_served_version = 52 where id = ?").bind(id).run();
  // 51 版の掃除で削除済みの印が 2 文になる。残り 2 では照合の 2 + 位置保存 1 が収まらない。
  await db.prepare(`with recursive versions(n) as (values (1) union all select n+1 from versions where n < 51)
    insert into publishes(id, site_id, version, status, config_hash, published_by, created_at)
    select 'retired-' || n, ?, n, 'active', 'hash', 'owner', 1 from versions`).bind(id).run();
  expect(await run(testEnv, 12)).toEqual({ more: true });
  expect(await flags([id!])).toEqual([0]);
  expect(await db.prepare("select cursor from cron_cursors where job = 'config-cleanup'").first()).toEqual({ cursor: null });
  expect(await run(testEnv, 12)).toBeUndefined();
  expect(await flags([id!])).toEqual([1]);
});

it.each(["freeze", "publish", "remove"])("daily_reconcile_guards_against_concurrent_%s", async change => {
  const [id] = await seed(["1"]);
  const hook = beforeD1BatchMatching(db, /update sites set active_kv_stale/i, () => {
    if (change === "freeze") return db.prepare("insert into instance_settings(key, value, updated_at) values ('writeFreeze', '{}', 1)").run();
    const sql = change === "publish" ? "active_version = 4" : "static_removing = 1";
    return db.prepare(`update sites set ${sql} where id = ?`).bind(id).run();
  });
  const result = run({ ...testEnv, DB: hook.db });
  if (change === "freeze") await expect(result).rejects.toBeInstanceOf(CronFrozen);
  else await result;
  expect(hook.ran()).toBe(true);
  expect(await flags([id!])).toEqual([0]);
});
