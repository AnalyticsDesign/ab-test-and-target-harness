import { describe, expect, it } from "vitest";
import { dropdownPosition, popoverPosition, searchContexts } from "@/lib/switcher";
import type { WorkspaceSummary } from "@/lib/types";

const ws: WorkspaceSummary[] = [
  { id: "w1", name: "マーケティング部", role: "owner", memberCount: 3, sites: [
    { id: "site_corp", name: "コーポレート", domain: "www.example.com", runningCount: 2 },
    { id: "site_prod", name: "製品", domain: "product.example.com", runningCount: 0 },
  ] },
  { id: "w2", name: "採用 › 広報", role: "editor", memberCount: 2, sites: [] },
];

describe("searchContexts (B35)", () => {
  it("returns nothing for an empty query", () => {
    expect(searchContexts(ws, "  ")).toEqual([]);
  });
  it("matches workspaces by name and sites by name, domain or id, linking by id", () => {
    expect(searchContexts(ws, "マーケ")).toEqual([{ href: "/w/w1", label: "マーケティング部", sub: "ワークスペース · サイト 2" }]);
    expect(searchContexts(ws, "PRODUCT")).toEqual([{ href: "/w/w1/sites/site_prod", label: "マーケティング部 › 製品", sub: "product.example.com" }]);
    expect(searchContexts(ws, "site_corp")[0]!.href).toBe("/w/w1/sites/site_corp");
  });
  it("links a workspace whose name contains the separator by its id", () => {
    expect(searchContexts(ws, "›")).toEqual([{ href: "/w/w2", label: "採用 › 広報", sub: "ワークスペース · サイト 0" }]);
  });
  it("returns an empty list when nothing matches", () => {
    expect(searchContexts(ws, "存在しない")).toEqual([]);
  });
  it("builds site hrefs with the given function and keeps workspace hrefs (B60: 設定の中の切り替え)", () => {
    const toSettings = (wid: string, sid: string) => `/w/${wid}/sites/${sid}/settings`;
    expect(searchContexts(ws, "PRODUCT", toSettings)[0]!.href).toBe("/w/w1/sites/site_prod/settings");
    expect(searchContexts(ws, "マーケ", toSettings)[0]!.href).toBe("/w/w1");
  });
});

describe("popoverPosition (B35 / r1 CX-Medium-4)", () => {
  const anchor = { top: 60, bottom: 108, left: 12, right: 224 }; // サイドバー(236px)の上端の枠
  it("opens to the right of the sidebar and keeps the whole panel inside a wide viewport", () => {
    expect(popoverPosition(anchor, { width: 1280, height: 800 })).toEqual({ top: 60, left: 232, width: 560, maxHeight: 724 });
  });
  it("narrows the panel so that it ends 16px before the right edge (768px wide = right of the sidebar)", () => {
    const p = popoverPosition(anchor, { width: 768, height: 800 });
    expect(p.left).toBe(232);
    expect(p.left + p.width).toBe(752);
  });
  it("opens below the anchor under 760px and fits the width", () => {
    expect(popoverPosition(anchor, { width: 400, height: 700 })).toEqual({ top: 114, left: 12, width: 372, maxHeight: 570 });
  });
  it("moves up an anchor near the bottom so that at least 200px of list remain (a low viewport)", () => {
    expect(popoverPosition({ ...anchor, top: 300, bottom: 348 }, { width: 1280, height: 420 })).toEqual({ top: 204, left: 232, width: 560, maxHeight: 200 });
  });
  it("keeps the top inside the viewport when the anchor is scrolled partly out (r2 CX-Medium-4)", () => {
    expect(popoverPosition({ ...anchor, top: -10, bottom: 38 }, { width: 1280, height: 420 }).top).toBe(16);
  });
  it("still leaves an operable height in a tiny viewport (top at the margin, the rest is the list)", () => {
    expect(popoverPosition(anchor, { width: 400, height: 120 })).toEqual({ top: 16, left: 12, width: 372, maxHeight: 88 });
  });
});

describe("dropdownPosition (B60: 上部バーの版の札の一覧)", () => {
  const chip = { top: 12, right: 520, bottom: 40, left: 420 };
  it("opens below the anchor, aligned to its left edge", () => {
    expect(dropdownPosition(chip, { width: 1280, height: 800 }, 340)).toEqual({ top: 46, left: 420, width: 340, maxHeight: 738 });
  });
  it("shifts left so that the panel ends 16px before the right edge", () => {
    expect(dropdownPosition({ ...chip, left: 700, right: 800 }, { width: 900, height: 700 }, 340)).toEqual({ top: 46, left: 544, width: 340, maxHeight: 638 });
  });
  it("narrows the panel to the viewport and keeps 16px on the left (a very narrow viewport)", () => {
    expect(dropdownPosition({ ...chip, left: 100, right: 200 }, { width: 300, height: 700 }, 340)).toEqual({ top: 46, left: 16, width: 268, maxHeight: 638 });
  });
  it("never returns a negative height", () => {
    expect(dropdownPosition({ ...chip, top: 700, bottom: 740 }, { width: 1280, height: 720 }, 340).maxHeight).toBe(0);
  });
});
