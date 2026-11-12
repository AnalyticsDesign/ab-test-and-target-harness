-- 古い公開の本体を消した時刻。履歴の行と hash は保持する。
ALTER TABLE publishes ADD COLUMN body_pruned_at INTEGER;
