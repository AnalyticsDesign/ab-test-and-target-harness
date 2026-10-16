import { describe, expect, it } from "vitest";
import { DUPLICATE_ID_MAX, duplicateIdCandidates, duplicateName } from "../src/duplicate";

describe("duplicate defaults (決定 51、設計書 §4.1)", () => {
  it("names a copy by the mode", () => {
    expect(duplicateName("same", "購入ボタンの文言テスト")).toBe("購入ボタンの文言テスト のコピー");
    expect(duplicateName("variant", "購入ボタンの文言テスト", "B")).toBe("購入ボタンの文言テスト(B だけを表示)");
  });

  it("shortens long names to the limit with an ellipsis", () => {
    const long = "あ".repeat(100);
    const same = duplicateName("same", long);
    expect(same.length).toBe(100);
    expect(same.endsWith("… のコピー")).toBe(true);
    const variant = duplicateName("variant", long, "い".repeat(100));
    expect(variant.length).toBeLessThanOrEqual(100);
    expect(variant).toContain("い".repeat(29) + "… だけを表示)");
  });

  it("auto id truncates the source id and skips taken ids", () => {
    expect(duplicateIdCandidates("exp_hero").slice(0, 3)).toEqual(["exp_hero-copy", "exp_hero-copy-2", "exp_hero-copy-3"]);
    const longId = "a".repeat(64);
    const c = duplicateIdCandidates(longId);
    expect(c).toHaveLength(99);
    expect(c.every((id) => id.length <= DUPLICATE_ID_MAX && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))).toBe(true);
    expect(c[0]).toBe("a".repeat(59) + "-copy");
    expect(c[98]).toBe("a".repeat(56) + "-copy-99");
  });
});
