import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productVersionView } from "@/lib/product-version";
import { parseCapabilities } from "@/lib/capabilities";

describe("productVersionView", () => {
  it("same", () => expect(productVersionView("v1.0", "v1.0")).toEqual({ kind: "same", version: "v1.0" }));
  it("diff", () => expect(productVersionView("v1.0", "v0.11")).toEqual({ kind: "diff", admin: "v1.0", control: "v0.11" }));
  it("unknown", () => expect(productVersionView("v1.0", null)).toEqual({ kind: "unknown", admin: "v1.0" }));
  it("dev", () => expect(productVersionView("dev", "dev")).toEqual({ kind: "same", version: "dev" }));
});
describe("parseCapabilities productVersion", () => {
  it("missing_is_null", () => expect(parseCapabilities({})!.productVersion).toBeNull());
  it("wrong_type_rejects_the_whole_response", () => {
    for (const value of [1, null, true, [], {}]) expect(parseCapabilities({ productVersion: value })).toBeNull();
  });
  it("malformed_string_is_null_only", () => {
    for (const value of ["<b>x</b>", "1.0", "v1", "v1.0.0.0", "v1.0-rc", " dev "]) {
      expect(parseCapabilities({ productVersion: value, resultsStore: true })!.productVersion).toBeNull();
      expect(parseCapabilities({ productVersion: value, resultsStore: true })!.resultsStore).toBe(true);
    }
  });
  it("accepts_version_and_dev", () => {
    for (const value of ["v1.0", "v1.0.1", "dev"]) expect(parseCapabilities({ productVersion: value })!.productVersion).toBe(value);
  });
});

const ROOT = path.join(import.meta.dirname, "..");
// admin の source 全体を歩く。Node で動くテスト・e2e、build の出力と依存は除く(client の JS に入りえない)
const SKIP = new Set(["node_modules", "dist", ".next", ".wrangler", "test", "e2e", "test-results"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(p);
  return SOURCE.test(e.name) ? [p] : [];
});
// 拡張子つき(.js・.ts など)の書き方も、generated/ の中の別の生成ファイルからの再 export(./release)も捕まえる
const releaseImport = /(?:from\s*|import\s*\(\s*)["'](?:@\/|(?:\.\.?\/)+)generated\/release(?:\.[cm]?[jt]sx?)?["']/;
const siblingImport = /(?:from\s*|import\s*\(\s*)["']\.\/release(?:\.[cm]?[jt]sx?)?["']/;
const RELEASE_FILE = path.join("generated", "release.ts");
const importers = () => walk(ROOT)
  .map((f) => path.relative(ROOT, f))
  .filter((f) => f !== RELEASE_FILE)
  .filter((f) => {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    return releaseImport.test(src) || (path.dirname(f) === "generated" && siblingImport.test(src));
  })
  .sort();

describe("the release version never ships in client JS", () => {
  it("no client module imports generated/release", () => {
    expect(importers().filter((f) => /^\s*["']use client["']/.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });
  it("only the /w layout and the about page import it, and both still do", () => {
    expect(importers()).toEqual(["app/w/layout.tsx", "app/w/me/about/page.tsx"]);
  });
  it("ProductVersion.tsx is not a client module", () => {
    expect(readFileSync(path.join(ROOT, "components/settings-personal/ProductVersion.tsx"), "utf8")).not.toMatch(/^\s*["']use client["']/);
  });
});
