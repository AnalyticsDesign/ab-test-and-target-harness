import { z } from "zod";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import type { ExperimentRow, GoalRow, SiteRow } from "./db";

/** siteSalt は返さない(公開値ではあるが管理画面に不要。spec §4.3) */
export function siteJson(row: SiteRow) {
  return {
    id: row.id, workspaceId: row.workspace_id, name: row.name, domain: row.domain, mode: row.mode, idSource: row.id_source,
    allowedOrigins: JSON.parse(row.allowed_origins_json) as string[], hosts: JSON.parse(row.hosts_json) as string[],
    retentionDays: row.retention_days, consentMode: row.consent_mode, forgetOnRevoke: row.forget_on_revoke === 1, timezone: row.timezone, decisionTimeoutMs: row.decision_timeout_ms,
    visitorCookieName: row.visitor_cookie_name, uuidCookieEnabled: row.uuid_cookie_enabled === 1, uuidCookieName: row.uuid_cookie_name,
    previousCookieNames: JSON.parse(row.previous_cookie_names_json) as Array<{ name: string; until: number }>,
    // 決定 62 より前に保存した行は dataLayerName を持たないので既定名で補う(edge へ配る record は SiteSettingsSchema が埋める)
    analytics: row.analytics_json ? { dataLayerName: DEFAULT_ANALYTICS.dataLayerName, ...JSON.parse(row.analytics_json) } : DEFAULT_ANALYTICS,
    ga4PropertyId: row.ga4_property_id, bigqueryDataset: row.bigquery_dataset,
    activeVersion: row.active_version, activeKvStale: row.active_kv_stale === 1,
    staticStale: row.static_stale === 1, staticRemoving: row.static_removing !== null,
    lastActivatedAt: row.last_activated_at, contentUpdatedAt: row.content_updated_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** `siteJson` の出力の契約(決定 34: OpenAPI はルート定義の zod から生成する)。時刻は epoch ミリ秒、`until` だけ epoch 秒 */
export const SiteJsonSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  domain: z.string(),
  mode: z.enum(["A", "B"]),
  idSource: z.string(),
  allowedOrigins: z.array(z.string()),
  hosts: z.array(z.string()),
  retentionDays: z.number().int(),
  consentMode: z.enum(["implicit", "required"]),
  forgetOnRevoke: z.boolean(),
  timezone: z.string().describe("曜日・時間帯の条件の判定に使うタイムゾーン(IANA 名)。変更は次の公開で効く"),
  decisionTimeoutMs: z.number().int(),
  visitorCookieName: z.string(),
  uuidCookieEnabled: z.boolean(),
  uuidCookieName: z.string(),
  previousCookieNames: z.array(z.object({ name: z.string(), until: z.number().int().describe("保持期限(epoch 秒)") })),
  analytics: z.record(z.string(), z.unknown()).describe("外部計測の名前(dataLayer の命名設定。`analytics`。push 先の配列の名前 `dataLayerName` を含む)"),
  ga4PropertyId: z.string().nullable(),
  bigqueryDataset: z.string().nullable(),
  activeVersion: z.number().int().nullable(),
  activeKvStale: z.boolean(),
  staticStale: z.boolean().describe("設置タグの配信ファイルの更新が済んでいない(自動で再試行する。続くときは作り直しの操作を使う)"),
  staticRemoving: z.boolean().describe("サイトの削除が途中で止まっている(配信ファイルの削除を頼んだ後、サイトが消えていない)。もう一度削除するか、POST /sites/:sid/static/redeploy で配信を戻す"),
  lastActivatedAt: z.number().int().nullable().describe("epoch ミリ秒"),
  contentUpdatedAt: z.number().int().describe("epoch ミリ秒"),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});

export function goalJson(row: GoalRow) {
  return { id: row.id, name: row.name, type: row.type, config: JSON.parse(row.config_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function experimentJson(row: ExperimentRow, extra: { unpublished: boolean }) {
  return {
    id: row.id, siteId: row.site_id, name: row.name, kind: row.kind, status: row.status, publishedStatus: row.published_status,
    urlMatch: JSON.parse(row.url_match_json), targeting: row.targeting_json ? JSON.parse(row.targeting_json) : null,
    trafficPercentage: row.traffic_percentage, persistAssignment: row.persist_assignment === 1,
    analytics: row.analytics_json ? JSON.parse(row.analytics_json) : null,
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
    unpublished: extra.unpublished,
  };
}
