"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import type { ResultsResponse } from "@/lib/results-view";
import type { Experiment } from "@/lib/types";
import { DuplicateDialog } from "./DuplicateDialog";

/**
 * 見出しの「複製」(編集者以上。どのタブ・どの状態でも)。
 * 開始した後のテストは、押したときに結果を読んでから開く(初期値とプルダウンに判定と上回る確率を使う。設計書 §4.2・D9 ③ Task 16)。
 * 読めなければ結果なしで開く
 */
export function DuplicateButton({ wid, siteId, experiment }: { wid: string; siteId: string; experiment: Experiment }) {
  const [open, setOpen] = useState<{ report: ResultsResponse | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const needsResults = experiment.kind === "test" && experiment.status !== "draft";
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={loading}
        onClick={async () => {
          if (!needsResults) {
            setOpen({ report: null });
            return;
          }
          setLoading(true);
          let report: ResultsResponse | null = null;
          try {
            report = await api<ResultsResponse>("GET", `/sites/${siteId}/experiments/${experiment.id}/results`);
          } catch {
            report = null;
          }
          setLoading(false);
          setOpen({ report });
        }}
      >
        {loading ? "読み込み中…" : "複製"}
      </button>
      {open ? <DuplicateDialog wid={wid} siteId={siteId} experiment={experiment} open report={open.report} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
