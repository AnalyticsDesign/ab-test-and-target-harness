import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import { PageEnter } from "./PageEnter";
import { NavGate } from "./NavGate";
import { ShellSidebar } from "./ShellSidebar";

/** サイドバー列 + 本文列。本文列の中身(TopBar と Content)は各 layout / page が描く */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <ShellSidebar>{sidebar}</ShellSidebar>
      <div className={styles.col}>{children}</div>
    </div>
  );
}

/**
 * ページ本文。E2E の appAlert が <main> の中の role="alert" を見るので、本文は必ずこの中に描く。
 * スクロールするのはこの <main> = 上部バーとバナーはその外に残り、縮まない。
 * SaveBar の `position: sticky; bottom: 0` はこの <main> のスクロールポートの下端に貼り付く。
 * 遅い遷移の間は NavGate が本文を隠して本文のスケルトンを出す(B173 第 1 段。NavGate.tsx)
 */
export function Content({ children }: { children: ReactNode }) {
  return (
    <main className={styles.content}>
      <div className={styles.inner}>
        <PageEnter>
          <NavGate>{children}</NavGate>
        </PageEnter>
      </div>
    </main>
  );
}
