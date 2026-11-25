import { beforeEach, expect, it, vi } from "vitest";
import { kvKeys } from "@wtt/core";
import { retentionStatements } from "../src/cron/audit-retention";
import { countingD1 } from "./d1-trips";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { abortingBindings, settleOrAbort, type AbortPoint } from "./abort-harness";
import {
  beforeD1BatchMatching, call, choosePrimaryGoal, createExperiment, createSite, experimentRow, failingD1Query, failingKv,
  fakeDeployer, json, publishRes, RESULTS_STORE, setupOwner, siteRow, testEnv,
} from "./helpers";

const activation = /update "sites" set "active_version"/i;
const statusOnly = /update "experiments" set "status"/i;
const clearMarker = /update "sites" set "active_kv_stale" = case/i;
const conflict = { error: "transition_conflict", message: "別の公開と重なりました", hint: "状態は変わっていません。読み込み直して、内容を確かめてからもう一度送ってください" };
const db = getDb(testEnv);

let owner: Awaited<ReturnType<typeof setupOwner>>;
beforeEach(async () => { owner = await setupOwner(); });

async function fixture(from: "draft" | "running" | "paused" = "draft") {
  const { token, workspaceId, userId } = owner;
  const { id: sid } = await createSite(token, workspaceId);
  await db.updateTable("sites").set({ results_enabled: 1 }).where("id", "=", sid).execute();
  const { id: eid } = await createExperiment(token, sid);
  await choosePrimaryGoal(token, sid, eid);
  const send = (status: string, overrides: Partial<Env> = {}, extra: Record<string, unknown> = {}) =>
    call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, envOverride: { ...RESULTS_STORE, ...overrides }, body: { status, ...extra } });
  if (from !== "draft") expect((await send("running")).status).toBe(200);
  if (from === "paused") expect((await send("paused")).status).toBe(200);
  return { sid, eid, token, userId, send };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const history = (sid: string) => db.selectFrom("publishes").select(["version", "status", "error"]).where("site_id", "=", sid).orderBy("version", "desc").execute();
const events = (sid: string, action: string) => db.selectFrom("audit_events").select("id").where("site_id", "=", sid).where("action", "=", action).execute();
const bindings = (point: AbortPoint | null, overrides: Partial<Env> = {}) =>
  abortingBindings({ ...testEnv, ...RESULTS_STORE, ...overrides }, point);

// 同じ初期状態・同じ操作の実測から切れ目を選ぶ。SQL の本数が変わっても別の文で止まらない。
async function cutPoint(from: "draft" | "running", to: string, re: RegExp, overrides: Partial<Env> = {}) {
  const f = await fixture(from);
  const trace = bindings(null, overrides);
  expect((await f.send(to, trace.env)).status).toBe(200);
  const index = trace.calls.findIndex((s) => re.test(s));
  expect(index, trace.calls.join("\n")).toBeGreaterThanOrEqual(0);
  return index + 1;
}

it("start_applies_transition_and_activation_in_one_batch", async () => {
  const at = await cutPoint("draft", "running", activation);
  for (const mode of ["before", "after"] as const) {
    const { sid, eid, send } = await fixture();
    const stopped = bindings({ at, mode });
    expect(await settleOrAbort(send("running", stopped.env), stopped.reached)).toEqual({ aborted: true });
    expect(stopped.calls[at - 1]).toMatch(activation);
    const applied = mode === "after";
    const row = await experimentRow(sid, eid);
    expect(row.status).toBe(applied ? "running" : "draft");
    expect(await siteRow(sid)).toMatchObject({ active_version: applied ? 1 : null, collect_until_dirty: applied ? 1 : 0 });
    expect(row.run_id !== null).toBe(applied);
    const plan = await db.selectFrom("evaluation_plans").select("fixed_at").where("site_id", "=", sid).executeTakeFirstOrThrow();
    expect(plan.fixed_at !== null).toBe(applied);
  }
});

it("start_config_carries_new_run_and_delivery_definition_uses_fixed_plan", async () => {
  const { sid, eid, send, token } = await fixture();
  const trace = bindings(null, { DEPLOYER: fakeDeployer() });
  expect((await send("running", trace.env)).status).toBe(200);
  const row = await experimentRow(sid, eid);
  expect(row.run_id).toBeTruthy();
  expect(JSON.parse((await testEnv.CONFIG_KV.get(kvKeys.config(sid, 1)))!).results.runs[eid]).toBe(row.run_id);
  const plan = await db.selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).executeTakeFirstOrThrow();
  const def = await db.selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).executeTakeFirstOrThrow();
  expect(JSON.parse(def.definition_json).primaryGoal.id).toBe(JSON.parse(plan.plan_json).primaryGoalId);
  expect(plan.fixed_at).toBe(row.started_at);
  expect((await siteRow(sid)).last_activated_at).toBe(row.updated_at);
  expect(await json(await call("GET", `/sites/${sid}`, { token }))).toMatchObject({ hasUnpublishedChanges: false });
  const afterPointer = trace.calls.findIndex((s) => clearMarker.test(s));
  const deadline = trace.calls.indexOf(`kv.put ${kvKeys.settings(sid)}`);
  const deploy = trace.calls.findIndex((s) => /insert into "?static_deploy_requests/i.test(s));
  expect(afterPointer).toBeGreaterThan(-1);
  expect(deadline).toBeGreaterThan(afterPointer);
  expect(deploy).toBeGreaterThan(deadline);
});

it.each(["draft", "paused"] as const)("start_prepare_failure_returns_409_and_keeps_status (%s)", async (from) => {
  const { sid, eid, send } = await fixture(from);
  const res = await send("running", { CONFIG_KV: failingKv(/config:v/) });
  expect(res.status).toBe(409);
  expect(await json(res)).toEqual({ error: "kv_put_failed", message: "config を KV に書き込めませんでした", hint: "数秒後に、同じ状態の変更をもう一度送ってください" });
  expect((await experimentRow(sid, eid)).status).toBe(from);
  expect((await history(sid))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/^kv_put_failed:/) });
});

it.each([["draft", "running"], ["paused", "running"], ["running", "paused"], ["running", "archived"]] as const)(
  "expect_digest_mismatch_is_409_for_all_transitions (%s -> %s)", async (from, to) => {
    const { sid, eid, send } = await fixture(from);
    const res = await send(to, {}, { expectDigest: "f".repeat(64) });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "stale_preview" });
    expect((await history(sid))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/^stale_preview:/) });
    expect((await experimentRow(sid, eid)).status).toBe(from);
  },
);

it.each(["draft", "paused"] as const)("preview_digest_roundtrip_start_and_resume (%s)", async (from) => {
  const { sid, eid, token, send } = await fixture(from);
  const preview = await json(await call("GET", `/sites/${sid}/publish-preview?transition=${eid}:running`, { token }));
  expect(preview.transitionDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await json(await send("running", {}, { expectDigest: preview.transitionDigest }))).toMatchObject({ publish: { ok: true } });
});

it("start_conflict_returns_transition_conflict", async () => {
  const { sid, eid, send, token } = await fixture();
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    expect(await json(await publishRes(token, sid))).toMatchObject({ ok: true, version: 2 });
  });
  const res = await send("running", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toEqual(conflict);
  expect((await experimentRow(sid, eid)).status).toBe("draft");
  expect((await history(sid))[1]).toMatchObject({ status: "failed", error: expect.stringMatching(/^transition_conflict:/) });
});

it("rejects a pending start when a new draft replaces the same experiment ID", async () => {
  const { token, workspaceId } = owner;
  const { id: sid } = await createSite(token, workspaceId);
  const { id: eid } = await createExperiment(token, sid);
  const path = `/sites/${sid}/experiments/${eid}`;
  const original = await experimentRow(sid, eid);
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    expect((await call("DELETE", path, { token })).status).toBe(204);
    await createExperiment(token, sid, { id: eid, urlMatch: { include: [{ page: { op: "contains", value: "/replacement" } }] } });
  });

  const res = await call("POST", `${path}/status`, { token, body: { status: "running" }, envOverride: { DB: hook.db } });
  expect(hook.ran()).toBe(true);
  const replacement = await experimentRow(sid, eid);
  expect(replacement.generation).not.toBe(original.generation);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "invalid_transition" });
  expect(replacement.status).toBe("draft");
  expect(await history(sid)).toEqual([{ version: 1, status: "failed", error: expect.stringMatching(/^transition_conflict:/) }]);
  expect((await siteRow(sid)).active_version).toBeNull();
  expect(await testEnv.CONFIG_KV.get(kvKeys.active(sid))).toBeNull();
});

it("pause_retries_snapshot_conflict_when_other_experiment_changed", async () => {
  const { sid, eid, send, token } = await fixture("running");
  const { id: other } = await createExperiment(token, sid, { id: "exp_other" });
  await choosePrimaryGoal(token, sid, other);
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    const started = await call("POST", `/sites/${sid}/experiments/${other}/status`, { token, body: { status: "running" }, envOverride: RESULTS_STORE });
    expect(started.status).toBe(200);
  });
  const res = await send("paused", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: "paused" }, publish: { ok: true, version: 4 } });
  expect((await experimentRow(sid, other)).status).toBe("running");
});

it("transition_guard_blocks_when_same_version_taken_by_other_row", async () => {
  const { sid, eid, send, userId } = await fixture("running");
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("delete from publishes where site_id = ? and version = 2").bind(sid),
      testEnv.DB.prepare("insert into publishes (id, site_id, version, status, published_by, created_at) values ('other', ?, 2, 'active', ?, 0)").bind(sid, userId),
      testEnv.DB.prepare("update sites set active_version = 2, collect_until_dirty = 0 where id = ?").bind(sid),
    ]);
  });
  const res = await send("paused", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "publish_record_missing" });
  expect(await experimentRow(sid, eid)).toMatchObject({ status: "running", published_status: "running" });
  expect(await events(sid, "experiment.status")).toHaveLength(1);
  expect(await events(sid, "publish.publish")).toHaveLength(1);
  expect((await siteRow(sid)).collect_until_dirty).toBe(0);
});

async function expectArchiveRecorded(f: Fixture) {
  expect(await events(f.sid, "experiment.adoption")).toHaveLength(1);
  expect(await db.selectFrom("adoptions").select("note").where("site_id", "=", f.sid).executeTakeFirst()).toEqual({ note: "採用" });
}
const adopted = { adoption: { variantId: "b", note: "採用" } };

it.each(["paused", "archived"] as const)("prepare_failure_changes_status_only_and_records_stop (%s)", async (to) => {
  const f = await fixture("running");
  const res = await f.send(to, { CONFIG_KV: failingKv(/config:v/) }, to === "archived" ? adopted : {});
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: to, publishedStatus: "running" }, publish: { ok: false }, ...(to === "archived" ? { results: { recorded: true } } : {}) });
  expect((await siteRow(f.sid)).active_version).toBe(1);
  expect(await json(await call("GET", `/sites/${f.sid}`, { token: f.token }))).toMatchObject({ hasUnpublishedChanges: true });
  if (to === "archived") await expectArchiveRecorded(f);
});

it("pause_prepare_abort_after_status_only_batch", async () => {
  const bad = { CONFIG_KV: failingKv(/config:v/) };
  const at = await cutPoint("running", "paused", statusOnly, bad);
  const f = await fixture("running");
  const trace = bindings({ at, mode: "after" }, bad);
  expect(await settleOrAbort(f.send("paused", trace.env), trace.reached)).toEqual({ aborted: true });
  expect(trace.calls[at - 1]).toMatch(statusOnly);
  expect((await history(f.sid))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/^kv_put_failed:/) });
  expect(await experimentRow(f.sid, f.eid)).toMatchObject({ status: "paused", published_status: "running" });
  expect((await siteRow(f.sid)).active_version).toBe(1);
});

it.each([["draft", "running"], ["running", "paused"]] as const)("transition_batch_throw_after_commit_returns_applied (%s)", async (from, to) => {
  const at = await cutPoint(from, to, activation);
  const f = await fixture(from);
  const before = (await events(f.sid, "experiment.status")).length;
  const trace = bindings({ at, mode: "throw_after" });
  const res = await f.send(to, trace.env);
  expect(trace.calls[at - 1]).toMatch(activation);
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: to }, publish: { ok: true } });
  expect(await events(f.sid, "experiment.status")).toHaveLength(before + 1);
  expect(await events(f.sid, "publish.publish")).toHaveLength(before + 1);
  expect(trace.calls.filter((s) => statusOnly.test(s))).toHaveLength(1);
  expect(trace.calls[at - 1]).toMatch(statusOnly);
});

it("pause_batch_throw_before_commit_runs_status_only_batch", async () => {
  const f = await fixture("running");
  const res = await f.send("paused", { DB: failingD1Query(testEnv.DB, activation) });
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: "paused", publishedStatus: "running" }, publish: { ok: false, error: "publish_failed" } });
  expect(await events(f.sid, "experiment.status")).toHaveLength(2);
  expect(await events(f.sid, "publish.publish")).toHaveLength(1);
});

it("pause_outcome_unknown_does_not_run_status_only_batch", async () => {
  const f = await fixture("running");
  const DB = failingD1Query(failingD1Query(testEnv.DB, activation), /as "own_status"/);
  const res = await f.send("paused", { DB });
  expect(res.status).toBe(503);
  expect(await json(res)).toMatchObject({ error: "publish_outcome_unknown" });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect((await history(f.sid))[0]?.status).toBe("reserved");
  expect(await events(f.sid, "experiment.status")).toHaveLength(1);
});

it.each([["draft", "running"], ["running", "archived"]] as const)("transition_finish_throw_still_returns_200_and_records_stop (%s)", async (from, to) => {
  const f = await fixture(from);
  const res = await f.send(to, { DB: failingD1Query(testEnv.DB, clearMarker) }, to === "archived" ? adopted : {});
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: to }, publish: { ok: true, warnings: expect.arrayContaining([{ path: "delivery", message: expect.any(String) }]) }, ...(to === "archived" ? { results: { recorded: true } } : {}) });
  expect((await siteRow(f.sid)).active_kv_stale).toBe(1);
  if (to === "archived") await expectArchiveRecorded(f);
});

it.each([["draft", "running"], ["running", "archived"]] as const)("response_read_failure_after_commit_returns_200 (%s)", async (from, to) => {
  for (const re of [/^select \* from "experiments" where/, /^select "last_activated_at" from "sites"/]) {
    const f = await fixture(from);
    const normal = await fixture(from);
    const trace = bindings(null);
    const extra = to === "archived" ? adopted : {};
    expect((await normal.send(to, trace.env, extra)).status).toBe(200);
    const marker = trace.calls.findIndex((s) => clearMarker.test(s));
    expect(marker).toBeGreaterThan(-1);
    const index = trace.calls.findIndex((s, i) => i > marker && re.test(s));
    expect(index, trace.calls.join("\n")).toBeGreaterThan(0);
    const failed = bindings({ at: index + 1, mode: "throw_after" });
    const res = await f.send(to, failed.env, extra);
    expect(failed.calls[index]).toMatch(re);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ experiment: { status: to, publishedStatus: to, unpublished: false }, publish: { ok: true, warnings: expect.arrayContaining([{ path: "delivery", message: expect.any(String) }]) }, ...(to === "archived" ? { results: { recorded: true } } : {}) });
    expect((await siteRow(f.sid)).active_kv_stale).toBe(0);
    if (to === "archived") await expectArchiveRecorded(f);
  }
});

it("start_preserves_unpublished_edit_to_same_experiment_after_compile", async () => {
  const { sid, eid, send, token } = await fixture();
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    const edited = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { trafficPercentage: 30 } });
    expect(edited.status).toBe(200);
  });
  const res = await send("running", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ experiment: { status: "running", unpublished: true }, publish: { ok: true } });
  expect(await json(await call("GET", `/sites/${sid}`, { token }))).toMatchObject({ hasUnpublishedChanges: true });
  expect((await experimentRow(sid, eid)).traffic_percentage).toBe(30);
  expect(JSON.parse((await testEnv.CONFIG_KV.get(kvKeys.config(sid, 1)))!).experiments[0].trafficPercentage).toBe(100);
});

it.each([false, true])("transition_target_disappears_before_compile (digest %s)", async (withDigest) => {
  const { sid, eid, send } = await fixture();
  const hook = beforeD1BatchMatching(testEnv.DB, /select \* from "audiences"/i, () =>
    db.deleteFrom("experiments").where("site_id", "=", sid).where("id", "=", eid).execute());
  const res = await send("running", { DB: hook.db }, withDigest ? { expectDigest: "a".repeat(64) } : {});
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: withDigest ? "stale_preview" : "invalid_transition" });
  expect((await history(sid))[0]?.status).toBe("failed");
});

it("pause_missing_reservation_before_config_write_keeps_status", async () => {
  const f = await fixture("running");
  const hook = beforeD1BatchMatching(testEnv.DB, /update publishes set config_hash/i, () =>
    db.deleteFrom("publishes").where("site_id", "=", f.sid).where("status", "=", "reserved").execute());
  const res = await f.send("paused", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "publish_record_missing" });
  expect(await experimentRow(f.sid, f.eid)).toMatchObject({ status: "running", published_status: "running" });
  expect((await siteRow(f.sid)).active_version).toBe(1);
});

it.each(["先行", "同じミリ秒"])("先に受け付けた PATCH が compile 後に確定した編集を残す（%s）", async (timing) => {
  const { sid, eid, send, token } = await fixture();
  const path = `/sites/${sid}/experiments/${eid}`;
  const at = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  let reached!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    // 同じミリ秒のケースでは、compile が読む updated_at も、次の PATCH が書く時刻と一致する。
    if (timing === "同じミリ秒") {
      expect((await call("PATCH", path, { token, body: { trafficPercentage: 100 } })).status).toBe(200);
      expect((await experimentRow(sid, eid)).updated_at).toBe(at);
    }
    const held = beforeD1BatchMatching(testEnv.DB, /update "experiments" set "updated_at"/i, async () => {
      reached();
      await gate;
    });
    const editing = call("PATCH", path, { token, body: { trafficPercentage: 30 }, envOverride: { DB: held.db } });
    await ready;
    if (timing === "先行") clock.mockReturnValue(at + 1);
    const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
      release();
      expect((await editing).status).toBe(200);
    });
    const res = await send("running", { DB: hook.db });
    expect(held.ran() && hook.ran()).toBe(true);
    expect(res.status).toBe(200);
    expect((await experimentRow(sid, eid)).traffic_percentage).toBe(30);
    expect(JSON.parse((await testEnv.CONFIG_KV.get(kvKeys.config(sid, 1)))!).experiments[0].trafficPercentage).toBe(100);
    expect(await json(await call("GET", `/sites/${sid}`, { token }))).toMatchObject({ hasUnpublishedChanges: true });
    expect(await json(res)).toMatchObject({ experiment: { unpublished: true }, publish: { ok: true } });
  } finally {
    release();
    clock.mockRestore();
  }
});

it("開始の compile 後に同じミリ秒で保存したメモは未公開に数えない", async () => {
  const { sid, eid, send, token } = await fixture();
  const path = `/sites/${sid}/experiments/${eid}`;
  const at = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    expect((await call("PATCH", path, { token, body: { trafficPercentage: 70 } })).status).toBe(200);
    const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
      expect((await call("PATCH", path, { token, body: { description: "確認用メモ" } })).status).toBe(200);
    });
    expect(await json(await send("running", { DB: hook.db }))).toMatchObject({ experiment: { unpublished: false }, publish: { ok: true } });
    expect(hook.ran()).toBe(true);
    expect((await experimentRow(sid, eid)).updated_at).toBe(at);
    expect((await siteRow(sid)).last_activated_at).toBe(at);
    expect(await json(await call("GET", `/sites/${sid}`, { token }))).toMatchObject({ hasUnpublishedChanges: false });
  } finally {
    clock.mockRestore();
  }
});

// A が自分の版を KV に書く直前に B を実行する。B には元の binding を渡す。
function beforeConfigPut(hook: () => Promise<void>, kv = testEnv.CONFIG_KV): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "put") return async (...args: Parameters<KVNamespace["put"]>) => {
        if (/config:v\d+$/.test(args[0])) await hook();
        return target.put(...args);
      };
      const method = Reflect.get(target, prop);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}

it.each([0, 20])("status_only_batch_updated_at_beats_concurrent_publish (batch の遅れ %i ms)", async (delay) => {
  const bad = { CONFIG_KV: failingKv(/config:v/) };
  const cut = await cutPoint("running", "paused", statusOnly, bad);
  const f = await fixture("running");
  const at = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    const CONFIG_KV = beforeConfigPut(async () => {
      clock.mockReturnValue(at + 10);
      expect(await json(await publishRes(f.token, f.sid))).toMatchObject({ ok: true, version: 3 });
      clock.mockReturnValue(at + 10 + delay);
    }, bad.CONFIG_KV);
    const trace = bindings({ at: cut, mode: "after" }, { CONFIG_KV });
    expect(await settleOrAbort(f.send("paused", trace.env), trace.reached)).toEqual({ aborted: true });
    expect(trace.calls[cut - 1]).toMatch(statusOnly);
    expect((await siteRow(f.sid)).last_activated_at).toBe(at + 10);
    expect((await experimentRow(f.sid, f.eid)).updated_at).toBe(at + 10 + Math.max(1, delay));
    expect(await json(await call("GET", `/sites/${f.sid}`, { token: f.token }))).toMatchObject({ hasUnpublishedChanges: true });
  } finally {
    clock.mockRestore();
  }
});

it.each(["paused", "archived"] as const)("pause_conflict_retries_once_then_succeeds (%s)", async (to) => {
  const f = await fixture("running");
  const at = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
      clock.mockReturnValue(at + 5);
      expect(await json(await publishRes(f.token, f.sid))).toMatchObject({ ok: true, version: 3 });
      clock.mockReturnValue(at + 10);
    });
    const res = await f.send(to, { DB: hook.db }, to === "archived" ? adopted : {});
    expect(hook.ran()).toBe(true);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ experiment: { status: to }, publish: { ok: true, version: 4 } });
    expect(await experimentRow(f.sid, f.eid)).toMatchObject({ updated_at: at + 10, ...(to === "archived" ? { stopped_at: at + 10 } : {}) });
    expect((await siteRow(f.sid)).last_activated_at).toBe(at + 10);
    if (to === "archived") await expectArchiveRecorded(f);
  } finally {
    clock.mockRestore();
  }
});

it("pause_conflict_twice_returns_409", async () => {
  const f = await fixture("running");
  let attempts = 0;
  const CONFIG_KV = beforeConfigPut(async () => {
    expect(++attempts).toBeLessThanOrEqual(2);
    expect(await json(await publishRes(f.token, f.sid))).toMatchObject({ ok: true });
  });
  const res = await f.send("paused", { CONFIG_KV });
  expect(res.status).toBe(409);
  expect(await json(res)).toEqual(conflict);
  expect(attempts).toBe(2);
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  const failed = (await history(f.sid)).filter((r) => r.status === "failed");
  expect(failed.map((r) => r.version)).toEqual([4, 2]);
  for (const r of failed) expect(r.error).toMatch(/^transition_conflict:/);
});

it.each(["paused", "archived"] as const)("pause_retry_uses_fresh_site_settings (%s)", async (to) => {
  const f = await fixture("running");
  const preview = await json(await call("GET", `/sites/${f.sid}/publish-preview?transition=${f.eid}:${to}`, { token: f.token }));
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    await db.updateTable("sites").set({ timezone: "Europe/Paris" }).where("id", "=", f.sid).execute();
    expect(await json(await publishRes(f.token, f.sid))).toMatchObject({ ok: true, version: 3 });
  });
  const res = await f.send(to, { DB: hook.db }, { expectDigest: preview.transitionDigest, ...(to === "archived" ? adopted : {}) });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "stale_preview" });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect((await history(f.sid))[0]).toMatchObject({ version: 4, status: "failed", error: expect.stringMatching(/^stale_preview:/) });
  expect(await events(f.sid, "experiment.adoption")).toHaveLength(0);
  expect(await testEnv.CONFIG_KV.get(kvKeys.active(f.sid))).toBe("3");
  expect(JSON.parse((await testEnv.CONFIG_KV.get(kvKeys.config(f.sid, 3)))!)).toMatchObject({ timezone: "Europe/Paris" });
});

it("pause_retry_trips", async () => {
  const normal = await fixture("running");
  const direct = bindings(null);
  expect((await normal.send("paused", direct.env)).status).toBe(200);
  const f = await fixture("running");
  const trace = bindings(null);
  let attempts = 0;
  const CONFIG_KV = beforeConfigPut(async () => {
    if (++attempts === 1) expect(await json(await publishRes(f.token, f.sid))).toMatchObject({ ok: true, version: 3 });
  }, trace.env.CONFIG_KV);
  expect((await f.send("paused", { ...trace.env, CONFIG_KV })).status).toBe(200);
  const reserve = trace.calls.findIndex((s) => /insert into publishes/i.test(s));
  const verify = trace.calls.indexOf(`kv.get ${kvKeys.config(f.sid, 2)}`);
  expect(reserve).toBeGreaterThan(0);
  expect(verify).toBeGreaterThan(reserve);
  const d1 = (calls: string[]) => calls.filter((s) => !s.startsWith("kv.")).length;
  const prep = d1(trace.calls.slice(reserve, verify + 1));
  const baseline = d1(direct.calls);
  const total = d1(trace.calls);
  expect({ baseline, prep, total }).toEqual({ baseline: 23, prep: 5, total: 31 });
  // 準備区間外の追加 3 往復。失敗した側は activation の batch 自体を送らない。
  expect(trace.calls[reserve - 1]).toMatch(/select "active_kv_stale", "active_version", "last_activated_at"/i);
  expect(trace.calls[verify + 1]).toMatch(/as "transition_ok"/i);
  expect(trace.calls[verify + 2]).toMatch(/update "publishes" set "status"/i);
  expect(total).toBe(baseline + prep + 3);
  expect(trace.calls.filter((s) => activation.test(s))).toHaveLength(1);
  expect(attempts).toBe(2);
});

it.each(["config", "activation_error"] as const)("pause_preserves_state_on_reservation_expiry_at_%s", async stage => {
  const f = await fixture("running");
  const expire = () => testEnv.DB.prepare("update publishes set status='failed', error='interrupted: reserved row expired' where site_id=? and version=2").bind(f.sid).run();
  const pattern = stage === "config" ? /update publishes set config_hash/i : activation;
  const hook = beforeD1BatchMatching(testEnv.DB, pattern, async () => {
    await expire();
    if (stage === "activation_error") throw new Error("activation interrupted");
  });
  const res = await f.send("paused", { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "publish_reservation_expired" });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect((await siteRow(f.sid)).active_version).toBe(1);
  if (stage === "config") expect(await testEnv.CONFIG_KV.get(kvKeys.config(f.sid, 2))).toBeNull();
});

it("an_already_active_reservation_does_not_apply_transition_after_a_missed_cas", async () => {
  const f = await fixture("running");
  const hook = beforeD1BatchMatching(testEnv.DB, activation, () => testEnv.DB.batch([
    testEnv.DB.prepare("update publishes set status='active' where site_id=? and version=2").bind(f.sid),
    testEnv.DB.prepare("update sites set active_version=2 where id=?").bind(f.sid),
  ]));
  const res = await f.send("paused", { DB: hook.db });
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "publish_reservation_expired" });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect(await events(f.sid, "experiment.status")).toHaveLength(1);
  expect(await events(f.sid, "publish.publish")).toHaveLength(1);
});

it.each([
  ["put", "expired", "publish_reservation_expired"],
  ["get", "missing", "publish_record_missing"],
] as const)("pause_handles_reservation_loss_with_config_%s_failure", async (op, lost, code) => {
  const f = await fixture("running");
  const CONFIG_KV = beforeConfigPut(async () => {
    const change = lost === "missing" ? "delete from publishes"
      : "update publishes set status='failed', error='interrupted: reserved row expired'";
    await testEnv.DB.prepare(`${change} where site_id=? and version=2`).bind(f.sid).run();
  }, failingKv(/config:v2$/, op));
  const res = await f.send("paused", { CONFIG_KV });
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: code });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect(await events(f.sid, "experiment.status")).toHaveLength(1);
});

it.each([false, true])("restored_active_during_activation_error_is_expired (old audit %s)", async withAudit => {
  const f = await fixture("running");
  // 旧版が既に残した成功の記録があれば、復元された activated_at も今回の予約時刻と一致する。
  const CONFIG_KV = beforeConfigPut(async () => {
    if (withAudit) await testEnv.DB.prepare(`insert into audit_events (at,category,action,site_id,via,detail_json)
      select created_at,'content','publish.publish',site_id,'system','{"version":2,"superseded":false}'
      from publishes where site_id=? and version=2`).bind(f.sid).run();
  });
  const hook = beforeD1BatchMatching(testEnv.DB, activation, async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("update publishes set status='active', activated_at=case when ? then created_at end where site_id=? and version=2").bind(withAudit ? 1 : 0, f.sid),
      testEnv.DB.prepare("update sites set active_version=2 where id=?").bind(f.sid),
    ]);
    throw new Error("activation response unavailable");
  });
  const res = await f.send("paused", { DB: hook.db, CONFIG_KV });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ error: "publish_reservation_expired" });
  expect((await experimentRow(f.sid, f.eid)).status).toBe("running");
  expect(await testEnv.CONFIG_KV.get(kvKeys.active(f.sid))).toBe("1");
});

it("a_committed_pause_survives_audit_id_reuse_after_retention", async () => {
  const at = await cutPoint("running", "paused", activation);
  const f = await fixture("running");
  // 保持期間を過ぎたイベントが一番大きい ID を持つ。削除後の次の INSERT はその番号を再利用できる。
  await testEnv.DB.prepare(`insert into audit_events (at, category, action, via)
    select 0, 'content', 'site.update', 'system' from json_each('[1,2,3,4,5]')`).run();
  const before = await testEnv.DB.prepare("select max(id) as id from audit_events").first<number>("id");
  const { DB } = countingD1(testEnv.DB, {
    match: activation,
    run: async () => {
      const [, removed] = await testEnv.DB.batch(retentionStatements(testEnv.DB, {
        runId: "during-activation", cutoff: Date.now() - 366 * 86_400_000,
      }));
      expect(removed?.meta.changes).toBe(5);
    },
  });
  const trace = bindings({ at, mode: "throw_after" }, { DB });
  const res = await f.send("paused", trace.env);
  expect(trace.calls[at - 1]).toMatch(activation);
  const committed = await testEnv.DB.prepare(`select id from audit_events where site_id=? and action='publish.publish'
    and json_extract(detail_json, '$.version')=2`).bind(f.sid).first<number>("id");
  expect(committed).toBeTypeOf("number");
  expect(committed!).toBeLessThanOrEqual(before!);
  expect((await experimentRow(f.sid, f.eid)).status).toBe("paused");
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ publish: { ok: true, version: 2 } });
});
