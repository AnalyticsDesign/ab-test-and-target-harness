import { describe, expect, it } from "vitest";
import { SETTINGS_NAV, SITE_NAV, activeSegment, screenName, sidebarContext } from "@/lib/nav";

describe("nav", () => {
  it("lists the site menu in the designed order with the glossary labels", () => {
    expect(SITE_NAV.map((n) => n.label)).toEqual(["エクスペリエンス", "目標", "オーディエンス", "公開履歴", "設定"]);
    expect(SITE_NAV.map((n) => n.segment)).toEqual(["", "goals", "audiences", "history", "settings"]);
  });

  it("names the screen from the pathname", () => {
    expect(screenName("/w/ws1/sites/s1")).toBe("エクスペリエンス");
    expect(screenName("/w/ws1/sites/s1/experiments/exp_a")).toBe("エクスペリエンス");
    expect(screenName("/w/ws1/sites/s1/goals")).toBe("目標");
    expect(screenName("/w/ws1/sites/s1/audiences/aud_x")).toBe("オーディエンス");
    expect(screenName("/w/ws1/sites/s1/publish")).toBe("公開");
    expect(screenName("/w/ws1/sites/s1/settings")).toBe("設定");
    expect(screenName("/w/ws1")).toBeNull();
  });

  it("marks the active menu item (publish has no menu item of its own)", () => {
    expect(activeSegment("/w/ws1/sites/s1/experiments/exp_a")).toBe("");
    expect(activeSegment("/w/ws1/sites/s1/publish")).toBeNull();
    expect(activeSegment("/w/ws1/members")).toBeNull();
  });

  it("decides the sidebar context from the pathname", () => {
    expect(sidebarContext("/w")).toEqual({ kind: "home" });
    expect(sidebarContext("/w/")).toEqual({ kind: "home" });
    expect(sidebarContext("/w/me/api-keys")).toEqual({ kind: "settings" });
    expect(sidebarContext("/w/me/workspaces")).toEqual({ kind: "settings" });
    expect(sidebarContext("/w/ws1")).toEqual({ kind: "workspace", wid: "ws1" });
    expect(sidebarContext("/w/ws1/members")).toEqual({ kind: "workspace", wid: "ws1" });
    expect(sidebarContext("/w/ws1/api-keys")).toEqual({ kind: "workspace", wid: "ws1" });
    expect(sidebarContext("/w/ws1/sites/s1")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(sidebarContext("/w/ws1/sites/s1/experiments/e1")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
  });

  it("stops prefetching only the usage screen (it calls control GET /usage, which reads Cloudflare usage)", () => {
    expect(SETTINGS_NAV.find((n) => n.href === "/w/me/usage")?.prefetch).toBe(false);
    expect(SETTINGS_NAV.filter((n) => n.prefetch !== undefined).map((n) => n.href)).toEqual(["/w/me/usage"]);
  });
});
