"use client";
import type { ReactNode } from "react";

/**
 * `error` には 422 validation_failed の issue(lib/client.ts の `fieldErrors`)をそのまま渡せる。
 * `group`: 中身が Picker / Combo のときは <label> で包まない(選択肢のクリックが <label> の中の入力欄へ転送されるため)
 */
export function Field({ label, hint, error, group, children }: { label: string; hint?: ReactNode; error?: string | null; group?: boolean; children: ReactNode }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </Tag>
  );
}
