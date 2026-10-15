/**
 * spec §10.9(決定 32): dataLayer の名札(イベント名・キー名・extra の名前空間キー)の既定値。
 * **このモジュールは zod を import しない** — runtime(10KB gzip 予算、zod 不在ゲート)が既定値を import するため。
 * zod のスキーマ・検証は analytics.ts に置く
 */
export type AnalyticsSettings = {
  extraKey: string;
  exposure: {
    event: string;
    keys: { experimentId: string; experimentName: string; variantId: string; variantName: string };
  };
  conversion: {
    event: string;
    keys: { goalId: string; goalName: string };
  };
};

export const DEFAULT_ANALYTICS: AnalyticsSettings = {
  extraKey: "ab_extra",
  exposure: {
    event: "ab_exposure",
    keys: { experimentId: "ab_experiment_id", experimentName: "ab_experiment_name", variantId: "ab_variant_id", variantName: "ab_variant_name" },
  },
  conversion: {
    event: "ab_conversion",
    keys: { goalId: "ab_goal_id", goalName: "ab_goal_name" },
  },
};

/**
 * compile が Experiment × Variant ごとに解決して compiled config の `exposurePayloads` に焼く値(§10.9)。
 * runtime はこれにサイト設定のキー名を当てて push するだけで、合成ロジックを持たない。
 * `extra` は常に存在する(無ければ `{}`)。runtime は空なら `[extraKey]: null` を push する
 */
export type ExposurePayload = {
  experimentId: string;
  experimentName: string;
  variantId: string;
  variantName: string;
  extra: Record<string, string>;
};
