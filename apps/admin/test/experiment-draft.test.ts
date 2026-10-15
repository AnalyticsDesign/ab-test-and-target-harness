import { describe, expect, it } from "vitest";
import { draftOf, failedTab, isDirty, targetingBody } from "@/lib/experiment-draft";
import type { Experiment } from "@/lib/types";

const EXP = {
  id: "exp_a", siteId: "s", name: "Hero", status: "draft", publishedStatus: null, urlMatch: { op: "equals", value: "/" }, targeting: { ctx: "device", op: "in", value: ["mobile"] },
  trafficPercentage: 100, persistAssignment: false, analytics: { overrides: { experimentName: "hero_test" }, extra: { team: "growth" } },
  createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: true,
  variants: [{ id: "a", name: "A", weight: 50, analytics: null, changes: [] }, { id: "b", name: "B", weight: 50, analytics: null, changes: [] }],
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
    expect(failedTab("patch", "analytics")).toBe("analytics");
    expect(failedTab("variants", "0")).toBe("variants");
    expect(failedTab("changes", "payload")).toBe("variants");
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
