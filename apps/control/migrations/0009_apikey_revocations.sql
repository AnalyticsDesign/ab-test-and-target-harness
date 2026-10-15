-- backlog B42(brief K15・K16): API キーの失効の記録。
-- Better Auth の apiKey プラグインは、鍵の検証のたびに読み込んだ行を丸ごと書き戻す(enabled を含む)。
-- そのため apikey.enabled だけでは、検証と失効がすれ違うと失効が消える。失効はこの表を正とし、control の鍵の入口が毎回見る
-- (apikey.enabled = 0 も今までどおり書く。Better Auth 側の判定にも効かせるため)
CREATE TABLE apikey_revocations (
  key_id TEXT NOT NULL PRIMARY KEY REFERENCES apikey("id") ON DELETE CASCADE,
  revoked_at INTEGER NOT NULL,
  revoked_by TEXT
);

-- 既に失効している鍵(enabled = 0)を移す。失効の時刻は updatedAt(失効の処理が enabled と同時に書いていた。ISO 文字列か epoch ミリ秒)
INSERT INTO apikey_revocations (key_id, revoked_at, revoked_by)
SELECT id,
  CASE WHEN typeof("updatedAt") = 'integer' THEN "updatedAt"
       ELSE CAST(round((julianday("updatedAt") - 2440587.5) * 86400000) AS INTEGER) END,
  NULL
FROM apikey
WHERE enabled = 0;

-- 範囲(scope)を持たない有効な鍵は使えない(control が 401 にする)ので、失効済みにして一覧に「失効済み」と出す。
-- 条件は「metadata に scope を含まない」: 順序を誤って control の deploy の後に流しても、範囲付きの鍵は失効しない
INSERT INTO apikey_revocations (key_id, revoked_at, revoked_by)
SELECT id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM apikey
WHERE coalesce(enabled, 1) != 0
  AND (metadata IS NULL OR metadata NOT LIKE '%scope%');

UPDATE apikey SET enabled = 0 WHERE id IN (SELECT key_id FROM apikey_revocations) AND coalesce(enabled, 1) != 0;
