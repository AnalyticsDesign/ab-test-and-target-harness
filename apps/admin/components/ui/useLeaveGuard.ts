"use client";
import { useEffect, useRef } from "react";
import { guardedHref, isLogoutSubmit } from "@/lib/leave-guard";

export type LeaveAttempt = { kind: "href"; href: string } | { kind: "logout"; form: HTMLFormElement };

/**
 * active の間、管理画面の中の移動(同じオリジンのリンクの普通のクリック・ログアウトの送信)を capture の段階で止めて onAttempt に渡し、
 * 再読み込み・タブを閉じるはブラウザ標準の beforeunload で確認する(文言は変えられない)。
 * document の capture は React の root より先に走るので、Next の Link の遷移より前に止まる。
 * 返す bypass() を呼ぶと、その後の移動(「移動する」を選んだ後)は止めない(beforeunload も二重に出さない)。
 * rearm() は bypass() の効き目を消す(移動が打ち切りで終わり、元の画面が残ったときに守りを付け直す。B173 第 1 段)。
 * ブラウザの戻る・進むは止めない(components/ui/PageLeaveGuard.tsx が lib/popstate-guard.ts で止める)。
 * shouldGuard を渡すと、event のたびにそれを呼び、false なら止めない(B173 第 2 段: active の変化が描き直しで listener を外すのを待たずに、
 * 最新の状態で決める。範囲が登録を外した直後の location.assign の beforeunload を止めないため)
 */
export function useLeaveGuard(
  active: boolean,
  onAttempt: (a: LeaveAttempt) => void,
  shouldGuard?: () => boolean,
): { bypass: () => void; rearm: () => void } {
  const skip = useRef(false);
  const handler = useRef(onAttempt);
  handler.current = onAttempt;
  const guardNow = useRef(shouldGuard);
  guardNow.current = shouldGuard;
  /** 今この event を止めるか */
  const pass = () => skip.current || guardNow.current?.() === false;
  useEffect(() => {
    if (!active) {
      skip.current = false;
      return;
    }
    const onClick = (e: MouseEvent) => {
      if (pass()) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = guardedHref(e, a ? { href: a.href, target: a.target, hasDownload: a.hasAttribute("download") } : null, window.location.origin);
      if (href === null) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current({ kind: "href", href });
    };
    const onSubmit = (e: SubmitEvent) => {
      if (pass()) return;
      const form = e.target as HTMLFormElement;
      if (!isLogoutSubmit(form.getAttribute("action"))) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current({ kind: "logout", form });
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pass()) return;
      e.preventDefault();
      e.returnValue = ""; // 古いブラウザは returnValue が必要
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active]);
  return { bypass: () => void (skip.current = true), rearm: () => void (skip.current = false) };
}
