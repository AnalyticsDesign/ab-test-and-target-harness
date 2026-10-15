import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { compile, generateVisitorId, inTraffic, kvKeys, parseSiteSettings, patternIdOf, pickVariant, type Experiment } from "@wtt/core";
import { evaluateDecision } from "../src/decision";
import app from "../src/index";
import { PROFILE_KEY, profileStub, type ProfileRecord } from "../src/profile";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

const ORIGIN = "https://site.example";
const exp: Experiment = {
  id: "exp_001", name: "hero", urlMatch: { op: "contains", value: "/" },
  trafficPercentage: 100, persistAssignment: false,
  variants: [
    { id: "vA", name: "A", weight: 50, changes: [] },
    { id: "vB", name: "B", weight: 50, changes: [] },
  ],
};
const cfg = { schemaVersion: 2, version: 1, siteId: "site_d", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
const okBody = () => ({ v: 1, url: `${ORIGIN}/lp/`, referrer: "", device: "desktop", visitorId: generateVisitorId() });

async function post(path: string, body: unknown, opts: { origin?: string | null; envOverride?: Partial<Env>; raw?: string } = {}): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.origin !== null) headers.set("Origin", opts.origin ?? ORIGIN);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://edge.example${path}`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }),
    // rate limit を検証するテスト以外は常に通す stub を既定にする(実 binding の有無に依存しない)
    { ...env, DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...opts.envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function kvSpy(onGet: () => void): Env["CONFIG_KV"] {
  return new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "get") onGet();
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Env["CONFIG_KV"];
}

/** DO namespace の spy。idFromName / get のどちらに触れても数える(「DO 非接触」の証明用) */
function doSpy(onTouch: () => void): Env["VISITOR_PROFILE"] {
  return new Proxy(env.VISITOR_PROFILE, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "idFromName" || prop === "get") onTouch();
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Env["VISITOR_PROFILE"];
}
const readProfile = (siteId: string, visitorId: string) =>
  runInDurableObject(profileStub(env, siteId, visitorId), (_i, state) => state.storage.get<ProfileRecord>(PROFILE_KEY));

beforeEach(async () => {
  __resetEdgeCaches();
  await env.CONFIG_KV.put(kvKeys.settings("site_d"), JSON.stringify({ settingsVersion: 1, siteId: "site_d", allowedOrigins: [ORIGIN] }));
  await env.CONFIG_KV.put(kvKeys.active("site_d"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_d", 1), JSON.stringify(cfg));
  await env.CONFIG_KV.put(kvKeys.settings("site_empty"), JSON.stringify({ settingsVersion: 1, siteId: "site_empty" }));
  await env.CONFIG_KV.put(kvKeys.active("site_d"), "5"); // /event は active config を見る(Task 4)
  // needsProfile 用: p_pricing パターン、履歴条件付き実験(/lp)、persistAssignment 実験(/persist)
  await env.CONFIG_KV.put(kvKeys.config("site_d", 5), JSON.stringify({
    ...cfg, version: 5, needsProfile: true,
    patterns: { p_pricing: { op: "contains", value: "/pricing" } },
    goals: [{ id: "g_lead", name: "Lead", type: "CUSTOM", config: {} }],
    experiments: [
      { ...exp, id: "exp_lp", urlMatch: { op: "contains", value: "/lp" }, targeting: { hist: "visited", pattern: "p_pricing" } },
      { ...exp, id: "exp_conv", urlMatch: { op: "contains", value: "/lp" }, targeting: { hist: "converted", goal: "g_lead" } },
      { ...exp, id: "exp_persist", urlMatch: { op: "contains", value: "/persist" }, persistAssignment: true, trafficPercentage: 100 },
      { ...exp, id: "exp_here", urlMatch: { op: "contains", value: "/pricing" }, targeting: { hist: "visited", pattern: "p_pricing" } },
    ],
  }));
  await env.CONFIG_KV.put(kvKeys.settings("site_e"), JSON.stringify({ settingsVersion: 1, siteId: "site_e", allowedOrigins: [ORIGIN] }));
  await env.CONFIG_KV.put(kvKeys.active("site_e"), "5");
  await env.CONFIG_KV.put(kvKeys.config("site_e", 5), JSON.stringify({ ...cfg, siteId: "site_e", version: 5, needsProfile: true, patterns: { p_pricing: { op: "contains", value: "/pricing" } }, experiments: [{ ...exp, id: "exp_lp", urlMatch: { op: "contains", value: "/lp" }, targeting: { hist: "visited", pattern: "p_pricing" } }] }));
});

describe("POST /v1/sites/:siteId/decision", () => {
  it("returns the deterministic assignment with CORS echo", async () => {
    const body = okBody();
    const res = await post("/v1/sites/site_d/decision", body);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Vary")).toBe("Origin");
    const out = (await res.json()) as { v: number; experiments: Array<{ id: string; variant: string }> };
    expect(out).toEqual({ v: 1, experiments: [{ id: "exp_001", variant: pickVariant(exp, body.visitorId) }] });
  });
  it("missing_site_path_returns_404_without_kv_or_do_access", async () => {
    let touched = 0;
    const envOverride = { CONFIG_KV: kvSpy(() => touched++), VISITOR_PROFILE: doSpy(() => touched++) };
    expect((await post("/v1/sites//decision", okBody(), { envOverride })).status).toBe(404);
    expect((await post("/v1/sites/decision", okBody(), { envOverride })).status).toBe(404);
    // siteId の形式外(長すぎ・不正文字)も KV に触れる前に 404(SITE_ID_RE)
    expect((await post("/v1/sites/" + "x".repeat(65) + "/decision", okBody(), { envOverride })).status).toBe(404);
    expect((await post("/v1/sites/bad$site/decision", okBody(), { envOverride })).status).toBe(404);
    expect(touched).toBe(0);
  });
  it("invalid_visitor_id_400", async () => {
    // 22 文字は canonical + v4 / v7 のみ受理(spec §9.5)
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "A".repeat(22) })).status).toBe(400);
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: undefined })).status).toBe(400);
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), v: undefined })).status).toBe(400);
    const res = await post("/v1/sites/site_d/decision", null, { raw: "{ not json" });
    expect(res.status).toBe(400);
  });
  it("mode_c_sha256_id_is_accepted", async () => {
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "B".repeat(43) })).status).toBe(200);
  });
  it("malformed_mode_c_id_is_rejected", async () => {
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "B".repeat(42) + "+" })).status).toBe(400);
    expect((await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "B".repeat(42) })).status).toBe(400);
  });
  it("body_over_4kb_413", async () => {
    const res = await post("/v1/sites/site_d/decision", null, { raw: JSON.stringify({ ...okBody(), url: "https://x/" + "a".repeat(5000) }) });
    expect(res.status).toBe(413);
    // 境界: ちょうど 4096 バイトは 413 にしない / 4097 バイトは 413。raw のバイト長を assert してから送る。
    // パディングは url / referrer に折半する(どちらも schema 上限 2048 のため、片側だけでは 4096 に届かない)
    const enc = new TextEncoder();
    const fill = (bytes: number): { raw: string; url: string; referrer: string } => {
      const base = okBody();
      const pad = bytes - enc.encode(JSON.stringify(base)).length;
      const urlPad = Math.ceil(pad / 2);
      const body = { ...base, url: base.url + "a".repeat(urlPad), referrer: "a".repeat(pad - urlPad) };
      return { raw: JSON.stringify(body), url: body.url, referrer: body.referrer };
    };
    const b4096 = fill(4096);
    expect(enc.encode(b4096.raw).length).toBe(4096);
    expect(b4096.url.length).toBeLessThanOrEqual(2048); // 200 が「上限内」の証明になるよう schema 上限内であることを固定する
    expect(b4096.referrer.length).toBeLessThanOrEqual(2048);
    // 4096 ちょうどは上限内(§9.5 は「4KB 超」が 413)。url 不一致でも 200 + experiments: []
    expect((await post("/v1/sites/site_d/decision", null, { raw: b4096.raw })).status).toBe(200);
    const b4097 = fill(4097);
    expect(enc.encode(b4097.raw).length).toBe(4097);
    expect((await post("/v1/sites/site_d/decision", null, { raw: b4097.raw })).status).toBe(413);
  });
  it("allowed_origins_empty_403", async () => {
    expect((await post("/v1/sites/site_empty/decision", okBody())).status).toBe(403);
  });
  it("cors_origin_mismatch_403", async () => {
    expect((await post("/v1/sites/site_d/decision", okBody(), { origin: "https://evil.example" })).status).toBe(403);
  });
  it("origin_null_403", async () => {
    expect((await post("/v1/sites/site_d/decision", okBody(), { origin: "null" })).status).toBe(403);
    expect((await post("/v1/sites/site_d/decision", okBody(), { origin: null })).status).toBe(403);
    expect((await post("/v1/sites/site_d/decision", okBody(), { origin: "*" })).status).toBe(403);
  });
  it("mode_b_site_rejects_browser_direct_decision", async () => {
    await env.CONFIG_KV.put(kvKeys.settings("site_dl"), JSON.stringify({ settingsVersion: 1, siteId: "site_dl", mode: "B", hosts: ["site.example"], allowedOrigins: [ORIGIN] }));
    expect((await post("/v1/sites/site_dl/decision", okBody())).status).toBe(404);
    // OPTIONS preflight も Mode B は 404(§7.1: ブラウザ直接経路は Mode A のみ、POST/OPTIONS 両方)
    const ctx = createExecutionContext();
    const pre = await app.fetch(
      new Request("https://edge.example/v1/sites/site_dl/decision", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(pre.status).toBe(404);
  });
  it("error_responses_cors_policy(ACAO は Origin 検証通過後の 200 のみ)", async () => {
    const res400 = await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "A".repeat(22) });
    expect(res400.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const res200 = await post("/v1/sites/site_d/decision", okBody());
    expect(res200.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
  it("rate_limit_exceeded_returns_429_without_do_creation", async () => {
    // 形式検証の後・Origin 検証 = KV 参照の前(§9.5 の順序)
    let touched = 0;
    const envOverride: Partial<Env> = {
      CONFIG_KV: kvSpy(() => touched++),
      VISITOR_PROFILE: doSpy(() => touched++),
      DECISION_RATE_LIMITER: { limit: async () => ({ success: false }) },
    };
    const res = await post("/v1/sites/site_d/decision", okBody(), { envOverride });
    expect(res.status).toBe(429);
    expect(touched).toBe(0); // KV(settings)にも DO にも触れないことで §9.5 の順序を証明
    // 形式不正はレート制限より先に 400(§9.5 の順序)
    const res400 = await post("/v1/sites/site_d/decision", { ...okBody(), visitorId: "A".repeat(22) }, { envOverride });
    expect(res400.status).toBe(400);
  });
  it("rate limiter binding が無いときは通す(fail-open、決定 29)", async () => {
    expect((await post("/v1/sites/site_d/decision", okBody(), { envOverride: { DECISION_RATE_LIMITER: undefined } })).status).toBe(200);
  });
  it("rate_limiter_exception_logs_and_fails_open", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/v1/sites/site_d/decision", okBody(), { envOverride: { DECISION_RATE_LIMITER: { limit: async () => { throw new Error("boom"); } } } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled(); // 決定 29: fail-open は無音にしない
    spy.mockRestore();
  });
  it("rate_limiter_missing_ip_uses_unknown_key", async () => {
    let seenKey = "";
    const envOverride: Partial<Env> = {
      DECISION_RATE_LIMITER: { limit: async ({ key }) => { seenKey = key; return { success: true }; } },
    };
    expect((await post("/v1/sites/site_d/decision", okBody(), { envOverride })).status).toBe(200);
    expect(seenKey).toBe("unknown"); // 決定 29: CF-Connecting-IP 欠落は共通 key
  });
  it("decision_with_unknown_version_returns_empty", async () => {
    const res = await post("/v1/sites/site_d/decision", { ...okBody(), v: 99 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 99, experiments: [] });
  });
  // spec 18.1 の edge 半分: schemaVersion 3 の config は未知 version と同じ空応答になる(core 半分は CompiledConfigSchema の拒否)
  it("unsupported_compiled_config_version_is_rejected", async () => {
    await env.CONFIG_KV.put(kvKeys.config("site_d", 2), JSON.stringify({ ...cfg, schemaVersion: 3, version: 2 }));
    const res = await post("/v1/sites/site_d/decision", { ...okBody(), v: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 2, experiments: [] });
  });
  it("unknown site 404 / preflight OPTIONS", async () => {
    expect((await post("/v1/sites/s_none/decision", okBody())).status).toBe(404);
    const ctx = createExecutionContext();
    const pre = await app.fetch(
      new Request("https://edge.example/v1/sites/site_d/decision", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });
  it("rate limited response carries Retry-After (plan 2 ride-along)", async () => {
    // 既存の 429 テストと同じ limiter stub を明示的に渡す
    const res = await post("/v1/sites/site_d/decision", okBody(), {
      envOverride: { DECISION_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });
});

describe("POST /v1/sites/:siteId/decision with the visitor profile (spec §7.4)", () => {
  const vid = () => generateVisitorId();
  const body = (url: string, visitorId: string) => ({ v: 5, url: `${ORIGIN}${url}`, referrer: "", device: "desktop", visitorId });
  const ids = async (res: Response) => ((await res.json()) as { experiments: Array<{ id: string }> }).experiments.map((e) => e.id);

  it("パターンだけ一致するページの閲覧が、別のページの閲覧の条件で効く", async () => {
    const v = vid();
    // /pricing には exp_here があるが、site_e には実験が無くパターンだけ一致する
    const first = await post("/v1/sites/site_e/decision", body("/pricing", v));
    expect(first.status).toBe(200);
    expect(await ids(first)).toEqual([]); // 実験は無いが Profile には記録される
    expect((await readProfile("site_e", v))!.pages.p_pricing!.count).toBe(1);
    expect(await ids(await post("/v1/sites/site_e/decision", body("/lp", v)))).toEqual(["exp_lp"]); // 別ページで履歴条件が成立
  });
  it("今のページの閲覧を評価の前に数える", async () => {
    // 現在ページの page_view を評価の前に加算するので、初回訪問の同じページで visited が真になる(§7.4 ④)
    expect(await ids(await post("/v1/sites/site_d/decision", body("/pricing", vid())))).toEqual(["exp_here"]);
  });
  it("visited_min_qualifies_on_nth_matching_decision", async () => {
    // hist visited(min 2): 1 回目の /pricing は不成立、2 回目で成立(現在ページを加算してから評価する)
    const v = vid();
    const raw = JSON.parse((await env.CONFIG_KV.get(kvKeys.config("site_d", 5)))!);
    raw.version = 7;
    raw.experiments = [{ ...exp, id: "exp_twice", urlMatch: { op: "contains", value: "/pricing" }, targeting: { hist: "visited", pattern: "p_pricing", min: 2 } }];
    await env.CONFIG_KV.put(kvKeys.config("site_d", 7), JSON.stringify(raw));
    expect(await ids(await post("/v1/sites/site_d/decision", { ...body("/pricing", v), v: 7 }))).toEqual([]);
    expect(await ids(await post("/v1/sites/site_d/decision", { ...body("/pricing", v), v: 7 }))).toEqual(["exp_twice"]);
  });
  it("ページの閲覧は 1 回の decision で 1 回だけ数え、/event では数えない", async () => {
    const v = vid();
    await post("/v1/sites/site_d/decision", body("/pricing", v));
    expect((await readProfile("site_d", v))!.pages.p_pricing!.count).toBe(1);
    // 別ページ(パターン不一致)の decision では加算しない
    await post("/v1/sites/site_d/decision", body("/lp", v));
    expect((await readProfile("site_d", v))!.pages.p_pricing!.count).toBe(1);
    // §9.2: /event は page_view を数えない(goal だけ増える)
    expect((await post("/v1/sites/site_d/event", { type: "goal", goalId: "g_lead", visitorId: v })).status).toBe(204);
    expect((await readProfile("site_d", v))!.pages.p_pricing!.count).toBe(1);
    expect((await readProfile("site_d", v))!.goals.g_lead!.count).toBe(1);
  });
  it("cross_site_profile_isolation", async () => {
    const v = vid();
    await post("/v1/sites/site_d/decision", body("/pricing", v));
    expect(await ids(await post("/v1/sites/site_e/decision", body("/lp", v)))).toEqual([]); // site_e の Profile には site_d の閲覧が無い
    expect((await readProfile("site_e", v))!.pages).toEqual({}); // /lp は exp_lp に一致するので DO は作られるが、pages は空
    expect((await readProfile("site_d", v))!.pages.p_pricing!.count).toBe(1);
  });
  it("no_experiment_and_no_pattern_match_skips_the_profile", async () => {
    let touched = 0;
    const res = await post("/v1/sites/site_d/decision", body("/about", vid()), { envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } });
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([]);
    expect(touched).toBe(0); // §7.4 ③
  });
  it("persisted_assignment_wins_over_traffic_reduction", async () => {
    // 約 1% の訪問者は traffic 1% を素通りし、保存済み割当が無くても一致してしまう。inTraffic が偽になる ID で固定する(r1 CL-Low-1)
    let v = vid();
    while (inTraffic(v, "exp_persist", 1)) v = vid();
    const first = (await (await post("/v1/sites/site_d/decision", body("/persist", v))).json()) as { experiments: Array<{ id: string; variant: string }> };
    expect(first.experiments).toEqual([{ id: "exp_persist", variant: expect.stringMatching(/^v[AB]$/) }]);
    // trafficPercentage を 1 に下げた version 6 でも、保存済み割当を持つ訪問者は同じ Variant を受け取る(決定 28)
    const raw = JSON.parse((await env.CONFIG_KV.get(kvKeys.config("site_d", 5)))!);
    raw.version = 6;
    raw.experiments = raw.experiments.map((e: { id: string }) => (e.id === "exp_persist" ? { ...e, trafficPercentage: 1 } : e));
    await env.CONFIG_KV.put(kvKeys.config("site_d", 6), JSON.stringify(raw));
    const second = (await (await post("/v1/sites/site_d/decision", { ...body("/persist", v), v: 6 })).json()) as { experiments: Array<{ id: string; variant: string }> };
    expect(second.experiments).toEqual(first.experiments);
  });
  it("profile_failure_returns_503", async () => {
    const broken = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ decide: async () => { throw new Error("do down"); } }),
    } as unknown as Env["VISITOR_PROFILE"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/v1/sites/site_d/decision", body("/pricing", vid()), { envOverride: { VISITOR_PROFILE: broken } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it("needsProfile=false の config は従来どおり DO に触れずローカル評価する", async () => {
    let touched = 0;
    const res = await post("/v1/sites/site_d/decision", okBody(), { envOverride: { VISITOR_PROFILE: doSpy(() => touched++) } });
    expect(res.status).toBe(200);
    expect(touched).toBe(0);
  });
});

describe("決定 49: 判定の入力(設計書 §11.1)", () => {
  /** needsProfile: false の版 2 の config を compile で作って KV に置く(v = 20) */
  async function seedV2(experiments: Array<{ id: string; targeting?: unknown; persistAssignment?: boolean }>, timezone?: string): Promise<void> {
    const config = compile({
      siteId: "site_d", siteSalt: "salt_test", version: 20, ...(timezone ? { timezone } : {}), goals: [],
      experiments: experiments.map((e) => ({
        id: e.id, name: e.id, urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: e.persistAssignment ?? false,
        ...(e.targeting ? { targeting: e.targeting } : {}),
        variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
      })),
    });
    await env.CONFIG_KV.put(kvKeys.config("site_d", 20), JSON.stringify(config));
  }
  const ids = async (res: Response) => ((await res.json()) as { experiments: Array<{ id: string }> }).experiments.map((e) => e.id);

  it("old_runtime_body_without_new_fields_keeps_other_experiments", async () => {
    // 古い runtime(bootstrap の 60 秒キャッシュ)は browser / os / firstVisitAt を送らない。新しい条件を含むものだけが対象外
    await seedV2([{ id: "e_plain" }, { id: "e_safari", targeting: { ctx: "browser", op: "in", value: ["safari"] } }]);
    expect(await ids(await post("/v1/sites/site_d/decision", { ...okBody(), v: 20 }))).toEqual(["e_plain"]);
    expect(await ids(await post("/v1/sites/site_d/decision", { ...okBody(), v: 20, browser: "safari", os: "ios" }))).toEqual(["e_plain", "e_safari"]);
  });

  it("画面の幅・初回の訪問からの経過は body の値で判定する(viewport が無ければ対象外)", async () => {
    await seedV2([{ id: "e_wide", targeting: { ctx: "viewport", minWidth: 768 } }, { id: "e_new", targeting: { ctx: "sinceFirstVisit", op: "lt", days: 1 } }]);
    const base = { ...okBody(), v: 20 };
    expect(await ids(await post("/v1/sites/site_d/decision", base))).toEqual([]);
    expect(await ids(await post("/v1/sites/site_d/decision", { ...base, viewport: { w: 1024, h: 800 }, firstVisitAt: Date.now() - 60_000 }))).toEqual(["e_wide", "e_new"]);
    expect(await ids(await post("/v1/sites/site_d/decision", { ...base, viewport: { w: 390, h: 800 }, firstVisitAt: null }))).toEqual([]); // null = 古い訪問者
  });

  it("DO で判定するときも edge が決めた判定時刻とサイトのタイムゾーンを渡す", async () => {
    // persistAssignment で needsProfile が立ち DO を通る。終日・全曜日の時間帯はタイムゾーンと判定時刻があれば必ず真
    const allDays = { ctx: "time", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] };
    await seedV2([{ id: "e_time", targeting: allDays, persistAssignment: true }], "Asia/Tokyo");
    expect(await ids(await post("/v1/sites/site_d/decision", { ...okBody(), v: 20 }))).toEqual(["e_time"]);
    await seedV2([{ id: "e_time", targeting: allDays, persistAssignment: true }]); // タイムゾーン無し = 判定できない
    __resetEdgeCaches();
    expect(await ids(await post("/v1/sites/site_d/decision", { ...okBody(), v: 20 }))).toEqual([]);
  });

  it("invalid_history_pattern_under_not_never_qualifies(DO 経由: 不正なパターンを参照する X は対象外、Y は配信される)", async () => {
    const variants = [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }];
    const config = compile({
      siteId: "site_d", siteSalt: "salt_test", version: 20, goals: [],
      experiments: [
        { id: "X", name: "X", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false, targeting: { not: { hist: "visited", page: { op: "contains", value: "/never" } } }, variants },
        { id: "Y", name: "Y", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false, variants },
      ],
    });
    // compile は不正な命令列を作らないので、配る形を書き換える(手書き・改竄の再現)。zod は形だけを見るので読み込みは通る
    const [pid] = Object.keys(config.patterns);
    config.patterns[pid!] = { part: "path", op: "regex", value: "x", prog: { v: 1, sets: [], code: [9, 0, 0] } };
    await env.CONFIG_KV.put(kvKeys.config("site_d", 20), JSON.stringify(config));
    __resetEdgeCaches();
    // 空の Profile(新しい訪問者)でも not(visited(p)) の X は配信されない
    expect(await ids(await post("/v1/sites/site_d/decision", { ...okBody(), v: 20 }))).toEqual(["Y"]);
  });
});

describe("閲覧の条件(保存する形の page から compile した版 2。決定 49)", () => {
  const PRICING = { part: "path", op: "startsWith", value: "/pricing" } as const;
  const PID = patternIdOf(PRICING);
  const variants = [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }];
  const e = (id: string, path: string, targeting?: unknown) => ({
    id, name: id, urlMatch: { part: "path", op: "startsWith", value: path }, trafficPercentage: 100, persistAssignment: false, ...(targeting ? { targeting } : {}), variants,
  });
  const LEAD = [{ id: "g_lead", name: "Lead", type: "CUSTOM", config: {} }];
  async function seed(siteId: string, experiments: unknown[], goals: unknown[] = []) {
    const config = compile({ siteId, siteSalt: "salt_test", version: 30, retentionDays: 90, goals, experiments });
    await env.CONFIG_KV.put(kvKeys.config(siteId, 30), JSON.stringify(config));
    await env.CONFIG_KV.put(kvKeys.active(siteId), "30");
    __resetEdgeCaches();
    return config;
  }
  const body = (url: string, visitorId: string) => ({ v: 30, url: `${ORIGIN}${url}`, referrer: "", device: "desktop" as const, visitorId });
  const ids = async (res: Response) => ((await res.json()) as { experiments: Array<{ id: string }> }).experiments.map((x) => x.id);

  it("visited_page_without_experiment_then_qualify_elsewhere", async () => {
    await seed("site_e", [e("exp_lp", "/lp", { hist: "visited", page: PRICING })]);
    const v = generateVisitorId();
    expect(await ids(await post("/v1/sites/site_e/decision", body("/pricing", v)))).toEqual([]); // 実験は無いが Profile には記録される
    expect((await readProfile("site_e", v))!.pages[PID]!.count).toBe(1);
    expect(await ids(await post("/v1/sites/site_e/decision", body("/lp", v)))).toEqual(["exp_lp"]);
  });
  it("current_page_history_semantics", async () => {
    // 今のページの閲覧を評価の前に数えるので、初めての訪問の同じページで閲覧の条件が真になる(§7.4 ④)
    await seed("site_d", [e("exp_here", "/pricing", { hist: "visited", page: PRICING })]);
    expect(await ids(await post("/v1/sites/site_d/decision", body("/pricing", generateVisitorId())))).toEqual(["exp_here"]);
  });
  it("page_view_counted_exactly_once", async () => {
    await seed("site_d", [e("exp_lp", "/lp", { hist: "visited", page: PRICING })], LEAD);
    const v = generateVisitorId();
    await post("/v1/sites/site_d/decision", body("/pricing", v));
    expect((await readProfile("site_d", v))!.pages[PID]!.count).toBe(1);
    await post("/v1/sites/site_d/decision", body("/lp", v)); // 別のページ(パターンに一致しない)では数えない
    expect((await readProfile("site_d", v))!.pages[PID]!.count).toBe(1);
    expect((await post("/v1/sites/site_d/event", { type: "goal", goalId: "g_lead", visitorId: v })).status).toBe(204); // §9.2: /event は閲覧を数えない
    expect((await readProfile("site_d", v))!.pages[PID]!.count).toBe(1);
    expect((await readProfile("site_d", v))!.goals.g_lead!.count).toBe(1);
  });
  it("DO は edge が決めた判定時刻でページの lastAt を打ち、期間の条件もその時刻で判定する(plan ② P11)", async () => {
    const config = await seed("site_d", [e("e_recent", "/lp", { hist: "visited", page: PRICING, withinDays: 7 })]);
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_d", retentionDays: 90 })!;
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 9, 6, 1, 0);
    const at = async (url: string, vid: string, t: number) =>
      (await evaluateDecision(env as unknown as Env, "site_d", settings, config, body(url, vid), vid, null, t))!.experiments.map((x) => x.id);
    const old = generateVisitorId();
    expect(await at("/pricing", old, now - 10 * DAY)).toEqual([]);
    expect((await readProfile("site_d", old))!.pages[PID]!.lastAt).toBe(Math.floor((now - 10 * DAY) / 1000));
    expect(await at("/lp", old, now)).toEqual([]); // 最後の閲覧が 10 日前 > 7 日
    const recent = generateVisitorId();
    await at("/pricing", recent, now - 3 * DAY);
    expect(await at("/lp", recent, now)).toEqual(["e_recent"]);
  });
  it("unmatchable_visited_pattern_excludes_experiment(256 字を超えるパスでは、パスの正規表現の閲覧の条件を数えも判定もしない = not の下でも対象外)", async () => {
    await seed("site_d", [e("X", "/", { not: { hist: "visited", page: { part: "path", op: "regex", value: "^/pricing" } } }), e("Y", "/", { not: { hist: "visited", page: PRICING } })]);
    const v = generateVisitorId();
    expect(await ids(await post("/v1/sites/site_d/decision", body("/lp", v)))).toEqual(["X", "Y"]);
    expect(await ids(await post("/v1/sites/site_d/decision", body(`/${"x".repeat(300)}`, v)))).toEqual(["Y"]);
  });
});
