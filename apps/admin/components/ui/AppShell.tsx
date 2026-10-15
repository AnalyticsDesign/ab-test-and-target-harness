import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import { PageEnter } from "./PageEnter";

/** サイドバー列 + 本文列。本文列の中身(TopBar と Content)は各 layout / page が描く */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.side}>{sidebar}</aside>
      <div className={styles.col}>{children}</div>
    </div>
  );
}

/**
 * ページ本文。E2E の appAlert が <main> の中の role="alert" を見るので、本文は必ずこの中に描く。
 * スクロールするのはこの <main> = 上部バーとバナーはその外に残り、縮まない。
 * SaveBar の `position: sticky; bottom: 0` はこの <main> のスクロールポートの下端に貼り付く
 */
export function Content({ children }: { children: ReactNode }) {
  return (
    <main className={styles.content}>
      <div className={styles.inner}>
        <PageEnter>{children}</PageEnter>
      </div>
    </main>
  );
}
