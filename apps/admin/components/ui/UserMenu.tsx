"use client";
import type { SessionUser } from "@/lib/types";
import { Icon } from "./Icon";
import styles from "./Sidebar.module.css";

/**
 * 名前のメニュー = ログアウトだけ(B60。設定の入口は左メニューの最下部の「設定」1 つにまとめた)。
 * caption = ワークスペース・サイトではそこでのロール、ホームと設定ではメール(K19)。
 * ログアウトは今までと同じ POST のフォーム(離脱の確認で取り消したときは、確認の側がこの details を閉じる)
 */
export function UserMenu({ user, caption }: { user: SessionUser; caption: string }) {
  return (
    <details className={styles.switcher} data-testid="user-menu">
      <summary className={styles.switcherSummary}>
        <span className={styles.switcherText}>
          <span className={styles.current}>{user.name}</span>
          <span className={styles.caption}>{caption}</span>
        </span>
        <Icon name="chevrons" />
      </summary>
      <div className={`${styles.pop} ${styles.popUp}`}>
        <form action="/api/session/logout" method="post">
          <button className={styles.popItem} style={{ width: "100%", textAlign: "left", border: 0, background: "none", font: "inherit", cursor: "pointer" }}>
            <Icon name="logout" size={14} />
            ログアウト
          </button>
        </form>
      </div>
    </details>
  );
}
