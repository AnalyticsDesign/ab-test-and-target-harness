-- B179: Better Auth 1.7 の API キーのプラグインは、鍵ごとの設定の名前(configId)を持つ。既存の鍵は既定の設定("default")。
-- 持ち主の列は、プラグインの schema の読み替え(referenceId → "userId")で今の列のまま使う(列・外部キー・索引を変えない)。
-- 足すだけなので、前の版の control はこの後も動く(Better Auth 1.4 は configId を書かず、既定値が入る)
ALTER TABLE apikey ADD COLUMN "configId" TEXT NOT NULL DEFAULT 'default';
