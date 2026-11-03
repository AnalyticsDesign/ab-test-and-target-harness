import type { ReactNode } from "react";
import { Icon } from "./Icon";
import styles from "./SaveBar.module.css";

/**
 * 画面下に固定する保存バー。ボタンは呼び出し側が children で渡す(文言と disabled の条件を呼び出し側が持つため)。
 * message を渡す画面は、保存の成功を帯の左の文字で知らせる(決まり 5.3)。変更が無い間だけ「変更はありません」の代わりに出す。
 * message を渡す画面では左の文字を role="status" にする(後から入る文字を読み上げるため、領域は最初から置いておく)。
 * 成功の文の前にはチェックの印を付ける(spec §5.3。印は飾りなので読み上げない = Icon の aria-hidden)
 */
export function SaveBar({ dirty, message, children }: { dirty: boolean; message?: string | null; children: ReactNode }) {
  const idle = message ? (
    <>
      <Icon name="check" size={14} />
      {message}
    </>
  ) : (
    "変更はありません"
  );
  return (
    <div className={styles.bar}>
      <span className={`${styles.state} ${dirty ? styles.dirty : ""}`} data-testid="save-state" role={message === undefined ? undefined : "status"}>
        {dirty ? "未保存の変更あり" : idle}
      </span>
      {children}
    </div>
  );
}
