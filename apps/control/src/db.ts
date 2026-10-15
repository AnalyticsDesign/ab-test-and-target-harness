import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { Env } from "./env";

// Better Auth 生成テーブル(migrations/0001_better_auth.sql)。列名は camelCase
export type UserRow = { id: string; email: string; name: string; emailVerified: number; createdAt: string; updatedAt: string };
export type OrganizationRow = { id: string; name: string; slug: string; createdAt: string };
export type MemberRow = { id: string; organizationId: string; userId: string; role: string; createdAt: string };
export type InvitationRow = { id: string; organizationId: string; email: string; role: string | null; status: string; expiresAt: string; inviterId: string };
/** Better Auth の verification(再設定リンクの token は identifier = `reset-password:<token>`、value = user ID) */
export type VerificationRow = { id: string; identifier: string; value: string; expiresAt: string };
/** migrations/0002_setup_lock.sql。初回セットアップの先勝ちロック(id は常に 1) */
export type SetupLockRow = { id: number; created_at: number; completed: number };

// control の自前テーブル(migrations/0003_control.sql)。列名は snake_case、時刻は epoch ミリ秒、JSON 列は _json 接尾辞
export type SiteRow = {
  id: string; workspace_id: string; name: string; domain: string; mode: "A" | "B"; id_source: string; site_salt: string;
  allowed_origins_json: string; hosts_json: string; retention_days: number; consent_mode: "implicit" | "required"; decision_timeout_ms: number;
  visitor_cookie_name: string; uuid_cookie_enabled: number; uuid_cookie_name: string; previous_cookie_names_json: string; analytics_json: string | null;
  forget_on_revoke: number;
  timezone: string;
  ga4_property_id: string | null; bigquery_dataset: string | null;
  bridge_secret: string | null; bridge_secret_prev: string | null; bridge_secret_rotated_at: number | null;
  active_version: number | null; active_kv_stale: number; last_activated_at: number | null; content_updated_at: number; created_at: number; updated_at: number;
  /** migrations/0012_static_delivery.sql(決定 52)。配信ファイルの出し直しの世代・印・配っている版・削除の印 */
  static_seq: number; static_stale: number; static_epoch: number; static_served_version: number | null; static_prev_served_version: number | null; static_served_at: number | null; static_removing: string | null;
};
export type SiteHostRow = { host: string; site_id: string };
/** migrations/0007_audiences.sql。definition_json = 保存する形の配信条件(core の Targeting) */
export type AudienceRow = { site_id: string; id: string; name: string; description: string; definition_json: string; created_at: number; updated_at: number };
/** migrations/0008_instance_admins.sql(決定 53)。システム管理者。granted_by = 昇格させた人の user ID(/setup とマイグレーションは null) */
export type InstanceAdminRow = { user_id: string; granted_by: string | null; created_at: number };
/** instance_admin_prior_roles のマイグレーション(B46)。昇格前のワークスペースとロール。外すときに戻す */
export type InstanceAdminPriorRoleRow = { user_id: string; organization_id: string; role: string; granted_at: number };
export type ExperimentRow = {
  site_id: string; id: string; name: string; status: "draft" | "running" | "paused" | "archived"; published_status: string | null;
  url_match_json: string; targeting_json: string | null; traffic_percentage: number; persist_assignment: number; analytics_json: string | null;
  started_at: number | null; stopped_at: number | null;
  created_by: string; updated_by: string; created_at: number; updated_at: number;
};
export type VariantRow = { site_id: string; experiment_id: string; id: string; name: string; weight: number; position: number; analytics_json: string | null };
export type ChangeRow = { site_id: string; experiment_id: string; variant_id: string; id: string; type: string; selector: string | null; payload_json: string; position: number; created_by: string; updated_by: string; created_at: number; updated_at: number };
export type GoalRow = { site_id: string; id: string; name: string; type: string; config_json: string; created_at: number; updated_at: number };
export type AssetRow = { id: string; site_id: string; experiment_id: string; r2_key: string; public_url: string; mime: string; size: number; created_by: string; created_at: number };
export type PublishRow = { id: string; site_id: string; version: number; status: "reserved" | "failed" | "active" | "superseded"; config_hash: string | null; config_json: string | null; needs_profile: number | null; error: string | null; kv_deleted: number; published_by: string; created_at: number; activated_at: number | null };

/** Better Auth apiKey プラグインの表(B33: metadata の roleCap と、管理者向け一覧のための列を読む。書くのはプラグインと失効の 2 列だけ)。date 列は ISO 文字列 */
/** migrations/0009_apikey_revocations.sql(backlog B42 / brief K15)。失効の正。revoked_at は epoch ミリ秒、revoked_by = 失効させた人の user ID(マイグレーションは null) */
export type ApiKeyRevocationRow = { key_id: string; revoked_at: number; revoked_by: string | null };
export type ApiKeyRow = {
  id: string;
  userId: string;
  name: string | null;
  prefix: string | null;
  enabled: number | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
};
/** migrations/0011_instance_settings.sql(backlog D10 / brief K3)。導入全体の設定。value は JSON、updated_at は epoch ミリ秒、updated_by は書いた人の user ID(初回セットアップは null) */
export type InstanceSettingRow = { key: string; value: string; updated_at: number; updated_by: string | null };

export interface Tables {
  user: UserRow;
  verification: VerificationRow;
  apikey: ApiKeyRow;
  apikey_revocations: ApiKeyRevocationRow;
  instance_settings: InstanceSettingRow;
  organization: OrganizationRow;
  member: MemberRow;
  invitation: InvitationRow;
  setup_lock: SetupLockRow;
  sites: SiteRow;
  site_hosts: SiteHostRow;
  audiences: AudienceRow;
  instance_admins: InstanceAdminRow;
  instance_admin_prior_roles: InstanceAdminPriorRoleRow;
  experiments: ExperimentRow;
  variants: VariantRow;
  changes: ChangeRow;
  goals: GoalRow;
  assets: AssetRow;
  publishes: PublishRow;
}
export type Db = Kysely<Tables>;

export function getDb(env: Env): Db {
  return new Kysely<Tables>({ dialect: new D1Dialect({ database: env.DB }) });
}

/** Kysely でビルドした文を D1 の prepared statement にする(batch = 1 トランザクション用) */
export function toStatement(env: Env, q: { compile(): { sql: string; parameters: readonly unknown[] } }): D1PreparedStatement {
  const c = q.compile();
  return env.DB.prepare(c.sql).bind(...c.parameters);
}
