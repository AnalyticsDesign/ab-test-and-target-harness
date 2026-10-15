import { z } from "zod";
import { DEFAULT_ANALYTICS, type AnalyticsSettings, type ExposurePayload } from "./analytics-defaults";

/** spec §10.9 の検証値(GA4 の実制限に合わせる) */
export const ANALYTICS_LIMITS = {
  nameMax: 40,      // パラメータ名・イベント名: 40 字以内
  valueMax: 100,    // 値: 100 字(GA4 標準プロパティの上限。360 の 500 字には合わせない)
  extraKeysMax: 20, // 1 payload の extra のキー数(標準 4 + 名前空間 1 と合わせて 25 パラメータ枠に収まる)
} as const;

/** GA4 のパラメータ名規則 = 英字始まり・英数字とアンダースコアのみ・40 字以内。ドットを禁じるのは DLV Version 2 がネストのパスと解釈するため */
export const ANALYTICS_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** GA4 の予約接頭辞(パラメータ名・イベント名とも始められない) */
// spec §10.9 の 5 接頭辞との対応を保つため全部列挙する。`_` と `gtag.` は ANALYTICS_NAME_RE(英字始まり・ドット不可)が先に弾くので到達しないが、regex を緩めたときに受理が広がらないよう残す
const RESERVED_NAME_PREFIXES = ["_", "firebase_", "ga_", "google_", "gtag."] as const;
/** Web イベント名だけに追加で効く予約接頭辞(GA4 イベント命名規則ヘルプ) */
const RESERVED_EVENT_PREFIXES = ["query_id"] as const;

/**
 * GA4 の予約イベント名と自動収集イベント名。どちらも使うとタグの誤発火や計測の破壊を招くため、イベント名として拒否する。
 * 出典(2026-09-02 取得、その時点の一覧を写したもの):
 * - https://support.google.com/analytics/answer/13316687 (Event naming rules → Reserved event names / Reserved prefixes)
 * - https://support.google.com/analytics/answer/9234069 (Automatically collected events → Web)
 * 範囲: Web の予約名に加え、App 専用の予約名(ad_* / app_* / notification_* / os_update / screen_view)も含めて拒否する
 */
export const GA4_RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  // Reserved event names(Web / App)
  "ad_activeview", "ad_click", "ad_exposure", "ad_impression", "ad_query", "adunit_exposure",
  "app_clear_data", "app_exception", "app_install", "app_remove", "app_store_refund",
  "app_store_subscription_cancel", "app_store_subscription_convert", "app_store_subscription_renew",
  "app_update", "app_upgrade", "error", "first_open", "first_visit", "in_app_purchase",
  "notification_dismiss", "notification_foreground", "notification_open", "notification_receive",
  "os_update", "screen_view", "session_start", "user_engagement",
  // Automatically collected events(Web)
  "click", "file_download", "form_start", "form_submit", "page_view", "scroll",
  "video_complete", "video_progress", "video_start", "view_search_results",
]);

/** キー名(標準キー・extraKey・extra のキー)の検査。問題があれば理由、無ければ null */
export function analyticsNameIssue(name: string): string | null {
  if (!ANALYTICS_NAME_RE.test(name)) return `"${name}" must match ${ANALYTICS_NAME_RE.source} (GA4 parameter name rule: letter first, [A-Za-z0-9_], max ${ANALYTICS_LIMITS.nameMax})`;
  const prefix = RESERVED_NAME_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `"${name}" must not start with the GA4 reserved prefix "${prefix}"`;
  return null;
}

/** イベント名の検査 = キー名の規則 + `query_id` 前置き + 予約 / 自動収集イベント名 */
export function analyticsEventNameIssue(name: string): string | null {
  const base = analyticsNameIssue(name);
  if (base) return base;
  const prefix = RESERVED_EVENT_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `"${name}" must not start with the GA4 reserved event prefix "${prefix}"`;
  if (GA4_RESERVED_EVENT_NAMES.has(name)) return `"${name}" is a GA4 reserved or automatically collected event name`;
  return null;
}

const refineWith = (check: (name: string) => string | null) => (v: string, ctx: z.RefinementCtx): void => {
  const issue = check(v);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
};
export const AnalyticsNameSchema = z.string().superRefine(refineWith(analyticsNameIssue));
export const AnalyticsEventNameSchema = z.string().superRefine(refineWith(analyticsEventNameIssue));
/** 値は文字列 1〜100 字。`.max` は `.length`(素の文字列長)で数える = 全角も 1 文字。URL エンコード後の長さでは数えない(§10.9) */
export const AnalyticsValueSchema = z.string().min(1).max(ANALYTICS_LIMITS.valueMax);

const D = DEFAULT_ANALYTICS;
/**
 * site-settings record の `analytics`(§10.9)。全フィールド optional で、欠けた部分は既定値で埋める。
 * `prefault({})` は「入力が undefined のとき `{}` を **parse して** 内側の default を効かせる」(zod 4。`default` は parse せず値をそのまま返すので入れ子の既定値が埋まらない)
 */
export const AnalyticsSettingsSchema = z
  .strictObject({
    extraKey: AnalyticsNameSchema.default(D.extraKey),
    exposure: z
      .strictObject({
        event: AnalyticsEventNameSchema.default(D.exposure.event),
        keys: z
          .strictObject({
            experimentId: AnalyticsNameSchema.default(D.exposure.keys.experimentId),
            experimentName: AnalyticsNameSchema.default(D.exposure.keys.experimentName),
            variantId: AnalyticsNameSchema.default(D.exposure.keys.variantId),
            variantName: AnalyticsNameSchema.default(D.exposure.keys.variantName),
          })
          .prefault({}),
      })
      .prefault({}),
    conversion: z
      .strictObject({
        event: AnalyticsEventNameSchema.default(D.conversion.event),
        keys: z
          .strictObject({
            goalId: AnalyticsNameSchema.default(D.conversion.keys.goalId),
            goalName: AnalyticsNameSchema.default(D.conversion.keys.goalName),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .superRefine((a, ctx) => {
    // サイト単位の 7 キー名は互いに重複せず、いずれも `event` と一致しない(exposure 4・conversion 2・extraKey をまとめて検査。§10.9)。
    // extra のキーは名前空間の下にネストするので標準キー・event と衝突しえず、ここでは見ない
    const names: Array<[string[], string]> = [
      [["extraKey"], a.extraKey],
      [["exposure", "keys", "experimentId"], a.exposure.keys.experimentId],
      [["exposure", "keys", "experimentName"], a.exposure.keys.experimentName],
      [["exposure", "keys", "variantId"], a.exposure.keys.variantId],
      [["exposure", "keys", "variantName"], a.exposure.keys.variantName],
      [["conversion", "keys", "goalId"], a.conversion.keys.goalId],
      [["conversion", "keys", "goalName"], a.conversion.keys.goalName],
    ];
    const seen = new Map<string, string>();
    for (const [path, name] of names) {
      if (name === "event") ctx.addIssue({ code: "custom", path, message: `${path.join(".")} must not be "event"` });
      const prev = seen.get(name);
      if (prev) ctx.addIssue({ code: "custom", path, message: `${path.join(".")} duplicates ${prev} ("${name}")` });
      else seen.set(name, path.join("."));
    }
    // exposure と conversion のイベント名が同じだと GTM の Custom Event トリガーで区別できず、§10.6 の分析レシピが成立しない
    if (a.exposure.event === a.conversion.event) {
      ctx.addIssue({ code: "custom", path: ["conversion", "event"], message: `exposure.event and conversion.event must differ (both "${a.exposure.event}")` });
    }
  });
// スキーマの出力型と zod-free の型が食い違ったらここでコンパイルエラーにする(双方向)
const _settingsOut: AnalyticsSettings = {} as z.infer<typeof AnalyticsSettingsSchema>;
const _settingsIn: z.infer<typeof AnalyticsSettingsSchema> = {} as AnalyticsSettings;
void _settingsOut; void _settingsIn;

/**
 * Experiment / Variant に著者が書く `analytics`(§10.9)。上書きできる論理フィールドは experimentName / variantName の 2 つだけ。
 * 論理フィールド名で指定するので、サイト側でキー名を変えても上書きが「追加キー」に化けない。
 * experimentId / variantId / イベント名は上書き不可(strict なので列挙外のキーは拒否される)
 */
const extraSchema = z.record(AnalyticsNameSchema, AnalyticsValueSchema).optional();
/** Experiment 側: Experiment 名だけを上書きできる。variantName を書くと全 Variant が GA4 上で同名になるため受け付けない(2026-09-02 決定) */
export const ExperimentAnalyticsSchema = z.strictObject({
  overrides: z.strictObject({ experimentName: AnalyticsValueSchema.optional() }).optional(),
  extra: extraSchema,
});
/** Variant 側: Variant 名だけを上書きできる。experimentName を書くと Variant ごとに Experiment 名が変わり §10.6 のセグメントが壊れるため受け付けない */
export const VariantAnalyticsSchema = z.strictObject({
  overrides: z.strictObject({ variantName: AnalyticsValueSchema.optional() }).optional(),
  extra: extraSchema,
});
export type ExperimentAnalytics = z.infer<typeof ExperimentAnalyticsSchema>;
export type VariantAnalytics = z.infer<typeof VariantAnalyticsSchema>;

/**
 * compiled config の `exposurePayloads[experimentId][variantId]`。`experimentName` / `variantName` は `ExperimentSchema` / `VariantSchema` と同じ `min(1)` のみで、**100 字の最大長だけを意図的に省く** —
 * 導出値(Experiment / Variant の name)は既存 config に 100 字超があり得て、共有スキーマで弾くと bootstrap 404 になる(§10.9)。
 * 拒否は control の保存 API(§13.5)、compile は警告(analyticsWarnings)。
 * `extra` のキー名・値の規則(予約接頭辞・1〜100 字)は既存 config が parse できなくなるため **緩める方向のみ**変更できる。厳しくする変更は `schemaVersion` を上げて edge 先行デプロイの手順を踏む
 */
export const ExposurePayloadSchema = z.strictObject({
  experimentId: z.string().min(1),
  experimentName: z.string().min(1),
  variantId: z.string().min(1),
  variantName: z.string().min(1),
  extra: z.record(AnalyticsNameSchema, AnalyticsValueSchema),
});
const _payloadOut: ExposurePayload = {} as z.infer<typeof ExposurePayloadSchema>;
void _payloadOut;

type ExperimentCarrier = { id: string; name: string; analytics?: ExperimentAnalytics | undefined };
type VariantCarrier = { id: string; name: string; analytics?: VariantAnalytics | undefined };

/**
 * 合成規則(§10.9、2026-09-02 決定): Experiment 名は Experiment の overrides ← 無ければ Experiment の name、
 * Variant 名は Variant の overrides ← 無ければ Variant の name。レベルをまたぐ上書きは無い(スキーマが受け付けない)。
 * extra はキー単位の浅いマージ(Variant が Experiment の同名キーを上書き)。experimentId / variantId は上書きしない
 */
export function resolveExposurePayload(exp: ExperimentCarrier, variant: VariantCarrier): ExposurePayload {
  return {
    experimentId: exp.id,
    experimentName: exp.analytics?.overrides?.experimentName ?? exp.name,
    variantId: variant.id,
    variantName: variant.analytics?.overrides?.variantName ?? variant.name,
    extra: { ...(exp.analytics?.extra ?? {}), ...(variant.analytics?.extra ?? {}) },
  };
}

/** 解決後の姿に対する検証(§10.9「検証は Experiment × Variant を解決した後の姿に対して行う」)。今は extra のキー数のみ */
export function exposurePayloadIssue(p: ExposurePayload): string | null {
  const n = Object.keys(p.extra).length;
  return n > ANALYTICS_LIMITS.extraKeysMax ? `extra has ${n} keys (max ${ANALYTICS_LIMITS.extraKeysMax})` : null;
}

/** 警告 1 件。Plan 4 の保存 API はこの構造から機械可読な 422(例: `{ error: "analytics_value_too_long", path, message }`)を組み立てる */
export type AnalyticsWarning = { path: string; message: string };

/**
 * 拒否ではなく警告に留める検査(§10.9 / §13.5): 導出値(Experiment / Variant / Goal の name)が 100 字を超える。
 * GA4 は 100 字超のパラメータ値を破棄する。control の保存 API は 422 で拒否し、fixture CLI はこの警告を stderr に出す。
 * **元の name を直接見る** — 短い override で隠れた長い name も検出する(override を外した瞬間に GA4 が値を破棄するため)。
 * 解決済み payload 側(exposurePayloads)も見るのは、authored な override の 1〜100 字検証が将来緩んだ場合の保険
 */
export function analyticsWarnings(config: {
  goals: Array<{ id: string; name: string }>;
  experiments: Array<{ id: string; name: string; variants: Array<{ id: string; name: string }> }>;
  exposurePayloads?: Record<string, Record<string, ExposurePayload>> | undefined;
}): AnalyticsWarning[] {
  const max = ANALYTICS_LIMITS.valueMax;
  const out: AnalyticsWarning[] = [];
  const over = (path: string, label: string, value: string): void => {
    if (value.length > max) out.push({ path, message: `${label} is ${value.length} chars (GA4 drops parameter values over ${max}; control rejects this at save time)` });
  };
  for (const g of config.goals) over(`goals.${g.id}.name`, `goal ${g.id}: name`, g.name);
  for (const e of config.experiments) {
    over(`experiments.${e.id}.name`, `experiment ${e.id}: name`, e.name);
    for (const v of e.variants) over(`experiments.${e.id}.variants.${v.id}.name`, `experiment ${e.id} variant ${v.id}: name`, v.name);
  }
  for (const [eid, byVariant] of Object.entries(config.exposurePayloads ?? {})) {
    for (const [vid, p] of Object.entries(byVariant)) {
      over(`exposurePayloads.${eid}.${vid}.experimentName`, `experiment ${eid} variant ${vid}: experimentName`, p.experimentName);
      over(`exposurePayloads.${eid}.${vid}.variantName`, `experiment ${eid} variant ${vid}: variantName`, p.variantName);
    }
  }
  return out;
}
