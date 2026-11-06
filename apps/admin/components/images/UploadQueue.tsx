"use client";
import type { QueueRow } from "@/lib/use-upload-queue";
import { LARGE_IMAGE_BYTES } from "@/lib/images";
import styles from "./ImageLibrary.module.css";

const STATE_CLASS: Record<QueueRow["state"], string | undefined> = { waiting: styles.qwait, uploading: styles.qrun, done: styles.qok, failed: styles.qerr };

/**
 * アップロードの結果のカード(spec §9.2)。見出しの件数で進みを伝え、行ごとに 待機中・アップロード中・完了・失敗(理由)。
 * 成功は緑・失敗は赤(トーストは使わない)。読み上げはカードに role="status" で、失敗の行を 1 つずつ alert にしない(まとめて読まれすぎるため)。
 * 送っている間は「閉じる」を押せない(行が消えると進みが見えなくなる)
 */
/** 送っている間に見出しの横に出す 1 行(一覧の画面の既定。選ぶ窓では名前を変えられないので、呼び出し元が文を変える) */
const ACTIVE_HINT = "送っている間も、ほかの画像を選んだり名前を変えたりできます";

export function UploadQueue({ rows, active, onClose, activeHint = ACTIVE_HINT }: { rows: QueueRow[]; active: boolean; onClose: () => void; activeHint?: string }) {
  if (rows.length === 0) return null;
  const done = rows.filter((r) => r.state === "done").length;
  return (
    <section className={`card ${styles.queueCard}`} role="status" aria-label="アップロードの結果">
      <div className={styles.queueHead}>
        <h2>
          アップロード({done} / {rows.length})
        </h2>
        {active ? <span className="muted">{activeHint}</span> : null}
        <button type="button" className="btn btn-sm" disabled={active} onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className={styles.queue}>
        {rows.map((r) => (
          <div key={r.key} className={styles.qrow}>
            <span className={styles.qname} title={r.renamedFrom && r.name ? `${r.fileName} → ${r.name}` : r.fileName}>
              {r.fileName}
              {r.renamedFrom && r.name ? <span className="muted"> → {r.name}(同じ名前があったので番号を付けました)</span> : null}
            </span>
            <span className={`${styles.qstate} ${STATE_CLASS[r.state] ?? ""}`}>
              {r.state === "uploading" ? <span className={styles.spinner} aria-hidden="true" /> : null}
              {rowText(r)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function rowText(r: QueueRow): string {
  switch (r.state) {
    case "waiting":
      return "待機中";
    case "uploading":
      return "アップロード中";
    case "done":
      // 1MB を超える画像は、配信の速さのための注意を添える
      return r.size > LARGE_IMAGE_BYTES ? "完了(1MB を超えるため、表示速度に影響します)" : "完了";
    case "failed":
      return `失敗: ${r.error ?? ""}`;
  }
}
