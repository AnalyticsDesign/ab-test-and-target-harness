import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResultsResponse } from "@/lib/results-view";
import {
  duplicateAnalyticsPatch, duplicateAnalyticsSameAsSource, duplicateBody, duplicateNotes, duplicateVariantModeIssue, duplicateVariantOptions, initialDuplicateState, withAnalyticsName, withId, withMode, withName, withVariant,
} from "@/lib/duplicate";
import type { Experiment } from "@/lib/types";

const TEXT = { id: "c1", type: "TEXT", selector: "#cta", payload: { text: "B" } };
const EXP = {
  id: "exp_buy", siteId: "s", name: "購入ボタンの文言テスト", kind: "test", status: "running", publishedStatus: "running", urlMatch: { include: [{ page: { op: "equals", value: "/" } }] }, targeting: null,
  trafficPercentage: 50, persistAssignment: false, analytics: null, createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: false,
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [TEXT, { ...TEXT, id: "c2" }] },
    { id: "c", name: "C", weight: 0, original: false, description: "", analytics: null, changes: [] },
  ],
} as unknown as Experiment;

describe("duplicate dialog state (決定 51、設計書 §4.2)", () => {
  it("starts with the same mode and the first pattern that is not the original selected (B77)", () => {
    expect(initialDuplicateState(EXP)).toEqual({ mode: "same", variantId: "b", name: "購入ボタンの文言テスト のコピー", nameEdited: false, id: "exp_buy-copy", idDefault: "exp_buy-copy", analyticsName: null });
  });

  // B103: 複製の画面で ID と外部計測のエクスペリエンス名を指定する
  it("ID は <元の ID>-copy から始め、直したときだけ送る(直さなければ control が空いている -copy・-copy-2 … を使う)", () => {
    const s = initialDuplicateState(EXP);
    expect(duplicateBody(s)).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
    const edited = withId(s, "exp_buy_v2");
    expect(edited).toMatchObject({ id: "exp_buy_v2", idDefault: "exp_buy-copy" });
    expect(duplicateBody(edited)).toEqual({ mode: "same", id: "exp_buy_v2", name: "購入ボタンの文言テスト のコピー" });
    expect(duplicateBody(withMode(EXP, edited, "variant"))).toMatchObject({ mode: "variant", variantId: "b", id: "exp_buy_v2" });
    // 初期値に打ち直したら送らない(送ると -copy が使われているときに 409 になる。送らなければ control が空いているものを選ぶ)
    expect(duplicateBody(withId(edited, "exp_buy-copy"))).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
  });

  it("ID の初期値は control と同じ候補の先頭(長い ID でも 64 字に収める)", () => {
    const long = { ...EXP, id: "e".repeat(62) } as Experiment;
    const s = initialDuplicateState(long);
    expect(s.id.length).toBeLessThanOrEqual(64);
    expect(s.id.endsWith("-copy")).toBe(true);
  });

  it("前後の空白だけが違う名前は、元と同じとみなす(触っていないのに名前を変えない)", () => {
    const spaced = { ...EXP, analytics: { overrides: { experimentName: "buy " } } } as Experiment;
    const s = initialDuplicateState(spaced);
    expect(duplicateAnalyticsSameAsSource(spaced, s)).toBe(true);
    expect(duplicateAnalyticsPatch(spaced, s)).toBeNull();
  });

  it("外部計測のエクスペリエンス名は、元に上書きがあるときだけ欄を出し、元の値から始める", () => {
    const withOverride = { ...EXP, analytics: { overrides: { experimentName: "buy_copy" }, extra: { team: "growth" } } } as Experiment;
    const s = initialDuplicateState(withOverride);
    expect(s.analyticsName).toBe("buy_copy");
    expect(initialDuplicateState(EXP).analyticsName).toBeNull(); // 上書きが無ければ欄を出さない(複製は ID を出す)
    // 変えなければ 2 回目の要求を送らない(元と同じ名前のまま。画面は注意を出す)
    expect(duplicateAnalyticsPatch(withOverride, s)).toBeNull();
    expect(duplicateAnalyticsSameAsSource(withOverride, s)).toBe(true);
    // 変えたら、元の外部計測(extra を含む)の名前だけを差し替えて送る
    const renamed = withAnalyticsName(s, "buy_copy_v2");
    expect(duplicateAnalyticsSameAsSource(withOverride, renamed)).toBe(false);
    expect(duplicateAnalyticsPatch(withOverride, renamed)).toEqual({ analytics: { overrides: { experimentName: "buy_copy_v2" }, extra: { team: "growth" } } });
    // 空にしたら上書きを外す(dataLayer には新しいエクスペリエンス ID が出る)
    expect(duplicateAnalyticsPatch(withOverride, withAnalyticsName(s, "  "))).toEqual({ analytics: { overrides: {}, extra: { team: "growth" } } });
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

});

/** D9 ③ Task 16(設計書 §4.2・決定 61): 結果があるときの初期値と、判定・速報・品質・編集の注意 */
describe("duplicate dialog with results (D9 ③)", () => {
  const load = (name: string): ResultsResponse => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/results", `${name}.json`), "utf8")) as ResultsResponse;
  const THREE = {
    ...EXP,
    trafficPercentage: 100,
    variants: [
      { id: "a", name: "A(現行)", weight: 33, original: true, description: "", analytics: null, changes: [] },
      { id: "b", name: "B(CTA 文言)", weight: 34, original: false, description: "", analytics: null, changes: [TEXT] },
      { id: "c", name: "C(CTA 文言 + 色)", weight: 33, original: false, description: "", analytics: null, changes: [TEXT] },
    ],
  } as unknown as Experiment;
  const TWO = { ...THREE, variants: THREE.variants!.slice(0, 2) } as Experiment;

  it("initial: the adopted pattern with the 'only the chosen pattern' mode", () => {
    expect(initialDuplicateState(TWO, load("adopted"))).toEqual({ mode: "variant", variantId: "b", name: "購入ボタンの文言テスト(B(CTA 文言) だけを表示)", nameEdited: false, id: "exp_buy-copy", idDefault: "exp_buy-copy", analyticsName: null });
  });

  it("initial: without an adoption, the non-baseline pattern with the highest probability of beating the baseline (same mode)", () => {
    expect(initialDuplicateState(THREE, load("three"))).toMatchObject({ mode: "same", variantId: "c" });
    // 採用なしを記録したときも同じ内容で開く
    const none = { ...load("three"), adoption: { variantId: null, note: "", decidedAt: 1, decidedBy: null } };
    expect(initialDuplicateState(THREE, none)).toMatchObject({ mode: "same", variantId: "c" });
  });

  it("initial: originals and zero-weight patterns are never picked (決定 61)", () => {
    const r = load("three");
    // c の重みを 0 に → b
    const zero = { ...r, variants: r.variants.map((v) => (v.id === "c" ? { ...v, weight: 0 } : v)) };
    expect(initialDuplicateState(THREE, zero).variantId).toBe("b");
    // 確率の最も高いのがオリジナルでも選ばない
    const orig = { ...THREE, variants: THREE.variants!.map((v) => (v.id === "c" ? { ...v, original: true, changes: [] } : v)) } as Experiment;
    expect(initialDuplicateState(orig, r).variantId).toBe("b");
    // 結果が無ければオリジナルでない先頭
    expect(initialDuplicateState(THREE, null).variantId).toBe("b");
  });

  it("options carry the verdict and probability", () => {
    expect(duplicateVariantOptions(THREE, load("three"))).toEqual([
      { value: "a", label: "A(現行)", hint: "オリジナルは複製できません", disabled: true },
      { value: "b", label: "B(CTA 文言)", hint: "判断材料が不足・上回る確率 96.2%" },
      { value: "c", label: "C(CTA 文言 + 色)", hint: "採用候補・上回る確率 99.8%" },
    ]);
  });

  it("notes: verdict other than adopt, interim, stopped early, quality", () => {
    const v = (e: Experiment, id: string) => withVariant(e, withMode(e, initialDuplicateState(e), "variant"), id);
    expect(duplicateNotes(THREE, v(THREE, "b"), load("three"))).toEqual(["判定: 判断材料が不足。効果は確かめられていません"]);
    expect(duplicateNotes(THREE, v(THREE, "c"), load("three"))).toEqual([]);
    const worse = { ...load("three"), variants: load("three").variants.map((x) => (x.id === "b" ? { ...x, state: "worse" as const } : x)) };
    expect(duplicateNotes(THREE, v(THREE, "b"), worse)).toEqual(["判定: 悪化の可能性が高い。基準より悪い可能性が高いパターンです"]);
    expect(duplicateNotes(TWO, v(TWO, "b"), load("interim"))).toEqual(["評価時点の前です。いまの確率は参考値です"]);
    // 評価時点の後に返った前の速報(記録がまだ無い)は「評価時点の前」と言わない。前かは今の時刻で決める
    const at = load("interim").evaluation!.evaluationAt;
    expect(duplicateNotes(TWO, v(TWO, "b"), load("interim"), at - 1)).toEqual(["評価時点の前です。いまの確率は参考値です"]);
    expect(duplicateNotes(TWO, v(TWO, "b"), load("interim"), at + 1)).toEqual(["評価時点を過ぎましたが、判定をまだ記録できていません。表示している確率は前に計算した参考値です"]);
    expect(duplicateNotes(TWO, v(TWO, "b"), load("early"))).toEqual(["評価時点の前に終了したため、確率は参考値です"]);
    expect(duplicateNotes(TWO, v(TWO, "b"), { ...load("adopt"), quality: "blocked" })).toEqual(["データ品質に問題があり、判定できていません。効果は確かめられていません"]);
    // 採用を記録したパターンには判定の注意を出さない
    expect(duplicateNotes(TWO, v(TWO, "b"), { ...load("adopted"), variants: load("adopted").variants.map((x) => (x.id === "b" ? { ...x, state: "insufficient" as const } : x)) })).toEqual([]);
    // 「同じ内容」には注意を出さない
    expect(duplicateNotes(THREE, initialDuplicateState(THREE, load("three")), load("three"))).toEqual([]);
  });

  it("notes: no changes in the delivered definition, traffic, edited after the evaluation point, unpublished edits", () => {
    const r = { ...load("three"), deliveredChanges: { a: false, b: false, c: true }, notes: [{ key: "edited_after_evaluation", params: { variantId: "c" } }, { key: "unpublished_changes", params: { variantId: "c" } }] } as ResultsResponse;
    const half = { ...THREE, trafficPercentage: 50 } as Experiment;
    const pick = (id: string) => withVariant(half, withMode(half, initialDuplicateState(half), "variant"), id);
    expect(duplicateNotes(half, pick("b"), r)).toEqual(["判定: 判断材料が不足。効果は確かめられていません", "B(CTA 文言) には変更が無いため、表示しても今のページと同じです", "配信率は 100% で作ります(元は 50%)"]);
    expect(duplicateNotes(half, pick("c"), r)).toEqual([
      "配信率は 100% で作ります(元は 50%)",
      "評価時点の後に C(CTA 文言 + 色) の変更が編集されています",
      "C(CTA 文言 + 色) に未公開の編集があります。テストで配信したのは編集の前の中身です。「C(CTA 文言 + 色) だけを表示」の複製は配信した中身で作ります",
    ]);
  });
});

describe("duplicate request body", () => {
  it("builds the request body", () => {
    expect(duplicateBody(initialDuplicateState(EXP))).toEqual({ mode: "same", name: "購入ボタンの文言テスト のコピー" });
    expect(duplicateBody(withMode(EXP, initialDuplicateState(EXP), "variant"))).toEqual({ mode: "variant", variantId: "b", name: "購入ボタンの文言テスト(B だけを表示)" });
  });
});
