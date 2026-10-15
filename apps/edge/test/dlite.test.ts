import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { compile, deriveExternalUuid, generateVisitorId, isCanonicalModeAId, kvKeys, pickVariant, uuidToVisitorId, visitorIdIssuedAt, visitorIdToUuid, type Experiment } from "@wtt/core";
import app from "../src/index";
import { PROFILE_KEY, profileStub, type ProfileRecord } from "../src/profile";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

const HOST = "site.example";
const exp: Experiment = {
  id: "exp_001", name: "hero", urlMatch: { op: "contains", value: "/" },
  trafficPercentage: 100, persistAssignment: false,
  variants: [
    { id: "vA", name: "A", weight: 50, changes: [] },
    { id: "vB", name: "B", weight: 50, changes: [] },
  ],
};
const cfg = { schemaVersion: 2, version: 1, siteId: "site_p", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
const decisionBody = () => ({ v: 1, url: `https://${HOST}/lp/`, referrer: "", device: "mobile" });

async function seedSettings(overrides: Record<string, unknown> = {}): Promise<void> {
  await env.CONFIG_KV.put(
    kvKeys.settings("site_p"),
    JSON.stringify({ settingsVersion: 1, siteId: "site_p", mode: "B", hosts: [HOST], ...overrides }),
  );
}

async function post(body: unknown, cookie?: string, envOverride: Partial<Env> = {}): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://${HOST}/__ab/decision`, { method: "POST", headers, body: JSON.stringify(body) }), { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function cookieByName(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}
function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0]!.split("=").slice(1).join("=");
}

beforeEach(async () => {
  __resetEdgeCaches();
  await env.CONFIG_KV.put(kvKeys.host(HOST), "site_p");
  await env.CONFIG_KV.put(kvKeys.active("site_p"), "1");
  await env.CONFIG_KV.put(kvKeys.config("site_p", 1), JSON.stringify(cfg));
  await seedSettings();
});

describe("POST /__ab/decision (spec §9.6 / §5.4 / §16)", () => {
  it("issues canonical cookie (HttpOnly) when missing and evaluates with it", async () => {
    const res = await post(decisionBody());
    expect(res.status).toBe(200);
    const set = cookieByName(res, "_ab_vid")!;
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=31536000");
    expect(set).toContain("Secure");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    const vid = cookieValue(set);
    expect(isCanonicalModeAId(vid)).toBe(true);
    const out = (await res.json()) as { v: number; experiments: Array<{ id: string; variant: string }> };
    expect(out).toEqual({ v: 1, experiments: [{ id: "exp_001", variant: pickVariant(exp, vid) }] });
  });
  it("uuid_cookie_disabled_by_default", async () => {
    const res = await post(decisionBody());
    expect(cookieByName(res, "_ab_uuid")).toBeUndefined(); // 既定オフ(spec §5.4)
  });
  it("d_lite_requires_mode_b_and_host_membership", async () => {
    await seedSettings({ mode: "A" });
    expect((await post(decisionBody())).status).toBe(404);
    __resetEdgeCaches(); // settings は 60 秒キャッシュされるため seed し直したら明示的に破棄する
    await seedSettings({ hosts: ["other.example"] });
    expect((await post(decisionBody())).status).toBe(404);
  });
  it("d_lite_invalid_mapped_site_id_returns_404_without_settings_lookup", async () => {
    await env.CONFIG_KV.put(kvKeys.host("evil.example"), "x".repeat(65));
    let gets = 0;
    const spy = {
      ...env,
      CONFIG_KV: new Proxy(env.CONFIG_KV, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          if (prop === "get") gets++;
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as typeof env.CONFIG_KV,
    };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://evil.example/__ab/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decisionBody()) }),
      spy, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(gets).toBe(1); // host mapping の 1 回のみ。settings は引かない
  });
  it("d_lite_reissues_existing_cookies_with_fresh_max_age", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    const vid = generateVisitorId();
    const res = await post(decisionBody(), `_ab_vid=${vid}; _ab_uuid=${visitorIdToUuid(vid)}`);
    const canonical = cookieByName(res, "_ab_vid")!;
    expect(cookieValue(canonical)).toBe(vid); // 既存 Cookie は必ず再利用(spec §5.4)
    expect(canonical).toContain("Max-Age=31536000");
    const uuid = cookieByName(res, "_ab_uuid")!;
    expect(cookieValue(uuid)).toBe(await deriveExternalUuid("salt_test", vid)); // 正本から導出した v4(決定 49 §7.2)
    expect(uuid).not.toContain("HttpOnly"); // JS 可読が目的(spec §5.4)
    expect(uuid).toContain("Max-Age=31536000");
  });
  it("invalid canonical cookie is not reused (spec §5.4: 再利用せず新規発行)", async () => {
    const res = await post(decisionBody(), `_ab_vid=${"A".repeat(22)}`);
    const vid = cookieValue(cookieByName(res, "_ab_vid")!);
    expect(vid).not.toBe("A".repeat(22));
    expect(isCanonicalModeAId(vid)).toBe(true);
  });
  it("uuid_cookie_cannot_seed_canonical_identity", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    const foreign = "12345678-1234-4123-8123-123456789abc";
    const res = await post(decisionBody(), `_ab_uuid=${foreign}`);
    const vid = cookieValue(cookieByName(res, "_ab_vid")!);
    expect(vid).not.toBe(uuidToVisitorId(foreign)); // UUID Cookie は読まない = 復元しない
    expect(cookieValue(cookieByName(res, "_ab_uuid")!)).toBe(await deriveExternalUuid("salt_test", vid)); // 新 ID から導出して上書き
  });
  it("tampered_uuid_cookie_is_overwritten_from_canonical", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    const vid = generateVisitorId();
    const res = await post(decisionBody(), `_ab_vid=${vid}; _ab_uuid=12345678-1234-4123-8123-123456789abc`);
    expect(cookieValue(cookieByName(res, "_ab_uuid")!)).toBe(await deriveExternalUuid("salt_test", vid));
  });
  it("rename_deletes_old_cookie_and_never_revives_old_identity", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ visitorCookieName: "_ab_vid2", previousCookieNames: [{ name: "_ab_vid", until: 2000000000 }] });
    const oldId = generateVisitorId();
    const res = await post(decisionBody(), `_ab_vid=${oldId}`);
    const del = cookieByName(res, "_ab_vid")!;
    expect(del).toContain("Max-Age=0"); // 旧名は再利用せず削除(spec §5.4 migration)
    const newSet = cookieByName(res, "_ab_vid2")!;
    expect(cookieValue(newSet)).not.toBe(oldId);
  });
  it("disable_uuid_cookie_deletes_previous_alias", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ uuidCookieEnabled: false, previousCookieNames: [{ name: "_ab_uuid", until: 2000000000 }] });
    const vid = generateVisitorId();
    const res = await post(decisionBody(), `_ab_vid=${vid}; _ab_uuid=${visitorIdToUuid(vid)}`);
    expect(cookieByName(res, "_ab_uuid")).toContain("Max-Age=0");
    expect(cookieValue(cookieByName(res, "_ab_vid")!)).toBe(vid);
  });
  it("configured_cookie_names_are_used_by_runtime_and_edge", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ visitorCookieName: "_my_id", uuidCookieEnabled: true, uuidCookieName: "_my_uuid" });
    const res = await post(decisionBody());
    expect(cookieByName(res, "_my_id")).toBeDefined();
    expect(cookieByName(res, "_my_uuid")).toBeDefined();
    expect(cookieByName(res, "_ab_vid")).toBeUndefined();
  });
  it("d_lite_revoke_clears_both_cookies", async () => {
    // DO へ転送しない = 204 で完結(spec §16)
    await seedSettings({ uuidCookieEnabled: true });
    const vid = generateVisitorId();
    let touched = 0;
    const spy = new Proxy(env.VISITOR_PROFILE, { get(t, p) { const v = Reflect.get(t, p); if (p === "idFromName" || p === "get") touched++; return typeof v === "function" ? v.bind(t) : v; } }) as Env["VISITOR_PROFILE"];
    const res = await post({ kind: "consent", value: "denied" }, `_ab_vid=${vid}; _ab_uuid=${visitorIdToUuid(vid)}`, { VISITOR_PROFILE: spy });
    expect(touched).toBe(0); // §16: revoke は DO 非接触(Plan 5 の最終証明)
    expect(res.status).toBe(204);
    expect(cookieByName(res, "_ab_vid")).toContain("Max-Age=0");
    expect(cookieByName(res, "_ab_uuid")).toContain("Max-Age=0");
    // 削除も発行時と同じ属性(正本は HttpOnly、UUID は HttpOnly なし)
    expect(cookieByName(res, "_ab_vid")).toContain("HttpOnly");
    expect(cookieByName(res, "_ab_uuid")).not.toContain("HttpOnly");
    for (const sc of res.headers.getSetCookie()) expect(sc).not.toContain("Max-Age=31536000"); // 新規発行しない
  });
  it("unknown version keeps Set-Cookie and returns empty experiments (spec §9.3 のエラー時挙動に整合)", async () => {
    const res = await post({ ...decisionBody(), v: 9 });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ v: 9, experiments: [] });
    expect(cookieByName(res, "_ab_vid")).toBeDefined();
  });
  it("unknown host 404 / bad body 400", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://unknown.example/__ab/decision", { method: "POST", body: JSON.stringify(decisionBody()) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect((await post({ v: 1 })).status).toBe(400);
    expect((await post({ kind: "consent", value: "granted" })).status).toBe(400);
  });
  it("d-lite decision uses the cookie identity for the profile (spec §9.6 + §7.4)", async () => {
    await env.CONFIG_KV.put(kvKeys.config("site_p", 2), JSON.stringify({ ...cfg, version: 2, needsProfile: true, patterns: { p_lp: { op: "contains", value: "/lp" } }, experiments: [{ ...exp, targeting: { hist: "visited", pattern: "p_lp" } }] }));
    const vid = generateVisitorId();
    const res = await post({ ...decisionBody(), v: 2 }, `_ab_vid=${vid}`);
    expect((await res.json()) as object).toEqual({ v: 2, experiments: [{ id: "exp_001", variant: pickVariant(exp, vid) }] });
    const p = await runInDurableObject(profileStub(env, "site_p", vid), (_i, state) => state.storage.get<ProfileRecord>(PROFILE_KEY));
    expect(p!.pages.p_lp!.count).toBe(1);
  });
  it("d_lite_profile_failure_returns_503_but_still_sets_the_cookie", async () => {
    await env.CONFIG_KV.put(kvKeys.config("site_p", 2), JSON.stringify({ ...cfg, version: 2, needsProfile: true, patterns: { p_lp: { op: "contains", value: "/lp" } }, experiments: [{ ...exp, targeting: { hist: "visited", pattern: "p_lp" } }] }));
    const broken = { idFromName: () => ({}) as DurableObjectId, get: () => ({ decide: async () => { throw new Error("do down"); } }) } as unknown as Env["VISITOR_PROFILE"];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ ...decisionBody(), v: 2 }, undefined, { VISITOR_PROFILE: broken });
    spy.mockRestore();
    expect(res.status).toBe(503);
    const set = cookieByName(res, "_ab_vid")!;
    expect(set).toContain("Max-Age=31536000"); // DO 障害でも Identity は発行する(CL-High-1)
    expect(isCanonicalModeAId(cookieValue(set))).toBe(true);
  });
  it("d_lite_without_active_config_does_not_set_uuid_cookie(salt が分からなければ _ab_uuid を出さない。正本の発行は続く)", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    await env.CONFIG_KV.delete(kvKeys.active("site_p"));
    __resetEdgeCaches();
    const res = await post(decisionBody());
    expect(res.status).toBe(200);
    expect(cookieByName(res, "_ab_vid")).toBeDefined();
    expect(cookieByName(res, "_ab_uuid")).toBeUndefined();
  });
  it("D-lite は正本 Cookie(UUIDv7)の発行時刻を初回の訪問に使う(v4 の Cookie は発行時刻が不明 = 古い訪問者)", async () => {
    const config = compile({
      siteId: "site_p", siteSalt: "salt_test", version: 1, goals: [],
      experiments: [{
        id: "e_new", name: "new", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false,
        targeting: { ctx: "sinceFirstVisit", op: "lt", days: 1 },
        variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
      }],
    });
    await env.CONFIG_KV.put(kvKeys.config("site_p", 1), JSON.stringify(config));
    __resetEdgeCaches();
    const fresh = await post(decisionBody());
    const vid = cookieValue(cookieByName(fresh, "_ab_vid")!);
    expect(typeof visitorIdIssuedAt(vid)).toBe("number"); // 新しく発行するのは v7
    expect(((await fresh.json()) as { experiments: unknown[] }).experiments).toHaveLength(1);
    const v4 = uuidToVisitorId("12345678-1234-4123-8123-123456789abc")!;
    const old = await post(decisionBody(), `_ab_vid=${v4}`);
    expect(((await old.json()) as { experiments: unknown[] }).experiments).toEqual([]);
  });
});
