import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { rewriteCollectUntil } from "../src/results/collect-until";
import type { DeliveredDefinition } from "../src/results/delivered";
import { apiGuard } from "../src/results/guard";
import {
  call,
  createExperiment,
  experimentRow,
  fakeResultsBudget,
  fakeResultsHealth,
  json,
  RESULTS_STORE,
  setupOwner,
  testEnvWith,
  TEXT_CHANGE,
  type SeedConversion,
  type SeedParticipant,
} from "./helpers";

// D9 plan ③ Task 10: 結果の記録・終了・採用のテストが共有する道具(results-api.test.ts の道具と同じ形)

export type Owner = Awaited<ReturnType<typeof setupOwner>>;
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const db = () => getDb(env as unknown as Env);

/** 結果を記録するサイト(計測用 D1 がある導入で作る = results_enabled 1) */
export async function recordingSite(owner: Owner): Promise<string> {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domains: ["www.example.com"] }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** 目標 g_buy(購入)と g_other(資料請求)をサイトに作る(既にあれば使い回す) */
export async function ensureGoals(owner: Owner, sid: string): Promise<void> {
  for (const [id, name] of [["g_buy", "購入"], ["g_other", "資料請求"]]) {
    const goal = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id, name, type: "CUSTOM", config: {} } });
    expect([201, 409]).toContain(goal.status);
  }
}

/**
 * テストの下書きを作る(既定のパターン a(オリジナル)/ b。b に TEXT の変更)。判定に使う目標 g_buy を選ぶ。
 * opts.bChanges = false なら b に変更を入れない
 */
export async function draftTest(owner: Owner, sid: string, eid: string, plan: Record<string, unknown> = {}, opts: { bChanges?: boolean } = {}): Promise<void> {
  await createExperiment(owner.token, sid, { id: eid });
  if (opts.bChanges !== false) expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(200);
  await ensureGoals(owner, sid);
  expect((await call("PUT", `/sites/${sid}/experiments/${eid}/evaluation-plan`, { token: owner.token, body: { plan: { primaryGoalId: "g_buy", ...plan } } })).status).toBe(200);
}

/** 状態の API(計測用 D1 がある導入)。envOverride で偽の予算の DO などを足す */
export const setStatus = (owner: Owner, sid: string, eid: string, body: Record<string, unknown>, envOverride: Partial<Env> = {}) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body, envOverride: { ...RESULTS_STORE, ...envOverride } });

/** 下書きを作って開始する。戻り値 = run_id */
export async function startTest(owner: Owner, sid: string, eid: string, plan: Record<string, unknown> = {}, opts: { bChanges?: boolean; envOverride?: Partial<Env> } = {}): Promise<string> {
  await draftTest(owner, sid, eid, plan, opts);
  expect((await setStatus(owner, sid, eid, { status: "running" }, opts.envOverride)).status).toBe(200);
  const runId = (await experimentRow(sid, eid)).run_id;
  expect(runId).toMatch(/.+/);
  return runId!;
}

/** 開始の時刻を過去にずらす(started_at と計画の fixed_at を同じ値に)。KV の締め切りもずらした開始で書き直す */
export async function backdate(sid: string, eid: string, startedAt: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("update experiments set started_at = ? where site_id = ? and id = ?").bind(startedAt, sid, eid),
    env.DB.prepare("update evaluation_plans set fixed_at = ? where site_id = ? and experiment_id = ?").bind(startedAt, sid, eid),
  ]);
  await rewriteCollectUntil(testEnvWith({ resultsStore: true }), getDb(env), sid, apiGuard(env));
}

/** 計測用 D1・偽の予算の DO・偽の収集の失敗の記録がある envOverride */
export function resultsOverride(budget = fakeResultsBudget(), health = fakeResultsHealth()): Partial<Env> {
  return { ...RESULTS_STORE, RESULTS_BUDGET: budget.ns, RESULTS_HEALTH: health.ns };
}

export const getResults = (owner: Owner, sid: string, eid: string, envOverride: Partial<Env> = resultsOverride()) =>
  call("GET", `/sites/${sid}/experiments/${eid}/results`, { token: owner.token, envOverride });

/** パターンごとに n 人の参加(exposedAt = from + i × step)。visitor は重ならない番号を振る */
let visitorSeq = 1_000_000;
export function participants(runId: string, sid: string, variantId: string, n: number, from: number, step = MIN, extra: Partial<SeedParticipant> = {}): SeedParticipant[] {
  return Array.from({ length: n }, (_, i) => ({ runId, siteId: sid, visitor: visitorSeq++, variantId, exposedAt: from + i * step, ...extra }));
}
/** 参加の先頭 k 人が goalId で CV(参加の after ms 後) */
export function conversionsOf(ps: SeedParticipant[], goalId: string, k: number, after = 1000): SeedConversion[] {
  return ps.slice(0, k).map((p) => ({ runId: p.runId, goalId, visitor: p.visitor, convertedAt: p.exposedAt! + after }));
}

export const snapshotRows = (sid: string, eid: string) =>
  db().selectFrom("result_snapshots").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).orderBy("kind").execute();
export const adoptionRow = (sid: string, eid: string) => db().selectFrom("adoptions").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirst();

/** 届く定義(b の TEXT の文言だけを変える。text = null なら b に変更なし) */
export const def = (text: string | null): DeliveredDefinition => ({
  variants: [
    { id: "a", changes: [] },
    { id: "b", changes: text === null ? [] : [{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text } }] },
  ],
  urlMatch: { op: "contains", value: "/" },
  targeting: null,
  primaryGoal: { id: "g_buy", config: {} },
});

/** 届く定義の行を置き換える(Publish で作られた行を消してから、配信を確かめた行を直接入れる) */
export async function seedDelivered(
  sid: string,
  eid: string,
  runId: string,
  rows: Array<{ version: number; d: DeliveredDefinition; from: number | null; until?: number | null; settled?: "delivered" | null }>,
): Promise<void> {
  await env.DB.prepare("delete from experiment_delivered_definitions where site_id = ? and experiment_id = ?").bind(sid, eid).run();
  for (const r of rows) {
    await env.DB.prepare(
      `insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash, delivered_from, delivered_until, settled)
       values (?, ?, ?, ?, null, ?, ?, ?, ?, ?)`,
    )
      .bind(sid, eid, runId, r.version, JSON.stringify(r.d), `hash_${r.version}`, r.from, r.until ?? null, r.settled === undefined ? "delivered" : r.settled)
      .run();
  }
}

/** 結果の API の応答(テストが見る分) */
export type Report = {
  phase: string; persisted: boolean; computedAt: number | null; cutoff: number | null; records: string; quality: string; stoppedEarly: boolean;
  evaluation: { minEnd: number; maxEnd: number; evaluationAt: number; reachedAt: number | null } | null;
  plan: { baselineVariantId: string | null } | null;
  variants: Array<{ id: string; name: string; n: number; y: number; diff: { mean: number; relMean: number | null; pAboveDelta: number } | null; state: string | null; applyFailed: number; applyRecovered: number; weight: number }>;
  qualityDetail: { srmP: number | null; mixedRate: number; stopRatio: number; stopPeriods: unknown[]; failedSends: number; failureRatio: number };
  otherGoals: Array<{ goalId: string; name: string }>;
  notes: Array<{ key: string; params?: Record<string, string | number> }>;
  helpKeys: string[];
  adoption: { variantId: string | null; note: string } | null;
  snapshots: { evaluation: boolean; stop: boolean };
  deliveredChanges: Record<string, boolean> | null;
  definition?: DeliveredDefinition | null;
  names?: { experiment: string; variants: Record<string, { name: string; original: boolean }>; goals: Record<string, string> };
};
export const noteKeys = (r: Report) => r.notes.map((n) => n.key);
export const variantOf = (r: Report, id: string) => r.variants.find((v) => v.id === id)!;

/** a 300 人(CV 30)・b 300 人(CV 60)を from から 1 分おきに入れる(b が採用候補になる量) */
export function seedWinner(runId: string, sid: string, from: number) {
  const a = participants(runId, sid, "a", 300, from);
  const b = participants(runId, sid, "b", 300, from);
  return { participants: [...a, ...b], conversions: [...conversionsOf(a, "g_buy", 30), ...conversionsOf(b, "g_buy", 60)] };
}
