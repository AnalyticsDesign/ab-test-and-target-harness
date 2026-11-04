"use client";
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConfirm, type ConfirmOptions } from "@/components/ConfirmProvider";
import { getSnapshot, leavePromptKind, markNavigationDispatched, normalizeUrl, startNavigation } from "@/lib/feedback-store";
import { currentUrl, navigateApp } from "@/lib/navigate";
import { popstateGuard, type PopstateBlock } from "@/lib/popstate-guard";
import { deferUntilRefreshed, isRefreshPending } from "@/lib/refresh-wait";
import { useFeedbackSelector } from "@/lib/use-feedback";
import { useLeaveGuard, type LeaveAttempt } from "./useLeaveGuard";

/** 未保存のまま離れる */
const UNSAVED = { title: "保存していない変更があります", body: "移動すると変更は失われます", confirmLabel: "移動する", cancelLabel: "とどまる", tone: "danger" } as const;
/** 保存の途中で離れる(書き込みの結果をこの画面では確かめられない) */
const SAVING = { title: "保存の途中です", body: "移動すると、保存できたかをこの画面では確かめられません", confirmLabel: "移動する", cancelLabel: "とどまる", tone: "primary" } as const;
/** 発行したキーを控えずに離れる(キーは二度と表示できない)。勧めるのは取りやめの側なので、「戻って控える」を強調し、初めのフォーカスもそちら */
const ISSUED_KEY = {
  title: "キーをまだ控えていません",
  body: "移動すると、このキーは二度と表示できません。控えずに移動した場合は、一覧からこのキーを失効させて、発行し直してください。",
  confirmLabel: "移動する",
  cancelLabel: "戻って控える",
  tone: "danger",
  emphasizeCancel: true,
} as const;

/** 確認の種類ごとの文言(B173 第 2 段) */
const PROMPTS: Record<NonNullable<ReturnType<typeof leavePromptKind>>, ConfirmOptions> = { saving: SAVING, issuedKey: ISSUED_KEY, unsaved: UNSAVED };

/** event の時点の store で、まだ確認が要るか */
function isGuardedNow(): boolean {
  return leavePromptKind(getSnapshot()) !== null;
}

/**
 * 離れる前の確認(B173 第 1 段)。app/w/layout.tsx に 1 つだけ置く。
 * どこかの節(BusyScope)に未保存の変更があるか・保存の途中か・未保存とは別の確認の種類(prompt。発行したキーを控えていない)を持つ間だけ、
 * リンク・ログアウト・再読み込み(useLeaveGuard)とブラウザの戻る・進む(lib/popstate-guard.ts)を止めて確認を出す。
 * 文言は 保存の途中 > prompt > 未保存 の順で選ぶ(feedback-store の leavePromptKind)。
 * 文言は止めた時点の store の値で選ぶ(描画の時点の値だと、保存が終わった直後の操作で古い文言になるため)
 */
export function PageLeaveGuard() {
  const router = useRouter();
  const ask = useConfirm();
  const active = useFeedbackSelector((s) => leavePromptKind(s) !== null);
  const timedOut = useFeedbackSelector((s) => s.nav?.timedOut === true);

  // onAttempt から最新の bypass・rearm を呼ぶための入れ物(useLeaveGuard の戻り値は描画ごとに作り直される)
  const guard = useRef<ReturnType<typeof useLeaveGuard> | null>(null);

  const confirmLeave = useCallback(async (): Promise<boolean> => {
    // 止めた後に状態が変わって種類が無くなっていても(すぐ後に保存が終わった等)、止めた移動には確認を出す(未保存の文言)
    return ask(PROMPTS[leavePromptKind(getSnapshot()) ?? "unsaved"]);
  }, [ask]);

  const onAttempt = useCallback(
    async (a: LeaveAttempt) => {
      if (!(await confirmLeave())) {
        if (a.kind === "logout") a.form.closest("details")?.removeAttribute("open");
        return;
      }
      guard.current?.bypass();
      // 押したリンクの回る印は出さない(key なし)。確認のダイアログの後なので、本文のスケルトンで足りる
      if (a.kind === "href") navigateApp(router, a.href);
      else a.form.requestSubmit();
    },
    [confirmLeave, router],
  );
  // 止めるかは event の時点の store で決める(範囲が after: "navigate" で自分の登録を外した直後の移動を止めないため。B173 第 2 段)
  guard.current = useLeaveGuard(active, (a) => void onAttempt(a), isGuardedNow);

  const onBlock = useCallback(
    async (b: PopstateBlock) => {
      if (!(await confirmLeave())) return; // 守りは付いたまま(とどまる)
      // 書き込みの結果を捨てられるよう遷移の始まりを知らせ、読み直しの反映の後に回す(lib/refresh-wait.ts。読み直しの途中の遷移は vinext に捨てられるため)
      const seq = startNavigation({ href: normalizeUrl(b.href), fromUrl: currentUrl(), key: null, deferred: isRefreshPending() });
      deferUntilRefreshed("navigation", () => {
        markNavigationDispatched(seq);
        popstateGuard()?.proceed(b.delta);
      });
    },
    [confirmLeave],
  );
  const onBlockRef = useRef(onBlock);
  onBlockRef.current = onBlock;

  // 戻る・進むの守り。vinext より後に読み込まれた文書では arm は何もしない(lib/popstate-guard.ts)
  useEffect(() => {
    if (!active) return;
    const g = popstateGuard();
    g?.arm((b) => void onBlockRef.current(b));
    return () => g?.disarm();
  }, [active]);

  // 「移動する」の後の遷移が打ち切りで終わり、まだ未保存・保存中なら守りを付け直す
  // (loading.tsx の無い画面では元の画面が残るので、次の移動もまた確認する)
  useEffect(() => {
    if (!timedOut || !active) return;
    guard.current?.rearm();
    popstateGuard()?.arm((b) => void onBlockRef.current(b));
  }, [timedOut, active]);

  return null;
}
