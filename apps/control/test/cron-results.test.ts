import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";
import { kvKeys } from "@wtt/core";
import { allotQueries, isTickPrioritySlot, queryLimitFor, runCron, type CronContext, type CronJob } from "../src/cron/runner";
import { CRON_JOBS } from "../src/cron/jobs";
import { resultsCapacityJob, resultsCollectUntilJob, resultsDailyJob, resultsDeliveryJob, resultsPurgeJob } from "../src/cron/results-jobs";
import type { Env, ResultsHealthRpc } from "../src/env";
import { getDb } from "../src/db";
import { mergeStoredPlan, RESULTS_STORE_LIMIT_BYTES } from "../src/evaluation-plan";
import { DEFAULT_PLAN } from "@wtt/stats";
import { collectUntilMap, rewriteCollectUntil } from "../src/results/collect-until";
import { apiGuard } from "../src/results/guard";
import type { ReadSession } from "../src/results/read-session";
import { computeSnapshot } from "../src/results/snapshot";
import { hourOf } from "../src/results/time";
import { composeSettingsRecord, putSettingsRecord, siteToSettings } from "../src/site-settings";
import { siteSettingsRefreshJob } from "../src/cron/site-settings-refresh";
import { call, createExperiment, experimentRow, failingKv, fakeDeployer, fakeResultsBudget, fakeResultsHealth, json, RESULTS_STORE, seedResults, setupOwner, siteRow, testEnv, testEnvWith } from "./helpers";
import {
  backdate,
  conversionsOf,
  DAY,
  db,
  getResults,
  HOUR,
  MIN,
  participants,
  recordingSite,
  resultsOverride,
  seedWinner,
  setStatus,
  snapshotRows,
  startTest,
  type Owner,
  type Report,
} from "./results-fixtures";

// D9 plan ③ Task 11(K17・K18・K12・K11・K13・K15・K24、設計書 §9.4・§6.8・§6.9): 結果の Cron のジョブ

afterEach(() => vi.restoreAllMocks());

const at = (iso: string) => Date.parse(iso);
/** t の枠が daily 優先なら次の枠(tick 優先)にずらす(daily が due の実行の配分は 15 分の枠の偶奇で替わる) */
const tickSlot = (t: number) => (isTickPrioritySlot(t) ? t : t + 15 * 60 * 1000);
type Budget = ReturnType<typeof fakeResultsBudget>;
type Health = { ns: DurableObjectNamespace<ResultsHealthRpc> };

/** Cron の env(計測用 D1・偽の予算の DO・偽の収集の失敗の記録。extra で DEPLOYER などを足す) */
function cronEnv(budget: Budget = fakeResultsBudget(), health: Health = fakeResultsHealth(), extra: Partial<Env> = {}): Env {
  return { ...testEnvWith({ resultsStore: true }), RESULTS_BUDGET: budget.ns, RESULTS_HEALTH: health.ns, ...extra };
}

/** 凍結の行を直接書く(cron.test.ts と同じ) */
async function freeze(): Promise<void> {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null) on conflict(key) do nothing").run();
}
const cursorRows = async () => (await env.DB.prepare("select job, day, cursor from cron_cursors order by job").all<{ job: string; day: string; cursor: string | null }>()).results;
const jobRun = async (job: string) => (await env.DB.prepare("select last_run_day from cron_job_runs where job = ?").bind(job).first<{ last_run_day: string }>())?.last_run_day ?? null;
const countRows = async (runId: string): Promise<number> => {
  const p = await env.RESULTS_DB!.prepare("select count(*) as n from participants where run_id = ?").bind(runId).first<{ n: number }>();
  const c = await env.RESULTS_DB!.prepare("select count(*) as n from conversions where run_id = ?").bind(runId).first<{ n: number }>();
  return (p?.n ?? 0) + (c?.n ?? 0);
};
const planRow = (sid: string, eid: string) => db().selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirstOrThrow();
const kvSettings = async (sid: string) => JSON.parse((await env.CONFIG_KV.get(kvKeys.settings(sid)))!) as Record<string, unknown>;

/** 記録の比べ方(K15): 計算した時刻と、収集できなかった送信の数・割合とそこから決まる品質・注記 collection_failures を除く */
function comparable(resultJson: string): unknown {
  const r = JSON.parse(resultJson) as Record<string, any>;
  const { computedAt: _c, quality: _q, ...rest } = r;
  const { failedSends: _f, failureRatio: _r, ...qd } = r.qualityDetail;
  return { ...rest, qualityDetail: qd, notes: (r.notes as Array<{ key: string }>).filter((n) => n.key !== "collection_failures") };
}

/** 評価時点を過ぎたテスト(a 300 人・b 300 人。既定の計画 = 評価時点は開始の 14 日後) */
async function dueTest(owner: Owner, sid: string, eid: string, startedAt: number, plan: Record<string, unknown> = {}): Promise<string> {
  const runId = await startTest(owner, sid, eid, plan);
  await backdate(sid, eid, startedAt);
  await seedResults(seedWinner(runId, sid, startedAt + HOUR));
  return runId;
}

/** ID を決めて Site を作る(結果を記録する。並びを決めるテスト用) */
async function siteWithId(owner: Owner, id: string): Promise<string> {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id, name: id, domains: [`${id.toLowerCase()}.example.com`] }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  return id;
}

/** 記録の行を直接入れる(削除の対象にするだけの記録。中身は使わない) */
async function fakeSnapshot(sid: string, eid: string, runId: string, cutoff: number): Promise<void> {
  await env.DB.prepare(
    "insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?, ?, 'evaluation', ?, ?, ?, 'test', '{}')",
  )
    .bind(sid, eid, runId, cutoff, cutoff)
    .run();
}

/** 本物の計測用 D1 を読む ReadSession(予約は持たない) */
const directRead: ReadSession = { batch: (stmts) => env.RESULTS_DB!.batch(stmts), close: async () => {} };

/** 計測用 D1 の batch の meta.size_after を size() にする(容量の取得のテスト用) */
function sizedResultsDb(size: () => number): D1Database {
  const real = env.RESULTS_DB!;
  return new Proxy(real, {
    get(t, p) {
      if (p === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const out = await t.batch(stmts);
          for (const r of out) (r.meta as Record<string, unknown>).size_after = size();
          return out;
        };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as D1Database;
}

/** 偽の収集の失敗の記録で、bad の run を読むと例外を投げる(記録の作成を失敗させる)。reads = run ごとの読んだ回数 */
function throwingHealth(bad: string) {
  const reads: Record<string, number> = {};
  const ns = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: () =>
      ({
        async read(runId: string) {
          reads[runId] = (reads[runId] ?? 0) + 1;
          if (runId === bad) throw new Error("health down");
          return [];
        },
      }) as unknown as ResultsHealthRpc,
  } as unknown as DurableObjectNamespace<ResultsHealthRpc>;
  return { ns, reads };
}

describe("results-daily: 評価時点の記録・終了の記録の補完(K15・K17)", () => {
  test("snapshot_from_api_and_cron_are_identical", async () => {
    // 同じ seed で、API が先に読んだ記録と Cron が作った記録は、計算した時刻と収集できなかった送信の数・割合(とそこから決まる品質・注記)を除いて同じ
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 15 * DAY;
    const runId = await dueTest(owner, sid, "exp_t", s);
    const health = fakeResultsHealth({ [runId]: [{ hour: hourOf(s + 2 * HOUR), failed: 3 }] });
    expect((await getResults(owner, sid, "exp_t", resultsOverride(fakeResultsBudget(), health))).status).toBe(200);
    const byApi = await snapshotRows(sid, "exp_t");
    expect(byApi.map((r) => r.kind)).toEqual(["evaluation"]);
    // 記録を消して(API が読まなかった場合と同じ)、Cron に作らせる。後から失敗が届いた(収集できなかった送信の数は記録を作った時点の値)
    await env.DB.prepare("delete from result_snapshots where site_id = ? and experiment_id = ?").bind(sid, "exp_t").run();
    const late = fakeResultsHealth({ [runId]: [{ hour: hourOf(s + 2 * HOUR), failed: 40 }] });
    expect(await runCron(cronEnv(fakeResultsBudget(), late), Date.now(), [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    const byCron = await snapshotRows(sid, "exp_t");
    expect(byCron.map((r) => [r.kind, r.cutoff_at, r.run_id])).toEqual([["evaluation", byApi[0]!.cutoff_at, runId]]);
    expect(comparable(byCron[0]!.result_json)).toEqual(comparable(byApi[0]!.result_json));
    // 除いた値は違いうる(記録を作った時点の値)
    expect(JSON.parse(byApi[0]!.result_json).qualityDetail.failedSends).toBe(3);
    expect(JSON.parse(byCron[0]!.result_json).qualityDetail.failedSends).toBe(40);
  });

  test("snapshot_failure_counts_are_as_of_recording", { timeout: 30_000 }, async () => {
    // 個票 10,000 行・失敗 99 件で記録 → quality ok。遅れて 3 件が届いた後に同じ cutoff で計算 → 102 件で warning・注記 collection_failures。
    // 人数・CV・判定は同じで、記録は書き換わらない
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 15 * DAY;
    const runId = await startTest(owner, sid, "exp_t");
    await backdate(sid, "exp_t", s);
    const a = participants(runId, sid, "a", 4_500, s + HOUR, MIN / 2);
    const b = participants(runId, sid, "b", 4_500, s + HOUR, MIN / 2);
    await seedResults({ participants: [...a, ...b], conversions: [...conversionsOf(a, "g_buy", 450), ...conversionsOf(b, "g_buy", 550)] });
    const failed = [{ hour: hourOf(s + 2 * HOUR), failed: 99 }];
    const health = fakeResultsHealth({ [runId]: failed });
    const now = Date.now();
    expect(await runCron(cronEnv(fakeResultsBudget(), health), now, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    const [row] = await snapshotRows(sid, "exp_t");
    const stored = JSON.parse(row!.result_json) as Report;
    expect(stored.qualityDetail.failedSends).toBe(99);
    expect(stored.quality).toBe("ok");
    expect(stored.notes.map((n) => n.key)).not.toContain("collection_failures");
    // 遅れて届いた 3 件
    failed.push({ hour: hourOf(s + 3 * HOUR), failed: 3 });
    const site = await siteRow(sid);
    const exp = await experimentRow(sid, "exp_t");
    const again = await computeSnapshot(cronEnv(fakeResultsBudget(), health), getDb(env), site, exp, "evaluation", row!.cutoff_at, now + MIN, directRead);
    expect(again.qualityDetail.failedSends).toBe(102);
    expect(again.quality).toBe("warning");
    expect(again.notes.map((n) => n.key)).toContain("collection_failures");
    // snapshots(記録の有無)は今の事実で、記録の後に計算したので違う
    const withoutSnapshots = (x: string) => ({ ...(comparable(x) as Record<string, unknown>), snapshots: undefined });
    expect(withoutSnapshots(JSON.stringify(again))).toEqual(withoutSnapshots(row!.result_json));
    // 記録は作った時点の値のまま(次の日の Cron も書き換えない)
    expect(await runCron(cronEnv(fakeResultsBudget(), health), now + DAY, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect((await snapshotRows(sid, "exp_t"))[0]!.result_json).toBe(row!.result_json);
  });

  test("API と Cron の実行順を入れ替えても同じ評価時点になる", async () => {
    // 目標参加者数に届いているが到達を記録していない 2 つのテスト。API が先(exp_api)でも Cron が先(exp_cron)でも、到達を先に確かめて
    // 同じ規則で評価時点を決める(記録していない到達のまま最大期間で待たない)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 10 * DAY;
    const plan = { targetPerVariant: 100, minDays: 7 };
    const runs: Record<string, string> = {};
    for (const eid of ["exp_api", "exp_cron"]) {
      runs[eid] = await startTest(owner, sid, eid, plan);
      await backdate(sid, eid, s);
      await seedResults({ participants: [...participants(runs[eid]!, sid, "a", 150, s + HOUR), ...participants(runs[eid]!, sid, "b", 150, s + HOUR)] });
    }
    const expected = s + 7 * DAY; // 到達(s + 1 時間 + 99 分)は最低期間の前 → 評価時点は最低期間の終わり
    // API が先
    const r1 = await json<Report>(await getResults(owner, sid, "exp_api"));
    expect(r1).toMatchObject({ phase: "fixed", cutoff: expected });
    // Cron が先(到達の確認と記録で配分を使い切れば、次の実行で続ける)
    const now = Date.now();
    const outcomes: string[] = [];
    for (let i = 0; i < 4 && outcomes.at(-1) !== "ran"; i++) outcomes.push((await runCron(cronEnv(), now + i * 15 * MIN, [resultsDailyJob]))[0]!.outcome);
    expect(outcomes.at(-1)).toBe("ran");
    const rows = [...(await snapshotRows(sid, "exp_api")), ...(await snapshotRows(sid, "exp_cron"))];
    expect(rows.map((r) => [r.experiment_id, r.kind, r.cutoff_at])).toEqual([
      ["exp_api", "evaluation", expected],
      ["exp_cron", "evaluation", expected],
    ]);
    const r2 = await json<Report>(await getResults(owner, sid, "exp_cron"));
    expect(r2).toMatchObject({ phase: "fixed", cutoff: expected });
    // API が作った記録は Cron が作り直さない
    expect((await snapshotRows(sid, "exp_api"))[0]!.computed_at).toBe(r1.computedAt);
  });

  test("cron_backfills_missing_stop_snapshot", async () => {
    // 評価時点の前の終了で記録を作れなかった(読み取りの予約を断られた)→ Cron が終了の記録(cutoff = 終了の時刻)を作る。
    // 後で評価時点を過ぎても評価時点の記録は作らない
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_stop");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_stop", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const stop = await setStatus(owner, sid, "exp_stop", { status: "archived" }, resultsOverride(fakeResultsBudget({ readBudget: 0 })));
    expect(stop.status).toBe(200);
    expect((await json(stop)).results).toEqual({ recorded: false });
    expect(await snapshotRows(sid, "exp_stop")).toEqual([]);
    const stoppedAt = (await experimentRow(sid, "exp_stop")).stopped_at!;
    expect(await runCron(cronEnv(), stoppedAt + MIN, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect((await snapshotRows(sid, "exp_stop")).map((r) => [r.kind, r.cutoff_at, r.run_id])).toEqual([["stop", stoppedAt, runId]]);
    expect(await cursorRows()).toContainEqual(expect.objectContaining({ job: "results-daily:stop-snapshot" }));
    // 評価時点(開始の 14 日後)を過ぎた日
    expect(await runCron(cronEnv(), s + 20 * DAY, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect((await snapshotRows(sid, "exp_stop")).map((r) => r.kind)).toEqual(["stop"]);
  });

  test("記録の数の上限に達したら { more: true } で次の実行に続ける", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 20 * DAY;
    await dueTest(owner, sid, "exp_1", s);
    await dueTest(owner, sid, "exp_2", s + HOUR);
    const now = Date.now();
    // 1 回目: 評価時点の早い exp_1 だけを作り、続きが残る(成功を記録しない)
    expect(await runCron(cronEnv(), now, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "continued" }]);
    expect((await snapshotRows(sid, "exp_1")).length).toBe(1);
    expect(await snapshotRows(sid, "exp_2")).toEqual([]);
    expect(await jobRun("results-daily")).toBeNull();
    // 2 回目: 続きから exp_2
    expect(await runCron(cronEnv(), now + 15 * MIN, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect((await snapshotRows(sid, "exp_2")).length).toBe(1);
    expect(await jobRun("results-daily")).not.toBeNull();
  });

  test("cron_skips_failing_snapshot_and_reaches_later_items", async () => {
    // 先頭の記録の作成が失敗し続けても、位置が進み、後ろの対象の記録が数回の実行で作られる。翌日は先頭からやり直す
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const T = at("2026-11-20T01:00:00Z");
    const bad = await dueTest(owner, sid, "exp_bad", T - 20 * DAY);
    const good = await dueTest(owner, sid, "exp_good", T - 19 * DAY);
    const health = throwingHealth(bad);
    const run = (t: number) => runCron(cronEnv(fakeResultsBudget(), health), t, [resultsDailyJob]);
    expect(await run(T)).toEqual([{ job: "results-daily", outcome: "continued" }]); // 失敗した 1 件で 1 回の分を使った
    expect(await run(T + 15 * MIN)).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect((await snapshotRows(sid, "exp_good")).length).toBe(1);
    expect(await snapshotRows(sid, "exp_bad")).toEqual([]);
    expect(health.reads).toEqual({ [bad]: 1, [good]: 1 }); // 同じ日には失敗した対象を試し直さない
    expect(error.mock.calls.flat().join(" ")).toContain("failed; skipped");
    // 翌日: 先頭からやり直す
    expect(await run(T + DAY)).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect(health.reads[bad]).toBe(2);
  });
});

describe("results-daily: 到達の確認と凍結(K17・K24)", () => {
  test("関数の中の外部呼び出しを待つ間に凍結すると、その後の wtt-control への書き込みが止まる(到達の記録も)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 2 * DAY;
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 });
    await backdate(sid, "exp_t", s);
    await seedResults({ participants: [...participants(runId, sid, "a", 100, s + HOUR), ...participants(runId, sid, "b", 100, s + HOUR)] });
    // 後ろにもう 1 つ到達の確認の対象(凍結の後は進まない)
    await startTest(owner, sid, "exp_later", { targetPerVariant: 100 });
    await backdate(sid, "exp_later", s + HOUR);
    // 計測用 D1 の読み取り(到達の確認)を待つ間に凍結が入る
    const real = env.RESULTS_DB!;
    let batches = 0;
    const freezing = new Proxy(real, {
      get(t, p) {
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            batches++;
            const out = await t.batch(stmts);
            await freeze();
            return out;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    expect(await runCron(cronEnv(fakeResultsBudget(), fakeResultsHealth(), { RESULTS_DB: freezing }), Date.now(), [resultsDailyJob])).toEqual([
      { job: "results-daily", outcome: "stopped_frozen" },
    ]);
    expect(batches).toBe(1); // 後ろの対象を読みに行かない
    const plan = await planRow(sid, "exp_t");
    expect(plan.reached_at).toBeNull();
    expect(plan.reach_checked_day).toBeNull();
    expect(await cursorRows()).toEqual([]);
    expect(await jobRun("results-daily")).toBeNull();
  });

  test("到達を確かめた run に今日の日付を入れ、届いていれば到達と締め切りを記録する", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const s = Date.now() - 2 * DAY;
    const reached = await startTest(owner, sid, "exp_reached", { targetPerVariant: 100 });
    const notYet = await startTest(owner, sid, "exp_not_yet", { targetPerVariant: 200 });
    for (const [eid, runId] of [["exp_reached", reached], ["exp_not_yet", notYet]] as const) {
      await backdate(sid, eid, s);
      await seedResults({ participants: [...participants(runId, sid, "a", 100, s + HOUR), ...participants(runId, sid, "b", 100, s + HOUR)] });
    }
    const now = Date.now();
    expect(await runCron(cronEnv(), now, [resultsDailyJob])).toEqual([{ job: "results-daily", outcome: "ran" }]);
    const today = new Date(now).toISOString().slice(0, 10);
    expect(await planRow(sid, "exp_reached")).toMatchObject({ reached_at: s + HOUR + 99 * MIN, reach_checked_day: today });
    expect(await planRow(sid, "exp_not_yet")).toMatchObject({ reached_at: null, reach_checked_day: today });
    // 締め切りの表も書き直した(到達 → 最低期間の終わり)
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual(await collectUntilMap(getDb(env), sid));
    expect(((await kvSettings(sid)).resultsCollectUntil as Record<string, number>)[reached]).toBe(s + 14 * DAY);
  });
});

describe("results-purge: 保持期限・queue・孤児(K12・K18)", () => {
  const T23 = at("2026-12-01T23:00:00Z");

  /** 保持期間 30 日の Site で、評価時点 E の記録がある実行中のテスト(参加 n 人)。戻り値 = run_id */
  async function retentionFixture(owner: Owner, sid: string, eid: string, evaluationAt: number, n = 20, snapshot = true): Promise<string> {
    const runId = await startTest(owner, sid, eid);
    await backdate(sid, eid, evaluationAt - 14 * DAY);
    await env.DB.prepare("update sites set results_retention_days = 30 where id = ?").bind(sid).run();
    await seedResults({ participants: participants(runId, sid, "a", n, evaluationAt - 13 * DAY, 1) });
    if (snapshot) await fakeSnapshot(sid, eid, runId, evaluationAt);
    return runId;
  }

  test("retention_counts_from_collection_end", async () => {
    // 実行中のテストでも、評価時点から保持期間を過ぎた個票は消え、results_purged_at が入る
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const E = T23 - 30 * DAY - HOUR;
    const runId = await retentionFixture(owner, sid, "exp_t", E);
    // 期限の前日(期限 = E + 30 日 = T23 − 1 時間)は消さない
    expect(await runCron(cronEnv(), T23 - DAY, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(20);
    expect(await runCron(cronEnv(), T23, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(0);
    const exp = await experimentRow(sid, "exp_t");
    expect(exp).toMatchObject({ status: "running", results_purged_at: T23 });
    // 実行中のまま個票を消しても締め切りは残る(K11)
    expect(Object.keys(await collectUntilMap(getDb(env), sid))).toEqual([runId]);
  });

  test("purge_skips_runs_without_snapshot", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await retentionFixture(owner, sid, "exp_t", T23 - 40 * DAY, 20, false);
    expect(await runCron(cronEnv(), T23, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(20);
    expect((await experimentRow(sid, "exp_t")).results_purged_at).toBeNull();
  });

  test("orphan_results_rows_are_purged_by_cron", async () => {
    // wtt-control に対応する run が無い行(参加と CV・CV だけの run)を消す。実行中のテストの run は消さない。
    // 孤児の段は配分の残りで進め、続きは翌日(位置は日をまたいで持ち、末尾まで来たら #end)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const live = await startTest(owner, sid, "exp_live");
    await seedResults({
      participants: [...participants(live, sid, "a", 5, T23 - DAY), ...participants("run_orphan", "s_gone", "a", 7, T23 - DAY)],
      conversions: [
        { runId: "run_orphan", goalId: "g_buy", visitor: 1 },
        { runId: "run_cv_only", goalId: "g_buy", visitor: 2 },
      ],
    });
    for (let d = 0; d < 3; d++) expect(await runCron(cronEnv(), T23 + d * DAY, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows("run_orphan")).toBe(0);
    expect(await countRows("run_cv_only")).toBe(0);
    expect(await countRows(live)).toBe(5);
    expect((await cursorRows()).find((r) => r.job === "results-purge:orphan")?.cursor).toBe("#end");
  });

  test("エクスペリエンスの削除の queue を消し終えたら、締め切りの表の書き直しの印を立てる(results-collect-until が KV から外す)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    await seedResults({ participants: participants(runId, sid, "a", 5, T23 - DAY) });
    expect((await setStatus(owner, sid, "exp_t", { status: "archived" }, resultsOverride())).status).toBe(200);
    // 削除の直後の消し始めは停止中なので消さずに queue に残る(偽の予算の DO を止めておく)
    const stopped = fakeResultsBudget({ stoppedUntil: Date.now() + DAY });
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_t`, { token: owner.token, envOverride: resultsOverride(stopped) })).status).toBe(204);
    expect((await kvSettings(sid)).resultsCollectUntil).toHaveProperty(runId); // KV には削除した run の締め切りが残っている
    expect(await countRows(runId)).toBe(5);
    expect(await runCron(cronEnv(), T23, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(0);
    expect(await env.DB.prepare("select count(*) as n from results_purge_queue").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await siteRow(sid)).collect_until_dirty).toBe(1);
    expect(await runCron(cronEnv(), T23 + 15 * MIN, [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    expect((await kvSettings(sid)).resultsCollectUntil).toBeUndefined();
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
  });

  test("エクスペリエンスの削除で印を立て、results-collect-until が KV の締め切りから外す(消し始めが queue を消し終えた場合も)", async () => {
    // 予算の DO が止まっていない普段の削除: 応答の後の消し始めが個票と queue を消し終える(Cron の queue の段は何も見ない)。
    // Site にほかの run が無くても、削除の batch が立てた印で results-collect-until が訪ねる
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    await seedResults({ participants: participants(runId, sid, "a", 5, Date.now() - HOUR) });
    expect((await setStatus(owner, sid, "exp_t", { status: "archived" }, resultsOverride())).status).toBe(200);
    expect((await kvSettings(sid)).resultsCollectUntil).toHaveProperty(runId);
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_t`, { token: owner.token, envOverride: resultsOverride() })).status).toBe(204);
    expect((await siteRow(sid)).collect_until_dirty).toBe(1);
    expect(await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    expect((await kvSettings(sid)).resultsCollectUntil).toBeUndefined();
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
    // 下書きの削除(run が無い)では印を立てない
    await createExperiment(owner.token, sid, { id: "exp_draft" });
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_draft`, { token: owner.token, envOverride: resultsOverride() })).status).toBe(204);
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
  });

  test("UTC 23 時台の削除は K12 の量までで、残りは翌日", { timeout: 30_000 }, async () => {
    // 予算 20,000・今日書いた 6,900(23 時まで 1 時間あたり 300)→ 量 = 20,000 − 6,900 − 300 × 1 = 12,800。
    // 1 回の実行はクエリの配分で DELETE 3 回(6,000 行)まで。次の実行は status から量を計算し直す(書いた分で減る)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await retentionFixture(owner, sid, "exp_t", T23 - 40 * DAY, 15_000);
    const budget = fakeResultsBudget({ writeBudget: 20_000, writeUsed: 6_900 });
    const run = (t: number, b = budget) => runCron(cronEnv(b), t, [resultsPurgeJob]);
    expect(await run(T23)).toEqual([{ job: "results-purge", outcome: "continued" }]);
    expect(await countRows(runId)).toBe(9_000);
    // 23:15: 書いた 12,900 → 1 時間あたり ceil(12,900 / 23.25) = 555 → 量 = 20,000 − 12,900 − 555 = 6,545(この回は配分で 6,000)
    expect(await run(T23 + 15 * MIN)).toEqual([{ job: "results-purge", outcome: "continued" }]);
    expect(await countRows(runId)).toBe(3_000);
    // 23:30: 書いた 18,900 → ceil(18,900 / 23.5) = 805 → 量 = 20,000 − 18,900 − 805 = 295 → 量を使い切ってその日はやめる
    expect(await run(T23 + 30 * MIN)).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(3_000 - 295);
    expect(await run(T23 + 45 * MIN)).toEqual([{ job: "results-purge", outcome: "not_due" }]);
    expect(budget.state.writeUsed).toBe(6_900 + 12_295); // 23 時の量 12,800 の範囲
    expect((await experimentRow(sid, "exp_t")).results_purged_at).toBeNull();
    // 翌日(新しい日の予算)に残りを消す
    expect(await run(T23 + DAY, fakeResultsBudget())).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(0);
    expect((await experimentRow(sid, "exp_t")).results_purged_at).toBe(T23 + DAY);
  });

  test("B93: Paid では 1 回の実行で消す量が増える(Free は配分 16 のまま)", { timeout: 60_000 }, async () => {
    // 予算は十分(量はクエリの配分で決まる)。参加 15,000 行: Free は 1 回で 6,000 行(DELETE 3 回)、Paid は配分 116 で 1 回で消し終える
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await retentionFixture(owner, sid, "exp_t", T23 - 40 * DAY, 15_000);
    const run = (t: number) => runCron(cronEnv(fakeResultsBudget({ writeBudget: 1_000_000 })), t, [resultsPurgeJob]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const lastRun = () => JSON.parse(String(log.mock.calls.filter((c) => c[0] === "cron run").at(-1)![1])) as { queries: number; queryLimit: number };
    expect(await run(T23)).toEqual([{ job: "results-purge", outcome: "continued" }]);
    expect(await countRows(runId)).toBe(9_000);
    expect(lastRun().queryLimit).toBe(40);
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('cloudflarePlan', '\"paid\"', 1, null)").run();
    expect(await run(T23 + 15 * MIN)).toEqual([{ job: "results-purge", outcome: "ran" }]);
    expect(await countRows(runId)).toBe(0);
    expect((await experimentRow(sid, "exp_t")).results_purged_at).toBe(T23 + 15 * MIN);
    expect(lastRun().queryLimit).toBe(140);
    expect(lastRun().queries).toBeLessThanOrEqual(116);
  });

  test("容量以外の理由で止めた日は削除しない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await retentionFixture(owner, sid, "exp_t", T23 - 40 * DAY);
    for (const reason of ["account_usage", "d1_limit", "write_budget"] as const) {
      const budget = fakeResultsBudget({ stopPeriods: [{ reason, from: T23 - 10 * HOUR, to: T23 - 9 * HOUR }] });
      expect(await runCron(cronEnv(budget), T23, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "ran" }]);
      expect(budget.calls.filter((c) => c.method === "lease")).toEqual([]);
      expect(await countRows(runId)).toBe(20);
      await env.DB.prepare("delete from cron_job_runs").run();
    }
  });
});

describe("results-capacity(K18)", () => {
  const T = at("2026-12-01T10:00:00Z");
  const LIMIT = RESULTS_STORE_LIMIT_BYTES;

  test("容量 95% で stop('capacity', 次の UTC 23:00)(23 時台の削除を終えるまでは立てない)、80% で level warning", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const site = async () => json<{ resultsCapacity: unknown }>(await call("GET", `/sites/${sid}`, { token: owner.token }));
    expect((await site()).resultsCapacity).toBeNull(); // まだ測っていない
    let size = LIMIT * 0.8;
    const budget = fakeResultsBudget();
    const e = cronEnv(budget, fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => size) });
    expect(await runCron(e, T, [resultsCapacityJob])).toEqual([{ job: "results-capacity", outcome: "ran" }]);
    expect((await site()).resultsCapacity).toEqual({ sizeBytes: LIMIT * 0.8, measuredAt: T, level: "warning" });
    expect(budget.calls.filter((c) => c.method === "stop")).toEqual([]);
    size = LIMIT * 0.95;
    expect(await runCron(e, T + 15 * MIN, [resultsCapacityJob])).toEqual([{ job: "results-capacity", outcome: "ran" }]);
    expect((await site()).resultsCapacity).toMatchObject({ sizeBytes: LIMIT * 0.95, level: "stopped" });
    const stops = () => budget.calls.filter((c) => c.method === "stop").map((c) => c.args);
    expect(stops()).toEqual([["capacity", at("2026-12-01T23:00:00Z"), T + 15 * MIN]]);
    // 23 時台: その日の削除を終えるまでは立てない → 削除の後の実行で立て直す(次の UTC 23:00 = 翌日)
    const T23 = at("2026-12-01T23:00:00Z");
    expect(await runCron(e, T23, [resultsCapacityJob, resultsPurgeJob])).toEqual([
      { job: "results-capacity", outcome: "ran" },
      { job: "results-purge", outcome: "ran" },
    ]);
    expect(stops()).toHaveLength(1);
    expect(await runCron(e, T23 + 15 * MIN, [resultsCapacityJob, resultsPurgeJob])).toEqual([
      { job: "results-capacity", outcome: "ran" },
      { job: "results-purge", outcome: "not_due" },
    ]);
    expect(stops()).toEqual([
      ["capacity", at("2026-12-01T23:00:00Z"), T + 15 * MIN],
      ["capacity", at("2026-12-02T23:00:00Z"), T23 + 15 * MIN],
    ]);
  });

  test("23 時台の削除が終わらない日も、UTC 0 時を過ぎた最初の実行で容量の停止を立てる", { timeout: 30_000 }, async () => {
    // results-purge が 23 時台ずっと { more: true }(個票 25,000 行・1 回 6,000 行)。容量は 95% 以上のまま
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const T23 = at("2026-12-01T23:00:00Z");
    const runId = await startTest(owner, sid, "exp_t");
    await backdate(sid, "exp_t", T23 - 60 * DAY);
    await env.DB.prepare("update sites set results_retention_days = 30 where id = ?").bind(sid).run();
    await seedResults({ participants: participants(runId, sid, "a", 25_000, T23 - 59 * DAY, 1) });
    await fakeSnapshot(sid, "exp_t", runId, T23 - 46 * DAY);
    const budget = fakeResultsBudget();
    const e = cronEnv(budget, fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => LIMIT * 0.96) });
    const jobs = [resultsCapacityJob, resultsPurgeJob];
    for (let i = 0; i < 4; i++) expect((await runCron(e, T23 + i * 15 * MIN, jobs)).map((r) => r.outcome)).toEqual(["ran", "continued"]);
    expect(budget.calls.filter((c) => c.method === "stop")).toEqual([]); // 23 時台は削除を待つ
    expect(await countRows(runId)).toBe(1_000);
    // 日が替わった最初の実行: 削除は翌日の 23 時まで due でなく、容量の停止を立てる(その日の 23:00 まで)
    const next = fakeResultsBudget();
    const e2 = cronEnv(next, fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => LIMIT * 0.96) });
    expect((await runCron(e2, T23 + HOUR, jobs)).map((r) => r.outcome)).toEqual(["ran", "not_due"]);
    expect(next.calls.filter((c) => c.method === "stop").map((c) => c.args)).toEqual([["capacity", at("2026-12-02T23:00:00Z"), T23 + HOUR]]);
  });

  test("purge_runs_during_capacity_stop", async () => {
    // 容量の停止中 → 23 時台に停止を立てず期限の個票を消す → 測り直して 95% 未満なら停止しない / まだ 95% 以上なら立て直す
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const T23 = at("2026-12-01T23:00:00Z");
    const runId = await startTest(owner, sid, "exp_t");
    await backdate(sid, "exp_t", T23 - 60 * DAY);
    await env.DB.prepare("update sites set results_retention_days = 30 where id = ?").bind(sid).run();
    await seedResults({ participants: participants(runId, sid, "a", 50, T23 - 59 * DAY, 1) });
    await fakeSnapshot(sid, "exp_t", runId, T23 - 46 * DAY);
    let size = LIMIT * 0.96;
    const budget = fakeResultsBudget();
    const e = cronEnv(budget, fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => size) });
    const jobs = [resultsCapacityJob, resultsPurgeJob];
    await runCron(e, T, jobs); // 10:00 に容量の停止(23:00 まで)
    expect(budget.state.stoppedUntil).toBe(T23);
    expect(await runCron(e, T23, jobs)).toEqual([
      { job: "results-capacity", outcome: "ran" },
      { job: "results-purge", outcome: "ran" },
    ]);
    expect(await countRows(runId)).toBe(0); // 容量の停止の日でも削除する
    const stops = () => budget.calls.filter((c) => c.method === "stop").length;
    expect(stops()).toBe(1);
    size = LIMIT * 0.5; // 消して空きができた
    await runCron(e, T23 + 15 * MIN, jobs);
    expect(stops()).toBe(1);
    size = LIMIT * 0.97; // まだ 95% 以上
    await runCron(e, T23 + 30 * MIN, jobs);
    expect(stops()).toBe(2);
  });
});

describe("results-collect-until(K11)", () => {
  test("collect_until_kv_write_failure_is_retried_by_cron", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    // 開始の時刻が変わって締め切りが変わったが、KV の書き込みに失敗した → 印が立つ
    await env.DB.prepare("update experiments set started_at = started_at - ? where site_id = ?").bind(DAY, sid).run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await rewriteCollectUntil({ ...testEnvWith({ resultsStore: true }), CONFIG_KV: failingKv(/settings/) }, getDb(env), sid, apiGuard(env));
    expect((await siteRow(sid)).collect_until_dirty).toBe(1);
    const expected = await collectUntilMap(getDb(env), sid);
    expect((await kvSettings(sid)).resultsCollectUntil).not.toEqual(expected);
    expect(await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual(expected);
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
  });

  test("B94: 印の立った Site を、全体の一巡を待たずに先に直す(位置が後ろにあっても)", { timeout: 60_000 }, async () => {
    // run を持つ Site を 4 つ作り、全体の段の位置を最後の Site の手前に置く。先頭の Site に印を立てると、次の実行で直る
    const owner = await setupOwner();
    const ids = ["b94-a", "b94-b", "b94-c", "b94-d"];
    for (const id of ids) {
      await siteWithId(owner, id);
      await startTest(owner, id, "exp_t");
    }
    await env.DB.prepare("insert into cron_cursors (job, day, cursor) values ('results-collect-until', '2026-11-20', ?)").bind(ids[2]).run();
    const first = ids[0]!;
    await env.DB.prepare("update experiments set started_at = started_at - ? where site_id = ?").bind(DAY, first).run();
    await env.DB.prepare("update sites set collect_until_dirty = 1 where id = ?").bind(first).run();
    const expected = await collectUntilMap(getDb(env), first);
    expect((await kvSettings(first)).resultsCollectUntil).not.toEqual(expected);
    // 印の Site の書き直し(締め切りの表・プラン・凍結の確かめ・印の 0 戻しの 4 件)で、この実行の全体の段は続きを次に回す(continued)
    expect(await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "continued" }]);
    expect((await kvSettings(first)).resultsCollectUntil).toEqual(expected);
    expect((await siteRow(first)).collect_until_dirty).toBe(0);
    // 全体の段の位置は動かない(先頭に戻らない)。次の実行で続き(ids[3])から進み、末尾まで来て先頭へ
    expect((await cursorRows()).find((r) => r.job === "results-collect-until")?.cursor).toBe(ids[2]);
    expect(await runCron(cronEnv(), Date.now() + 15 * MIN, [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    expect((await cursorRows()).find((r) => r.job === "results-collect-until")?.cursor).toBeNull();
  });

  test("B94: 書き直しに失敗し続ける印の Site があっても、同じ実行で後ろの印の Site を直す", async () => {
    const owner = await setupOwner();
    const bad = await siteWithId(owner, "b94-bad");
    const good = await siteWithId(owner, "b94-good");
    for (const id of [bad, good]) {
      await startTest(owner, id, "exp_t");
      await env.DB.prepare("update experiments set started_at = started_at - ? where site_id = ?").bind(DAY, id).run();
      await env.DB.prepare("update sites set collect_until_dirty = 1 where id = ?").bind(id).run();
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    const e = cronEnv(undefined, undefined, { CONFIG_KV: failingKv(new RegExp(`^${kvKeys.settings(bad)}$`)) });
    // 1 回の実行で、bad は失敗して飛ばし、印の段の位置を越えて good まで直す(配分 10: 位置 1 + 一覧 1 + bad 3 + good 4)
    await runCron(e, Date.now(), [resultsCollectUntilJob]);
    expect((await siteRow(good)).collect_until_dirty).toBe(0);
    expect((await siteRow(bad)).collect_until_dirty).toBe(1);
    // 次の実行は bad から試し直す(印の段は一巡ごとに先頭へ)
    await runCron(e, Date.now() + 15 * MIN, [resultsCollectUntilJob]);
    expect((await siteRow(bad)).collect_until_dirty).toBe(1);
  });

  test("concurrent_site_patch_overwrite_is_repaired_by_cron", async () => {
    // Site の PATCH の後に、PATCH の前の行で読んだ締め切りの書き直しが KV を上書きした(同意の設定が古い)。印は立っていない
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const before = await siteRow(sid);
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { consentMode: "required" }, envOverride: RESULTS_STORE })).status).toBe(200);
    const table = await collectUntilMap(getDb(env), sid);
    await env.CONFIG_KV.put(kvKeys.settings(sid), JSON.stringify({ ...siteToSettings(before), resultsCollectUntil: table }));
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
    expect(await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    const kv = await kvSettings(sid);
    expect(kv).toEqual(JSON.parse(JSON.stringify({ ...siteToSettings(await siteRow(sid)), newProfileBudget: { perDay: 20_000, instancePerDay: 20_000 }, resultsCollectUntil: table })));
    expect(Object.keys(kv.resultsCollectUntil as object)).toEqual([runId]);
    expect(kv.consentMode).toBe("required");
  });

  test("the plan-change rewrite (refreshSiteRecords) keeps resultsCollectUntil on a run-bearing site", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const table = await collectUntilMap(getDb(env), sid);
    expect(Object.keys(table)).toEqual([runId]);
    const res = await call("PATCH", "/usage/settings", { token: owner.token, body: { cloudflarePlan: "paid" }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(200);
    const kv = await kvSettings(sid);
    expect(kv.newProfileBudget).toEqual({ perDay: 200_000 });
    expect(kv.resultsCollectUntil).toEqual(table);
  });

  test("a run-bearing site keeps newProfileBudget (and its deadlines) after results-collect-until and site-settings-refresh run", async () => {
    // 締め切りの Cron が予算なしの記録を書き戻すと、site-settings-refresh と 15 分ごとに書き合う(controller Ruling 1)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const budget = { perDay: 20_000, instancePerDay: 20_000 };
    expect((await kvSettings(sid)).newProfileBudget).toEqual(budget);
    // 締め切りの表がずれて書き直しが走る状態にする
    await env.DB.prepare("update sites set collect_until_dirty = 1 where id = ?").bind(sid).run();
    await env.CONFIG_KV.put(kvKeys.settings(sid), JSON.stringify({ ...siteToSettings(await siteRow(sid)), resultsCollectUntil: { stale: 1 } }));
    expect(await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob])).toEqual([{ job: "results-collect-until", outcome: "ran" }]);
    const kv = await kvSettings(sid);
    expect(kv.newProfileBudget).toEqual(budget);
    expect(Object.keys(kv.resultsCollectUntil as object)).toEqual([runId]);
    // プランを Paid に変えた後は、collect-until が Paid の予算を書く(Free の予算に戻さない)
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('cloudflarePlan', '\"paid\"', 1, null)").run();
    await env.CONFIG_KV.put(kvKeys.settings(sid), JSON.stringify({ ...siteToSettings(await siteRow(sid)), resultsCollectUntil: { stale: 1 } }));
    await runCron(cronEnv(), Date.now(), [resultsCollectUntilJob]);
    expect((await kvSettings(sid)).newProfileBudget).toEqual({ perDay: 200_000 });
    // site-settings-refresh と書き合わない(同じ形に合っているので変わらない)
    await runCron(cronEnv(), at("2026-12-01T00:30:00Z"), [siteSettingsRefreshJob]);
    const after = await kvSettings(sid);
    expect(after.newProfileBudget).toEqual({ perDay: 200_000 });
    expect(Object.keys(after.resultsCollectUntil as object)).toEqual([runId]);
  });
});

describe("results-delivery(K14・K17)", () => {
  /** 配信の確認がまだ要る行(settled = NULL)を持つ Site を作る */
  async function pendingSite(owner: Owner, id: string): Promise<string> {
    const sid = await siteWithId(owner, id);
    const runId = await startTest(owner, sid, "exp_t");
    await env.DB.prepare("update experiment_delivered_definitions set settled = null, delivered_from = null where site_id = ?").bind(sid).run();
    const n = await env.DB.prepare("select count(*) as n from experiment_delivered_definitions where site_id = ? and run_id = ?").bind(sid, runId).first<{ n: number }>();
    if (n!.n === 0) {
      await env.DB.prepare(
        "insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash) values (?, 'exp_t', ?, 1, null, '{}', 'h')",
      )
        .bind(sid, runId)
        .run();
    }
    return sid;
  }
  /** siteStatus の問い合わせを記録する偽のデプロイ専用 Worker。failing の Site は例外を投げる */
  function statusDeployer(failing: string | null) {
    const fake = fakeDeployer();
    const asked: string[] = [];
    fake.siteStatus = async (siteId: string) => {
      asked.push(siteId);
      if (siteId === failing) throw new Error("status down");
      return { accepted: null, deployed: null, deployedAt: null, history: [], historyFrom: null, pending: false, lastError: null };
    };
    return { fake, asked };
  }

  test("cron_tick_failure_retry_policy_survives_wraparound", async () => {
    // tick のジョブで 1 件が失敗し続ける → 同じ日の一巡ごとに試し直すが、ほかの対象は毎回進む。
    // daily の段で失敗した対象はその日はもう試さず、翌日に試す
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await setupOwner();
    for (const id of ["site-a", "site-b", "site-c"]) await pendingSite(owner, id);
    const { fake, asked } = statusDeployer("site-a");
    const T = at("2026-11-20T10:00:00Z");
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push((await runCron(cronEnv(fakeResultsBudget(), fakeResultsHealth(), { DEPLOYER: fake }), T + i * 15 * MIN, [resultsDeliveryJob]))[0]!.outcome);
    // 1 回目: a(失敗)→ b → 配分の残りで c は次へ / 2 回目: c / 3 回目: 末尾 → 同じ実行で先頭に戻り a(また失敗)→ b …
    expect(asked).toEqual(["site-a", "site-b", "site-c", "site-a", "site-b", "site-c", "site-a", "site-b", "site-c"]);
    expect(outcomes).toEqual(["continued", "ran", "continued", "ran", "continued", "ran"]);
    expect(error.mock.calls.flat().join(" ")).toContain("site-a failed; skipped");

    // daily の段: 失敗した対象はその日はもう試さない(段が末尾まで来て成功を記録する)→ 翌日に試す。
    // 時刻は 2 日後の UTC 1 時(上の Site のテストは今開始したので、まだ評価時点の前)
    const now = Math.floor(Date.now() / DAY) * DAY + 2 * DAY + HOUR;
    const sid = await recordingSite(owner);
    const bad = await dueTest(owner, sid, "exp_bad", now - 20 * DAY);
    const health = throwingHealth(bad);
    const daily = (t: number) => runCron(cronEnv(fakeResultsBudget(), health), t, [resultsDailyJob]);
    expect(await daily(now)).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect(await daily(now + 15 * MIN)).toEqual([{ job: "results-daily", outcome: "not_due" }]);
    expect(health.reads[bad]).toBe(1);
    expect(await daily(now + DAY)).toEqual([{ job: "results-daily", outcome: "ran" }]);
    expect(health.reads[bad]).toBe(2);
  });

  test("cron_delivery_backlog_does_not_starve_other_jobs", async () => {
    // 未確定の届く定義を持つ Site が配分より多い。daily が due の日でも、tick 優先の枠で配信の確認が 1 Site 以上確定し、
    // 同じ実行で容量の取得が進み、次の枠(daily 優先)で記録の補完が進む
    const owner = await setupOwner();
    const gen = { epoch: 1, seq: 1 };
    for (const id of ["site-a", "site-b", "site-c", "site-d"]) {
      const s = await pendingSite(owner, id);
      await env.DB.prepare("update experiment_delivered_definitions set static_generation = ? where site_id = ?").bind(JSON.stringify(gen), s).run();
    }
    const sid = await recordingSite(owner);
    const tick = tickSlot(Date.now());
    await dueTest(owner, sid, "exp_due", tick - 20 * DAY);
    const fake = fakeDeployer();
    const asked: string[] = [];
    const at0 = new Date(tick - HOUR).toISOString();
    fake.siteStatus = async (siteId: string) => {
      asked.push(siteId);
      return { accepted: gen, deployed: gen, deployedAt: at0, history: [{ generation: gen, deployedAt: at0 }], historyFrom: null, pending: false, lastError: null };
    };
    const e = cronEnv(fakeResultsBudget(), fakeResultsHealth(), { DEPLOYER: fake, RESULTS_DB: sizedResultsDb(() => 1_000) });
    const delivered = async () =>
      (await env.DB.prepare("select count(distinct site_id) as n from experiment_delivered_definitions where settled = 'delivered' and site_id like 'site-%'").first<{ n: number }>())!.n;
    const r1 = await runCron(e, tick, CRON_JOBS);
    expect(r1.find((r) => r.job === "results-delivery")).toEqual({ job: "results-delivery", outcome: "continued" });
    expect(await delivered()).toBeGreaterThanOrEqual(1);
    expect(r1.find((r) => r.job === "results-capacity")).toEqual({ job: "results-capacity", outcome: "ran" });
    expect(await env.DB.prepare("select size_bytes from results_store_status").first()).toEqual({ size_bytes: 1_000 });
    const r2 = await runCron(e, tick + 15 * MIN, CRON_JOBS);
    expect(r2.find((r) => r.job === "results-capacity")).toEqual({ job: "results-capacity", outcome: "ran" });
    expect((await snapshotRows(sid, "exp_due")).length).toBe(1);
    expect(await delivered()).toBeGreaterThanOrEqual(1);
  });
});

describe("runner の配分・続き・凍結(K17・K24)", () => {
  test("{ more: true } を返したジョブは成功を記録せず次の実行で続ける / クエリの上限 40 を全ジョブで分け合う", async () => {
    let more = true;
    const seen: Array<{ job: string; left: number }> = [];
    /** n 回 D1 を読み、残りを記録する偽のジョブ */
    const reader = (name: string, share: number | undefined, floor: number | undefined, n: number, cadence: CronJob["cadence"] = { every: "tick" }): CronJob => ({
      name,
      cadence,
      writesControl: true,
      ...(share === undefined ? {} : { queryShare: share }),
      ...(floor === undefined ? {} : { queryFloor: floor }),
      async run(ctx: CronContext) {
        for (let i = 0; i < n; i++) await ctx.db.selectFrom("sites").select("id").limit(1).execute();
        await ctx.env.DB.batch([ctx.env.DB.prepare("select 1"), ctx.env.DB.prepare("select 2")]); // batch は 1 件
        seen.push({ job: name, left: ctx.queries.left() });
        if (name === "daily" && more) return { more: true };
      },
    });
    const jobs = [
      reader("unshared", undefined, undefined, 5), // 配分を持たないジョブ(results-account-guard と同じ)は数えない
      reader("a", 8, 5, 3),
      reader("b", 30, 6, 5),
      reader("daily", 26, 10, 1, { daily: { afterUtcHour: 0 } }),
    ];
    const T = tickSlot(at("2026-11-20T01:00:00Z"));
    expect(await runCron(testEnv, T, jobs)).toEqual([
      { job: "unshared", outcome: "ran" },
      { job: "a", outcome: "ran" },
      { job: "b", outcome: "ran" },
      { job: "daily", outcome: "continued" },
    ]);
    // tick 優先の枠で daily が due: a・b は 1 件の最低(5・6)、daily は残り 40 − 11 = 26 まで(配分 26)。
    // 全体の残りからは後ろで動くジョブの配分を引いて残す。unshared: 40 − 37 = 3 / a: 5 − 4 = 1 / b: 6 − 6 = 0 / daily: 26 − 2 = 24
    expect(seen).toEqual([
      { job: "unshared", left: 3 },
      { job: "a", left: 1 },
      { job: "b", left: 0 },
      { job: "daily", left: 24 },
    ]);
    expect(await jobRun("daily")).toBeNull();
    more = false;
    expect((await runCron(testEnv, T + 15 * MIN, jobs)).at(-1)).toEqual({ job: "daily", outcome: "ran" });
    expect(await jobRun("daily")).toBe("2026-11-20");
    // daily が済んだ後の実行は、tick のジョブが宣言した配分(a 8 − 4 = 4 / b 30 − 6 = 24。unshared は 40 − 38 = 2)
    seen.length = 0;
    await runCron(testEnv, T + 30 * MIN, jobs);
    expect(seen).toEqual([
      { job: "unshared", left: 2 },
      { job: "a", left: 4 },
      { job: "b", left: 24 },
    ]);
    // use(n) は配分の残りを超えると false
    const probe: CronJob = {
      name: "probe",
      cadence: { every: "tick" },
      writesControl: true,
      queryShare: 3,
      async run(ctx) {
        expect(ctx.queries.use(3)).toBe(true);
        await ctx.db.selectFrom("sites").select("id").execute();
        expect(ctx.queries.use(3)).toBe(false);
        expect(ctx.queries.use(2)).toBe(true);
      },
    };
    expect(await runCron(testEnv, T + 45 * MIN, [probe])).toEqual([{ job: "probe", outcome: "ran" }]);
  });

  test("実行ごとの配分の表(容量は残す・daily が due の実行は枠の偶奇で tick と daily の優先を替える)", () => {
    const tick = tickSlot(at("2026-11-20T01:00:00Z"));
    const daily = tick + 15 * MIN;
    expect(isTickPrioritySlot(tick)).toBe(true);
    expect(isTickPrioritySlot(daily)).toBe(false);
    const allot = (due: string[], t: number, plan: "free" | "paid" = "free") => {
      const m = Object.fromEntries(allotQueries(CRON_JOBS, new Set(due), t, plan));
      return { d: m["results-delivery"], c: m["results-collect-until"], daily: m["results-daily"], cap: m["results-capacity"], purge: m["results-purge"] };
    };
    expect(allot([], tick)).toMatchObject({ d: 10, c: 10, cap: 3 });
    expect(allot([], daily)).toMatchObject({ d: 10, c: 10, cap: 3 });
    expect(allot(["results-daily"], tick)).toMatchObject({ d: 10, c: 7, daily: 20, cap: 3 });
    expect(allot(["results-daily"], daily)).toMatchObject({ d: 10, c: 1, daily: 26, cap: 3 });
    expect(allot(["results-purge"], tick)).toMatchObject({ d: 10, c: 7, cap: 3, purge: 16 });
    expect(allot(["results-purge"], daily)).toMatchObject({ d: 10, c: 10, cap: 3, purge: 16 });
    expect(allot(["results-daily", "results-purge"], tick)).toEqual({ d: 10, c: 7, daily: 20, cap: 3, purge: 0 });
    expect(allot(["results-daily", "results-purge"], daily)).toEqual({ d: 0, c: 0, daily: 26, cap: 3, purge: 11 });
    // B93: Paid の実行は、purge が due のときだけ purge に 100 を足す(ほかの列と、purge が due でない実行は Free と同じ)
    expect(allot([], tick, "paid")).toEqual(allot([], tick));
    expect(allot(["results-daily"], daily, "paid")).toEqual(allot(["results-daily"], daily));
    expect(allot(["results-purge"], tick, "paid")).toMatchObject({ d: 10, c: 7, cap: 3, purge: 116 });
    expect(allot(["results-purge"], daily, "paid")).toMatchObject({ d: 10, c: 10, cap: 3, purge: 116 });
    expect(allot(["results-daily", "results-purge"], tick, "paid")).toEqual({ d: 10, c: 7, daily: 20, cap: 3, purge: 100 });
    expect(allot(["results-daily", "results-purge"], daily, "paid")).toEqual({ d: 0, c: 0, daily: 26, cap: 3, purge: 111 });
    expect(queryLimitFor(CRON_JOBS, new Set(["results-purge"]), "paid")).toBe(140);
    expect(queryLimitFor(CRON_JOBS, new Set(["results-purge"]), "free")).toBe(40);
    expect(queryLimitFor(CRON_JOBS, new Set(["results-daily"]), "paid")).toBe(40);
    // 記録 1 件(位置と対象の読み取り 3 + 記録 21 + 位置の書き込み 1)は daily 優先の枠に収まる
    expect(allot(["results-daily"], daily).daily).toBeGreaterThanOrEqual(3 + 21 + 1);
    for (const due of [[], ["results-daily"], ["results-purge"], ["results-daily", "results-purge"]])
      for (const t of [tick, daily]) {
        const a = allot(due, t);
        expect((a.d ?? 0) + (a.c ?? 0) + (due.includes("results-daily") ? a.daily! : 0) + a.cap! + (due.includes("results-purge") ? a.purge! : 0)).toBeLessThanOrEqual(40);
      }
  });

  /** 配分の残りがある限り D1 を 1 件ずつ読む偽のジョブ(使った数を used に残す) */
  function greedy(name: string, share: number, floor: number, cadence: CronJob["cadence"], used: Record<string, number>, reserved = false): CronJob {
    return {
      name,
      cadence,
      writesControl: true,
      queryShare: share,
      queryFloor: floor,
      ...(reserved ? { queryReserved: true } : {}),
      async run(ctx) {
        used[name] = 0;
        while (ctx.queries.use(1)) {
          await ctx.db.selectFrom("sites").select("id").limit(1).execute();
          used[name]++;
        }
      },
    };
  }
  /** 登録と同じ並び・配分・最低を持つ偽のジョブ(daily は 0 時、purge は 23 時) */
  const fakeJobs = (used: Record<string, number>, dailyShare = 26) => [
    greedy("tick-1", 10, 10, { every: "tick" }, used),
    greedy("tick-2", 10, 7, { every: "tick" }, used),
    greedy("daily", dailyShare, 10, { daily: { afterUtcHour: 0 } }, used),
    greedy("capacity", 3, 2, { every: "tick" }, used, true),
    greedy("purge", 16, 10, { daily: { afterUtcHour: 23 } }, used),
  ];
  const clear = (o: Record<string, number>) => {
    for (const k of Object.keys(o)) delete o[k];
  };

  test("daily uses its full share and capacity still runs in the same invocation", async () => {
    // daily 優先の枠: daily は配分 26 を使い切り、登録で後ろの容量も 3 を使える。tick-2 は残り 1 が最低 7 に届かず、位置も読まずに continued
    const used: Record<string, number> = {};
    const daily = tickSlot(at("2026-11-20T00:00:00Z")) + 15 * MIN;
    const report = await runCron(testEnv, daily, fakeJobs(used));
    expect(report.map((r) => [r.job, r.outcome])).toEqual([
      ["tick-1", "ran"],
      ["tick-2", "continued"],
      ["daily", "ran"],
      ["capacity", "ran"],
      ["purge", "not_due"],
    ]);
    expect(used).toEqual({ "tick-1": 10, daily: 26, capacity: 3 });
    // 前のジョブの配分が大きすぎても(daily 40 と宣言)、容量の 3 は残る(queryReserved)。tick のジョブは配分 0 で動かない
    clear(used);
    await runCron(testEnv, daily + DAY, fakeJobs(used, 40));
    expect(used).toEqual({ daily: 37, capacity: 3 });
  });

  test("purge due + tick jobs still ≤ 40", async () => {
    const used: Record<string, number> = {};
    const tick = tickSlot(at("2026-11-20T23:00:00Z"));
    const sum = () => Object.values(used).reduce((a, b) => a + b, 0);
    // results-daily は済んだ日: tick 優先でも daily 優先でも purge 16・容量 3 と tick のジョブで 40 以内
    await env.DB.prepare("insert into cron_job_runs (job, last_run_day, last_success_at) values ('daily', '2026-11-20', 0)").run();
    await runCron(testEnv, tick, fakeJobs(used));
    expect(used).toEqual({ "tick-1": 10, "tick-2": 7, capacity: 3, purge: 16 });
    expect(sum()).toBeLessThanOrEqual(40);
    await env.DB.prepare("delete from cron_job_runs where job = 'purge'").run();
    clear(used);
    await runCron(testEnv, tick + 15 * MIN, fakeJobs(used));
    expect(used).toEqual({ "tick-1": 10, "tick-2": 10, capacity: 3, purge: 16 });
    expect(sum()).toBeLessThanOrEqual(40);
  });

  test("results-daily と results-purge が両方 due の日: daily 優先の枠は daily → purge の順、tick 優先の枠は tick のジョブと daily", async () => {
    const used: Record<string, number> = {};
    const tick = tickSlot(at("2026-11-20T23:00:00Z"));
    // daily 優先の枠: daily 26・purge 11・容量 3。tick のジョブは動かない
    const r1 = await runCron(testEnv, tick + 15 * MIN, fakeJobs(used));
    expect(r1.map((r) => r.outcome)).toEqual(["continued", "continued", "ran", "ran", "ran"]);
    expect(used).toEqual({ daily: 26, capacity: 3, purge: 11 });
    // tick 優先の枠(daily と purge がまだ due の日): tick 10・7、daily 20、purge は 0 で動かない(continued = 成功を記録しない)
    await env.DB.prepare("delete from cron_job_runs").run();
    clear(used);
    const r2 = await runCron(testEnv, tick + DAY, fakeJobs(used));
    expect(r2.map((r) => r.outcome)).toEqual(["ran", "ran", "ran", "ran", "continued"]);
    expect(used).toEqual({ "tick-1": 10, "tick-2": 7, daily: 20, capacity: 3 });
    expect(await jobRun("purge")).toBeNull();
  });

  test("daily が due の日も、どちらの偶奇から始めても 2 回の実行で配信の確認・締め切りの書き直し・記録がそれぞれ 1 件以上進む", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    for (const [day, start] of [
      [0, "tick"],
      [1, "daily"],
    ] as const) {
      const base = tickSlot(at("2026-11-20T01:00:00Z")) + day * DAY + (start === "daily" ? 15 * MIN : 0);
      expect(isTickPrioritySlot(base)).toBe(start === "tick");
      // 配信の確認の対象(世代 {1, day + 1} の行)・締め切りの書き直しの印・評価時点を過ぎた記録の対象を、その日ごとに用意する
      const eid = `exp_${day}`;
      const runId = await dueTest(owner, sid, eid, base - 20 * DAY);
      const gen = { epoch: 1, seq: day + 1 };
      await env.DB.prepare("update experiment_delivered_definitions set static_generation = ?, settled = null, delivered_from = null where site_id = ? and run_id = ?")
        .bind(JSON.stringify(gen), sid, runId)
        .run();
      const rows = await env.DB.prepare("select count(*) as n from experiment_delivered_definitions where site_id = ? and run_id = ?").bind(sid, runId).first<{ n: number }>();
      if (rows!.n === 0)
        await env.DB.prepare(
          "insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash) values (?, ?, ?, 1, ?, '{}', 'h')",
        )
          .bind(sid, eid, runId, JSON.stringify(gen))
          .run();
      await env.DB.prepare("update sites set collect_until_dirty = 1 where id = ?").bind(sid).run();
      const fake = fakeDeployer();
      fake.setStatus({ accepted: gen, deployed: gen, deployedAt: new Date(base - HOUR).toISOString(), history: [{ generation: gen, deployedAt: new Date(base - HOUR).toISOString() }], historyFrom: null, pending: false, lastError: null });
      const e = cronEnv(fakeResultsBudget(), fakeResultsHealth(), { DEPLOYER: fake, RESULTS_DB: sizedResultsDb(() => 1_000) });
      for (const t of [base, base + 15 * MIN]) await runCron(e, t, CRON_JOBS);
      const delivered = await env.DB.prepare("select settled from experiment_delivered_definitions where site_id = ? and run_id = ?").bind(sid, runId).first<{ settled: string | null }>();
      expect(delivered?.settled).toBe("delivered");
      expect((await siteRow(sid)).collect_until_dirty).toBe(0);
      expect((await snapshotRows(sid, eid)).length).toBe(1);
    }
  });

  test("B93: プランは paidExtraShare を持つジョブが due のときだけ読み、読めなければ Free の配分で動く", async () => {
    const used: Record<string, number> = {};
    const jobs = () => fakeJobs(used).map((j) => (j.name === "purge" ? { ...j, paidExtraShare: 100 } : j));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const lastRun = () => JSON.parse(String(log.mock.calls.filter((c) => c[0] === "cron run").at(-1)![1])) as { queryLimit: number };
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('cloudflarePlan', '\"paid\"', 1, null)").run();
    // daily は済んだ日の 23 時: purge が due → Paid の配分 116
    await env.DB.prepare("insert into cron_job_runs (job, last_run_day, last_success_at) values ('daily', '2026-11-20', 0)").run();
    const t23 = tickSlot(at("2026-11-20T23:00:00Z"));
    // プランの読み取り(readInstanceSettings の `"key" in (…)`。凍結の読み取りは `"key" = ?`)を数え、throwPlan なら投げる D1
    let planReads = 0;
    let throwPlan = false;
    const isPlanRead = (q: string) => q.includes('from "instance_settings"') && q.includes('"key" in');
    const spyDb = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare")
          return (q: string) => {
            if (isPlanRead(q)) {
              planReads++;
              if (throwPlan) throw new Error("injected plan read failure");
            }
            return t.prepare(q);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    const spyEnv = { ...testEnv, DB: spyDb };
    await runCron(spyEnv, t23, jobs());
    expect(planReads).toBe(1);
    expect(used.purge).toBe(116);
    expect(lastRun().queryLimit).toBe(140);
    // purge が due でない実行は、プランを読まない(Free と同じ配分)
    planReads = 0;
    clear(used);
    await runCron(spyEnv, tickSlot(at("2026-11-21T12:00:00Z")), jobs());
    expect(planReads).toBe(0);
    expect(used.purge).toBeUndefined();
    expect(lastRun().queryLimit).toBe(40);
    // プランの読み取りが失敗した → Free の配分で動き、ログに残す
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    throwPlan = true;
    clear(used);
    await env.DB.prepare("delete from cron_job_runs where job = 'purge'").run();
    await env.DB.prepare("update cron_job_runs set last_run_day = '2026-11-21' where job = 'daily'").run();
    await runCron(spyEnv, t23 + DAY, jobs());
    expect(planReads).toBe(1);
    expect(used.purge).toBe(16);
    expect(lastRun().queryLimit).toBe(40);
    expect(err.mock.calls.some((c) => String(c[0]).includes("reading the Cloudflare plan failed"))).toBe(true);
    // 壊れた値は readInstanceSettings が既定(Free)に倒す(例外にはならない)
    throwPlan = false;
    await env.DB.prepare("update instance_settings set value = 'not json' where key = 'cloudflarePlan'").run();
    clear(used);
    await env.DB.prepare("delete from cron_job_runs where job = 'purge'").run();
    await env.DB.prepare("update cron_job_runs set last_run_day = '2026-11-22' where job = 'daily'").run();
    await runCron(spyEnv, t23 + 2 * DAY, jobs());
    expect(used.purge).toBe(16);
    expect(lastRun().queryLimit).toBe(40);
  });

  test("前のジョブが見込みを超えて実行の時点の残りが最低に届かないジョブは動かさず、次の動ける枠で進む", async () => {
    // tick 優先の枠・daily が due: 配分は delivery 10・collect 6・daily 21・容量 3。delivery が 1 件目で 13 件使う(見込み超え)→
    // collect の残りは min(6, 40 − 13 − 24) = 3 < 最低 6 → run を呼ばない(クエリも使わない)。次の tick 優先の枠で進む
    let overshoot = true;
    const runs: string[] = [];
    let collectSpent = -1;
    const delivery: CronJob = {
      name: "delivery",
      cadence: { every: "tick" },
      writesControl: true,
      queryShare: 10,
      queryFloor: 10,
      async run(ctx) {
        const n = overshoot ? 13 : 1;
        overshoot = false;
        for (let i = 0; i < n; i++) await ctx.db.selectFrom("sites").select("id").limit(1).execute();
      },
    };
    const collect: CronJob = {
      name: "collect",
      cadence: { every: "tick" },
      writesControl: true,
      queryShare: 8,
      queryFloor: 6,
      async run(ctx) {
        runs.push("collect");
        const before = ctx.queries.left();
        await ctx.db.selectFrom("sites").select("id").limit(1).execute();
        collectSpent = before - ctx.queries.left();
      },
    };
    const daily: CronJob = { name: "daily", cadence: { daily: { afterUtcHour: 0 } }, writesControl: true, queryShare: 26, queryFloor: 10, run: async () => ({ more: true }) };
    const capacity: CronJob = { name: "capacity", cadence: { every: "tick" }, writesControl: true, queryShare: 3, queryFloor: 2, queryReserved: true, async run() {} };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const queriesOf = () => (JSON.parse(String(log.mock.calls.filter((c) => c[0] === "cron run").at(-1)![1])) as { queries: number }).queries;
    const tick = tickSlot(at("2026-11-20T01:00:00Z"));
    const jobs = [delivery, collect, daily, capacity];
    const r1 = await runCron(testEnv, tick, jobs);
    expect(r1.map((r) => [r.job, r.outcome])).toEqual([
      ["delivery", "ran"],
      ["collect", "continued"],
      ["daily", "continued"],
      ["capacity", "ran"],
    ]);
    expect(runs).toEqual([]);
    expect(queriesOf()).toBe(13); // collect は 1 件も使っていない
    // 次の枠(daily 優先): collect の配分は 1 で動かない / その次の tick 優先の枠で進む
    await runCron(testEnv, tick + 15 * MIN, jobs);
    expect(runs).toEqual([]);
    const r3 = await runCron(testEnv, tick + 30 * MIN, jobs);
    expect(r3.find((r) => r.job === "collect")).toEqual({ job: "collect", outcome: "ran" });
    expect(runs).toEqual(["collect"]);
    expect(collectSpent).toBe(1);
  });

  test("tick 優先・daily 優先の枠で、配分が 1 件の最低に届かないジョブは位置も読まない", async () => {
    // collect-until は daily 優先の枠で配分 1(最低 7 未満)→ 動かない(cron_cursors を読まない = クエリ 0)
    const counted: string[] = [];
    const job: CronJob = {
      ...resultsCollectUntilJob,
      async run(ctx) {
        counted.push("ran");
        return resultsCollectUntilJob.run.call(job, ctx);
      },
    };
    // daily は due のまま(続きがある)にして、枠の偶奇だけを替える
    const stubDaily: CronJob = { ...resultsDailyJob, run: async () => ({ more: true }) };
    const jobs = [resultsDeliveryJob, job, stubDaily, resultsCapacityJob];
    const daily = tickSlot(at("2026-11-20T01:00:00Z")) + 15 * MIN;
    const report = await runCron(testEnv, daily, jobs);
    expect(report.find((r) => r.job === "results-collect-until")).toEqual({ job: "results-collect-until", outcome: "continued" });
    expect(counted).toEqual([]);
    // 次の枠(tick 優先)では動く
    await runCron(testEnv, daily + 15 * MIN, jobs);
    expect(counted).toEqual(["ran"]);
  });

  test("1 回の上限を超える未到達の run と記録の対象がある fixture で、数回の実行の後に、後ろの記録・容量の取得・削除まで進む", { timeout: 30_000 }, async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const T23 = at("2026-12-01T23:00:00Z");
    // 未到達の run 8 本(到達の確認は 1 回の配分に収まらない)
    for (let i = 0; i < 8; i++) {
      await startTest(owner, sid, `exp_r${i}`, { targetPerVariant: 1_000 });
      await backdate(sid, `exp_r${i}`, T23 - 2 * DAY);
    }
    // 評価時点を過ぎた記録の対象(到達の確認の段の後ろ)
    await dueTest(owner, sid, "exp_due", T23 - 15 * DAY);
    // 期限を過ぎた削除の対象
    const old = await startTest(owner, sid, "exp_old");
    await backdate(sid, "exp_old", T23 - 200 * DAY);
    await seedResults({ participants: participants(old, sid, "a", 30, T23 - 199 * DAY, 1) });
    await fakeSnapshot(sid, "exp_old", old, T23 - 186 * DAY);
    const budget = fakeResultsBudget();
    const e = cronEnv(budget, fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => 1_000) });
    const reports: Awaited<ReturnType<typeof runCron>>[] = [];
    for (let i = 0; i < 4; i++) reports.push(await runCron(e, T23 + i * 15 * MIN, CRON_JOBS));
    const outcome = (i: number, job: string) => reports[i]!.find((r) => r.job === job)?.outcome;
    expect(outcome(0, "results-daily")).toBe("continued");
    expect(outcome(0, "results-capacity")).toBe("ran"); // 容量の取得は 1 回目から
    expect(await env.DB.prepare("select measured_at from results_store_status").first()).toEqual({ measured_at: T23 + 45 * MIN });
    // 数回の実行の後に、到達の確認を終え、後ろの記録と削除まで進む
    expect(reports.some((r) => r.find((x) => x.job === "results-daily")?.outcome === "ran")).toBe(true);
    for (let i = 0; i < 8; i++) expect((await planRow(sid, `exp_r${i}`)).reach_checked_day).toBe("2026-12-01");
    expect((await snapshotRows(sid, "exp_due")).length).toBe(1);
    expect(await countRows(old)).toBe(0);
    expect(await jobRun("results-purge")).toBe("2026-12-01");
  });

  test("凍結中は 5 本とも見送り、実行中に凍結したら次の書き込みの前に止まる", async () => {
    const owner = await setupOwner();
    // 配信の確認がまだ要る Site を 2 つ(どちらも世代 {1, 1} の行)
    const sites: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sid = await recordingSite(owner);
      const runId = await startTest(owner, sid, "exp_t");
      await env.DB.prepare("delete from experiment_delivered_definitions where site_id = ?").bind(sid).run();
      await env.DB.prepare(
        `insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash)
       values (?, 'exp_t', ?, 1, '{"epoch":1,"seq":1}', '{}', 'h')`,
      )
        .bind(sid, runId)
        .run();
      sites.push(sid);
    }
    // 1. 凍結中: 10 本のうち wtt-control に書く 9 本とも見送る(results-account-guard は wtt-control に書かないので動く)
    await freeze();
    const report = await runCron(cronEnv(), at("2026-11-20T23:00:00Z"), CRON_JOBS);
    expect(report).toEqual([
      { job: "results-account-guard", outcome: "ran" },
      { job: "results-delivery", outcome: "skipped_frozen" },
      { job: "results-collect-until", outcome: "skipped_frozen" },
      { job: "results-daily", outcome: "skipped_frozen" },
      { job: "results-capacity", outcome: "skipped_frozen" },
      { job: "results-purge", outcome: "skipped_frozen" },
      { job: "site-settings-refresh", outcome: "skipped_frozen" },
      { job: "break-glass-sweep", outcome: "skipped_frozen" },
      { job: "config-cleanup", outcome: "skipped_frozen" },
      { job: "static-reconcile", outcome: "skipped_frozen" },
    ]);
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    // 2. 実行中の凍結: デプロイ専用の Worker の応答を待つ間に凍結 → 配信の確認は書かずに止まる。後のジョブも最初の書き込みの前に止まる
    const fake = fakeDeployer();
    const asked: string[] = [];
    fake.siteStatus = async (siteId: string) => {
      asked.push(siteId);
      await freeze();
      return {
        accepted: { epoch: 1, seq: 1 },
        deployed: { epoch: 1, seq: 1 },
        deployedAt: "2026-11-20T09:00:00.000Z",
        history: [{ generation: { epoch: 1, seq: 1 }, deployedAt: "2026-11-20T09:00:00.000Z" }],
        historyFrom: null,
        pending: false,
        lastError: null,
      };
    };
    // results-daily も due の実行(tick 優先の枠 = 配信の確認に 1 件の最低がある)
    const after = await runCron(cronEnv(fakeResultsBudget(), fakeResultsHealth(), { DEPLOYER: fake, RESULTS_DB: sizedResultsDb(() => 1) }), tickSlot(at("2026-11-20T10:00:00Z")), CRON_JOBS);
    expect(after.find((r) => r.job === "results-delivery")).toEqual({ job: "results-delivery", outcome: "stopped_frozen" });
    expect(asked).toHaveLength(1); // 凍結の後は次の Site に進まない
    expect(after.find((r) => r.job === "results-capacity")).toEqual({ job: "results-capacity", outcome: "stopped_frozen" });
    expect(after.find((r) => r.job === "results-collect-until")).toEqual({ job: "results-collect-until", outcome: "stopped_frozen" });
    for (const sid of sites)
      expect(await env.DB.prepare("select delivered_from, settled from experiment_delivered_definitions where site_id = ?").bind(sid).first()).toEqual({ delivered_from: null, settled: null });
    expect(await cursorRows()).toEqual([]);
    expect(await env.DB.prepare("select count(*) as n from results_store_status").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("select count(*) as n from cron_job_runs").first()).toEqual({ n: 0 });
  });

  test("B132: UTC 0 時の枠はどの日も tick 優先、00:15 の枠は daily 優先", () => {
    // 1 日は 15 分の枠 96 個(偶数)で、epoch は UTC 0 時に始まるので、0 時の枠の番号はいつも 96 の倍数(偶数 = tick 優先)。
    // results-daily(afterUtcHour 0)が due になる最初の回は、必ず tick 優先の枠になる
    for (const day of ["2026-11-20", "2028-02-29", "2031-07-01"]) {
      expect(isTickPrioritySlot(at(`${day}T00:00:00Z`))).toBe(true);
      expect(isTickPrioritySlot(at(`${day}T00:15:00Z`))).toBe(false);
    }
  });

  test("B132: UTC 0 時の回は tick 優先の枠で記録を作らず(continued)、評価時点の記録は次の 00:15 の回で作る", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // tickSlot でずらさず、0 時ちょうどの時刻をそのまま使う(0 時の枠の配分を固定するため)
    const T0 = at("2026-11-20T00:00:00Z");
    // 0 時の時点で評価時点(開始の 14 日後 = T0 − 6 日)を過ぎた記録の対象。00:00 と 00:15 で同じ対象を使い、
    // 00:00 に 0 行なのが「対象が無いから」ではなく配分によることを、00:15 で同じ対象から 1 行できることで確かめる
    const runId = await dueTest(owner, sid, "exp_b132", T0 - 20 * DAY);
    // 配分: 0 時の枠(tick 優先)の results-daily は 20、00:15 の枠(daily 優先)は 26。記録 1 件を始めるには、その時点の残りが
    // SNAPSHOT_COST 21 + 位置の書き込み 1 = 22 要る。00:00 は位置(loadCursors)1・到達の list 1・記録の list 1 の読み取り 3 を使い、
    // 残り 17 < 22 なので continued。00:15 は、00:00 に到達の段の終わりの印(#end)を書いてあるので到達の list を読まず、
    // 読み取り 2 で残り 24 ≥ 22 なので ran。このテストが SNAPSHOT_COST の変化に気づくのは、16 以下(00:00 で記録を作る)か
    // 24 以上(00:15 でも作れない)のときだけで、17〜23 の変化には気づかない
    expect(allotQueries(CRON_JOBS, new Set(["results-daily"]), T0).get("results-daily")).toBe(20);
    expect(allotQueries(CRON_JOBS, new Set(["results-daily"]), T0 + 15 * MIN).get("results-daily")).toBe(26);
    // 配分は tick のジョブがあって決まるので、登録の全ジョブで走らせる(results-daily だけなら tick 優先の枠でも 26 になる)
    const e = cronEnv(fakeResultsBudget(), fakeResultsHealth(), { RESULTS_DB: sizedResultsDb(() => 1_000) });
    const daily = (r: Awaited<ReturnType<typeof runCron>>) => r.find((x) => x.job === "results-daily")?.outcome;
    // (ii) 00:00 の回: 対象は残っている(continued = 続きあり。対象が無ければ ran になる)が、記録は作らない
    expect(daily(await runCron(e, T0, CRON_JOBS))).toBe("continued");
    expect(await snapshotRows(sid, "exp_b132")).toEqual([]);
    expect(await jobRun("results-daily")).toBeNull();
    // (iii) 00:15 の回(daily 優先の枠): 同じ対象の評価時点の記録を作り、その日の成功を記録する
    const T1 = T0 + 15 * MIN;
    expect(daily(await runCron(e, T1, CRON_JOBS))).toBe("ran");
    const rows = await snapshotRows(sid, "exp_b132");
    expect(rows.map((r) => [r.kind, r.run_id, r.computed_at])).toEqual([["evaluation", runId, T1]]);
    expect(await jobRun("results-daily")).toBe("2026-11-20");
  });
});

describe("fix round 1: 共有の関数・孤児の確かめ直し・打ち切り", () => {
  test("mergeStoredPlan と settingsRecord は loadPlan・putSettingsRecord と Cron で同じ結果", async () => {
    // 計画: 下書きは保存した集計の定義を使わず既定、固定した計画は保存した定義。基準は直さない(loadPlan がパターンを見て直す)
    const custom = { ...DEFAULT_PLAN.definition, mixed: "exclude" };
    const draft = mergeStoredPlan({ plan_json: JSON.stringify({ minDays: 7, definition: custom }), fixed_at: null });
    expect(draft).toMatchObject({ minDays: 7, maxWeeks: DEFAULT_PLAN.maxWeeks, primaryGoalId: null, baselineVariantId: null, definition: DEFAULT_PLAN.definition });
    expect(mergeStoredPlan({ plan_json: JSON.stringify({ definition: custom }), fixed_at: 1 }).definition).toEqual(custom);
    // 設定の記録: 表が空なら項目を出さない。putSettingsRecord が書くのと同じ形
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const row = await siteRow(sid);
    const budget = { perDay: 20_000, instancePerDay: 20_000 };
    expect(composeSettingsRecord(row, { plan: "free", collectUntil: {} })).toEqual({ ...siteToSettings(row), newProfileBudget: budget });
    expect(composeSettingsRecord(row, { plan: "free", collectUntil: { r1: 5 } })).toEqual({ ...siteToSettings(row), newProfileBudget: budget, resultsCollectUntil: { r1: 5 } });
    await putSettingsRecord(testEnv, row, { plan: "free", collectUntil: { r1: 5 } });
    expect(await kvSettings(sid)).toEqual(JSON.parse(JSON.stringify(composeSettingsRecord(row, { plan: "free", collectUntil: { r1: 5 } }))));
  });

  test("Site の削除の queue の行は Site の確かめの分も見込み、purge の配分 16 を超えない", { timeout: 30_000 }, async () => {
    // 期限の段は今日もう終えた(#end)。queue の 1 件目は削除した Site の run(参加 5,000・CV 500 = 繰り返し 3 回で消し終える量)。
    // Site の確かめ(1)を見込むと繰り返しは 2 回まで(続きは次の実行)。見込まないと 3 回で消し終え、最後の確かめと記録で 16 を超える
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const T = at("2026-12-01T23:15:00Z");
    await env.DB.prepare("insert into cron_cursors (job, day, cursor) values ('results-purge:retention', '2026-12-01', '#end')").run();
    await env.DB.prepare("insert into results_purge_queue (site_id, run_id, reason, enqueued_at) values ('s_gone', 'run_gone', 'site_deleted', 1)").run();
    const ps = participants("run_gone", "s_gone", "a", 5_000, T - DAY, 1);
    await seedResults({ participants: ps, conversions: conversionsOf(ps, "g_buy", 500) });
    expect(await runCron(cronEnv(), T, [resultsPurgeJob])).toEqual([{ job: "results-purge", outcome: "continued" }]);
    const runLog = log.mock.calls.find((c) => c[0] === "cron run");
    const queries = (JSON.parse(String(runLog![1])) as { queries: number }).queries;
    expect(queries).toBeLessThanOrEqual(16);
    expect(await countRows("run_gone")).toBe(5_500 - 4_000);
  });

  test("孤児の段は消す直前に wtt-control を読み直し、一覧の後に現れた run を消さない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await createExperiment(owner.token, sid, { id: "exp_late" });
    await seedResults({ participants: participants("run_late", sid, "a", 4, at("2026-11-30T00:00:00Z")) });
    // 孤児の段が run の一覧を読んだ後(計測用 D1 で次の run を引いた直後)に、同じ run_id のテストが現れる
    const real = env.RESULTS_DB!;
    const late = new Proxy(real, {
      get(t, p) {
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            const out = await t.batch(stmts);
            const hit = out.some((r) => ((r.results ?? []) as Array<{ run_id?: string }>).some((x) => x.run_id === "run_late"));
            if (hit) await env.DB.prepare("update experiments set run_id = 'run_late' where site_id = ? and id = 'exp_late'").bind(sid).run();
            return out;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    expect(await runCron(cronEnv(fakeResultsBudget(), fakeResultsHealth(), { RESULTS_DB: late }), at("2026-12-01T23:00:00Z"), [resultsPurgeJob])).toEqual([
      { job: "results-purge", outcome: "ran" },
    ]);
    expect(await countRows("run_late")).toBe(4);
  });

  test("デプロイ専用の Worker の問い合わせは 2 秒で打ち切り、後から失敗しても未処理の拒否を残さない", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    await env.DB.prepare("update experiment_delivered_definitions set settled = null, delivered_from = null where site_id = ?").bind(sid).run();
    const fake = fakeDeployer();
    let rejectLater: ((e: Error) => void) | undefined;
    fake.siteStatus = () =>
      new Promise((_, reject) => {
        rejectLater = reject;
      });
    const started = Date.now();
    expect(await runCron(cronEnv(fakeResultsBudget(), fakeResultsHealth(), { DEPLOYER: fake }), at("2026-11-20T10:00:00Z"), [resultsDeliveryJob])).toEqual([
      { job: "results-delivery", outcome: "ran" },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(error.mock.calls.flat().join(" ")).toContain("siteStatus timed out");
    // 打ち切った後に元の呼び出しが失敗する: catch が付いているのでログだけ
    rejectLater!(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 10));
    expect(error.mock.calls.flat().join(" ")).toContain("call after timeout failed");
  });
});
