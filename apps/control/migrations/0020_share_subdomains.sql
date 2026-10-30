-- B139: 訪問者 ID の Cookie をサブドメインをまたいで共有する。
-- share_subdomains: 共有するか(0 / 1)。列の既定は 0(今までどおりホスト限定)。新しいサイトは control が 1 で作る。
-- previous_cookie_domains_json: 前の共有の範囲と保持期限([{ domain, until(epoch 秒) }])。範囲が消える保存のたびに control が足す。
-- share_migration_pending: 共有の自動の移行(同じ導入の中で衝突しないサイトをオンにする)の対象(0 / 1)。既存の行は下で 1 にする。
-- 足すだけの変更。control より前に流す(新しい control はこれらの列を読み書きする)
ALTER TABLE sites ADD COLUMN share_subdomains INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN previous_cookie_domains_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sites ADD COLUMN share_migration_pending INTEGER NOT NULL DEFAULT 0;
UPDATE sites SET share_migration_pending = 1;

-- 共有の予約: 登録ドメイン × Cookie 名をどのサイトが使うか(同じ導入の中で、同じ範囲・同じ名前の Cookie を 2 つのサイトが書かないため)。
-- until = 前の範囲・旧名の予約の期限(epoch 秒)。今の範囲・今の名前は NULL。サイトを消すと予約も消える
CREATE TABLE sharing_claims (
  domain TEXT NOT NULL,
  cookie_name TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  until INTEGER,
  PRIMARY KEY (domain, cookie_name)
);
