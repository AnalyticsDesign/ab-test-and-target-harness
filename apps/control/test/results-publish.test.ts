import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { RUN_ID_RE, type CompiledConfig } from "@wtt/core";
import { getDb } from "../src/db";
import { publishSite } from "../src/publish";
import { call, createExperiment, experimentRow, json, publishRes, RESULTS_STORE, runDirect, setupOwner, siteRow, testEnv, TEXT_CHANGE } from "./helpers";

// D9 ②(設計書 §6.3・§9.3、plan ② の K15・Task 11): Publish が compiled config に results を出し、収集の状態の変化を記録する

/** 計測用 D1 がある導入で作った Site(results_enabled = 1)。store = false なら結果を記録しない Site */
async function resultsSite(store = true, existing?: Awaited<ReturnType<typeof setupOwner>>) {
  const owner = existing ?? (await setupOwner());
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
    token: owner.token,
    body: { name: "Site", domain: "www.example.com" },
    ...(store ? { envOverride: RESULTS_STORE } : {}),
  });
  expect(res.status).toBe(201);
  const { id: sid } = await json<{ id: string }>(res);
  return { owner, sid };
}

/** 変更 1 件付きのテストを作る(kind は既定の test) */
async function testExperiment(token: string, sid: string, id: string, overrides: Record<string, unknown> = {}) {
  await createExperiment(token, sid, { id, ...overrides });
  const variant = overrides.kind === "single" ? "a" : "b";
  await call("PUT", `/sites/${sid}/experiments/${id}/variants/${variant}/changes`, { token, body: [TEXT_CHANGE()] });
}

/** /status で遷移する(開始で run_id を振るには計測用 D1 が要る。遷移は自動で公開する) */
async function transition(token: string, sid: string, eid: string, status: string) {
  const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(200);
  expect((await json(res)).publish.ok).toBe(true);
}

/** active な版の compiled config(D1 の publishes.config_json) */
async function activeConfig(sid: string): Promise<CompiledConfig> {
  const site = await siteRow(sid);
  const row = await getDb(env).selectFrom("publishes").select("config_json").where("site_id", "=", sid).where("version", "=", site.active_version!).executeTakeFirstOrThrow();
  return JSON.parse(row.config_json!);
}

async function publish(token: string, sid: string): Promise<number> {
  const r = await json(await publishRes(token, sid));
  expect(r.ok).toBe(true);
  return r.version;
}

const logRows = (sid: string) =>
  getDb(env).selectFrom("results_collection_log").select(["enabled", "publish_version"]).where("site_id", "=", sid).orderBy("id").execute();

/**
 * `:active` の put の直前に D1 の `active_version` を別の版へ進める KV(publish.test.ts と同じ)。
 * activation の後に別の Publish に追い越された状況を作る(published_status と同じ fence を見る)
 */
function kvBumpingActiveOnPut(sid: string, to: number): KVNamespace {
  return new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "put")
        return async (key: string, ...rest: unknown[]) => {
          if (/:active$/.test(key)) await getDb(env).updateTable("sites").set({ active_version: to }).where("id", "=", sid).execute();
          return (target.put as (...a: unknown[]) => unknown).apply(target, [key, ...rest]);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as KVNamespace;
}

describe("Publish の results(D9 ②)", () => {
  it("publishes results.runs for running and paused tests with run_id", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_run");
    await testExperiment(owner.token, sid, "exp_pause");
    await transition(owner.token, sid, "exp_run", "running");
    await transition(owner.token, sid, "exp_pause", "running");
    await transition(owner.token, sid, "exp_pause", "paused");
    const runA = (await experimentRow(sid, "exp_run")).run_id!;
    const runB = (await experimentRow(sid, "exp_pause")).run_id!;
    expect(runA).toMatch(RUN_ID_RE);
    expect(runB).toMatch(RUN_ID_RE);
    const config = await activeConfig(sid);
    expect(config.results).toEqual({ forget: true, runs: { exp_run: runA, exp_pause: runB } });
    // paused は experiments[] に載らない(CV を受けるために runs で持つ)
    expect(config.experiments.map((e) => e.id)).toEqual(["exp_run"]);
  });

  it("omits results when the site does not record and no rows may remain", async () => {
    const { owner, sid } = await resultsSite(false);
    await testExperiment(owner.token, sid, "exp_plain");
    await transition(owner.token, sid, "exp_plain", "running");
    expect((await experimentRow(sid, "exp_plain")).run_id).toBeNull();
    const config = await activeConfig(sid);
    expect(config.experiments.map((e) => e.id)).toEqual(["exp_plain"]);
    expect("results" in config).toBe(false);
    // 結果を記録する Site でも、開始したテストが無ければ出さない
    const other = await resultsSite(true, owner);
    await publish(owner.token, other.sid);
    expect("results" in (await activeConfig(other.sid))).toBe(false);
  });

  it("keeps results with empty runs while a run has not been purged", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_live");
    await testExperiment(owner.token, sid, "exp_done");
    await transition(owner.token, sid, "exp_live", "running");
    await transition(owner.token, sid, "exp_done", "running");
    await transition(owner.token, sid, "exp_done", "archived");
    const live = (await experimentRow(sid, "exp_live")).run_id!;
    // 終了したテストは runs に載らない
    expect((await activeConfig(sid)).results).toEqual({ forget: true, runs: { exp_live: live } });
    // 結果の記録を無効にすると runs は空(実行中のテストも送らない)。個票が残っている間は forget のために出し続ける
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: false } })).status).toBe(200);
    await publish(owner.token, sid);
    expect((await activeConfig(sid)).results).toEqual({ forget: true, runs: {} });
    // すべてのテストが終了した後も同じ
    await transition(owner.token, sid, "exp_live", "archived");
    expect((await activeConfig(sid)).results).toEqual({ forget: true, runs: {} });
  });

  it("drops results once all runs are purged", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_a");
    await testExperiment(owner.token, sid, "exp_b");
    await transition(owner.token, sid, "exp_a", "running");
    await transition(owner.token, sid, "exp_b", "running");
    await transition(owner.token, sid, "exp_a", "archived");
    await transition(owner.token, sid, "exp_b", "archived");
    const db = getDb(env);
    // 1 つだけ消した: もう 1 つの個票が残っているので出し続ける
    await db.updateTable("experiments").set({ results_purged_at: Date.now() }).where("site_id", "=", sid).where("id", "=", "exp_a").execute();
    await publish(owner.token, sid);
    expect((await activeConfig(sid)).results).toEqual({ forget: true, runs: {} });
    // すべて消した: 出さない
    await db.updateTable("experiments").set({ results_purged_at: Date.now() }).where("site_id", "=", sid).where("run_id", "is not", null).execute();
    await publish(owner.token, sid);
    expect("results" in (await activeConfig(sid))).toBe(false);
  });

  it("single and run_id-less tests are not in runs", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_single", { kind: "single" });
    await testExperiment(owner.token, sid, "exp_legacy");
    await testExperiment(owner.token, sid, "exp_recorded");
    await transition(owner.token, sid, "exp_single", "running");
    expect((await experimentRow(sid, "exp_single")).run_id).toBeNull(); // パーソナライズには振らない
    await runDirect(sid, "exp_legacy"); // 結果の記録より前に開始したテスト(run_id が無い)
    await transition(owner.token, sid, "exp_recorded", "running");
    const recorded = (await experimentRow(sid, "exp_recorded")).run_id!;
    // 万一パーソナライズに run_id があっても runs には載せない
    await sql`update experiments set run_id = ${"A".repeat(22)} where site_id = ${sid} and id = 'exp_single'`.execute(getDb(env));
    await publish(owner.token, sid);
    const config = await activeConfig(sid);
    expect(config.experiments.map((e) => e.id).sort()).toEqual(["exp_legacy", "exp_recorded", "exp_single"]);
    expect(config.results).toEqual({ forget: true, runs: { exp_recorded: recorded } });
  });

  it("records results_collection_log when the published state changes", async () => {
    const { owner, sid } = await resultsSite(false); // 結果を記録しない Site で始める
    await testExperiment(owner.token, sid, "exp_hero");
    await runDirect(sid, "exp_hero");
    // 行が無く無効のときは足さない
    await publish(owner.token, sid);
    expect(await logRows(sid)).toEqual([]);
    // 有効にして公開すると 1 行
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: true }, envOverride: RESULTS_STORE })).status).toBe(200);
    const v2 = await publish(owner.token, sid);
    expect(await logRows(sid)).toEqual([{ enabled: 1, publish_version: v2 }]);
    // 同じ状態の再公開では足さない
    await publish(owner.token, sid);
    expect(await logRows(sid)).toEqual([{ enabled: 1, publish_version: v2 }]);
    // 無効にして公開すると 1 行
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: false } })).status).toBe(200);
    const v4 = await publish(owner.token, sid);
    expect(await logRows(sid)).toEqual([{ enabled: 1, publish_version: v2 }, { enabled: 0, publish_version: v4 }]);
    await publish(owner.token, sid);
    expect(await logRows(sid)).toHaveLength(2);
    // 時刻は公開の時刻(activation と同じ nowMs)
    const at = await getDb(env).selectFrom("results_collection_log").select("at").where("site_id", "=", sid).where("publish_version", "=", v4).executeTakeFirstOrThrow();
    const pub = await getDb(env).selectFrom("publishes").select("activated_at").where("site_id", "=", sid).where("version", "=", v4).executeTakeFirstOrThrow();
    expect(at.at).toBe(pub.activated_at);
  });

  it("superseded publish does not record collection log", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_hero");
    await runDirect(sid, "exp_hero");
    const db = getDb(env);
    // activation の前に追い越された(自分より新しい版が先に active になった)
    await db.updateTable("sites").set({ active_version: 9 }).where("id", "=", sid).execute();
    const r = await publishSite(testEnv, db, await siteRow(sid), owner.userId);
    expect(r).toMatchObject({ ok: true, superseded: true });
    expect(await logRows(sid)).toEqual([]);
    // activation の後、active の put の最中に追い越された(published_status と同じ fence で書かない)
    await db.updateTable("sites").set({ active_version: null }).where("id", "=", sid).execute();
    const bumped = await json(await publishRes(owner.token, sid, { CONFIG_KV: kvBumpingActiveOnPut(sid, 99) }));
    expect(bumped).toMatchObject({ ok: true, superseded: false });
    expect(await logRows(sid)).toEqual([]);
  });

  it("draft bootstrap has no results", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_live");
    await transition(owner.token, sid, "exp_live", "running");
    const run = (await experimentRow(sid, "exp_live")).run_id!;
    expect((await activeConfig(sid)).results).toEqual({ forget: true, runs: { exp_live: run } }); // 公開した config には出ている
    const res = await call("GET", `/sites/${sid}/experiments/exp_live/draft-bootstrap`, { token: owner.token });
    expect(res.status).toBe(200);
    const body = await res.text();
    const boot = JSON.parse(body.split("self.__WTT_BOOT__=")[1]!.split(";\n")[0]!);
    expect(boot.config.experiments.map((e: { id: string }) => e.id)).toEqual(["exp_live"]);
    expect("results" in boot.config).toBe(false);
  });
});
