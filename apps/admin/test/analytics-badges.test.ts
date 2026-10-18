import { describe, expect, it } from "vitest";
import { analyticsCardOpenInitially, experimentAnalyticsBadge, experimentOutputKeyMax, outputKeyCount, overrideCountByKey, variantAnalyticsBadge } from "@/lib/analytics-badges";

const v = (id: string, extra?: Record<string, string>) => ({ id, analytics: extra ? { extra } : null });

describe("外部計測の印と件数(B77、設計書 Q19〜Q22)", () => {
  it("badge と件数", () => {
    expect(variantAnalyticsBadge("Blue", { c: "2", d: "3" }, { c: "1" })).toEqual({ count: 3, overridden: true });
    expect(variantAnalyticsBadge("", { d: "3" }, { c: "1" })).toEqual({ count: 1, overridden: false }); // 新しいキーは上書きに数えない
    expect(outputKeyCount({ c: "1" }, { c: "2", d: "3" })).toBe(2);
    expect(analyticsCardOpenInitially("", {})).toBe(false);
  });
  it("名前の指定だけでも上書き。何も無ければ 0", () => {
    expect(variantAnalyticsBadge("Blue", {}, {})).toEqual({ count: 1, overridden: true });
    expect(variantAnalyticsBadge("", {}, { c: "1" })).toEqual({ count: 0, overridden: false });
  });
  it("experimentAnalyticsBadge は名前の指定 1 + 追加の値のキー数。名前を指定したら上書き(ruling R8)", () => {
    expect(experimentAnalyticsBadge("hero", { c: "1", d: "2" })).toEqual({ count: 3, overridden: true });
    expect(experimentAnalyticsBadge("", { c: "1" })).toEqual({ count: 1, overridden: false }); // 追加の値はエクスペリエンス側では上書きに数えない
    expect(experimentAnalyticsBadge("", {})).toEqual({ count: 0, overridden: false });
  });
  it("experimentOutputKeyMax はパターンごとの出力するキーの最大", () => {
    expect(experimentOutputKeyMax({ c: "1" }, [v("a"), v("b", { c: "2", d: "3", e: "4" })])).toBe(3);
    expect(experimentOutputKeyMax({ c: "1", d: "2" }, [])).toBe(2);
  });
  it("overrideCountByKey はエクスペリエンスのキーごとに、上書きしているパターン ID", () => {
    expect(overrideCountByKey({ c: "1", g: "2" }, [v("a"), v("b", { c: "2", d: "3" }), v("c", { c: "9" })])).toEqual({ c: ["b", "c"], g: [] });
  });
  it("analyticsCardOpenInitially は設定があれば開く", () => {
    expect(analyticsCardOpenInitially("x", {})).toBe(true);
    expect(analyticsCardOpenInitially("", { c: "1" })).toBe(true);
  });
  it("キーが空の行(入力中)は数えない", () => {
    expect(outputKeyCount({}, { "": "" })).toBe(0);
    expect(variantAnalyticsBadge("", { "": "" }, {})).toEqual({ count: 0, overridden: false });
  });
});
