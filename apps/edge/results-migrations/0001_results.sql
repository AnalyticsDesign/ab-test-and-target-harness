-- 計測用 D1(wtt-results)の最初の表。設計書 §6.5 の DDL そのまま。
-- 表の形の版はマイグレーションの番号で管理する(列の追加は新しい番号のファイルで)

CREATE TABLE participants (
  run_id      TEXT NOT NULL,
  visitor_key BLOB NOT NULL,          -- HMAC の先頭 16 バイト
  site_id     TEXT NOT NULL,
  variant_id  TEXT NOT NULL,          -- 最初に参加したパターン
  exposed_at  INTEGER NOT NULL,       -- 初回の参加(edge の受信時刻、UTC ms)
  device      TEXT NOT NULL,          -- desktop | mobile | tablet
  applied     TEXT NOT NULL,          -- ok | failed | recovered
  mixed       INTEGER NOT NULL DEFAULT 0,
  mixed_at    INTEGER,                -- 混在になった時刻(edge の受信時刻、UTC ms。NULL 可)
  recovered_at INTEGER,               -- 適用が回復した時刻(edge の受信時刻、UTC ms。NULL 可)
  failed_at   INTEGER,                -- 後から失敗した時刻(edge の受信時刻、UTC ms。NULL 可)
  PRIMARY KEY (run_id, visitor_key)
) WITHOUT ROWID;
CREATE INDEX participants_by_visitor ON participants (site_id, visitor_key);

CREATE TABLE conversions (
  run_id       TEXT NOT NULL,
  goal_id      TEXT NOT NULL,
  visitor_key  BLOB NOT NULL,
  converted_at INTEGER NOT NULL,      -- 初回の CV(edge の受信時刻、UTC ms)
  PRIMARY KEY (run_id, goal_id, visitor_key)
) WITHOUT ROWID;
CREATE INDEX conversions_by_visitor ON conversions (visitor_key);
