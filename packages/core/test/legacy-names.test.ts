import { describe, expect, it } from "vitest";
import { CompiledConfigSchema, withoutLegacyNames, type CompiledConfig } from "../src/index";

/** 古い版 2 の config: 名前付き・exp1.a だけ exposurePayloads を持ち exp1.b は持たない・conversionPayloads 無し */
const legacy: CompiledConfig = {
  schemaVersion: 2, version: 4, siteId: "site_l", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {},
  goals: [
    { id: "g_buy", name: "購入完了", type: "CUSTOM", config: {} },
    { id: "g_click", name: "CTA クリック", type: "CLICK", config: { selector: "#cta" } },
  ],
  experiments: [{
    id: "exp1", name: "社内のヒーロー検証", trafficPercentage: 100, persistAssignment: true,
    urlMatch: { op: "contains", value: "/lp/" },
    variants: [
      { id: "a", name: "A案", weight: 50, changes: [] },
      { id: "b", name: "社内の部長案", weight: 50, changes: [] },
    ],
  }],
  exposurePayloads: {
    exp1: { a: { experimentId: "exp1", experimentName: "外部名", variantId: "a", variantName: "外部 A", extra: { k: "v" } } },
  },
};

describe("withoutLegacyNames", () => {
  it("bake_strips_legacy_names_and_keeps_output", () => {
    const out = withoutLegacyNames(legacy);
    expect(JSON.stringify({ e: out.experiments, g: out.goals })).not.toMatch(/"name"/);
    expect(out.exposurePayloads!.exp1!.b!.variantName).toBe("社内の部長案"); // 名前だった値は payload にだけ残る(出力を保つ)
    expect(out.exposurePayloads!.exp1!.b).toMatchObject({ experimentId: "exp1", experimentName: "社内のヒーロー検証", variantId: "b", extra: {} }); // 補完した payload の ID はキーと一致する
    expect(out.exposurePayloads!.exp1!.a!.variantName).toBe(legacy.exposurePayloads!.exp1!.a!.variantName); // 既にある payload は変えない
    expect(out.exposurePayloads!.exp1!.a).toEqual(legacy.exposurePayloads!.exp1!.a);
    expect(out.conversionPayloads!.g_buy).toEqual({ goalId: "g_buy", goalName: "購入完了" });
    expect(out.conversionPayloads!.g_click).toEqual({ goalId: "g_click", goalName: "CTA クリック" });
    expect(CompiledConfigSchema.parse(out)).toBeTruthy();
  });
  it("withoutLegacyNames は冪等", () => {
    const once = withoutLegacyNames(legacy);
    expect(withoutLegacyNames(once)).toEqual(once);
  });
  it("入力を書き換えない", () => {
    const before = structuredClone(legacy);
    withoutLegacyNames(legacy);
    expect(legacy).toEqual(before);
  });
  it("既にある conversionPayloads は変えない", () => {
    const withConv: CompiledConfig = { ...legacy, conversionPayloads: { g_buy: { goalId: "g_buy", goalName: "外部の購入" } } };
    const out = withoutLegacyNames(withConv);
    expect(out.conversionPayloads!.g_buy!.goalName).toBe("外部の購入");
    expect(out.conversionPayloads!.g_click!.goalName).toBe("CTA クリック");
  });
  it("名前の無い config はそのまま返す", () => {
    const clean: CompiledConfig = { ...legacy, goals: [{ id: "g", type: "CUSTOM", config: {} }], experiments: [], exposurePayloads: {} };
    expect(withoutLegacyNames(clean)).toEqual(clean);
  });
});
