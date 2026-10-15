"use client";
import type { ReactNode } from "react";

export function SubmitButton({ busy, children, danger, form, disabled }: { busy: boolean; children: ReactNode; danger?: boolean; form?: string; disabled?: boolean }) {
  return (
    <button type="submit" disabled={busy || disabled} className={danger ? "btn btn-danger" : "btn btn-primary"} form={form}>
      {busy ? "送信中…" : children}
    </button>
  );
}
