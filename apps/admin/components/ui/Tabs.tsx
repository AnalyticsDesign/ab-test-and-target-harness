"use client";
import type { ReactNode } from "react";
import styles from "./Tabs.module.css";

/**
 * 同じ画面の中での表示の切替(設計書 4.4)。中身は呼び出し側が value を見て出し分ける。
 * marked = そのタブの中にエラーがある印(control の 422 が別のタブの欄を指しているとき)
 */
export function Tabs({ tabs, value, onChange }: { tabs: Array<{ id: string; label: string; marked?: boolean }>; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className={styles.list}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-controls={`tabpanel-${t.id}`} aria-selected={t.id === value} className={styles.tab} onClick={() => onChange(t.id)}>
          {t.label}
          {t.marked ? <span className={styles.mark} role="img" aria-label="このタブに入力エラーがあります" /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * タブの中身。role="tab" は対になる tabpanel が要る(id / aria-controls / aria-labelledby で結ぶ)。
 * animate = 切替操作の後だけ true にする(初回表示は外側の PageEnter が動くので重ねない)
 */
export function TabPanel({ id, animate, children }: { id: string; animate?: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`tabpanel-${id}`} aria-labelledby={`tab-${id}`} className={animate ? "enter" : undefined}>
      {children}
    </div>
  );
}
