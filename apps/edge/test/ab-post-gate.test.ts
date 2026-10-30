import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { generateVisitorId, kvKeys, type Experiment } from "@wtt/core";
import app from "../src/index";
import { visitorKey } from "../src/results";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

// B158(G05): D-lite の POST /__ab/* は application/json 以外を 415、ブラウザが別オリジンから送ったもの(Sec-Fetch-Site が same-origin 以外)を 403 で断る。
// 同じ登録ドメインの兄弟ホストのページが text/plain で送ると、訪問者の Cookie 付きで撤回・送信ができてしまうため
const HOST = "site.example";
const RUN = "r".repeat(22);
const exp: Experiment = {
  id: "exp_001", name: "hero", urlMatch: { op: "contains", value: "/" },
  trafficPercentage: 100, persistAssignment: false,
  variants: [
    { id: "vA", name: "A", weight: 50, changes: [] },
    { id: "vB", name: "B", weight: 50, changes: [] },
  ],
};
const cfg = {
  schemaVersion: 2, version: 1, siteId: "site_p", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {},
  goals: [{ id: "g_buy", name: "Buy", type: "CUSTOM", config: {} }], experiments: [exp], results: { forget: true, runs: { exp_001: RUN } },
};
const decisionBody = () => ({ v: 1, url: `https://${HOST}/lp/`, referrer: "", device: "mobile" });

type SendOpts = { contentType?: string | null; fetchSite?: string; cookie?: string; method?: string; envOverride?: Partial<Env> };
async function send(path: string, body: unknown, opts: SendOpts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.contentType !== null) headers.set("Content-Type", opts.contentType ?? "application/json");
  if (opts.fetchSite) headers.set("Sec-Fetch-Site", opts.fetchSite);
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  const method = opts.method ?? "POST";
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://${HOST}${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body) }),
    { ...env, DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...opts.envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** DO と KV に触れたかを数える(門は KV を読む前に断る) */
function spies() {
  const touched = { kv: 0, do: 0 };
  const envOverride: Partial<Env> = {
    CONFIG_KV: new Proxy(env.CONFIG_KV, {
      get(t, p) { const v = Reflect.get(t, p); if (p === "get") touched.kv++; return typeof v === "function" ? v.bind(t) : v; },
    }) as Env["CONFIG_KV"],
    VISITOR_PROFILE: new Proxy(env.VISITOR_PROFILE, {
      get(t, p) { const v = Reflect.get(t, p); if (p === "idFromName" || p === "get") touched.do++; return typeof v === "function" ? v.bind(t) : v; },
    }) as Env["VISITOR_PROFILE"],
  };
  return { touched, envOverride };
}

async function seedRows(vid: string): Promise<void> {
  const key = (await visitorKey(env, "site_p", vid))!;
  await env.RESULTS_DB!.batch([
    env.RESULTS_DB!.prepare("INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied) VALUES (?1, ?2, 'site_p', 'vA', 1, 'mobile', 'ok')").bind(RUN, key),
    env.RESULTS_DB!.prepare("INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at) VALUES (?1, 'g_buy', ?2, 2)").bind(RUN, key),
  ]);
}
const count = async (table: string) => (await env.RESULTS_DB!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  await applyD1Migrations(env.RESULTS_DB!, env.TEST_RESULTS_MIGRATIONS);
});
beforeEach(async () => {
  __resetEdgeCaches();
  await env.CONFIG_KV.put(kvKeys.host(HOST), "site_p");
  await env.CONFIG_KV.put(kvKeys.active("site_p"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_p", 1), JSON.stringify(cfg));
  await env.CONFIG_KV.put(kvKeys.settings("site_p"), JSON.stringify({ settingsVersion: 1, siteId: "site_p", mode: "B", hosts: [HOST] }));
  await env.RESULTS_DB!.batch([env.RESULTS_DB!.prepare("DELETE FROM participants"), env.RESULTS_DB!.prepare("DELETE FROM conversions")]);
});

describe("POST /__ab/* gate (B158, G05)", () => {
  it("text/plain consent revoke with a canonical cookie is rejected with 415, no Set-Cookie, results kept", async () => {
    const vid = generateVisitorId();
    await seedRows(vid);
    const { touched, envOverride } = spies();
    const res = await send("/__ab/decision", { kind: "consent", value: "denied" }, { contentType: "text/plain", cookie: `_ab_vid=${vid}`, envOverride });
    expect(res.status).toBe(415);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await count("participants")).toBe(1);
    expect(await count("conversions")).toBe(1);
    expect(touched.kv).toBe(0); // KV を読む前に断る
  });

  it("text/plain event is rejected with 415 without touching DO or results", async () => {
    const vid = generateVisitorId();
    const { touched, envOverride } = spies();
    const res = await send("/__ab/event", { type: "participant", v: 1, runId: RUN, variantId: "vA", device: "mobile", applied: "ok" }, { contentType: "text/plain", cookie: `_ab_vid=${vid}`, envOverride });
    expect(res.status).toBe(415);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(touched.do).toBe(0);
    expect(touched.kv).toBe(0);
    expect(await count("participants")).toBe(0);
  });

  it("missing Content-Type is rejected with 415", async () => {
    expect((await send("/__ab/decision", decisionBody(), { contentType: null })).status).toBe(415);
    expect((await send("/__ab/event", { type: "goal", goalId: "g_buy" }, { contentType: null })).status).toBe(415);
  });

  it("json-like but not application/json media types are rejected with 415", async () => {
    expect((await send("/__ab/decision", decisionBody(), { contentType: "application/jsonx" })).status).toBe(415);
    expect((await send("/__ab/decision", decisionBody(), { contentType: "text/json" })).status).toBe(415);
  });

  it.each(["same-site", "cross-site", "none"])("Sec-Fetch-Site: %s with json is rejected with 403 and no Set-Cookie", async (site) => {
    const vid = generateVisitorId();
    await seedRows(vid);
    const { touched, envOverride } = spies();
    const rev = await send("/__ab/decision", { kind: "consent", value: "denied" }, { fetchSite: site, cookie: `_ab_vid=${vid}`, envOverride });
    expect(rev.status).toBe(403);
    expect(rev.headers.getSetCookie()).toEqual([]);
    expect(await count("participants")).toBe(1);
    const ev = await send("/__ab/event", { type: "goal", goalId: "g_buy" }, { fetchSite: site, cookie: `_ab_vid=${vid}`, envOverride });
    expect(ev.status).toBe(403);
    expect(touched.kv).toBe(0);
    expect(touched.do).toBe(0);
  });

  it("application/json from the same origin keeps working", async () => {
    const res = await send("/__ab/decision", decisionBody(), { fetchSite: "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("_ab_vid="))).toBe(true);
    const vid = generateVisitorId();
    await seedRows(vid);
    const rev = await send("/__ab/decision", { kind: "consent", value: "denied" }, { fetchSite: "same-origin", cookie: `_ab_vid=${vid}` });
    expect(rev.status).toBe(204);
    expect(await count("participants")).toBe(0);
    const ev = await send("/__ab/event", { type: "participant", v: 1, runId: RUN, variantId: "vA", device: "mobile", applied: "ok" }, { fetchSite: "same-origin", cookie: `_ab_vid=${vid}` });
    expect(ev.status).toBe(200);
  });

  it("Sec-Fetch-Site is compared case-insensitively after trimming (Same-Origin passes)", async () => {
    // admin の originVerdict とそろえる(値は小文字のはずだが、大文字や前後の空白で正規の要求を断らない)
    expect((await send("/__ab/decision", decisionBody(), { fetchSite: "Same-Origin" })).status).toBe(200);
    expect((await send("/__ab/decision", decisionBody(), { fetchSite: " same-origin " })).status).toBe(200);
    expect((await send("/__ab/decision", decisionBody(), { fetchSite: "Cross-Site" })).status).toBe(403);
  });

  it("application/json; charset=utf-8 (any case, spaces) is accepted", async () => {
    expect((await send("/__ab/decision", decisionBody(), { contentType: "application/json; charset=utf-8" })).status).toBe(200);
    expect((await send("/__ab/decision", decisionBody(), { contentType: " Application/JSON ;charset=UTF-8" })).status).toBe(200);
  });

  it("json without Sec-Fetch-Site (non-browser / old browser) is accepted", async () => {
    expect((await send("/__ab/decision", decisionBody())).status).toBe(200);
  });

  it.each(["GET", "HEAD"])("%s /__ab/decision and /__ab/event are outside the gate (not 415/403)", async (method) => {
    // B139 §4.2: GET は導入の確認に使う(印が無ければ 503)。門の 415/403 にはならない
    await env.CONFIG_KV.put(kvKeys.installMarker, "marker-gate");
    // 印の有無は検証の対象外(ここでは門の外にあることだけを見る)
    for (const path of ["/__ab/decision", "/__ab/event"]) {
      const res = await send(path, undefined, { method, contentType: "text/plain", fetchSite: "cross-site" });
      expect(res.status).toBe(200);
    }
  });

  it("POST to /v1/sites/* is outside the gate (CORS path keeps its own checks)", async () => {
    const res = await send("/v1/sites/site_p/decision", decisionBody(), { contentType: "text/plain" });
    expect(res.status).not.toBe(415); // この門は /__ab/* だけ(/v1/sites/* の受け方は変えない)
  });
});
