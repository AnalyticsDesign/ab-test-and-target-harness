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
  { id: "vA", name: "A", weight: wA, changes: [] },
  { id: "vB", name: "B", weight: 100 - wA, changes: [] },
];
const expA: Experiment = { id: "exp_a", name: "a", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false, variants: variants(50) };
const expB: Experiment = { ...expA, id: "exp_b", name: "b" };
const expS: Experiment = { ...expA, id: "exp_s", name: "single" }; // パーソナライズ(results.runs に載らない)
const config = (version: number, experiments: Experiment[] = [expA, expB, expS]) => ({
  schemaVersion: 2, version, siteId: SITE, siteSalt: "salt", needsProfile: true, prehide: {}, exposureSelectors: {}, patterns: {},
  goals: [{ id: "g_buy", name: "Buy", type: "CUSTOM", config: {} }],
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
