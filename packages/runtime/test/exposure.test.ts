import { expect, it } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { createExposureTracker } from "../src/exposure";
import { baseConfig, namedConfig, renamedAnalytics } from "./fixtures";

it("pushes the namespace clear then ab_exposure once per experiment (spec §10.5 / §10.9)", () => {
  const pushed: Array<Record<string, unknown>> = [];
  const t = createExposureTracker(baseConfig, DEFAULT_ANALYTICS, { exp_hero: "vB" }, (e) => pushed.push(e));
  t.expose("exp_hero");
  t.expose("exp_hero"); // 2 回目は無視(Experiment ごとに 1 回)
  expect(pushed).toEqual([
    { ab_extra: null }, // 1 回目は名前空間の消去だけ。event を含まないので GTM トリガーは発火しない
    { event: "ab_exposure", ab_experiment_id: "exp_hero", ab_experiment_name: "Hero", ab_variant_id: "vB", ab_variant_name: "B", ab_extra: null },
  ]);
});

it("ignores experiments without an assignment", () => {
  const pushed: unknown[] = [];
  const t = createExposureTracker(baseConfig, DEFAULT_ANALYTICS, {}, (e) => pushed.push(e));
  t.expose("exp_hero");
  expect(pushed).toEqual([]);
});

it("reset() lets the same experiment expose again after a revoke (2026-09-01 決定)", () => {
  const assignments: Record<string, string> = { exp_hero: "vB" };
  const pushed: unknown[] = [];
  const t = createExposureTracker(baseConfig, DEFAULT_ANALYTICS, assignments, (e) => pushed.push(e));
  t.expose("exp_hero");
  t.reset();
  assignments.exp_hero = "vA"; // 再 grant で新 ID → 別 Variant になり得る
  t.expose("exp_hero");
  expect(pushed).toHaveLength(4); // (消去 + イベント)× 2
  expect((pushed[3] as Record<string, unknown>).ab_variant_id).toBe("vA");
});

it("applies site key names and the resolved payload, nesting extra under extraKey (spec §10.9)", () => {
  const pushed: Array<Record<string, unknown>> = [];
  const t = createExposureTracker(namedConfig, renamedAnalytics, { exp_hero: "vB" }, (e) => pushed.push(e));
  t.expose("exp_hero");
  expect(pushed).toEqual([
    { wtt_x: null },
    { event: "wtt_exposure", wtt_exp_id: "exp_hero", wtt_exp_name: "Hero Q3", wtt_var_id: "vB", wtt_var_name: "New hero", wtt_x: { test_group: "pricing_q3", external_exp_id: "E-101" } },
  ]);
  // extra を持たない Variant でも消去は行い、イベント側の名前空間は null(前の Experiment の値を残さない)
  const pushedA: Array<Record<string, unknown>> = [];
  createExposureTracker(namedConfig, renamedAnalytics, { exp_hero: "vA" }, (e) => pushedA.push(e)).expose("exp_hero");
  expect(pushedA).toEqual([
    { wtt_x: null },
    { event: "wtt_exposure", wtt_exp_id: "exp_hero", wtt_exp_name: "Hero Q3", wtt_var_id: "vA", wtt_var_name: "Control", wtt_x: null },
  ]);
});

it("missing_exposure_payload_entry_uses_derived_defaults", () => {
  // exposurePayloads に当該 Experiment × Variant のエントリが無い(旧 config / 部分欠落)→ experiments[] の id / name から導出し extra なし。
  // 名前空間の消去はこの場合も行う(§10.9「バージョンと異常時」)
  const partial = { ...namedConfig, exposurePayloads: { exp_other: { vA: { experimentId: "exp_other", experimentName: "X", variantId: "vA", variantName: "A", extra: { k: "v" } } } } };
  const pushed: Array<Record<string, unknown>> = [];
  createExposureTracker(partial, renamedAnalytics, { exp_hero: "vB" }, (e) => pushed.push(e)).expose("exp_hero");
  expect(pushed).toEqual([
    { wtt_x: null },
    { event: "wtt_exposure", wtt_exp_id: "exp_hero", wtt_exp_name: "Hero", wtt_var_id: "vB", wtt_var_name: "B", wtt_x: null },
  ]);
  // Variant 単位で欠けている場合も同じ
  const variantMissing = { ...namedConfig, exposurePayloads: { exp_hero: { vA: namedConfig.exposurePayloads!.exp_hero!.vA! } } };
  const pushed2: Array<Record<string, unknown>> = [];
  createExposureTracker(variantMissing, renamedAnalytics, { exp_hero: "vB" }, (e) => pushed2.push(e)).expose("exp_hero");
  expect(pushed2[1]).toMatchObject({ wtt_exp_name: "Hero", wtt_var_name: "B", wtt_x: null });
});

it("pushes the assigned ids even if the baked payload carries different id copies", () => {
  // CompiledConfigSchema はキー↔ID 不一致を拒否するが、runtime 単体でも不変条件を持つ(CL-Medium-2)
  const drifted = { ...namedConfig, exposurePayloads: { exp_hero: { vB: { ...namedConfig.exposurePayloads!.exp_hero!.vB!, experimentId: "exp_other", variantId: "vZ" } } } };
  const pushed: Array<Record<string, unknown>> = [];
  createExposureTracker(drifted, renamedAnalytics, { exp_hero: "vB" }, (e) => pushed.push(e)).expose("exp_hero");
  expect(pushed[1]).toMatchObject({ wtt_exp_id: "exp_hero", wtt_var_id: "vB", wtt_exp_name: "Hero Q3", wtt_var_name: "New hero" });
});
