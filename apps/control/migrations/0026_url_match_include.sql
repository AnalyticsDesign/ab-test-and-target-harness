-- B69(spec §6.1・§6.2): 対象 URL(urlMatch)を「含める行 / 除く行」の形にし、配信条件・オーディエンスからページの条件
-- (ctx: url / host / path / query)を外す。意味は変えない(1 つのページの一致 = 含める 1 行)。データを書き換える文(1〜3)は 2 回当てても結果が変わらない。
-- 列を足す文(4)は 2 回目が失敗するが、migration の適用の記録で 1 回だけに限られる。

-- 1. エクスペリエンスの対象 URL を含める 1 行に包む。すでに include を持つ行(新しい形)は触らない。updated_at は進めない
--    (形を変えるだけで配信は変わらないため、未公開の変更にしない)
UPDATE experiments
SET url_match_json = json_object('include', json_array(json_object('page', json(url_match_json))))
WHERE json_valid(url_match_json) AND json_extract(url_match_json, '$.include') IS NULL;

-- 2. 届いた定義(結果の記録の材料)の urlMatch も同じく包む。包まないと、更新の後の最初の Publish で古い形と新しい形の違いが
--    テスト中の変更と記録される。definition_hash は SQL で計算し直せないので古いまま(次の Publish で行が 1 件増えるのは許す)。
--    結果の記録(result_snapshots)はその時点の写しなので包まない
UPDATE experiment_delivered_definitions
SET definition_json = json_set(definition_json, '$.urlMatch',
      json_object('include', json_array(json_object('page', json(json_extract(definition_json, '$.urlMatch'))))))
WHERE json_valid(definition_json)
  AND json_type(definition_json, '$.urlMatch') = 'object'
  AND json_extract(definition_json, '$.urlMatch.include') IS NULL;

-- 3. ページの条件が残った running のエクスペリエンスを一時停止にし、1 件ずつ記録する。条件 = 配信条件にページの条件の葉があるか、
--    参照する同じサイトのオーディエンス(主キーは (site_id, id))の定義にあるか。記録(追記だけの表)を先に入れ、同じ条件で更新する。
--    2 回目は running の行が残っていないので、記録も更新も増えない。記録の形はアプリの状態の変更の記録と同じ + reason
INSERT INTO audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via,
                          actor_user_id, target_type, target_id, target_label, detail_json)
SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'content', 'experiment.status', s.workspace_id, e.site_id, e.id,
       s.generation, e.generation, 'system', NULL, 'experiment', e.id, substr(e.name, 1, 200),
       json_object('from', 'running', 'to', 'paused', 'reason', 'page_condition_moved')
FROM experiments e JOIN sites s ON s.id = e.site_id
WHERE e.status = 'running' AND json_valid(e.targeting_json) AND (
  EXISTS (SELECT 1 FROM json_tree(e.targeting_json) t WHERE t.key = 'ctx' AND t.type = 'text' AND t.atom IN ('url', 'host', 'path', 'query'))
  OR EXISTS (
    SELECT 1 FROM json_tree(e.targeting_json) r
    JOIN audiences a ON a.site_id = e.site_id AND a.id = r.atom
    WHERE r.key = 'audience' AND r.type = 'text' AND json_valid(a.definition_json)
      AND EXISTS (SELECT 1 FROM json_tree(a.definition_json) t WHERE t.key = 'ctx' AND t.type = 'text' AND t.atom IN ('url', 'host', 'path', 'query'))
  )
)
ORDER BY e.site_id, e.id;

UPDATE experiments
SET status = 'paused', updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE status = 'running' AND json_valid(targeting_json) AND (
  EXISTS (SELECT 1 FROM json_tree(experiments.targeting_json) t WHERE t.key = 'ctx' AND t.type = 'text' AND t.atom IN ('url', 'host', 'path', 'query'))
  OR EXISTS (
    SELECT 1 FROM json_tree(experiments.targeting_json) r
    JOIN audiences a ON a.site_id = experiments.site_id AND a.id = r.atom
    WHERE r.key = 'audience' AND r.type = 'text' AND json_valid(a.definition_json)
      AND EXISTS (SELECT 1 FROM json_tree(a.definition_json) t WHERE t.key = 'ctx' AND t.type = 'text' AND t.atom IN ('url', 'host', 'path', 'query'))
  )
);

-- 4. 公開版ごとに、その版の配る設定に入ったエクスペリエンスの ID(JSON の配列)。配信の確かめは、エクスペリエンスが入った版だけを
--    証拠にする。更新の前の版は NULL(今までどおり当てる)。ALTER TABLE は 2 回当てられない(同じ列がすでにある)ので、
--    migration の適用の記録(d1_migrations)で 1 回だけに限る
ALTER TABLE publishes ADD COLUMN experiment_ids_json TEXT;
