-- D9 plan ③(設計書 §9.1、plan ③ の K4・Task 4): テストの結果のレポート。番号はマージの時点で migrations/ の最大の番号 + 1 に付け直す
-- エクスペリエンスに属する表は (site_id, experiment_id) から experiments(site_id, id) への ON DELETE CASCADE
-- (エクスペリエンスの削除で結果の記録・採用・計画の変更履歴も消える。設計書 §6.8)

-- 評価計画(設計書 §5.1 の形を plan_json に持つ)。行は遅れて作る(GET は既定値で埋め、PUT と開始のときに作る)
CREATE TABLE evaluation_plans (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  update_token TEXT,
  fixed_at INTEGER,               -- 開始のときに固定した時刻
  reached_at INTEGER,             -- 目標参加者数に届いた参加の時刻
  reached_recorded_at INTEGER,    -- 到達を確かめた時刻
  reach_checked_day TEXT,         -- Cron が到達を確かめた UTC の日付(YYYY-MM-DD)
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, experiment_id),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- 評価計画の変更の履歴
CREATE TABLE evaluation_plan_changes (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- 結果の記録(kind = evaluation: 評価時点 / stop: 終了)。個票を消した後も画面を再現できるように固定する
CREATE TABLE result_snapshots (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('evaluation','stop')),
  run_id TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  stats_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (site_id, experiment_id, kind),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- 採用の記録(variant_id = NULL は採用なし)。記録し直しは上書き
CREATE TABLE adoptions (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  variant_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, experiment_id),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- Publish ごとの「訪問者に届く定義」(前回と同じなら行を作らない)。delivered_from は配信を確かめた時に入れる
CREATE TABLE experiment_delivered_definitions (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  publish_version INTEGER NOT NULL,
  static_generation TEXT,         -- Publish の世代 {epoch, seq} の JSON(出し直しに失敗した Publish は NULL)
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  delivered_from INTEGER,
  delivered_until INTEGER,
  settled TEXT CHECK (settled IN ('delivered','overtaken','unknown')),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);
CREATE INDEX experiment_delivered_definitions_by_run ON experiment_delivered_definitions (run_id, publish_version);
-- deliveredAt(結果の記録の写し・パターンの複製)がエクスペリエンスごとに版の新しい順で引く
CREATE INDEX experiment_delivered_definitions_by_experiment ON experiment_delivered_definitions (site_id, experiment_id, publish_version);

-- 配信ファイルの出し直しの依頼ごとの「世代 → その出し直しで焼いた版」(配信の確認が世代から版を引く)
CREATE TABLE static_deploy_requests (
  site_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, epoch, seq),
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- テスト中の変更の記録(変わった部分の一覧)
CREATE TABLE experiment_delivery_changes (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  publish_version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  parts_json TEXT NOT NULL,
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- 計測用 D1(wtt-results)の行の削除待ち(エクスペリエンス・Site・Workspace の削除で積む)。
-- 外部キーを持たない: Site・エクスペリエンスの行が消えた後も残し、計測用 D1 の行を消し終えたら消す
CREATE TABLE results_purge_queue (
  site_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL,           -- experiment_deleted | site_deleted | workspace_deleted
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, run_id)
);

-- 保存した速報(5 分以内なら再計算しない)
CREATE TABLE results_interim_cache (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  rows_read INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (site_id, experiment_id),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

-- 計測用 D1 の最後に測った大きさ(導入全体で 1 行)
CREATE TABLE results_store_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  size_bytes INTEGER NOT NULL,
  measured_at INTEGER NOT NULL
);

-- Cron のジョブの続きの位置(job = 「ジョブ名:段」、day = UTC の YYYY-MM-DD)
CREATE TABLE cron_cursors (
  job TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  cursor TEXT
);

-- 収集の締め切りを KV に書き直す必要がある Site の印(0 / 1)
ALTER TABLE sites ADD COLUMN collect_until_dirty INTEGER NOT NULL DEFAULT 0;
