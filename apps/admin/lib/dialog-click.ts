/**
 * 確認のモーダル(components/ui/ConfirmDialog.tsx)を開いた直後のクリックの無視(B173 第 2 段 Task 2。第 1 段の最終レビューの台帳 106)。
 *
 * ダブルクリックの 1 回目で確認が開くと、2 回目のクリックが確認の背面(= キャンセル)やボタン(= 確定)の上に落ちて、
 * 利用者が読む前に閉じたり実行したりしてしまう。開いてから DIALOG_CLICK_GUARD_MS の間は、マウス・タッチのクリックを無視する。
 * キーボードの押下(Enter・Space。click イベントの detail が 0)は、押す前にフォーカスを合わせているので無視しない
 */
export const DIALOG_CLICK_GUARD_MS = 500;

/** openedAt = 開いた時点の時計(dialogNow())。開く前は null / pointer = マウス・タッチのクリックか(e.detail > 0) */
export function ignoreDialogClick(input: { openedAt: number | null; now: number; pointer: boolean }): boolean {
  const { openedAt, now, pointer } = input;
  if (openedAt === null || !pointer) return false;
  return now - openedAt < DIALOG_CLICK_GUARD_MS;
}

/** 開いた時点とクリックの時点を測る時計。イベントと effect の中だけで読む(描画の中で時刻を読まない。test/hydration-guard.test.ts) */
export function dialogNow(): number {
  return performance.now();
}

/**
 * 確認のモーダルの effect の 1 回分の判定(開く・閉じる・時計の取り直し・フォーカス)。
 * - 閉じた要素を開く: 時計を取り直す。初めて開くとき(neverOpened)か覆いの間でないときは、初期のフォーカス(キャンセル側)へ
 *   (覆いの間の開き直しは中が inert なので動かさない)
 * - 開いたまま別の確認に替わった(requestKey が変わった。待ち行列から次の確認が出た・差し替え): 時計を取り直し、初期のフォーカスへ
 *   (前の確認の 0.5 秒の判定・フォーカスを持ち越さない)
 * - 開いたまま覆いが外れた(hold.fail): 確定のボタンへフォーカスを戻す(キーボードでもう一度押せるように)
 * - 開いている要素を閉じる
 */
export function dialogEffectStep(input: {
  open: boolean;
  elementOpen: boolean;
  busy: boolean;
  wasBusy: boolean;
  keyChanged: boolean;
  neverOpened: boolean;
}): { show: boolean; close: boolean; restartClock: boolean; focus: "initial" | "confirm" | null } {
  const { open, elementOpen, busy, wasBusy, keyChanged, neverOpened } = input;
  if (!open) return { show: false, close: elementOpen, restartClock: false, focus: null };
  if (!elementOpen) return { show: true, close: false, restartClock: true, focus: neverOpened || keyChanged || !busy ? "initial" : null };
  if (keyChanged) return { show: false, close: false, restartClock: true, focus: busy ? null : "initial" };
  if (wasBusy && !busy) return { show: false, close: false, restartClock: false, focus: "confirm" };
  return { show: false, close: false, restartClock: false, focus: null };
}
