import { describe, expect, it } from "vitest";
import { EDITOR_TABS, draftOf, tabsFor, draftValueErrors, experimentPatchBody, failedTab, hasSteps, isDirty, reconcileServerUpdate, saveSteps, targetingBody, type Draft } from "@/lib/experiment-draft";
import type { Experiment } from "@/lib/types";

const EXP = {
  id: "exp_a", siteId: "s", name: "Hero", kind: "test", status: "draft", publishedStatus: null, urlMatch: { op: "equals", value: "/" }, targeting: { ctx: "device", op: "in", value: ["mobile"] },
  trafficPercentage: 100, persistAssignment: false, analytics: { overrides: { experimentName: "hero_test" }, extra: { team: "growth" } },
  createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: true, runId: null, description: "仮説: 無料体験を前に出す",
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [] },
  ],
} as Experiment;

describe("experiment draft", () => {
  it("builds the form state from the experiment", () => {
    const d = draftOf(EXP);
    expect(d.name).toBe("Hero");
    expect(d.targeting).toEqual({ kind: "form", form: { logic: "and", rows: [{ id: "r1", kind: "cond", type: "device", neg: false, values: ["mobile"] }] } });
    expect(d.traffic).toBe(100);
    expect(d.expName).toBe("hero_test");
    expect(d.extra).toEqual({ team: "growth" });
    expect(d.variants.map((v) => v.id)).toEqual(["a", "b"]);
    expect(d.description).toBe("仮説: 無料体験を前に出す");
  });
  it("uses empty values when the experiment has none", () => {
    const d = draftOf({ ...EXP, targeting: null, analytics: null, variants: undefined });
    expect(d.targeting).toEqual({ kind: "form", form: { logic: "and", rows: [] } });
    expect(d.expName).toBe("");
    expect(d.extra).toEqual({});
    expect(d.variants).toEqual([]);
  });
  it("is dirty only when something differs from the initial state", () => {
    const initial = draftOf(EXP);
    expect(isDirty(initial, draftOf(EXP))).toBe(false);
    expect(isDirty(initial, { ...initial, name: "Hero 2" })).toBe(true);
    expect(isDirty(initial, { ...initial, variants: initial.variants.map((v) => (v.id === "b" ? { ...v, weight: 40 } : v)) })).toBe(true);
    const reverted = { ...initial, name: "Hero 2" };
    expect(isDirty(initial, { ...reverted, name: "Hero" })).toBe(false); // 元に戻せば未保存ではない
  });
  it("maps a failed save stage to the tab that holds the field", () => {
    expect(failedTab("patch", "name")).toBe("overview");
    expect(failedTab("patch", "urlMatch")).toBe("overview");
    expect(failedTab("patch", undefined)).toBe("overview");
    expect(failedTab("patch", "analytics")).toBe("overview"); // B77 K16: 外部計測は基本設定タブの下部のカード
    expect(failedTab("variants", "0")).toBe("variants");
    expect(failedTab("changes", "payload")).toBe("variants");
    expect(EDITOR_TABS).toEqual(["overview", "variants", "plan", "results"]); // ?tab=analytics は pickParam の既定で基本設定に落ちる
    // D9 ③ Task 14・15: 評価計画と結果のタブはテストだけ(パーソナライズの ?tab=plan / ?tab=results は基本設定に落ちる)
    expect(tabsFor("test")).toEqual(["overview", "variants", "plan", "results"]);
    expect(tabsFor("single")).toEqual(["overview", "variants"]);
  });
  it("experiment_form_keeps_unrepresentable_targeting(画面で表せない保存値は JSON のまま持ち、保存では送らない = ほかの欄の保存を止めない)", () => {
    const legacy = draftOf({ ...EXP, targeting: { hist: "visited", pattern: "p_pricing" } });
    expect(legacy.targeting).toEqual({ kind: "raw", json: { hist: "visited", pattern: "p_pricing" } });
    expect(targetingBody(legacy.targeting)).toEqual({});
    expect(targetingBody(draftOf(EXP).targeting)).toEqual({ targeting: { ctx: "device", op: "in", value: ["mobile"] } });
    expect(targetingBody(draftOf({ ...EXP, targeting: null }).targeting)).toEqual({ targeting: null });
  });
  it("想定外の保存値(スカラー・入れ子の null・未知のフィールド・不完全なページの一致)も raw にし、例外を出さず、保存では送らない(plan ② P16)", () => {
    for (const t of [false, 42, { and: [null] }, { ctx: "time", days: ["mon"], extra: 1 }, { hist: "visited", page: {} }]) {
      const d = draftOf({ ...EXP, targeting: t as never });
      expect(d.targeting).toEqual({ kind: "raw", json: t });
      expect(targetingBody(d.targeting)).toEqual({}); // 名前だけを保存しても PATCH の本文に targeting は含まれない
    }
  });
});

describe("saveSteps(B77 K17。保存の段を差分で決める)", () => {
  const TEXT = { id: "c1", type: "TEXT" as const, selector: "#cta", payload: { text: "B" } };
  const initial = draftOf(EXP);
  const withVariant = (d: Draft, id: string, patch: Partial<Draft["variants"][number]>): Draft => ({ ...d, variants: d.variants.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  const NONE = { patchExperiment: false, experimentMemo: false, putVariants: false, variantMemos: [], putChanges: [], putPlan: false };

  it("何も変えていなければ何も送らない", () => {
    expect(saveSteps(initial, draftOf(EXP), "draft")).toEqual(NONE);
  });
  it("エクスペリエンスのメモだけ → experimentMemo のみ", () => {
    expect(saveSteps(initial, { ...initial, description: "仮説 2" }, "draft")).toEqual({ ...NONE, experimentMemo: true });
  });
  it("パターンのメモだけ → variantMemos のみ", () => {
    expect(saveSteps(initial, withVariant(initial, "b", { description: "メモ" }), "draft")).toEqual({ ...NONE, variantMemos: ["b"] });
  });
  it("名前と b の変更 → patchExperiment と putChanges [\"b\"]", () => {
    expect(saveSteps(initial, withVariant({ ...initial, name: "Hero 2" }, "b", { changes: [TEXT] }), "draft")).toEqual({ ...NONE, patchExperiment: true, putChanges: ["b"] });
  });
  it("エクスペリエンスの外部計測・配信の欄はどれでも patchExperiment(メモは載せない)", () => {
    expect(saveSteps(initial, { ...initial, expName: "x" }, "running").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, extra: {} }, "running").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, traffic: 50 }, "paused").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, persist: true }, "draft").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, urlMatch: { op: "equals", value: "/x" } } as Draft, "draft").patchExperiment).toBe(true);
  });
  it("オリジナルの切り替えだけでも、下書きなら putVariants", () => {
    expect(saveSteps(initial, withVariant(initial, "a", { original: false }), "draft")).toEqual({ ...NONE, putVariants: true });
  });
  it("パターンの集合(並び・名前・重み・外部計測)が変わったら putVariants。下書きでなければ送らない", () => {
    expect(saveSteps(initial, { ...initial, variants: [...initial.variants].reverse() }, "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { weight: 40 }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { name: "Blue" }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { analytics: { overrides: { variantName: "blue" } } }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { weight: 40 }), "running").putVariants).toBe(false);
  });
  it("オリジナルのパターンの変更は送らない", () => {
    expect(saveSteps(initial, withVariant(initial, "a", { changes: [TEXT] }), "draft").putChanges).toEqual([]);
  });
  it("新しいパターンは集合の更新で作り、メモと変更があればその後に送る", () => {
    const added = { ...initial, variants: [...initial.variants, { id: "c", name: "C", weight: 0, original: false, description: "新案", analytics: null, changes: [TEXT] }] };
    expect(saveSteps(initial, added, "draft")).toEqual({ ...NONE, putVariants: true, variantMemos: ["c"], putChanges: ["c"] });
    const empty = { ...initial, variants: [...initial.variants, { id: "c", name: "C", weight: 0, original: false, description: "", analytics: null, changes: [] }] };
    expect(saveSteps(initial, empty, "draft")).toEqual({ ...NONE, putVariants: true });
  });
  it("配信中でもメモと変更は送る", () => {
    expect(saveSteps(initial, withVariant({ ...initial, description: "途中の記録" }, "b", { description: "m", changes: [TEXT] }), "running")).toEqual({ ...NONE, experimentMemo: true, variantMemos: ["b"], putChanges: ["b"] });
  });
  it("終了したエクスペリエンスでメモ以外は対象にしない", () => {
    const edited = withVariant({ ...initial, name: "Hero 2", description: "結果の記録" }, "b", { description: "勝ち", changes: [TEXT] });
    expect(saveSteps(initial, edited, "archived")).toEqual({ ...NONE, experimentMemo: true, variantMemos: ["b"] });
  });
  it("draftValueErrors: エクスペリエンスと各パターンの外部計測を、保存済みの値と比べて検査する(B77 K17 (1))", () => {
    const initial = draftOf({ ...EXP, analytics: { overrides: { experimentName: "旧\t名前" } } });
    expect(draftValueErrors(initial, initial)).toEqual([]); // 変えていない古い値では止めない
    const current: Draft = {
      ...initial,
      extra: { team: "" },
      variants: [
        ...initial.variants.map((v) => (v.id === "b" ? { ...v, analytics: { overrides: { variantName: "b\nb" } } } : v)),
        { id: "c", name: "C", weight: 0, original: false, description: "", analytics: { extra: { k: "x".repeat(101) } }, changes: [] }, // 新しいパターンは保存済みの値が無い
      ],
    };
    expect(draftValueErrors(initial, current).map((e) => [e.path, e.code])).toEqual([
      [["analytics", "extra", "team"], "empty"],
      [["variants", "b", "analytics", "overrides", "variantName"], "invalid_char"],
      [["variants", "c", "analytics", "extra", "k"], "too_long"],
    ]);
  });
});

describe("B173 第 1 段 Task 7: 変えた欄だけを送る・評価計画をまとめる・新しいサーバーの値の扱い(spec §6.1)", () => {
  it("name-only change sends only { name }", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, name: "x" })).toEqual({ name: "x" });
  });
  it("traffic-only change sends only trafficPercentage", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, traffic: 20 })).toEqual({ trafficPercentage: 20 });
  });
  it("each body field maps to its PATCH key", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, urlMatch: { op: "equals", value: "/x" } })).toEqual({ urlMatch: { op: "equals", value: "/x" } });
    expect(experimentPatchBody(a, { ...a, persist: true })).toEqual({ persistAssignment: true });
    expect(experimentPatchBody(a, { ...a, targeting: { kind: "form", form: { logic: "and", rows: [] } } })).toEqual({ targeting: null });
    expect(experimentPatchBody(a, a)).toEqual({}); // 変えていなければ空
    // メモ・パターンは本体の PATCH に載せない(別の段)
    expect(experimentPatchBody(a, { ...a, description: "x", variants: [] })).toEqual({});
  });
  it("raw targeting is never sent", () => {
    const a = draftOf({ ...EXP, targeting: { hist: "visited", pattern: "p_pricing" } });
    expect(a.targeting.kind).toBe("raw");
    const body = experimentPatchBody(a, { ...a, name: "renamed" });
    expect(body).toEqual({ name: "renamed" });
    expect("targeting" in body).toBe(false);
  });
  it("changing expName sends the whole analytics object", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, expName: "n" })).toEqual({ analytics: { overrides: { experimentName: "n" }, extra: { team: "growth" } } });
    expect(experimentPatchBody(a, { ...a, extra: {} })).toEqual({ analytics: { overrides: { experimentName: "hero_test" } } });
    expect(experimentPatchBody(a, { ...a, expName: "", extra: {} })).toEqual({ analytics: null }); // 両方空なら null
  });
  it("plan-only save sends only the plan PUT", () => {
    const a = draftOf(EXP);
    expect(saveSteps(a, a, "running", { dirty: true })).toEqual({ patchExperiment: false, experimentMemo: false, putVariants: false, variantMemos: [], putChanges: [], putPlan: true });
  });
  it("plan-only save is not treated as nothing-to-send", () => {
    const a = draftOf(EXP);
    expect(hasSteps(saveSteps(a, a, "running", { dirty: true }))).toBe(true);
    expect(hasSteps(saveSteps(a, a, "running", { dirty: false }))).toBe(false);
    expect(hasSteps(saveSteps(a, a, "running"))).toBe(false);
    expect(hasSteps(saveSteps(a, { ...a, description: "m" }, "running"))).toBe(true);
  });
  it("failedTab maps the plan stage to the plan tab", () => {
    expect(failedTab("plan", undefined)).toBe("plan");
    expect(failedTab("plan", "plan")).toBe("plan");
  });
  it("server update while clean replaces base and draft", () => {
    const a = draftOf(EXP);
    const s = { ...a, traffic: 20 };
    expect(reconcileServerUpdate({ base: a, draft: a, server: s })).toEqual({ base: s, draft: s, notice: false });
  });
  it("server update while dirty keeps the draft and shows the notice", () => {
    const a = draftOf(EXP);
    const d = { ...a, name: "mine" };
    const s = { ...a, traffic: 20 };
    expect(reconcileServerUpdate({ base: a, draft: d, server: s })).toEqual({ base: a, draft: d, notice: true });
  });
  it("server update while dirty with the same server value shows no notice", () => {
    const a = draftOf(EXP);
    const d = { ...a, name: "mine" };
    expect(reconcileServerUpdate({ base: a, draft: d, server: draftOf(EXP) })).toEqual({ base: a, draft: d, notice: false });
  });
  it("own save: after onWritten the refreshed server value replaces the draft without a notice, including other users' changes", () => {
    const sent = { ...draftOf(EXP), name: "mine" };
    const s = { ...sent, traffic: 20 };
    expect(reconcileServerUpdate({ base: sent, draft: sent, server: s })).toEqual({ base: s, draft: s, notice: false });
  });
});
