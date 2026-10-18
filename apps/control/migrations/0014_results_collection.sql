-- D9 plan ②(設計書 §6.6・§9.1): 結果の収集。番号はマージの時点で migrations/ の最大の番号 + 1 に付け直す(plan ② の K3)
-- Site ごとの「結果を記録する」と個票の保持期間(日、7〜365)。既存の Site は 0 のまま(新しい Site は作成時に、計測用 D1 があれば 1)
ALTER TABLE sites ADD COLUMN results_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN results_retention_days INTEGER NOT NULL DEFAULT 90;
-- テストの最初の開始のときに 1 回振る結果の記録の ID(下書き・パーソナライズ・結果を記録しない Site で開始したテストは NULL)
ALTER TABLE experiments ADD COLUMN run_id TEXT;
-- 計測用 D1 の個票を消した時刻(epoch ミリ秒)
ALTER TABLE experiments ADD COLUMN results_purged_at INTEGER;
-- 一度開始したエクスペリエンスを削除した後の ID。同じ ID の作成・複製を拒む(設計書 §6.3)
CREATE TABLE retired_experiment_ids (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, experiment_id)
);
-- Publish で公開された収集の状態(compiled config に results.runs を載せるか)が変わった時刻。収集の停止の期間をここから出す
CREATE TABLE results_collection_log (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  publish_version INTEGER NOT NULL
);
CREATE INDEX results_collection_log_by_site ON results_collection_log (site_id, at);
-- Cron のジョブの実行の記録(1 日 1 回のジョブの「今日はもう済んだか」。last_run_day = UTC の日付 YYYY-MM-DD)
CREATE TABLE cron_job_runs (
  job TEXT PRIMARY KEY,
  last_run_day TEXT,
  last_success_at INTEGER
);
