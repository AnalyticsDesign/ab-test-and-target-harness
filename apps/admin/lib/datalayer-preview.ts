import type { AnalyticsSettings } from "@wtt/core";

/**
 * B77(K13、設計書 §5 の「出力」): dataLayer の出力プレビューの 1 行。エクスペリエンス・パターン・目標の 3 か所で共有する。
 * key = サイトの設定の実際のキー名、value = JSON.stringify の形(`"` は `\"` と出る。React の文字列として描くので HTML のエスケープは要らない)。
 * note = 行の注釈、overridden = 本来出力される値(ID・エクスペリエンスの値)を置き換えた行。
 * nested = 追加の値の行(`extraKey` の下のオブジェクトに入る。画面は `extraKey: {` で包んで描く)
 */
export type PreviewLine = { key: string; value: string; note?: string; overridden?: boolean; nested?: boolean };

const line = (key: string, value: string | null, note?: string, overridden?: boolean): PreviewLine => ({
  key,
  value: JSON.stringify(value),
  ...(note ? { note } : {}),
  ...(overridden ? { overridden: true } : {}),
});

/** キーが空の行は入力中なので出さない・数えない(analytics-badges と同じ) */
const keysOf = (extra: Record<string, string>): string[] => Object.keys(extra).filter((k) => k !== "");

/**
 * 露出の push 1 回分(runtime の exposure.ts の 2 回目の push と同じ並び。名前空間を消す 1 回目は出さない)。
 * 名前は「外部計測で指定 ?? ID」(空の名前 = 指定なし)。追加の値はエクスペリエンスの値にパターンの値をキー単位で重ねる(compile と同じ)
 */
export function exposurePreview(
  names: AnalyticsSettings,
  input: { experimentId: string; experimentName: string; variantId: string; variantName: string; experimentExtra: Record<string, string>; variantExtra: Record<string, string> },
): PreviewLine[] {
  const k = names.exposure.keys;
  const lines: PreviewLine[] = [
    line("event", names.exposure.event),
    line(k.experimentId, input.experimentId),
    input.experimentName ? line(k.experimentName, input.experimentName, "指定したエクスペリエンス名", true) : line(k.experimentName, input.experimentId, "指定なし = エクスペリエンス ID"),
    line(k.variantId, input.variantId),
    input.variantName ? line(k.variantName, input.variantName, "指定したパターン名", true) : line(k.variantName, input.variantId, "指定なし = パターン ID"),
  ];
  const expKeys = keysOf(input.experimentExtra);
  const ownKeys = keysOf(input.variantExtra);
  // 並びは { ...エクスペリエンス, ...パターン } と同じ(エクスペリエンスのキーが先、パターンだけのキーが後)
  const keys = [...expKeys, ...ownKeys.filter((key) => !expKeys.includes(key))];
  if (keys.length === 0) return [...lines, { key: names.extraKey, value: "null", note: "追加する情報なし" }];
  for (const key of keys) {
    const own = ownKeys.includes(key);
    const nested = own
      ? line(key, input.variantExtra[key]!, expKeys.includes(key) ? "このパターンの値(エクスペリエンスの値を上書き)" : "このパターンの値", expKeys.includes(key))
      : line(key, input.experimentExtra[key]!, "エクスペリエンスの値");
    lines.push({ ...nested, nested: true });
  }
  return lines;
}

/** CV の push 1 回分(runtime の CV と同じ並び)。目標名は「外部計測で指定 ?? 目標 ID」。目標の追加の値は無いので extraKey は null */
export function conversionPreview(names: AnalyticsSettings, input: { goalId: string; goalName: string }): PreviewLine[] {
  const k = names.conversion.keys;
  return [
    line("event", names.conversion.event),
    line(k.goalId, input.goalId),
    input.goalName ? line(k.goalName, input.goalName, "指定した目標名", true) : line(k.goalName, input.goalId, "指定なし = 目標 ID"),
    line(names.extraKey, null, "追加する情報なし"),
  ];
}

export type SitePreviewSample = {
  experimentId: string;
  experimentName: string;
  variantId: string;
  variantName: string;
  extra: Record<string, string>;
  goalId: string;
  goalName: string;
};

export const SITE_PREVIEW_SAMPLE: SitePreviewSample = {
  experimentId: "<エクスペリエンス ID>",
  experimentName: "",
  variantId: "<パターン ID>",
  variantName: "",
  extra: { example_key: "<値>" },
  goalId: "<目標 ID>",
  goalName: "",
};

export type SitePreviewBlock = {
  id: "exposure" | "conversion" | "rateLimited";
  title: string;
  pushes: PreviewLine[][];
};

export function siteDataLayerPreview(
  names: AnalyticsSettings,
  sample: SitePreviewSample = SITE_PREVIEW_SAMPLE,
): SitePreviewBlock[] {
  return [
    {
      id: "exposure",
      title: "露出",
      pushes: [
        [line(names.extraKey, null, "前の露出の追加情報を消す(イベントなし)")],
        exposurePreview(names, { ...sample, experimentExtra: sample.extra, variantExtra: {} }),
      ],
    },
    {
      id: "conversion",
      title: "コンバージョン",
      pushes: [conversionPreview(names, sample)],
    },
    {
      id: "rateLimited",
      title: "制限に当たったとき",
      pushes: [[line("event", "ab_error"), line("ab_error_type", "rate_limited")]],
    },
  ];
}
