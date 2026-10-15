"use client";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * キーを控えずに移動しようとしたときの確認(決定 54 (11))。共通の確認モーダル(B45)を使う。
 * 初期のフォーカス = 「戻って控える」。Esc(cancel)= 戻る
 */
export function LeaveKeyDialog({ open, onStay, onLeave }: { open: boolean; onStay: () => void; onLeave: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      title="キーをまだ控えていません"
      confirmLabel="移動する"
      cancelLabel="戻って控える"
      emphasizeCancel
      onConfirm={onLeave}
      onCancel={onStay}
    >
      <p>移動すると、このキーは二度と表示できません。控えずに移動した場合は、一覧からこのキーを失効させて、発行し直してください。</p>
    </ConfirmDialog>
  );
}
