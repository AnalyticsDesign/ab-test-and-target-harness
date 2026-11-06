-- B68: 画像をサイトの持ち物(画像のライブラリ)に作り直す。experiment_id を消し、管理用の名前・縮小版・削除待ちの列を足す。
-- SQLite の列の削除と制約の追加は表の作り直しで行う(0015 と同じ流儀)。今ある画像の R2 のキーと公開 URL は動かさない。
-- D1 のトリガーは置かない(消すと決めた後の新しい参照は、公開の設定の記録の条件付きの UPDATE で止める)。
CREATE TABLE assets_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- 管理用の名前(表示のまま。NFC・前後の空白を落としたもの)
  name_key TEXT NOT NULL,             -- 重複の判定用(name の英字だけを小文字にしたもの。control が書く)
  r2_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,                      -- 縮小版を作るときに Images から読む。読めなければ NULL
  height INTEGER,
  thumb_key TEXT,                     -- 縮小版の R2 のキー。無ければ NULL
  thumb_state TEXT NOT NULL DEFAULT 'pending',  -- pending | ready | failed | skipped
  thumb_attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,                 -- 削除待ちにした時刻。NULL = ふつう
  deleted_by TEXT,                    -- 削除を押した人
  kept_at INTEGER,                    -- 削除待ちから Cron が戻した時刻(使われていたため)
  purge_marked_at INTEGER,            -- 消す途中の印(Cron が参照の無いことを確かめた時刻)。R2 を消せるまで行を残す墓標を兼ねる
  updated_at INTEGER NOT NULL
);
-- 今ある画像の仮の名前は「画像(<ID の全体>)」。ID はサイトの中で重ならないので、名前も重ならない(末尾だけを使うと重なりうる)
INSERT INTO assets_new (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at)
  SELECT id, site_id, '画像(' || id || ')', lower('画像(' || id || ')'),
         r2_key, public_url, mime, size, 'pending', created_by, created_at, created_at FROM assets;
DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
CREATE UNIQUE INDEX assets_site_name ON assets(site_id, name_key);
CREATE INDEX assets_site_created ON assets(site_id, created_at);
CREATE INDEX assets_thumb_pending ON assets(created_at) WHERE thumb_state = 'pending';
CREATE INDEX assets_pending_delete ON assets(deleted_at) WHERE deleted_at IS NOT NULL;

-- 公開したときの定義が使っている画像(一覧・削除の判定が、定義の JSON を毎回照合しないため)。
-- エクスペリエンスを消すと外部キーで一緒に消える。画像の行は外部キーで持たない(削除待ちの間も定義の行は残るため)
CREATE TABLE asset_delivered_refs (
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  PRIMARY KEY (site_id, asset_id, experiment_id),
  FOREIGN KEY (site_id, experiment_id) REFERENCES experiments(site_id, id) ON DELETE CASCADE
);
-- 既存の定義から 1 回だけ埋める(定義の文字列に画像の ID がそのまま現れるもの。同じサイトの中だけ)
INSERT OR IGNORE INTO asset_delivered_refs (site_id, asset_id, experiment_id)
  SELECT a.site_id, a.id, d.experiment_id FROM assets a
  JOIN experiment_delivered_definitions d ON d.site_id = a.site_id AND instr(d.definition_json, a.id) > 0;
