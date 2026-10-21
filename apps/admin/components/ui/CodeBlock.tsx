"use client";
import { useRef, useState } from "react";
import { Icon } from "./Icon";

/** コード枠 + コピー。clipboard が使えなければ選択状態にするだけ(設計書 4.6) */
// label は「〜をコピー」の形(読み上げの名前に見える文字「コピー」を含め、コピーした後は「〜をコピーしました」にするため)
export function CodeBlock({ code, label }: { code: string; label: `${string}コピー` }) {
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
      {/* 読み上げの名前は見える文字を含める(label は「リンクをコピー」などで、見える「コピー」を含む)。コピーした後も名前と表示をそろえる */}
      <button type="button" className="btn" aria-label={copied ? `${label}しました` : label} onClick={() => void copy()}>
        <Icon name="copy" />
        {copied ? "コピーしました" : "コピー"}
      </button>
      {/* コピーしたことは、ボタンの名前が変わるだけでは読み上げられないので、status で知らせる */}
      <span role="status" className="visually-hidden">
        {copied ? "コピーしました" : ""}
      </span>
    </div>
  );
}
