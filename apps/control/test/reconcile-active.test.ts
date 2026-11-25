import { expect, it, vi } from "vitest";
import { kvKeys } from "@wtt/core";
import { CronFrozen } from "../src/cron/runner";
import { getDb } from "../src/db";
import { reconcileActive } from "../src/publish";
import { abortingBindings } from "./abort-harness";
import { beforeD1BatchMatching, beforeD1Query, createSite, failingKv, lateFailingActivePut, setupOwner, siteRow, testEnv } from "./helpers";

async function fixture() {
  const { token, workspaceId } = await setupOwner();
  const { id: sid } = await createSite(token, workspaceId);
  const row = { active_kv_stale: 1, active_version: 1, last_activated_at: 100 };
  await getDb(testEnv).updateTable("sites").set(row).where("id", "=", sid).execute();
  await testEnv.CONFIG_KV.put(kvKeys.config(sid, 1), "{}");
  return { sid, row, nowMs: 30_101 };
}

it("reconcile_lowers_flag_only_when_written_is_current", async () => {
  const { sid, nowMs } = await fixture();
  const hook = beforeD1Query(testEnv.DB, /update "sites" set "active_kv_stale"/i, () =>
    getDb(testEnv).updateTable("sites").set({ active_version: 2, active_kv_stale: 0 }).where("id", "=", sid).execute());
  const bindings = { ...testEnv, DB: hook.db };
  expect(await reconcileActive(bindings, getDb(bindings), sid, { nowMs })).toMatchObject({ stale: true, reason: "pending", kvPuts: 1 });
  expect(hook.ran()).toBe(true);
  expect((await siteRow(sid)).active_kv_stale).toBe(1);
});

it("reconcile_lowers_flag_without_put_when_kv_equals_d1", async () => {
  const { sid, nowMs } = await fixture();
  await testEnv.CONFIG_KV.put(kvKeys.active(sid), "1");
  const log = abortingBindings(testEnv, null);
  expect(await reconcileActive(log.env, getDb(log.env), sid, { nowMs })).toEqual({ stale: false, reason: null, deferred: false, kvPuts: 0 });
  expect(log.calls.filter(c => c.startsWith("kv.put"))).toHaveLength(0);
  expect((await siteRow(sid)).active_kv_stale).toBe(0);
});

it.each([false, true])("reconcile_keeps_flag_when_config_missing (version moved = %s)", async moved => {
  const { sid, nowMs, row } = await fixture();
  if (moved) await getDb(testEnv).updateTable("sites").set({ active_version: 2 }).where("id", "=", sid).execute();
  else await testEnv.CONFIG_KV.delete(kvKeys.config(sid, 1));
  const error = vi.spyOn(console, "error");
  try {
    const log = abortingBindings(testEnv, null);
    expect(await reconcileActive(log.env, getDb(log.env), sid, { nowMs, row })).toMatchObject({ stale: true, reason: "config_missing", kvPuts: 0 });
    expect(log.calls.filter(c => c.startsWith("kv.put"))).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
  } finally {
    error.mockRestore();
  }
});

it("reconcile_defers_within_30s", async () => {
  const { sid, row } = await fixture();
  const log = abortingBindings(testEnv, null);
  expect(await reconcileActive(log.env, getDb(log.env), sid, { row, nowMs: 30_099 })).toMatchObject({ stale: true, deferred: true, kvPuts: 0 });
  expect(log.calls).toEqual([]);
  expect(await reconcileActive(log.env, getDb(log.env), sid, { row, nowMs: 30_101 })).toMatchObject({ stale: false, deferred: false, kvPuts: 1 });
});

it("cron_reconcile_throws_cron_frozen_when_flag_update_hits_freeze", async () => {
  const { sid, row, nowMs } = await fixture();
  const cron = { assertNotFrozen: vi.fn(async () => {}) };
  const hook = beforeD1BatchMatching(testEnv.DB, /update "sites" set "active_kv_stale"/i, async () => {
    expect(await testEnv.CONFIG_KV.get(kvKeys.active(sid))).toBe("1");
    await testEnv.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{}', 1)").run();
  });
  const bindings = { ...testEnv, DB: hook.db };
  await expect(reconcileActive(bindings, getDb(bindings), sid, { nowMs, row, cron })).rejects.toBeInstanceOf(CronFrozen);
  expect(cron.assertNotFrozen).toHaveBeenCalledTimes(1);
  expect(hook.ran()).toBe(true);
  expect(await testEnv.CONFIG_KV.get(kvKeys.active(sid))).toBe("1");
  expect((await siteRow(sid)).active_kv_stale).toBe(1);
});

it("cron_reconcile_does_not_retry_put", async () => {
  const { sid, row, nowMs } = await fixture();
  const cron = { assertNotFrozen: vi.fn(async () => {}) };
  const log = abortingBindings({ ...testEnv, CONFIG_KV: failingKv(/:active$/, "put", 1) }, null);
  expect(await reconcileActive(log.env, getDb(log.env), sid, { nowMs, row, cron })).toMatchObject({ stale: true, reason: "pending", kvPuts: 1 });
  expect(cron.assertNotFrozen).toHaveBeenCalledTimes(1);
  expect(log.calls.filter(c => c.startsWith("kv.put"))).toHaveLength(1);
});

it("cron_reconcile_stops_when_freeze_starts_on_a_failed_put", async () => {
  const { sid, row, nowMs } = await fixture();
  const log = abortingBindings({ ...testEnv, CONFIG_KV: failingKv(/:active$/, "put", 1) }, null);
  // put の直前の確認後に凍結。失敗後の印の batch は凍結を読み、書き込まない。
  const cron = { assertNotFrozen: async () => {
    await testEnv.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{}', 1)").run();
  } };
  await expect(reconcileActive(log.env, getDb(log.env), sid, { nowMs, row, cron })).rejects.toBeInstanceOf(CronFrozen);
  expect(log.calls.filter(c => c.startsWith("kv.put"))).toHaveLength(1);
  expect((await siteRow(sid)).active_kv_stale).toBe(1);
});

it.each(["retry_put", "retry_config_missing", "cron"] as const)("ambiguous late repair put reopens a cleared flag (%s)", async mode => {
  const { sid, row, nowMs } = await fixture();
  const kv = lateFailingActivePut(sid, async () => {
    await getDb(testEnv).updateTable("sites").set({ active_version: 2, active_kv_stale: 0 }).where("id", "=", sid).execute();
    await testEnv.CONFIG_KV.put(kvKeys.active(sid), "2");
    if (mode !== "retry_config_missing") await testEnv.CONFIG_KV.put(kvKeys.config(sid, 2), "{}");
  });
  const bindings = { ...testEnv, CONFIG_KV: kv };
  const cron = mode === "cron" ? { assertNotFrozen: async () => {} } : undefined;
  expect(await reconcileActive(bindings, getDb(bindings), sid, { nowMs, row, cron })).toMatchObject({
    stale: true, reason: mode === "retry_config_missing" ? "config_missing" : "pending", kvPuts: mode === "retry_put" ? 2 : 1,
  });
  expect(await testEnv.CONFIG_KV.get(kvKeys.active(sid))).toBe("1");
  expect(await siteRow(sid)).toMatchObject({ active_version: 2, active_kv_stale: 1 });
});

it.each(["first_read", "retry"] as const)("repair defers a newly activated version at the %s", async when => {
  const { sid, row, nowMs } = await fixture();
  const advance = async () => {
    await getDb(testEnv).updateTable("sites").set({ active_version: 2, active_kv_stale: when === "retry" ? 0 : 1, last_activated_at: nowMs }).where("id", "=", sid).execute();
    await testEnv.CONFIG_KV.put(kvKeys.config(sid, 2), "{}");
    await testEnv.CONFIG_KV.put(kvKeys.active(sid), "2");
  };
  if (when === "first_read") await advance();
  const log = abortingBindings({ ...testEnv, CONFIG_KV: when === "retry" ? lateFailingActivePut(sid, advance) : testEnv.CONFIG_KV }, null);
  expect(await reconcileActive(log.env, getDb(log.env), sid, { row, nowMs })).toMatchObject({
    stale: true, deferred: true, kvPuts: when === "retry" ? 1 : 0,
  });
  expect(await siteRow(sid)).toMatchObject({ active_version: 2, active_kv_stale: 1 });
  expect(log.calls.filter(c => c.startsWith("kv.put"))).toHaveLength(when === "retry" ? 1 : 0);
});
