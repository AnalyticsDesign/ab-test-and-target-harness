import type { ReactNode } from "react";
import styles from "./SaveBar.module.css";

/** 画面下に固定する保存バー。ボタンは呼び出し側が children で渡す(文言と disabled の条件を呼び出し側が持つため) */
export function SaveBar({ dirty, children }: { dirty: boolean; children: ReactNode }) {
  return (
    <div className={styles.bar}>
      <span className={`${styles.state} ${dirty ? styles.dirty : ""}`} data-testid="save-state">
        {dirty ? "未保存の変更あり" : "変更はありません"}
      </span>
      {children}
    </div>
  );
}
