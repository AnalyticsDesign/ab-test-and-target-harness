import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { getDb } from "../src/db";
import { WriteFrozen } from "../src/results/guard";
import type { ReadSession } from "../src/results/read-session";
import { ensureSnapshot, snapshotTarget } from "../src/results/snapshot";
import { recordStop } from "../src/results/stop";
import { beforeD1Batch, call, experimentRow, failingD1Insert, failingKv, fakeDeployer, fakeResultsBudget, fakeResultsHealth, json, RESULTS_STORE, seedResults, setupOwner, siteRow, testEnvWith } from "./helpers";
import {
  backdate,
  conversionsOf,
  DAY,
  db,
  def,
  getResults,
  HOUR,
  MIN,
  noteKeys,
  participants,
  recordingSite,
  resultsOverride,
  seedDelivered,
  seedWinner,
  setStatus,
  snapshotRows,
  startTest,
  adoptionRow,
  type Report,
} from "./results-fixtures";

// D9 plan ③ Task 10(K13・K15・K24、設計書 §5.3・§7.5): 結果の記録(評価時点の記録・終了の記録)

/** 本物の計測用 D1 を読む ReadSession(予約は持たない)。onBatch で読んだ後に割り込める */
function directRead(onBatch?: () => Promise<void>): ReadSession & { batches: number } {
  const s = {
    batches: 0,
    async batch(stmts: D1PreparedStatement[]) {
      s.batches++;
      const out = await env.RESULTS_DB!.batch(stmts);
      if (onBatch) await onBatch();
      return out;
    },
    async close() {},
  };
  return s;
}
const noRead: ReadSession = {
  batch: async () => {
    throw new Error("must not read RESULTS_DB");
  },
  close: async () => {},
};

describe("結果の記録(固定)", () => {
  test("snapshot_definition_comes_from_version_active_at_cutoff", async () => {
    // 評価時点(cutoff)で有効だった届く定義の行を写す。cutoff の前に終わった行・cutoff の後に始まった行は使わない。
    // 注記 aa_test は写した定義(b に変更なし)から出す(今の保存済みの b には変更がある)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_def");
    const s = Date.now() - 15 * DAY;
    const e = s + 14 * DAY;
    await backdate(sid, "exp_def", s);
    await seedDelivered(sid, "exp_def", runId, [
      { version: 1, d: def("Early"), from: s, until: s + DAY },
      { version: 2, d: def(null), from: s + DAY, until: e + 2 * HOUR },
      { version: 3, d: def("After"), from: e + 2 * HOUR },
    ]);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const res = await getResults(owner, sid, "exp_def");
    expect(res.status).toBe(200);
    const r = await json<Report>(res);
    expect(r).toMatchObject({ phase: "fixed", persisted: true, cutoff: e, stoppedEarly: false });
    expect(r.definition).toEqual(def(null));
    expect(noteKeys(r)).toContain("aa_test");
    const rows = await snapshotRows(sid, "exp_def");
    expect(rows.map((x) => [x.kind, x.cutoff_at, x.run_id])).toEqual([["evaluation", e, runId]]);
    expect(JSON.parse(rows[0]!.result_json).definition).toEqual(def(null));
  });

  test("snapshot_definition_when_test_paused_at_cutoff / stop_snapshot_definition_taken_from_version_before_archive", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const deployer = fakeDeployer();
    // (1) 一時停止中に評価時点を迎えた: 一時停止の間の Publish は届く定義の行を作らないので、一時停止の直前の定義を写す
    const runId = await startTest(owner, sid, "exp_paused", {}, { envOverride: { DEPLOYER: deployer } });
    expect((await setStatus(owner, sid, "exp_paused", { status: "paused" }, { DEPLOYER: deployer })).status).toBe(200);
    expect((await call("PUT", `/sites/${sid}/experiments/exp_paused/variants/b/changes`, { token: owner.token, body: [{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "While paused" } }] })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/publish`, { token: owner.token, envOverride: { ...RESULTS_STORE, DEPLOYER: deployer } })).status).toBe(200);
    const delivered = await db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).where("experiment_id", "=", "exp_paused").execute();
    expect(delivered).toHaveLength(1);
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_paused", s);
    await env.DB.prepare("update experiment_delivered_definitions set delivered_from = ? where site_id = ? and experiment_id = ?").bind(s, sid, "exp_paused").run();
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const paused = await json<Report>(await getResults(owner, sid, "exp_paused"));
    expect(paused.phase).toBe("fixed");
    expect(paused.definition!.variants.find((v) => v.id === "b")!.changes).toEqual([{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "Hello" } }]);

    // (2) 評価時点の前の終了: 終了の直前に配信していた行(v2)を写す。終了の後に配信を確かめた行(v3)は使わない
    const run2 = await startTest(owner, sid, "exp_stop");
    const s2 = Date.now() - 3 * DAY;
    await backdate(sid, "exp_stop", s2);
    const now = Date.now();
    await seedDelivered(sid, "exp_stop", run2, [
      { version: 1, d: def("Before"), from: s2, until: now - HOUR },
      { version: 2, d: def("Last"), from: now - HOUR, until: now + HOUR },
      { version: 3, d: def("Later"), from: now + HOUR },
    ]);
    await seedResults(seedWinner(run2, sid, s2 + HOUR));
    const stop = await setStatus(owner, sid, "exp_stop", { status: "archived" }, resultsOverride());
    expect(stop.status).toBe(200);
    expect((await json(stop)).results).toEqual({ recorded: true });
    const stoppedAt = (await experimentRow(sid, "exp_stop")).stopped_at!;
    const rows = await snapshotRows(sid, "exp_stop");
    expect(rows.map((x) => [x.kind, x.cutoff_at])).toEqual([["stop", stoppedAt]]);
    const snap = JSON.parse(rows[0]!.result_json);
    expect(snap.definition).toEqual(def("Last"));
    expect(snap.phase).toBe("stopped");
    expect(snap.stoppedEarly).toBe(true);
    expect(snap.notes.map((n: { key: string }) => n.key)).toContain("stopped_early");
  });

  test("記録に名前を写す: 目標を削除した後も記録の目標の名前が読める", async () => {
    // 目標は評価計画からだけ参照する(配信条件から参照すると、終了したテストの参照で削除が止まる)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_names");
    expect((await experimentRow(sid, "exp_names")).targeting_json).toBeNull();
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_names", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    expect((await getResults(owner, sid, "exp_names")).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_names", { status: "archived" }, resultsOverride())).status).toBe(200);
    for (const gid of ["g_buy", "g_other"]) expect([200, 204]).toContain((await call("DELETE", `/sites/${sid}/goals/${gid}`, { token: owner.token })).status);
    expect(await db().selectFrom("goals").select("id").where("site_id", "=", sid).execute()).toEqual([]);
    const r = await json<Report>(await getResults(owner, sid, "exp_names"));
    expect(r.phase).toBe("fixed");
    expect(r.names!.goals).toEqual({ g_buy: "購入", g_other: "資料請求" });
    expect(r.names!.experiment).toBe("Hero");
    expect(r.names!.variants).toEqual({ a: { name: "A", original: true }, b: { name: "B", original: false } });
    expect(r.otherGoals.map((g) => [g.goalId, g.name])).toEqual([["g_other", "資料請求"]]);
  });

  test("stop_unpublishes_even_if_results_snapshot_fails", async () => {
    // 記録の batch を失敗させても 200・状態は archived・Publish は済み・results.recorded false(採用も同じ batch なので未記録)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_fail");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_fail", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    expect((await getResults(owner, sid, "exp_fail")).status).toBe(200); // 保存した速報を作っておく
    const res = await setStatus(owner, sid, "exp_fail", { status: "archived", adoption: { variantId: "b", note: "B を採用" } }, { ...resultsOverride(), DB: failingD1Insert(env.DB, "result_snapshots") });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.results).toEqual({ recorded: false });
    expect(body.experiment.status).toBe("archived");
    expect(body.publish.ok).toBe(true);
    expect(body.experiment.publishedStatus).toBe("archived");
    expect(await snapshotRows(sid, "exp_fail")).toEqual([]);
    expect(await adoptionRow(sid, "exp_fail")).toBeUndefined();
    // 終了の後は保存した速報を消す
    expect(await db().selectFrom("results_interim_cache").selectAll().where("site_id", "=", sid).execute()).toEqual([]);
  });

  test("終了は配信を止めてから(Publish の後で)記録の読み取りを始める", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_order");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_order", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const budget = fakeResultsBudget();
    const seen: Array<{ version: number | null; published: string | null }> = [];
    const original = budget.stub.reserveRead.bind(budget.stub);
    budget.stub.reserveRead = async (day, rows, now) => {
      seen.push({ version: (await siteRow(sid)).active_version, published: (await experimentRow(sid, "exp_order")).published_status });
      return original(day, rows, now);
    };
    const body = await json(await setStatus(owner, sid, "exp_order", { status: "archived" }, resultsOverride(budget)));
    expect(body.publish.ok).toBe(true);
    expect(body.results).toEqual({ recorded: true });
    expect(seen).toEqual([{ version: body.publish.version, published: "archived" }]);
  });

  test("終了の後は保存した速報を消す(公開が失敗しても)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_cache");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_cache", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    expect((await getResults(owner, sid, "exp_cache")).status).toBe(200);
    expect(await db().selectFrom("results_interim_cache").selectAll().where("site_id", "=", sid).execute()).toHaveLength(1);
    // 新しい版の config の書き込みを失敗させる(activation に届かない = Publish は速報を消さない)
    const res = await setStatus(owner, sid, "exp_cache", { status: "archived" }, { ...resultsOverride(), CONFIG_KV: failingKv(/config:v\d+$/) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish.ok).toBe(false);
    expect(body.experiment.status).toBe("archived");
    expect(body.results).toEqual({ recorded: true });
    expect(await db().selectFrom("results_interim_cache").selectAll().where("site_id", "=", sid).execute()).toEqual([]);
  });

  test("stop_creates_missing_evaluation_snapshot_first / stop_after_evaluation_keeps_fixed_verdict / no_stop_snapshot_after_evaluation_point", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // (1) 評価時点を過ぎて記録が無い: 終了の処理が先に評価時点の記録を作る(終了の記録は作らない)。採用も同じ batch で書く
    const run1 = await startTest(owner, sid, "exp_first");
    const s = Date.now() - 15 * DAY;
    const e = s + 14 * DAY;
    await backdate(sid, "exp_first", s);
    await seedResults(seedWinner(run1, sid, s + HOUR));
    // 評価時点の後の参加(記録に入らない)
    await seedResults({ participants: participants(run1, sid, "a", 50, e + HOUR) });
    const budget1 = fakeResultsBudget();
    const stop1 = await setStatus(owner, sid, "exp_first", { status: "archived", adoption: { variantId: "b" } }, resultsOverride(budget1));
    expect(stop1.status).toBe(200);
    expect((await json(stop1)).results).toEqual({ recorded: true });
    const rows1 = await snapshotRows(sid, "exp_first");
    expect(rows1.map((x) => [x.kind, x.cutoff_at])).toEqual([["evaluation", e]]);
    expect(JSON.parse(rows1[0]!.result_json).variants.map((v: { n: number }) => v.n)).toEqual([300, 300]);
    expect((await adoptionRow(sid, "exp_first"))!.variant_id).toBe("b");
    expect(budget1.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(budget1.calls.filter((c) => c.method === "settleRead")).toHaveLength(1);

    // (2) 評価時点の記録が既にある: 終了しても記録は変わらず(読み取りの予約もしない)、終了の記録は作らない
    const run2 = await startTest(owner, sid, "exp_kept");
    await backdate(sid, "exp_kept", s);
    await seedResults(seedWinner(run2, sid, s + HOUR));
    const first = await json<Report>(await getResults(owner, sid, "exp_kept"));
    expect(first.phase).toBe("fixed");
    const before = await snapshotRows(sid, "exp_kept");
    await seedResults({ participants: participants(run2, sid, "b", 80, e + HOUR), conversions: [] });
    const budget2 = fakeResultsBudget();
    const stop2 = await setStatus(owner, sid, "exp_kept", { status: "archived", adoption: { variantId: "b" } }, resultsOverride(budget2));
    expect((await json(stop2)).results).toEqual({ recorded: true });
    expect(budget2.calls.filter((c) => c.method === "reserveRead")).toHaveLength(0);
    expect(await snapshotRows(sid, "exp_kept")).toEqual(before);
    const after = await json<Report>(await getResults(owner, sid, "exp_kept"));
    expect(after.variants.map((v) => [v.id, v.n, v.y, v.state])).toEqual(first.variants.map((v) => [v.id, v.n, v.y, v.state]));
    expect(after.phase).toBe("fixed");
    expect(after.snapshots).toEqual({ evaluation: true, stop: false });
    expect(after.adoption).toMatchObject({ variantId: "b" });
  });

  test("early_stop_does_not_create_evaluation_snapshot_later", async () => {
    // 評価時点の前に終了したテストは、評価時点を過ぎた後に結果を読んでも終了の記録(cutoff = 終了の時刻)だけで、評価時点の記録は作らない
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_early");
    const s = Date.now() - 20 * DAY;
    const stoppedAt = s + 10 * DAY;
    await backdate(sid, "exp_early", s);
    await env.DB.prepare("update experiments set status = 'archived', stopped_at = ? where site_id = ? and id = ?").bind(stoppedAt, sid, "exp_early").run();
    await seedResults(seedWinner(runId, sid, s + HOUR));
    await seedResults({ participants: participants(runId, sid, "b", 40, stoppedAt + HOUR) }); // 終了の後(記録に入らない)
    const r = await json<Report>(await getResults(owner, sid, "exp_early"));
    expect(r).toMatchObject({ phase: "stopped", stoppedEarly: true, cutoff: stoppedAt });
    expect(r.variants.map((v) => v.n)).toEqual([300, 300]);
    expect(noteKeys(r)).toContain("stopped_early");
    // 配信を確かめた届く定義が無い(出し直しの依頼先が無い導入で開始): 写しなしで記録し、注記 definition_missing
    expect(r.definition).toBeNull();
    expect(noteKeys(r)).toContain("definition_missing");
    expect((await snapshotRows(sid, "exp_early")).map((x) => x.kind)).toEqual(["stop"]);
    // もう一度読んでも評価時点の記録は作らない
    const again = await json<Report>(await getResults(owner, sid, "exp_early"));
    expect(again.phase).toBe("stopped");
    expect((await snapshotRows(sid, "exp_early")).map((x) => x.kind)).toEqual(["stop"]);
  });

  test("evaluation_snapshot_is_not_created_twice", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_twice");
    const s = Date.now() - 15 * DAY;
    const e = s + 14 * DAY;
    await backdate(sid, "exp_twice", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const first = await json<Report>(await getResults(owner, sid, "exp_twice"));
    const budget = fakeResultsBudget();
    const second = await json<Report>(await getResults(owner, sid, "exp_twice", resultsOverride(budget)));
    expect(second.computedAt).toBe(first.computedAt);
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(0);
    expect(await snapshotRows(sid, "exp_twice")).toHaveLength(1);

    // ensureSnapshot: 記録があれば読まずに返す
    const cenv = testEnvWith({ resultsStore: true });
    const site = await siteRow(sid);
    const exp = await experimentRow(sid, "exp_twice");
    const stored = await ensureSnapshot(cenv, getDb(env), site, exp, "evaluation", e, Date.now(), noRead, async () => {});
    expect(stored!.computedAt).toBe(first.computedAt);

    // 並行して先に書かれた(INSERT が 0 行): 自分の計算ではなく保存済みの記録を返す(API と Cron が同じ記録を返す)
    const run2 = await startTest(owner, sid, "exp_race");
    await backdate(sid, "exp_race", s);
    await seedResults(seedWinner(run2, sid, s + HOUR));
    const exp2 = await experimentRow(sid, "exp_race");
    const winner = JSON.stringify({ ...first, computedAt: 42, persisted: true, definition: null, names: { experiment: "x", variants: {}, goals: {} } });
    const read = directRead(async () => {
      await env.DB.prepare(
        "insert or ignore into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?, ?, 'evaluation', ?, ?, 42, 'v', ?)",
      )
        .bind(sid, "exp_race", run2, e, winner)
        .run();
    });
    const raced = await ensureSnapshot(cenv, getDb(env), site, exp2, "evaluation", e, Date.now(), read, async () => {});
    expect(raced!.computedAt).toBe(42);
    expect(await snapshotRows(sid, "exp_race")).toHaveLength(1);
  });

  test("凍結中は記録を保存せず、計算した値を persisted: false で返す(K24)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_frozen");
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_frozen", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\",\"until\":\"2099-01-01T00:00:00+09:00\"}', 1)").run();
    try {
      const r = await json<Report>(await getResults(owner, sid, "exp_frozen"));
      expect(r).toMatchObject({ phase: "fixed", persisted: false });
      expect(r.variants.map((v) => v.n)).toEqual([300, 300]);
      expect(await snapshotRows(sid, "exp_frozen")).toEqual([]);
      // ensureSnapshot に凍結の guard を渡しても同じ
      const frozen = await ensureSnapshot(testEnvWith({ resultsStore: true }), getDb(env), await siteRow(sid), await experimentRow(sid, "exp_frozen"), "evaluation", s + 14 * DAY, Date.now(), directRead(), async () => {
        throw new WriteFrozen();
      });
      expect(frozen!.persisted).toBe(false);
      expect(await snapshotRows(sid, "exp_frozen")).toEqual([]);
    } finally {
      await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    }
    expect((await json<Report>(await getResults(owner, sid, "exp_frozen"))).persisted).toBe(true);
    expect(await snapshotRows(sid, "exp_frozen")).toHaveLength(1);
  });

  test("snapshot_quality_ignores_post_cutoff_updates", async () => {
    // 記録の品質は cutoff の時点の値: cutoff の後の混在・失敗・回復・収集の失敗・収集の停止は入らない。記録の後に増えても変わらない
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_quality");
    const s = Date.now() - 15 * DAY;
    const e = s + 14 * DAY;
    await backdate(sid, "exp_quality", s);
    const a = participants(runId, sid, "a", 300, s + HOUR, MIN, { mixed: 1, mixedAt: e + HOUR });
    const b = [
      ...participants(runId, sid, "b", 100, s + HOUR, MIN, { applied: "failed", failedAt: e + HOUR }),
      ...participants(runId, sid, "b", 100, s + HOUR, MIN, { applied: "recovered", failedAt: s + 2 * HOUR, recoveredAt: e + HOUR }),
      ...participants(runId, sid, "b", 100, s + HOUR, MIN),
    ];
    await seedResults({ participants: [...a, ...b], conversions: [...conversionsOf(a, "g_buy", 30), ...conversionsOf(b, "g_buy", 45)] });
    const hour = (t: number) => t - (t % HOUR);
    const health = fakeResultsHealth({ [runId]: [{ hour: hour(s + 3 * HOUR), failed: 2 }, { hour: hour(e) + HOUR, failed: 500 }] });
    const budget = fakeResultsBudget({ stopPeriods: [{ reason: "write_budget", from: e + HOUR, to: e + 5 * HOUR }] });
    const r = await json<Report>(await getResults(owner, sid, "exp_quality", resultsOverride(budget, health)));
    expect(r.phase).toBe("fixed");
    expect(r.qualityDetail.mixedRate).toBe(0);
    expect(r.qualityDetail.failedSends).toBe(2);
    expect(r.qualityDetail.stopPeriods).toEqual([]);
    expect(r.variants.find((v) => v.id === "b")).toMatchObject({ applyFailed: 100, applyRecovered: 0 });
    // 記録の後に cutoff の後のデータが増えても、記録は変わらない
    await seedResults({ participants: participants(runId, sid, "a", 100, e + 2 * HOUR, MIN, { mixed: 1, mixedAt: e + 2 * HOUR }) });
    const again = await json<Report>(await getResults(owner, sid, "exp_quality", resultsOverride(fakeResultsBudget(), fakeResultsHealth({ [runId]: [{ hour: hour(s + 3 * HOUR), failed: 900 }] }))));
    expect(again.qualityDetail).toEqual(r.qualityDetail);
    expect(again.variants).toEqual(r.variants);
  });

  test("記録の後の結果の API は記録を読むだけ(RESULTS_DB を読まない)。個票の削除の後は records: purged で同じ数字", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_read");
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_read", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const first = await json<Report>(await getResults(owner, sid, "exp_read"));
    expect(first.phase).toBe("fixed");
    // 計測用 D1 を読むと投げる binding・予約を必ず断る予算の DO でも、記録を返す
    const throwingDb = new Proxy(env.RESULTS_DB!, {
      get() {
        throw new Error("RESULTS_DB must not be touched");
      },
    }) as D1Database;
    const budget = fakeResultsBudget({ readBudget: 0 });
    const second = await json<Report>(await getResults(owner, sid, "exp_read", { RESULTS_DB: throwingDb, RESULTS_BUDGET: budget.ns }));
    expect(second.variants).toEqual(first.variants);
    expect(budget.calls).toEqual([]);
    // 計測用 D1 の binding が無い導入でも記録を返す
    const noStore = await json<Report>(await getResults(owner, sid, "exp_read", {}));
    expect(noStore.variants).toEqual(first.variants);
    // 個票の削除の後: records: purged・注記 purged・同じ数字
    await env.DB.prepare("update experiments set results_purged_at = ? where site_id = ? and id = ?").bind(Date.now(), sid, "exp_read").run();
    const purged = await json<Report>(await getResults(owner, sid, "exp_read"));
    expect(purged.records).toBe("purged");
    expect(purged.phase).toBe("fixed");
    expect(purged.variants).toEqual(first.variants);
    expect(noteKeys(purged)).toContain("purged");
    expect(purged.helpKeys).toContain("retention");
  });

  test("first_fixed_snapshot_shares_reach_read_reservation", async () => {
    // 到達を初めて見つけ、その評価時点を過ぎていれば同じ要求で記録を作る → 予約 1 回・精算 1 回。終了も外側の予約 1 つで行う
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const plan = { targetPerVariant: 100, minDays: 1 };
    const s = Date.now() - 3 * DAY;
    const minEnd = s + DAY;
    // (1) 結果の API
    const run1 = await startTest(owner, sid, "exp_reach", plan);
    await backdate(sid, "exp_reach", s);
    await seedResults(seedWinner(run1, sid, s + HOUR));
    const budget = fakeResultsBudget();
    const r = await json<Report>(await getResults(owner, sid, "exp_reach", resultsOverride(budget)));
    expect(r.phase).toBe("fixed");
    expect(r.cutoff).toBe(minEnd);
    expect(r.evaluation!.reachedAt).toBe(s + HOUR + 99 * MIN);
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(budget.calls.filter((c) => c.method === "settleRead")).toHaveLength(1);
    expect((await snapshotRows(sid, "exp_reach")).map((x) => [x.kind, x.cutoff_at])).toEqual([["evaluation", minEnd]]);
    const planRow = await db().selectFrom("evaluation_plans").select("reached_at").where("site_id", "=", sid).where("experiment_id", "=", "exp_reach").executeTakeFirstOrThrow();
    expect(planRow.reached_at).toBe(s + HOUR + 99 * MIN);

    // (2) 終了: 到達を記録していない(記録した計画では評価時点 = 最大期間の終わり = 未来)テストを終了すると、
    // 同じ予約の中で到達を確かめ、評価時点の後の終了として評価時点の記録を作る(終了の記録ではない)
    const run2 = await startTest(owner, sid, "exp_reach_stop", plan);
    await backdate(sid, "exp_reach_stop", s);
    await seedResults(seedWinner(run2, sid, s + HOUR));
    const budget2 = fakeResultsBudget();
    const stop = await setStatus(owner, sid, "exp_reach_stop", { status: "archived", adoption: { variantId: null } }, resultsOverride(budget2));
    expect((await json(stop)).results).toEqual({ recorded: true });
    expect(budget2.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(budget2.calls.filter((c) => c.method === "settleRead")).toHaveLength(1);
    expect((await snapshotRows(sid, "exp_reach_stop")).map((x) => [x.kind, x.cutoff_at])).toEqual([["evaluation", minEnd]]);
    expect((await adoptionRow(sid, "exp_reach_stop"))!.variant_id).toBeNull();
  });
});

describe("記録の種類の規則と、正の判定の記録は 1 件(Task 10 の追補)", () => {
  test("snapshotTarget: 評価時点の前は null、早期終了は stop(cutoff = 終了の時刻)、それ以外は evaluation(cutoff = 評価時点)", () => {
    const ev = (evaluationAt: number, stoppedEarly: boolean) => ({ point: { evaluationAt, stoppedEarly } });
    expect(snapshotTarget(null, 1000)).toBeNull();
    expect(snapshotTarget(ev(2000, false), 1999)).toBeNull();
    expect(snapshotTarget(ev(2000, false), 2000)).toEqual({ kind: "evaluation", cutoff: 2000 });
    expect(snapshotTarget(ev(1500, true), 1500)).toEqual({ kind: "stop", cutoff: 1500 });
    expect(snapshotTarget(ev(1500, true), 9999)).toEqual({ kind: "stop", cutoff: 1500 });
  });

  test("ensureSnapshot は種類が違っても正の判定の記録を返し、2 件目を書かない(読み取りの後に先に書かれた場合も)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_one");
    const s = Date.now() - 15 * DAY;
    const e = s + 14 * DAY;
    await backdate(sid, "exp_one", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const first = await json<Report>(await getResults(owner, sid, "exp_one"));
    expect(first.phase).toBe("fixed");
    const cenv = testEnvWith({ resultsStore: true });
    const site = await siteRow(sid);
    // 既に評価時点の記録がある: stop を求めても読まずに評価時点の記録を返す
    const wrong = await ensureSnapshot(cenv, getDb(env), site, await experimentRow(sid, "exp_one"), "stop", e, Date.now(), noRead, async () => {});
    expect(wrong).toMatchObject({ phase: "fixed", computedAt: first.computedAt });
    expect((await snapshotRows(sid, "exp_one")).map((x) => x.kind)).toEqual(["evaluation"]);
    // 計算している間に別の種類の記録が先に書かれた: INSERT は 0 行で、先に書かれた記録を返す
    const run2 = await startTest(owner, sid, "exp_two");
    await backdate(sid, "exp_two", s);
    await seedResults(seedWinner(run2, sid, s + HOUR));
    const other = JSON.stringify({ ...first, phase: "fixed", computedAt: 77, persisted: true, definition: null, names: { experiment: "x", variants: {}, goals: {} } });
    const read = directRead(async () => {
      await env.DB.prepare(
        "insert or ignore into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?, ?, 'evaluation', ?, ?, 77, 'v', ?)",
      )
        .bind(sid, "exp_two", run2, e, other)
        .run();
    });
    const raced = await ensureSnapshot(cenv, getDb(env), site, await experimentRow(sid, "exp_two"), "stop", e, Date.now(), read, async () => {});
    expect(raced!.computedAt).toBe(77);
    expect((await snapshotRows(sid, "exp_two")).map((x) => x.kind)).toEqual(["evaluation"]);
  });

  test("INSERT が 0 行で読み直しても記録が無ければ persisted: false。終了も recorded false で採用を書かない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_gone");
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_gone", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const cenv = testEnvWith({ resultsStore: true });
    const site = await siteRow(sid);
    // エクスペリエンスの run_id が読んだ行と違う(INSERT の条件に合わない)
    const stale = { ...(await experimentRow(sid, "exp_gone")), run_id: "run_other" };
    const snap = await ensureSnapshot(cenv, getDb(env), site, stale, "evaluation", s + 14 * DAY, Date.now(), directRead(), async () => {});
    expect(snap!.persisted).toBe(false);
    expect(await snapshotRows(sid, "exp_gone")).toEqual([]);
    // 終了の記録: 記録の INSERT が 0 行なら採用も書かずに false
    const benv = { ...cenv, RESULTS_BUDGET: fakeResultsBudget().ns, RESULTS_HEALTH: fakeResultsHealth().ns } as typeof cenv;
    const now = Date.now();
    const archived = { ...stale, status: "archived" as const, stopped_at: now };
    const ok = await recordStop(benv, getDb(env), site, archived, { adoption: { variantId: "b", note: "" }, userId: owner.userId, now, estimate: 100, guard: async () => {} });
    expect(ok).toBe(false);
    expect(await snapshotRows(sid, "exp_gone")).toEqual([]);
    expect(await adoptionRow(sid, "exp_gone")).toBeUndefined();
  });

  test("終了の記録の INSERT が競合で 0 行でも、正の判定の記録が先にあれば recorded true で採用も書く", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_race_stop");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_race_stop", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const now = Date.now();
    await env.DB.prepare("update experiments set status = 'archived', stopped_at = ? where site_id = ? and id = ?").bind(now, sid, "exp_race_stop").run();
    // 記録の集計(計測用 D1 の最初の batch)の直前に、別の書き手が正の判定の記録を書く
    const hooked = beforeD1Batch(env.RESULTS_DB!, async () => {
      await env.DB.prepare(
        "insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?, ?, 'stop', ?, ?, 5, 'v', '{}')",
      )
        .bind(sid, "exp_race_stop", runId, now)
        .run();
    });
    const benv = { ...testEnvWith({ resultsStore: true }), RESULTS_DB: hooked, RESULTS_BUDGET: fakeResultsBudget().ns, RESULTS_HEALTH: fakeResultsHealth().ns } as ReturnType<typeof testEnvWith>;
    const ok = await recordStop(benv, getDb(env), await siteRow(sid), await experimentRow(sid, "exp_race_stop"), {
      adoption: { variantId: "b", note: "" },
      userId: owner.userId,
      now,
      estimate: 100,
      guard: async () => {},
    });
    expect(ok).toBe(true);
    expect((await snapshotRows(sid, "exp_race_stop")).map((x) => [x.kind, x.computed_at])).toEqual([["stop", 5]]);
    expect((await adoptionRow(sid, "exp_race_stop"))!.variant_id).toBe("b");
  });

  test("記録を返すときの collection は今のサイトの設定と計測用 D1 の有無から決める", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_coll");
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_coll", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    expect((await json<Report & { collection: string }>(await getResults(owner, sid, "exp_coll"))).collection).toBe("enabled");
    await env.DB.prepare("update sites set results_enabled = 0 where id = ?").bind(sid).run();
    const disabled = await json<Report & { collection: string }>(await getResults(owner, sid, "exp_coll"));
    expect(disabled).toMatchObject({ phase: "fixed", collection: "site_disabled" });
    const missing = await json<Report & { collection: string }>(await getResults(owner, sid, "exp_coll", {}));
    expect(missing).toMatchObject({ phase: "fixed", collection: "store_missing" });
    expect(JSON.parse((await snapshotRows(sid, "exp_coll"))[0]!.result_json).collection).toBe("enabled");
  });
});
