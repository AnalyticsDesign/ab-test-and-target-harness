import { Kysely, type Generated } from "kysely";
import { D1Dialect } from "kysely-d1";
import type { ExperimentKind } from "@wtt/core";
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
  /** migrations/0014_results_collection.sql(D9 ②、設計書 §6.6)。結果を記録するか(0 / 1)と個票の保持期間(日、7〜365) */
  results_enabled: number; results_retention_days: number;
  /** migrations/0016_results_reports.sql(D9 ③ K11): 収集の締め切りを KV に書き直す必要がある(0 / 1。書き込みに失敗したとき Cron が拾う) */
  collect_until_dirty: number;
  /** migrations/0017_plan12_defense.sql(plan12 K10・K15): 新しい訪問者の記録の上限(1 日あたり)。null = Cloudflare のプランの既定 */
  new_profile_budget_per_day: number | null;
  /**
   * migrations/0020_share_subdomains.sql(B139): 訪問者 ID の Cookie を共有するか(0 / 1)・前の共有の範囲(`[{ domain, until(epoch 秒) }]`)・
   * 共有の自動の移行の対象か(0 / 1。既存の行は 1)
   */
  share_subdomains: number; previous_cookie_domains_json: string; share_migration_pending: number;
  /**
   * migrations/0022_site_domains.sql(B148): タグを置くドメインの一覧(`DomainRow[]` の JSON。domains.ts)。一覧が正で、
   * domain・allowed_origins_json・hosts_json は保存のたびに deriveDomainColumns で一覧から導いて書く
   */
  domains_json: string;
};
export type SiteHostRow = { host: string; site_id: string };
/** migrations/0007_audiences.sql。definition_json = 保存する形の配信条件(core の Targeting) */
export type AudienceRow = { site_id: string; id: string; name: string; description: string; definition_json: string; created_at: number; updated_at: number };
/** migrations/0008_instance_admins.sql(決定 53)。システム管理者。granted_by = 昇格させた人の user ID(/setup とマイグレーションは null) */
export type InstanceAdminRow = { user_id: string; granted_by: string | null; created_at: number };
/** instance_admin_prior_roles のマイグレーション(B46)。昇格前のワークスペースとロール。外すときに戻す */
export type InstanceAdminPriorRoleRow = { user_id: string; organization_id: string; role: string; granted_at: number };
export type ExperimentRow = {
  site_id: string; id: string; name: string; kind: ExperimentKind; status: "draft" | "running" | "paused" | "archived"; published_status: string | null;
  url_match_json: string; targeting_json: string | null; traffic_percentage: number; persist_assignment: number; analytics_json: string | null;
  started_at: number | null; stopped_at: number | null;
  /** 配信に入った時刻。開始・再開のたびに更新する。テストどうしの優先の順(決定 51) */
  last_started_at: number | null;
  /** D9 ②(設計書 §6.3): 最初の開始のときに 1 回振る結果の記録の ID(core の newRunId)。振らなかったテスト・下書き・パーソナライズは null */
  run_id: string | null;
  /** 計測用 D1 の個票を消した時刻(epoch ミリ秒。③ の保持期限の削除が書く) */
  results_purged_at: number | null;
  /** migrations/0015_variant_original_and_memo.sql(B77): メモ(社内用。外部には出力しない。1,000 字まで) */
  description: string;
  created_by: string; updated_by: string; created_at: number; updated_at: number;
};
/** original = オリジナル(0 / 1。変更を持たず元のページを見せる)・description = メモ(同 0015、B77) */
export type VariantRow = {
  site_id: string; experiment_id: string; id: string; name: string; weight: number; position: number; analytics_json: string | null;
  original: number; description: string;
};
export type ChangeRow = { site_id: string; experiment_id: string; variant_id: string; id: string; type: string; selector: string | null; payload_json: string; position: number; created_by: string; updated_by: string; created_at: number; updated_at: number };
/** analytics_json = 目標の外部計測 `{ overrides: { goalName } }`(0015、B77)。無ければ null */
export type GoalRow = { site_id: string; id: string; name: string; type: string; config_json: string; analytics_json: string | null; created_at: number; updated_at: number };
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

/** migrations/0014_results_collection.sql(D9 ②)。一度開始したエクスペリエンスを削除した後の ID(設計書 §6.3) */
export type RetiredExperimentIdRow = { site_id: string; experiment_id: string; retired_at: number };
/** migrations/0021_retired_site_ids.sql(B155)。削除したサイトの ID。別のワークスペースの取り直しを断る。retired_at は epoch ミリ秒。FK なし(サイト・ワークスペースの削除で消さない) */
export type RetiredSiteIdRow = { id: string; workspace_id: string; retired_at: number };
/**
 * 同上。Publish で公開された収集の状態が変わった時刻(設計書 §6.6)。id は SQLite の rowid(足すときは省く)。
 * enabled = その公開の Site の results_enabled(results.runs にテストを載せる設定か)。runs が空かどうかではない(B110:
 * run を持つテストが無い公開でも、Site が記録する設定なら 1)。テストを開始した公開から cutoff までの公開では、そのテストは
 * running か paused なので「設定が有効」と「runs にそのテストが載る」が一致し、収集の停止の期間(report.ts の collectionStops)の計算は変わらない。
 * もともとの限界: 記録は公開ごと・Site ごとなので、開始(started_at)から開始の公開が成功するまでの間(通常は数秒。公開が失敗すれば次の公開まで)を表せない
 * 0014 のコメントの「compiled config に results.runs を載せるか」もこの意味(適用済みのマイグレーションなので直していない)
 */
export type ResultsCollectionLogRow = { id: Generated<number>; site_id: string; at: number; enabled: number; publish_version: number };
/** 同上。Cron のジョブの実行の記録(last_run_day = UTC の YYYY-MM-DD) */
export type CronJobRunRow = { job: string; last_run_day: string | null; last_success_at: number | null };

/**
 * migrations/0016_results_reports.sql(D9 ③、設計書 §9.1)。時刻は epoch ミリ秒、JSON 列は _json 接尾辞。
 * id が Generated<number> の表は SQLite の rowid(足すときは省く)
 */
export type EvaluationPlanRow = {
  site_id: string; experiment_id: string; plan_json: string; version: number; update_token: string | null;
  fixed_at: number | null; reached_at: number | null; reached_recorded_at: number | null; reach_checked_day: string | null;
  updated_by: string | null; updated_at: number;
};
export type EvaluationPlanChangeRow = { id: Generated<number>; site_id: string; experiment_id: string; at: number; by: string | null; before_json: string; after_json: string; reason: string | null };
export type ResultSnapshotRow = { site_id: string; experiment_id: string; kind: "evaluation" | "stop"; run_id: string; cutoff_at: number; computed_at: number; stats_version: string; result_json: string };
export type AdoptionRow = { site_id: string; experiment_id: string; variant_id: string | null; note: string; decided_by: string | null; decided_at: number };
export type ExperimentDeliveredDefinitionRow = {
  id: Generated<number>; site_id: string; experiment_id: string; run_id: string; publish_version: number; static_generation: string | null;
  definition_json: string; definition_hash: string; delivered_from: number | null; delivered_until: number | null; settled: "delivered" | "overtaken" | "unknown" | null;
};
/**
 * 配信ファイルの出し直しの依頼ごとの「世代 → その出し直しで焼いた版」(requestStaticDeploy が書く)。
 * input_digest = 送った入力の digest(core の staticInputDigest。7o K24)。マイグレーション 0019 の前の記録は NULL
 */
export type StaticDeployRequestRow = { site_id: string; epoch: number; seq: number; version: number; requested_at: number; input_digest: string | null };
export type ExperimentDeliveryChangeRow = { id: Generated<number>; site_id: string; experiment_id: string; run_id: string; publish_version: number; at: number; by: string | null; parts_json: string };
/** 計測用 D1 の行の削除待ち。外部キーなし(Site・エクスペリエンスが消えた後も残す) */
export type PurgeReason = "experiment_deleted" | "site_deleted" | "workspace_deleted";
export type ResultsPurgeQueueRow = { site_id: string; run_id: string; reason: PurgeReason; enqueued_at: number };
export type ResultsInterimCacheRow = { site_id: string; experiment_id: string; computed_at: number; rows_read: number; result_json: string };
export type ResultsStoreStatusRow = { id: number; size_bytes: number; measured_at: number };
export type CronCursorRow = { job: string; day: string; cursor: string | null };

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
  retired_experiment_ids: RetiredExperimentIdRow;
  retired_site_ids: RetiredSiteIdRow;
  results_collection_log: ResultsCollectionLogRow;
  cron_job_runs: CronJobRunRow;
  evaluation_plans: EvaluationPlanRow;
  evaluation_plan_changes: EvaluationPlanChangeRow;
  result_snapshots: ResultSnapshotRow;
  adoptions: AdoptionRow;
  experiment_delivered_definitions: ExperimentDeliveredDefinitionRow;
  static_deploy_requests: StaticDeployRequestRow;
  experiment_delivery_changes: ExperimentDeliveryChangeRow;
  results_purge_queue: ResultsPurgeQueueRow;
  results_interim_cache: ResultsInterimCacheRow;
  results_store_status: ResultsStoreStatusRow;
  cron_cursors: CronCursorRow;
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
