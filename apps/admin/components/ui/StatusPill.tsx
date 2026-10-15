import type { ReactNode } from "react";

const TONE = {
  ok: ["var(--ok)", "var(--ok-soft)"],
  warn: ["var(--warn)", "var(--warn-soft)"],
  gray: ["var(--gray)", "var(--gray-soft)"],
  danger: ["var(--danger)", "var(--danger-soft)"],
  accent: ["var(--accent)", "var(--accent-soft)"],
} as const;

/** 状態の pill。色の意味は設計書 2 節(ok = 配信中 / warn = 一時停止・未公開・未反映 / gray = 下書き・終了) */
export function StatusPill({ tone, children, title }: { tone: keyof typeof TONE; children: ReactNode; title?: string }) {
  const [fg, bg] = TONE[tone];
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 12, fontWeight: 500, color: fg, background: bg, whiteSpace: "nowrap", transition: "color var(--dur-fast), background var(--dur-fast)" }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: fg }} />
      {children}
    </span>
  );
}
