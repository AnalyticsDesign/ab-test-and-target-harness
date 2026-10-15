"use client";
import { useRef, useState } from "react";
import { Icon } from "./Icon";

/** コード枠 + コピー。clipboard が使えなければ選択状態にするだけ(設計書 4.6) */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = ref.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--code-bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 8px 8px 12px" }}>
      <code ref={ref} data-testid="code-block" style={{ marginRight: "auto", overflowX: "auto", whiteSpace: "nowrap" }}>
        {code}
      </code>
      <button type="button" className="btn" aria-label={label} onClick={() => void copy()}>
        <Icon name="copy" />
        {copied ? "コピーしました" : "コピー"}
      </button>
    </div>
  );
}
