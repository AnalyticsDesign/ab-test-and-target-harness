-- 決定 49(B34): 目標の PAGEVIEW の config を { urlOp, urlValue } から { page: { op, value } } に名前を付け替える(意味は変えない)。
-- v0.9 のデータのために作る変換はこれだけ(設計書 §6.4)。URL 全体の正規表現(op = regex)の目標も名前だけ付け替え、
-- 新しい規則(URL に正規表現は使えない)で Publish が止まる(fail-closed。手で直してもらう)
UPDATE goals
SET config_json = json_object('page', json_object('op', json_extract(config_json, '$.urlOp'), 'value', json_extract(config_json, '$.urlValue')))
WHERE type = 'PAGEVIEW' AND json_extract(config_json, '$.urlOp') IS NOT NULL;
