-- 本体を持つ版だけで、保持する境と掃除の候補を引く。
CREATE INDEX IF NOT EXISTS publishes_with_body
  ON publishes (site_id, version) WHERE config_json IS NOT NULL;

-- 入力の照合値を本体から作り直す必要がある、更新前の配信依頼だけを引く。
CREATE INDEX IF NOT EXISTS static_deploy_requests_without_digest
  ON static_deploy_requests (site_id, version) WHERE input_digest IS NULL;

-- 配信の確認がまだ要りうる行。needsDeliveryConfirmation の前半の条件と揃える。
CREATE INDEX IF NOT EXISTS experiment_delivered_definitions_unsettled
  ON experiment_delivered_definitions (site_id, publish_version) WHERE settled IS NULL OR settled = 'unknown';

-- KV の掃除は、キーをまだ消していない版だけを読む。
CREATE INDEX IF NOT EXISTS publishes_kv_live
  ON publishes (site_id, version) WHERE kv_deleted = 0;

-- 公開後に、世代がまだ無い届く定義へサイトと版から世代を記録する。setDeliveredGeneration の WHERE と同じ項で絞る。
-- 全行の (site_id, publish_version) にすると、統計の無い DB で配信の確認の run ごとの読み直し(run_id = ?)が
-- by_run ではなくこの索引でサイトの全行を読むため、部分索引にして、その読み直しには使えないようにする。
CREATE INDEX IF NOT EXISTS experiment_delivered_definitions_without_generation
  ON experiment_delivered_definitions (site_id, publish_version) WHERE static_generation IS NULL;
