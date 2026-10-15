import { test, expect } from "@playwright/test";
import { bucketOf } from "@wtt/core";
import { findVisitor, foldDataLayer, presetVisitor, readDataLayer } from "./helpers";

// site_analytics(fixtures/e2e-analytics.json): 名札をすべて wtt_* に変更、exp_pricing は overrides + extra、exp_promo は extra のみ
const EXPOSURE = "wtt_exposure";
const CONVERSION = "wtt_conversion";
const EXTRA = "wtt_x";

async function waitForExposures(page: import("@playwright/test").Page, n: number): Promise<Array<Record<string, unknown>>> {
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === EXPOSURE).length).toBe(n);
  return readDataLayer(page);
}

test("renamed_exposure_keys_reach_datalayer", async ({ context, page }) => {
  const id = findVisitor("exp_pricing", "B");
  await presetVisitor(context, id);
  await page.goto("/analytics.html");
  await expect(page.locator(".hero-title")).toHaveText("価格ページ B");
  const pushes = await waitForExposures(page, 2);
  // exp_pricing vB: サイト単位のキー名 + Experiment / Variant の overrides と extra(Variant が test_group を上書き)
  expect(pushes.filter((e) => e.event === EXPOSURE && e.wtt_exp_id === "exp_pricing")).toEqual([
    { event: EXPOSURE, wtt_exp_id: "exp_pricing", wtt_exp_name: "Pricing Q3", wtt_var_id: "vB", wtt_var_name: "New hero", [EXTRA]: { test_group: "pricing_q3_b", external_exp_id: "E-101" } },
  ]);
  // exp_promo: 割当は ID 次第なので bucket から期待 Variant を算出。extra は Experiment 単位で Variant に依らない
  const promoVariant = bucketOf(id, "exp_promo") < 5000 ? "vA" : "vB";
  expect(pushes.filter((e) => e.event === EXPOSURE && e.wtt_exp_id === "exp_promo")).toEqual([
    { event: EXPOSURE, wtt_exp_id: "exp_promo", wtt_exp_name: "Promo", wtt_var_id: promoVariant, wtt_var_name: promoVariant === "vA" ? "A" : "B", [EXTRA]: { campaign: "autumn" } },
  ]);
  // 既定名は一切出ない(名札はサイト単位で置き換わる)
  for (const p of pushes) for (const k of Object.keys(p)) expect(k.startsWith("ab_"), `${k} in ${JSON.stringify(p)}`).toBe(false);
  expect(pushes.some((p) => p.event === "ab_exposure")).toBe(false);
  // conversion も同じサイト設定の名前で、名前空間を null にして 1 回で push する
  await page.click("#cta");
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === CONVERSION)).toEqual([
    { event: CONVERSION, wtt_goal_id: "g_cta", wtt_goal_name: "CTA click", [EXTRA]: null },
  ]);
});

test("extra_namespace_holds_only_current_experiment_keys", async ({ context, page }) => {
  // 生の push 列ではなくマージ後のモデルで検証する(§10.9「テスト」)。GTM の data layer は push をマージし省略キーが残るため、
  // 各 WTT イベント時点で名前空間がその Experiment のキーだけを持つことが契約
  await presetVisitor(context, findVisitor("exp_pricing", "B"));
  await page.goto("/analytics.html");
  await waitForExposures(page, 2);
  await page.click("#cta");
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === CONVERSION).length).toBe(1);
  const pushes = await readDataLayer(page);
  const models = foldDataLayer(pushes);
  const expected: Record<string, Record<string, string>> = {
    exp_pricing: { test_group: "pricing_q3_b", external_exp_id: "E-101" },
    exp_promo: { campaign: "autumn" },
  };
  let exposuresSeen = 0;
  pushes.forEach((p, i) => {
    const model = models[i]!;
    if (p.event === EXPOSURE) {
      exposuresSeen++;
      const expId = String(p.wtt_exp_id);
      expect(model[EXTRA], `at exposure of ${expId}`).toEqual(expected[expId]); // 他方の Experiment のキーが混ざらない(toEqual はキー集合まで一致を要求)
      expect(model.wtt_exp_id).toBe(expId);
    }
    if (p.event === CONVERSION) {
      expect(model[EXTRA], "at conversion").toBeNull(); // Conversion 時点で名前空間は消えている
      expect(model.wtt_goal_id).toBe("g_cta");
    }
  });
  expect(exposuresSeen).toBe(2);
  // 消去はイベントの直前だけ: 最後の Exposure の直後に残るモデルの標準キーはその Experiment のもの(§10.9 注意書きの挙動を固定)
  const lastExposureIdx = pushes.map((p) => p.event).lastIndexOf(EXPOSURE);
  const conversionIdx = pushes.findIndex((p) => p.event === CONVERSION);
  expect(models[conversionIdx - 1]!.wtt_exp_id).toBe(pushes[lastExposureIdx]!.wtt_exp_id);
  expect(pushes.slice(lastExposureIdx + 1, conversionIdx)).toEqual([]); // 最後の Exposure と Conversion の間に push は無い(消去は直前だけ、直後には行わない)
});

test("foldDataLayer follows the data-layer-helper merge rules", () => {
  // 実際の runtime は部分オブジェクトを分割 push しないため、E2E フロー単体では shallow merge への劣化を検出できない。ここで規則を直接固定する
  const models = foldDataLayer([
    { a: { x: 1 } },
    { a: { y: 2 } }, // plain object 同士は再帰マージ
    { a: null }, // null はオブジェクト全体を置換
    { a: { x: 1 } },
    { a: [1] },
    { a: [2] }, // 配列はマージせず置換
  ]);
  expect(models[0]!.a).toEqual({ x: 1 });
  expect(models[1]!.a).toEqual({ x: 1, y: 2 });
  expect(models[2]!.a).toBeNull();
  expect(models[3]!.a).toEqual({ x: 1 });
  expect(models[4]!.a).toEqual([1]);
  expect(models[5]!.a).toEqual([2]);

  // 各スナップショットは独立(structuredClone): 後のスナップショットを変更しても前のものは変わらない
  (models[3]!.a as Record<string, unknown>).x = 999;
  expect(models[3]!.a).toEqual({ x: 999 });
  expect(models[1]!.a).toEqual({ x: 1, y: 2 });
});
