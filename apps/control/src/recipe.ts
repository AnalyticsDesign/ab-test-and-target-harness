import { DEFAULT_ANALYTICS, type AnalyticsSettings } from "@wtt/core";
import type { ExperimentRow, GoalRow, SiteRow } from "./db";

export const GA4_PROPERTY_PLACEHOLDER = "{{GA4_PROPERTY_ID}}";
export const BQ_DATASET_PLACEHOLDER = "{{BQ_DATASET}}";

/** そのまま送れる HTTP リクエスト(決定 39 (5)。エージェントは url に body を POST するだけでよい) */
export type Ga4Request = { method: "POST"; url: string; body: Record<string, unknown> };

export type AnalyticsRecipe = {
  experiment: { id: string; name: string; startedAt: number | null; stoppedAt: number | null };
  period: { start: string; end: string };
  ga4: { propertyId: string; exposureByVariant: Ga4Request; conversionsByGoal: Ga4Request };
  bigquery: { dataset: string; visitorCvrSql: string; sessionCvrSql: string; mixedExposureCountSql: string };
  goals: Array<{ id: string; name: string; type: string }>;
  /** 読み手(エージェント)が結果を誤読しないための注記(決定 39 (8)) */
  notes: string[];
};

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ymdCompact = (ms: number): string => ymd(ms).replace(/-/g, "");
/** BigQuery のリテラル。ID は Goal のように任意文字列を取り得るのでエスケープする */
const lit = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** GA4 の event_params から 1 つ取り出す副問い合わせ */
const param = (key: string): string => `(SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = ${lit(key)})`;

/**
 * spec §13.10 / 決定 39 (5): 数値ではなく**クエリ**を返す。外部通信はしない。
 * GA4 Data API 側は v1beta runReport 2 本(Variant 別 exposure = 配分 / SRM の確認、Goal 別 conversion 数)。
 * Variant 別 CVR は GA4 だけでは出せない(conversion の payload に experiment / variant が無い)ので BigQuery SQL に委ねる
 */
export function analyticsRecipe(input: { site: SiteRow; experiment: ExperimentRow; goals: GoalRow[]; now: number }): AnalyticsRecipe {
  const { site, experiment, goals, now } = input;
  const names: AnalyticsSettings = site.analytics_json ? (JSON.parse(site.analytics_json) as AnalyticsSettings) : DEFAULT_ANALYTICS;
  const propertyId = site.ga4_property_id ?? GA4_PROPERTY_PLACEHOLDER;
  const dataset = site.bigquery_dataset ?? BQ_DATASET_PLACEHOLDER;
  const startMs = experiment.started_at ?? experiment.created_at; // 未 Start は作成日から(まだデータは無い)
  const endMs = experiment.stopped_at ?? now;
  const period = { start: ymd(startMs), end: ymd(endMs) };
  // GA4 export の日次テーブルの日付は**プロパティのタイムゾーン**で、UTC の event_timestamp と最大 1 日ずれる。
  // 走査範囲は「開始の UTC 日付 − 1 日」〜「終了の UTC 日付 + 1 日」に広げ、**採否は下の event_timestamp(UTC µs)条件で決める**
  // (広げた分は時刻条件で落ちるので数え過ぎにはならない。逆に UTC 日付ちょうどで切ると期間内のイベントを落とす。CX-High-7)
  const DAY_MS = 86_400_000;
  const suffix = { start: ymdCompact(startMs - DAY_MS), end: ymdCompact(endMs + DAY_MS) };
  const goalIds = goals.map((g) => g.id);

  const dateRanges = [{ startDate: period.start, endDate: period.end }];
  const eventFilter = (event: string) => ({ filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: event } } });
  // property は URL パスで指定する(v1beta runReport)。body に property を入れる形は API の契約に無い
  const runReportUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const exposureByVariant: Ga4Request = {
    method: "POST",
    url: runReportUrl,
    body: {
      dateRanges,
      dimensions: [{ name: `customEvent:${names.exposure.keys.variantId}` }],
      metrics: [{ name: "totalUsers" }, { name: "sessions" }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            eventFilter(names.exposure.event),
            { filter: { fieldName: `customEvent:${names.exposure.keys.experimentId}`, stringFilter: { matchType: "EXACT", value: experiment.id } } },
          ],
        },
      },
      keepEmptyRows: false,
    },
  };
  const conversionsByGoal: Ga4Request = {
    method: "POST",
    url: runReportUrl,
    body: {
      dateRanges,
      dimensions: [{ name: `customEvent:${names.conversion.keys.goalId}` }],
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
      // conversion の payload には experiment / variant が入らない(§10.6)ので Experiment で絞れない。
      // Variant 別に見るには BigQuery(下)を使う(決定 39 (5))
      dimensionFilter: eventFilter(names.conversion.event),
      keepEmptyRows: false,
    },
  };

  const goalArray = `ARRAY<STRING>[${goalIds.map(lit).join(", ")}]`;
  // 走査するテーブルは日付で絞り(_TABLE_SUFFIX)、集計対象は実験の開始・終了の**時刻**で絞る(GA4 の event_timestamp は µs)。
  // 日付だけだと、同じ日の開始前・停止後のイベント(12 時に停止した実験の 18 時の conversion 等)を数えてしまう
  const startUs = startMs * 1000;
  const endUs = endMs * 1000;
  const events =
    `FROM \`${dataset}.events_*\`\n  WHERE _TABLE_SUFFIX BETWEEN ${lit(suffix.start)} AND ${lit(suffix.end)}` +
    `\n    AND event_timestamp BETWEEN ${startUs} AND ${endUs}`;
  const sessionId = `CONCAT(user_pseudo_id, '.', CAST((SELECT ep.value.int_value FROM UNNEST(event_params) ep WHERE ep.key = 'ga_session_id') AS STRING))`;

  const visitorCvrSql = `-- 訪問者単位のパターン別 CVR
-- 単位 = user_pseudo_id。最初の exposure より後の conversion だけを数える。
-- 複数パターンに露出した訪問者は**除外せず**、期間内の初回露出のパターンに帰属させる(intention-to-treat)
WITH exposure AS (
  SELECT
    user_pseudo_id,
    ${param(names.exposure.keys.experimentId)} AS experiment_id,
    ${param(names.exposure.keys.variantId)} AS variant_id,
    TIMESTAMP_MICROS(event_timestamp) AS exposed_at,
    -- 同一 timestamp の露出から「初回」を決めるための GA4 export の順序列
    batch_page_id,
    batch_ordering_id,
    batch_event_index
  ${events}
    AND event_name = ${lit(names.exposure.event)}
),
assigned AS (
  -- 初回露出の 1 行だけを採る = 帰属するパターンと、その後の conversion を数える起点。
  -- GA4 は同じリクエストで送った複数イベントに同じ event_timestamp を付けることがあるので、batch 内の順序列で並びを固定する
  -- (順序列も等しい場合は不定。NULL は末尾に置く)
  SELECT user_pseudo_id, variant_id, exposed_at
  FROM (
    SELECT
      user_pseudo_id,
      variant_id,
      exposed_at,
      ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn
    FROM exposure
    WHERE experiment_id = ${lit(experiment.id)} AND variant_id IS NOT NULL
  )
  WHERE rn = 1
),
conversion AS (
  SELECT
    user_pseudo_id,
    ${param(names.conversion.keys.goalId)} AS goal_id,
    TIMESTAMP_MICROS(event_timestamp) AS converted_at
  ${events}
    AND event_name = ${lit(names.conversion.event)}
)
SELECT
  a.variant_id,
  g AS goal_id,
  COUNT(DISTINCT a.user_pseudo_id) AS visitors,
  COUNT(DISTINCT c.user_pseudo_id) AS converters,
  SAFE_DIVIDE(COUNT(DISTINCT c.user_pseudo_id), COUNT(DISTINCT a.user_pseudo_id)) AS cvr
FROM assigned a
CROSS JOIN UNNEST(${goalArray}) AS g
LEFT JOIN conversion c
  ON c.user_pseudo_id = a.user_pseudo_id AND c.goal_id = g AND c.converted_at >= a.exposed_at
GROUP BY a.variant_id, g
ORDER BY a.variant_id, g
`;

  const sessionCvrSql = `-- セッション単位のパターン別 CVR(訪問者単位の併記)
-- 単位 = user_pseudo_id + ga_session_id。露出したセッション内の、露出より後の conversion だけを数える。
-- セッション内で複数パターンに露出した場合も除外せず、そのセッションの初回露出のパターンに帰属させる
WITH exposure AS (
  SELECT
    ${sessionId} AS session_id,
    ${param(names.exposure.keys.experimentId)} AS experiment_id,
    ${param(names.exposure.keys.variantId)} AS variant_id,
    TIMESTAMP_MICROS(event_timestamp) AS exposed_at,
    -- 同一 timestamp の露出から「初回」を決めるための GA4 export の順序列
    batch_page_id,
    batch_ordering_id,
    batch_event_index
  ${events}
    AND event_name = ${lit(names.exposure.event)}
),
assigned AS (
  -- セッション内の初回露出の 1 行だけを採る。同じ event_timestamp の露出は batch 内の順序列で並べる
  -- (順序列も等しい場合は不定。NULL は末尾)
  SELECT session_id, variant_id, exposed_at
  FROM (
    SELECT
      session_id,
      variant_id,
      exposed_at,
      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn
    FROM exposure
    WHERE experiment_id = ${lit(experiment.id)} AND variant_id IS NOT NULL
  )
  WHERE rn = 1
),
conversion AS (
  SELECT
    ${sessionId} AS session_id,
    ${param(names.conversion.keys.goalId)} AS goal_id,
    TIMESTAMP_MICROS(event_timestamp) AS converted_at
  ${events}
    AND event_name = ${lit(names.conversion.event)}
)
SELECT
  a.variant_id,
  g AS goal_id,
  COUNT(DISTINCT a.session_id) AS sessions,
  COUNT(DISTINCT c.session_id) AS converting_sessions,
  SAFE_DIVIDE(COUNT(DISTINCT c.session_id), COUNT(DISTINCT a.session_id)) AS cvr
FROM assigned a
CROSS JOIN UNNEST(${goalArray}) AS g
LEFT JOIN conversion c
  ON c.session_id = a.session_id AND c.goal_id = g AND c.converted_at >= a.exposed_at
GROUP BY a.variant_id, g
ORDER BY a.variant_id, g
`;

  // 決定 39 (8): 除外しないぶん、混在の規模は別に測れるようにする(帰属の妥当性を読み手が判断するため)
  const mixedExposureCountSql = `-- 複数パターンに露出した訪問者数 / セッション数
-- CVR の 2 本は初回露出に帰属させて母数に残すので、混在がどれだけあるかはここで確認する
WITH exposure AS (
  SELECT
    user_pseudo_id,
    ${sessionId} AS session_id,
    ${param(names.exposure.keys.experimentId)} AS experiment_id,
    ${param(names.exposure.keys.variantId)} AS variant_id
  ${events}
    AND event_name = ${lit(names.exposure.event)}
),
scoped AS (
  SELECT * FROM exposure WHERE experiment_id = ${lit(experiment.id)} AND variant_id IS NOT NULL
)
SELECT
  (SELECT COUNT(*) FROM (SELECT user_pseudo_id FROM scoped GROUP BY user_pseudo_id HAVING COUNT(DISTINCT variant_id) > 1)) AS mixed_visitors,
  (SELECT COUNT(*) FROM (SELECT session_id FROM scoped GROUP BY session_id HAVING COUNT(DISTINCT variant_id) > 1)) AS mixed_sessions,
  (SELECT COUNT(DISTINCT user_pseudo_id) FROM scoped) AS visitors,
  (SELECT COUNT(DISTINCT session_id) FROM scoped) AS sessions
`;

  const notes = [
    "複数パターンに露出した訪問者 / セッションは、期間内の初回露出のパターンに帰属させる(intention-to-treat)。母数から除外はしない",
    "混在の規模(複数パターンに露出した訪問者数 / セッション数)は mixedExposureCountSql で確認する",
    "同じ event_timestamp の露出は GA4 export の batch 内順序列(batch_page_id / batch_ordering_id / batch_event_index)で並べて初回を決める。順序列も等しい場合は不定",
    "_TABLE_SUFFIX の走査範囲は events_YYYYMMDD のみで、当日ぶんの events_intraday_YYYYMMDD は含まない。配信中のエクスペリエンスでは当日ぶんのイベントが日次エクスポートが着地するまで反映されない",
  ];
  if (goals.length === 0) {
    notes.push(
      "このサイトには目標が無いので visitorCvrSql / sessionCvrSql は 0 行を返す(CROSS JOIN UNNEST の対象配列が空になり、露出の母数すら出ない)。先に目標を作ること。mixedExposureCountSql と GA4 の exposureByVariant は目標無しでも機能する",
    );
  }
  // 決定 51(設計書 §3.4): パーソナライズはパターン 1 つで振り分けないので、パターンどうしの比較も割り振りの偏りの確認も成り立たない
  if (experiment.kind === "single") notes.push("パーソナライズなので、比較と SRM の確認は意味を持ちません");

  return {
    experiment: { id: experiment.id, name: experiment.name, startedAt: experiment.started_at, stoppedAt: experiment.stopped_at },
    period,
    ga4: { propertyId, exposureByVariant, conversionsByGoal },
    bigquery: { dataset, visitorCvrSql, sessionCvrSql, mixedExposureCountSql },
    goals: goals.map((g) => ({ id: g.id, name: g.name, type: g.type })),
    notes,
  };
}
