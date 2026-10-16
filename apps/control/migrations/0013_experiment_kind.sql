-- 決定 51(D9 plan ①、設計書 §3.1): エクスペリエンスの種別。test = テスト(2 つ以上のパターンに振り分けて比べる)、
-- single = パーソナライズ(パターン 1 つ・重み 100)。作成後は変えない。既存の行はすべて test
ALTER TABLE experiments ADD COLUMN kind TEXT NOT NULL DEFAULT 'test';
-- 決定 51(設計書 §3.2、2026-10-06 ユーザー決定): テストどうしの優先の順に使う「配信に入った時刻」。running になる遷移(開始・再開)のたびに更新する。
-- started_at(最初の開始。analytics-recipe の期間の起点)とは別に持つ。既存の行は started_at から埋める(一時停止中のものは再開で更新される)
ALTER TABLE experiments ADD COLUMN last_started_at INTEGER;
UPDATE experiments SET last_started_at = started_at WHERE started_at IS NOT NULL;
