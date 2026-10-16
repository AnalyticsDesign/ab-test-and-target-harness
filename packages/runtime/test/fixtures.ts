import type { AnalyticsSettings, CompiledConfig, RuntimeSettings } from "@wtt/core";

export const baseConfig: CompiledConfig = {
  schemaVersion: 2, version: 3, siteId: "site_unit", siteSalt: "salt",
  needsProfile: false, patterns: {},
  prehide: { exp_hero: [".hero-title"] },
  exposureSelectors: { exp_hero: [".hero-title"] },
  goals: [{ id: "g_cta", name: "CTA click", type: "CUSTOM", config: {} }],
  experiments: [{
    id: "exp_hero", name: "Hero", urlMatch: { op: "contains", value: "/" },
    trafficPercentage: 100, persistAssignment: false,
    variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "B!" } }] },
    ],
  }],
};

/** persistAssignment: true で needsProfile が立ち remote 経路になる(§7.1) */
export const remoteConfig: CompiledConfig = {
  ...baseConfig,
  needsProfile: true,
  experiments: [{ ...baseConfig.experiments[0]!, persistAssignment: true }],
};

export const baseSettings: RuntimeSettings = {
  mode: "A", idSource: "ab",
  visitorCookieName: "_ab_vid", uuidCookieEnabled: false, uuidCookieName: "_ab_uuid",
  previousCookieNames: [], decisionTimeoutMs: 1000, consentMode: "implicit",
};

/** spec §10.9: 名前を変えたサイト設定。baseSettings(analytics 無し = 旧 record)と対で使う */
export const renamedAnalytics: AnalyticsSettings = {
  dataLayerName: "dataLayer",
  extraKey: "wtt_x",
  exposure: { event: "wtt_exposure", keys: { experimentId: "wtt_exp_id", experimentName: "wtt_exp_name", variantId: "wtt_var_id", variantName: "wtt_var_name" } },
  conversion: { event: "wtt_conversion", keys: { goalId: "wtt_goal_id", goalName: "wtt_goal_name" } },
};
export const namedSettings: RuntimeSettings = { ...baseSettings, analytics: renamedAnalytics };

/** compile が焼いた exposurePayloads を持つ config(vB に extra、vA は extra なし) */
export const namedConfig: CompiledConfig = {
  ...baseConfig,
  exposurePayloads: {
    exp_hero: {
      vA: { experimentId: "exp_hero", experimentName: "Hero Q3", variantId: "vA", variantName: "Control", extra: {} },
      vB: { experimentId: "exp_hero", experimentName: "Hero Q3", variantId: "vB", variantName: "New hero", extra: { test_group: "pricing_q3", external_exp_id: "E-101" } },
    },
  },
};

/** Goals 付き needsProfile config(persistAssignment で remote 経路)。PAGEVIEW は happy-dom の URL(https://site.test/pricing?utm=x)に一致 */
export const goalsConfig: CompiledConfig = {
  ...remoteConfig,
  goals: [
    { id: "g_cta", name: "CTA click", type: "CUSTOM", config: {} },
    { id: "g_pv", name: "Pricing view", type: "PAGEVIEW", config: { page: { op: "contains", value: "/pricing" } } },
    { id: "g_click", name: "CTA", type: "CLICK", config: { selector: ".cta" } },
  ],
};
