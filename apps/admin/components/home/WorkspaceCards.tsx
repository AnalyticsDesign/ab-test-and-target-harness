import Link from "next/link";
import { roleLabel } from "@/lib/roles";
import type { WorkspaceSummary } from "@/lib/types";
import styles from "./WorkspaceCards.module.css";

/** ホームのワークスペースのカード(決定 54 (8)): 名前・ロール・サイトの数・サイトごとの配信中の数。メンバーの数は管理者以上だけ(K22) */
export function WorkspaceCards({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  return (
    <div className={styles.grid}>
      {workspaces.map((w) => (
        <div key={w.id} className={styles.card} data-testid="workspace-card">
          <div className={styles.head}>
            <Link href={`/w/${w.id}`}>{w.name}</Link>
            <span className="badge">{roleLabel(w.role)}</span>
          </div>
          <span className="muted">
            サイト {w.sites.length}
            {w.memberCount !== null ? ` · メンバー ${w.memberCount}` : null /* K22: 管理者以上だけ */}
          </span>
          {w.sites.length === 0 ? (
            <span className="muted">まだサイトはありません</span>
          ) : (
            <ul className={styles.sites}>
              {w.sites.map((s) => (
                <li key={s.id}>
                  <Link href={`/w/${w.id}/sites/${s.id}`}>{s.name}</Link>
                  <span className="muted">配信中 {s.runningCount}</span>
                  <span className={`${styles.domain} mono`}>{s.domain}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
