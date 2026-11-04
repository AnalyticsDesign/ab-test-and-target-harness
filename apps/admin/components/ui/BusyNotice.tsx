"use client";
import { useCallback, useState } from "react";
import { NO_NOTICE, noticeOf, type BusyNotice } from "@/lib/busy-notice";
import type { BusyOutcome } from "@/lib/run-busy";
import { ErrorBox } from "../ErrorBox";

/**
 * 範囲(BusyScope)の書き込みの結果の 1 行を持つ(B173 第 2 段 Task 6)。範囲ごとに 1 つ持つ(別の範囲の結果が混ざらないように)。
 * show は結果を出す(discarded・cancelled などは今の表示のまま)。clear は次の操作を始めたとき、clearStatus は欄を変えたときに呼ぶ
 */
export function useBusyNotice(): {
  notice: BusyNotice;
  show: (outcome: BusyOutcome<unknown>, success: string | null) => void;
  clear: () => void;
  clearStatus: () => void;
  setError: (error: string | null) => void;
} {
  const [notice, setNotice] = useState<BusyNotice>(NO_NOTICE);
  const show = useCallback((outcome: BusyOutcome<unknown>, success: string | null) => {
    const next = noticeOf(outcome, success);
    if (next) setNotice(next);
  }, []);
  const clear = useCallback(() => setNotice(NO_NOTICE), []);
  // 欄を変えたときは成功の文だけを消す(失敗の文は次の操作まで残す)
  const clearStatus = useCallback(() => setNotice((n) => (n.status ? { ...n, status: null } : n)), []);
  const setError = useCallback((error: string | null) => setNotice({ status: null, error }), []);
  return { notice, show, clear, clearStatus, setError };
}

/** 結果の 1 行の表示(失敗 = ErrorBox / 成功 = role="status")。何も無ければ描かない */
export function BusyNoticeText({ notice }: { notice: BusyNotice }) {
  return (
    <>
      <ErrorBox message={notice.error} />
      {notice.status ? <p role="status">{notice.status}</p> : null}
    </>
  );
}

/** 一覧のカードの先頭に置く結果の 1 行(カードの直下の最初の子)。何も無ければ描かない */
export function CardNotice({ notice }: { notice: BusyNotice }) {
  if (!notice.error && !notice.status) return null;
  return (
    <div className="card-notice" data-testid="card-notice">
      <BusyNoticeText notice={notice} />
    </div>
  );
}
