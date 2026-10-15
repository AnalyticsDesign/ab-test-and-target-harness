import { describe, expect, it } from "vitest";
import { readParam, withParam } from "@/lib/url-state";

const TABS = ["overview", "variants", "analytics"] as const;

describe("url-state", () => {
  it("reads an allowed value and falls back otherwise", () => {
    expect(readParam("?tab=variants", "tab", TABS, "overview")).toBe("variants");
    expect(readParam("?tab=nope", "tab", TABS, "overview")).toBe("overview");
    expect(readParam("", "tab", TABS, "overview")).toBe("overview");
    expect(readParam("?tab=variants&tab=analytics", "tab", TABS, "overview")).toBe("variants");
  });

  it("sets, replaces and removes a param while keeping the others and the hash", () => {
    expect(withParam("/w/a/sites/s/experiments/e", "tab", "variants")).toBe("/w/a/sites/s/experiments/e?tab=variants");
    expect(withParam("/x?tab=overview&variant=b#top", "tab", "analytics")).toBe("/x?tab=analytics&variant=b#top");
    expect(withParam("/x?tab=overview&variant=b", "tab", null)).toBe("/x?variant=b");
    expect(withParam("/x?tab=overview", "tab", null)).toBe("/x");
  });
});
