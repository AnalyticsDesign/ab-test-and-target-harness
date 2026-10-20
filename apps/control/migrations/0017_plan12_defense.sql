-- plan12 K15(決定 63): サイトごとの「新しい訪問者の記録の上限(1 日あたり)」。NULL = Cloudflare のプランの既定を使う。
-- 番号はマージの時点で migrations/ の最大の番号 + 1 に付け直す。足すだけの変更(凍結の中で control の前に流す)
ALTER TABLE sites ADD COLUMN new_profile_budget_per_day INTEGER;
