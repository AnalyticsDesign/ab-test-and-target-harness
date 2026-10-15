import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { generateVisitorId, kvKeys, type Experiment } from "@wtt/core";
import app from "../src/index";
import { __resetEdgeCaches } from "../src/store";
import { PROFILE_KEY, profileStub, type ProfileRecord } from "../src/profile";
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
    expect((await send("/v1/sites/site_dl/event", { type: "goal", goalId: "g_lead", visitorId: generateVisitorId() })).status).toBe(404); // Mode B はブラウザ直接経路を持たない
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
