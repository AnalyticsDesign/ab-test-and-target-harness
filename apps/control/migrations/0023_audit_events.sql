-- B129: 管理の操作の記録(人とアクセス権の操作と、サイト・エクスペリエンス・目標・オーディエンス・公開の変更の要約)。
-- 足すだけの変更(既存の行は sites・experiments の世代を埋める UPDATE のほかは書き換えない)。control より前に流す。
-- 古い control はこの表を使わないので、当てた後に control を前の版へ戻しても壊れない(記録が欠けるだけ)。
-- 外部キーは持たない(人・ワークスペース・サイト・エクスペリエンスが消えても記録を残す。消えた対象は控えの列で読む)。
-- 主キーは整数(rowid。暗黙の索引を持たない)。時刻 at は epoch ミリ秒(Worker の時刻)
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  category TEXT NOT NULL,              -- 'access' | 'content'
  action TEXT NOT NULL,
  workspace_id TEXT,                   -- NULL = 導入全体(システム管理者・使用状況の設定・非常口)
  site_id TEXT,
  experiment_id TEXT,                  -- experiment.* だけ
  site_generation TEXT,                -- サイトの世代(sites.generation)
  experiment_generation TEXT,          -- エクスペリエンスの世代(experiments.generation)
  via TEXT NOT NULL,                   -- 'google' | 'password' | 'unknown' | 'api_key' | 'break_glass' | 'system' | 'setup'
  actor_user_id TEXT,                  -- NULL = 非常用トークン・Cron
  actor_email TEXT,                    -- 控え
  actor_name TEXT,                     -- 控え
  api_key_id TEXT,
  api_key_name TEXT,                   -- 控え
  target_type TEXT,                    -- 'user' | 'invitation' | 'api_key' | 'workspace' | 'site' | 'experiment' | 'variant' | 'goal' | 'audience' | 'asset' | 'instance'
  target_id TEXT,
  target_label TEXT,                   -- 控え(メールアドレス・名前。200 文字まで)
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_at ON audit_events (at, id);
CREATE INDEX audit_events_ws_at ON audit_events (workspace_id, at, id);
CREATE INDEX audit_events_exp_at ON audit_events (site_id, experiment_id, experiment_generation, at, id) WHERE experiment_id IS NOT NULL;
-- まれな行だけを持つ部分索引。使う問い合わせは条件を literal で書く(category = 'access'・via IN ('password', 'break_glass'))
CREATE INDEX audit_events_access_at ON audit_events (at, id) WHERE category = 'access';
CREATE INDEX audit_events_ws_access_at ON audit_events (workspace_id, at, id) WHERE category = 'access';
CREATE INDEX audit_events_pw_at ON audit_events (at, id) WHERE via IN ('password', 'break_glass');
CREATE INDEX audit_events_ws_pw_at ON audit_events (workspace_id, at, id) WHERE via IN ('password', 'break_glass');

-- 追記だけ。書き換えは断り、削除は 365 日より前の行だけを通す(D1 の時計で判定。保持の Cron は 1 日の余裕を取って 366 日より前を消す)。
-- wrangler d1 execute を叩ける人はトリガーごと消せる(ここでは守れない)
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TRIGGER audit_events_keep_365d BEFORE DELETE ON audit_events
WHEN old.at > (CAST(strftime('%s', 'now') AS INTEGER) - 365 * 86400) * 1000
BEGIN SELECT RAISE(ABORT, 'audit_events rows are kept for 365 days'); END;

-- 保持の Cron の 1 日の枠。1 行だけ(day = UTC 日 YYYY-MM-DD を D1 の時計から取る。deleted = その日に消した行の数、
-- run_id = 枠を最後に消費した実行の乱数、last_limit = その batch で使う削除の上限)。最初の 1 行をここで入れ、行が無い場合の処理を作らない
CREATE TABLE audit_retention_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  last_limit INTEGER NOT NULL
);
INSERT INTO audit_retention_state VALUES (1, '1970-01-01', 0, '', 0);

-- 世代: 作るたびに control が crypto.randomUUID() を入れる(同じ ID で作り直すと新しい値)。変更履歴とサイトの記録は今の世代の一致で引く。
-- 既存の行はここで埋める。UPDATE なので sites の退役のトリガー(削除と insert のとき)は動かない
ALTER TABLE sites ADD COLUMN generation TEXT;
ALTER TABLE experiments ADD COLUMN generation TEXT;
UPDATE sites SET generation = lower(hex(randomblob(16))) WHERE generation IS NULL;
UPDATE experiments SET generation = lower(hex(randomblob(16))) WHERE generation IS NULL;

-- 世代が空のまま作られる行を埋める(凍結の前に入った古い control の作成や、古い control へ戻している間の作成)。
-- 新しい control は作成のときに世代を入れるので動かない。INSERT の後なので、sites の退役のトリガー(BEFORE INSERT・AFTER DELETE)と時点がぶつからない
CREATE TRIGGER sites_fill_generation AFTER INSERT ON sites WHEN NEW.generation IS NULL
BEGIN UPDATE sites SET generation = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER experiments_fill_generation AFTER INSERT ON experiments WHEN NEW.generation IS NULL
BEGIN UPDATE experiments SET generation = lower(hex(randomblob(16))) WHERE site_id = NEW.site_id AND id = NEW.id; END;
