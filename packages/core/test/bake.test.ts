import { describe, it, expect } from "vitest";
import { BOOTSTRAP_LIMITS, bakeBootstrap, parseSiteSettings, type CompiledConfig } from "../src/index";

const cfg: CompiledConfig = {
  schemaVersion: 2, version: 3, siteId: "site_b", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [], exposurePayloads: {},
};

describe("bakeBootstrap", () => {
  it("bake_embeds_config_and_runtime_settings_before_runtime_source", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b", hosts: ["a.example"], allowedOrigins: ["https://a.example"] })!;
    const out = bakeBootstrap(cfg, settings, "/*RUNTIME*/");
    expect(out.startsWith("/* AB Test and Target Harness bootstrap (site site_b, config v3) */\nself.__WTT_BOOT__=")).toBe(true);
    expect(out.endsWith(";\n/*RUNTIME*/")).toBe(true);
    const boot = JSON.parse(out.slice(out.indexOf("=") + 1, out.lastIndexOf(";\n")));
    expect(boot.config).toEqual(cfg);
    // spec §5.4: runtime 向けサブセットだけ焼く(hosts / allowedOrigins / siteId は含めない)
    expect(boot.settings.hosts).toBeUndefined();
    expect(boot.settings.allowedOrigins).toBeUndefined();
    expect(boot.settings.visitorCookieName).toBe("_ab_vid");
  });
  it("bake_is_pure_and_does_not_touch_storage", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    expect(bakeBootstrap(cfg, settings, "x")).toBe(bakeBootstrap(cfg, settings, "x"));
  });
  it("previewSource を渡すと boot の前に埋め込む(下書きの bootstrap。決定 50)", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    const out = bakeBootstrap(cfg, settings, "/*RUNTIME*/", { previewSource: "/*PREVIEW*/" });
    expect(out).toContain("/*PREVIEW*/"); // indexOf が -1(埋め込まれていない)でも下の比較が通ってしまうのを防ぐ
    expect(out.indexOf("/*PREVIEW*/")).toBeLessThan(out.indexOf("self.__WTT_BOOT__="));
    expect(out.indexOf("self.__WTT_BOOT__=")).toBeLessThan(out.indexOf("/*RUNTIME*/"));
    expect(bakeBootstrap(cfg, settings, "/*RUNTIME*/")).not.toContain("PREVIEW"); // 本番の bootstrap には入れない
  });
  it("apiBase と runtimeHash を渡すと boot に apiBase、先頭の注釈に runtime のハッシュが入る(決定 52 (7))", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    const out = bakeBootstrap(cfg, settings, "/*RUNTIME*/", { apiBase: "https://edge.example", runtimeHash: "abc123def456" });
    expect(out.startsWith("/* AB Test and Target Harness bootstrap (site site_b, config v3, runtime abc123def456) */\nself.__WTT_BOOT__=")).toBe(true);
    const boot = JSON.parse(out.slice(out.indexOf("=") + 1, out.lastIndexOf(";\n")));
    expect(boot.apiBase).toBe("https://edge.example");
  });
  it("apiBase が null なら boot に apiBase を入れない(runtime は今の導出のまま)", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    const out = bakeBootstrap(cfg, settings, "x", { apiBase: null });
    expect(out).not.toContain("apiBase");
  });
  it("BOOTSTRAP_LIMITS は決定 50 の値で、runtime の build の検査値と同じ", async () => {
    expect(BOOTSTRAP_LIMITS).toEqual({ totalBytes: 14336, headerAllowance: 512, runtimeGzipMax: 11264 });
    const { readFileSync } = await import("node:fs");
    const embed = readFileSync(new URL("../../runtime/scripts/embed.mjs", import.meta.url), "utf8");
    expect(embed).toMatch(new RegExp(`RUNTIME_GZIP_MAX = ${BOOTSTRAP_LIMITS.runtimeGzipMax};`));
  });
});
