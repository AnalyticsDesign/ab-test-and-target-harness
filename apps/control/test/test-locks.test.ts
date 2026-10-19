import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { beforeD1Batch, call, createExperiment, createSite, expectEnvelope, experimentRow, json, setupOwner, TEXT_CHANGE } from "./helpers";

// D9 plan ③ Task 6(K10・K25、設計書 §5.5、B77 の K9): 開始後のテストの編集の制限・終了したテストは読み取り専用(メモを除く)・
// 目標を参照している実行中のテスト

type Owner = Awaited<ReturnType<typeof setupOwner>>;

const TRAFFIC_HINT = "テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください";
const PERSIST_HINT = "テストの開始後は割当の固定を変えられません";
const READONLY_HINT = "終了したテストは編集できません。変えるときは複製してください";

const expPath = (sid: string, eid: string) => `/sites/${sid}/experiments/${eid}`;
const patchExp = (owner: Owner, sid: string, eid: string, body: Record<string, unknown>, envOverride?: Partial<Env>) =>
  call("PATCH", expPath(sid, eid), { token: owner.token, body, envOverride });
const setStatus = (owner: Owner, sid: string, eid: string, status: string) =>
  call("POST", `${expPath(sid, eid)}/status`, { token: owner.token, body: { status } });
const putChanges = (owner: Owner, sid: string, eid: string, vid: string, body: unknown[], envOverride?: Partial<Env>) =>
  call("PUT", `${expPath(sid, eid)}/variants/${vid}/changes`, { token: owner.token, body, envOverride });
const putVariants = (owner: Owner, sid: string, eid: string, body: unknown[], envOverride?: Partial<Env>) =>
  call("PUT", `${expPath(sid, eid)}/variants`, { token: owner.token, body, envOverride });
const VARIANTS = [
  { id: "a", name: "A", weight: 40 },
  { id: "b", name: "B", weight: 60 },
];

async function expectError(res: Response, status: number, error: string, hint?: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = await expectEnvelope(res);
  expect(body.error).toBe(error);
  if (hint !== undefined) expect(body.hint).toBe(hint);
}

async function changeIds(sid: string, eid: string, vid: string): Promise<string[]> {
  const rows = await getDb(env).selectFrom("changes").select("id").where("site_id", "=", sid).where("experiment_id", "=", eid).where("variant_id", "=", vid).orderBy("position").execute();
  return rows.map((r) => r.id);
}

async function variantRows(sid: string, eid: string) {
  return getDb(env).selectFrom("variants").select(["id", "weight"]).where("site_id", "=", sid).where("experiment_id", "=", eid).orderBy("position").execute();
}

/** 結果を記録しないサイト(開始に評価計画の検査が無い)。setupOwner はテストごとに 1 回だけ呼べる */
async function siteFor(): Promise<{ owner: Owner; sid: string }> {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  return { owner, sid };
}

/** 変更 1 件付きのエクスペリエンスを作り、指定の状態にする */
async function experimentIn(ctx: { owner: Owner; sid: string }, status: "draft" | "running" | "paused" | "archived", opts: Record<string, unknown> = {}) {
  const { owner, sid } = ctx;
  const eid = (opts.id as string | undefined) ?? "exp_lock";
  await createExperiment(owner.token, sid, { id: eid, trafficPercentage: 50, ...opts });
  expect((await putChanges(owner, sid, eid, opts.kind === "single" ? "a" : "b", [TEXT_CHANGE()])).status).toBe(200);
  if (status !== "draft") expect((await setStatus(owner, sid, eid, "running")).status).toBe(200);
  if (status === "paused" || status === "archived") expect((await setStatus(owner, sid, eid, status)).status).toBe(200);
  return { owner, sid, eid };
}

describe("開始後のテストの編集の制限(K10)", () => {
  test("traffic_decrease_rejected_for_running_test", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "running");
    // 実行中: 50 → 30 は拒否、行は変わらない
    await expectError(await patchExp(owner, sid, eid, { trafficPercentage: 30 }), 409, "test_setting_locked", TRAFFIC_HINT);
    expect((await experimentRow(sid, eid)).traffic_percentage).toBe(50);
    // ほかの欄と一緒に送っても拒否し、ほかの欄も書かない
    await expectError(await patchExp(owner, sid, eid, { name: "新しい名前", trafficPercentage: 30 }), 409, "test_setting_locked");
    expect((await experimentRow(sid, eid)).name).toBe("Hero");
    // 同じ値は変更ではないので受ける(traffic_same_allowed)
    expect((await patchExp(owner, sid, eid, { trafficPercentage: 50, name: "同じ配信率" })).status).toBe(200);
    // 50 → 80 は受ける(traffic_increase_allowed)
    const up = await patchExp(owner, sid, eid, { trafficPercentage: 80 });
    expect(up.status).toBe(200);
    expect((await json(up)).trafficPercentage).toBe(80);
    expect((await experimentRow(sid, eid)).traffic_percentage).toBe(80);
    // 一時停止中も下げられない
    expect((await setStatus(owner, sid, eid, "paused")).status).toBe(200);
    await expectError(await patchExp(owner, sid, eid, { trafficPercentage: 60 }), 409, "test_setting_locked", TRAFFIC_HINT);
    expect((await experimentRow(sid, eid)).traffic_percentage).toBe(80);
    expect((await patchExp(owner, sid, eid, { trafficPercentage: 90 })).status).toBe(200);
    // 下書きのテストは下げられる
    const draft = await experimentIn(ctx, "draft", { id: "exp_draft" });
    expect((await patchExp(draft.owner, draft.sid, draft.eid, { trafficPercentage: 10 })).status).toBe(200);
    expect((await experimentRow(draft.sid, draft.eid)).traffic_percentage).toBe(10);
  });

  test("persist_assignment_locked_after_start", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "running");
    await expectError(await patchExp(owner, sid, eid, { persistAssignment: true }), 409, "test_setting_locked", PERSIST_HINT);
    expect((await experimentRow(sid, eid)).persist_assignment).toBe(0);
    // 同じ値は受ける
    expect((await patchExp(owner, sid, eid, { persistAssignment: false })).status).toBe(200);
    expect((await setStatus(owner, sid, eid, "paused")).status).toBe(200);
    await expectError(await patchExp(owner, sid, eid, { persistAssignment: true }), 409, "test_setting_locked", PERSIST_HINT);
    expect((await experimentRow(sid, eid)).persist_assignment).toBe(0);
    // true で開始したテストは false にできない
    const on = await experimentIn(ctx, "running", { id: "exp_on", persistAssignment: true });
    await expectError(await patchExp(on.owner, on.sid, on.eid, { persistAssignment: false }), 409, "test_setting_locked", PERSIST_HINT);
    expect((await experimentRow(on.sid, on.eid)).persist_assignment).toBe(1);
    // 下書きは変えられる
    const draft = await experimentIn(ctx, "draft", { id: "exp_draft" });
    expect((await patchExp(draft.owner, draft.sid, draft.eid, { persistAssignment: true })).status).toBe(200);
    expect((await experimentRow(draft.sid, draft.eid)).persist_assignment).toBe(1);
  });

  test("archived_test_is_readonly", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "archived");
    const before = await experimentRow(sid, eid);
    // エクスペリエンスの PATCH(メモ以外の欄。メモと一緒でも)
    await expectError(await patchExp(owner, sid, eid, { name: "新しい名前" }), 409, "experiment_archived_readonly", READONLY_HINT);
    await expectError(await patchExp(owner, sid, eid, { name: "新しい名前", description: "メモ" }), 409, "experiment_archived_readonly", READONLY_HINT);
    await expectError(await patchExp(owner, sid, eid, { trafficPercentage: 100 }), 409, "experiment_archived_readonly", READONLY_HINT);
    await expectError(await patchExp(owner, sid, eid, { analytics: { overrides: { experimentName: "renamed" } } }), 409, "experiment_archived_readonly", READONLY_HINT);
    // パターン・変更・評価計画
    await expectError(await putVariants(owner, sid, eid, VARIANTS), 409, "experiment_archived_readonly", READONLY_HINT);
    await expectError(await putChanges(owner, sid, eid, "b", [TEXT_CHANGE("c_new")]), 409, "experiment_archived_readonly", READONLY_HINT);
    await expectError(await putChanges(owner, sid, eid, "b", []), 409, "experiment_archived_readonly", READONLY_HINT);
    const plan = await call("PUT", `${expPath(sid, eid)}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 21 } } });
    await expectError(plan, 409, "experiment_archived_readonly", READONLY_HINT);
    // 何も書いていない
    const after = await experimentRow(sid, eid);
    expect(after).toEqual(before);
    expect(await changeIds(sid, eid, "b")).toEqual(["c_text"]);
    expect((await variantRows(sid, eid)).map((v) => [v.id, v.weight])).toEqual([["a", 50], ["b", 50]]);
  });

  test("memo_edit_allowed_on_archived_test", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "archived");
    const before = await experimentRow(sid, eid);
    const memo = await patchExp(owner, sid, eid, { description: "購入ボタンの文言で B が勝った" });
    expect(memo.status).toBe(200);
    const memoBody = await json(memo);
    expect(memoBody).toMatchObject({ description: "購入ボタンの文言で B が勝った", updatedAt: before.updated_at, unpublished: false });
    const vmemo = await call("PATCH", `${expPath(sid, eid)}/variants/b`, { token: owner.token, body: { description: "文言を短くした" } });
    expect(vmemo.status).toBe(200);
    expect((await json(vmemo)).description).toBe("文言を短くした");
    const after = await experimentRow(sid, eid);
    expect(after.description).toBe("購入ボタンの文言で B が勝った");
    expect([after.updated_at, after.updated_by]).toEqual([before.updated_at, before.updated_by]);
    const detail = await json(await call("GET", expPath(sid, eid), { token: owner.token }));
    expect(detail.unpublished).toBe(false);
    expect(detail.variants.find((v: { id: string }) => v.id === "b").description).toBe("文言を短くした");
  });

  test("single_remains_editable", async () => {
    const ctx = await siteFor();
    // 実行中のパーソナライズは配信率を下げられ、割当の固定も変えられる
    const run = await experimentIn(ctx, "running", { id: "exp_run", kind: "single" });
    expect((await patchExp(run.owner, run.sid, run.eid, { trafficPercentage: 20, persistAssignment: true })).status).toBe(200);
    expect(await experimentRow(run.sid, run.eid)).toMatchObject({ traffic_percentage: 20, persist_assignment: 1 });
    // 終了したパーソナライズも、設定と変更を保存できる(パターンの集合は今と同じく下書きだけ = experiment_active)
    const done = await experimentIn(ctx, "archived", { id: "exp_done", kind: "single" });
    expect((await patchExp(done.owner, done.sid, done.eid, { name: "名前を変えた" })).status).toBe(200);
    expect((await experimentRow(done.sid, done.eid)).name).toBe("名前を変えた");
    expect((await putChanges(done.owner, done.sid, done.eid, "a", [TEXT_CHANGE("c_after")])).status).toBe(200);
    expect(await changeIds(done.sid, done.eid, "a")).toEqual(["c_after"]);
    await expectError(await putVariants(done.owner, done.sid, done.eid, [{ id: "a", name: "A", weight: 100 }]), 409, "experiment_active");
  });

  test("concurrent_traffic_increases_cannot_decrease_effective_traffic", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "running");
    // 50 を読んだ後、書き込みの直前に別の要求が 80 に上げる。60 への書き込みは配信率を下げることになるので拒否する
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await patchExp(owner, sid, eid, { trafficPercentage: 80 })).status).toBe(200);
    });
    await expectError(await patchExp(owner, sid, eid, { trafficPercentage: 60, name: "割り込まれた" }, { DB: racing }), 409, "test_setting_locked", TRAFFIC_HINT);
    expect(await experimentRow(sid, eid)).toMatchObject({ traffic_percentage: 80, name: "Hero" });
    // 割り込みが無ければ上げられる
    expect((await patchExp(owner, sid, eid, { trafficPercentage: 90 })).status).toBe(200);
  });

  test("draft_patch_racing_start_is_rechecked(読んだ後に開始が割り込む)", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "draft");
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(owner, sid, eid, "running")).status).toBe(200);
    });
    // 下書きとして読んだ後に開始された。下げる・割当の固定を変える PATCH は、開始後の検査に読み直して拒否する
    await expectError(await patchExp(owner, sid, eid, { trafficPercentage: 10, persistAssignment: true }, { DB: racing }), 409, "test_setting_locked", TRAFFIC_HINT);
    expect(await experimentRow(sid, eid)).toMatchObject({ status: "running", traffic_percentage: 50, persist_assignment: 0 });
    const persistRace = await experimentIn(ctx, "draft", { id: "exp_persist_race" });
    const racing2 = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(persistRace.owner, persistRace.sid, persistRace.eid, "running")).status).toBe(200);
    });
    await expectError(await patchExp(persistRace.owner, persistRace.sid, persistRace.eid, { persistAssignment: true }, { DB: racing2 }), 409, "test_setting_locked", PERSIST_HINT);
    expect((await experimentRow(persistRace.sid, persistRace.eid)).persist_assignment).toBe(0);
  });

  test("archive_racing_changes_write_is_rejected", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "running");
    // 実行中として読んだ後、書き込みの直前に終了される。変更は置き換えず(元の c_text が残る)、親の帳簿も進めない
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(owner, sid, eid, "archived")).status).toBe(200);
    });
    await expectError(await putChanges(owner, sid, eid, "b", [TEXT_CHANGE("c_new"), TEXT_CHANGE("c_new2")], { DB: racing }), 409, "experiment_archived_readonly", READONLY_HINT);
    expect(await changeIds(sid, eid, "b")).toEqual(["c_text"]);
    const archived = await experimentRow(sid, eid);
    expect(archived.status).toBe("archived");
    expect(archived.stopped_at).toBe(archived.updated_at); // 帳簿は終了の時刻のまま(変更の保存で進んでいない)
  });

  test("archive_racing_patch_is_rejected(エクスペリエンスの PATCH と終了が競合)", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "running");
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(owner, sid, eid, "archived")).status).toBe(200);
    });
    await expectError(await patchExp(owner, sid, eid, { name: "割り込まれた" }, { DB: racing }), 409, "experiment_archived_readonly", READONLY_HINT);
    const row = await experimentRow(sid, eid);
    expect(row.name).toBe("Hero");
    expect(row.stopped_at).toBe(row.updated_at);
  });

  test("start_racing_variants_write_is_rejected(パターンの全置換と開始が競合)", async () => {
    const ctx = await siteFor();
    const { owner, sid, eid } = await experimentIn(ctx, "draft");
    const before = await experimentRow(sid, eid);
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await setStatus(owner, sid, eid, "running")).status).toBe(200);
    });
    // b を外して c を足す全置換(b の削除・a の更新・c の追加のどれも書かない)
    await expectError(await putVariants(owner, sid, eid, [{ id: "a", name: "A", weight: 60 }, { id: "c", name: "C", weight: 40 }], { DB: racing }), 409, "experiment_active");
    // パターンは開始した時のまま(重み・数とも)。b の変更も残る
    expect((await variantRows(sid, eid)).map((v) => [v.id, v.weight])).toEqual([["a", 50], ["b", 50]]);
    expect(await changeIds(sid, eid, "b")).toEqual(["c_text"]);
    expect((await experimentRow(sid, eid)).updated_at).not.toBe(before.updated_at); // 開始の帳簿だけ
    expect((await experimentRow(sid, eid)).updated_at).toBe((await experimentRow(sid, eid)).last_started_at);
  });
});

describe("目標を参照している実行中のテスト(K10)", () => {
  test("目標の JSON の runningTests に、評価計画で参照している実行中のテストが入る", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    for (const id of ["g_buy", "g_other"])
      expect((await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id, name: id, type: "CUSTOM", config: {} } })).status).toBe(201);
    const byPlan = async (eid: string, name: string, goal: string, opts: Record<string, unknown> = {}) => {
      await createExperiment(owner.token, sid, { id: eid, name, ...opts });
      if (opts.kind !== "single")
        expect((await call("PUT", `${expPath(sid, eid)}/evaluation-plan`, { token: owner.token, body: { plan: { primaryGoalId: goal } } })).status).toBe(200);
    };
    // 評価計画で参照: 実行中・一時停止中は入る。下書き・終了は入らない
    await byPlan("exp_plan_run", "計画・実行中", "g_buy");
    await byPlan("exp_plan_paused", "計画・一時停止中", "g_buy");
    await byPlan("exp_plan_draft", "計画・下書き", "g_buy");
    await byPlan("exp_plan_done", "計画・終了", "g_buy");
    await byPlan("exp_plan_other", "別の目標", "g_other");
    // 配信条件で参照: 実行中のテストは入る。パーソナライズは入らない
    await createExperiment(owner.token, sid, { id: "exp_target_run", name: "配信条件・実行中", targeting: { hist: "converted", goal: "g_buy" } });
    await createExperiment(owner.token, sid, { id: "exp_single_run", name: "パーソナライズ", kind: "single", targeting: { hist: "converted", goal: "g_buy" } });
    // 配信条件と評価計画の両方で参照しても 1 回だけ
    await byPlan("exp_both", "両方", "g_buy", { targeting: { hist: "converted", goal: "g_buy" } });
    // オーディエンスを通した参照(配信条件はオーディエンスを展開した形で届く。設計書 §5.5)
    expect(
      (await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_buyers", name: "購入者", definition: { hist: "converted", goal: "g_buy" } } })).status,
    ).toBe(201);
    await createExperiment(owner.token, sid, { id: "exp_audience_run", name: "オーディエンス・実行中", targeting: { not: { audience: "aud_buyers" } } });
    for (const eid of ["exp_plan_run", "exp_plan_paused", "exp_plan_done", "exp_plan_other", "exp_target_run", "exp_single_run", "exp_both", "exp_audience_run"])
      expect((await setStatus(owner, sid, eid, "running")).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_plan_paused", "paused")).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_plan_done", "archived")).status).toBe(200);

    const expected = [
      { id: "exp_plan_run", name: "計画・実行中" },
      { id: "exp_plan_paused", name: "計画・一時停止中" },
      { id: "exp_target_run", name: "配信条件・実行中" },
      { id: "exp_both", name: "両方" },
      { id: "exp_audience_run", name: "オーディエンス・実行中" },
    ];
    const list = await call("GET", `/sites/${sid}/goals`, { token: owner.token });
    expect(list.status).toBe(200);
    const goals = await json<Array<{ id: string; runningTests: unknown }>>(list);
    expect(goals.find((g) => g.id === "g_buy")!.runningTests).toEqual(expected);
    expect(goals.find((g) => g.id === "g_other")!.runningTests).toEqual([{ id: "exp_plan_other", name: "別の目標" }]);
    // 更新の応答にも入る(管理画面が保存の確認に件数を出す)
    const patched = await call("PATCH", `/sites/${sid}/goals/g_buy`, { token: owner.token, body: { name: "購入" } });
    expect(patched.status).toBe(200);
    expect((await json(patched)).runningTests).toEqual(expected);
    // 作成したばかりの目標は空
    const created = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_new", name: "新しい目標", type: "CUSTOM", config: {} } });
    expect((await json(created)).runningTests).toEqual([]);
  });
});
