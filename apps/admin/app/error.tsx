"use client";

import { PageMark } from "@/components/ui/PageMark";
import { writeSucceededRecently } from "@/lib/feedback-store";

/**
 * サーバーコンポーネントや画面側で拾えなかった例外の受け皿(Next の error boundary)。
 * これが無いと control 障害などがそのまま 500 の HTML になり、利用者には何も伝わらない。
 * PageMark(kind="error")は、移動先がこの画面になったことを知らせて、遷移の待ち表示を終える
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // 保存の直後の読み直しで失敗したときは、保存そのものは済んでいると伝える(利用者が保存をやり直さないように)。描いたときに 1 回読めばよい
  const saved = writeSucceededRecently();
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <PageMark kind="error" />
      <h1>エラーが発生しました</h1>
      <p className="muted">画面を表示できませんでした。control に接続できないか、一時的な障害の可能性があります。</p>
      {saved ? <p className="muted">保存は済んでいます。</p> : null}
      {error.digest ? <p className="muted">参照 ID: {error.digest}</p> : null}
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        再試行する
      </button>
    </div>
  );
}
