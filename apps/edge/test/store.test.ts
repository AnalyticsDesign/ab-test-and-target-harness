import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys } from "@wtt/core";
import { loadSettings, loadActiveVersion, loadConfig, loadSiteIdByHost, __resetEdgeCaches } from "../src/store";

const cfg = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [] };

beforeEach(() => __resetEdgeCaches());

describe("store", () => {
  it("loads and validates settings; malformed or missing is null (fail-closed)", async () => {
    expect(await loadSettings(env, "s_none")).toBeNull();
    await env.CONFIG_KV.put(kvKeys.settings("s1"), JSON.stringify({ settingsVersion: 1, siteId: "s1" }));
    await env.CONFIG_KV.put(kvKeys.settings("s_bad"), "{ not json");
    await env.CONFIG_KV.put(kvKeys.settings("s_v2"), JSON.stringify({ settingsVersion: 2, siteId: "s_v2" }));
    expect((await loadSettings(env, "s1"))?.visitorCookieName).toBe("_ab_vid");
    expect(await loadSettings(env, "s_bad")).toBeNull();
    expect(await loadSettings(env, "s_v2")).toBeNull();
  });
  it("caches settings for 60s in isolate memory (spec §7.4)", async () => {
    const t0 = 1_000_000;
    await env.CONFIG_KV.put(kvKeys.settings("s1"), JSON.stringify({ settingsVersion: 1, siteId: "s1" }));
    expect((await loadSettings(env, "s1", t0))?.decisionTimeoutMs).toBe(1000);
    await env.CONFIG_KV.put(kvKeys.settings("s1"), JSON.stringify({ settingsVersion: 1, siteId: "s1", decisionTimeoutMs: 2000 }));
    expect((await loadSettings(env, "s1", t0 + 59_000))?.decisionTimeoutMs).toBe(1000); // まだ旧値
    expect((await loadSettings(env, "s1", t0 + 61_000))?.decisionTimeoutMs).toBe(2000); // TTL 後に新値
  });
  it("active version must be a positive integer string", async () => {
    await env.CONFIG_KV.put(kvKeys.active("s1"), "3");
    await env.CONFIG_KV.put(kvKeys.active("s_bad"), "abc");
    // Valid decimal
    expect(await loadActiveVersion(env, "s1")).toBe(3);
    // Invalid: non-decimal and malformed
    expect(await loadActiveVersion(env, "s_bad")).toBeNull();
    expect(await loadActiveVersion(env, "s_none")).toBeNull();
    // Strict validation rejects lenient coercions
    await env.CONFIG_KV.put(kvKeys.active("s_hex"), "0x10");
    await env.CONFIG_KV.put(kvKeys.active("s_exp"), "1e1");
    await env.CONFIG_KV.put(kvKeys.active("s_space"), " 3");
    await env.CONFIG_KV.put(kvKeys.active("s_float"), "3.0");
    await env.CONFIG_KV.put(kvKeys.active("s_leading"), "007");
    await env.CONFIG_KV.put(kvKeys.active("s_zero"), "0");
    await env.CONFIG_KV.put(kvKeys.active("s_neg"), "-1");
    expect(await loadActiveVersion(env, "s_hex")).toBeNull(); // hex not accepted
    expect(await loadActiveVersion(env, "s_exp")).toBeNull(); // exponential not accepted
    expect(await loadActiveVersion(env, "s_space")).toBeNull(); // leading space not accepted
    expect(await loadActiveVersion(env, "s_float")).toBeNull(); // decimal not accepted
    expect(await loadActiveVersion(env, "s_leading")).toBeNull(); // leading zero not accepted (not canonical)
    expect(await loadActiveVersion(env, "s_zero")).toBeNull(); // zero not positive
    expect(await loadActiveVersion(env, "s_neg")).toBeNull(); // negative not positive
  });
  it("config is cached for 60s (positive and negative) via kv call count", async () => {
    const t0 = 2_000_000;
    let gets = 0;
    const counted = {
      ...env,
      CONFIG_KV: new Proxy(env.CONFIG_KV, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          if (prop === "get") { gets++; }
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as typeof env.CONFIG_KV,
    };
    await env.CONFIG_KV.put(kvKeys.config("s1", 9), JSON.stringify({ ...cfg, version: 9 }));
    expect((await loadConfig(counted, "s1", 9, t0))?.version).toBe(9);
    expect((await loadConfig(counted, "s1", 9, t0 + 59_000))?.version).toBe(9);
    expect(gets).toBe(1); // 59 秒以内はキャッシュ
    await loadConfig(counted, "s1", 9, t0 + 61_000);
    expect(gets).toBe(2); // 61 秒後は再読込
    expect(await loadConfig(counted, "s1", 404, t0)).toBeNull();
    expect(await loadConfig(counted, "s1", 404, t0 + 1_000)).toBeNull();
    expect(gets).toBe(3); // negative も 60 秒キャッシュ
  });
  it("unknown schemaVersion config is rejected (unsupported_compiled_config_version の edge 半分)", async () => {
    await env.CONFIG_KV.put(kvKeys.config("s1", 2), JSON.stringify({ ...cfg, schemaVersion: 3, version: 2 }));
    expect(await loadConfig(env, "s1", 2)).toBeNull();
  });
  it("schemaVersion 1 config is unknown too (版 1 の読み取りは backlog B52 で削除。版 2 が公開の最初の版)", async () => {
    await env.CONFIG_KV.put(kvKeys.config("s1", 3), JSON.stringify({ ...cfg, schemaVersion: 1, version: 3 }));
    expect(await loadConfig(env, "s1", 3)).toBeNull();
  });
  it("config_site_or_version_mismatch_is_rejected", async () => {
    await env.CONFIG_KV.put(kvKeys.config("s1", 5), JSON.stringify({ ...cfg, siteId: "other", version: 5 }));
    await env.CONFIG_KV.put(kvKeys.config("s1", 6), JSON.stringify({ ...cfg, version: 7 }));
    expect(await loadConfig(env, "s1", 5)).toBeNull();
    expect(await loadConfig(env, "s1", 6)).toBeNull();
  });
  it("settings_site_mismatch_is_rejected", async () => {
    await env.CONFIG_KV.put(kvKeys.settings("s_a"), JSON.stringify({ settingsVersion: 1, siteId: "s_b" }));
    expect(await loadSettings(env, "s_a")).toBeNull();
  });
  it("host mapping resolves and caches", async () => {
    await env.CONFIG_KV.put(kvKeys.host("example.com"), "s1");
    expect(await loadSiteIdByHost(env, "example.com")).toBe("s1");
    expect(await loadSiteIdByHost(env, "EXAMPLE.com")).toBe("s1"); // kvKeys.host が小文字化する
    expect(await loadSiteIdByHost(env, "nope.example")).toBeNull();
  });
});
