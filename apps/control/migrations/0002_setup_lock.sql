-- spec §13.3: 初回セットアップを先勝ちで 1 回に閉じるための行ロック(id は常に 1)
CREATE TABLE setup_lock (id INTEGER PRIMARY KEY CHECK (id = 1), created_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
