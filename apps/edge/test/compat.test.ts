import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { generateVisitorId, kvKeys } from "@wtt/core";
import { COMPILED_V2 } from "../../../packages/core/test/fixtures/compiled-v2";
import app from "../src/index";
import { __resetEdgeCaches, loadConfig } from "../src/store";
import type { Env } from "../src/env";

const ORIGIN = "https://a.example";

/**
 * 版 1(v0.9 の内部版)の形の compiled config。版 1 の読み取りは backlog B52 で削除した(版 2 が公開の最初の版。設計書 §6.1 の 2026-10-08 の注記)ので、
 * KV に残っていても「未知の版」として扱う: parse は null、decision は空応答、Durable Object には触れない
 */
const SCHEMA_V1_CONFIG = {
  schemaVersion: 1, version: 7, siteId: "site_v1", siteSalt: "salt_v1", needsProfile: true,
  patterns: { p_pricing: { op: "contains", value: "/pricing" }, p_re: { op: "regex", value: "/docs/\\d+" } },
  prehide: { exp_v1: [] }, exposureSelectors: { exp_v1: [] },
  goals: [
    { id: "g_contains", name: "c", type: "PAGEVIEW", config: { urlOp: "contains", urlValue: "/thanks" } },
    { id: "g_regex", name: "r", type: "PAGEVIEW", config: { urlOp: "regex", urlValue: "/done\\?id=\\d+" } },
  ],
  experiments: [{
    id: "exp_v1", name: "v1", urlMatch: { op: "regex", value: "^https://a\\.example/(lp|top)/" },
    targeting: { and: [{ hist: "page_view_count", pattern: "p_pricing", gte: 2 }, { not: { ctx: "url", op: "regex", value: "\\?nope" } }] },
    trafficPercentage: 100, persistAssignment: false,
    variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
  }],
};

function doSpy(onTouch: () => void): Env["VISITOR_PROFILE"] {
  return new Proxy(env.VISITOR_PROFILE, {
    get(t, p) { const v = Reflect.get(t, p); if (p === "idFromName" || p === "get") onTouch(); return typeof v === "function" ? v.bind(t) : v; },
  }) as Env["VISITOR_PROFILE"];
}

async function request(path: string, init: RequestInit = {}, envOverride: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://edge.example${path}`, init),
    { ...env, DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const decision = (visitorId: string, url: string, envOverride: Partial<Env> = {}) =>
  request("/v1/sites/site_v1/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ v: 7, url, referrer: "", device: "desktop", visitorId }),
  }, envOverride);

beforeEach(async () => {
  __resetEdgeCaches();
  await env.CONFIG_KV.put(kvKeys.settings("site_v1"), JSON.stringify({ settingsVersion: 1, siteId: "site_v1", allowedOrigins: [ORIGIN] }));
  await env.CONFIG_KV.put(kvKeys.active("site_v1"), "7");
  await env.CONFIG_KV.put(kvKeys.config("site_v1", 7), JSON.stringify(SCHEMA_V1_CONFIG));
});

describe("版 1 の設定は未知の版(backlog B52。版 2 が公開の最初の版)", () => {
  it("schema_v1_config_is_treated_as_unknown: loadConfig は null、decision は空応答、DO に触れない", async () => {
    expect(await loadConfig(env, "site_v1", 7)).toBeNull();
    let touched = 0;
    const vid = generateVisitorId();
    const envOverride = { VISITOR_PROFILE: doSpy(() => touched++) };
    // 版 1 なら 2 回目の /pricing の後に exp_v1 が出ていた URL でも、何も出ない(版 1 の正規表現が RegExp で動く経路は無い)
    for (const url of ["https://a.example/pricing", "https://a.example/pricing", "https://a.example/lp/x"]) {
      const res = await decision(vid, url, envOverride);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ v: 7, experiments: [] });
    }
    expect(touched).toBe(0);
  });
});

/**
 * B69 spec §5: 版 2 の設定(KV に残った公開版)は parseCompiledConfig が upgradeV2 で版 3 に読み替えて配る。
 * 配信条件にページの条件(url / host / path / query)を持つエクスペリエンス(e_query)は外れ、ほかは今までどおり配る
 */
describe("版 2 の設定は版 3 に読み替えて配る(B69)", () => {
  const V2_ORIGIN = "https://www.example.com";
  const v2Decision = (v: number, envOverride: Partial<Env> = {}) =>
    request("/v1/sites/site_v2/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: V2_ORIGIN },
      // e_path_re(パスの正規表現)と e_host_re(ホストの正規表現 + 端末)に一致し、e_query も版 2 の規則なら一致する URL
      body: JSON.stringify({ v, url: `${V2_ORIGIN}/products/12?utm=mail`, referrer: "", device: "mobile", visitorId: generateVisitorId() }),
    }, envOverride);
  const ids = async (res: Response) => ((await res.json()) as { experiments: Array<{ id: string }> }).experiments.map((e) => e.id);

  beforeEach(async () => {
    await env.CONFIG_KV.put(kvKeys.settings("site_v2"), JSON.stringify({ settingsVersion: 1, siteId: "site_v2", allowedOrigins: [V2_ORIGIN] }));
    await env.CONFIG_KV.put(kvKeys.config("site_v2", 7), JSON.stringify(COMPILED_V2));
  });

  it("previous_schema_version_config_is_served: 持たない方を配り、持つ方を配らない", async () => {
    await env.CONFIG_KV.put(kvKeys.active("site_v2"), "7");
    const loaded = await loadConfig(env, "site_v2", 7);
    expect(loaded?.schemaVersion).toBe(3);
    expect(loaded?.experiments.map((e) => e.id)).toEqual(["e_path_re", "e_host_re", "e_plain"]);
    let touched = 0;
    const res = await v2Decision(7, { VISITOR_PROFILE: doSpy(() => touched++) });
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(["e_path_re", "e_host_re"]);
    expect(touched).toBe(0); // e_query(唯一の persistAssignment)が外れて needsProfile が false になる = ローカル評価
  });

  it("old_bootstrap_with_new_edge: 版 2 の公開版を body.v で指名した要求でも、外れたエクスペリエンスは配らない", async () => {
    // 公開済みの最新は版 3(版 8)。キャッシュに残った古い bootstrap が版 2 の 7 を指名する
    await env.CONFIG_KV.put(kvKeys.config("site_v2", 8), JSON.stringify({ ...COMPILED_V2, schemaVersion: 3, version: 8, needsProfile: false, prehide: {}, exposureSelectors: {}, experiments: [], exposurePayloads: {}, results: undefined }));
    await env.CONFIG_KV.put(kvKeys.active("site_v2"), "8");
    const res = await v2Decision(7);
    expect(res.status).toBe(200);
    const got = await ids(res);
    expect(got).not.toContain("e_query");
    expect(got).toEqual(["e_path_re", "e_host_re"]);
  });
});
