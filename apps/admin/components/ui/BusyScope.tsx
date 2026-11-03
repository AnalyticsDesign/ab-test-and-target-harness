"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { navStartedAfter, nextSeq, noteWriteSucceeded, setGuard } from "@/lib/feedback-store";
import { claimRun, realClock, releaseRun, runBusy, type BusyOutcome, type BusyTask } from "@/lib/run-busy";
import { useRefreshAndWait } from "@/lib/use-refresh-and-wait";
import styles from "./BusyScope.module.css";

export { claimRun, releaseRun, runBusy };
export type { BusyOutcome, BusyTask };

const DEFAULT_LABEL = "保存中…";

type BusyContextValue = {
  /** 実行権を持っている間(確認の間も含む)true */
  busy: boolean;
  run<T>(task: BusyTask<T>): Promise<BusyOutcome<T>>;
};

const BusyContext = createContext<BusyContextValue | null>(null);

/**
 * 書き込み(保存・削除など)の間、範囲を覆って触れなくし、二度押しを止める(B173 第 1 段)。
 * 書き込み中は中身に inert と aria-busy を付け、本文の背景色を 60% で重ねた覆いに回る印と文言(role="status")を出す。
 * 覆いは中身の外に置く(inert の中に置くと、支援技術に「保存中」が届かないため)。className は中身の側に付く(中身のレイアウトを変えないため)。
 * 書き込みの流れ(確認・上限・読み直しの待ち・遷移との競合)は lib/run-busy.ts。ここは実行権(範囲ごとに 1 つ)・覆いの出し外し・フォーカスの復帰・
 * 節ごとの状態(dirty / busy)の登録(feedback-store の setGuard。unmount で外す)を持つ。
 * `dirty` は呼び出し元が持つ未保存の印。ページを離れる前の確認が見る
 */
export function BusyScope({ id, dirty = false, children, className }: { id: string; dirty?: boolean; children: ReactNode; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(null);
  /** 実行権。state にしない(同じ tick の二度目の呼び出しでも、描き直しを待たずに止めるため) */
  const running = useRef(false);
  const dirtyRef = useRef(dirty);
  const mounted = useRef(true);
  /** 覆う前に押されていたボタン。覆いを外したらここへフォーカスを戻す */
  const focusTarget = useRef<HTMLElement | null>(null);
  const refreshAndWait = useRefreshAndWait();
  // useRefreshAndWait は router が変わると別の関数を返す。run を安定させるため、最新を ref で読む
  const refreshRef = useRef(refreshAndWait);

  useEffect(() => {
    dirtyRef.current = dirty;
    refreshRef.current = refreshAndWait;
  });

  useEffect(() => {
    // StrictMode は effect を cleanup してからもう一度走らせるので、走らせるたびに true に戻す
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 節ごとの状態の登録。外すのは id ごと(unmount・id の変更)。dirty / busy の変化のたびに外して付け直すと、購読者に 2 回知らせてしまうので分ける
  useEffect(() => () => setGuard(id, null), [id]);
  useEffect(() => {
    setGuard(id, { dirty, busy });
  }, [id, dirty, busy]);

  // 覆いが外れた描画の後で、覚えたボタンにフォーカスを戻す(inert が外れた後でないと focus できない)。
  // 利用者が覆いの間に別の所へ動かしていた(body 以外にある)ときは奪わない
  useEffect(() => {
    if (overlay !== null) return;
    const el = focusTarget.current;
    focusTarget.current = null;
    if (!el?.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body) el.focus();
  }, [overlay]);

  const run = useCallback(
    async <T,>(task: BusyTask<T>): Promise<BusyOutcome<T>> => {
      if (!claimRun(running)) return { kind: "ignored" };
      // busy は実行権を取った時点(確認の間を含む)から true。store へは、描き直しを待たずにすぐ知らせる(離れる操作の確認が見るため)
      setBusy(true);
      setGuard(id, { dirty: dirtyRef.current, busy: true });
      let covered = false;
      try {
        return await runBusy<T>(
          {
            ...realClock,
            refresh: () => refreshRef.current(),
            seq: nextSeq,
            navStartedAfter,
            noteWriteSucceeded,
            showOverlay: () => {
              // 確認のモーダルが閉じた後の activeElement を覚える(押したボタンに戻っている)
              const active = document.activeElement;
              focusTarget.current = active instanceof HTMLElement && active !== document.body ? active : null;
              covered = true;
              setOverlay(task.label ?? DEFAULT_LABEL);
            },
          },
          task,
        );
      } finally {
        releaseRun(running);
        // 消えた範囲の guard を付け直さない(外した後に付けると、誰も消さない dirty が残る)
        if (mounted.current) {
          setBusy(false);
          setGuard(id, { dirty: dirtyRef.current, busy: false });
        }
        if (covered) setOverlay(null);
      }
    },
    [id],
  );

  const value = useMemo<BusyContextValue>(() => ({ busy, run }), [busy, run]);

  return (
    <BusyContext.Provider value={value}>
      <div className={styles.scope}>
        <div className={className} inert={overlay !== null} aria-busy={overlay !== null ? true : undefined}>
          {children}
        </div>
        {overlay !== null && (
          <div className={styles.overlay}>
            <div className={styles.box} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              {overlay}
            </div>
          </div>
        )}
      </div>
    </BusyContext.Provider>
  );
}

/** BusyScope の中で使う。run で書き込みを 1 回実行する(実行中の二度目は { kind: "ignored" }) */
export function useBusyAction(): BusyContextValue {
  const ctx = useContext(BusyContext);
  if (!ctx) throw new Error("useBusyAction は BusyScope の中で使う");
  return ctx;
}
