import type { ReactNode } from "react";

/** ページ見出し + 右上の主操作(設計書 4.7 の「4 画面の型」)。見出しは必ず h1(E2E が heading で引く) */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 20 }}>
      <div style={{ marginRight: "auto", minWidth: 0 }}>
        <h1 style={{ margin: 0 }}>{title}</h1>
        {meta ? <div className="muted" style={{ marginTop: 4 }}>{meta}</div> : null}
      </div>
      {actions ? <div className="row" style={{ flexShrink: 0 }}>{actions}</div> : null}
    </div>
  );
}
