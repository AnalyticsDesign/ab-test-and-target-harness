-- backlog D10(brief K3): 導入全体の設定。キーと値(値は JSON)。行が無い・読めない値は control が既定値として扱う
-- (src/instance-settings.ts)。使用状況の 3 項目から始め、後の項目(書き込みの凍結のスイッチなど)はマイグレーション無しでキーを足す
CREATE TABLE instance_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
