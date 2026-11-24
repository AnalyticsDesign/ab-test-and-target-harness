import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { conversionPreview, exposurePreview, siteDataLayerPreview, type SitePreviewBlock } from "@/lib/datalayer-preview";

const BASE = { experimentId: "e", experimentName: "", variantId: "b", variantName: "", experimentExtra: {}, variantExtra: {} };

describe("出力プレビュー(B77 K13、設計書 §5 の「出力」)", () => {
  it("conversionPreview: 値は JSON の形、指定なしは ID と注釈", () => {
    const n = DEFAULT_ANALYTICS;
    expect(conversionPreview(n, { goalId: "g_cta", goalName: "" }).find((l) => l.key === "ab_goal_name")).toEqual({ key: "ab_goal_name", value: '"g_cta"', note: "指定なし = 目標 ID" });
    expect(conversionPreview(n, { goalId: "g", goalName: '購入 "A"' }).find((l) => l.key === "ab_goal_name")?.value).toBe('"購入 \\"A\\""');
  });
  it("conversionPreview: CV の push 1 回分を runtime と同じ並びで出す", () => {
    expect(conversionPreview(DEFAULT_ANALYTICS, { goalId: "g", goalName: "buy" })).toEqual([
      { key: "event", value: '"ab_conversion"' },
      { key: "ab_goal_id", value: '"g"' },
      { key: "ab_goal_name", value: '"buy"', note: "指定した目標名", overridden: true },
      { key: "ab_extra", value: "null", note: "追加する情報なし" },
    ]);
  });
  it("exposurePreview: パターンの値がエクスペリエンスの値を上書き", () => {
    const lines = exposurePreview(DEFAULT_ANALYTICS, { experimentId: "e", experimentName: "", variantId: "b", variantName: "", experimentExtra: { c: "1" }, variantExtra: { c: "2", d: "3" } });
    expect(lines.find((l) => l.key === "ab_variant_name")?.note).toBe("指定なし = パターン ID");
    expect(lines.find((l) => l.value === '"2"')).toMatchObject({ overridden: true, note: "このパターンの値(エクスペリエンスの値を上書き)" });
  });
  it("exposurePreview: 露出の push 1 回分。追加の値は extraKey の下に入れ子で、エクスペリエンスのキーが先", () => {
    expect(exposurePreview(DEFAULT_ANALYTICS, { ...BASE, experimentName: "hero", variantName: "buy_b", experimentExtra: { c: "1", g: "x" }, variantExtra: { d: "3", c: "2" } })).toEqual([
      { key: "event", value: '"ab_exposure"' },
      { key: "ab_experiment_id", value: '"e"' },
      { key: "ab_experiment_name", value: '"hero"', note: "指定したエクスペリエンス名", overridden: true },
      { key: "ab_variant_id", value: '"b"' },
      { key: "ab_variant_name", value: '"buy_b"', note: "指定したパターン名", overridden: true },
      { key: "c", value: '"2"', note: "このパターンの値(エクスペリエンスの値を上書き)", overridden: true, nested: true },
      { key: "g", value: '"x"', note: "エクスペリエンスの値", nested: true },
      { key: "d", value: '"3"', note: "このパターンの値", nested: true },
    ]);
  });
  it("exposurePreview: 指定なしの名前は ID、追加の値が無ければ extraKey は null", () => {
    const lines = exposurePreview(DEFAULT_ANALYTICS, BASE);
    expect(lines.find((l) => l.key === "ab_experiment_name")).toEqual({ key: "ab_experiment_name", value: '"e"', note: "指定なし = エクスペリエンス ID" });
    expect(lines.find((l) => l.key === "ab_variant_name")).toEqual({ key: "ab_variant_name", value: '"b"', note: "指定なし = パターン ID" });
    expect(lines.at(-1)).toEqual({ key: "ab_extra", value: "null", note: "追加する情報なし" });
  });
  it("キー名はサイトの設定の実際の値を使う。キーが空の行(入力中)は出さない", () => {
    const names = { ...DEFAULT_ANALYTICS, extraKey: "my_extra", exposure: { event: "exp_ev", keys: { experimentId: "eid", experimentName: "ename", variantId: "vid", variantName: "vname" } } };
    const lines = exposurePreview(names, { ...BASE, variantExtra: { "": "" } });
    expect(lines.map((l) => l.key)).toEqual(["event", "eid", "ename", "vid", "vname", "my_extra"]);
    expect(lines[0]?.value).toBe('"exp_ev"');
  });
});

describe("siteDataLayerPreview", () => {
  it("3 つの小見出しと push の数(露出 2・コンバージョン 1・制限 1)", () => {
    expect(siteDataLayerPreview(DEFAULT_ANALYTICS).map((b) => [b.id, b.title, b.pushes.length])).toEqual([
      ["exposure", "露出", 2],
      ["conversion", "コンバージョン", 1],
      ["rateLimited", "制限に当たったとき", 1],
    ]);
  });
  it("露出の 1 回目は extraKey の消去だけ", () => {
    expect(siteDataLayerPreview(DEFAULT_ANALYTICS)[0]!.pushes[0]).toEqual([
      { key: "ab_extra", value: "null", note: "前の露出の追加情報を消す(イベントなし)" },
    ]);
  });
  it("例の追加情報は example_key", () => {
    expect(siteDataLayerPreview(DEFAULT_ANALYTICS)[0]!.pushes[1]!.filter((l) => l.nested)).toEqual([
      { key: "example_key", value: '"<値>"', note: "エクスペリエンスの値", nested: true },
    ]);
  });
  it("制限に当たったときは名前を変えても固定", () => {
    expect(siteDataLayerPreview({ ...DEFAULT_ANALYTICS, extraKey: "ab_info" })[2]!.pushes[0]).toEqual([
      { key: "event", value: '"ab_error"' },
      { key: "ab_error_type", value: '"rate_limited"' },
    ]);
  });
  it("extraKey を ab_info・variantId を ab_vid にすると、その所だけ変わる", () => {
    const keys = (blocks: SitePreviewBlock[]) => blocks.flatMap((block) => block.pushes.flatMap((push) => push.map((line) => line.key)));
    const before = keys(siteDataLayerPreview(DEFAULT_ANALYTICS));
    const after = keys(siteDataLayerPreview({
      ...DEFAULT_ANALYTICS,
      extraKey: "ab_info",
      exposure: {
        ...DEFAULT_ANALYTICS.exposure,
        keys: { ...DEFAULT_ANALYTICS.exposure.keys, variantId: "ab_vid" },
      },
    }));
    expect(before.map((key, i) => [key, after[i]]).filter(([a, b]) => a !== b)).toEqual([
      ["ab_extra", "ab_info"],
      ["ab_variant_id", "ab_vid"],
      ["ab_extra", "ab_info"],
    ]);
  });
  it("同じ名前のキーが 2 つあれば 2 行とも出す", () => {
    const names = {
      ...DEFAULT_ANALYTICS,
      conversion: { ...DEFAULT_ANALYTICS.conversion, keys: { goalId: "x", goalName: "x" } },
    };
    expect(siteDataLayerPreview(names)[1]!.pushes[0]!.map((l) => l.key)).toEqual(["event", "x", "x", "ab_extra"]);
  });
});
