-- 決定 49(B34): オーディエンス(Site ごとの名前付きの条件。設計書 §5.1)を作り、URL パターンの表を消す(閲覧の条件はページの一致を
-- 直接書き、パターン ID は Publish が値から決める)。url_patterns のデータは移さない(v1.0 を最初の基準にする。設計書 §6.4)
CREATE TABLE audiences (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
);
DROP TABLE url_patterns;
