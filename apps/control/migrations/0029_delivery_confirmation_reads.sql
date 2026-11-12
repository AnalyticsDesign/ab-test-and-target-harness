-- 更新前の形式(入力の照合値の無い)配信依頼の記録は、配信の確認にも本体の掃除の守りにも使わなくなった
DROP INDEX IF EXISTS static_deploy_requests_without_digest;
-- 確認の要る run を run の順に読めるよう(DISTINCT が run ごとに最初の 1 行で次へ進める)、確認がまだ要りうる届く定義の部分索引を作り直す。WHERE は 0028 と同じ
DROP INDEX IF EXISTS experiment_delivered_definitions_unsettled;
CREATE INDEX IF NOT EXISTS experiment_delivered_definitions_unsettled
  ON experiment_delivered_definitions (site_id, run_id, publish_version) WHERE settled IS NULL OR settled = 'unknown';
-- 配信の確認の run ごとの読み取り・作り直しの削除と、結果のレポートの読み取りが使う
CREATE INDEX IF NOT EXISTS experiment_delivery_changes_by_run ON experiment_delivery_changes (run_id, publish_version);
