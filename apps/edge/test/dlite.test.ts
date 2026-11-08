import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { compile, deriveExternalUuid, generateVisitorId, isCanonicalModeAId, kvKeys, pickVariant, shortVisitorHash, uuidToVisitorId, visitorIdIssuedAt, visitorIdToUuid, type Experiment } from "@wtt/core";
import app from "../src/index";
import { PROFILE_KEY, profileStub, type ProfileRecord } from "../src/profile";
import { visitorKey } from "../src/results";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

const HOST = "site.example";
const exp: Experiment = {
  id: "exp_001", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] },
  trafficPercentage: 100, persistAssignment: false,
  variants: [
    { id: "vA", weight: 50, changes: [] },
    { id: "vB", weight: 50, changes: [] },
  ],
};
const cfg = { schemaVersion: 3, version: 1, siteId: "site_p", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
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
    const set = cookieByName(res, "_wtt_vid")!;
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=31536000");
    expect(set).toContain("Secure");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    const vid = cookieValue(set);
    expect(isCanonicalModeAId(vid)).toBe(true);
    const out = (await res.json()) as { v: number; experiments: Array<{ id: string; variant: string }> };
    expect(out).toEqual({ v: 1, experiments: [{ id: "exp_001", variant: pickVariant(exp, vid) }], vh: await shortVisitorHash(vid) });
  });
  it("uuid_cookie_disabled_by_default", async () => {
    const res = await post(decisionBody());
    expect(cookieByName(res, "_wtt_uuid")).toBeUndefined(); // 既定オフ(spec §5.4)
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
    const res = await post(decisionBody(), `_wtt_vid=${vid}; _wtt_uuid=${visitorIdToUuid(vid)}`);
    const canonical = cookieByName(res, "_wtt_vid")!;
    expect(cookieValue(canonical)).toBe(vid); // 既存 Cookie は必ず再利用(spec §5.4)
    expect(canonical).toContain("Max-Age=31536000");
    const uuid = cookieByName(res, "_wtt_uuid")!;
    expect(cookieValue(uuid)).toBe(await deriveExternalUuid("salt_test", vid)); // 正本から導出した v4(決定 49 §7.2)
    expect(uuid).not.toContain("HttpOnly"); // JS 可読が目的(spec §5.4)
    expect(uuid).toContain("Max-Age=31536000");
  });
  it("invalid canonical cookie is not reused (spec §5.4: 再利用せず新規発行)", async () => {
    const res = await post(decisionBody(), `_wtt_vid=${"A".repeat(22)}`);
    const vid = cookieValue(cookieByName(res, "_wtt_vid")!);
    expect(vid).not.toBe("A".repeat(22));
    expect(isCanonicalModeAId(vid)).toBe(true);
  });
  it("uuid_cookie_cannot_seed_canonical_identity", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    const foreign = "12345678-1234-4123-8123-123456789abc";
    const res = await post(decisionBody(), `_wtt_uuid=${foreign}`);
    const vid = cookieValue(cookieByName(res, "_wtt_vid")!);
    expect(vid).not.toBe(uuidToVisitorId(foreign)); // UUID Cookie は読まない = 復元しない
    expect(cookieValue(cookieByName(res, "_wtt_uuid")!)).toBe(await deriveExternalUuid("salt_test", vid)); // 新 ID から導出して上書き
  });
  it("tampered_uuid_cookie_is_overwritten_from_canonical", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    const vid = generateVisitorId();
    const res = await post(decisionBody(), `_wtt_vid=${vid}; _wtt_uuid=12345678-1234-4123-8123-123456789abc`);
    expect(cookieValue(cookieByName(res, "_wtt_uuid")!)).toBe(await deriveExternalUuid("salt_test", vid));
  });
  it("rename_deletes_old_cookie_and_never_revives_old_identity", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ visitorCookieName: "_wtt_vid2", previousCookieNames: [{ name: "_wtt_vid", until: 2000000000 }] });
    const oldId = generateVisitorId();
    const res = await post(decisionBody(), `_wtt_vid=${oldId}`);
    const del = cookieByName(res, "_wtt_vid")!;
    expect(del).toContain("Max-Age=0"); // 旧名は再利用せず削除(spec §5.4 migration)
    const newSet = cookieByName(res, "_wtt_vid2")!;
    expect(cookieValue(newSet)).not.toBe(oldId);
  });
  it("disable_uuid_cookie_deletes_previous_alias", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ uuidCookieEnabled: false, previousCookieNames: [{ name: "_wtt_uuid", until: 2000000000 }] });
    const vid = generateVisitorId();
    const res = await post(decisionBody(), `_wtt_vid=${vid}; _wtt_uuid=${visitorIdToUuid(vid)}`);
    expect(cookieByName(res, "_wtt_uuid")).toContain("Max-Age=0");
    expect(cookieValue(cookieByName(res, "_wtt_vid")!)).toBe(vid);
  });
  it("configured_cookie_names_are_used_by_runtime_and_edge", async () => {
    // edge 半分(runtime 半分は Plan 3)
    await seedSettings({ visitorCookieName: "_my_id", uuidCookieEnabled: true, uuidCookieName: "_my_uuid" });
    const res = await post(decisionBody());
    expect(cookieByName(res, "_my_id")).toBeDefined();
    expect(cookieByName(res, "_my_uuid")).toBeDefined();
    expect(cookieByName(res, "_wtt_vid")).toBeUndefined();
  });
  it("d_lite_revoke_clears_both_cookies", async () => {
    // DO へ転送しない = 204 で完結(spec §16)。B139 §3.5: 範囲付きの側・ホスト限定の側の両方と、印の Cookie も消す
    await seedSettings({ uuidCookieEnabled: true, cookieDomains: [HOST] });
    const vid = generateVisitorId();
    let touched = 0;
    const spy = new Proxy(env.VISITOR_PROFILE, { get(t, p) { const v = Reflect.get(t, p); if (p === "idFromName" || p === "get") touched++; return typeof v === "function" ? v.bind(t) : v; } }) as Env["VISITOR_PROFILE"];
    const res = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${vid}; _wtt_uuid=${visitorIdToUuid(vid)}`, { VISITOR_PROFILE: spy });
    expect(touched).toBe(0); // §16: revoke は DO 非接触(Plan 5 の最終証明)
    expect(res.status).toBe(204);
    // 削除も発行時と同じ属性(ホスト限定の正本は HttpOnly、範囲付きの正本・UUID・印は HttpOnly なし)
    expect(res.headers.getSetCookie().sort()).toEqual([
      `_wtt_uuid=; Path=/; Domain=${HOST}; Max-Age=0; Secure; SameSite=Lax`,
      "_wtt_uuid=; Path=/; Max-Age=0; Secure; SameSite=Lax",
      `_wtt_vid=; Path=/; Domain=${HOST}; Max-Age=0; Secure; SameSite=Lax`,
      "_wtt_vid=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
      `_wtt_vid_js=; Path=/; Domain=${HOST}; Max-Age=0; Secure; SameSite=Lax`,
      "_wtt_vid_js=; Path=/; Max-Age=0; Secure; SameSite=Lax",
    ].sort());
    for (const sc of res.headers.getSetCookie()) expect(sc).not.toContain("Max-Age=31536000"); // 新規発行しない
  });
  it("decision は binding の limit が success: false なら 429 で Set-Cookie が無い。同意の撤回は制限の前なので 204 と Max-Age=0(決定 63 (13)(e))", async () => {
    let keys: string[] = [];
    const limited: Partial<Env> = { DECISION_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
    const res = await post(decisionBody(), undefined, limited);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("rate limited");
    expect(res.headers.get("Retry-After")).toBe("10");
    expect(res.headers.getSetCookie()).toEqual([]); // Identity を発行しない
    expect(keys).toEqual(["unknown"]); // CF-Connecting-IP が無ければ共通の鍵(/v1/sites/* と同じ)
    keys = [];
    const vid = generateVisitorId();
    const rev = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${vid}`, limited);
    expect(rev.status).toBe(204);
    expect(cookieByName(rev, "_wtt_vid")).toContain("Max-Age=0");
    expect(keys).toEqual([]); // 撤回には制限を掛けない
    // 制限に掛からなければ今までどおり
    expect((await post(decisionBody(), undefined, { DECISION_RATE_LIMITER: { limit: async () => ({ success: true }) } })).status).toBe(200);
  });
  it("unknown version keeps Set-Cookie and returns empty experiments (spec §9.3 のエラー時挙動に整合)", async () => {
    const res = await post({ ...decisionBody(), v: 9 });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ v: 9, experiments: [], vh: await shortVisitorHash(cookieValue(cookieByName(res, "_wtt_vid")!)) });
    expect(cookieByName(res, "_wtt_vid")).toBeDefined();
  });
  it("unknown host 404 / bad body 400", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://unknown.example/__ab/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decisionBody()) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect((await post({ v: 1 })).status).toBe(400);
    expect((await post({ kind: "consent", value: "granted" })).status).toBe(400);
  });
  it("d-lite decision uses the cookie identity for the profile (spec §9.6 + §7.4)", async () => {
    await env.CONFIG_KV.put(kvKeys.config("site_p", 2), JSON.stringify({ ...cfg, version: 2, needsProfile: true, patterns: { p_lp: { op: "contains", value: "/lp" } }, experiments: [{ ...exp, targeting: { hist: "visited", pattern: "p_lp" } }] }));
    const vid = generateVisitorId();
    const res = await post({ ...decisionBody(), v: 2 }, `_wtt_vid=${vid}`);
    expect((await res.json()) as object).toEqual({ v: 2, experiments: [{ id: "exp_001", variant: pickVariant(exp, vid) }], vh: await shortVisitorHash(vid) });
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
    const set = cookieByName(res, "_wtt_vid")!;
    expect(set).toContain("Max-Age=31536000"); // DO 障害でも Identity は発行する(CL-High-1)
    expect(isCanonicalModeAId(cookieValue(set))).toBe(true);
  });
  it("d_lite_without_active_config_does_not_set_uuid_cookie(salt が分からなければ _wtt_uuid を出さない。正本の発行は続く)", async () => {
    await seedSettings({ uuidCookieEnabled: true });
    await env.CONFIG_KV.delete(kvKeys.active("site_p"));
    __resetEdgeCaches();
    const res = await post(decisionBody());
    expect(res.status).toBe(200);
    expect(cookieByName(res, "_wtt_vid")).toBeDefined();
    expect(cookieByName(res, "_wtt_uuid")).toBeUndefined();
  });
  it("D-lite は正本 Cookie(UUIDv7)の発行時刻を初回の訪問に使う(v4 の Cookie は発行時刻が不明 = 古い訪問者)", async () => {
    const config = compile({
      siteId: "site_p", siteSalt: "salt_test", version: 1, goals: [],
      experiments: [{
        id: "e_new", name: "new", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] }, trafficPercentage: 100, persistAssignment: false,
        targeting: { ctx: "sinceFirstVisit", op: "lt", days: 1 },
        variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
      }],
    });
    await env.CONFIG_KV.put(kvKeys.config("site_p", 1), JSON.stringify(config));
    __resetEdgeCaches();
    const fresh = await post(decisionBody());
    const vid = cookieValue(cookieByName(fresh, "_wtt_vid")!);
    expect(typeof visitorIdIssuedAt(vid)).toBe("number"); // 新しく発行するのは v7
    expect(((await fresh.json()) as { experiments: unknown[] }).experiments).toHaveLength(1);
    const v4 = uuidToVisitorId("12345678-1234-4123-8123-123456789abc")!;
    const old = await post(decisionBody(), `_wtt_vid=${v4}`);
    expect(((await old.json()) as { experiments: unknown[] }).experiments).toEqual([]);
  });
});

// B139 §3(Task 5): edge は訪問者の Cookie を共有の範囲(Domain=登録ドメイン)で発行し、ほかの側の写しを消し、撤回ではすべての側を消す
describe("D-lite shared visitor cookie (B139 §3)", () => {
  const W = "www.example.com";
  const FUTURE = 4102444800; // 2100-01-01(保持期間の中)
  const PAST = 1000000000; // 2001(保持期間を過ぎた)

  /** host を site_p に結び、hosts に入れた設定で /__ab/decision に送る */
  async function postAt(host: string, settings: Record<string, unknown>, body: unknown, cookie?: string): Promise<Response> {
    await env.CONFIG_KV.put(kvKeys.host(host), "site_p");
    await seedSettings({ hosts: [host], ...settings });
    __resetEdgeCaches();
    const headers = new Headers({ "Content-Type": "application/json" });
    if (cookie) headers.set("Cookie", cookie);
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://${host}/__ab/decision`, { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const all = (res: Response) => res.headers.getSetCookie();
  /** 発行(Max-Age=31536000)の行 */
  const issued = (res: Response, name: string) => all(res).filter((c) => c.startsWith(`${name}=`) && c.includes("Max-Age=31536000"));
  /** 削除(Max-Age=0)の行の Domain(ホスト限定は null) */
  const deletedDomains = (res: Response, name: string) =>
    all(res)
      .filter((c) => c.startsWith(`${name}=;`) && c.includes("Max-Age=0"))
      .map((c) => /; Domain=([^;]+);/.exec(c)?.[1] ?? null);
  const shared = { cookieDomains: ["example.com"] };

  it("shared_cookie_has_no_httponly_when_sharing_on", async () => {
    const res = await postAt(W, shared, decisionBody());
    expect(res.status).toBe(200);
    const [set] = issued(res, "_wtt_vid");
    expect(set).toContain("; Domain=example.com;");
    expect(set).not.toContain("HttpOnly"); // Q20
    expect(set).toContain("Path=/");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(isCanonicalModeAId(cookieValue(set!))).toBe(true);
  });

  it("sharing_off_keeps_host_only_httponly", async () => {
    const vid = generateVisitorId();
    const res = await postAt(W, { ...shared, shareSubdomains: false }, decisionBody(), `_wtt_vid=${vid}`);
    expect(issued(res, "_wtt_vid")).toEqual([`_wtt_vid=${vid}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`]); // 今と同じ文字列
    expect(all(res).some((c) => c.includes("Domain="))).toBe(false); // 共有オフは今の範囲を消さない(後始末は前の範囲だけ)
  });

  it("legacy_runtime_without_scopes_keeps_host_only_cookie", async () => {
    // 更新の途中で control がまだ cookieDomains を書いていない KV の設定(shareSubdomains は既定の true)
    const res = await postAt(W, {}, decisionBody());
    const [set] = issued(res, "_wtt_vid");
    expect(set).not.toContain("Domain=");
    expect(set).toContain("HttpOnly");
    expect(all(res).filter((c) => c.includes("Max-Age=0"))).toEqual([]); // 発行先がホスト限定なので消すものは無い
  });

  it("edge_deletes_host_only_copy_even_when_single_value", async () => {
    const vid = generateVisitorId();
    const res = await postAt(W, shared, decisionBody(), `_wtt_vid=${vid}`);
    expect(cookieValue(issued(res, "_wtt_vid")[0]!)).toBe(vid); // 値は引き継ぐ
    expect(all(res)).toContain("_wtt_vid=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"); // ホスト限定の正本(発行時は HttpOnly)
    expect(deletedDomains(res, "_wtt_vid")).toEqual([null]); // 今の発行先(example.com)は消さない
    expect(deletedDomains(res, "_wtt_vid_js")).toEqual([null]); // 印はホスト限定の側だけ(届いていないので範囲付きは消さない)
  });

  it("edge_reissues_and_deletes_marker_on_cloudflare_host", async () => {
    const vid = generateVisitorId();
    const res = await postAt(W, shared, decisionBody(), `_wtt_vid=${vid}; _wtt_vid_js=${vid}`);
    const [set] = issued(res, "_wtt_vid");
    expect(cookieValue(set!)).toBe(vid);
    expect(set).toContain("; Domain=example.com;");
    expect(issued(res, "_wtt_vid_js")).toEqual([]); // 印は発行しない
    expect(deletedDomains(res, "_wtt_vid_js").sort()).toEqual(["example.com", null].sort());
    // 規則 2: 2 種類のうち片方が印と同じなら、もう片方(サーバーが書いた古い ID)
    const server = generateVisitorId();
    const js = generateVisitorId();
    const res2 = await postAt(W, shared, decisionBody(), `_wtt_vid=${js}; _wtt_vid=${server}; _wtt_vid_js=${js}`);
    expect(cookieValue(issued(res2, "_wtt_vid")[0]!)).toBe(server);
  });

  it("planted_long_path_cookie_does_not_fix_visitor_id", async () => {
    const attacker = generateVisitorId();
    const legit = generateVisitorId();
    const res = await postAt(W, shared, decisionBody(), `_wtt_vid=${attacker}; _wtt_vid=${legit}`);
    const vid = cookieValue(issued(res, "_wtt_vid")[0]!);
    expect(isCanonicalModeAId(vid)).toBe(true);
    expect(vid).not.toBe(attacker);
    expect(vid).not.toBe(legit);
    // 共有オフのサイトでも同じ(印の規則は使わない)
    const off = await postAt(W, { ...shared, shareSubdomains: false }, decisionBody(), `_wtt_vid=${attacker}; _wtt_vid=${legit}; _wtt_vid_js=${legit}`);
    expect([attacker, legit]).not.toContain(cookieValue(issued(off, "_wtt_vid")[0]!));
  });

  it("edge_rule3_deletes_host_only_previous_and_marker", async () => {
    const a = generateVisitorId();
    const b = generateVisitorId();
    const res = await postAt(W, { ...shared, previousCookieDomains: [{ domain: W, until: FUTURE }] }, decisionBody(), `_wtt_vid=${a}; _wtt_vid=${b}; _wtt_vid_js=${generateVisitorId()}`);
    expect([a, b]).not.toContain(cookieValue(issued(res, "_wtt_vid")[0]!));
    expect(deletedDomains(res, "_wtt_vid").sort()).toEqual([W, null].sort());
    expect(deletedDomains(res, "_wtt_vid_js").sort()).toEqual(["example.com", W, null].sort());
  });

  it("previous_range_cookie_deleted_within_retention", async () => {
    const host = "app.old.example.com";
    const res = await postAt(host, {
      ...shared,
      uuidCookieEnabled: true,
      previousCookieDomains: [
        { domain: "old.example.com", until: FUTURE },
        { domain: "example.com", until: FUTURE }, // 今の発行先と同じ範囲は消さない
        { domain: "gone.example.com", until: FUTURE }, // このホストが属さない範囲は無視
        { domain: "app.old.example.com", until: PAST }, // 保持期間を過ぎた範囲は無視
      ],
    }, decisionBody());
    expect(deletedDomains(res, "_wtt_vid").sort()).toEqual(["old.example.com", null].sort());
    expect(deletedDomains(res, "_wtt_uuid").sort()).toEqual(["old.example.com", null].sort());
    expect(deletedDomains(res, "_wtt_vid_js").sort()).toEqual(["old.example.com", null].sort());
    expect(all(res).find((c) => c.startsWith("_wtt_vid=;") && c.includes("Domain=old.example.com"))).not.toContain("HttpOnly"); // 範囲付きは HttpOnly なしで書いた
  });

  it("previous_ranges_are_capped_at_4_newest_first", async () => {
    const host = "a.b.c.d.e.example.com";
    const ranges = ["a.b.c.d.e.example.com", "b.c.d.e.example.com", "c.d.e.example.com", "d.e.example.com", "e.example.com", "example.com"];
    const res = await postAt(host, { previousCookieDomains: ranges.map((domain, i) => ({ domain, until: FUTURE + i })) }, decisionBody());
    // 発行先はホスト限定(cookieDomains が空)。前の範囲は until の新しい順に 4 つ
    expect(deletedDomains(res, "_wtt_vid")).toEqual(["example.com", "e.example.com", "d.e.example.com", "c.d.e.example.com"]);
  });

  it("uuid_cookie_shares_domain_and_never_httponly", async () => {
    const on = await postAt(W, { ...shared, uuidCookieEnabled: true }, decisionBody());
    const [uOn] = issued(on, "_wtt_uuid");
    expect(uOn).toContain("; Domain=example.com;");
    expect(uOn).not.toContain("HttpOnly");
    const off = await postAt(W, { ...shared, uuidCookieEnabled: true, shareSubdomains: false }, decisionBody());
    const [uOff] = issued(off, "_wtt_uuid");
    expect(uOff).not.toContain("Domain=");
    expect(uOff).not.toContain("HttpOnly");
  });

  it("renamed_cookie_marker_cleaned_on_issue", async () => {
    const old = generateVisitorId();
    const res = await postAt(W, {
      ...shared,
      visitorCookieName: "_wtt_vid2",
      previousCookieNames: [{ name: "_wtt_vid", until: FUTURE }],
      previousCookieDomains: [{ domain: W, until: FUTURE }],
    }, decisionBody(), `_wtt_vid=${old}; _wtt_vid_js=${old}`);
    expect(cookieValue(issued(res, "_wtt_vid2")[0]!)).not.toBe(old); // 旧名は再利用しない
    expect(deletedDomains(res, "_wtt_vid").sort()).toEqual(["example.com", W, null].sort());
    expect(deletedDomains(res, "_wtt_vid_js").sort()).toEqual(["example.com", W, null].sort());
  });

  it("revoke_deletes_all_sides_on_edge", async () => {
    const vid = generateVisitorId();
    const res = await postAt(W, { ...shared, uuidCookieEnabled: true, previousCookieDomains: [{ domain: W, until: FUTURE }, { domain: "example.org", until: FUTURE }] }, { kind: "consent", value: "denied" }, `_wtt_vid=${vid}`);
    expect(res.status).toBe(204);
    for (const name of ["_wtt_vid", "_wtt_uuid", "_wtt_vid_js"]) expect(deletedDomains(res, name).sort()).toEqual(["example.com", W, null].sort());
    expect(all(res).every((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(all(res)).toContain("_wtt_vid=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
    expect(all(res)).toContain("_wtt_vid=; Path=/; Domain=example.com; Max-Age=0; Secure; SameSite=Lax");
  });

  it("revoke_cleans_renamed_cookie_marker", async () => {
    const res = await postAt(W, { ...shared, visitorCookieName: "_wtt_vid2", previousCookieNames: [{ name: "_wtt_vid", until: FUTURE }] }, { kind: "consent", value: "denied" }, `_wtt_vid_js=${generateVisitorId()}`);
    expect(deletedDomains(res, "_wtt_vid_js").sort()).toEqual(["example.com", null].sort());
    expect(deletedDomains(res, "_wtt_vid2_js").sort()).toEqual(["example.com", null].sort());
  });
});

// D9 ② Task 6(設計書 §6.2・§6.4): D-lite の結果の受信は Cookie の ID で行い、decision の応答に ID の短いハッシュ(vh)を返す
describe("D-lite results (D9 ②)", () => {
  const RUN = "r".repeat(22);
  const resultsCfg = { ...cfg, version: 3, goals: [{ id: "g_buy", type: "CUSTOM", config: {} }], results: { forget: true, runs: { exp_001: RUN } } };
  async function postEvent(body: unknown, cookie?: string): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (cookie) headers.set("Cookie", cookie);
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://${HOST}/__ab/event`, { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  beforeAll(async () => {
    await applyD1Migrations(env.RESULTS_DB!, env.TEST_RESULTS_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.CONFIG_KV.put(kvKeys.config("site_p", 3), JSON.stringify(resultsCfg));
    await env.CONFIG_KV.put(kvKeys.active("site_p"), "3");
    __resetEdgeCaches();
    // D1 の行は同じファイルのテストの間で残る
    await env.RESULTS_DB!.batch([env.RESULTS_DB!.prepare("DELETE FROM participants"), env.RESULTS_DB!.prepare("DELETE FROM conversions")]);
  });

  it("d_lite_participant_is_stored_with_the_cookie_identity", async () => {
    const vid = generateVisitorId();
    const other = generateVisitorId(); // body の visitorId は無視する(Cookie が正)
    const res = await postEvent({ type: "participant", v: 1, runId: RUN, variantId: pickVariant(exp, vid), device: "mobile", applied: "ok", visitorId: other }, `_wtt_vid=${vid}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "stored" });
    expect(res.headers.getSetCookie()).toEqual([]);
    const row = await env.RESULTS_DB!.prepare("SELECT site_id, visitor_key, variant_id, device FROM participants WHERE run_id = ?").bind(RUN).first<Record<string, unknown>>();
    expect(row).toMatchObject({ site_id: "site_p", variant_id: pickVariant(exp, vid), device: "mobile" });
    expect([...new Uint8Array(row!.visitor_key as ArrayBuffer | number[])]).toEqual([...(await visitorKey(env, "site_p", vid))!]);
    // CV も同じ Cookie の ID で
    const cv = await postEvent({ type: "conversion", v: 1, goalId: "g_buy", runIds: [RUN] }, `_wtt_vid=${vid}`);
    expect(await cv.json()).toEqual({ result: "stored", runs: { [RUN]: { result: "stored" } } });
    expect((await env.RESULTS_DB!.prepare("SELECT COUNT(*) AS n FROM conversions WHERE run_id = ?").bind(RUN).first<{ n: number }>())!.n).toBe(1);
  });

  // D9 ② Task 7(K13): 撤回(consent body)で計測用 D1 の行を消す。Cookie の ID が正本
  async function seedRows(vid: string): Promise<void> {
    const key = (await visitorKey(env, "site_p", vid))!;
    const otherKey = (await visitorKey(env, "site_other", vid))!;
    await env.RESULTS_DB!.batch([
      env.RESULTS_DB!.prepare("INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied) VALUES (?1, ?2, 'site_p', 'vA', 1, 'mobile', 'ok')").bind(RUN, key),
      env.RESULTS_DB!.prepare("INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at) VALUES (?1, 'g_buy', ?2, 2)").bind(RUN, key),
      env.RESULTS_DB!.prepare("INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied) VALUES (?1, ?2, 'site_other', 'vA', 1, 'mobile', 'ok')").bind(RUN, otherKey),
    ]);
  }
  const count = async (table: string) => (await env.RESULTS_DB!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

  it("dlite consent revoke deletes results rows", async () => {
    const vid = generateVisitorId();
    await seedRows(vid);
    const res = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${vid}`);
    expect(res.status).toBe(204);
    expect(cookieByName(res, "_wtt_vid")).toContain("Max-Age=0"); // Cookie の削除は今のとおり
    expect(await count("conversions")).toBe(0);
    // 別の Site の同じ ID の行は残る
    expect(await env.RESULTS_DB!.prepare("SELECT site_id FROM participants").all<{ site_id: string }>().then((r) => r.results)).toEqual([{ site_id: "site_other" }]);
  });

  it("dlite consent revoke keeps results rows when forgetOnRevoke is false", async () => {
    await seedSettings({ forgetOnRevoke: false });
    __resetEdgeCaches();
    const vid = generateVisitorId();
    await seedRows(vid);
    const res = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${vid}`);
    expect(res.status).toBe(204);
    expect(cookieByName(res, "_wtt_vid")).toContain("Max-Age=0");
    expect(await count("participants")).toBe(2);
    expect(await count("conversions")).toBe(1);
  });

  it("dlite consent revoke without a canonical cookie deletes nothing and still returns 204", async () => {
    const vid = generateVisitorId();
    await seedRows(vid);
    const res = await post({ kind: "consent", value: "denied" }, "_wtt_vid=not-a-canonical-id");
    expect(res.status).toBe(204);
    expect(await count("participants")).toBe(2);
  });

  it("dlite consent revoke still clears cookies when results deletion fails", async () => {
    const vid = generateVisitorId();
    await seedRows(vid);
    const failing = { prepare: (sql: string) => env.RESULTS_DB!.prepare(sql), batch: async () => { throw new Error("D1_ERROR: down"); } } as unknown as D1Database;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${vid}`, { RESULTS_DB: failing });
    spy.mockRestore();
    expect(res.status).toBe(204);
    expect(cookieByName(res, "_wtt_vid")).toContain("Max-Age=0");
  });

  it("revoke_forgets_all_canonical_values", async () => {
    // B139 Q31: 同じ名前で届いた形の正しい値すべての記録を消す
    const a = generateVisitorId();
    const b = generateVisitorId();
    await seedRows(a);
    await seedRows(b);
    expect(await count("participants")).toBe(4);
    const res = await post({ kind: "consent", value: "denied" }, `_wtt_vid=${a}; _wtt_vid=not-canonical; _wtt_vid=${b}`);
    expect(res.status).toBe(204);
    expect(await count("conversions")).toBe(0);
    expect(await env.RESULTS_DB!.prepare("SELECT site_id FROM participants").all<{ site_id: string }>().then((r) => r.results)).toEqual([{ site_id: "site_other" }, { site_id: "site_other" }]);
  });

  it("d_lite_event_with_ambiguous_cookies_is_ignored_with_204", async () => {
    // B139 §3.4 規則 3: 値が 2 種類並ぶ(印で説明がつかない)ときは、どちらの ID でも記録しない
    const res = await postEvent({ type: "participant", v: 1, runId: RUN, variantId: "vA", device: "mobile", applied: "ok" }, `_wtt_vid=${generateVisitorId()}; _wtt_vid=${generateVisitorId()}`);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await count("participants")).toBe(0);
  });

  it("d_lite_event_uses_marker_rule_when_sharing_on", async () => {
    await seedSettings({ cookieDomains: [HOST] });
    __resetEdgeCaches();
    const server = generateVisitorId();
    const js = generateVisitorId();
    const res = await postEvent({ type: "participant", v: 1, runId: RUN, variantId: pickVariant(exp, server), device: "mobile", applied: "ok" }, `_wtt_vid=${js}; _wtt_vid=${server}; _wtt_vid_js=${js}`);
    expect(await res.json()).toEqual({ result: "stored" });
    const row = await env.RESULTS_DB!.prepare("SELECT visitor_key FROM participants WHERE run_id = ?").bind(RUN).first<Record<string, unknown>>();
    expect([...new Uint8Array(row!.visitor_key as ArrayBuffer | number[])]).toEqual([...(await visitorKey(env, "site_p", server))!]);
  });

  it("d_lite_results_event_without_cookie_is_ignored_with_204", async () => {
    const res = await postEvent({ type: "participant", v: 1, runId: RUN, variantId: "vA", device: "mobile", applied: "ok" });
    expect(res.status).toBe(204);
    expect(await env.RESULTS_DB!.prepare("SELECT COUNT(*) AS n FROM participants WHERE run_id = ?").bind(RUN).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("d_lite_decision_returns_vh_of_the_cookie_identity", async () => {
    const vid = generateVisitorId();
    const res = await post({ ...decisionBody(), v: 3 }, `_wtt_vid=${vid}`);
    const out = (await res.json()) as { vh?: string };
    expect(out.vh).toBe(await shortVisitorHash(vid));
    expect(out.vh).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });
});
