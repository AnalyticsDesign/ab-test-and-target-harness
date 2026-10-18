import { describe, expect, it } from "vitest";
import { duplicateBody, duplicateNotes, duplicateVariantModeIssue, duplicateVariantOptions, initialDuplicateState, withMode, withName, withVariant } from "@/lib/duplicate";
import type { Experiment } from "@/lib/types";

const TEXT = { id: "c1", type: "TEXT", selector: "#cta", payload: { text: "B" } };
const EXP = {
  id: "exp_buy", siteId: "s", name: "購入ボタンの文言テスト", kind: "test", status: "running", publishedStatus: "running", urlMatch: { op: "equals", value: "/" }, targeting: null,
  trafficPercentage: 50, persistAssignment: false, analytics: null, createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: false,
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [TEXT, { ...TEXT, id: "c2" }] },
    { id: "c", name: "C", weight: 0, original: false, description: "", analytics: null, changes: [] },
  ],
} as unknown as Experiment;

describe("duplicate dialog state (決定 51、設計書 §4.2)", () => {
  it("starts with the same mode and the first pattern that is not the original selected (B77)", () => {
    expect(initialDuplicateState(EXP)).toEqual({ mode: "same", variantId: "b", name: "購入ボタンの文言テスト のコピー", nameEdited: false });
  });

  it("follows the mode and the pattern in the default name", () => {
    const s = withMode(EXP, initialDuplicateState(EXP), "variant");
    expect(s.name).toBe("購入ボタンの文言テスト(B だけを表示)");
    expect(withVariant(EXP, s, "c").name).toBe("購入ボタンの文言テスト(C だけを表示)");
  });

  it("keeps the edited name when the mode changes", () => {
    const edited = withName(initialDuplicateState(EXP), "私の名前");
    expect(withMode(EXP, edited, "variant").name).toBe("私の名前");
    expect(withVariant(EXP, withMode(EXP, edited, "variant"), "c").name).toBe("私の名前");
  });

  it("shows the number of changes in the pattern list, and the original cannot be chosen (B77)", () => {
    expect(duplicateVariantOptions(EXP)).toEqual([
      { value: "a", label: "A", hint: "オリジナルは複製できません", disabled: true },
      { value: "b", label: "B", hint: "変更 2 件" },
      { value: "c", label: "C", hint: "変更なし" },
    ]);
  });

  it("the original is not selected even if asked (B77)", () => {
    const s = withMode(EXP, initialDuplicateState(EXP), "variant");
    expect(withVariant(EXP, s, "a")).toEqual(s);
  });

  it("duplicate_variant_mode_unavailable_when_all_original(A/A は「選んだパターンだけを表示」を選べない)", () => {
    const aa = { ...EXP, variants: [EXP.variants![0], { ...EXP.variants![0], id: "b", name: "B" }] } as Experiment;
    const s = initialDuplicateState(aa);
    expect(s.variantId).toBeNull();
    expect(duplicateVariantModeIssue(aa)).toBe("変更のあるパターンがありません");
    expect(withMode(aa, s, "variant").mode).toBe("same");
    expect(duplicateBody(withMode(aa, s, "variant"))).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
    expect(duplicateVariantModeIssue(EXP)).toBeNull();
    // 選んだパターンが無いまま variant で送る経路は無い(黙って same にしない)
    expect(() => duplicateBody({ ...s, mode: "variant" })).toThrow();
  });

  it("warns about a pattern without changes and about the traffic", () => {
    const s = withVariant(EXP, withMode(EXP, initialDuplicateState(EXP), "variant"), "c");
    expect(duplicateNotes(EXP, s)).toEqual(["C には変更が無いため、表示しても今のページと同じです", "配信率は 100% で作ります(元は 50%)"]);
    expect(duplicateNotes(EXP, initialDuplicateState(EXP))).toEqual([]);
    expect(duplicateNotes({ ...EXP, trafficPercentage: 100 } as Experiment, withMode(EXP, initialDuplicateState(EXP), "variant"))).toEqual([]);
  });

  it("a personalization source has no variant mode", () => {
    const single = { ...EXP, kind: "single", variants: [EXP.variants![1]] } as Experiment;
    const s = initialDuplicateState(single);
    expect(s.mode).toBe("same");
    expect(duplicateBody(withMode(single, s, "variant"))).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
  });

  it("builds the request body", () => {
    expect(duplicateBody(initialDuplicateState(EXP))).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
    expect(duplicateBody(withMode(EXP, initialDuplicateState(EXP), "variant"))).toEqual({ mode: "variant", variantId: "b", name: "購入ボタンの文言テスト(B だけを表示)" });
  });
});
