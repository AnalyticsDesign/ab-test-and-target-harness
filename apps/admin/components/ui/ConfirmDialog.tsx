"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { dialogCloseEvent } from "@/lib/dialog-close";
import { dialogEffectStep, dialogNow, ignoreDialogClick } from "@/lib/dialog-click";
import { ErrorBox } from "@/components/ErrorBox";
import styles from "./ConfirmDialog.module.css";

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
 * 開いてから 0.5 秒の間は、マウス・タッチのクリック(背面・確定・取り消し)を無視する(ダブルクリックの 2 回目で閉じたり実行したりしない。
 * lib/dialog-click.ts。キーボードの押下は無視しない。B173 第 2 段)。
 * busyLabel = 書き込みを待つ間の覆いの文言(null 以外のとき、中を inert にして回る印と文言を出し、Esc・背面のクリックでも閉じない)。
 * error = 本文の下に出す失敗(書き込みが失敗して開いたまま、もう一度の確定を待つとき)。
 * 普段は useConfirm()(components/ConfirmProvider.tsx)から使う。画面に固有の確認はこれを直接使う
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
  requestKey,
  busyLabel = null,
  error = null,
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
  /** 確認ごとの鍵(ConfirmProvider の待ち行列の 1 件ごと)。開いたまま変わったら、チェック・0.5 秒の時計・初期のフォーカスを取り直す */
  requestKey?: number;
  /** 書き込みを待つ間の覆いの文言(「開始中…」など)。null 以外の間は中を押せず、Esc・背面のクリックでも閉じない */
  busyLabel?: string | null;
  /** 本文の下に出す失敗の文(ErrorBox) */
  error?: string | null;
  onConfirm: (optionChecked: boolean) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [checked, setChecked] = useState(false);
  // 開いたときにオフに戻す(描画中に前回の open と比べて直す。effect の中で setState しない)
  // 開いたまま別の確認に替わった(requestKey)ときもオフに戻す
  const [wasOpen, setWasOpen] = useState(open);
  const [seenKey, setSeenKey] = useState(requestKey);
  if (open !== wasOpen || requestKey !== seenKey) {
    setWasOpen(open);
    setSeenKey(requestKey);
    if (open) setChecked(false);
  }
  // 自分で呼んだ close() のうち、close イベントがまだ届いていない数(onClose で古いイベントを見分ける。lib/dialog-close.ts)
  const selfClosePending = useRef(0);
  /** showModal() の時点の時計(開いた直後のクリックの無視。lib/dialog-click.ts)。閉じている間は null */
  const openedAt = useRef<number | null>(null);
  const busy = busyLabel !== null;
  const show = (d: HTMLDialogElement) => {
    d.showModal();
    openedAt.current = dialogNow();
  };
  /** 前回の effect の時点の鍵と覆い(開いたまま別の確認に替わった・覆いが外れたを見分ける) */
  const lastKey = useRef(requestKey);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const step = dialogEffectStep({
      open,
      elementOpen: d.open,
      busy,
      wasBusy: wasBusy.current,
      keyChanged: lastKey.current !== requestKey,
      neverOpened: openedAt.current === null,
    });
    lastKey.current = requestKey;
    wasBusy.current = busy;
    if (step.show) show(d);
    else if (step.restartClock) openedAt.current = dialogNow();
    if (step.focus === "initial") (cancel.current ?? confirm.current)?.focus();
    if (step.focus === "confirm") confirm.current?.focus();
    if (step.close) {
      selfClosePending.current += 1;
      d.close();
    }
    if (!open) openedAt.current = null;
  }, [open, busy, requestKey]);
  /** マウス・タッチのクリックで、開いてから 0.5 秒の間なら true(キーボードの押下は detail が 0) */
  const ignored = (e: { detail: number }) => ignoreDialogClick({ openedAt: openedAt.current, now: dialogNow(), pointer: e.detail > 0 });
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
        const wasOutside = downOutside.current;
        downOutside.current = false;
        if (busy || !dismissOnBackdrop || !wasOutside || !outside(e)) return;
        if (ignored(e)) return;
        onCancel();
      }}
      onCancel={(e) => {
        e.preventDefault();
        // 覆いの間は Esc で閉じない(書き込みの結果を待つ)
        if (!busy) onCancel();
      }}
      // 保険: cancel を経ずにブラウザ側で閉じられたら(実装の差など)、React の状態もキャンセルとしてそろえる。
      // ボタンや Esc で閉じた後は open が false になってから effect が close() する。そのイベントは自分の close() の分として無視する。
      // close イベントは close() の後のタスクで届くので、閉じた直後に次の確認を開くと(「とどまる」の直後の戻るなど。B173 第 1 段)、
      // 前の close() のイベントが次の確認の open=true の後(showModal() の前のこともある)に届く。DOM の今の open では見分けられないので、
      // 自分の close() の数で見分けて、次の確認を取り消さない(最終レビュー FR-Medium-3)
      onClose={(e) => {
        const d = e.currentTarget;
        const r = dialogCloseEvent({ open, elementOpen: d.open, selfClosePending: selfClosePending.current, holding: busy });
        selfClosePending.current = r.selfClosePending;
        // 覆いの間にブラウザが閉じた(続けて押した 2 回目の Esc など)ときは、取り消さずに開き直す
        if (r.reopen) {
          if (!d.open) show(d);
          return;
        }
        if (r.cancel) onCancel();
      }}
    >
      <div inert={busy} aria-busy={busy ? true : undefined}>
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
        <ErrorBox message={error} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {single ? null : (
            <button
              ref={cancel}
              type="button"
              className={emphasizeCancel ? "btn btn-primary" : "btn"}
              onClick={(e) => {
                if (ignored(e)) return;
                onCancel();
              }}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirm}
            type="button"
            className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"}
            disabled={confirmDisabled}
            onClick={(e) => {
              if (ignored(e)) return;
              onConfirm(checked);
            }}
          >
            {checked && option?.checkedConfirmLabel ? option.checkedConfirmLabel : confirmLabel}
          </button>
        </div>
      </div>
      {/* 覆いは中身(inert)の外に置く(inert の中だと支援技術に「…中」が届かない。BusyScope と同じ) */}
      {busy ? (
        <div className={styles.overlay}>
          <div className={styles.box} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            {busyLabel}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
