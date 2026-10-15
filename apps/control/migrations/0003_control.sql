-- spec §13.1 の自前テーブル。Workspace / Member / 招待は Better Auth(0001)の organization / member / invitation
-- 時刻は epoch ミリ秒(INTEGER)。JSON 列は _json 接尾辞
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'A',
  id_source TEXT NOT NULL DEFAULT 'ab',
  site_salt TEXT NOT NULL,
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  hosts_json TEXT NOT NULL DEFAULT '[]',
  retention_days INTEGER NOT NULL DEFAULT 90,
  consent_mode TEXT NOT NULL DEFAULT 'implicit',
  decision_timeout_ms INTEGER NOT NULL DEFAULT 1000,
  visitor_cookie_name TEXT NOT NULL DEFAULT '_ab_vid',
  uuid_cookie_enabled INTEGER NOT NULL DEFAULT 0,
  uuid_cookie_name TEXT NOT NULL DEFAULT '_ab_uuid',
  previous_cookie_names_json TEXT NOT NULL DEFAULT '[]',
  analytics_json TEXT,
  ga4_property_id TEXT,          -- 決定 34: analytics-recipe(Plan 4b)の穴埋め用。資格情報ではない
  bigquery_dataset TEXT,         -- 同上(`project.dataset`)
  bridge_secret TEXT,
  bridge_secret_prev TEXT,
  bridge_secret_rotated_at INTEGER,
  active_version INTEGER,
  active_kv_stale INTEGER NOT NULL DEFAULT 0,  -- KV active が D1 と食い違っている可能性(自己修復失敗 / put の成否不明)。publish.ts の reconcileActive(次回 Publish の冒頭、および GET /sites/:sid の都度)が D1 最新版を再 put して 0 に戻す
  last_activated_at INTEGER,
  content_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sites_workspace ON sites(workspace_id);

-- host → site の所有権を D1 で先に確定する(KV の host キーを別 Site が上書きしないため)
CREATE TABLE site_hosts (host TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE);

CREATE TABLE url_patterns (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
);

CREATE TABLE experiments (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_status TEXT,
  url_match_json TEXT NOT NULL,
  targeting_json TEXT,
  traffic_percentage INTEGER NOT NULL DEFAULT 100,
  persist_assignment INTEGER NOT NULL DEFAULT 0,
  analytics_json TEXT,
  started_at INTEGER,            -- 決定 34: 最初に running になった時刻(ms)。analytics-recipe の期間の起点
  stopped_at INTEGER,            -- archived になった時刻(ms)
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
);

CREATE TABLE variants (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL,
  position INTEGER NOT NULL,
  analytics_json TEXT,
  PRIMARY KEY (site_id, experiment_id, id),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);

CREATE TABLE changes (
  site_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  selector TEXT,
  payload_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, experiment_id, variant_id, id),
  FOREIGN KEY (site_id, experiment_id, variant_id) REFERENCES variants(site_id, experiment_id, id) ON DELETE CASCADE
);

CREATE TABLE goals (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX assets_site ON assets(site_id, experiment_id);

-- spec §13.6: version の予約台帳 + 公開履歴(config_json は本体)。status: reserved | failed | active | superseded
CREATE TABLE publishes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  config_hash TEXT,
  config_json TEXT,
  needs_profile INTEGER,
  error TEXT,
  kv_deleted INTEGER NOT NULL DEFAULT 0,
  published_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  UNIQUE (site_id, version)
);
