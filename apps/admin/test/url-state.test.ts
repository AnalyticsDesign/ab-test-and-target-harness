import { describe, expect, it } from "vitest";
import { pickParam, withParam } from "@/lib/url-state";

const TABS = ["overview", "variants", "analytics"] as const;

describe("url-state", () => {
  it("sets, replaces and removes a param while keeping the others and the hash", () => {
    expect(withParam("/w/a/sites/s/experiments/e", "tab", "variants")).toBe("/w/a/sites/s/experiments/e?tab=variants");
    expect(withParam("/x?tab=overview&variant=b#top", "tab", "analytics")).toBe("/x?tab=analytics&variant=b#top");
    expect(withParam("/x?tab=overview&variant=b", "tab", null)).toBe("/x?variant=b");
    expect(withParam("/x?tab=overview", "tab", null)).toBe("/x");
  });

  // B31 ⑦: ページの searchParams の値をそのまま受ける(クエリ文字列を手で組み立てない)
  it("picks an allowed searchParams value: string, first of an array, or the fallback", () => {
    expect(pickParam("variants", TABS, "overview")).toBe("variants");
    expect(pickParam(["analytics", "variants"], TABS, "overview")).toBe("analytics");
    expect(pickParam(undefined, TABS, "overview")).toBe("overview");
    expect(pickParam("nope", TABS, "overview")).toBe("overview");
    expect(pickParam("variants&tab=analytics", TABS, "overview")).toBe("overview"); // 組み立てた文字列のように別のキーへ化けない
    expect(pickParam([], TABS, "overview")).toBe("overview");
  });
});
