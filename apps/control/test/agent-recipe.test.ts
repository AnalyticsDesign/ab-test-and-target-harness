import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { call, createExperiment, createSite, json, setupOwner } from "./helpers";
import { getDb } from "../src/db";

type Recipe = {
  experiment: { id: string; name: string; startedAt: number | null; stoppedAt: number | null };
  period: { start: string; end: string };
  ga4: { propertyId: string; exposureByVariant: Record<string, unknown>; conversionsByGoal: Record<string, unknown> };
  bigquery: { dataset: string; visitorCvrSql: string; sessionCvrSql: string; mixedExposureCountSql: string };
  goals: Array<{ id: string; name: string; type: string }>;
  notes: string[];
};

/** 正規表現の中で使うためのエスケープ(SQL の境界リテラルをそのまま数える) */
const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** started_at / stopped_at を固定して期間を決定論にする(status 遷移で入る値を直接書き換える) */
async function setPeriod(sid: string, eid: string, startedAt: number, stoppedAt: number | null): Promise<void> {
  await sql`update experiments set started_at = ${startedAt}, stopped_at = ${stoppedAt} where site_id = ${sid} and id = ${eid}`.execute(getDb(env));
}

async function recipeSite(sitePatch: Record<string, unknown> = {}) {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  if (Object.keys(sitePatch).length > 0) {
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: sitePatch })).status).toBe(200);
  }
  await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_lead", name: "資料請求", type: "CUSTOM", config: {} } });
  const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_lp", name: "LP hero" });
  // 2026-01-02T00:00:00Z 〜 2026-01-05T00:00:00Z
  await setPeriod(sid, eid, Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5));
  return { owner, sid, eid };
}
const get = async (token: string, sid: string, eid: string): Promise<Recipe> =>
  json<Recipe>(await call("GET", `/sites/${sid}/experiments/${eid}/analytics-recipe`, { token }));

describe("GET …/analytics-recipe (spec §13.10 / 決定 39 (5))", () => {
  it("analytics_recipe_uses_placeholders_when_ids_missing", async () => {
    const { owner, sid, eid } = await recipeSite();
    const r = await get(owner.token, sid, eid);
    expect(r.ga4.propertyId).toBe("{{GA4_PROPERTY_ID}}");
    expect(r.bigquery.dataset).toBe("{{BQ_DATASET}}");
    expect(r.ga4.exposureByVariant).toMatchObject({
      method: "POST",
      url: "https://analyticsdata.googleapis.com/v1beta/properties/{{GA4_PROPERTY_ID}}:runReport",
    });
    expect(r.bigquery.visitorCvrSql).toContain("`{{BQ_DATASET}}.events_*`");
    expect(r.period).toEqual({ start: "2026-01-02", end: "2026-01-05" });
    expect(r.goals).toEqual([{ id: "g_lead", name: "資料請求", type: "CUSTOM" }]);
    expect(r.experiment).toMatchObject({ id: "exp_lp", name: "LP hero", startedAt: Date.UTC(2026, 0, 2), stoppedAt: Date.UTC(2026, 0, 5) });
  });

  it("analytics_recipe_uses_site_naming_and_period", async () => {
    const { owner, sid, eid } = await recipeSite({
      ga4PropertyId: "123456789",
      bigqueryDataset: "my-project.analytics_1",
      analytics: {
        exposure: { event: "wtt_exposure", keys: { experimentId: "wtt_exp_id", variantId: "wtt_var_id" } },
        conversion: { event: "wtt_conversion", keys: { goalId: "wtt_goal_id" } },
      },
    });
    const r = await get(owner.token, sid, eid);
    // GA4 Data API v1beta runReport(決定 39 (5)): Variant 別の exposure は totalUsers / sessions
    expect(r.ga4.exposureByVariant).toEqual({
      method: "POST",
      url: "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport",
      body: {
        dateRanges: [{ startDate: "2026-01-02", endDate: "2026-01-05" }],
        dimensions: [{ name: "customEvent:wtt_var_id" }],
        metrics: [{ name: "totalUsers" }, { name: "sessions" }],
        dimensionFilter: {
          andGroup: {
            expressions: [
              { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "wtt_exposure" } } },
              { filter: { fieldName: "customEvent:wtt_exp_id", stringFilter: { matchType: "EXACT", value: "exp_lp" } } },
            ],
          },
        },
        keepEmptyRows: false,
      },
    });
    expect(r.ga4.conversionsByGoal).toEqual({
      method: "POST",
      url: "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport",
      body: {
        dateRanges: [{ startDate: "2026-01-02", endDate: "2026-01-05" }],
        dimensions: [{ name: "customEvent:wtt_goal_id" }],
        metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
        dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "wtt_conversion" } } },
        keepEmptyRows: false,
      },
    });
    // BigQuery: 命名設定・期間・Goal 一覧が埋まっている
    const sqlText = r.bigquery.visitorCvrSql;
    for (const needle of [
      "-- 訪問者単位のパターン別 CVR",
      "FROM `my-project.analytics_1.events_*`",
      // テーブル日付はプロパティのタイムゾーン。UTC と最大 1 日ずれるので前後 1 日ずつ広げる(CX-High-7)
      "WHERE _TABLE_SUFFIX BETWEEN '20260101' AND '20260106'",
      "WHERE ep.key = 'wtt_exp_id'",
      "WHERE ep.key = 'wtt_var_id'",
      "WHERE ep.key = 'wtt_goal_id'",
      "AND event_name = 'wtt_exposure'",
      "AND event_name = 'wtt_conversion'",
      "experiment_id = 'exp_lp'",
      "CROSS JOIN UNNEST(ARRAY<STRING>['g_lead']) AS g",
      "g AS goal_id",
      "c.goal_id = g",
      "COUNT(DISTINCT a.user_pseudo_id) AS visitors",
      "c.converted_at >= a.exposed_at",
      // 決定 39 (8): 複数 Variant に露出した訪問者は除外せず、期間内の初回露出に帰属させる(intention-to-treat)。
      // 同一 timestamp の露出でも「初回」を再現できるよう、GA4 export の batch 内順序列で並びを固定する(CX-Medium-8)
      "ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn",
      "    batch_page_id,",
      "    batch_ordering_id,",
      "    batch_event_index",
      "WHERE rn = 1",
      `AND event_timestamp BETWEEN ${Date.UTC(2026, 0, 2) * 1000} AND ${Date.UTC(2026, 0, 5) * 1000}`,
    ]) {
      expect(sqlText, `visitorCvrSql に「${needle}」が無い`).toContain(needle);
    }
    expect(r.bigquery.sessionCvrSql).toContain("ga_session_id");
    expect(r.bigquery.sessionCvrSql).toContain("COUNT(DISTINCT a.session_id) AS sessions");
    expect(r.bigquery.sessionCvrSql).toContain(
      "ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn",
    );
    // 除外はしない(決定 39 (8)): CVR の 2 本に HAVING COUNT(DISTINCT …) は現れない
    expect(r.bigquery.visitorCvrSql).not.toContain("HAVING COUNT(DISTINCT");
    expect(r.bigquery.sessionCvrSql).not.toContain("HAVING COUNT(DISTINCT");
    // 混在の規模は補助 SQL で数える
    for (const needle of [
      "FROM `my-project.analytics_1.events_*`",
      "HAVING COUNT(DISTINCT variant_id) > 1",
      "AS mixed_visitors",
      "AS mixed_sessions",
    ]) {
      expect(r.bigquery.mixedExposureCountSql, `mixedExposureCountSql に「${needle}」が無い`).toContain(needle);
    }
    expect(r.notes.some((n) => n.includes("初回露出"))).toBe(true);
    expect(r.notes.some((n) => n.includes("mixedExposureCountSql"))).toBe(true);
  });

  it("同日内の境界(開始前 / 露出後 / 停止後)が SQL の述語として入る", async () => {
    // CX-High-4: 「境界文字列が 2 回出る」ではなく、**どの述語がどの CTE にあるか**を固定する
    // (`c.converted_at >= a.exposed_at` を消しても落ちる形にする)
    const { owner, sid, eid } = await recipeSite({ bigqueryDataset: "my-project.analytics_1" });
    const startedAt = Date.UTC(2026, 0, 2, 9, 0, 0); // 同日 09:00 に開始
    const stoppedAt = Date.UTC(2026, 0, 5, 12, 0, 0); // 同日 12:00 に停止
    await setPeriod(sid, eid, startedAt, stoppedAt);
    const r = await get(owner.token, sid, eid);
    const bound = `AND event_timestamp BETWEEN ${startedAt * 1000} AND ${stoppedAt * 1000}`;
    /** SQL の `from` から `to` の直前までを切り出す(CTE 単位で述語を数えるため) */
    const section = (sqlText: string, from: string, to: string): string => {
      const i = sqlText.indexOf(from);
      const j = sqlText.indexOf(to, i + from.length);
      expect(i, `「${from}」が SQL に無い`).toBeGreaterThanOrEqual(0);
      expect(j, `「${to}」が SQL に無い`).toBeGreaterThan(i);
      return sqlText.slice(i, j);
    };
    const count = (text: string, needle: string): number => (text.match(new RegExp(rx(needle), "g")) ?? []).length;
    for (const sqlText of [r.bigquery.visitorCvrSql, r.bigquery.sessionCvrSql]) {
      // 走査するテーブルは日付。プロパティのタイムゾーンずれを見込んで前後 1 日ずつ広げる(CX-High-7)
      expect(sqlText).toContain("WHERE _TABLE_SUFFIX BETWEEN '20260101' AND '20260106'");
      // 開始前(09:00 より前)・停止後(12:00 より後)の同日イベントは exposure と conversion の**両方**で落とす
      expect(count(section(sqlText, "WITH exposure AS (", "assigned AS ("), bound), "exposure の CTE に開始 / 終了境界が 1 回").toBe(1);
      expect(count(section(sqlText, "conversion AS (", "\nSELECT\n  a."), bound), "conversion の CTE に開始 / 終了境界が 1 回").toBe(1);
      // 露出より前の Conversion は数えない(この述語を消すと期間内の露出前 conversion が母数に混ざる)
      expect(sqlText, "conversion の JOIN に露出時刻の下限が無い").toContain("c.converted_at >= a.exposed_at");
      // 帰属は初回露出の 1 行(決定 39 (8))
      expect(count(sqlText, "WHERE rn = 1"), "初回露出の絞り込みが 1 回").toBe(1);
    }
    // 混在の補助 SQL も同じ期間・同じテーブル範囲で数える
    expect(r.bigquery.mixedExposureCountSql).toContain(bound);
    expect(r.bigquery.mixedExposureCountSql).toContain("WHERE _TABLE_SUFFIX BETWEEN '20260101' AND '20260106'");

    // 停止していなければ上限は生成時刻(未来のイベントを含めない)
    await setPeriod(sid, eid, startedAt, null);
    const open = await get(owner.token, sid, eid);
    const upper = Number(/AND event_timestamp BETWEEN \d+ AND (\d+)/.exec(open.bigquery.visitorCvrSql)![1]);
    expect(upper).toBeGreaterThan(startedAt * 1000);
    expect(upper).toBeLessThanOrEqual(Date.now() * 1000);
  });

  it("analytics_recipe_keeps_events_across_property_timezone_boundaries", async () => {
    // CX-High-7: GA4 export のテーブル日付は**プロパティのタイムゾーン**で、UTC の event_timestamp と最大 1 日ずれる。
    // 例: 日本時間 2026-01-02 00:00〜02:00 = UTC 2026-01-01 15:00〜17:00。イベントは events_20260102(JST 日付)に入るので、
    // UTC 日付だけで BETWEEN を作ると期間内のイベントを丸ごと落とす。走査範囲は前後 1 日ずつ広げ、採否は UTC の時刻条件で決める
    const { owner, sid, eid } = await recipeSite({ bigqueryDataset: "my-project.analytics_1" });
    const startedAt = Date.UTC(2026, 0, 1, 15, 0, 0); // JST 2026-01-02 00:00
    const stoppedAt = Date.UTC(2026, 0, 1, 17, 0, 0); // JST 2026-01-02 02:00
    await setPeriod(sid, eid, startedAt, stoppedAt);
    const r = await get(owner.token, sid, eid);
    for (const sqlText of [r.bigquery.visitorCvrSql, r.bigquery.sessionCvrSql, r.bigquery.mixedExposureCountSql]) {
      expect(sqlText).toContain("WHERE _TABLE_SUFFIX BETWEEN '20251231' AND '20260102'");
      const m = /_TABLE_SUFFIX BETWEEN '(\d{8})' AND '(\d{8})'/.exec(sqlText)!;
      // UTC 日付(20260101)も、プロパティのタイムゾーンの日付(20260102)も走査範囲に入っている
      expect(Number(m[1]), "走査範囲が UTC 日付を含まない").toBeLessThanOrEqual(20260101);
      expect(Number(m[2]), "走査範囲が JST 日付(20260102)を含まない").toBeGreaterThanOrEqual(20260102);
      // 範囲を広げても、期間外のイベントは時刻条件で落ちる
      expect(sqlText).toContain(`AND event_timestamp BETWEEN ${startedAt * 1000} AND ${stoppedAt * 1000}`);
    }
  });

  it("停止していない実験の期間は今日まで / 開始前は作成日から", async () => {
    const { owner, sid, eid } = await recipeSite();
    await setPeriod(sid, eid, Date.UTC(2026, 0, 2), null);
    const today = new Date().toISOString().slice(0, 10);
    expect((await get(owner.token, sid, eid)).period).toEqual({ start: "2026-01-02", end: today });

    // コントローラ判定: started_at が null(未 Start)の実験は created_at から期間が始まる
    const owner2 = owner; // /setup は 1 回きりなので同じ owner を使い、2 つめの Workspace は作らない
    const { id: sid2 } = await createSite(owner2.token, owner2.workspaceId);
    const { id: eid2 } = await createExperiment(owner2.token, sid2, { id: "exp_never_started", name: "Never started" });
    const notStarted = await get(owner2.token, sid2, eid2);
    expect(notStarted.experiment.startedAt).toBeNull();
    expect(notStarted.period).toEqual({ start: today, end: today });
  });

  it("Goal が 0 件の Site では CVR クエリが 0 行になる旨を notes に書く", async () => {
    // recipeSite() は常に g_lead を作るので、ここでは Goal を作らず createSite / createExperiment だけを使う
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_no_goal", name: "Goal 無し" });
    const r = await get(owner.token, sid, eid);
    expect(r.goals).toEqual([]);
    expect(r.notes.some((n) => n.includes("目標") && n.includes("0 行"))).toBe(true);
    expect(r.notes.some((n) => n.includes("mixedExposureCountSql") && n.includes("exposureByVariant"))).toBe(true);
  });

  it("events_intraday テーブルは走査対象に含まれない旨を notes に書く", async () => {
    const { owner, sid, eid } = await recipeSite();
    const r = await get(owner.token, sid, eid);
    expect(r.notes.some((n) => n.includes("events_intraday"))).toBe(true);
  });

  it("adds a note that comparison does not apply to a personalization (決定 51、設計書 §3.4)", async () => {
    const NOTE = "パーソナライズなので、比較と SRM の確認は意味を持ちません";
    const { owner, sid, eid } = await recipeSite();
    expect((await get(owner.token, sid, eid)).notes).not.toContain(NOTE); // テスト(exp_lp)には付かない
    const { id: single } = await createExperiment(owner.token, sid, { id: "exp_single", name: "LP personalize", kind: "single" });
    await setPeriod(sid, single, Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5));
    expect((await get(owner.token, sid, single)).notes).toContain(NOTE);
  });

  it("VIEWER で読め、未知の Experiment は 404", async () => {
    const { owner, sid, eid } = await recipeSite();
    expect((await call("GET", `/sites/${sid}/experiments/${eid}/analytics-recipe`, { token: owner.token })).status).toBe(200);
    expect((await call("GET", `/sites/${sid}/experiments/exp_nope/analytics-recipe`, { token: owner.token })).status).toBe(404);
  });
});
