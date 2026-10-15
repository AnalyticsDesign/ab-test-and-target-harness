"use client";
import { useRef } from "react";
import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { Icon } from "./Icon";
import styles from "./Sidebar.module.css";

/**
 * ユーザーメニュー = 設定 / ログアウト(決定 54 (7))。caption = ワークスペース・サイトではそこでのロール、ホームと設定ではメール(K19)。
 * ログアウトは今までと同じ POST のフォーム。リンクを押したら閉じる(サイドバーは遷移をまたいで残る)
 */
export function UserMenu({ user, caption }: { user: SessionUser; caption: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  return (
    <details ref={ref} className={styles.switcher} data-testid="user-menu">
      <summary className={styles.switcherSummary}>
        <span className={styles.switcherText}>
          <span className={styles.current}>{user.name}</span>
          <span className={styles.caption}>{caption}</span>
        </span>
        <Icon name="chevrons" />
      </summary>
      <div className={`${styles.pop} ${styles.popUp}`}>
        <Link href="/w/me/api-keys" className={styles.popItem} onClick={close}>
          <Icon name="gear" size={14} />
          設定
        </Link>
        <div className={styles.popSep} />
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
