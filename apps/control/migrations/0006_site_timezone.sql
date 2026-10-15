-- 決定 49(B34): 曜日・時間帯の条件の判定に使うサイトのタイムゾーン(IANA 名)。compiled config で配る(Publish で効く)
ALTER TABLE sites ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo';
