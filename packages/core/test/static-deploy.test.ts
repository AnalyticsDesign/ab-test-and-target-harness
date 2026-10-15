import { describe, expect, it } from "vitest";
import { compareGeneration, SITE_REMOVED_SEQ, STATIC_HEADERS_FILE, StaticDeployRequestSchema, StaticRemoveRequestSchema, staticPaths } from "../src/index";

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
});
