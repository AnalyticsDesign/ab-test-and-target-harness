"use client";
import Link from "next/link";
import type { MouseEvent } from "react";
import { Icon, type IconName } from "./Icon";
import styles from "./Sidebar.module.css";

/**
 * 左メニューの 1 項目(普段のメニュー・設定のメニューで共有する)。Sidebar と SettingsSidebar の両方が使うので別のファイルに置く
 * (どちらかに置くと、Sidebar → SettingsSidebar → Sidebar の循環の import になる)。
 * testId・danger・marked はサイト設定の節の項目だけが使う(B60: 本文の中にあった節のメニューから移した印)
 */
export function NavItem({
  href,
  icon,
  label,
  current,
  prefetch,
  onClick,
  testId,
  danger,
  marked,
}: {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  prefetch?: false;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  testId?: string;
  /** 注意の色で出す(危険な操作の節) */
  danger?: boolean;
  /** 右端に入力エラーの赤い点を付ける(その節に入力エラーがある) */
  marked?: boolean;
}) {
  return (
    // prefetch は false のときだけ渡す(未指定 = フレームワークの既定のまま)
    <Link
      href={href}
      prefetch={prefetch}
      className={danger ? `${styles.item} ${styles.danger}` : styles.item}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon name={icon} />
      {label}
      {marked ? <span className={styles.mark} role="img" aria-label="この節に入力エラーがあります" /> : null}
    </Link>
  );
}
