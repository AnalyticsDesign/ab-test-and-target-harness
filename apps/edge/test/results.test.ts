import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import {
  generateVisitorId,
  kvKeys,
  nextUtcMidnight,
  parseSiteSettings,
  pickVariant,
  type ConversionBody,
  type Experiment,
  type ParticipantBody,
  type ResultsEventResponse,
  type SiteSettings,
} from "@wtt/core";
import app from "../src/index";
import { forgetResults, handleResultsEvent, visitorKey } from "../src/results";
import { recordGoalConversion } from "../src/goal-conversion";
import { PROFILE_KEY, profileStub } from "../src/profile";
import { budgetStub } from "../src/results-budget";
import { healthBuffer, healthStub, hourOf, resetHealthBufferForTest } from "../src/results-health";
import { leaseHolder, resetLeaseHolderForTest } from "../src/results-lease";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

// D9 ② Task 6: 結果の参加・CV の受信(設計書 §6.4・K8・K10・K11)。
// 予算の DO は本物(vitest.config.ts の予算 1000 行/日)を使う。DO と D1 の中身は同じファイルのテストの間で残るので、
// テストごとに別の UTC の日(`day(n)`)で書き(枠・停止を取り合わない)、D1 の行は beforeEach で消す。
// 予算の DO に届かない・D1 の失敗は、env の binding を偽物に差し替えて作る
const SITE = "site_r";
const ORIGIN = "https://site.example";
const HOUR = 3_600_000;
const RUN_A = "a".repeat(22);
const RUN_B = "b".repeat(22);
const RUN_P = "p".repeat(22); // 一時停止中のテスト(results.runs にはあるが experiments[] に無い)
const RUN_X = "x".repeat(22); // どの config にも無い run
/** テストごとに別の UTC の日の正午(2026-11-n 12:00 UTC) */
const day = (n: number): number => Date.UTC(2026, 10, n, 12);

const variants = (wA: number) => [
  { id: "vA", weight: wA, changes: [] },
  { id: "vB", weight: 100 - wA, changes: [] },
];
const expA: Experiment = { id: "exp_a", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] }, trafficPercentage: 100, persistAssignment: false, variants: variants(50) };
const expB: Experiment = { ...expA, id: "exp_b" };
const expS: Experiment = { ...expA, id: "exp_s" }; // パーソナライズ(results.runs に載らない)
const config = (version: number, experiments: Experiment[] = [expA, expB, expS]) => ({
  schemaVersion: 3, version, siteId: SITE, siteSalt: "salt", needsProfile: true, prehide: {}, exposureSelectors: {}, patterns: {},
  goals: [{ id: "g_buy", type: "CUSTOM", config: {} }],
  experiments,
  results: { forget: true, runs: { exp_a: RUN_A, exp_b: RUN_B, exp_p: RUN_P } },
});
const settings = (extra: Record<string, unknown> = {}): SiteSettings =>
  parseSiteSettings({ settingsVersion: 1, siteId: SITE, allowedOrigins: [ORIGIN], ...extra })!;

const participant = (runId: string, variantId: string, extra: Partial<ParticipantBody> = {}): ParticipantBody =>
  ({ type: "participant", v: 1, runId, variantId, device: "desktop", applied: "ok", ...extra }) as ParticipantBody;
const conversion = (runIds: string[], goalId = "g_buy"): ConversionBody => ({ type: "conversion", v: 1, goalId, runIds });
/** 訪問者に割り当たるパターンと、割り当たらないパターン */
const assigned = (exp: Experiment, vid: string) => pickVariant(exp, vid);
const otherThan = (exp: Experiment, vid: string) => (pickVariant(exp, vid) === "vA" ? "vB" : "vA");

async function call(
  body: ParticipantBody | ConversionBody,
  opts: { now: number; vid: string; settings?: SiteSettings; envOverride?: Partial<Env> },
): Promise<ResultsEventResponse> {
  const ctx = createExecutionContext();
  const out = await handleResultsEvent({ ...env, ...opts.envOverride }, ctx, SITE, opts.settings ?? settings(), body, opts.vid, opts.now);
  await waitOnExecutionContext(ctx); // waitUntil に回した失敗の記録・停止を済ませる
  return out;
}
async function send(path: string, body: unknown, envOverride: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://edge.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(body) }),
    { ...env, DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const db = () => env.RESULTS_DB!;
const rows = (table: string) => db().prepare(`SELECT * FROM ${table} ORDER BY run_id`).all<Record<string, unknown>>().then((r) => r.results);
const bytes = (v: unknown): Uint8Array => new Uint8Array(v as ArrayBuffer | number[]);
/** その時の失敗の回数。HealthBuffer が 1 分の間隔で送らずに持っている分も先に DO へ送ってから読む */
const failedCount = async (runId: string, now: number): Promise<number> => {
  await healthBuffer().flushIfDue(env, now + 60_000);
  return (await healthStub(env, SITE).read(runId, hourOf(now), hourOf(now) + HOUR)).reduce((a, r) => a + r.failed, 0);
};
/** 偽物の予算の DO の namespace(LeaseHolder は最初に渡された env の binding を使う) */
const fakeBudgetNs = (stub: Record<string, unknown>): Env["RESULTS_BUDGET"] =>
  ({ idFromName: () => ({}) as DurableObjectId, get: () => stub }) as unknown as Env["RESULTS_BUDGET"];
/** batch だけを差し替えた D1(prepare は本物) */
const failingDb = (message: string): D1Database =>
  ({ prepare: (sql: string) => db().prepare(sql), batch: async () => { throw new Error(message); } }) as unknown as D1Database;

beforeAll(async () => {
  await applyD1Migrations(db(), env.TEST_RESULTS_MIGRATIONS);
});
beforeEach(async () => {
  __resetEdgeCaches();
  resetLeaseHolderForTest(); // isolate の枠を作り直す(前のテストの env の binding を持ち越さない)
  resetHealthBufferForTest();
  await db().batch([db().prepare("DELETE FROM participants"), db().prepare("DELETE FROM conversions")]);
  await env.CONFIG_KV.put(kvKeys.settings(SITE), JSON.stringify({ settingsVersion: 1, siteId: SITE, allowedOrigins: [ORIGIN] }));
  await env.CONFIG_KV.put(kvKeys.active(SITE), "1");
  await env.CONFIG_KV.put(kvKeys.config(SITE, 1), JSON.stringify(config(1)));
});

describe("results events (D9 ② 設計書 §6.4)", () => {
  it("stores the first participant and returns stored", async () => {
    const vid = generateVisitorId();
    const res = await send(`/v1/sites/${SITE}/event`, { ...participant(RUN_A, assigned(expA, vid)), visitorId: vid });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ result: "stored" });
    const ps = await rows("participants");
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ run_id: RUN_A, site_id: SITE, variant_id: assigned(expA, vid), device: "desktop", applied: "ok", mixed: 0 });
    expect(bytes(ps[0]!.visitor_key)).toHaveLength(16);
  });

  it("visitor_key_does_not_contain_raw_visitor_id", async () => {
    const vid = generateVisitorId();
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now: day(1), vid })).toEqual({ result: "stored" });
    const stored = bytes((await rows("participants"))[0]!.visitor_key);
    const raw = new TextEncoder().encode(vid);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(stored)).not.toContain(hex(raw.subarray(0, 8))); // 訪問者 ID の UTF-8 を含まない
    // HMAC-SHA-256(RESULTS_VISITOR_KEY, siteId + ":" + visitorId) の先頭 16 バイトと一致する
    const keyBytes = Uint8Array.from(atob(env.RESULTS_VISITOR_KEY!), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${SITE}:${vid}`)));
    expect([...stored]).toEqual([...mac.subarray(0, 16)]);
    expect([...(await visitorKey(env, SITE, vid))!]).toEqual([...mac.subarray(0, 16)]);
  });

  it("mixed is recorded once for a different variant", async () => {
    // 割り当ての照合を通る「違うパターン」は、重みが変わった config でしか作れない(本番ではテストの開始後に重みを変えられない)。
    // 1 回目は vA 100%、その後 vB 100% の config にして vB を 2 回送る
    const vid = generateVisitorId();
    await env.CONFIG_KV.put(kvKeys.config(SITE, 1), JSON.stringify(config(1, [{ ...expA, variants: variants(100) }, expB])));
    __resetEdgeCaches();
    expect(await call(participant(RUN_A, "vA"), { now: day(2), vid })).toEqual({ result: "stored" });
    await env.CONFIG_KV.put(kvKeys.config(SITE, 2), JSON.stringify(config(2, [{ ...expA, variants: variants(0) }, expB])));
    await env.CONFIG_KV.put(kvKeys.active(SITE), "2");
    __resetEdgeCaches();
    expect(await call(participant(RUN_A, "vB"), { now: day(2) + 1000, vid })).toEqual({ result: "stored" });
    expect(await call(participant(RUN_A, "vB"), { now: day(2) + 2000, vid })).toEqual({ result: "stored" });
    const ps = await rows("participants");
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ variant_id: "vA", exposed_at: day(2), mixed: 1, mixed_at: day(2) + 1000 });
  });

  it("failed_later and recovered update the participant row with edge time", async () => {
    const vid = generateVisitorId();
    const now = day(16);
    const v = assigned(expA, vid);
    const later = (applied: "failed_later" | "recovered"): ParticipantBody => ({ type: "participant", v: 1, runId: RUN_A, variantId: v, applied });
    expect(await call(participant(RUN_A, v), { now, vid })).toEqual({ result: "stored" });
    // 適用できていた人が後から失敗 → failed、その後の回復 → recovered
    expect(await call(later("failed_later"), { now: now + 1, vid })).toEqual({ result: "stored" });
    expect((await rows("participants"))[0]).toMatchObject({ applied: "failed", failed_at: now + 1, recovered_at: null });
    expect(await call(later("recovered"), { now: now + 2, vid })).toEqual({ result: "stored" });
    expect((await rows("participants"))[0]).toMatchObject({ applied: "recovered", failed_at: now + 1, recovered_at: now + 2, exposed_at: now });
    // 行の無い人の回復は何も書かない(stored のまま。送り直させない)
    const stranger = generateVisitorId();
    expect(await call({ type: "participant", v: 1, runId: RUN_A, variantId: assigned(expA, stranger), applied: "recovered" }, { now, vid: stranger })).toEqual({ result: "stored" });
    expect(await rows("participants")).toHaveLength(1);
  });

  it("participant_with_wrong_variant_for_visitor_is_ignored", async () => {
    const vid = generateVisitorId();
    expect(await call(participant(RUN_A, otherThan(expA, vid)), { now: day(3), vid })).toEqual({ result: "ignored", retry: false });
    expect(await call(participant(RUN_A, "vZ"), { now: day(3), vid })).toEqual({ result: "ignored", retry: false }); // そのテストのパターンでない
    expect(await rows("participants")).toEqual([]);
  });

  it("unknown run and paused experiment are temporarily ignored", async () => {
    const vid = generateVisitorId();
    expect(await call(participant(RUN_X, "vA"), { now: day(4), vid })).toEqual({ result: "ignored" });
    expect(await call(participant(RUN_P, "vA"), { now: day(4), vid })).toEqual({ result: "ignored" });
    // active な config が無い・results が無いときも一時的
    const { results: _r, ...noResults } = config(3);
    await env.CONFIG_KV.put(kvKeys.config(SITE, 3), JSON.stringify(noResults));
    await env.CONFIG_KV.put(kvKeys.active(SITE), "3");
    __resetEdgeCaches();
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now: day(4), vid })).toEqual({ result: "ignored" });
    await env.CONFIG_KV.delete(kvKeys.active(SITE));
    __resetEdgeCaches();
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now: day(4), vid })).toEqual({ result: "ignored" });
    expect(await rows("participants")).toEqual([]);
  });

  it("events_after_collect_until_are_ignored", async () => {
    const vid = generateVisitorId();
    const now = day(5);
    // 締め切りの前に両方の run に参加しておく
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now: now - 10, vid })).toEqual({ result: "stored" });
    expect(await call(participant(RUN_B, assigned(expB, vid)), { now: now - 10, vid })).toEqual({ result: "stored" });
    const closed = settings({ resultsCollectUntil: { [RUN_A]: now - 1 } });
    expect(await call({ type: "participant", v: 1, runId: RUN_A, variantId: assigned(expA, vid), applied: "failed_later" }, { now, vid, settings: closed })).toEqual({ result: "ignored", retry: false });
    // 締め切りちょうども受けない
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, settings: settings({ resultsCollectUntil: { [RUN_A]: now } }) })).toEqual({ result: "ignored", retry: false });
    // CV はその run だけ外す
    const cv = await call(conversion([RUN_A, RUN_B]), { now, vid, settings: closed });
    expect(cv).toEqual({ result: "stored", runs: { [RUN_A]: { result: "ignored", retry: false }, [RUN_B]: { result: "stored" } } });
    const cs = await rows("conversions");
    expect(cs.map((c) => c.run_id)).toEqual([RUN_B]);
    expect((await rows("participants")).every((p) => p.applied === "ok")).toBe(true); // 後から失敗も書いていない
  });

  it("conversion is inserted only for runs with a participant row", async () => {
    const vid = generateVisitorId();
    const now = day(6);
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid })).toEqual({ result: "stored" });
    // RUN_B には参加者の行が無い。印を付けて送り直させないよう stored
    expect(await call(conversion([RUN_A, RUN_B]), { now: now + 1, vid })).toEqual({ result: "stored", runs: { [RUN_A]: { result: "stored" }, [RUN_B]: { result: "stored" } } });
    // 2 回目は DO NOTHING
    expect((await call(conversion([RUN_A]), { now: now + 2, vid })).result).toBe("stored");
    const cs = await rows("conversions");
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ run_id: RUN_A, goal_id: "g_buy", converted_at: now + 1 });
  });

  it("conversion returns per-run results", async () => {
    const vid = generateVisitorId();
    const now = day(7);
    await call(participant(RUN_A, assigned(expA, vid)), { now, vid });
    // RUN_P(一時停止中)も CV は受ける。RUN_X は config に無いので一時的な ignored
    expect(await call(conversion([RUN_A, RUN_P, RUN_X]), { now, vid })).toEqual({
      result: "stored",
      runs: { [RUN_A]: { result: "stored" }, [RUN_P]: { result: "stored" }, [RUN_X]: { result: "ignored" } },
    });
    // 知らない goal は全部 retry: false
    expect(await call(conversion([RUN_A, RUN_B], "g_nope"), { now, vid })).toEqual({
      result: "ignored",
      retry: false,
      runs: { [RUN_A]: { result: "ignored", retry: false }, [RUN_B]: { result: "ignored", retry: false } },
    });
    // 全部が一時的な ignored なら全体も一時的
    expect(await call(conversion([RUN_X]), { now, vid })).toEqual({ result: "ignored", runs: { [RUN_X]: { result: "ignored" } } });
  });

  it("edge_without_results_key_does_not_write", async () => {
    const vid = generateVisitorId();
    const now = day(8);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride: { RESULTS_VISITOR_KEY: undefined } })).toEqual({ result: "failed" });
    spy.mockRestore();
    expect(await rows("participants")).toEqual([]);
    expect(await failedCount(RUN_A, now)).toBe(1);
  });

  it("missing RESULTS_DB does not throw", async () => {
    const vid = generateVisitorId();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = await send(`/v1/sites/${SITE}/event`, { ...participant(RUN_A, assigned(expA, vid)), visitorId: vid }, { RESULTS_DB: undefined });
    expect(p.status).toBe(200);
    expect(await p.json()).toEqual({ result: "failed" });
    const c = await send(`/v1/sites/${SITE}/event`, { ...conversion([RUN_A]), visitorId: vid }, { RESULTS_DB: undefined });
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ result: "failed", runs: { [RUN_A]: { result: "failed" } } });
    spy.mockRestore();
  });

  it("returns stopped when the budget is exhausted", async () => {
    const vid = generateVisitorId();
    const now = day(9);
    const { writeBudget } = await budgetStub(env).status(now);
    expect((await budgetStub(env).lease(new Date(now).toISOString().slice(0, 10), writeBudget, now)).ok).toBe(true); // その日の予算を配り終える
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid })).toEqual({ result: "stopped", until: nextUtcMidnight(now) });
    expect(await call(conversion([RUN_A, RUN_B]), { now, vid })).toEqual({
      result: "stopped",
      until: nextUtcMidnight(now),
      runs: { [RUN_A]: { result: "stopped", until: nextUtcMidnight(now) }, [RUN_B]: { result: "stopped", until: nextUtcMidnight(now) } },
    });
    expect(await rows("participants")).toEqual([]);
    expect(await failedCount(RUN_A, now)).toBe(0); // 停止は失敗に数えない
  });

  it("budget_unreachable_returns_failed_and_is_counted", async () => {
    const vid = generateVisitorId();
    const now = day(10);
    const unreachable = fakeBudgetNs({ lease: async () => { throw new Error("budget DO down"); }, check: async () => { throw new Error("budget DO down"); } });
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride: { RESULTS_BUDGET: unreachable } })).toEqual({ result: "failed" });
    expect(await rows("participants")).toEqual([]);
    expect(await failedCount(RUN_A, now)).toBe(1);
    // 停止期間には数えない(本物の予算の DO に停止が増えていない)
    expect(await budgetStub(env).stopPeriods(Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 11))).toEqual([]);
  });

  it("invalid_results_key_does_not_write", async () => {
    const vid = generateVisitorId();
    const now = day(11);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const short = btoa("x".repeat(31)); // 31 バイト
    for (const bad of ["", short, "not base64 !!!"]) {
      expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride: { RESULTS_VISITOR_KEY: bad } })).toEqual({ result: "failed" });
      expect(await visitorKey({ ...env, RESULTS_VISITOR_KEY: bad }, SITE, vid)).toBeNull();
    }
    spy.mockRestore();
    expect(await rows("participants")).toEqual([]);
    // 正しい鍵に戻せば同じ isolate でも書ける(鍵は secret の文字列ごとに持つ)
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid })).toEqual({ result: "stored" });
  });

  it("d1 daily limit error stops collection immediately", async () => {
    const vid = generateVisitorId();
    const now = day(12);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limited = failingDb("D1_ERROR: Exceeded D1's free tier Daily Row Write Limit. Please upgrade.");
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride: { RESULTS_DB: limited } })).toEqual({ result: "stopped", until: nextUtcMidnight(now) });
    spy.mockRestore();
    // 予算の DO に d1_limit の停止が立ち、次の送信は本物の D1 でも書かずに stopped
    const periods = await budgetStub(env).stopPeriods(now - 1, now + 86_400_000);
    expect(periods.map((p) => p.reason)).toEqual(["d1_limit"]);
    expect(periods[0]!.to).toBe(nextUtcMidnight(now));
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now: now + 1, vid })).toEqual({ result: "stopped", until: nextUtcMidnight(now) });
    expect(await rows("participants")).toEqual([]);
    expect(await failedCount(RUN_A, now)).toBe(0);
  });

  it("d1 failure returns failed and is counted", async () => {
    const vid = generateVisitorId();
    const now = day(13);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = failingDb("D1_ERROR: network connection lost");
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride: { RESULTS_DB: broken } })).toEqual({ result: "failed" });
    expect(await call(conversion([RUN_A, RUN_B]), { now, vid, envOverride: { RESULTS_DB: broken } })).toEqual({
      result: "failed",
      runs: { [RUN_A]: { result: "failed" }, [RUN_B]: { result: "failed" } },
    });
    spy.mockRestore();
    expect(await failedCount(RUN_A, now)).toBe(2); // 参加 1 + CV 1
    expect(await failedCount(RUN_B, now)).toBe(1);
  });

  it("rows_written is subtracted from the lease", async () => {
    const now = day(14);
    let written = 0;
    // batch の meta.rows_written を数える D1
    const recording = {
      prepare: (sql: string) => db().prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        const res = await db().batch(stmts);
        for (const r of res) written += r.meta.rows_written;
        return res;
      },
    } as unknown as D1Database;
    const envOverride = { RESULTS_DB: recording, RESULTS_LEASE_ROWS: "20" };
    for (const vid of [generateVisitorId(), generateVisitorId()]) {
      expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid, envOverride })).toEqual({ result: "stored" });
    }
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(2 * 3); // 見込み(3 行)より少ない分が手元の枠に戻っている
    expect((await budgetStub(env).status(now)).writeUsed).toBe(20); // 枠は 1 回だけ受け取った
    // 残り = 枠 − rows_written の合計。ちょうどその分は DO を呼ばずに取れ、さらに 1 行は新しい枠を受け取る
    const holder = leaseHolder({ ...env, ...envOverride });
    expect((await holder.take(20 - written, now)).kind).toBe("ok");
    expect((await budgetStub(env).status(now)).writeUsed).toBe(20);
    expect((await holder.take(1, now)).kind).toBe("ok");
    expect((await budgetStub(env).status(now)).writeUsed).toBe(40);
  });

  it("single experiment has no run and is ignored", async () => {
    // パーソナライズ(exp_s)は experiments[] にあるが results.runs に無い。その実験向けの run は無いので一時的な ignored
    const vid = generateVisitorId();
    const runS = "s".repeat(22);
    expect(await call(participant(runS, pickVariant(expS, vid)), { now: day(15), vid })).toEqual({ result: "ignored" });
    expect(await rows("participants")).toEqual([]);
  });

  it("goal and forget responses stay unchanged", async () => {
    const vid = generateVisitorId();
    expect((await send(`/v1/sites/${SITE}/event`, { type: "goal", goalId: "g_buy", visitorId: vid })).status).toBe(204);
    expect((await send(`/v1/sites/${SITE}/event`, { type: "forget", visitorId: vid })).status).toBe(204);
    const broken = { idFromName: () => ({}) as DurableObjectId, get: () => ({ recordGoal: async () => { throw new Error("do down"); }, forget: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send(`/v1/sites/${SITE}/event`, { type: "goal", goalId: "g_buy", visitorId: vid }, { VISITOR_PROFILE: broken })).status).toBe(503);
    expect((await send(`/v1/sites/${SITE}/event`, { type: "forget", visitorId: vid }, { VISITOR_PROFILE: broken })).status).toBe(503);
    spy.mockRestore();
  });
});

// D9 ② Task 7(設計書 §6.4・K13): 撤回(Mode A の forget)で計測用 D1 の行を消す
describe("results forget (D9 ② Task 7)", () => {
  const OTHER_SITE = "site_other";
  /** 参加と CV を 1 件ずつ入れ、同じ訪問者 ID・別の Site の行(visitor_key が違う)も直接入れる */
  async function seed(vid: string, now: number): Promise<void> {
    expect(await call(participant(RUN_A, assigned(expA, vid)), { now, vid })).toEqual({ result: "stored" });
    expect((await call(conversion([RUN_A]), { now: now + 1, vid })).result).toBe("stored");
    const otherKey = (await visitorKey(env, OTHER_SITE, vid))!;
    await db().batch([
      db().prepare("INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied) VALUES (?1, ?2, ?3, 'vA', ?4, 'desktop', 'ok')").bind(RUN_A, otherKey, OTHER_SITE, now),
      db().prepare("INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at) VALUES (?1, 'g_buy', ?2, ?3)").bind(RUN_A, otherKey, now),
    ]);
  }
  const forgetEvent = (vid: string, envOverride: Partial<Env> = {}) => send(`/v1/sites/${SITE}/event`, { type: "forget", visitorId: vid }, envOverride);
  const brokenProfile = { idFromName: () => ({}) as DurableObjectId, get: () => ({ forget: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];

  it("forget deletes results rows for Mode A", async () => {
    const vid = generateVisitorId();
    await seed(vid, day(17));
    expect(await rows("participants")).toHaveLength(2);
    expect((await forgetEvent(vid)).status).toBe(204);
    // 別の Site の同じ ID の行は残る(visitor_key に siteId を含めて作るため)
    expect(await rows("participants")).toMatchObject([{ site_id: OTHER_SITE }]);
    expect(await rows("conversions")).toHaveLength(1);
    expect(bytes((await rows("conversions"))[0]!.visitor_key)).toEqual((await visitorKey(env, OTHER_SITE, vid))!);
    // 冪等(消した後の 2 回目も 204)
    expect((await forgetEvent(vid)).status).toBe(204);
  });

  it("forget still deletes the profile when results deletion fails", async () => {
    const vid = generateVisitorId();
    expect((await send(`/v1/sites/${SITE}/event`, { type: "goal", goalId: "g_buy", visitorId: vid })).status).toBe(204);
    expect(await runInDurableObject(profileStub(env, SITE, vid), (_i, state) => state.storage.get(PROFILE_KEY))).toBeDefined();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await forgetEvent(vid, { RESULTS_DB: failingDb("D1_ERROR: network connection lost") });
    spy.mockRestore();
    expect(res.status).toBe(204); // 応答は Profile の結果のまま(計測用 D1 の失敗はログだけ)
    expect(await runInDurableObject(profileStub(env, SITE, vid), (_i, state) => state.storage.get(PROFILE_KEY))).toBeUndefined();
  });

  it("forget_deletes_results_when_profile_delete_fails", async () => {
    const vid = generateVisitorId();
    await seed(vid, day(18));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await forgetEvent(vid, { VISITOR_PROFILE: brokenProfile });
    spy.mockRestore();
    expect(res.status).toBe(503); // 応答は今のとおり Profile の失敗
    expect(await rows("participants")).toMatchObject([{ site_id: OTHER_SITE }]); // 計測用 D1 の行は消えている
    expect(await rows("conversions")).toHaveLength(1);
  });

  it("mode_a_forget_keeps_results_when_forget_on_revoke_is_false", async () => {
    await env.CONFIG_KV.put(kvKeys.settings(SITE), JSON.stringify({ settingsVersion: 1, siteId: SITE, allowedOrigins: [ORIGIN], forgetOnRevoke: false }));
    __resetEdgeCaches();
    const vid = generateVisitorId();
    await seed(vid, day(19));
    expect((await forgetEvent(vid)).status).toBe(204);
    expect(await rows("participants")).toHaveLength(2);
    expect(await rows("conversions")).toHaveLength(2);
  });

  it("forgetResults does nothing without the key or the database", async () => {
    const vid = generateVisitorId();
    await seed(vid, day(20));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await forgetResults({ ...env, RESULTS_VISITOR_KEY: undefined }, SITE, vid);
    await forgetResults({ ...env, RESULTS_DB: undefined }, SITE, vid);
    spy.mockRestore();
    expect(await rows("participants")).toHaveLength(2);
    expect(await rows("conversions")).toHaveLength(2);
  });
});

// B139 §5(Q14・Q22・Q30): 目標だけの CV。run は D1 の参加の記録から引く。/__ab/decision と type:"goal" に便乗させる
describe("goal-only conversions (B139 §5)", () => {
  const HOST = "site.example"; // ORIGIN のホスト。Mode B の Cloudflare 経由のドメイン
  const pvGoal = (id: string, value: string) => ({ id, type: "PAGEVIEW", config: { page: { op: "contains", value } } });
  /** CUSTOM の g_buy に、ページの表示の目標を 2 つ足した config(needsProfile = true) */
  const goalConfig = (version: number, runs: Record<string, string> = { exp_a: RUN_A, exp_b: RUN_B, exp_p: RUN_P }) => ({
    ...config(version),
    goals: [{ id: "g_buy", type: "CUSTOM", config: {} }, pvGoal("g_thanks", "/thanks"), pvGoal("g_done", "/thanks/done")],
    results: { forget: true, runs },
  });
  /** route 経由の書き込みは今の時刻で予算を使うので、受け取る枠を小さくして同じ日の予算を使い切らない */
  const routeEnv: Partial<Env> = { RESULTS_LEASE_ROWS: "1", DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as Env["DECISION_RATE_LIMITER"] };
  async function fetchAt(url: string, body: unknown, opts: { cookie?: string; origin?: string | null; envOverride?: Partial<Env> } = {}): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (opts.origin !== null) headers.set("Origin", opts.origin ?? ORIGIN);
    if (opts.cookie) headers.set("Cookie", opts.cookie);
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), { ...env, ...routeEnv, ...opts.envOverride }, ctx);
    await waitOnExecutionContext(ctx); // 便乗の記録(waitUntil)を済ませる
    return res;
  }
  const abDecision = (path: string, cookie: string, envOverride: Partial<Env> = {}, v = 1) =>
    fetchAt(`https://${HOST}/__ab/decision`, { v, url: `https://${HOST}${path}`, referrer: "", device: "mobile" }, { cookie, origin: null, envOverride });
  const abEvent = (body: unknown, cookie: string, envOverride: Partial<Env> = {}) => fetchAt(`https://${HOST}/__ab/event`, body, { cookie, origin: null, envOverride });
  const v1Event = (body: unknown, envOverride: Partial<Env> = {}, origin?: string | null) => fetchAt(`https://edge.example/v1/sites/${SITE}/event`, body, { envOverride, origin });
  const goalCv = (goalIds: string[]) => ({ type: "conversion", v: 2, goalIds });
  /** 参加の行を直接入れる(受信の経路を通すと isolate の枠を受け取ってしまい、予算の停止の確かめを乱す) */
  async function seedParticipant(vid: string, runId: string, siteId = SITE): Promise<void> {
    const key = (await visitorKey(env, siteId, vid))!;
    await db().prepare("INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied) VALUES (?1, ?2, ?3, 'vA', 1, 'desktop', 'ok')").bind(runId, key, siteId).run();
  }
  const cvRows = () => db().prepare("SELECT run_id, goal_id, visitor_key FROM conversions ORDER BY run_id, goal_id").all<{ run_id: string; goal_id: string; visitor_key: ArrayBuffer }>().then((r) => r.results);
  const cvPairs = async () => (await cvRows()).map((r) => `${r.run_id.slice(0, 1)}:${r.goal_id}`);
  const ctxOf = (now: number, envOverride: Partial<Env> = {}) => ({ env: { ...env, ...envOverride }, ctx: createExecutionContext(), siteId: SITE, now });
  async function record(goalIds: string[], vid: string, now: number, envOverride: Partial<Env> = {}) {
    const c = ctxOf(now, envOverride);
    const out = await recordGoalConversion(c, settings(), goalIds, vid);
    await waitOnExecutionContext(c.ctx);
    return out;
  }
  /** SELECT(参加の記録を引く文)だけを失敗させる・数える D1 */
  const lookupDb = (opts: { fail: boolean; onSelect?: () => void }): D1Database =>
    ({
      prepare: (sql: string) => {
        if (!sql.trimStart().startsWith("SELECT")) return db().prepare(sql);
        opts.onSelect?.();
        if (!opts.fail) return db().prepare(sql);
        const boom = async () => { throw new Error("D1_ERROR: lookup failed"); };
        const stmt = { all: boom, first: boom, raw: boom, run: boom };
        return { ...stmt, bind: () => stmt };
      },
      batch: (stmts: D1PreparedStatement[]) => db().batch(stmts),
    }) as unknown as D1Database;
  /** HealthBuffer を手で送らずに ResultsHealth を読む(便乗の経路が flush を waitUntil に登録したかを見る) */
  const healthNow = async (runId: string, now: number) =>
    (await healthStub(env, SITE).read(runId, hourOf(now), hourOf(now) + HOUR)).reduce((a, r) => a + r.failed, 0);
  const goalCount = async (vid: string, goalId: string) =>
    (await runInDurableObject(profileStub(env, SITE, vid), (_i, s) => s.storage.get<{ goals: Record<string, { count: number }> }>(PROFILE_KEY)))?.goals[goalId]?.count ?? 0;

  beforeEach(async () => {
    await env.CONFIG_KV.put(kvKeys.host(HOST), SITE);
    await env.CONFIG_KV.put(kvKeys.settings(SITE), JSON.stringify({ settingsVersion: 1, siteId: SITE, mode: "B", hosts: [HOST], allowedOrigins: [ORIGIN] }));
    await env.CONFIG_KV.put(kvKeys.config(SITE, 1), JSON.stringify(goalConfig(1)));
    __resetEdgeCaches();
  });

  it("goal_only_cv_counts_paused_run", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_P); // 一時停止中(experiments[] に無いが results.runs にある)
    expect(await record(["g_buy"], vid, day(21))).toEqual({ result: "stored" });
    expect(await cvPairs()).toEqual(["p:g_buy"]);
  });

  it("goal_only_cv_ignored_without_participation", async () => {
    const vid = generateVisitorId();
    await seedParticipant(generateVisitorId(), RUN_A); // 別の人の参加
    await seedParticipant(vid, RUN_A, "site_other"); // 同じ ID の別の Site の参加(visitor_key が違う)
    expect(await record(["g_buy"], vid, day(21))).toEqual({ result: "ignored" });
    expect(await cvRows()).toEqual([]);
    expect(await failedCount(RUN_A, day(21))).toBe(0);
  });

  it("unknown goals are ignored and duplicated goal ids are written once", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    expect(await record(["g_nope"], vid, day(21))).toEqual({ result: "ignored", retry: false });
    expect(await record(["g_buy", "g_buy", "g_nope"], vid, day(21))).toEqual({ result: "stored" });
    expect(await cvPairs()).toEqual(["a:g_buy"]);
  });

  it("runs past collect until and runs not in active config are not written", async () => {
    const vid = generateVisitorId();
    const now = day(21);
    await seedParticipant(vid, RUN_A);
    await seedParticipant(vid, RUN_B);
    await seedParticipant(vid, RUN_X); // active の config の results.runs に無い run
    const c = ctxOf(now);
    expect(await recordGoalConversion(c, settings({ resultsCollectUntil: { [RUN_A]: now } }), ["g_buy"], vid)).toEqual({ result: "stored" });
    await waitOnExecutionContext(c.ctx);
    expect(await cvPairs()).toEqual(["b:g_buy"]);
  });

  it("participant_lookup_failure_does_not_write", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await record(["g_buy"], vid, day(22), { RESULTS_DB: lookupDb({ fail: true }) })).toEqual({ result: "failed" });
    // route でも 200 / failed(今の書き込みの失敗と同じ)
    const res = await v1Event({ ...goalCv(["g_buy"]), visitorId: vid }, { RESULTS_DB: lookupDb({ fail: true }) });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "failed" });
    expect(await cvRows()).toEqual([]);
  });

  it("participant_lookup_failure_counts_health_per_run", async () => {
    const vid = generateVisitorId();
    const now = day(23);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await record(["g_buy", "g_thanks"], vid, now, { RESULTS_DB: lookupDb({ fail: true }) })).toEqual({ result: "failed" });
    spy.mockRestore();
    // 目標の数ではなく、対象の results.runs の各 run に 1 ずつ
    expect(await failedCount(RUN_A, now)).toBe(1);
    expect(await failedCount(RUN_B, now)).toBe(1);
    expect(await failedCount(RUN_P, now)).toBe(1);
    expect(await failedCount(RUN_X, now)).toBe(0);
  });

  it("missing RESULTS_DB fails like a write failure", async () => {
    const vid = generateVisitorId();
    const now = day(23) + HOUR;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await record(["g_buy"], vid, now, { RESULTS_DB: undefined })).toEqual({ result: "failed" });
    spy.mockRestore();
    expect(await failedCount(RUN_A, now)).toBe(1);
  });

  it("goal_only_cv_stopped_sets_halt_until", async () => {
    const vid = generateVisitorId();
    const now = day(24);
    await seedParticipant(vid, RUN_A);
    const { writeBudget } = await budgetStub(env).status(now);
    expect((await budgetStub(env).lease(new Date(now).toISOString().slice(0, 10), writeBudget, now)).ok).toBe(true); // その日の予算を配り終える
    expect(await record(["g_buy"], vid, now)).toEqual({ result: "stopped", until: nextUtcMidnight(now), retry: false });
    expect(await cvRows()).toEqual([]);
    expect(await failedCount(RUN_A, now)).toBe(0); // 停止は失敗に数えない
    // 停止を知った isolate は、D1 を引かずに stopped を返す
    let selects = 0;
    expect(await record(["g_buy"], vid, now + 1, { RESULTS_DB: lookupDb({ fail: false, onSelect: () => selects++ }) })).toEqual({ result: "stopped", until: nextUtcMidnight(now), retry: false });
    expect(selects).toBe(0);
  });

  it("goal_only_cv_does_not_write_beyond_lease", async () => {
    const vid = generateVisitorId();
    const now = day(25);
    await seedParticipant(vid, RUN_A);
    await seedParticipant(vid, RUN_B);
    // 見込み = 3 行 × 2 目標 × 2 run = 12 行。予算の DO が 11 行しか配れないと、1 行も書かずに止まる
    let asked = 0;
    const short = fakeBudgetNs({ lease: async (d: string, rows: number) => { asked = rows; return { ok: true, day: d, rows: 11 }; }, check: async () => ({ stoppedUntil: null }) });
    expect(await record(["g_buy", "g_thanks"], vid, now, { RESULTS_BUDGET: short, RESULTS_LEASE_ROWS: "1" })).toEqual({ result: "stopped", until: nextUtcMidnight(now), retry: false });
    expect(asked).toBe(12);
    expect(await cvRows()).toEqual([]);
    // 本物の予算では、見込みの 12 行を 1 回で受け取り、4 行(目標 × run)を書く
    resetLeaseHolderForTest();
    expect(await record(["g_buy", "g_thanks"], vid, now, { RESULTS_LEASE_ROWS: "1" })).toEqual({ result: "stored" });
    expect((await budgetStub(env).status(now)).writeUsed).toBe(12);
    expect(await cvPairs()).toEqual(["a:g_buy", "a:g_thanks", "b:g_buy", "b:g_thanks"]);
  });

  it("goal_only_cv_batch_has_one_statement_per_goal", async () => {
    // 2 目標 × 3 run = 6 行を、目標ごとの 2 文で書く(run の数で文を増やさない。D1 の 1 回の呼び出しの文の上限のため)
    const vid = generateVisitorId();
    const now = day(26);
    for (const r of [RUN_A, RUN_B, RUN_P]) await seedParticipant(vid, r);
    await seedParticipant(vid, RUN_X); // results.runs に無い run には入れない
    const batches: number[] = [];
    const counting = {
      prepare: (sql: string) => db().prepare(sql),
      batch: (stmts: D1PreparedStatement[]) => { batches.push(stmts.length); return db().batch(stmts); },
    } as unknown as D1Database;
    expect(await record(["g_buy", "g_thanks"], vid, now, { RESULTS_DB: counting, RESULTS_LEASE_ROWS: "1" })).toEqual({ result: "stored" });
    expect(batches).toEqual([2]);
    expect(await cvPairs()).toEqual(["a:g_buy", "a:g_thanks", "b:g_buy", "b:g_thanks", "p:g_buy", "p:g_thanks"]);
    expect((await budgetStub(env).status(now)).writeUsed).toBe(3 * 2 * 3); // 見込みは目標 × run のまま
  });

  it("legacy_run_specified_cv_still_accepted", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const res = await v1Event({ ...conversion([RUN_A, RUN_X]), visitorId: vid });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored", runs: { [RUN_A]: { result: "stored" }, [RUN_X]: { result: "ignored" } } });
    expect(await cvPairs()).toEqual(["a:g_buy"]);
  });

  it("goal_only_cv_on_v1_from_outside_domain", async () => {
    // Mode B のサイトの /v1/(Cloudflare 外のドメインのページ)。Origin は allowedOrigins の完全一致
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const res = await v1Event({ ...goalCv(["g_buy"]), visitorId: vid });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.json()).toEqual({ result: "stored" });
    expect(await cvPairs()).toEqual(["a:g_buy"]);
    // 一覧に無い Origin は拒む
    expect((await v1Event({ ...goalCv(["g_buy"]), visitorId: vid }, {}, "https://evil.example")).status).toBe(403);
  });

  it("v2_conversion_requires_visitor_id_on_v1", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    expect((await v1Event(goalCv(["g_buy"]))).status).toBe(400);
    expect((await v1Event({ ...goalCv(["g_buy"]), visitorId: "A".repeat(22) })).status).toBe(400);
    expect(await cvRows()).toEqual([]);
    expect((await v1Event({ ...goalCv(["g_buy"]), visitorId: vid })).status).toBe(200); // 正しい ID なら受ける
  });

  it("v2_conversion_ignores_body_identity_on_ab", async () => {
    const vid = generateVisitorId();
    const other = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    await seedParticipant(other, RUN_B);
    const res = await abEvent({ ...goalCv(["g_buy"]), visitorId: other }, `_wtt_vid=${vid}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored" });
    const cs = await cvRows();
    expect(cs.map((r) => r.run_id)).toEqual([RUN_A]); // Cookie の ID(vid)の参加の run だけ
    expect(bytes(cs[0]!.visitor_key)).toEqual((await visitorKey(env, SITE, vid))!);
  });

  it("pageview_goal_recorded_by_edge_on_decision_request", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const res = await abDecision("/thanks", `_wtt_vid=${vid}`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["experiments", "v", "vh"]); // 記録の結果は載せない
    expect(await cvPairs()).toEqual(["a:g_thanks"]);
    // 目標に当たらないページでは記録しない
    expect((await abDecision("/other", `_wtt_vid=${vid}`)).status).toBe(200);
    expect(await cvPairs()).toEqual(["a:g_thanks"]);
  });

  it("multiple_pageview_goals_share_one_conversion_request", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    let selects = 0;
    expect((await abDecision("/thanks/done", `_wtt_vid=${vid}`, { RESULTS_DB: lookupDb({ fail: false, onSelect: () => selects++ }) })).status).toBe(200);
    expect(selects).toBe(1);
    expect(await cvPairs()).toEqual(["a:g_done", "a:g_thanks"]);
  });

  it("decision_response_unchanged_when_cv_collection_fails", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const cookie = `_wtt_vid=${vid}`;
    const ok = await abDecision("/thanks", cookie);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await abDecision("/thanks", cookie, { RESULTS_DB: lookupDb({ fail: true }) });
    const brokenWrite = await abDecision("/thanks", cookie, { RESULTS_DB: failingDb("D1_ERROR: network connection lost") });
    spy.mockRestore();
    for (const res of [broken, brokenWrite]) {
      expect(res.status).toBe(ok.status);
      expect(res.headers.getSetCookie()).toEqual(ok.headers.getSetCookie());
    }
    const body = await ok.json();
    expect(await broken.json()).toEqual(body);
    expect(await brokenWrite.json()).toEqual(body);
  });

  it("piggyback failure reaches ResultsHealth without later events", async () => {
    const vid = generateVisitorId();
    const now = Date.now();
    const before = await healthNow(RUN_A, now);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await abDecision("/thanks", `_wtt_vid=${vid}`, { RESULTS_DB: lookupDb({ fail: true }) })).status).toBe(200);
    spy.mockRestore();
    expect(await healthNow(RUN_A, now)).toBe(before + 1); // flushIfDue を waitUntil に登録している
  });

  it("pageview_cv_uses_active_config_with_stale_decision_version", async () => {
    // 版 1 にだけ RUN_A がある。active は版 2(RUN_B だけ)。decision の要求の版は古い 1
    await env.CONFIG_KV.put(kvKeys.config(SITE, 2), JSON.stringify(goalConfig(2, { exp_b: RUN_B })));
    await env.CONFIG_KV.put(kvKeys.config(SITE, 1), JSON.stringify(goalConfig(1, { exp_a: RUN_A })));
    await env.CONFIG_KV.put(kvKeys.active(SITE), "2");
    __resetEdgeCaches();
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    await seedParticipant(vid, RUN_B);
    expect((await abDecision("/thanks", `_wtt_vid=${vid}`, {}, 1)).status).toBe(200);
    expect(await cvPairs()).toEqual(["b:g_thanks"]);
  });

  it("no piggyback when active config has no results runs", async () => {
    await env.CONFIG_KV.put(kvKeys.config(SITE, 1), JSON.stringify(goalConfig(1, {})));
    __resetEdgeCaches();
    const vid = generateVisitorId();
    let selects = 0;
    const counting = { RESULTS_DB: lookupDb({ fail: false, onSelect: () => selects++ }) };
    expect((await abDecision("/thanks", `_wtt_vid=${vid}`, counting)).status).toBe(200);
    expect((await abEvent({ type: "goal", goalId: "g_buy" }, `_wtt_vid=${vid}`, counting)).status).toBe(204);
    expect((await abEvent(goalCv(["g_buy"]), `_wtt_vid=${vid}`, counting)).status).toBe(200);
    expect(selects).toBe(0);
  });

  it("goal_event_also_records_results_cv_when_needs_profile", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    // Cloudflare 経由のドメイン(/__ab/event)
    expect((await abEvent({ type: "goal", goalId: "g_buy" }, `_wtt_vid=${vid}`)).status).toBe(204);
    expect(await goalCount(vid, "g_buy")).toBe(1);
    expect(await cvPairs()).toEqual(["a:g_buy"]);
    // Mode A / Cloudflare 外のドメイン(/v1/)
    const vid2 = generateVisitorId();
    await seedParticipant(vid2, RUN_B);
    expect((await v1Event({ type: "goal", goalId: "g_buy", visitorId: vid2 })).status).toBe(204);
    expect(await goalCount(vid2, "g_buy")).toBe(1);
    expect(await cvPairs()).toEqual(["a:g_buy", "b:g_buy"]);
  });

  it("goal event on a Cloudflare host leaves pageview goals to the decision request", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    let selects = 0;
    expect((await abEvent({ type: "goal", goalId: "g_thanks" }, `_wtt_vid=${vid}`, { RESULTS_DB: lookupDb({ fail: false, onSelect: () => selects++ }) })).status).toBe(204);
    expect(selects).toBe(0); // D1 を引かない
    expect(await goalCount(vid, "g_thanks")).toBe(1); // 履歴は今のとおり記録する
    expect(await cvRows()).toEqual([]);
    // /v1/ ではページの表示の目標も記録する(decision では記録しないため)
    expect((await v1Event({ type: "goal", goalId: "g_thanks", visitorId: vid })).status).toBe(204);
    expect(await cvPairs()).toEqual(["a:g_thanks"]);
  });

  it("goal_profile_recorded_when_cv_collection_fails", async () => {
    const vid = generateVisitorId();
    await seedParticipant(vid, RUN_A);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await v1Event({ type: "goal", goalId: "g_buy", visitorId: vid }, { RESULTS_DB: lookupDb({ fail: true }) });
    const resAb = await abEvent({ type: "goal", goalId: "g_buy" }, `_wtt_vid=${vid}`, { RESULTS_DB: failingDb("D1_ERROR: network connection lost") });
    spy.mockRestore();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(resAb.status).toBe(204);
    expect(await goalCount(vid, "g_buy")).toBe(2);
    expect(await cvRows()).toEqual([]);
    // Profile が失敗しても CV は記録する(互いの失敗に影響されない)。goal の応答は今のとおり 503
    const brokenProfile = { idFromName: () => ({}) as DurableObjectId, get: () => ({ recordGoal: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];
    const spy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    const res503 = await v1Event({ type: "goal", goalId: "g_buy", visitorId: vid }, { VISITOR_PROFILE: brokenProfile });
    spy2.mockRestore();
    expect(res503.status).toBe(503);
    expect(await cvPairs()).toEqual(["a:g_buy"]);
  });

  it("needs_profile_pageview_goal_before_participation_is_ignored", async () => {
    // Q30: ページを開いた時点のページの表示の目標の goal は、同じページの参加より先に届く。そのページで初めて参加した 1 回は入らない
    const vid = generateVisitorId();
    expect((await v1Event({ type: "goal", goalId: "g_thanks", visitorId: vid })).status).toBe(204);
    expect(await (await v1Event({ ...participant(RUN_A, assigned(expA, vid)), visitorId: vid })).json()).toEqual({ result: "stored" });
    expect(await cvRows()).toEqual([]);
    // 次のページ(参加の後)の達成は入る
    expect((await v1Event({ type: "goal", goalId: "g_thanks", visitorId: vid })).status).toBe(204);
    expect(await cvPairs()).toEqual(["a:g_thanks"]);
  });
});
