import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { apiGuard, WriteFrozen } from "../src/results/guard";
import { purgeRun, PURGE_READ_ROWS_PER_ROW } from "../src/results/purge";
import { openRead } from "../src/results/read-session";
import {
  beforeD1Batch,
  call,
  choosePrimaryGoal,
  createExperiment,
  experimentRow,
  expectEnvelope,
  fakeDeployer,
  fakeResultsBudget,
  json,
  publishRes,
  RESULTS_STORE,
  seedResults,
  setupOwner,
  siteRow,
  testEnv,
  TEXT_CHANGE,
  type SeedConversion,
  type SeedParticipant,
} from "./helpers";

// D9 plan ③ Task 4(K5・K6・K12・K13・K24): 計測用 D1 の binding・削除の queue と forget・開始の CAS

const NOW = Date.parse("2026-10-19T10:00:00Z");
type Owner = Awaited<ReturnType<typeof setupOwner>>;

/** 結果を記録する Site(計測用 D1 がある導入で作る = results_enabled 1) */
async function recordingSite(owner: Owner, workspaceId = owner.workspaceId): Promise<string> {
  const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  const { id } = await json<{ id: string }>(res);
  expect((await siteRow(id)).results_enabled).toBe(1);
  return id;
}

const setStatus = (token: string, sid: string, eid: string, status: string, envOverride: Partial<Env> = RESULTS_STORE) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride });

/** 開始(run_id を振る)→ 必要なら終了。戻り値 = run_id */
async function startedTest(owner: Owner, sid: string, eid: string, opts: { archive?: boolean } = {}): Promise<string> {
  await createExperiment(owner.token, sid, { id: eid });
  await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  await choosePrimaryGoal(owner.token, sid, eid); // 結果を記録する開始は判定に使う目標が要る(D9 ③ Task 5)
  expect((await setStatus(owner.token, sid, eid, "running")).status).toBe(200);
  const runId = (await experimentRow(sid, eid)).run_id;
  expect(runId).toMatch(/.+/);
  if (opts.archive) expect((await setStatus(owner.token, sid, eid, "archived")).status).toBe(200);
  return runId!;
}

/** run の個票(参加 n 人、目標ごとに CV n 件) */
function rowsFor(runId: string, siteId: string, n: number, goals: string[] = ["g1"], offset = 0): { participants: SeedParticipant[]; conversions: SeedConversion[] } {
  const participants: SeedParticipant[] = [];
  const conversions: SeedConversion[] = [];
  for (let i = 0; i < n; i++) {
    participants.push({ runId, siteId, visitor: offset + i });
    for (const goalId of goals) conversions.push({ runId, goalId, visitor: offset + i });
  }
  return { participants, conversions };
}

async function countRows(runId: string): Promise<{ participants: number; conversions: number }> {
  const db = env.RESULTS_DB!;
  const p = await db.prepare("SELECT count(*) AS n FROM participants WHERE run_id = ?").bind(runId).first<{ n: number }>();
  const c = await db.prepare("SELECT count(*) AS n FROM conversions WHERE run_id = ?").bind(runId).first<{ n: number }>();
  return { participants: p!.n, conversions: c!.n };
}

const queueRows = () => getDb(env).selectFrom("results_purge_queue").selectAll().orderBy("run_id").execute();

/** 公開した config の results(publishes.config_json から読む) */
async function publishedResults(token: string, sid: string): Promise<unknown> {
  const res = await publishRes(token, sid, RESULTS_STORE);
  expect(res.status).toBe(200);
  const { ok, version } = await json<{ ok: boolean; version: number }>(res);
  expect(ok).toBe(true);
  const row = await getDb(env).selectFrom("publishes").select("config_json").where("site_id", "=", sid).where("version", "=", version).executeTakeFirstOrThrow();
  return (JSON.parse(row.config_json!) as { results?: unknown }).results;
}

/** 計測用 D1 と偽の予算の DO がある env(purgeRun を直接呼ぶ用) */
const purgeEnv = (budget: ReturnType<typeof fakeResultsBudget>, o: Partial<Env> = {}): Env => ({ ...testEnv, ...RESULTS_STORE, RESULTS_BUDGET: budget.ns, ...o }) as Env;

/** 計測用 D1 の batch の結果を控える(DELETE の行数と、予算の DO の呼び出しとの順を見る) */
function recordingResultsDb(log: string[]): D1Database {
  const db = env.RESULTS_DB!;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const out = await target.batch(stmts);
          for (const r of out) log.push(`d1:changes=${r.meta.changes}:written=${r.meta.rows_written}`);
          return out;
        };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

describe("results purge queue and forget (D9 ③ K6・K12)", () => {
  test("forget_continues_after_deleting_recorded_experiment", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_rec", { archive: true });
    await seedResults(rowsFor(runId, sid, 30));
    // 予算の DO が無い導入(waitUntil の削除は始まらない)で削除 → queue に残る
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_rec`, { token: owner.token, envOverride: RESULTS_STORE })).status).toBe(204);
    expect(await queueRows()).toEqual([expect.objectContaining({ site_id: sid, run_id: runId, reason: "experiment_deleted" })]);
    // run_id を持つエクスペリエンスはもう無いが、queue に行がある間は forget を出し続ける
    expect(await publishedResults(owner.token, sid)).toEqual({ forget: true, runs: {} });
    // 消し終えると queue が空になり、次の Publish で results が消える
    const budget = fakeResultsBudget();
    expect(await purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).toEqual({ done: true, rowsWritten: 60 });
    expect(await countRows(runId)).toEqual({ participants: 0, conversions: 0 });
    expect(await queueRows()).toEqual([]);
    expect(await publishedResults(owner.token, sid)).toBeUndefined();
  });

  test("削除の batch で queue に積み、waitUntil で 1 回消し始める(枠が無い日は消さずに残す)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runA = await startedTest(owner, sid, "exp_a", { archive: true });
    const runB = await startedTest(owner, sid, "exp_b", { archive: true });
    const runC = await startedTest(owner, sid, "exp_c", { archive: true });
    await seedResults(rowsFor(runA, sid, 20));
    await seedResults(rowsFor(runB, sid, 20));
    await seedResults(rowsFor(runC, sid, 20));

    // 枠がある: 応答の後の waitUntil で消し終え、queue の行も消える(lease は 1 回)
    const ok = fakeResultsBudget();
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_a`, { token: owner.token, envOverride: { ...RESULTS_STORE, RESULTS_BUDGET: ok.ns } })).status).toBe(204);
    expect(await countRows(runA)).toEqual({ participants: 0, conversions: 0 });
    expect(ok.calls.filter((c) => c.method === "lease")).toHaveLength(1);
    expect((await queueRows()).map((q) => q.run_id)).not.toContain(runA);

    // その日の枠が尽きている: 消さず(lease も呼ばず)queue に残す
    const exhausted = fakeResultsBudget({ writeBudget: 1_000, writeUsed: 1_000 });
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_b`, { token: owner.token, envOverride: { ...RESULTS_STORE, RESULTS_BUDGET: exhausted.ns } })).status).toBe(204);
    expect(await countRows(runB)).toEqual({ participants: 20, conversions: 20 });
    expect(exhausted.calls.filter((c) => c.method === "lease")).toHaveLength(0);
    expect((await queueRows()).map((q) => q.run_id)).toContain(runB);

    // 停止中(K18: waitUntil の削除も停止中なら消さずに残す)
    const stopped = fakeResultsBudget({ stoppedUntil: Date.now() + 3_600_000 });
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_c`, { token: owner.token, envOverride: { ...RESULTS_STORE, RESULTS_BUDGET: stopped.ns } })).status).toBe(204);
    expect(await countRows(runC)).toEqual({ participants: 20, conversions: 20 });
    expect((await queueRows()).map((q) => q.run_id)).toContain(runC);
  });

  test("site_delete_purges_results_rows", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const other = await recordingSite(owner);
    const run1 = await startedTest(owner, sid, "exp_1", { archive: true });
    const run2 = await startedTest(owner, sid, "exp_2", { archive: true });
    const runOther = await startedTest(owner, other, "exp_o", { archive: true });
    await createExperiment(owner.token, sid, { id: "exp_draft" }); // run_id の無い下書きは積まない
    await seedResults(rowsFor(run1, sid, 15, ["g1", "g2"]));
    await seedResults(rowsFor(run2, sid, 10));
    await seedResults(rowsFor(runOther, other, 12));

    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token, envOverride: RESULTS_STORE })).status).toBe(204);
    const q = await queueRows();
    expect(q.map((r) => [r.site_id, r.run_id, r.reason]).sort()).toEqual([[sid, run1, "site_deleted"], [sid, run2, "site_deleted"]].sort());

    const budget = fakeResultsBudget();
    for (const r of q) expect((await purgeRun(purgeEnv(budget), sid, r.run_id, 10_000, NOW, apiGuard(purgeEnv(budget)))).done).toBe(true);
    expect(await countRows(run1)).toEqual({ participants: 0, conversions: 0 });
    expect(await countRows(run2)).toEqual({ participants: 0, conversions: 0 });
    const left = await env.RESULTS_DB!.prepare("SELECT count(*) AS n FROM participants WHERE site_id = ?").bind(sid).first<{ n: number }>();
    expect(left!.n).toBe(0);
    // ほかの Site の個票は残る
    expect(await countRows(runOther)).toEqual({ participants: 12, conversions: 12 });
    expect(await queueRows()).toEqual([]);
  });

  test("Workspace の削除でもその Site の run を積む", async () => {
    const owner = await setupOwner();
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const sid = await recordingSite(owner, second.id);
    const runId = await startedTest(owner, sid, "exp_ws", { archive: true });
    await seedResults(rowsFor(runId, sid, 8));
    expect((await call("DELETE", `/workspaces/${second.id}`, { token: owner.token, envOverride: RESULTS_STORE })).status).toBe(204);
    expect(await queueRows()).toEqual([expect.objectContaining({ site_id: sid, run_id: runId, reason: "workspace_deleted" })]);
    const budget = fakeResultsBudget();
    expect(await purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).toEqual({ done: true, rowsWritten: 16 });
    expect(await countRows(runId)).toEqual({ participants: 0, conversions: 0 });
    expect(await queueRows()).toEqual([]);
  });

  test("purgeRun は site_deleted の行で Site がまだ残っていれば個票を消さず queue の行だけを消す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_keep", { archive: true });
    await seedResults(rowsFor(runId, sid, 5));
    await getDb(env).insertInto("results_purge_queue").values({ site_id: sid, run_id: runId, reason: "site_deleted", enqueued_at: NOW }).execute();
    const budget = fakeResultsBudget();
    expect(await purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).toEqual({ done: true, rowsWritten: 0 });
    expect(await countRows(runId)).toEqual({ participants: 5, conversions: 5 });
    expect(await queueRows()).toEqual([]);
    expect(budget.calls.filter((c) => c.method === "lease")).toHaveLength(0);
    expect((await experimentRow(sid, "exp_keep")).results_purged_at).toBeNull();
  });

  // B155(G26 (d)): 判定は「その run がまだ Site のエクスペリエンスにあるか」。同じ ID で作り直したサイトは同じ run_id を持たない
  test("site_deleted_queue_survives_recreate_with_same_id", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_re", { archive: true });
    await seedResults(rowsFor(runId, sid, 6));
    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token, envOverride: RESULTS_STORE })).status).toBe(204);
    expect((await queueRows()).map((r) => [r.site_id, r.run_id, r.reason])).toEqual([[sid, runId, "site_deleted"]]);
    // 同じ WS で同じ ID を作り直す(別の WS からは退役の 409。同じ WS からは作れる)
    const again = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: sid, name: "Again", domain: "again.example.com" }, envOverride: RESULTS_STORE });
    expect(again.status).toBe(201);
    const budget = fakeResultsBudget();
    expect(await purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).toEqual({ done: true, rowsWritten: 12 });
    expect(await countRows(runId)).toEqual({ participants: 0, conversions: 0 });
    expect(await queueRows()).toEqual([]);
  });

  test("消し終えたらエクスペリエンスが残っていれば results_purged_at を入れる(期限の削除の形)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_ret", { archive: true });
    await seedResults(rowsFor(runId, sid, 7));
    const budget = fakeResultsBudget();
    expect(await purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).toEqual({ done: true, rowsWritten: 14 });
    expect((await experimentRow(sid, "exp_ret")).results_purged_at).toBe(NOW);
    // 個票を消した後は forget も出さない
    expect(await publishedResults(owner.token, sid)).toBeUndefined();
  });

  test("purgeRun は凍結中なら wtt-control に書かない(guard が WriteFrozen を投げる)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_frz", { archive: true });
    await seedResults(rowsFor(runId, sid, 3));
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
    const budget = fakeResultsBudget();
    await expect(purgeRun(purgeEnv(budget), sid, runId, 10_000, NOW, apiGuard(purgeEnv(budget)))).rejects.toBeInstanceOf(WriteFrozen);
    expect((await experimentRow(sid, "exp_frz")).results_purged_at).toBeNull();
  });

  test("開始の CAS: 要求の間に Site の results_enabled が変わったら 409 invalid_transition で run_id を振らない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await createExperiment(owner.token, sid, { id: "exp_cas" });
    await call("PUT", `/sites/${sid}/experiments/exp_cas/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await choosePrimaryGoal(owner.token, sid, "exp_cas");
    // 開始の batch(状態の CAS と計画の固定。D9 ③ Task 5)の直前に、別の要求が Site の結果の記録を無効にした
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("update sites set results_enabled = 0 where id = ?").bind(sid).run();
    });
    const res = await setStatus(owner.token, sid, "exp_cas", "running", { ...RESULTS_STORE, DB: racing });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("invalid_transition");
    expect(body.hint).toBe("状態かサイト設定が変わりました。画面を読み込み直してください");
    const row = await experimentRow(sid, "exp_cas");
    expect(row.status).toBe("draft");
    expect(row.run_id).toBeNull();
    // 読み直してからの開始は、今の設定(記録しない)で通る
    const again = await setStatus(owner.token, sid, "exp_cas", "running");
    expect(again.status).toBe(200);
    expect((await experimentRow(sid, "exp_cas")).run_id).toBeNull();
  });

  test("下書きに run_id がある(作為的に入れた)とき、結果を記録しない警告を出さない", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await createExperiment(owner.token, sid, { id: "exp_pre" });
    await call("PUT", `/sites/${sid}/experiments/exp_pre/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await env.DB.prepare("update experiments set run_id = 'run_preset' where site_id = ? and id = 'exp_pre'").bind(sid).run();
    const res = await setStatus(owner.token, sid, "exp_pre", "running");
    expect(res.status).toBe(200);
    expect((await json<{ warnings: unknown[] }>(res)).warnings).toEqual([]);
    expect((await experimentRow(sid, "exp_pre")).run_id).toBe("run_preset");
  });

  test("purgeRun は 1 回の DELETE を 2,000 行までにし、lease の行数を書き込みの前に受け取る", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_big", { archive: true });
    await seedResults(rowsFor(runId, sid, 4_500));
    const log: string[] = [];
    const budget = fakeResultsBudget({ log });
    const e = purgeEnv(budget, { RESULTS_DB: recordingResultsDb(log) });
    const r = await purgeRun(e, sid, runId, 100_000, NOW, apiGuard(e));
    expect(r).toEqual({ done: true, rowsWritten: 9_000 });
    expect(await countRows(runId)).toEqual({ participants: 0, conversions: 0 });
    // DELETE(行数 > 0 の batch)ごとに、その前に lease があり、DELETE の行数の合計はその lease の行数以下
    let granted = 0;
    let deletes = 0;
    for (const line of log) {
      const lease = /^lease:\[.*?,(\d+),.*\]->\{"ok":true,"day":".*?","rows":(\d+)\}$/.exec(line);
      if (lease) {
        expect(Number(lease[1])).toBeLessThanOrEqual(2_000);
        granted = Number(lease[2]);
        continue;
      }
      const d1 = /^d1:changes=(\d+):written=(\d+)$/.exec(line);
      if (d1 && Number(d1[1]) > 0) {
        deletes++;
        expect(Number(d1[1])).toBeLessThanOrEqual(2_000);
        expect(Number(d1[2])).toBeLessThanOrEqual(granted);
        granted -= Number(d1[2]);
      }
    }
    expect(deletes).toBeGreaterThanOrEqual(5);
    // 読み取りも予約して精算する(DELETE の見込みは消す行数 × 倍率)
    const reserves = budget.calls.filter((c) => c.method === "reserveRead");
    const settles = budget.calls.filter((c) => c.method === "settleRead");
    expect(reserves.length).toBeGreaterThan(0);
    expect(settles).toHaveLength(reserves.length);
    expect((reserves[0]!.args[1] as number)).toBeGreaterThanOrEqual(2_000 * PURGE_READ_ROWS_PER_ROW);
  });

  test("purge_conversions_respects_grant_with_multiple_goals", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_goals", { archive: true });
    // 参加は少なく(50 人)、CV は 2,000 人 × 3 目標。1 回の枠(2,000 行)の大半が CV の DELETE に回る
    const cv = rowsFor(runId, sid, 2_000, ["g1", "g2", "g3"]);
    await seedResults({ participants: cv.participants.slice(0, 50), conversions: cv.conversions });
    const before = await countRows(runId);
    expect(before).toEqual({ participants: 50, conversions: 6_000 });
    const budget = fakeResultsBudget();
    const r = await purgeRun(purgeEnv(budget), sid, runId, 2_000, NOW, apiGuard(purgeEnv(budget)));
    const after = await countRows(runId);
    const leases = budget.calls.filter((c) => c.method === "lease");
    expect(leases).toHaveLength(1);
    const grant = (leases[0]!.result as { rows: number }).rows;
    expect(grant).toBe(2_000);
    // 参加を消した余り(1,950 行)の範囲だけ CV を消す。訪問者ごとに消す形(3 目標分 = 枠の 3 倍)にはならない
    expect(after.participants).toBe(0);
    const removedCv = before.conversions - after.conversions;
    expect(removedCv).toBeGreaterThan(0);
    expect(removedCv).toBeLessThanOrEqual(grant - before.participants);
    expect(after.conversions).toBe(6_000 - removedCv);
    expect(r.done).toBe(false);
    expect(r.rowsWritten).toBe(before.participants + removedCv);
    expect(r.rowsWritten).toBeLessThanOrEqual(grant);
  });

  test("purge_uses_partial_lease_rows", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startedTest(owner, sid, "exp_part", { archive: true });
    await seedResults(rowsFor(runId, sid, 3_000));
    // その日の残りが 1,000 行: 求めるのは「残り − 1」以下(残りすべてを受け取って書き込みの停止を立てない)
    const tight = fakeResultsBudget({ writeBudget: 10_000, writeUsed: 9_000 });
    const r1 = await purgeRun(purgeEnv(tight), sid, runId, 2_000, NOW, apiGuard(purgeEnv(tight)));
    expect(r1.rowsWritten).toBeGreaterThan(0);
    expect(r1.rowsWritten).toBeLessThanOrEqual(1_000);
    for (const c of tight.calls.filter((x) => x.method === "lease")) expect(c.args[1] as number).toBeLessThanOrEqual(999);
    expect(tight.state.stoppedUntil).toBeNull();
    // status の後に edge が枠を使い、lease が求めた 2,000 行のうち 1,000 行だけを返す: 受け取った行数までだけ消す
    const partial = fakeResultsBudget({ grantAtMost: 1_000 });
    const before = await countRows(runId);
    const r2 = await purgeRun(purgeEnv(partial), sid, runId, 2_000, NOW, apiGuard(purgeEnv(partial)));
    const after = await countRows(runId);
    const removed = before.participants + before.conversions - after.participants - after.conversions;
    expect(partial.calls.filter((x) => x.method === "lease").map((c) => c.args[1])).toContain(2_000);
    expect(removed).toBe(r2.rowsWritten);
    expect(removed).toBeLessThanOrEqual(2_000);
    const leased = partial.calls.filter((c) => c.method === "lease").reduce((n, c) => n + ((c.result as { ok: boolean; rows?: number }).rows ?? 0), 0);
    expect(removed).toBeLessThanOrEqual(leased);
  });

  test("site_delete_conflict_does_not_enqueue_purge", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startedTest(owner, sid, "exp_sc", { archive: true });
    // 削除の印を立てた後・D1 の削除の前に「配信ファイルを作り直す」が印を消した
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("update sites set static_removing = null where id = ?").bind(sid).run();
    });
    const res = await call("DELETE", `/sites/${sid}`, { token: owner.token, envOverride: { ...RESULTS_STORE, DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("static_remove_conflict");
    expect(await queueRows()).toEqual([]);
    expect((await siteRow(sid)).id).toBe(sid);
  });

  test("last_workspace_conflict_does_not_enqueue_purge", async () => {
    const owner = await setupOwner();
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const sid = await recordingSite(owner, second.id);
    await startedTest(owner, sid, "exp_lw", { archive: true });
    // 最後の 1 つかの確かめの後・削除の前に、もう 1 つのワークスペースが消えた(同時の削除)
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("delete from organization where id = ?").bind(owner.workspaceId).run();
    });
    const res = await call("DELETE", `/workspaces/${second.id}`, { token: owner.token, envOverride: { ...RESULTS_STORE, DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("last_workspace");
    expect(await queueRows()).toEqual([]);
    expect((await siteRow(sid)).id).toBe(sid);
  });

  test("experiment_started_between_read_and_delete_is_not_deleted", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await createExperiment(owner.token, sid, { id: "exp_race" });
    // 削除の要求が下書きとして読んだ後・削除の batch の前に、別の要求が開始した(run_id も振られた)
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("update experiments set status = 'running', started_at = ?, run_id = 'run_race' where site_id = ? and id = 'exp_race'").bind(Date.now(), sid).run();
    });
    const res = await call("DELETE", `/sites/${sid}/experiments/exp_race`, { token: owner.token, envOverride: { ...RESULTS_STORE, DB: racing } });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("experiment_active");
    const row = await experimentRow(sid, "exp_race");
    expect(row.status).toBe("running");
    expect(row.run_id).toBe("run_race");
    expect(await queueRows()).toEqual([]);
    expect(await getDb(env).selectFrom("retired_experiment_ids").selectAll().execute()).toEqual([]);
  });
});

describe("read session and write guard (D9 ③ K13・K24)", () => {
  test("close は何度呼んでも settleRead を 1 回だけ呼び、rows_read は batch の合計", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await seedResults(rowsFor("run_read", sid, 40));
    const budget = fakeResultsBudget();
    const e = purgeEnv(budget);
    const s = await openRead(e, "2026-10-19", 500, NOW);
    if ("refused" in s) throw new Error("refused");
    const db = env.RESULTS_DB!;
    const [a] = await s.batch([db.prepare("SELECT count(*) AS n FROM participants WHERE run_id = ?").bind("run_read")]);
    const [b, c] = await s.batch([db.prepare("SELECT * FROM conversions WHERE run_id = ?").bind("run_read"), db.prepare("SELECT 1")]);
    const total = a!.meta.rows_read + b!.meta.rows_read + c!.meta.rows_read;
    expect(total).toBeGreaterThan(0);
    // 2 回目の予約は busy(導入全体で 1 つ)
    expect(await openRead(e, "2026-10-19", 10, NOW)).toEqual({ refused: "busy" });
    await Promise.all([s.close(), s.close()]);
    await s.close();
    const settles = budget.calls.filter((x) => x.method === "settleRead");
    expect(settles).toHaveLength(1);
    expect(settles[0]!.args[1]).toBe(total);
    // 精算の後は次の予約が通る。予算が足りなければ budget
    const next = await openRead(e, "2026-10-19", 10, NOW);
    expect("refused" in next).toBe(false);
    if (!("refused" in next)) await next.close();
    expect(await openRead(purgeEnv(fakeResultsBudget({ readBudget: 100, readUsed: 95 })), "2026-10-19", 10, NOW)).toEqual({ refused: "budget" });
  });

  test("apiGuard は凍結中なら WriteFrozen を投げ、凍結していなければ通す", async () => {
    await expect(apiGuard(testEnv)()).resolves.toBeUndefined();
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
    await expect(apiGuard(testEnv)()).rejects.toBeInstanceOf(WriteFrozen);
  });
});

describe("static deploy requests (D9 ③ K14 の土台)", () => {
  test("requestStaticDeploy は世代とその出し直しで焼いた版を static_deploy_requests に残す", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await createExperiment(owner.token, sid, { id: "exp_sd" });
    await call("PUT", `/sites/${sid}/experiments/exp_sd/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await choosePrimaryGoal(owner.token, sid, "exp_sd");
    const deployer = fakeDeployer();
    const res = await setStatus(owner.token, sid, "exp_sd", "running", { ...RESULTS_STORE, DEPLOYER: deployer });
    expect(res.status).toBe(200);
    const { publish } = await json<{ publish: { version: number } }>(res);
    const site = await siteRow(sid);
    const rows = await getDb(env).selectFrom("static_deploy_requests").selectAll().where("site_id", "=", sid).execute();
    expect(rows).toEqual([expect.objectContaining({ site_id: sid, epoch: Math.max(site.created_at, site.static_epoch), seq: deployer.deploys[0]!.generation.seq, version: publish.version })]);
    // 出し直しの依頼が無い(binding が無い)ときは残さない
    expect((await publishRes(owner.token, sid, RESULTS_STORE)).status).toBe(200);
    expect(await getDb(env).selectFrom("static_deploy_requests").selectAll().where("site_id", "=", sid).execute()).toHaveLength(1);
  });
});
