-- B77(設計書 §1〜§2): パターンの「オリジナル」・メモ、目標の外部計測の列を足す。
-- メモ(エクスペリエンスとパターン)。上限 1,000 字はルートで見る。既存の行は空
ALTER TABLE experiments ADD COLUMN description TEXT NOT NULL DEFAULT '';
-- オリジナル(0 / 1)。オリジナルのパターンは変更を持たず、元のページをそのまま見せる。既存の行は 0
ALTER TABLE variants ADD COLUMN original INTEGER NOT NULL DEFAULT 0;
ALTER TABLE variants ADD COLUMN description TEXT NOT NULL DEFAULT '';
-- 目標の外部計測。`{ "overrides": { "goalName": "…" } }`。無ければ NULL
ALTER TABLE goals ADD COLUMN analytics_json TEXT;

-- 名前を外部計測の名前に写す(K7)。compiled config から管理画面の名前を抜くため、
-- 開始済みのエクスペリエンス・パターンと、すべての目標は今の名前を外部計測の名前にして dataLayer の出力を保つ。
-- json_patch は RFC 7396 の深いマージなので、既存の overrides の別のキーと extra は残る。
-- updated_at は変えない(出力が変わらないので「未公開の編集あり」を付けない)。下書きは写さない(開始まで配信されない)
UPDATE experiments
SET analytics_json = json_patch(coalesce(analytics_json, '{}'), json_object('overrides', json_object('experimentName', name)))
WHERE started_at IS NOT NULL
  AND json_extract(coalesce(analytics_json, '{}'), '$.overrides.experimentName') IS NULL;

UPDATE variants
SET analytics_json = json_patch(coalesce(analytics_json, '{}'), json_object('overrides', json_object('variantName', name)))
WHERE json_extract(coalesce(analytics_json, '{}'), '$.overrides.variantName') IS NULL
  AND EXISTS (
    SELECT 1 FROM experiments e
    WHERE e.site_id = variants.site_id AND e.id = variants.experiment_id AND e.started_at IS NOT NULL
  );

UPDATE goals
SET analytics_json = json_object('overrides', json_object('goalName', name))
WHERE analytics_json IS NULL;
