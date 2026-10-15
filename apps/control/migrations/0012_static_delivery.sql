-- 決定 52: bootstrap を配信専用の Worker の静的アセットから配る。
-- static_seq = 出し直しの依頼の世代(依頼のたびに +1。デプロイ専用の Worker は新しい世代だけを受ける)
-- static_stale = 出し直しが済んでいない印(管理画面に警告と再試行のボタンを出す)
-- static_epoch = 世代の epoch の繰り上げ(世代の epoch = max(created_at, static_epoch)。削除の墓標に負けた Site を出し直すとき、墓標の epoch + 1 にする)
-- static_served_version = 配信ファイルが今配っている版(古い版の掃除がこの版以上の config を残す)
-- static_prev_served_version / static_served_at = 配っている版が切り替わる前の版と、切り替えの時刻(ms)。古い版の掃除が切り替えの直後 5 分は前の版も残す
-- static_removing = 削除ごとの印(token)。NULL = 削除中でない。Site の D1 の削除は、これが自分の token のときだけ行う(「配信ファイルを作り直す」が消すと削除を取りやめる)
ALTER TABLE sites ADD COLUMN static_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN static_stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN static_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN static_served_version INTEGER;
ALTER TABLE sites ADD COLUMN static_prev_served_version INTEGER;
ALTER TABLE sites ADD COLUMN static_served_at INTEGER;
ALTER TABLE sites ADD COLUMN static_removing TEXT;
-- 移行の時点では edge が KV の active から焼いて配っているので、配っている版 = active_version(前の版と切り替えの時刻は NULL のまま)
UPDATE sites SET static_served_version = active_version;
-- 公開中の Site は、移行の直後に一度出し直す(GET /sites/:sid の自己修復が依頼する)
UPDATE sites SET static_stale = 1 WHERE active_version IS NOT NULL;
