import { createPreviewEngine } from "./preview";

// 決定 50: プレビュー(#__ab_preview。エージェント用)の処理は本番の訪問者が使わないので、同期で読む runtime から外した別ファイル。
// 読まれたら runtime が待つ読み込み口に engine の作り方を置く。下書きの bootstrap は先頭にこれを埋め込み、設置タグ経由は edge の
// /s/preview/<hash>.js から読む(runtime.ts の loadPreviewFactory)
(self as unknown as { __WTT_PREVIEW__?: typeof createPreviewEngine }).__WTT_PREVIEW__ = createPreviewEngine;
