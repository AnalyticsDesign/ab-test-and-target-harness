import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { betaInterval, diffNormal, diffSummary, STATS_VERSION } from "@wtt/stats";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { rewriteCollectUntil } from "../src/results/collect-until";
import { apiGuard } from "../src/results/guard";
import { hourOf } from "../src/results/time";
import {
  beforeD1Batch,
  call,
  createExperiment,
  createSite,
  expectEnvelope,
  experimentRow,
  fakeResultsBudget,
  fakeResultsHealth,
  json,
  publishRes,
  RESULTS_STORE,
  seedResults,
  setupOwner,
  testEnvWith,
  TEXT_CHANGE,
  type SeedConversion,
  type SeedParticipant,
} from "./helpers";

// D9 plan ③ Task 9(K13・K15・K24、設計書 §6.7・§6.9・§7.1・§7.3・§9.2): 集計と結果の API(評価時点の前の速報)

type Owner = Awaited<ReturnType<typeof setupOwner>>;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 結果を記録するサイト(計測用 D1 がある導入で作る = results_enabled 1) */
async function recordingSite(owner: Owner): Promise<string> {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/**
 * 結果を記録するサイトでテストを開始する(既定のパターン a(オリジナル)/ b。variants を渡せば置き換える)。戻り値 = run_id。
 * 判定に使う目標 g_buy と、ほかの目標 g_other を同じサイトに 1 回だけ作る
 */
async function startTest(
  owner: Owner,
  sid: string,
  eid: string,
  plan: Record<string, unknown> = {},
  opts: { variants?: Array<{ id: string; name: string; weight: number }> } = {},
): Promise<string> {
  await createExperiment(owner.token, sid, { id: eid });
  if (opts.variants) expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token: owner.token, body: opts.variants })).status).toBe(200);
  expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(200);
  for (const [id, name] of [["g_buy", "購入"], ["g_other", "資料請求"]]) {
    const goal = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id, name, type: "CUSTOM", config: {} } });
    expect([201, 409]).toContain(goal.status);
  }
  expect((await call("PUT", `/sites/${sid}/experiments/${eid}/evaluation-plan`, { token: owner.token, body: { plan: { primaryGoalId: "g_buy", ...plan } } })).status).toBe(200);
  expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" }, envOverride: RESULTS_STORE })).status).toBe(200);
  const runId = (await experimentRow(sid, eid)).run_id;
  expect(runId).toMatch(/.+/);
  return runId!;
}

/** 開始の時刻を過去にずらす(started_at と計画の fixed_at を同じ値に)。KV の締め切りもずらした開始で書き直す */
async function backdate(sid: string, eid: string, startedAt: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("update experiments set started_at = ? where site_id = ? and id = ?").bind(startedAt, sid, eid),
    env.DB.prepare("update evaluation_plans set fixed_at = ? where site_id = ? and experiment_id = ?").bind(startedAt, sid, eid),
  ]);
  await rewriteCollectUntil(testEnvWith({ resultsStore: true }), getDb(env), sid, apiGuard(env));
}

/** 計測用 D1・偽の予算の DO・偽の収集の失敗の記録がある envOverride */
function resultsOverride(budget = fakeResultsBudget(), health = fakeResultsHealth()): Partial<Env> {
  return { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns, RESULTS_HEALTH: health.ns };
}

const getResults = (owner: Owner, sid: string, eid: string, envOverride: Partial<Env> = resultsOverride()) =>
  call("GET", `/sites/${sid}/experiments/${eid}/results`, { token: owner.token, envOverride });

/** パターンごとに n 人の参加(exposedAt = from + i × step)。visitor は run の中で重ならない番号を振る */
let visitorSeq = 1;
function participants(runId: string, sid: string, variantId: string, n: number, from: number, step = MIN, extra: Partial<SeedParticipant> = {}): SeedParticipant[] {
  return Array.from({ length: n }, (_, i) => ({ runId, siteId: sid, visitor: visitorSeq++, variantId, exposedAt: from + i * step, ...extra }));
}
/** 参加の先頭 k 人が goalId で CV(参加の after ms 後) */
function conversionsOf(ps: SeedParticipant[], goalId: string, k: number, after = 1000): SeedConversion[] {
  return ps.slice(0, k).map((p) => ({ runId: p.runId, goalId, visitor: p.visitor, convertedAt: p.exposedAt! + after }));
}

const cacheRow = (sid: string, eid: string) =>
  getDb(env).selectFrom("results_interim_cache").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirst();
/** 保存した速報を古くする(computed_at を ms だけ前へ) */
const ageCache = (sid: string, eid: string, ms: number) =>
  env.DB.prepare("update results_interim_cache set computed_at = computed_at - ? where site_id = ? and experiment_id = ?").bind(ms, sid, eid).run();

type Report = {
  phase: string; persisted: boolean; computedAt: number | null; cutoff: number | null; collection: string; records: string; quality: string;
  evaluation: { minEnd: number; maxEnd: number; evaluationAt: number; reachedAt: number | null } | null;
  variants: Array<{ id: string; name: string; original: boolean; weight: number; n: number; y: number; cvr: number; cvrCi95: [number, number]; diff: Record<string, unknown> | null; state: string | null; probBest: number | null; applyFailed: number; applyRecovered: number; minCountMet: boolean | null }>;
  qualityDetail: { srmP: number | null; mixedRate: number; stopRatio: number; stopPeriods: Array<{ reason: string; from: number; to: number }>; failedSends: number; failureRatio: number };
  byDevice: Array<{ variantId: string; device: string; n: number; y: number; cvr: number; diff: { mean: number; ci95: [number, number] } | null }>;
  otherGoals: Array<{ goalId: string; name: string; variants: Array<{ variantId: string; n: number; y: number; cvr: number; diff: { mean: number; ci95: [number, number] } | null }> }>;
  notes: Array<{ key: string; params?: Record<string, string | number> }>;
  statsVersion: string; helpKeys: string[]; planChanges: number; deliveryChanges: unknown[]; snapshots: { evaluation: boolean; stop: boolean }; adoption: unknown;
};
const variantOf = (r: Report, id: string) => r.variants.find((v) => v.id === id)!;
const noteKeys = (r: Report) => r.notes.map((n) => n.key);

describe("結果の API(速報)", () => {
  test("下書き = 409 results_not_started、single = 404 results_not_applicable、run_id なし = 200 not_recorded、RESULTS_DB なし = 200 store_missing", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 下書き
    const { id: draft } = await createExperiment(owner.token, sid);
    const draftRes = await getResults(owner, sid, draft);
    expect(draftRes.status).toBe(409);
    expect((await expectEnvelope(draftRes)).error).toBe("results_not_started");
    // パーソナライズ
    const { id: single } = await createExperiment(owner.token, sid, { kind: "single" });
    const singleRes = await getResults(owner, sid, single);
    expect(singleRes.status).toBe(404);
    expect((await expectEnvelope(singleRes)).error).toBe("results_not_applicable");
    // 結果を記録しないサイトで開始(run_id なし)
    const { id: plain } = await createSite(owner.token, owner.workspaceId);
    const { id: unrecorded } = await createExperiment(owner.token, plain);
    expect((await call("POST", `/sites/${plain}/experiments/${unrecorded}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    expect((await experimentRow(plain, unrecorded)).run_id).toBeNull();
    const budget = fakeResultsBudget();
    const nr = await getResults(owner, plain, unrecorded, resultsOverride(budget));
    expect(nr.status).toBe(200);
    const nrBody = await json<Report>(nr);
    expect(nrBody).toMatchObject({ phase: "interim", collection: "not_recorded", variants: [], persisted: false, computedAt: null, cutoff: null });
    expect(noteKeys(nrBody)).toContain("not_recorded");
    // 計測用 D1 がない導入(binding なし)。開始は計測用 D1 がある導入で行い、読むときだけ外す
    await startTest(owner, sid, "exp_store");
    const sm = await getResults(owner, sid, "exp_store", {});
    expect(sm.status).toBe(200);
    const smBody = await json<Report>(sm);
    expect(smBody).toMatchObject({ collection: "store_missing", variants: [] });
    expect(noteKeys(smBody)).toContain("store_missing");
    // どちらも計測用 D1 を読まない(予約しない)
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(0);
  });

  test("速報: 人数・CV・確率が seed の値と合い、評価時点の前は state が null(判定のラベルを出さない)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    const a = participants(runId, sid, "a", 300, startedAt + HOUR, MIN, { device: "desktop" });
    const b = [...participants(runId, sid, "b", 200, startedAt + HOUR, MIN, { device: "desktop" }), ...participants(runId, sid, "b", 100, startedAt + HOUR, MIN, { device: "mobile" })];
    await seedResults({
      participants: [...a, ...b],
      conversions: [...conversionsOf(a, "g_buy", 30), ...conversionsOf(b, "g_buy", 45), ...conversionsOf(a, "g_other", 6), ...conversionsOf(b, "g_other", 9)],
    });
    const before = Date.now();
    const res = await getResults(owner, sid, "exp_t");
    expect(res.status).toBe(200);
    const r = await json<Report>(res);
    expect(r.phase).toBe("interim");
    expect(r.collection).toBe("enabled");
    expect(r.records).toBe("available");
    expect(r.persisted).toBe(true);
    expect(r.statsVersion).toBe(STATS_VERSION);
    expect(r.cutoff).toBeGreaterThanOrEqual(before);
    expect(r.cutoff).toBe(r.computedAt);
    // 人数と CV
    expect(variantOf(r, "a")).toMatchObject({ n: 300, y: 30, original: true, weight: 50, diff: null, state: null });
    expect(variantOf(r, "b")).toMatchObject({ n: 300, y: 45, original: false, state: null });
    expect(variantOf(r, "a").cvr).toBeCloseTo(0.1, 10);
    // CVR の 95% 信用区間は事後分布の分位点(stats の betaInterval)
    expect(variantOf(r, "a").cvrCi95).toEqual(betaInterval(300, 30));
    expect(variantOf(r, "b").cvrCi95).toEqual(betaInterval(300, 45));
    // 確率は stats の値と同じ(判定に使う目標・基準との比較は diffSummary)
    const expected = diffSummary({ n: 300, y: 30 }, { n: 300, y: 45 }, 0, null);
    expect(variantOf(r, "b").diff).toEqual(expected);
    // 評価時点の前: どのパターンにも判定のラベルを出さない。interim の注記に評価時点(既定の最低期間 14 日)
    expect(r.variants.every((v) => v.state === null)).toBe(true);
    expect(r.evaluation).toMatchObject({ evaluationAt: startedAt + 14 * DAY, minEnd: startedAt + 14 * DAY, reachedAt: null });
    expect(r.notes).toContainEqual({ key: "interim", params: { evaluationAt: startedAt + 14 * DAY } });
    // 端末別とほかの目標は正規近似の差
    const bMobile = r.byDevice.find((d) => d.variantId === "b" && d.device === "mobile")!;
    expect(bMobile).toMatchObject({ n: 100, y: 0 });
    const bDesktop = r.byDevice.find((d) => d.variantId === "b" && d.device === "desktop")!;
    expect(bDesktop).toMatchObject({ n: 200, y: 45 });
    expect(bDesktop.diff).toEqual(diffNormal({ n: 300, y: 30 }, { n: 200, y: 45 }));
    expect(r.byDevice.find((d) => d.variantId === "a" && d.device === "desktop")!.diff).toBeNull();
    const other = r.otherGoals.find((g) => g.goalId === "g_other")!;
    expect(other.name).toBe("資料請求");
    expect(other.variants.find((v) => v.variantId === "b")).toMatchObject({ n: 300, y: 9, diff: diffNormal({ n: 300, y: 6 }, { n: 300, y: 9 }) });
    expect(r.otherGoals.map((g) => g.goalId)).not.toContain("g_buy");
    // 保存した速報は人数(variants[].n)を持つ(開始の容量の見込みが読む)
    const cached = await cacheRow(sid, "exp_t");
    expect(JSON.parse(cached!.result_json).variants.map((v: { n: number }) => v.n)).toEqual([300, 300]);
  });

  test("participant_conversion_same_timestamp", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    const t = startedAt + HOUR;
    const [same, early] = participants(runId, sid, "a", 2, t, MIN);
    await seedResults({
      participants: [same!, early!],
      conversions: [
        { runId, goalId: "g_buy", visitor: same!.visitor, convertedAt: same!.exposedAt },
        { runId, goalId: "g_buy", visitor: early!.visitor, convertedAt: early!.exposedAt! - 1 },
      ],
    });
    const r = await json<Report>(await getResults(owner, sid, "exp_t"));
    // 参加と同じミリ秒の CV は数える、参加の 1 ミリ秒前の CV は数えない
    expect(variantOf(r, "a")).toMatchObject({ n: 2, y: 1 });
  });

  test("interim_results_are_reused_within_5_minutes", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: participants(runId, sid, "a", 5, startedAt + HOUR) });
    const budget = fakeResultsBudget();
    const first = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    await seedResults({ participants: participants(runId, sid, "a", 3, startedAt + 2 * HOUR) });
    // 5 分以内: 計測用 D1 を読まず(予約しない)、保存した速報をそのまま返す
    const second = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(second.computedAt).toBe(first.computedAt);
    expect(variantOf(second, "a").n).toBe(5);
    expect(second.persisted).toBe(true);
    // 5 分を過ぎたら再計算する
    await ageCache(sid, "exp_t", 5 * MIN);
    const third = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(2);
    expect(variantOf(third, "a").n).toBe(8);
    expect(third.computedAt).toBeGreaterThan(first.computedAt! - 5 * MIN);
  });

  test("interim_recompute_skipped_when_read_budget_exhausted", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: participants(runId, sid, "a", 4, startedAt + HOUR) });
    // 保存した速報が無いときに予算が尽きている: 数値なしの速報(variants: [])と interim_stale
    const exhausted = () => fakeResultsBudget({ readBudget: 100, readUsed: 100 });
    const none = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(exhausted())));
    expect(none.variants).toEqual([]);
    expect(none.computedAt).toBeNull();
    expect(none.notes).toContainEqual({ key: "interim_stale", params: { reason: "budget" } });
    expect(await cacheRow(sid, "exp_t")).toBeUndefined();
    // 速報を保存してから古くし、予算が尽きた日に読む: 再計算せず保存した速報 + interim_stale(理由と計算した時刻)
    const saved = await json<Report>(await getResults(owner, sid, "exp_t"));
    await ageCache(sid, "exp_t", 10 * MIN);
    const savedAt = saved.computedAt! - 10 * MIN;
    await seedResults({ participants: participants(runId, sid, "a", 3, startedAt + 2 * HOUR) });
    const budget = exhausted();
    const stale = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    expect(variantOf(stale, "a").n).toBe(4);
    expect(stale.computedAt).toBe(savedAt);
    expect(stale.notes).toContainEqual({ key: "interim_stale", params: { reason: "budget", computedAt: savedAt } });
    expect(budget.calls.filter((c) => c.method === "reserveRead").map((c) => c.result)).toEqual([{ ok: false, reason: "budget" }]);
    expect(budget.calls.filter((c) => c.method === "settleRead")).toHaveLength(0);
    // 保存した速報は書き換えない
    expect((await cacheRow(sid, "exp_t"))!.computed_at).toBe(savedAt);
  });

  test("parallel_recomputes_respect_account_read_budget", async () => {
    // 本物の予約の規則を持つ fake(同時に 1 つ)で、2 本を同時に始めると予約を通るのは 1 本、もう 1 本は保存した速報 + notes interim_stale
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: participants(runId, sid, "a", 6, startedAt + HOUR) });
    const budget = fakeResultsBudget();
    const saved = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    await ageCache(sid, "exp_t", 6 * MIN);
    await seedResults({ participants: participants(runId, sid, "b", 2, startedAt + HOUR) });
    // 1 本目が予約を持って計測用 D1 を読む直前に、2 本目を最後まで走らせる
    let second: Report | null = null;
    const pausedDb = beforeD1Batch(env.RESULTS_DB!, async () => {
      second = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    });
    const first = await json<Report>(await getResults(owner, sid, "exp_t", { ...resultsOverride(budget), RESULTS_DB: pausedDb }));
    expect(second).not.toBeNull();
    const reserves = budget.calls.filter((c) => c.method === "reserveRead").map((c) => (c.result as { ok: boolean; reason?: string }).reason ?? "ok");
    expect(reserves).toEqual(["ok", "ok", "busy"]);
    expect(budget.calls.filter((c) => c.method === "settleRead")).toHaveLength(2);
    // 予約を通った 1 本は新しい値、もう 1 本は保存した速報(古い値)+ interim_stale(busy)
    expect(variantOf(first, "b").n).toBe(2);
    expect(first.notes.map((n) => n.key)).not.toContain("interim_stale");
    const s = second as unknown as Report;
    expect(s.computedAt).toBe(saved.computedAt! - 6 * MIN);
    expect(variantOf(s, "b").n).toBe(0);
    expect(s.notes).toContainEqual({ key: "interim_stale", params: { reason: "busy", computedAt: saved.computedAt! - 6 * MIN } });
    // 予約していた読み取りは使った行数で精算され、残りの予約は無い
    expect(budget.state.readUsed).toBeLessThan(10_000);
  });

  test("read_reservation_is_settled_with_actual_rows_read", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    const a = participants(runId, sid, "a", 40, startedAt + HOUR);
    await seedResults({ participants: [...a, ...participants(runId, sid, "b", 40, startedAt + HOUR)], conversions: conversionsOf(a, "g_buy", 5) });
    const budget = fakeResultsBudget();
    await getResults(owner, sid, "exp_t", resultsOverride(budget));
    // 初回は見込み 10,000 行(前回の値も人数も無い)で予約し、実際の rows_read で 1 回だけ精算する
    const [reserve] = budget.calls.filter((c) => c.method === "reserveRead");
    expect(reserve!.args[1]).toBe(10_000);
    const settles = budget.calls.filter((c) => c.method === "settleRead");
    expect(settles).toHaveLength(1);
    const token = (reserve!.result as { token: string }).token;
    const actual = settles[0]!.args[1] as number;
    expect(settles[0]!.args[0]).toBe(token);
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThan(10_000);
    expect(budget.state.readUsed).toBe(actual);
    // 実際の行数は保存した速報に残り、次の再計算の見込みになる
    expect((await cacheRow(sid, "exp_t"))!.rows_read).toBe(actual);
    await ageCache(sid, "exp_t", 5 * MIN);
    await getResults(owner, sid, "exp_t", resultsOverride(budget));
    const reserves = budget.calls.filter((c) => c.method === "reserveRead");
    expect(reserves[1]!.args[1]).toBe(actual);
  });

  test("reach_and_aggregation_share_one_read_reservation", async () => {
    // 到達を初めて見つける結果の API の読み取りで、予約 1 回・精算 1 回、集計の cutoff は到達から決めた評価時点
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 5 * DAY;
    await backdate(sid, "exp_t", startedAt);
    // a は 2 日目に 100 人目、b は 3 日目に 100 人目 → 到達 = b の 100 人目の参加の時刻(最低期間 1 日の後)
    const a = participants(runId, sid, "a", 100, startedAt + DAY, MIN);
    const b = participants(runId, sid, "b", 100, startedAt + 2 * DAY, MIN);
    const reachedAt = b[99]!.exposedAt!;
    // 到達の後の参加と CV(評価時点の後なので数えない)
    const late = participants(runId, sid, "a", 7, reachedAt + HOUR, MIN);
    await seedResults({ participants: [...a, ...b, ...late], conversions: [...conversionsOf(a, "g_buy", 3), ...conversionsOf(late, "g_buy", 7)] });
    const budget = fakeResultsBudget();
    const r = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(budget.calls.filter((c) => c.method === "settleRead")).toHaveLength(1);
    expect(r.evaluation).toMatchObject({ reachedAt, evaluationAt: reachedAt });
    expect(r.cutoff).toBe(reachedAt);
    expect(variantOf(r, "a")).toMatchObject({ n: 100, y: 3 });
    expect(variantOf(r, "b")).toMatchObject({ n: 100, y: 0 });
    // 到達を記録した(以後は読まずに使う)
    const plan = await getDb(env).selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", "exp_t").executeTakeFirstOrThrow();
    expect(plan.reached_at).toBe(reachedAt);
  });

  test("failure_ratio_excludes_hour_containing_cutoff", async () => {
    // ResultsHealth.read の toHour が hourOf(cutoff)。hourOf は control の apps/control/src/results/time.ts のもの(edge から import しない)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - 2 * DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: [...participants(runId, sid, "a", 49, startedAt + HOUR), ...participants(runId, sid, "b", 48, startedAt + HOUR)] });
    const now = Date.now();
    const health = fakeResultsHealth({
      [runId]: [
        { hour: hourOf(startedAt + 2 * HOUR), failed: 3 },
        { hour: hourOf(now), failed: 50 }, // cutoff を含む時(まだ終わっていない)
      ],
    });
    const r = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(fakeResultsBudget(), health)));
    expect(health.calls).toHaveLength(1);
    expect(health.calls[0]).toMatchObject({ siteId: sid, runId, fromHour: hourOf(startedAt), toHour: hourOf(r.cutoff!) });
    expect(r.qualityDetail.failedSends).toBe(3);
    expect(r.qualityDetail.failureRatio).toBeCloseTo(3 / (3 + 97), 12);
    expect(r.notes).toContainEqual({ key: "collection_failures", params: { ratio: 3 / 100, failedSends: 3 } });
    expect(r.quality).toBe("warning");
  });

  test("failure_ratio_counts_resent_and_multi_run_conversions", async () => {
    // 送り直し・複数 run の CV・同じ日の cutoff の前後・同時に実行中のテスト・送り直して保存できた送信
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const run1 = await startTest(owner, sid, "exp_1");
    const run2 = await startTest(owner, sid, "exp_2");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_1", startedAt);
    await backdate(sid, "exp_2", startedAt);
    const now = Date.now();
    const p1 = participants(run1, sid, "a", 10, startedAt + HOUR);
    const p2 = participants(run2, sid, "a", 5, startedAt + HOUR);
    // 同じ訪問者が両方のテストに参加して 1 回の CV(run ごとに 1 行)。p1[0] は最初の送信が失敗し、送り直して保存できた
    const shared = p1[0]!.visitor;
    p2[0]!.visitor = shared;
    await seedResults({
      participants: [...p1, ...p2],
      conversions: [
        { runId: run1, goalId: "g_buy", visitor: shared, convertedAt: startedAt + 3 * HOUR },
        { runId: run2, goalId: "g_buy", visitor: shared, convertedAt: startedAt + 3 * HOUR },
        { runId: run1, goalId: "g_other", visitor: p1[1]!.visitor, convertedAt: startedAt + 3 * HOUR },
        // cutoff(今)より後の CV は個票に数えない
        { runId: run1, goalId: "g_buy", visitor: p1[2]!.visitor, convertedAt: now + HOUR },
      ],
    });
    const health = fakeResultsHealth({
      [run1]: [
        { hour: hourOf(startedAt + HOUR), failed: 2 }, // 送り直して保存できた送信の失敗も数える
        { hour: hourOf(now) + 2 * HOUR, failed: 40 }, // cutoff の後の時(同じ日)は数えない
      ],
      [run2]: [{ hour: hourOf(startedAt + 3 * HOUR), failed: 7 }], // 複数 run の CV の失敗は run ごとに 1 件
    });
    const env1 = resultsOverride(fakeResultsBudget(), health);
    const r1 = await json<Report>(await getResults(owner, sid, "exp_1", env1));
    // run1: 失敗 2 / (2 + 参加 10 + CV 2)
    expect(r1.qualityDetail.failedSends).toBe(2);
    expect(r1.qualityDetail.failureRatio).toBeCloseTo(2 / 14, 12);
    const r2 = await json<Report>(await getResults(owner, sid, "exp_2", resultsOverride(fakeResultsBudget(), health)));
    // run2: 失敗 7 / (7 + 参加 5 + CV 1)。もう一方のテストの失敗を混ぜない
    expect(r2.qualityDetail.failedSends).toBe(7);
    expect(r2.qualityDetail.failureRatio).toBeCloseTo(7 / 13, 12);
  });

  test("収集の停止の期間 = stopPeriods + results_collection_log の無効の期間", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - 10 * DAY;
    await backdate(sid, "exp_t", startedAt);
    // 予算の停止 1〜3 時間目、サイトで無効にした期間 2〜5 時間目(重なる 1 時間は 1 回だけ数える = 合計 4 時間)
    const budget = fakeResultsBudget({ stopPeriods: [{ reason: "write_budget", from: startedAt + HOUR, to: startedAt + 3 * HOUR }] });
    await env.DB.batch([
      env.DB.prepare("insert into results_collection_log (site_id, at, enabled, publish_version) values (?, ?, 0, 900)").bind(sid, startedAt + 2 * HOUR),
      env.DB.prepare("insert into results_collection_log (site_id, at, enabled, publish_version) values (?, ?, 1, 901)").bind(sid, startedAt + 5 * HOUR),
    ]);
    const r = await json<Report>(await getResults(owner, sid, "exp_t", resultsOverride(budget)));
    expect(budget.calls.find((c) => c.method === "stopPeriods")!.args).toEqual([startedAt, r.cutoff]);
    expect(r.qualityDetail.stopPeriods).toEqual([
      { reason: "write_budget", from: startedAt + HOUR, to: startedAt + 3 * HOUR },
      { reason: "site_disabled", from: startedAt + 2 * HOUR, to: startedAt + 5 * HOUR },
    ]);
    expect(r.qualityDetail.stopRatio).toBeCloseTo((4 * HOUR) / (r.cutoff! - startedAt), 12);
    const stops = r.notes.find((n) => n.key === "collection_stops");
    expect(stops?.params?.hours).toBeCloseTo(4, 12);
  });

  test("凍結中は保存した速報を書かず persisted: false", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    const a = participants(runId, sid, "a", 100, startedAt + HOUR);
    const b = participants(runId, sid, "b", 100, startedAt + 2 * HOUR);
    await seedResults({ participants: [...a, ...b] });
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\",\"until\":\"2099-01-01T00:00:00+09:00\"}', 1)").run();
    const res = await getResults(owner, sid, "exp_t");
    expect(res.status).toBe(200);
    const r = await json<Report>(res);
    expect(r.persisted).toBe(false);
    // 計算した値は返す(到達は見つけたが記録しない)
    expect(r.evaluation?.reachedAt).toBe(b[99]!.exposedAt);
    expect(variantOf(r, "a").n).toBe(100);
    expect(await cacheRow(sid, "exp_t")).toBeUndefined();
    const plan = await getDb(env).selectFrom("evaluation_plans").select("reached_at").where("site_id", "=", sid).where("experiment_id", "=", "exp_t").executeTakeFirstOrThrow();
    expect(plan.reached_at).toBeNull();
    // 評価時点の前の速報でも保存しない(開始は凍結を外して行う)
    const other = "exp_u";
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    const run2 = await startTest(owner, sid, other);
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\",\"until\":\"2099-01-01T00:00:00+09:00\"}', 1)").run();
    await seedResults({ participants: participants(run2, sid, "a", 2, Date.now() - MIN) });
    const u = await json<Report>(await getResults(owner, sid, other));
    expect(u.phase).toBe("interim");
    expect(u.persisted).toBe(false);
    expect(variantOf(u, "a").n).toBe(2);
    expect(await cacheRow(sid, other)).toBeUndefined();
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
  });

  test("重み 0 のパターンは判定のラベルを持たず、注記 zero_weight で「配信していない」を示す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", {}, { variants: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50 }, { id: "c", name: "C", weight: 0 }] });
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: [...participants(runId, sid, "a", 3, startedAt + HOUR), ...participants(runId, sid, "b", 3, startedAt + HOUR)] });
    const r = await json<Report>(await getResults(owner, sid, "exp_t"));
    expect(variantOf(r, "c")).toMatchObject({ weight: 0, n: 0, state: null, probBest: null });
    expect(r.notes).toContainEqual({ key: "zero_weight", params: { variantId: "c" } });
  });

  test("読み取りの予約の精算に失敗しても、組み立てた結果を返す(予約は DO の側の期限で解ける)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t");
    const startedAt = Date.now() - DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: participants(runId, sid, "a", 3, startedAt + HOUR) });
    const budget = fakeResultsBudget();
    budget.stub.settleRead = async () => {
      throw new Error("settle failed");
    };
    const res = await getResults(owner, sid, "exp_t", resultsOverride(budget));
    expect(res.status).toBe(200);
    const r = await json<Report>(res);
    expect(variantOf(r, "a").n).toBe(3);
    // CV 0 件のパターンの区間は正確な分位点(Beta(1, 4) の 2.5% 点は 1 − 0.975^(1/4))
    expect(variantOf(r, "a").cvrCi95[0]).toBeCloseTo(1 - 0.975 ** (1 / 4), 12);
  });

  test("Publish で保存した速報を消す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    await getResults(owner, sid, "exp_t");
    expect(await cacheRow(sid, "exp_t")).toBeDefined();
    const pub = await publishRes(owner.token, sid, RESULTS_STORE);
    expect(pub.status).toBe(200);
    expect(await cacheRow(sid, "exp_t")).toBeUndefined();
  });
});
