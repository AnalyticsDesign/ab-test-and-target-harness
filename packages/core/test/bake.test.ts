import { describe, it, expect } from "vitest";
import { BOOTSTRAP_LIMITS, bakeBootstrap, bootPayload, parseCompiledConfig, parseSiteSettings, type CompiledConfig, type CompiledConfigV2 } from "../src/index";

const cfg: CompiledConfig = {
  schemaVersion: 3, version: 3, siteId: "site_b", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [], exposurePayloads: {},
};

describe("bootPayload", () => {
  const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
  it("config・runtime 向けの settings・apiBase(値があるときだけ)をこの順で作る", () => {
    expect(Object.keys(bootPayload(cfg, settings, "https://edge.example"))).toEqual(["config", "settings", "apiBase"]);
    expect(bootPayload(cfg, settings, "https://edge.example").apiBase).toBe("https://edge.example");
    for (const none of [undefined, null, ""] as const) expect("apiBase" in bootPayload(cfg, settings, none)).toBe(false);
    expect("apiBase" in bootPayload(cfg, settings)).toBe(false);
  });
  it("bakeBootstrap の boot と同じ JSON になる", () => {
    const out = bakeBootstrap(cfg, settings, "/*R*/", { apiBase: "https://edge.example" });
    expect(out).toContain(`self.__WTT_BOOT__=${JSON.stringify(bootPayload(cfg, settings, "https://edge.example"))};\n`);
  });
});

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
    expect(boot.settings.visitorCookieName).toBe("_wtt_vid");
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
  it("bake_output_has_no_name_keys(B69: 名前付きの版 2 は parseCompiledConfig が版 3 にする時点で名前を payload に移して落とす)", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    const named: CompiledConfigV2 = {
      ...cfg,
      schemaVersion: 2,
      goals: [{ id: "g1", name: "購入完了", type: "CUSTOM", config: {} }],
      experiments: [{
        id: "e1", name: "社内名", trafficPercentage: 100, persistAssignment: false, urlMatch: { op: "contains", value: "/lp/" },
        variants: [{ id: "a", name: "A案", weight: 50, changes: [] }, { id: "b", name: "B案", weight: 50, changes: [] }],
      }],
    };
    const before = JSON.stringify(named);
    const out = bakeBootstrap(parseCompiledConfig(named)!, settings, "/*RUNTIME*/");
    const boot = JSON.parse(out.slice(out.indexOf("=") + 1, out.lastIndexOf(";\n")));
    expect(boot.config.schemaVersion).toBe(3);
    expect(JSON.stringify({ e: boot.config.experiments, g: boot.config.goals })).not.toMatch(/"name"/);
    // 出力(dataLayer)を保つため、名前だった値は payload に移っている。runtime の isExposurePayloads との照合は runtime 側のテスト
    expect(boot.config.exposurePayloads.e1.b).toEqual({ experimentId: "e1", experimentName: "社内名", variantId: "b", variantName: "B案", extra: {} });
    expect(boot.config.conversionPayloads.g1).toEqual({ goalId: "g1", goalName: "購入完了" });
    expect(JSON.stringify(named)).toBe(before); // 入力は書き換えない
  });
  it("bootPayload は版 3 の config をそのまま入れる(名前の変換は parse の側。bake は通さない)", () => {
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_b" })!;
    expect(bootPayload(cfg, settings).config).toBe(cfg);
  });
  it("BOOTSTRAP_LIMITS は決定 50 の値で、runtime の build の検査値と同じ", async () => {
    expect(BOOTSTRAP_LIMITS).toEqual({ totalBytes: 14336, headerAllowance: 512, runtimeGzipMax: 11809 });
    const { readFileSync } = await import("node:fs");
    const embed = readFileSync(new URL("../../runtime/scripts/embed.mjs", import.meta.url), "utf8");
    expect(embed).toMatch(new RegExp(`RUNTIME_GZIP_MAX = ${BOOTSTRAP_LIMITS.runtimeGzipMax};`));
  });
});
