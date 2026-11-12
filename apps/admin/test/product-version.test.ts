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
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(?:ts|tsx)$/.test(e.name) ? [p] : [];
});
const releaseImport = /(?:from\s*|import\s*\(\s*)["'](?:@\/|(?:\.\.?\/)+)generated\/release(?:\.ts)?["']/;
const importers = () => ["app", "components", "lib"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => releaseImport.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)).sort();

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
