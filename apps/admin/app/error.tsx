"use client";

/**
 * サーバーコンポーネントや画面側で拾えなかった例外の受け皿(Next の error boundary)。
 * これが無いと control 障害などがそのまま 500 の HTML になり、利用者には何も伝わらない
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>エラーが発生しました</h1>
      <p className="muted">画面を表示できませんでした。control に接続できないか、一時的な障害の可能性があります。</p>
      {error.digest ? <p className="muted">参照 ID: {error.digest}</p> : null}
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        再試行する
      </button>
    </div>
  );
}
