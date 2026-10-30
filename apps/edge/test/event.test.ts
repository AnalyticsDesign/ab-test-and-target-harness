import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { generateVisitorId, kvKeys, type Experiment } from "@wtt/core";
import app from "../src/index";
import { __resetEdgeCaches } from "../src/store";
import { PROFILE_KEY, profileStub, type ProfileRecord } from "../src/profile";
import { __setNewProfileCounterForTests, createNewProfileCounter } from "../src/new-profile-counter";
import type { Env } from "../src/env";

const ORIGIN = "https://site.example";
const HOST = "dlite.example";
const exp: Experiment = {
  id: "exp_001", name: "hero", urlMatch: { op: "contains", value: "/lp" }, trafficPercentage: 100, persistAssignment: false,
  targeting: { hist: "converted", goal: "g_lead" },
  variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [] }],
};
const base = { schemaVersion: 2, version: 1, siteSalt: "salt", prehide: {}, exposureSelectors: {}, patterns: {}, goals: [{ id: "g_lead", name: "Lead", type: "CUSTOM", config: {} }] };

async function send(path: string, body: unknown, opts: { origin?: string | null; cookie?: string; envOverride?: Partial<Env>; host?: string; method?: string } = {}): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.origin !== null) headers.set("Origin", opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://${opts.host ?? "edge.example"}${path}`, { method: opts.method ?? "POST", headers, body: opts.method === "OPTIONS" ? undefined : JSON.stringify(body) }),
    { ...env, DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...opts.envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
function doSpy(onTouch: () => void): Env["VISITOR_PROFILE"] {
  return new Proxy(env.VISITOR_PROFILE, {
    get(t, p) { const v = Reflect.get(t, p); if (p === "idFromName" || p === "get") onTouch(); return typeof v === "function" ? v.bind(t) : v; },
  }) as Env["VISITOR_PROFILE"];
}
const readProfile = (siteId: string, visitorId: string) =>
  runInDurableObject(profileStub(env, siteId, visitorId), (_i, state) => state.storage.get<ProfileRecord>(PROFILE_KEY));

beforeEach(async () => {
  __resetEdgeCaches();
  __setNewProfileCounterForTests(null); // isolate の数え役をテストごとに作り直す
  await env.CONFIG_KV.put(kvKeys.settings("site_p"), JSON.stringify({ settingsVersion: 1, siteId: "site_p", allowedOrigins: [ORIGIN], retentionDays: 30 }));
  await env.CONFIG_KV.put(kvKeys.active("site_p"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_p", 1), JSON.stringify({ ...base, siteId: "site_p", needsProfile: true, experiments: [exp] }));
  await env.CONFIG_KV.put(kvKeys.settings("site_np"), JSON.stringify({ settingsVersion: 1, siteId: "site_np", allowedOrigins: [ORIGIN] }));
  await env.CONFIG_KV.put(kvKeys.active("site_np"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_np", 1), JSON.stringify({ ...base, siteId: "site_np", needsProfile: false, experiments: [{ ...exp, targeting: undefined }] }));
  await env.CONFIG_KV.put(kvKeys.host(HOST), "site_dl");
  await env.CONFIG_KV.put(kvKeys.settings("site_dl"), JSON.stringify({ settingsVersion: 1, siteId: "site_dl", mode: "B", hosts: [HOST] }));
  await env.CONFIG_KV.put(kvKeys.active("site_dl"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_dl", 1), JSON.stringify({ ...base, siteId: "site_dl", needsProfile: true, experiments: [exp] }));
});

describe("POST /v1/sites/:siteId/event (spec §9.2)", () => {
  it("records a goal into the profile, returns 204 with CORS, and makes the converted() condition true", async () => {
    const vid = generateVisitorId();
    const res = await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: vid });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect((await readProfile("site_p", vid))!.goals.g_lead!.count).toBe(1);
    expect((await readProfile("site_p", vid))!.retentionDays).toBe(30); // settings record の値が DO に届く
    const dec = await send("/v1/sites/site_p/decision", { v: 1, url: `${ORIGIN}/lp`, referrer: "", device: "desktop", visitorId: vid });
    expect(((await dec.json()) as { experiments: unknown[] }).experiments).toHaveLength(1);
  });
  it("mode_a_event_requires_visitor_id", async () => {
    let touched = 0;
    const envOverride = { VISITOR_PROFILE: doSpy(() => touched++) };
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead" }, { envOverride })).status).toBe(400);
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: "A".repeat(22) }, { envOverride })).status).toBe(400);
    expect((await send("/v1/sites/site_p/event", { type: "forget" }, { envOverride })).status).toBe(400);
    expect(touched).toBe(0);
  });
  it("unknown_goal_and_needs_profile_false_are_ignored_without_profile", async () => {
    let touched = 0;
    const envOverride = { VISITOR_PROFILE: doSpy(() => touched++) };
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_nope", visitorId: generateVisitorId() }, { envOverride })).status).toBe(204);
    expect((await send("/v1/sites/site_np/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() }, { envOverride })).status).toBe(204);
    expect(touched).toBe(0);
  });
  it("forget_is_honored_regardless_of_active_config", async () => {
    // 決定 37 の r1 追記(ユーザー選択 C): forget は config を見ずに届ける。履歴条件の実験を止めた後(needsProfile=false)の撤回でも
    // 旧 Profile が消え、active が無い Site でも 204 で DO に届く(空の DO への deleteAll は storage も alarm も残さない)
    const vid = generateVisitorId();
    await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: vid });
    await env.CONFIG_KV.put(kvKeys.config("site_p", 2), JSON.stringify({ ...base, siteId: "site_p", version: 2, needsProfile: false, experiments: [{ ...exp, targeting: undefined }] }));
    await env.CONFIG_KV.put(kvKeys.active("site_p"), "2");
    __resetEdgeCaches();
    expect((await send("/v1/sites/site_p/event", { type: "forget", visitorId: vid })).status).toBe(204);
    expect(await readProfile("site_p", vid)).toBeUndefined(); // needsProfile=false でも消えている
    await env.CONFIG_KV.delete(kvKeys.active("site_p"));
    __resetEdgeCaches();
    let touched = 0;
    expect((await send("/v1/sites/site_p/event", { type: "forget", visitorId: generateVisitorId() }, { envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } })).status).toBe(204);
    expect(touched).toBeGreaterThan(0); // active が無くても DO に届く(goal はこの状態では ignored のまま)
  });
  it("forget_deletes_profile_and_is_idempotent", async () => {
    const vid = generateVisitorId();
    await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: vid });
    expect((await send("/v1/sites/site_p/event", { type: "forget", visitorId: vid })).status).toBe(204);
    expect(await readProfile("site_p", vid)).toBeUndefined();
    expect((await send("/v1/sites/site_p/event", { type: "forget", visitorId: vid })).status).toBe(204);
    const dec = await send("/v1/sites/site_p/decision", { v: 1, url: `${ORIGIN}/lp`, referrer: "", device: "desktop", visitorId: vid });
    expect(((await dec.json()) as { experiments: unknown[] }).experiments).toEqual([]); // 履歴が消えたので converted は偽
  });
  it("applies the same order as decision: schema → rate limit → mode → origin (spec §9.5)", async () => {
    let kv = 0;
    const kvSpy = new Proxy(env.CONFIG_KV, { get(t, p) { const v = Reflect.get(t, p); if (p === "get") kv++; return typeof v === "function" ? v.bind(t) : v; } }) as Env["CONFIG_KV"];
    const limited = { limit: async () => ({ success: false }) };
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() }, { envOverride: { DECISION_RATE_LIMITER: limited, CONFIG_KV: kvSpy } })).status).toBe(429);
    expect(kv).toBe(0);
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() }, { origin: null })).status).toBe(403);
    // B139 §4.2: Mode B も /v1/ を受ける。site_dl は allowedOrigins が空なので Origin 検証で 403(404 ではない)
    expect((await send("/v1/sites/site_dl/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() })).status).toBe(403);
    expect((await send("/v1/sites/site_none/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() })).status).toBe(404);
    expect((await send("/v1/sites/site_p/event", { type: "pageview" })).status).toBe(400);
  });
  it("preflight OPTIONS mirrors the decision route", async () => {
    const res = await send("/v1/sites/site_p/event", undefined, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
  it("profile failure on event returns 503", async () => {
    const broken = { idFromName: () => ({}) as DurableObjectId, get: () => ({ recordGoal: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send("/v1/sites/site_p/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() }, { envOverride: { VISITOR_PROFILE: broken } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    spy.mockRestore();
  });
});

describe("/event と新しい Profile の予算(plan12 K9)・binding の 429(K11)", () => {
  async function seedBudgetSite(newProfileBudget: object): Promise<string> {
    const siteId = `site_nbe_${crypto.randomUUID().slice(0, 8)}`;
    await env.CONFIG_KV.put(kvKeys.settings(siteId), JSON.stringify({ settingsVersion: 1, siteId, allowedOrigins: [ORIGIN], newProfileBudget }));
    await env.CONFIG_KV.put(kvKeys.active(siteId), "1");
    await env.CONFIG_KV.put(kvKeys.config(siteId, 1), JSON.stringify({ ...base, siteId, needsProfile: true, experiments: [exp] }));
    return siteId;
  }
  const goal = (visitorId: string) => ({ type: "goal", goalId: "g_lead", visitorId });

  it("/event の新しい ID も、予算が尽きた後は保存しない(204)。既存の ID は保存する", async () => {
    const s = await seedBudgetSite({ perDay: 1 });
    const v1 = generateVisitorId();
    expect((await send(`/v1/sites/${s}/event`, goal(v1))).status).toBe(204);
    expect((await readProfile(s, v1))!.goals.g_lead!.count).toBe(1); // 1 件を作って報告 → 尽きた
    const v2 = generateVisitorId();
    expect((await send(`/v1/sites/${s}/event`, goal(v2))).status).toBe(204);
    expect(await readProfile(s, v2)).toBeUndefined();
    expect(await runInDurableObject(profileStub(env, s, v2), (_i, state) => state.storage.getAlarm())).toBeNull();
    expect((await send(`/v1/sites/${s}/event`, goal(v1))).status).toBe(204);
    expect((await readProfile(s, v1))!.goals.g_lead!.count).toBe(2);
  });

  it("newProfileBudget の無い Site の /event は予算の DO を呼ばない", async () => {
    let reports = 0;
    const spy = new Proxy(env.NEW_PROFILE_BUDGET!, { get(t, p) { const v = Reflect.get(t, p); if (p === "get") reports++; return typeof v === "function" ? v.bind(t) : v; } }) as Env["NEW_PROFILE_BUDGET"];
    for (let i = 0; i < 6; i++) expect((await send("/v1/sites/site_p/event", goal(generateVisitorId()), { envOverride: { NEW_PROFILE_BUDGET: spy } })).status).toBe(204);
    expect(reports).toBe(0);
  });

  it("profile_exception_is_not_counted", async () => {
    // 数え役: Profile の DO の例外(record の "failed")は手元を変えない
    const T = Date.UTC(2026, 9, 19, 12);
    const counts: number[] = [];
    const unit = createNewProfileCounter({ now: () => T, report: async (_d, _s, _h, _day, count) => { counts.push(count); return { exhaustedUntil: null }; } });
    for (let i = 0; i < 10; i++) unit.record("s1", { perDay: 100 }, "failed", T, () => {});
    expect(counts).toEqual([]); // 手元は 0 件のまま(報告も出ない)
    unit.record("s1", { perDay: 100 }, "created", T, () => {});
    expect(counts).toEqual([1]);

    // edge: Profile の DO の呼び出しの例外だけが "failed"。KV の読み取りの失敗では record を呼ばない
    const s = await seedBudgetSite({ perDay: 100 });
    const calls: string[] = [];
    __setNewProfileCounterForTests({ canCreate: () => { calls.push("canCreate"); return true; }, record: (_s, _b, outcome) => { calls.push(outcome); } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { idFromName: () => ({}) as DurableObjectId, get: () => ({ recordGoal: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];
    expect((await send(`/v1/sites/${s}/event`, goal(generateVisitorId()), { envOverride: { VISITOR_PROFILE: broken } })).status).toBe(503);
    expect(calls).toEqual(["canCreate", "failed"]);
    calls.length = 0;
    __resetEdgeCaches();
    const activeKey = kvKeys.active(s);
    const failingKv = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "get") return (key: string, ...rest: unknown[]) => (key === activeKey ? Promise.reject(new Error("kv down")) : (v as (...a: unknown[]) => unknown).call(t, key, ...rest));
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Env["CONFIG_KV"];
    expect((await send(`/v1/sites/${s}/event`, goal(generateVisitorId()), { envOverride: { CONFIG_KV: failingKv } })).status).toBe(503);
    expect(calls).toEqual([]); // canCreate も record も呼ばない
    spy.mockRestore();
  });

  it("binding の 429 に Access-Control-Allow-Origin: * が付く(KV を読まない)", async () => {
    let kv = 0;
    const kvSpy = new Proxy(env.CONFIG_KV, { get(t, p) { const v = Reflect.get(t, p); if (p === "get") kv++; return typeof v === "function" ? v.bind(t) : v; } }) as Env["CONFIG_KV"];
    const res = await send("/v1/sites/site_p/event", goal(generateVisitorId()), { origin: "https://other.example", envOverride: { DECISION_RATE_LIMITER: { limit: async () => ({ success: false }) }, CONFIG_KV: kvSpy } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Retry-After")).toBe("10");
    expect(await res.text()).toBe("rate limited");
    expect(kv).toBe(0);
  });
});

describe("POST /__ab/event (D-lite, spec §9.2 / §9.6)", () => {
  it("uses the cookie identity, never issues cookies, and records the goal", async () => {
    const vid = generateVisitorId();
    const res = await send("/__ab/event", { type: "goal", goalId: "g_lead" }, { host: HOST, cookie: `_ab_vid=${vid}`, origin: null });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]); // §15.1: event は Cookie に作用しない
    expect((await readProfile("site_dl", vid))!.goals.g_lead!.count).toBe(1);
  });
  it("d_lite_event_without_cookie_is_ignored", async () => {
    let touched = 0;
    const res = await send("/__ab/event", { type: "goal", goalId: "g_lead" }, { host: HOST, origin: null, envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(touched).toBe(0);
    // 不正な Cookie 値も同じ(再利用も発行もしない)
    expect((await send("/__ab/event", { type: "goal", goalId: "g_lead" }, { host: HOST, origin: null, cookie: `_ab_vid=${"A".repeat(22)}`, envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } })).status).toBe(204);
    expect(touched).toBe(0);
  });
  it("body の visitorId は無視し、unknown host / mode A は 404", async () => {
    const vid = generateVisitorId();
    const other = generateVisitorId();
    await send("/__ab/event", { type: "goal", goalId: "g_lead", visitorId: other }, { host: HOST, cookie: `_ab_vid=${vid}`, origin: null });
    expect((await readProfile("site_dl", vid))!.goals.g_lead!.count).toBe(1);
    expect(await readProfile("site_dl", other)).toBeUndefined();
    expect((await send("/__ab/event", { type: "goal", goalId: "g_lead" }, { host: "unknown.example", origin: null })).status).toBe(404);
  });
  it("d_lite_event_ignores_forget_without_touching_the_profile", async () => {
    const vid = generateVisitorId();
    await send("/__ab/event", { type: "goal", goalId: "g_lead" }, { host: HOST, cookie: `_ab_vid=${vid}`, origin: null });
    let touched = 0;
    const res = await send("/__ab/event", { type: "forget" }, { host: HOST, cookie: `_ab_vid=${vid}`, origin: null, envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } });
    expect(res.status).toBe(204);
    expect(touched).toBe(0);
    expect((await readProfile("site_dl", vid))!.goals.g_lead!.count).toBe(1); // 消えていない
  });
});
