"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { dialogCloseEvent } from "@/lib/dialog-close";

/**
 * 本文の下に出すチェックボックス(B46 K12)。開くたびにオフから始まる。
 * checkedBody = チェックを入れたときに本文と差し替える注意(目立つ枠で出す。チェックの前の本文が押した結果と食い違うときに使う)。
 * checkedConfirmLabel = チェックを入れたときの実行のボタンの文言(押す動詞を結果に合わせる)
 */
export type ConfirmOption = { label: string; checkedBody?: ReactNode; checkedConfirmLabel?: string };

/**
 * 確認のモーダル(backlog B45)。<dialog> の showModal = 外側は押せない・フォーカスは中に閉じる・閉じると押したボタンへ戻る。
 * 画面の中央に出す。初期のフォーカス = キャンセル側(Enter の押し間違いで実行しない)。Esc と外(背面)のクリック = キャンセル。
 * single = 実行のボタン 1 つだけ(知らせるだけの確認。B173 第 1 段の状態の変更の前の確認)。初期のフォーカスはそのボタン
 * 入力欄を持つ確認をモーダルにするときは dismissOnBackdrop を false にする(外のクリックで書きかけが消えないように)。
 * 普段は useConfirm()(components/ConfirmProvider.tsx)から使う。画面に固有の確認(LeaveKeyDialog)はこれを直接使う
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "キャンセル",
  tone = "danger",
  emphasizeCancel = false,
  option,
  dismissOnBackdrop = true,
  confirmDisabled = false,
  single = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 実行のボタンの色。取り消せない操作は danger */
  tone?: "danger" | "primary";
  /** キャンセル側を主ボタンの色にする(「戻って控える」のように、キャンセルが勧める側のとき) */
  emphasizeCancel?: boolean;
  /** 本文の下に出すチェックボックス(B46 K12)。開くたびにオフから始まる */
  option?: ConfirmOption;
  /** 外(背面)のクリックで閉じるか。入力欄を持つモーダルは false(書きかけが消えないように)。Esc は閉じる */
  dismissOnBackdrop?: boolean;
  /** 実行のボタンを押せなくする(送信中など) */
  confirmDisabled?: boolean;
  /** 実行のボタン 1 つだけを出す(キャンセルのボタンを出さない。Esc と背面のクリックは onCancel のまま) */
  single?: boolean;
  onConfirm: (optionChecked: boolean) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [checked, setChecked] = useState(false);
  // 開いたときにオフに戻す(描画中に前回の open と比べて直す。effect の中で setState しない)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setChecked(false);
  }
  // 自分で呼んだ close() のうち、close イベントがまだ届いていない数(onClose で古いイベントを見分ける。lib/dialog-close.ts)
  const selfClosePending = useRef(0);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      (cancel.current ?? confirm.current)?.focus();
    }
    if (!open && d.open) {
      selfClosePending.current += 1;
      d.close();
    }
  }, [open]);
  // 外(背面)のクリック = キャンセル(Esc と同じ。どの確認もキャンセルが安全側)。背面を押すとイベントの target は
  // <dialog> そのものになる(余白を押しても同じ)ので、座標が枠の外かで見分ける。中で押し始めて外で離した
  // (文字の選択など)ときは閉じないよう、押し始めも外だったときだけにする
  const downOutside = useRef(false);
  const outside = (e: { target: EventTarget; clientX: number; clientY: number }) => {
    const d = ref.current;
    if (!d || e.target !== d) return false;
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={children || option?.checkedBody ? `${id}-desc` : undefined}
      className="dialog"
      onPointerDown={(e) => {
        downOutside.current = outside(e);
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && downOutside.current && outside(e)) onCancel();
        downOutside.current = false;
      }}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      // 保険: cancel を経ずにブラウザ側で閉じられたら(実装の差など)、React の状態もキャンセルとしてそろえる。
      // ボタンや Esc で閉じた後は open が false になってから effect が close() する。そのイベントは自分の close() の分として無視する。
      // close イベントは close() の後のタスクで届くので、閉じた直後に次の確認を開くと(「とどまる」の直後の戻るなど。B173 第 1 段)、
      // 前の close() のイベントが次の確認の open=true の後(showModal() の前のこともある)に届く。DOM の今の open では見分けられないので、
      // 自分の close() の数で見分けて、次の確認を取り消さない(最終レビュー FR-Medium-3)
      onClose={(e) => {
        const r = dialogCloseEvent({ open, elementOpen: e.currentTarget.open, selfClosePending: selfClosePending.current });
        selfClosePending.current = r.selfClosePending;
        if (r.cancel) onCancel();
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      {/* チェックを入れたら本文を注意に差し替える。aria-live は常にある外側に置き、差し替えを読み上げにも伝える */}
      {children || option?.checkedBody ? (
        <div id={`${id}-desc`} aria-live="polite">
          {checked && option?.checkedBody ? (
            <div className="confirm-warning" data-testid="confirm-option-warning">
              {option.checkedBody}
            </div>
          ) : (
            children
          )}
        </div>
      ) : null}
      {option ? (
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {option.label}
        </label>
      ) : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button ref={confirm} type="button" className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"} disabled={confirmDisabled} onClick={() => onConfirm(checked)}>
          {checked && option?.checkedConfirmLabel ? option.checkedConfirmLabel : confirmLabel}
        </button>
        {single ? null : (
          <button ref={cancel} type="button" className={emphasizeCancel ? "btn btn-primary" : "btn"} onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
      </div>
    </dialog>
  );
}
