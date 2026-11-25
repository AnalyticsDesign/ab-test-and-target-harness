"use client";

import { useId, useState, type ReactNode } from "react";
import styles from "./AppShell.module.css";

/** 本文の幅を優先し、狭い画面でだけメニューを開閉する。 */
export function ShellSidebar({ children }: { children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={styles.menuBar}>
        <button type="button" className="btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          メニュー
        </button>
      </div>
      <aside id={id} className={styles.side} data-open={open}>{children}</aside>
    </>
  );
}
