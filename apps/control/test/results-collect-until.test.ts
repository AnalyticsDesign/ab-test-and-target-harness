import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { kvKeys, utcDay } from "@wtt/core";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { loadPlan } from "../src/evaluation-plan";
import { checkReach, collectUntilMap, rewriteCollectUntil } from "../src/results/collect-until";
import { apiGuard, WriteFrozen } from "../src/results/guard";
import { openRead, type ReadSession } from "../src/results/read-session";
import { loadVariants } from "../src/routes/experiments";
import {
  call,
  createExperiment,
  expectEnvelope,
  experimentRow,
  failingKv,
  fakeResultsBudget,
  json,
  RESULTS_STORE,
  seedResults,
  setupOwner,
  siteRow,
  testEnvWith,
  TEXT_CHANGE,
  type SeedParticipant,
} from "./helpers";

// D9 plan ③ Task 8(K9・K11・K13・K24、設計書 §5.3・§5.4): 収集の締め切り(KV の resultsCollectUntil)と目標参加者数の到達の記録

type Owner = Awaited<ReturnType<typeof setupOwner>>;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** 結果を記録するサイト(計測用 D1 がある導入で作る = results_enabled 1) */
async function recordingSite(owner: Owner): Promise<string> {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

const setStatus = (owner: Owner, sid: string, eid: string, status: string, envOverride: Partial<Env> = RESULTS_STORE) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status }, envOverride });
const putPlan = (owner: Owner, sid: string, eid: string, plan: Record<string, unknown>, envOverride?: Partial<Env>) =>
  call("PUT", `/sites/${sid}/experiments/${eid}/evaluation-plan`, { token: owner.token, body: { plan }, envOverride });

/**
 * 結果を記録するサイトでテストを開始する(既定のパターン a / b。variants を渡せば置き換える)。戻り値 = run_id。
 * goalId は同じサイトで 1 回だけ作る
 */
async function startTest(
  owner: Owner,
  sid: string,
  eid: string,
  plan: Record<string, unknown> = {},
  opts: { variants?: Array<{ id: string; name: string; weight: number }>; envOverride?: Partial<Env> } = {},
): Promise<string> {
  await createExperiment(owner.token, sid, { id: eid });
  if (opts.variants) expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token: owner.token, body: opts.variants })).status).toBe(200);
  expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(200);
  const goal = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_buy", name: "購入", type: "CUSTOM", config: {} } });
  expect([201, 409]).toContain(goal.status);
  expect((await putPlan(owner, sid, eid, { primaryGoalId: "g_buy", ...plan })).status).toBe(200);
  expect((await setStatus(owner, sid, eid, "running", opts.envOverride ?? RESULTS_STORE)).status).toBe(200);
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

/** KV の Site の設定の記録 */
async function kvSettings(sid: string): Promise<Record<string, unknown> & { resultsCollectUntil?: Record<string, number> }> {
  const raw = await env.CONFIG_KV.get(kvKeys.settings(sid));
  expect(raw).not.toBeNull();
  return JSON.parse(raw!);
}

const planRow = (sid: string, eid: string) =>
  getDb(env).selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirstOrThrow();

/** パターンごとに n 人の参加(exposedAt = from + i 分)。visitor は base から振る(run の中で重ならないように) */
let visitorSeq = 1;
function participants(runId: string, sid: string, variantId: string, n: number, from: number, stepMs = 60_000): SeedParticipant[] {
  return Array.from({ length: n }, (_, i) => ({ runId, siteId: sid, visitor: visitorSeq++, variantId, exposedAt: from + i * stepMs }));
}

/** 計測用 D1 と偽の予算の DO がある env(checkReach を直接呼ぶ用) */
function resultsEnv(budget = fakeResultsBudget()): Env {
  return { ...testEnvWith({ resultsStore: true }), RESULTS_BUDGET: budget.ns };
}

/** 到達の確認を 1 回(読み取りの予約 → checkReach → 精算)。guard を渡さなければ API の guard */
async function runCheckReach(sid: string, eid: string, now: number, opts: { env?: Env; guard?: () => Promise<void> } = {}): Promise<number | null> {
  const e = opts.env ?? resultsEnv();
  const db = getDb(e);
  const exp = await experimentRow(sid, eid);
  const plan = await loadPlan(db, sid, exp, await loadVariants(db, sid, eid));
  const session = await openRead(e, utcDay(now), 10_000, now);
  if ("refused" in session) throw new Error(`read refused: ${session.refused}`);
  try {
    return await checkReach(e, db, await siteRow(sid), exp, plan, now, session, opts.guard ?? apiGuard(e));
  } finally {
    await session.close();
  }
}

describe("収集の締め切り(resultsCollectUntil)", () => {
  test("collection_stops_at_evaluation_point", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 目標なしで開始 → KV の settings の resultsCollectUntil[runId] = minEnd(誰も結果を読まなくても開始の時点で入る)
    const runId = await startTest(owner, sid, "exp_t", { minDays: 10 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    const settings = await kvSettings(sid);
    expect(settings.resultsCollectUntil).toEqual({ [runId]: startedAt + 10 * DAY });
    // ほかの設定の項目はそのまま(siteToSettings の形に締め切りを足しただけ)
    expect(settings.siteId).toBe(sid);
    expect(settings.settingsVersion).toBe(1);
  });

  test("collect_until_updated_on_reach_extension_and_early_stop", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const budget = fakeResultsBudget();
    const override = { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns };
    // 目標ありで開始: 到達の前は maxEnd
    const runId = await startTest(owner, sid, "exp_t", { minDays: 14, maxWeeks: 8, targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 56 * DAY });
    // 到達(最低期間の前に届いた)を記録: max(minEnd, reachedAt) = minEnd
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    expect(await runCheckReach(sid, "exp_t", Date.now(), { env: resultsEnv(budget) })).toBe(startedAt + HOUR + 99 * 60_000);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 14 * DAY });
    // 期間を延ばす: 新しい minEnd
    expect((await putPlan(owner, sid, "exp_t", { minDays: 21 }, override)).status).toBe(200);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 21 * DAY });
    // 目標を増やす: 到達の記録を消すので、また maxEnd
    expect((await putPlan(owner, sid, "exp_t", { targetPerVariant: 200 }, override)).status).toBe(200);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 56 * DAY });
    // 評価時点の前に終了: 終了の時刻
    expect((await setStatus(owner, sid, "exp_t", "archived")).status).toBe(200);
    const stoppedAt = (await experimentRow(sid, "exp_t")).stopped_at!;
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: stoppedAt });
  });

  test("Site の PATCH で KV を書き直しても resultsCollectUntil が消えない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 7 });
    const before = (await kvSettings(sid)).resultsCollectUntil;
    expect(before).toEqual({ [runId]: expect.any(Number) });
    const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { decisionTimeoutMs: 900 }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(200);
    const after = await kvSettings(sid);
    expect(after.decisionTimeoutMs).toBe(900);
    expect(after.resultsCollectUntil).toEqual(before);
  });

  test("Site の PATCH が失敗して KV を戻すときも resultsCollectUntil を残す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 7 });
    const before = (await kvSettings(sid)).resultsCollectUntil;
    // 前進の settings の put が 1 回落ちる → 503。戻しの putSiteRecords(旧行)も締め切りを付けて書く
    const res = await call("PATCH", `/sites/${sid}`, {
      token: owner.token,
      body: { decisionTimeoutMs: 900 },
      envOverride: { ...RESULTS_STORE, CONFIG_KV: failingKv(new RegExp(`^site:${sid}:settings$`), "put", 1) },
    });
    expect(res.status).toBe(503);
    const after = await kvSettings(sid);
    expect(after.decisionTimeoutMs).not.toBe(900);
    expect(after.resultsCollectUntil).toEqual(before);
    expect(after.resultsCollectUntil).toHaveProperty(runId);
  });

  test("終了したテストの項目は個票を消すまで残り、results_purged_at で消える", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 7 });
    expect((await setStatus(owner, sid, "exp_t", "archived")).status).toBe(200);
    const stoppedAt = (await experimentRow(sid, "exp_t")).stopped_at!;
    // 終了しても項目は残る(終了の時刻 = 評価時点の前の終了)
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: stoppedAt });
    expect(await collectUntilMap(getDb(env), sid)).toEqual({ [runId]: stoppedAt });
    // 個票を消した(results_purged_at)→ 書き直すと項目が消え、空なら resultsCollectUntil の項目そのものを出さない
    await env.DB.prepare("update experiments set results_purged_at = ? where site_id = ? and id = ?").bind(Date.now(), sid, "exp_t").run();
    expect(await collectUntilMap(getDb(env), sid)).toEqual({});
    await rewriteCollectUntil(testEnvWith({ resultsStore: true }), getDb(env), sid, apiGuard(env));
    expect(await kvSettings(sid)).not.toHaveProperty("resultsCollectUntil");
  });

  test("collection_stays_closed_after_retention_purge_of_running_test", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 7 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    // 実行中のまま期限で個票を消した後、Site の PATCH で KV を書き直しても締め切りが残る
    await env.DB.prepare("update experiments set results_purged_at = ? where site_id = ? and id = ?").bind(Date.now(), sid, "exp_t").run();
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { decisionTimeoutMs: 900 }, envOverride: RESULTS_STORE })).status).toBe(200);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 7 * DAY });
    // 一時停止中も同じ
    expect((await setStatus(owner, sid, "exp_t", "paused")).status).toBe(200);
    expect(await collectUntilMap(getDb(env), sid)).toEqual({ [runId]: startedAt + 7 * DAY });
  });

  test("ほかのサイトの run と run_id の無いテストは載せない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const other = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 7 });
    const otherRun = await startTest(owner, other, "exp_o", { minDays: 9 });
    // 結果を記録しないで開始したテスト(run_id なし)
    await createExperiment(owner.token, sid, { id: "exp_norun" });
    await call("PUT", `/sites/${sid}/experiments/exp_norun/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    expect((await setStatus(owner, sid, "exp_norun", "running", {})).status).toBe(200);
    expect((await experimentRow(sid, "exp_norun")).run_id).toBeNull();
    expect(Object.keys(await collectUntilMap(getDb(env), sid))).toEqual([runId]);
    expect(Object.keys((await kvSettings(other)).resultsCollectUntil!)).toEqual([otherRun]);
  });

  test("collect_until_kv_write_failure_is_retried_by_cron の前半: 失敗で collect_until_dirty = 1", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 開始の後の締め切りの書き込み(settings の put)だけが落ちる → 開始は 200 のまま、印が立つ
    const failing = failingKv(new RegExp(`^site:${sid}:settings$`), "put");
    await startTest(owner, sid, "exp_t", { minDays: 7 }, { envOverride: { ...RESULTS_STORE, CONFIG_KV: failing } });
    expect((await siteRow(sid)).collect_until_dirty).toBe(1);
    expect((await kvSettings(sid)).resultsCollectUntil).toBeUndefined();
    // 直接呼んでも投げない
    await env.DB.prepare("update sites set collect_until_dirty = 0 where id = ?").bind(sid).run();
    await expect(rewriteCollectUntil({ ...testEnvWith({ resultsStore: true }), CONFIG_KV: failing }, getDb(env), sid, apiGuard(env))).resolves.toBeUndefined();
    expect((await siteRow(sid)).collect_until_dirty).toBe(1);
  });

  test("凍結中は KV の書き込みが失敗しても印を書かない(投げない)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t", { minDays: 7 });
    const failing = failingKv(new RegExp(`^site:${sid}:settings$`), "put");
    const frozen = async () => {
      throw new WriteFrozen();
    };
    await expect(rewriteCollectUntil({ ...testEnvWith({ resultsStore: true }), CONFIG_KV: failing }, getDb(env), sid, frozen)).resolves.toBeUndefined();
    expect((await siteRow(sid)).collect_until_dirty).toBe(0);
  });
});

describe("到達の記録(checkReach)", () => {
  test("reached_at_is_exposed_at_not_recorded_time", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 14, targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    // b の 100 人目が最も遅い(a は 1 分おき、b は 2 分おき)
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR, 120_000)] });
    const now = Date.now() + 5 * HOUR;
    const reachedAt = startedAt + HOUR + 99 * 120_000;
    expect(await runCheckReach(sid, "exp_t", now)).toBe(reachedAt);
    const row = await planRow(sid, "exp_t");
    expect(row.reached_at).toBe(reachedAt);
    expect(row.reached_recorded_at).toBe(now);
    expect(row.reached_at).not.toBe(row.reached_recorded_at);
  });

  test("目標に届いていない・目標が無いときは何も記録しない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    // b が 99 人
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 99, startedAt + HOUR)] });
    expect(await runCheckReach(sid, "exp_t", Date.now())).toBeNull();
    expect((await planRow(sid, "exp_t")).reached_at).toBeNull();
    // 目標なし: 読まずに null
    const run2 = await startTest(owner, sid, "exp_none", {});
    await seedResults({ participants: [...participants(run2, sid, "a", 100, startedAt), ...participants(run2, sid, "b", 100, startedAt)] });
    const budget = fakeResultsBudget();
    expect(await runCheckReach(sid, "exp_none", Date.now(), { env: resultsEnv(budget) })).toBeNull();
    expect((await planRow(sid, "exp_none")).reached_at).toBeNull();
    expect(budget.calls.find((c) => c.method === "settleRead")?.args[1]).toBe(0);
  });

  test("forget_after_target_reached_does_not_move_evaluation_at", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + 2 * DAY), ...participants(runId, sid, "b", 100, startedAt + 2 * DAY)] });
    const reachedAt = startedAt + 2 * DAY + 99 * 60_000;
    expect(await runCheckReach(sid, "exp_t", Date.now())).toBe(reachedAt);
    const recorded = await planRow(sid, "exp_t");
    const kvBefore = (await kvSettings(sid)).resultsCollectUntil;
    expect(kvBefore).toEqual({ [runId]: reachedAt });
    // 撤回で b の参加者を消す → 未到達に戻らず、読みもしない
    await env.RESULTS_DB!.prepare("delete from participants where run_id = ? and variant_id = 'b' and exposed_at > ?").bind(runId, startedAt + 2 * DAY + 50 * 60_000).run();
    const budget = fakeResultsBudget();
    expect(await runCheckReach(sid, "exp_t", Date.now() + HOUR, { env: resultsEnv(budget) })).toBe(reachedAt);
    expect(await planRow(sid, "exp_t")).toEqual(recorded);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual(kvBefore);
    expect(budget.calls.find((c) => c.method === "settleRead")?.args[1]).toBe(0);
    const plan = await json(await call("GET", `/sites/${sid}/experiments/exp_t/evaluation-plan`, { token: owner.token }));
    expect(plan.evaluation).toMatchObject({ reachedAt, evaluationAt: reachedAt });
  });

  test("forget_before_reach_check_shifts_reached_at_to_next_participant", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    // a は 101 人(後から来るほど遅い)、b は a より早く 100 人
    await seedResults({ participants: [...participants(runId, sid, "a", 101, startedAt + 2 * HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    // 確かめる前に、a の 5 人目が撤回で消える → a の 100 人目は元の 101 人目
    await env.RESULTS_DB!.prepare("delete from participants where run_id = ? and variant_id = 'a' and exposed_at = ?").bind(runId, startedAt + 2 * HOUR + 4 * 60_000).run();
    expect(await runCheckReach(sid, "exp_t", Date.now())).toBe(startedAt + 2 * HOUR + 100 * 60_000);
  });

  test("evaluation_point_ignores_zero_weight_variant_for_target", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const variants = [
      { id: "a", name: "A", weight: 50 },
      { id: "b", name: "B", weight: 50 },
      { id: "c", name: "C", weight: 0 },
    ];
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 }, { variants });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    // 重み 0 の c には誰も参加しない。a・b が届けば到達
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    expect(await runCheckReach(sid, "exp_t", Date.now())).toBe(startedAt + HOUR + 99 * 60_000);
    expect((await planRow(sid, "exp_t")).reached_at).toBe(startedAt + HOUR + 99 * 60_000);
  });

  test("late_reach_writes_until_recorded_are_excluded_by_cutoff", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    // 最低期間(1 日)の後で届く。到達を確かめるまで(結果の API か Cron が読むまで)の間にも参加が書かれる
    const reachedAt = startedAt + 2 * DAY + 99 * 60_000;
    await seedResults({
      participants: [
        ...participants(runId, sid, "a", 100, startedAt + 2 * DAY),
        ...participants(runId, sid, "b", 100, startedAt + 2 * DAY),
        ...participants(runId, sid, "a", 20, startedAt + 2.5 * DAY),
        ...participants(runId, sid, "b", 20, startedAt + 2.5 * DAY),
      ],
    });
    // 到達を記録する前の締め切りは maxEnd(遅れて書かれた参加は締め切りの前なので受けた)
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 56 * DAY });
    const now = Date.now();
    expect(await runCheckReach(sid, "exp_t", now)).toBe(reachedAt);
    // 締め切り = 評価時点 = 到達した参加の時刻(確かめた時刻ではない)。遅れて書かれた参加はすべて締め切りより後で、
    // 判定の cutoff(= 評価時点、結果の集計は Task 9)で外れる
    const until = (await kvSettings(sid)).resultsCollectUntil![runId]!;
    expect(until).toBe(reachedAt);
    expect(until).toBeLessThan(now);
    const late = await env.RESULTS_DB!.prepare("select count(*) as n from participants where run_id = ? and exposed_at >= ?").bind(runId, until + 1).first<{ n: number }>();
    expect(late?.n).toBe(40);
    const plan = await json(await call("GET", `/sites/${sid}/experiments/exp_t/evaluation-plan`, { token: owner.token }));
    expect(plan.evaluation.evaluationAt).toBe(until);
  });

  test("読んだ後に目標を増やした変更が入ったら、古い目標の到達を記録しない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    const e = resultsEnv();
    const db = getDb(e);
    const exp = await experimentRow(sid, "exp_t");
    const stale = await loadPlan(db, sid, exp, await loadVariants(db, sid, "exp_t"));
    // 計画を読んだ後に、目標を 200 人に増やす変更が入る(計測用 D1 の binding の無い env で = 到達を確かめずに受ける)
    expect((await putPlan(owner, sid, "exp_t", { targetPerVariant: 200 })).status).toBe(200);
    const session = await openRead(e, utcDay(Date.now()), 10_000, Date.now());
    if ("refused" in session) throw new Error("refused");
    try {
      expect(await checkReach(e, db, await siteRow(sid), exp, stale, Date.now(), session, apiGuard(e))).toBeNull();
    } finally {
      await session.close();
    }
    const row = await planRow(sid, "exp_t");
    expect(row.reached_at).toBeNull();
    expect(row.reached_recorded_at).toBeNull();
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 56 * DAY });
  });

  test("凍結中は到達を記録せず、確かめた値だけを返す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    const kvBefore = (await kvSettings(sid)).resultsCollectUntil;
    let guarded = 0;
    const frozen = async () => {
      guarded++;
      throw new WriteFrozen();
    };
    expect(await runCheckReach(sid, "exp_t", Date.now(), { guard: frozen })).toBe(startedAt + HOUR + 99 * 60_000);
    expect(guarded).toBeGreaterThan(0);
    const row = await planRow(sid, "exp_t");
    expect(row.reached_at).toBeNull();
    expect(row.reached_recorded_at).toBeNull();
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual(kvBefore);
    // Cron の guard(WriteFrozen 以外)はそのまま投げる
    const cronFrozen = async () => {
      throw new Error("cron frozen");
    };
    await expect(runCheckReach(sid, "exp_t", Date.now(), { guard: cronFrozen })).rejects.toThrow("cron frozen");
  });
});

describe("延長の経路の到達の確認(K9)", () => {
  test("extension_rejected_after_unrecorded_target_reach", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    // 目標に届いたが、API も Cron もまだ読んでいない(reached_at は空)。評価時点 = minEnd(開始 + 1 日)は過ぎている
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    expect((await planRow(sid, "exp_t")).reached_at).toBeNull();
    const budget = fakeResultsBudget();
    const res = await putPlan(owner, sid, "exp_t", { minDays: 2 }, { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("evaluation_already_fixed");
    // 延長の前の確認で到達を記録した(以後の読みも同じ評価時点になる)
    const row = await planRow(sid, "exp_t");
    expect(row.reached_at).toBe(startedAt + HOUR + 99 * 60_000);
    expect(JSON.parse(row.plan_json).minDays).toBe(1);
    // 予約は 1 つ、精算も 1 回
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(1);
    expect(budget.calls.filter((c) => c.method === "settleRead")).toHaveLength(1);
  });

  test("到達を確かめていなくても、まだ届いていなければ延長を受ける(評価時点は maxEnd のまま)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 1, targetPerVariant: 100 });
    const startedAt = Date.now() - 3 * DAY;
    await backdate(sid, "exp_t", startedAt);
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 50, startedAt + HOUR)] });
    const res = await putPlan(owner, sid, "exp_t", { minDays: 2 }, { ...RESULTS_STORE, RESULTS_BUDGET: fakeResultsBudget().ns });
    expect(res.status).toBe(200);
    expect((await planRow(sid, "exp_t")).reached_at).toBeNull();
  });

  test("評価時点の前に新しく到達を記録した延長は、読み直した version で受ける", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_t", { minDays: 14, targetPerVariant: 100 });
    const startedAt = (await experimentRow(sid, "exp_t")).started_at!;
    await seedResults({ participants: [...participants(runId, sid, "a", 100, startedAt + HOUR), ...participants(runId, sid, "b", 100, startedAt + HOUR)] });
    const before = await planRow(sid, "exp_t");
    const res = await putPlan(owner, sid, "exp_t", { minDays: 21 }, { ...RESULTS_STORE, RESULTS_BUDGET: fakeResultsBudget().ns });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.plan.minDays).toBe(21);
    expect(body.evaluation.reachedAt).toBe(startedAt + HOUR + 99 * 60_000);
    const row = await planRow(sid, "exp_t");
    expect(row.reached_at).toBe(startedAt + HOUR + 99 * 60_000);
    expect(row.version).toBe(before.version + 1);
    expect((await kvSettings(sid)).resultsCollectUntil).toEqual({ [runId]: startedAt + 21 * DAY });
  });

  test("読み取りの予約が断られたら 503 results_read_unavailable で、計画を変えない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t", { minDays: 14, targetPerVariant: 100 });
    const before = await planRow(sid, "exp_t");
    for (const budget of [fakeResultsBudget({ readBudget: 0 }), fakeResultsBudget({ readBudget: 1 })]) {
      const res = await putPlan(owner, sid, "exp_t", { minDays: 21 }, { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns });
      expect(res.status).toBe(503);
      const body = await expectEnvelope(res);
      expect(body.error).toBe("results_read_unavailable");
      expect(body.hint).toBe("結果の読み取りが混み合っているか、今日の読み取りの上限に達しました。時間をおいてやり直してください");
    }
    // 予約中(busy)も同じ
    const busy = fakeResultsBudget();
    await busy.stub.reserveRead(utcDay(Date.now()), 1, Date.now());
    const res = await putPlan(owner, sid, "exp_t", { minDays: 21 }, { ...RESULTS_STORE, RESULTS_BUDGET: busy.ns });
    expect(res.status).toBe(503);
    expect(await planRow(sid, "exp_t")).toEqual(before);
  });

  test("到達を記録済み・目標なしの計画の延長は読み取りを予約しない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_none", { minDays: 14 });
    const budget = fakeResultsBudget({ readBudget: 0 });
    expect((await putPlan(owner, sid, "exp_none", { minDays: 21 }, { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns })).status).toBe(200);
    expect(budget.calls.filter((c) => c.method === "reserveRead")).toHaveLength(0);
  });
});
