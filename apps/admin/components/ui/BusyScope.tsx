"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { navStartedAfter, nextSeq, noteWriteSucceeded, setGuard, type LeavePrompt } from "@/lib/feedback-store";
import { claimRun, createNavWaiter, realClock, releaseRun, runBusy, type BusyOutcome, type BusyTask } from "@/lib/run-busy";
import { useRefreshAndWait } from "@/lib/use-refresh-and-wait";
import { releaseConfirmOwner } from "@/lib/confirm-queue";
import { ErrorBox } from "@/components/ErrorBox";
import { NAV_TIMEOUT_MESSAGE } from "./RouteLoading";
import styles from "./BusyScope.module.css";

export { claimRun, releaseRun, runBusy };
export type { BusyOutcome, BusyTask };

const DEFAULT_LABEL = "保存中…";

type BusyContextValue = {
  /** 範囲の id(useBusyScopeId で読む) */
  id: string;
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
 * `dirty` は呼び出し元が持つ未保存の印。ページを離れる前の確認が見る。
 * 第 2 段: after: "navigate" の間は、自分の登録を外して(releaseGuard)移動の終わりまで覆い続ける。store の遷移を始めない移動
 * (reloadDocument・外の URL)が 10 秒で終わらなければ、打ち切りの文言を範囲の中に出す(NavGate はその移動を知らないため)。
 * `prompt` は未保存とは別の離れる前の確認の種類(issuedKey = 発行したキーを控えていない)。登録に載せるだけで、文言は PageLeaveGuard が選ぶ
 */
export function BusyScope({
  id,
  dirty = false,
  prompt,
  children,
  className,
}: {
  id: string;
  dirty?: boolean;
  prompt?: LeavePrompt;
  children: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(null);
  /** 実行権。state にしない(同じ tick の二度目の呼び出しでも、描き直しを待たずに止めるため) */
  const running = useRef(false);
  const dirtyRef = useRef(dirty);
  const promptRef = useRef(prompt);
  const mounted = useRef(true);
  /** 覆う前に押されていたボタン。覆いを外したらここへフォーカスを戻す */
  const focusTarget = useRef<HTMLElement | null>(null);
  const refreshAndWait = useRefreshAndWait();
  // useRefreshAndWait は router が変わると別の関数を返す。run を安定させるため、最新を ref で読む
  const refreshRef = useRef(refreshAndWait);
  /** after: "navigate" の間、登録を外している(dirty の変化の effect が登録し直さないように) */
  const released = useRef(false);
  /** store の遷移を始めない移動が 10 秒で終わらなかった */
  const [navTimedOut, setNavTimedOut] = useState(false);
  /** 移動の待ち。unmount で購読・タイマーを外す(作るのは最初の描画の 1 回だけ) */
  const waiterRef = useRef<ReturnType<typeof createNavWaiter> | null>(null);
  waiterRef.current ??= createNavWaiter(() => {
    if (mounted.current) setNavTimedOut(true);
  });

  useEffect(() => {
    dirtyRef.current = dirty;
    promptRef.current = prompt;
    refreshRef.current = refreshAndWait;
  });

  useEffect(() => {
    // StrictMode は effect を cleanup してからもう一度走らせるので、走らせるたびに true に戻す
    mounted.current = true;
    return () => {
      mounted.current = false;
      waiterRef.current?.dispose();
    };
  }, []);

  // 節ごとの状態の登録。外すのは id ごと(unmount・id の変更)。dirty / busy の変化のたびに外して付け直すと、購読者に 2 回知らせてしまうので分ける
  // unmount では、この範囲を持ち主にする確認(useConfirm・useConfirmHold)も片付ける(ConfirmProvider が閉じて取り消しで解く。lib/confirm-queue.ts)
  useEffect(
    () => () => {
      setGuard(id, null);
      releaseConfirmOwner(id);
    },
    [id],
  );
  useEffect(() => {
    if (released.current) return;
    setGuard(id, { dirty, busy, prompt });
  }, [id, dirty, busy, prompt]);

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
      setNavTimedOut(false);
      // busy は実行権を取った時点(確認の間を含む)から true。store へは、描き直しを待たずにすぐ知らせる(離れる操作の確認が見るため)
      setBusy(true);
      setGuard(id, { dirty: dirtyRef.current, busy: true, prompt: promptRef.current });
      let covered = false;
      try {
        return await runBusy<T>(
          {
            ...realClock,
            refresh: () => refreshRef.current(),
            seq: nextSeq,
            navStartedAfter,
            noteWriteSucceeded,
            alive: () => mounted.current,
            releaseGuard: () => {
              // 自分の登録だけを外す(ほかの範囲の未保存・保存中の確認はそのまま)。離脱の listener は event のたびに最新の store を読む
              // (useLeaveGuard の shouldGuard)ので、外した直後の location.assign も止めない
              released.current = true;
              setGuard(id, null);
              return () => {
                released.current = false;
                if (mounted.current) setGuard(id, { dirty: dirtyRef.current, busy: running.current, prompt: promptRef.current });
              };
            },
            waitNav: (h) => waiterRef.current!.waitNav(h),
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
          setGuard(id, { dirty: dirtyRef.current, busy: false, prompt: promptRef.current });
        }
        if (covered) setOverlay(null);
      }
    },
    [id],
  );

  const value = useMemo<BusyContextValue>(() => ({ id, busy, run }), [id, busy, run]);

  return (
    <BusyContext.Provider value={value}>
      <div className={styles.scope}>
        {navTimedOut ? <ErrorBox message={NAV_TIMEOUT_MESSAGE} /> : null}
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

/** 囲んでいる BusyScope の id。外なら null(確認のダイアログを開いた範囲に結びつけるため) */
export function useBusyScopeId(): string | null {
  return useContext(BusyContext)?.id ?? null;
}
