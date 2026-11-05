import { describe, expect, it } from "vitest";
import { AUDIT_ACTION_CATEGORY, AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_TARGET_TYPES, AUDIT_VIAS } from "../src/index";

// B129(spec §1・§3.1): 操作の記録の一覧。control と管理画面が同じ一覧を使う
describe("audit actions (B129)", () => {
  it("actions_are_unique_and_categorized", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(Object.keys(AUDIT_ACTION_CATEGORY).sort()).toEqual([...AUDIT_ACTIONS].sort());
    for (const a of AUDIT_ACTIONS) {
      expect(AUDIT_CATEGORIES).toContain(AUDIT_ACTION_CATEGORY[a]);
      expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("content_actions_are_site_scoped", () => {
    // content = サイト・エクスペリエンス・目標・オーディエンス・画像・公開(spec §1)。それ以外の接頭辞は access
    const contentPrefixes = new Set(["site", "experiment", "goal", "audience", "asset", "publish"]);
    for (const a of AUDIT_ACTIONS) expect(AUDIT_ACTION_CATEGORY[a], a).toBe(contentPrefixes.has(a.split(".")[0]!) ? "content" : "access");
  });

  it("vias_include_setup_and_system", () => {
    expect([...AUDIT_VIAS].sort()).toEqual(["api_key", "break_glass", "google", "password", "setup", "system", "unknown"]);
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
  });
});
