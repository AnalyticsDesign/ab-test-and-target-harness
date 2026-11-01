import { describe, expect, it } from "vitest";
import {
  compareGeneration,
  SITE_REMOVED_SEQ,
  STATIC_BATCH_MAX,
  STATIC_HEADERS_FILE,
  StaticBatchDeployRequestSchema,
  StaticDeployRequestSchema,
  StaticRemoveRequestSchema,
  staticInputDigest,
  staticPaths,
  type CompiledConfig,
} from "../src/index";

describe("static-deploy", () => {
  it("パスは設置タグと同じ形(先頭の / を含む)", () => {
    expect(staticPaths.site("site_a")).toBe("/s/site_a.js");
    expect(staticPaths.preview("abc123")).toBe("/s/preview/abc123.js");
  });
  it("_headers は /s/* の 1 規則で今の edge と同じ 3 つのヘッダ", () => {
    expect(STATIC_HEADERS_FILE).toBe("/s/*\n  Cache-Control: public, max-age=60\n  Content-Type: text/javascript; charset=utf-8\n  X-Content-Type-Options: nosniff\n");
  });
  it("世代は epoch、次に seq で比べる", () => {
    expect(compareGeneration({ epoch: 1, seq: 9 }, { epoch: 2, seq: 1 })).toBeLessThan(0);
    expect(compareGeneration({ epoch: 2, seq: 3 }, { epoch: 2, seq: 2 })).toBeGreaterThan(0);
    expect(compareGeneration({ epoch: 2, seq: 2 }, { epoch: 2, seq: 2 })).toBe(0);
  });
  it("依頼の形: protocol 1・Site ID の規則・apiBase は完全な origin か null", () => {
    const ok = { protocol: 1, siteId: "site_a", generation: { epoch: 1, seq: 1 }, config: {}, settings: {}, apiBase: "https://www.example.com" };
    expect(StaticDeployRequestSchema.safeParse(ok).success).toBe(true);
    expect(StaticDeployRequestSchema.safeParse({ ...ok, apiBase: null }).success).toBe(true);
    expect(StaticDeployRequestSchema.safeParse({ ...ok, apiBase: "https://www.example.com/" }).success).toBe(false);
    expect(StaticDeployRequestSchema.safeParse({ ...ok, siteId: "../x" }).success).toBe(false);
    expect(StaticDeployRequestSchema.safeParse({ ...ok, protocol: 2 }).success).toBe(false);
    expect(StaticDeployRequestSchema.safeParse({ ...ok, generation: { epoch: 1, seq: 0 } }).success).toBe(false);
  });
  it("削除の墓標の seq は安全な整数の最大値で、形の検査を通る", () => {
    expect(StaticRemoveRequestSchema.safeParse({ protocol: 1, siteId: "site_a", generation: { epoch: 1, seq: SITE_REMOVED_SEQ } }).success).toBe(true);
  });

  describe("StaticBatchDeployRequestSchema", () => {
    const gen = { epoch: 1, seq: 1 };
    const site = (i: number) => ({ siteId: `site_${i}`, generation: gen, config: {}, settings: {}, apiBase: "https://www.example.com" });
    const ok = { protocol: 1, sites: [site(1)], flush: "soon" };
    const sites = (n: number) => Array.from({ length: n }, (_, i) => site(i));

    it("STATIC_BATCH_MAX は 5", () => {
      expect(STATIC_BATCH_MAX).toBe(5);
    });
    it("1〜5 件は通し、0 件と 6 件は断る", () => {
      expect(StaticBatchDeployRequestSchema.safeParse(ok).success).toBe(true);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: sites(5) }).success).toBe(true);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: sites(6) }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [] }).success).toBe(false);
    });
    it("protocol 2・未知のキー・flush なし・flush の不正値は断る。force は任意", () => {
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, protocol: 2 }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ protocol: 1, sites: ok.sites }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, flush: "now" }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, flush: "later", force: true }).success).toBe(true);
    });
    it("要素の siteId が SITE_ID_RE に合わなければ断る。要素の protocol・force・未知のキーも断る", () => {
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...site(1), siteId: "../x" }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...site(1), protocol: 1 }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...site(1), force: true }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...site(1), extra: 1 }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...site(1), apiBase: "https://www.example.com/" }] }).success).toBe(false);
    });
    it("削除の要素は通し、削除の要素に config があれば断る。通常の要素と混ぜてよい", () => {
      const rm = { siteId: "site_x", generation: { epoch: 1, seq: SITE_REMOVED_SEQ }, remove: true };
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [rm] }).success).toBe(true);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...rm, generation: gen }] }).success).toBe(true); // 墓標の seq でない通常の世代でも形は通る
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [site(1), rm] }).success).toBe(true);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...rm, config: {} }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...rm, remove: false }] }).success).toBe(false);
      expect(StaticBatchDeployRequestSchema.safeParse({ ...ok, sites: [{ ...rm, siteId: "../x" }] }).success).toBe(false);
    });
  });

  describe("staticInputDigest", () => {
    const cfg: CompiledConfig = {
      schemaVersion: 2, version: 3, siteId: "site_b", siteSalt: "s", needsProfile: false,
      patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [], exposurePayloads: {},
    };
    const settings = { settingsVersion: 1, siteId: "site_b", hosts: ["a.example"], allowedOrigins: ["https://a.example"] };
    const base = { config: cfg, settings, apiBase: "https://edge.example" as string | null };

    it("同じ入力なら同じ値(64 桁の小文字 hex)", async () => {
      const a = await staticInputDigest(base);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(await staticInputDigest({ ...base })).toBe(a);
    });
    it("キーの順だけが違う入力でも同じ値", async () => {
      const reordered = {
        apiBase: base.apiBase,
        settings: { allowedOrigins: settings.allowedOrigins, hosts: settings.hosts, siteId: "site_b", settingsVersion: 1 },
        config: Object.fromEntries(Object.entries(cfg).reverse()),
      };
      expect(await staticInputDigest(reordered)).toBe(await staticInputDigest(base));
    });
    it("入れ子の record(prehide・exposureSelectors)の挿入順だけが違っても同じ値(辞書順の並べ替えが効いている)", async () => {
      const x = { ...cfg, prehide: { exp_a: ["#a"], exp_b: ["#b"] }, exposureSelectors: { exp_a: ["#a1"], exp_b: ["#b1"] } };
      const y = { ...cfg, prehide: { exp_b: ["#b"], exp_a: ["#a"] }, exposureSelectors: { exp_b: ["#b1"], exp_a: ["#a1"] } };
      expect(Object.keys(y.prehide)).toEqual(["exp_b", "exp_a"]); // 挿入順が本当に違う入力であること
      expect(await staticInputDigest({ ...base, config: y })).toBe(await staticInputDigest({ ...base, config: x }));
      // 配列の順は意味があるので並べ替えない(中身の順が違えば別の値)
      const z = { ...x, prehide: { exp_a: ["#b"], exp_b: ["#a"] } };
      expect(await staticInputDigest({ ...base, config: z })).not.toBe(await staticInputDigest({ ...base, config: x }));
    });
    it("config か apiBase が違えば違う値。apiBase なし(null)は値ありと違う", async () => {
      const a = await staticInputDigest(base);
      expect(await staticInputDigest({ ...base, config: { ...cfg, version: 4 } })).not.toBe(a);
      expect(await staticInputDigest({ ...base, apiBase: "https://other.example" })).not.toBe(a);
      expect(await staticInputDigest({ ...base, apiBase: null })).not.toBe(a);
    });
    it("toRuntimeSettings に入る設定が変われば変わり、入らない設定だけの違いでは変わらない", async () => {
      const a = await staticInputDigest(base);
      expect(await staticInputDigest({ ...base, settings: { ...settings, visitorCookieName: "_other" } })).not.toBe(a);
      expect(await staticInputDigest({ ...base, settings: { ...settings, consentMode: "required" } })).not.toBe(a);
      expect(await staticInputDigest({ ...base, settings: { ...settings, allowedOrigins: ["https://b.example"] } })).toBe(a);
      expect(await staticInputDigest({ ...base, settings: { ...settings, hosts: ["b.example"] } })).toBe(a);
      expect(await staticInputDigest({ ...base, settings: { ...settings, retentionDays: 30 } })).toBe(a);
    });
    it("bake と同じく parse する。既定値を明示した入力と省いた入力は同じ値", async () => {
      const explicit = { ...settings, mode: "A", idSource: "ab", visitorCookieName: "_wtt_vid" };
      expect(await staticInputDigest({ ...base, settings: explicit })).toBe(await staticInputDigest(base));
    });
    it("parse できない config か settings は例外にする(別のサイトの値と見分けがつかない digest を作らない)", async () => {
      await expect(staticInputDigest({ ...base, config: { nope: 1 } })).rejects.toThrow();
      await expect(staticInputDigest({ ...base, settings: { nope: 1 } })).rejects.toThrow();
    });
  });
});
