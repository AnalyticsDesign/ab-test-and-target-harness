-- 7o K16・K24: 配信ファイルの出し直しの依頼の記録に、送った入力の digest(boot payload の SHA-256。core の staticInputDigest)を残す。
-- D9 の配信の確認が、同じ世代番号の別の中身(D1 を過去の時点に戻した後の依頼が、デプロイ専用の Worker の履歴にある世代を再利用した)を
-- 新しい版の配信の証拠にしないため、履歴の項目の digest とこの列を照らし合わせる。
-- 足すだけの変更。control より前に流す(新しい control は依頼の記録の INSERT にこの列を含め、書けなければ依頼を送らない)。
-- 既存の行(この変更の前の依頼)は NULL のまま(配信の確認は、その記録の版の config と今の設定から digest を作って照らし合わせる)
ALTER TABLE static_deploy_requests ADD COLUMN input_digest TEXT;
