-- spec §16 / 決定 37: 撤回時に runtime が forget を送り DO の Profile を削除する(既定 on)。off = Retention に委ねる
ALTER TABLE sites ADD COLUMN forget_on_revoke INTEGER NOT NULL DEFAULT 1;
