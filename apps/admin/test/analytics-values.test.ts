import { describe, expect, it } from "vitest";
import { analyticsValueErrors, shownValueErrors } from "@/lib/analytics-values";

describe("analyticsValueErrors(B77 K12。control の assertAnalyticsValues と同じ規則)", () => {
  it("analytics_value_errors_skip_unchanged: 変えていない古い値は見ない", () => {
    const prev = { overrides: { experimentName: "旧\t名前" } };
    expect(analyticsValueErrors(prev, prev, ["analytics"])).toEqual([]); // 古い値のまま他の欄を保存できる
    expect(analyticsValueErrors({ overrides: { experimentName: "新\n名前" } }, prev, ["analytics"])).toEqual([
      { path: ["analytics", "overrides", "experimentName"], code: "invalid_char", message: "改行・タブなどの制御文字は使えません" },
    ]); // 別の制御文字入りに変えたら送る前に止める
    expect(analyticsValueErrors({ overrides: { experimentName: "" }, extra: { c: "" } }, null, ["analytics"]).map((e) => e.path.at(-1))).toEqual(["c"]); // 名前の空欄は指定なし、追加の値の空は弾く
  });
  it("最初の 1 件で止めず、問題のある欄をすべて返す", () => {
    expect(analyticsValueErrors({ overrides: { variantName: "x".repeat(101) }, extra: { c: "ok", d: "a b", e: "" } }, null, ["variants", "1", "analytics"])).toEqual([
      { path: ["variants", "1", "analytics", "overrides", "variantName"], code: "too_long", message: "100 字以内で入力してください" },
      { path: ["variants", "1", "analytics", "extra", "d"], code: "invalid_char", message: "改行・タブなどの制御文字は使えません" },
      { path: ["variants", "1", "analytics", "extra", "e"], code: "empty", message: "値を入力してください" },
    ]);
  });
  it("同じキーでも値を変えたら見る。null / undefined は何も無い", () => {
    expect(analyticsValueErrors({ extra: { c: "a\tb" } }, { extra: { c: "a\tc" } }, ["analytics"])).toHaveLength(1);
    expect(analyticsValueErrors(null, null, ["analytics"])).toEqual([]);
    expect(analyticsValueErrors(undefined, { extra: { c: "1" } }, ["analytics"])).toEqual([]);
    expect(analyticsValueErrors({ overrides: { goalName: undefined } }, null, ["analytics"])).toEqual([]);
  });
  it("shownValueErrors: 追加したばかりでキーが空の行の「値を入力してください」は、保存を試すまで出さない(ruling R12)", () => {
    const errors = analyticsValueErrors({ extra: { "": "", c: "", d: "a\tb" } }, null, []);
    expect(errors.map((e) => e.path)).toEqual([["extra", ""], ["extra", "c"], ["extra", "d"]]);
    expect(shownValueErrors(errors, false).map((e) => e.path)).toEqual([["extra", "c"], ["extra", "d"]]); // キーを入れた行は今どおり出す
    expect(shownValueErrors(errors, true)).toEqual(errors); // 保存を試した後はすべて出す(保存の前の検査は止める)
    const blankKeyBadValue = analyticsValueErrors({ extra: { "": "a\tb" } }, null, []);
    expect(shownValueErrors(blankKeyBadValue, false)).toEqual(blankKeyBadValue); // 空の値の案内だけを待たせる
  });
});
