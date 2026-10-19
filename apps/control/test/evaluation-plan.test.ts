import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { DEFAULT_PLAN } from "@wtt/stats";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import {
  beforeD1Batch,
  call,
  createExperiment,
  createSite,
  expectEnvelope,
  experimentRow,
  json,
  publishRes,
  RESULTS_STORE,
  runDirect,
  setupOwner,
  siteRow,
  TEXT_CHANGE,
} from "./helpers";

// D9 plan ③ Task 5(K7・K8・K9・K24・K25、設計書 §5・§9.1・§9.2): 評価計画の API・開始の検査と固定・容量の警告・goal_in_use

type Owner = Awaited<ReturnType<typeof setupOwner>>;
const DAY = 24 * 60 * 60 * 1000;

/** 結果を記録するサイト(計測用 D1 がある導入で作る = results_enabled 1) */
async function recordingSite(owner: Owner): Promise<string> {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  const { id } = await json<{ id: string }>(res);
  expect((await siteRow(id)).results_enabled).toBe(1);
  return id;
}

/** 変更 1 件付きのテスト(既定のパターン a = オリジナル / b) */
async function testWithChange(owner: Owner, sid: string, eid: string): Promise<void> {
  await createExperiment(owner.token, sid, { id: eid });
  expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(200);
}

async function createGoal(owner: Owner, sid: string, id: string): Promise<void> {
  expect((await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id, name: "購入", type: "CUSTOM", config: {} } })).status).toBe(201);
}

const planPath = (sid: string, eid: string) => `/sites/${sid}/experiments/${eid}/evaluation-plan`;
const putPlan = (owner: Owner, sid: string, eid: string, plan: Record<string, unknown>, extra: { reason?: string; envOverride?: Partial<Env> } = {}) =>
  call("PUT", planPath(sid, eid), { token: owner.token, body: { plan, ...(extra.reason !== undefined ? { reason: extra.reason } : {}) }, envOverride: extra.envOverride });
const getPlan = async (owner: Owner, sid: string, eid: string) => {
  const res = await call("GET", planPath(sid, eid), { token: owner.token });
  expect(res.status).toBe(200);
  return json(res);
};
const setStatus = (owner: Owner, sid: string, eid: string, status: string, envOverride: Partial<Env> = RESULTS_STORE) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status }, envOverride });

/** 結果を記録するサイトで、目標を選んだ計画で開始したテスト */
async function startedRecordingTest(owner: Owner, plan: Record<string, unknown> = {}) {
  const sid = await recordingSite(owner);
  await testWithChange(owner, sid, "exp_t");
  await createGoal(owner, sid, "g_buy");
  expect((await putPlan(owner, sid, "exp_t", { primaryGoalId: "g_buy", ...plan })).status).toBe(200);
  const res = await setStatus(owner, sid, "exp_t", "running");
  expect(res.status).toBe(200);
  return { sid, eid: "exp_t", res };
}

const planRow = (sid: string, eid: string) =>
  getDb(env).selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirst();
const changeRows = (sid: string, eid: string) =>
  getDb(env).selectFrom("evaluation_plan_changes").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).orderBy("id").execute();
const cacheRows = (sid: string, eid: string) =>
  getDb(env).selectFrom("results_interim_cache").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).execute();
async function putCache(sid: string, eid: string, resultJson = '{"variants":[{"n":10},{"n":10}]}', computedAt = Date.now()): Promise<void> {
  await env.DB.prepare("insert or replace into results_interim_cache (site_id, experiment_id, computed_at, rows_read, result_json) values (?, ?, ?, 1, ?)")
    .bind(sid, eid, computedAt, resultJson)
    .run();
}
async function setReached(sid: string, eid: string, at: number): Promise<void> {
  await env.DB.prepare("update evaluation_plans set reached_at = ?, reached_recorded_at = ?, reach_checked_day = '2026-10-19' where site_id = ? and experiment_id = ?")
    .bind(at, at + 1, sid, eid)
    .run();
}

describe("start checks and fixing (K8)", () => {
  test("start_requires_primary_goal_when_recording", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await testWithChange(owner, sid, "exp_nogoal");
    // 計画の行が無い(既定値 = 目標なし)
    const res = await setStatus(owner, sid, "exp_nogoal", "running");
    expect(res.status).toBe(422);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("evaluation_plan_incomplete");
    expect(body.hint).toBe("評価計画のタブで判定に使う目標を選んでください");
    const row = await experimentRow(sid, "exp_nogoal");
    expect(row.status).toBe("draft");
    expect(row.run_id).toBeNull();
    expect(row.started_at).toBeNull();
    expect(await planRow(sid, "exp_nogoal")).toBeUndefined(); // 断った開始は計画も作らない
    // 計画の行があっても目標が未設定なら同じ
    expect((await putPlan(owner, sid, "exp_nogoal", { minDays: 21 })).status).toBe(200);
    expect((await expectEnvelope(await setStatus(owner, sid, "exp_nogoal", "running"))).error).toBe("evaluation_plan_incomplete");
    // 目標を選べば開始できる
    await createGoal(owner, sid, "g_ok");
    expect((await putPlan(owner, sid, "exp_nogoal", { primaryGoalId: "g_ok" })).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_nogoal", "running")).status).toBe(200);
    expect((await experimentRow(sid, "exp_nogoal")).status).toBe("running");
  });

  test("start_without_goal_allowed_when_site_results_disabled", async () => {
    const owner = await setupOwner();
    // 計測用 D1 が無い導入で作ったサイト(結果を記録しない)
    const { id: plain } = await createSite(owner.token, owner.workspaceId);
    await testWithChange(owner, plain, "exp_plain");
    const res = await setStatus(owner, plain, "exp_plain", "running", {});
    expect(res.status).toBe(200);
    expect((await json(res)).warnings).toEqual([{ path: "results", message: expect.stringContaining("結果はツール上に残りません") }]);
    expect((await experimentRow(plain, "exp_plain")).run_id).toBeNull();
    // 計測用 D1 はあるが、サイトで結果の記録を無効にした
    const sid = await recordingSite(owner);
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: false }, envOverride: RESULTS_STORE })).status).toBe(200);
    await testWithChange(owner, sid, "exp_off");
    expect((await setStatus(owner, sid, "exp_off", "running")).status).toBe(200);
    expect((await experimentRow(sid, "exp_off")).run_id).toBeNull();
    // パーソナライズは結果を記録するサイトでも検査しない
    const recording = await recordingSite(owner);
    await createExperiment(owner.token, recording, { id: "exp_single", kind: "single" });
    expect((await setStatus(owner, recording, "exp_single", "running")).status).toBe(200);
  });

  test("baseline_with_zero_weight_is_rejected_at_start", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await testWithChange(owner, sid, "exp_w0");
    await createGoal(owner, sid, "g_w0");
    expect((await putPlan(owner, sid, "exp_w0", { primaryGoalId: "g_w0" })).status).toBe(200);
    // 基準(既定 = オリジナルの a)の重みを 0 にする
    const vs = await call("PUT", `/sites/${sid}/experiments/exp_w0/variants`, {
      token: owner.token,
      body: [
        { id: "a", name: "A パターン", weight: 0 },
        { id: "b", name: "B パターン", weight: 100 },
      ],
    });
    expect(vs.status).toBe(200);
    const res = await setStatus(owner, sid, "exp_w0", "running");
    expect(res.status).toBe(422);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("evaluation_plan_incomplete");
    expect(body.hint).toBe("基準のパターンの重みを 0 より大きくしてください");
    const row = await experimentRow(sid, "exp_w0");
    expect(row.status).toBe("draft");
    expect(row.run_id).toBeNull();
    // 重みのある b を基準にすれば開始できる
    expect((await putPlan(owner, sid, "exp_w0", { baselineVariantId: "b" })).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_w0", "running")).status).toBe(200);
  });

  test("開始で fixed_at が入り、run_id_not_issued_when_site_results_disabled_at_start の Site では fixed_at が入らない", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { minDays: 10 });
    const exp = await experimentRow(sid, eid);
    expect(exp.run_id).toMatch(/.+/);
    const row = (await planRow(sid, eid))!;
    expect(row.fixed_at).toBe(exp.started_at);
    // 固定した計画は、開始の時点の基準(既定 = a)を書き込んだ形
    expect(JSON.parse(row.plan_json)).toEqual({ ...DEFAULT_PLAN, minDays: 10, primaryGoalId: "g_buy", baselineVariantId: "a" });
    const view = await getPlan(owner, sid, eid);
    expect(view.fixed).toBe(true);
    expect(view.fixedAt).toBe(exp.started_at);
    expect(view.evaluation).toEqual({ minEnd: exp.started_at! + 10 * DAY, maxEnd: exp.started_at! + 8 * 7 * DAY, evaluationAt: exp.started_at! + 10 * DAY, reachedAt: null });

    // 結果を記録しないサイト(計測用 D1 はあるが無効): 計画を保存していても固定しない
    const off = await recordingSite(owner);
    expect((await call("PATCH", `/sites/${off}`, { token: owner.token, body: { resultsEnabled: false }, envOverride: RESULTS_STORE })).status).toBe(200);
    await testWithChange(owner, off, "exp_off");
    await createGoal(owner, off, "g_off");
    expect((await putPlan(owner, off, "exp_off", { primaryGoalId: "g_off" })).status).toBe(200);
    expect((await setStatus(owner, off, "exp_off", "running")).status).toBe(200);
    expect((await experimentRow(off, "exp_off")).run_id).toBeNull();
    expect((await planRow(off, "exp_off"))!.fixed_at).toBeNull();
    const offView = await getPlan(owner, off, "exp_off");
    expect(offView.fixed).toBe(false);
    expect(offView.evaluation).toBeNull();
  });

  test("start_rejected_when_plan_saved_during_start(検査した計画だけを固定する)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await testWithChange(owner, sid, "exp_mid");
    await createGoal(owner, sid, "g_mid");
    expect((await putPlan(owner, sid, "exp_mid", { primaryGoalId: "g_mid" })).status).toBe(200);
    // 開始の検査の後、batch の直前に下書きの計画の保存が割り込む
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await putPlan(owner, sid, "exp_mid", { minDays: 21 })).status).toBe(200);
    });
    const res = await setStatus(owner, sid, "exp_mid", "running", { ...RESULTS_STORE, DB: racing });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("invalid_transition");
    expect(body.hint).toBe("評価計画が変わりました。画面を読み込み直してください");
    const row = await experimentRow(sid, "exp_mid");
    expect(row.status).toBe("draft");
    expect(row.run_id).toBeNull();
    const plan = (await planRow(sid, "exp_mid"))!;
    expect(plan.fixed_at).toBeNull();
    expect(JSON.parse(plan.plan_json).minDays).toBe(21); // 割り込んだ保存は残る
    // 読み直してからの開始は、今の計画で固定する
    expect((await setStatus(owner, sid, "exp_mid", "running")).status).toBe(200);
    expect(JSON.parse((await planRow(sid, "exp_mid"))!.plan_json).minDays).toBe(21);
  });

  test("start_rejected_when_baseline_weight_zeroed_during_start(検査の後にパターンの保存が割り込む)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await testWithChange(owner, sid, "exp_bw");
    await createGoal(owner, sid, "g_bw");
    expect((await putPlan(owner, sid, "exp_bw", { primaryGoalId: "g_bw" })).status).toBe(200);
    // 開始の検査(基準 a の重み 50)の後、batch の直前に基準の重みが 0 になる
    const racing = beforeD1Batch(env.DB, async () => {
      const vs = await call("PUT", `/sites/${sid}/experiments/exp_bw/variants`, {
        token: owner.token,
        body: [
          { id: "a", name: "A パターン", weight: 0 },
          { id: "b", name: "B パターン", weight: 100 },
        ],
      });
      expect(vs.status).toBe(200);
    });
    const res = await setStatus(owner, sid, "exp_bw", "running", { ...RESULTS_STORE, DB: racing });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("invalid_transition");
    expect(body.hint).toBe("パターンの設定が変わりました。画面を読み込み直してください");
    const row = await experimentRow(sid, "exp_bw");
    expect(row.status).toBe("draft");
    expect(row.run_id).toBeNull();
    expect((await planRow(sid, "exp_bw"))!.fixed_at).toBeNull();
    // 基準のパターンを消した場合も同じ(重みを戻してから、検査の後に既定の基準 a が消える)
    const restore = await call("PUT", `/sites/${sid}/experiments/exp_bw/variants`, {
      token: owner.token,
      body: [
        { id: "a", name: "A パターン", weight: 50 },
        { id: "b", name: "B パターン", weight: 50 },
      ],
    });
    expect(restore.status).toBe(200);
    const removing = beforeD1Batch(env.DB, async () => {
      const vs = await call("PUT", `/sites/${sid}/experiments/exp_bw/variants`, {
        token: owner.token,
        body: [
          { id: "b", name: "B パターン", weight: 50 },
          { id: "c", name: "C パターン", weight: 50 },
        ],
      });
      expect(vs.status).toBe(200);
    });
    const removed = await setStatus(owner, sid, "exp_bw", "running", { ...RESULTS_STORE, DB: removing });
    expect(removed.status).toBe(409);
    expect((await expectEnvelope(removed)).hint).toBe("パターンの設定が変わりました。画面を読み込み直してください");
    expect((await experimentRow(sid, "exp_bw")).run_id).toBeNull();
    expect((await planRow(sid, "exp_bw"))!.fixed_at).toBeNull();
  });

  test("resume_keeps_run_id_and_fixed_at / legacy_paused_test_can_resume", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner);
    const before = await experimentRow(sid, eid);
    const fixed = (await planRow(sid, eid))!;
    expect((await setStatus(owner, sid, eid, "paused")).status).toBe(200);
    expect((await setStatus(owner, sid, eid, "running")).status).toBe(200);
    const after = await experimentRow(sid, eid);
    expect(after.run_id).toBe(before.run_id);
    expect(after.started_at).toBe(before.started_at);
    const again = (await planRow(sid, eid))!;
    expect(again.fixed_at).toBe(fixed.fixed_at);
    expect(again.version).toBe(fixed.version); // 再開は計画を書き直さない

    // 結果の記録より前に開始して一時停止していたテスト(run_id も計画も無い): 結果を記録するサイトでも検査せずに再開できる
    await createExperiment(owner.token, sid, { id: "exp_legacy" });
    await runDirect(sid, "exp_legacy", "paused");
    await env.DB.prepare("update experiments set started_at = ? where site_id = ? and id = 'exp_legacy'").bind(Date.now() - DAY, sid).run();
    const res = await setStatus(owner, sid, "exp_legacy", "running");
    expect(res.status).toBe(200);
    expect((await experimentRow(sid, "exp_legacy")).run_id).toBeNull();
    expect(await planRow(sid, "exp_legacy")).toBeUndefined();
  });

  test("容量の見込みが 80% を超えると開始の応答の warnings に 1 行(拒否しない)", async () => {
    const owner = await setupOwner();
    const db = getDb(env);
    // 最後に測った大きさが無い: 見込みを出さない
    const none = await startedRecordingTest(owner, { targetPerVariant: 10_000 });
    expect((await json(none.res)).warnings).toEqual([]);

    // 399MB + 目標 10,000 人 × 2 パターン × 169 B(約 3.4MB)= 約 402.4MB > 400MB
    await db.insertInto("results_store_status").values({ id: 1, size_bytes: 399_000_000, measured_at: Date.now() }).onConflict((oc) => oc.column("id").doUpdateSet({ size_bytes: 399_000_000 })).execute();
    const sid = await recordingSite(owner);
    await createGoal(owner, sid, "g_cap");
    await testWithChange(owner, sid, "exp_cap");
    expect((await putPlan(owner, sid, "exp_cap", { primaryGoalId: "g_cap", targetPerVariant: 10_000 })).status).toBe(200);
    const res = await setStatus(owner, sid, "exp_cap", "running");
    expect(res.status).toBe(200); // 拒否しない
    const warnings = (await json<{ warnings: Array<{ path: string; message: string }> }>(res)).warnings;
    expect(warnings).toEqual([
      { path: "resultsCapacity", message: "計測用のデータベースの空きが少なくなります(見込み 約 403 MB)。保持期間を短くするか、終了したテストの記録を整理してください" },
    ]);
    expect((await experimentRow(sid, "exp_cap")).status).toBe("running");

    // 重みが 0 のパターンは数えない: 397.5MB + 目標 10,000 人 × 1 パターン(約 1.7MB)= 約 399.2MB は超えない(2 パターンに数えると 400.9MB で超える)
    await db.updateTable("results_store_status").set({ size_bytes: 397_500_000 }).where("id", "=", 1).execute();
    await testWithChange(owner, sid, "exp_zero");
    const weights = await call("PUT", `/sites/${sid}/experiments/exp_zero/variants`, {
      token: owner.token,
      body: [
        { id: "a", name: "A パターン", weight: 0 },
        { id: "b", name: "B パターン", weight: 100 },
      ],
    });
    expect(weights.status).toBe(200);
    expect((await putPlan(owner, sid, "exp_zero", { primaryGoalId: "g_cap", baselineVariantId: "b", targetPerVariant: 10_000 })).status).toBe(200);
    expect((await json(await setStatus(owner, sid, "exp_zero", "running"))).warnings).toEqual([]);

    // 目標参加者数が無い: 同じサイトの実行中のテストの保存した速報の参加の速さ(10 日で 10,000 人 = 1,000 人 / 日)× 最大期間 56 日 × 169 B ≒ 9.5MB
    await db.updateTable("results_store_status").set({ size_bytes: 395_000_000 }).where("id", "=", 1).execute();
    const startedAt = (await experimentRow(sid, "exp_cap")).started_at!;
    await putCache(sid, "exp_cap", '{"variants":[{"n":5000},{"n":5000}]}', startedAt + 10 * DAY);
    await testWithChange(owner, sid, "exp_rate");
    expect((await putPlan(owner, sid, "exp_rate", { primaryGoalId: "g_cap" })).status).toBe(200);
    const rate = await json<{ warnings: Array<{ path: string; message: string }> }>(await setStatus(owner, sid, "exp_rate", "running"));
    expect(rate.warnings).toEqual([{ path: "resultsCapacity", message: expect.stringContaining("見込み 約 405 MB") }]);
    // 読めない速報は見込みに使わない(ほかに見込みが無ければ警告しない)
    await putCache(sid, "exp_cap", "not json");
    await testWithChange(owner, sid, "exp_unknown");
    expect((await putPlan(owner, sid, "exp_unknown", { primaryGoalId: "g_cap" })).status).toBe(200);
    expect((await json(await setStatus(owner, sid, "exp_unknown", "running"))).warnings).toEqual([]);
  });
});

describe("evaluation plan API (K7・K9)", () => {
  test("既定の基準はオリジナルの中で先頭(決定 61)/ GET は行が無くても既定値で埋める", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, { id: "exp_def" });
    const view = await getPlan(owner, sid, "exp_def");
    expect(view).toEqual({
      plan: { ...DEFAULT_PLAN, primaryGoalId: null, baselineVariantId: "a" },
      fixed: false,
      fixedAt: null,
      evaluation: null,
      cautions: [{ key: "no_target" }],
      changes: [],
    });
    expect(await planRow(sid, "exp_def")).toBeUndefined(); // GET は行を作らない
    // オリジナルが先頭でない: オリジナルの中で先頭
    const put = (body: unknown) => call("PUT", `/sites/${sid}/experiments/exp_def/variants`, { token: owner.token, body });
    expect((await put([{ id: "x", name: "X", weight: 50, original: false }, { id: "y", name: "Y", weight: 50, original: true }])).status).toBe(200);
    expect((await getPlan(owner, sid, "exp_def")).plan.baselineVariantId).toBe("y");
    // オリジナルが無い: 先頭のパターン
    expect((await put([{ id: "x", name: "X", weight: 50 }, { id: "y", name: "Y", weight: 50, original: false }])).status).toBe(200);
    expect((await getPlan(owner, sid, "exp_def")).plan.baselineVariantId).toBe("x");
    // 保存した基準が今のパターンに無くなった: 既定値に戻した形
    expect((await putPlan(owner, sid, "exp_def", { baselineVariantId: "y" })).status).toBe(200);
    expect((await getPlan(owner, sid, "exp_def")).plan.baselineVariantId).toBe("y");
    expect((await put([{ id: "x", name: "X", weight: 50 }, { id: "z", name: "Z", weight: 50 }])).status).toBe(200);
    expect((await getPlan(owner, sid, "exp_def")).plan.baselineVariantId).toBe("x");
    // 下書きの保存: definition は送っても既定のまま、範囲外は 422、整数でない日数は zod で 422
    const saved = await putPlan(owner, sid, "exp_def", { minDays: 7, threshold: 90, definition: { version: 2 } });
    expect(saved.status).toBe(200);
    const savedBody = await json(saved);
    expect(savedBody.plan.definition).toEqual(DEFAULT_PLAN.definition);
    expect(savedBody.cautions).toEqual([{ key: "min_days_short", params: { minDays: 7 } }, { key: "threshold_low", params: { threshold: 90 } }, { key: "no_target" }]);
    expect(savedBody.changes).toEqual([]); // 下書きの保存は履歴に残さない
    const range = await expectEnvelope(await putPlan(owner, sid, "exp_def", { threshold: 80 }));
    expect(range).toMatchObject({ error: "validation_failed", path: ["plan", "threshold"] });
    expect((await expectEnvelope(await putPlan(owner, sid, "exp_def", { minDays: 1.5 }))).error).toBe("validation_failed");
    const unknownGoal = await expectEnvelope(await putPlan(owner, sid, "exp_def", { primaryGoalId: "g_none" }));
    expect(unknownGoal).toMatchObject({ error: "validation_failed", path: ["plan", "primaryGoalId"], message: "判定に使う目標が、このサイトにありません" });
    // パーソナライズには評価計画が無い
    await createExperiment(owner.token, sid, { id: "exp_single", kind: "single" });
    for (const res of [await call("GET", planPath(sid, "exp_single"), { token: owner.token }), await putPlan(owner, sid, "exp_single", { minDays: 21 })]) {
      expect(res.status).toBe(404);
      expect((await expectEnvelope(res)).error).toBe("results_not_applicable");
    }
  });

  test("evaluation_plan_only_extends_after_start", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner);
    // 延ばす: 200、変更の履歴に 1 行
    const ok = await putPlan(owner, sid, eid, { minDays: 21 }, { reason: "流入が少ない" });
    expect(ok.status).toBe(200);
    const okBody = await json(ok);
    expect(okBody.plan.minDays).toBe(21);
    expect(okBody.changes).toEqual([
      { at: expect.any(Number), by: owner.userId, before: expect.objectContaining({ minDays: 14 }), after: expect.objectContaining({ minDays: 21 }), reason: "流入が少ない" },
    ]);
    expect(await changeRows(sid, eid)).toHaveLength(1);
    // 縮める: 409 evaluation_plan_locked
    const shorter = await putPlan(owner, sid, eid, { minDays: 7 });
    expect(shorter.status).toBe(409);
    const shorterBody = await expectEnvelope(shorter);
    expect(shorterBody.error).toBe("evaluation_plan_locked");
    expect(shorterBody.fields).toEqual(["minDays"]);
    expect(shorterBody.hint).toContain("早く終えるときは終了してください");
    // 判定の基準を変える: 409
    const threshold = await putPlan(owner, sid, eid, { threshold: 90 });
    expect(threshold.status).toBe(409);
    expect((await expectEnvelope(threshold)).fields).toEqual(["threshold"]);
    expect((await expectEnvelope(await putPlan(owner, sid, eid, { primaryGoalId: null }))).error).toBe("evaluation_plan_locked");
    // 同じ値の保存は何も書かない
    expect((await putPlan(owner, sid, eid, { minDays: 21 })).status).toBe(200);
    expect(await changeRows(sid, eid)).toHaveLength(1);
    expect((await planRow(sid, eid))!.plan_json).toContain('"minDays":21');
    // 評価時点(開始 + 21 日)の後: 409 evaluation_already_fixed
    await env.DB.prepare("update experiments set started_at = ? where site_id = ? and id = ?").bind(Date.now() - 22 * DAY, sid, eid).run();
    const late = await putPlan(owner, sid, eid, { minDays: 28 });
    expect(late.status).toBe(409);
    expect((await expectEnvelope(late)).error).toBe("evaluation_already_fixed");
    // 終了したテスト: 409 experiment_archived_readonly
    expect((await setStatus(owner, sid, eid, "archived")).status).toBe(200);
    const archived = await putPlan(owner, sid, eid, { minDays: 28 });
    expect(archived.status).toBe(409);
    const archivedBody = await expectEnvelope(archived);
    expect(archivedBody.error).toBe("experiment_archived_readonly");
    expect(archivedBody.hint).toBe("終了したテストは編集できません。変えるときは複製してください");
    expect(await changeRows(sid, eid)).toHaveLength(1);
    // 結果を記録しないで開始したテスト(固定していない): 409 evaluation_plan_locked
    const off = await recordingSite(owner);
    expect((await call("PATCH", `/sites/${off}`, { token: owner.token, body: { resultsEnabled: false }, envOverride: RESULTS_STORE })).status).toBe(200);
    await testWithChange(owner, off, "exp_off");
    expect((await setStatus(owner, off, "exp_off", "running")).status).toBe(200);
    expect((await expectEnvelope(await putPlan(owner, off, "exp_off", { minDays: 21 }))).error).toBe("evaluation_plan_locked");
  });

  test("target_increase_after_reach_clears_reached_at", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { targetPerVariant: 1000 });
    const reached = (await experimentRow(sid, eid)).started_at! + DAY;
    await setReached(sid, eid, reached);
    await putCache(sid, eid);
    // 期間だけを延ばす: 到達の記録は残し、保存した速報は消す
    expect((await putPlan(owner, sid, eid, { minDays: 21 })).status).toBe(200);
    let row = (await planRow(sid, eid))!;
    expect(row.reached_at).toBe(reached);
    expect(row.reached_recorded_at).toBe(reached + 1);
    expect(await cacheRows(sid, eid)).toHaveLength(0);
    // 目標参加者数を増やす: 到達を記録した後(評価時点の前)でも受け、到達の記録を消して確かめ直す
    await putCache(sid, eid);
    const res = await putPlan(owner, sid, eid, { targetPerVariant: 2000 });
    expect(res.status).toBe(200);
    expect((await json(res)).evaluation.reachedAt).toBeNull();
    row = (await planRow(sid, eid))!;
    expect(row.reached_at).toBeNull();
    expect(row.reached_recorded_at).toBeNull();
    expect(row.reach_checked_day).toBeNull();
    expect(await cacheRows(sid, eid)).toHaveLength(0);
    expect((await changeRows(sid, eid)).map((r) => JSON.parse(r.after_json).targetPerVariant)).toEqual([1000, 2000]);
    // 目標参加者数を外す・減らすのは縮める変更
    expect((await expectEnvelope(await putPlan(owner, sid, eid, { targetPerVariant: null }))).fields).toEqual(["targetPerVariant"]);
    expect((await expectEnvelope(await putPlan(owner, sid, eid, { targetPerVariant: 1500 }))).fields).toEqual(["targetPerVariant"]);
    // 目標参加者数を新しく設けるのは延ばす変更
    const fresh = await startedRecordingTest(owner);
    expect((await putPlan(owner, fresh.sid, fresh.eid, { targetPerVariant: 500 })).status).toBe(200);
  });

  test("archive_racing_plan_extension_is_rejected", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { targetPerVariant: 1000 });
    const reached = (await experimentRow(sid, eid)).started_at! + DAY;
    await setReached(sid, eid, reached);
    await putCache(sid, eid);
    const before = (await planRow(sid, eid))!;
    // 延長の検査を通った後、batch の直前に終了が割り込む
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("update experiments set status = 'archived', stopped_at = ? where site_id = ? and id = ?").bind(Date.now(), sid, eid).run();
    });
    const res = await putPlan(owner, sid, eid, { minDays: 21, targetPerVariant: 2000 }, { envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("experiment_archived_readonly");
    // 計画・変更の履歴・到達・保存した速報は変わらない
    const after = (await planRow(sid, eid))!;
    expect(after).toEqual(before);
    expect(after.reached_at).toBe(reached);
    expect(await changeRows(sid, eid)).toHaveLength(0);
    expect(await cacheRows(sid, eid)).toHaveLength(1);
  });

  test("concurrent_plan_extensions_cannot_shorten_effective_plan", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { targetPerVariant: 1000 });
    const reached = (await experimentRow(sid, eid)).started_at! + 2 * DAY;
    // 後の要求(21 日・目標 2,000 人)が同じ version を読んで検査を通った後、batch の直前に、
    // 先の要求(28 日)が書き終わり、その後に到達と保存した速報が作り直される
    const racing = beforeD1Batch(env.DB, async () => {
      const first = await putPlan(owner, sid, eid, { minDays: 28 });
      expect(first.status).toBe(200);
      await setReached(sid, eid, reached);
      await putCache(sid, eid);
    });
    const res = await putPlan(owner, sid, eid, { minDays: 21, targetPerVariant: 2000 }, { envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("evaluation_plan_locked");
    // 計画は 28 日・目標 1,000 人のまま
    const row = (await planRow(sid, eid))!;
    expect(JSON.parse(row.plan_json)).toMatchObject({ minDays: 28, targetPerVariant: 1000 });
    // 拒否された要求は変更の履歴・到達・保存した速報を変えない
    const changes = await changeRows(sid, eid);
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0]!.after_json).minDays).toBe(28);
    expect(row.reached_at).toBe(reached);
    expect(await cacheRows(sid, eid)).toHaveLength(1);
  });

  // 到達も速報も作り直さない競合
  test("concurrent_plan_extensions_rejected_by_version_alone", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { targetPerVariant: 1000 });
    // 後の要求(21 日)が同じ version を読んで検査を通った後、batch の直前に先の要求(28 日)だけが書き終わる。
    // reached_at は両方とも null のままなので、後の要求を断るのは version の条件だけ
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await putPlan(owner, sid, eid, { minDays: 28 })).status).toBe(200);
    });
    const res = await putPlan(owner, sid, eid, { minDays: 21 }, { envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("evaluation_plan_locked");
    const row = (await planRow(sid, eid))!;
    expect(row.reached_at).toBeNull();
    expect(JSON.parse(row.plan_json)).toMatchObject({ minDays: 28, targetPerVariant: 1000 });
    const changes = await changeRows(sid, eid);
    expect(changes).toHaveLength(1);
    expect(JSON.parse(changes[0]!.after_json).minDays).toBe(28);
  });

  // version を進めない到達の記録との競合
  test("plan_extension_rejected_when_reach_recorded_concurrently", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await startedRecordingTest(owner, { targetPerVariant: 1000 });
    const reached = (await experimentRow(sid, eid)).started_at! + DAY;
    // 延長が到達なしの計画を読んで検査を通った後、batch の直前に到達が記録される(到達の記録は version を進めない)
    const racing = beforeD1Batch(env.DB, async () => {
      await setReached(sid, eid, reached);
    });
    const before = (await planRow(sid, eid))!;
    const res = await putPlan(owner, sid, eid, { minDays: 21, targetPerVariant: 2000 }, { envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("evaluation_plan_locked");
    // 到達の記録は消えず、計画・履歴も変わらない(読み直してからやり直す)
    const row = (await planRow(sid, eid))!;
    expect(row.reached_at).toBe(reached);
    expect(row.plan_json).toBe(before.plan_json);
    expect(row.version).toBe(before.version);
    expect(await changeRows(sid, eid)).toHaveLength(0);
  });

  test("draft_plan_put_cannot_overwrite_fixed_plan", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await testWithChange(owner, sid, "exp_race");
    await createGoal(owner, sid, "g_race");
    expect((await putPlan(owner, sid, "exp_race", { primaryGoalId: "g_race" })).status).toBe(200);
    // 下書きの PUT が読んだ後、batch の直前に開始が割り込む(計画は最低期間 14 日で固定される)
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(owner, sid, "exp_race", "running")).status).toBe(200);
    });
    const res = await putPlan(owner, sid, "exp_race", { minDays: 7, threshold: 90 }, { envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("evaluation_plan_locked");
    const row = (await planRow(sid, "exp_race"))!;
    expect(row.fixed_at).not.toBeNull();
    expect(JSON.parse(row.plan_json)).toMatchObject({ minDays: 14, threshold: 95, primaryGoalId: "g_race" });
    expect((await experimentRow(sid, "exp_race")).status).toBe("running");
  });

  test("評価計画の保存で「未公開の編集あり」が付かない(isUnpublished が false のまま)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, { id: "exp_pub" });
    await createGoal(owner, sid, "g_pub");
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    const expBefore = await experimentRow(sid, "exp_pub");
    const siteBefore = await siteRow(sid);
    expect((await json(await call("GET", `/sites/${sid}/experiments/exp_pub`, { token: owner.token }))).unpublished).toBe(false);
    expect((await putPlan(owner, sid, "exp_pub", { primaryGoalId: "g_pub", minDays: 21 })).status).toBe(200);
    expect((await json(await call("GET", `/sites/${sid}/experiments/exp_pub`, { token: owner.token }))).unpublished).toBe(false);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(false);
    expect((await experimentRow(sid, "exp_pub")).updated_at).toBe(expBefore.updated_at);
    const siteAfter = await siteRow(sid);
    expect(siteAfter.content_updated_at).toBe(siteBefore.content_updated_at);
    expect(siteAfter.updated_at).toBe(siteBefore.updated_at);
  });

  test("評価計画が参照する目標は削除できない(goal_in_use)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 下書きの計画から参照
    await testWithChange(owner, sid, "exp_draft");
    await createGoal(owner, sid, "g_draft");
    expect((await putPlan(owner, sid, "exp_draft", { primaryGoalId: "g_draft" })).status).toBe(200);
    const res = await call("DELETE", `/sites/${sid}/goals/g_draft`, { token: owner.token });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("goal_in_use");
    expect(body.message).toContain("評価計画");
    expect(body.hint).toContain("評価計画");
    // 実行中・一時停止中のテストの固定した計画から参照
    expect((await setStatus(owner, sid, "exp_draft", "running")).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/goals/g_draft`, { token: owner.token })).status).toBe(409);
    expect((await setStatus(owner, sid, "exp_draft", "paused")).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/goals/g_draft`, { token: owner.token })).status).toBe(409);
    // 終了したテストの計画は参照に数えない(記録は目標の名前を写す)
    expect((await setStatus(owner, sid, "exp_draft", "archived")).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/goals/g_draft`, { token: owner.token })).status).toBe(204);
    // 参照されていない目標は今までどおり削除できる
    await createGoal(owner, sid, "g_free");
    expect((await call("DELETE", `/sites/${sid}/goals/g_free`, { token: owner.token })).status).toBe(204);
  });
});
