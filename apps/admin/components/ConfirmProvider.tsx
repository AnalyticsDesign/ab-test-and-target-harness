"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  cancelCurrent,
  confirmCurrent,
  emptyQueue,
  enqueue,
  failHold,
  finishCurrent,
  onConfirmOwnerReleased,
  releaseAll,
  releaseOwner,
  type ConfirmPhase,
  type ConfirmQueue,
} from "@/lib/confirm-queue";
import { ConfirmDialog, type ConfirmOption } from "./ui/ConfirmDialog";
import { useBusyScopeId } from "./ui/BusyScope";

/**
 * 確認のモーダルを 1 つだけ置き、どの画面からも `const ask = useConfirm(); if (!(await ask({...}))) return;` で使う(backlog B45)。
 * ブラウザ標準の confirm() は管理画面の見た目・テーマと合わないので使わない(test/hydration-guard.test.ts が止める)
 *
 * B173 第 2 段 Task 2:
 * - useConfirmHold() の askHold: 確定を押してもダイアログを閉じず、busyLabel で中を覆って `{ confirmed: true, hold }` で解く。
 *   呼び出し元は書き込みの後に hold.close() で閉じる。失敗なら hold.fail(error) で覆いを外して中に失敗を出し、開いたまま
 *   (返る Promise は、もう一度の確定で true(また覆う)、取り消しで false)。書き込みそのもの(上限・実行権)は呼び出し元の BusyScope の run が持つ
 * - 持ち続ける間(覆い・失敗の表示)に来たほかの確認は、閉じるまで待たせてから開く。それ以外は今までどおり、開いている確認を取り消して差し替える
 * - 確認は呼んだ BusyScope(useBusyScopeId)を持ち主にする。持ち主の範囲が unmount したら、その持ち主の表示中の確認を閉じ、
 *   待たせている要求を外し、未解決の Promise を取り消し(ask は false、askHold は { confirmed: false }、hold.fail は false)で解く。
 *   待ち行列の判定は lib/confirm-queue.ts
 */
export type ConfirmOptions = {
  title: string;
  /** 何が起きるか(取り消せるか・誰に影響するか)を 1〜2 文で */
  body?: ReactNode;
  /** 実行のボタンの文言(「失効する」「外す」など、操作を動詞で) */
  confirmLabel: string;
  tone?: "danger" | "primary";
  /** 取りやめのボタンの文言(既定は「キャンセル」。離れる前の確認の「とどまる」など) */
  cancelLabel?: string;
  /** 取りやめのボタンを主ボタンの色にする(「戻って控える」のように、取りやめが勧める側のとき) */
  emphasizeCancel?: boolean;
  /** true なら confirmLabel のボタン 1 つだけを出す(知らせるだけの確認。Esc と背面のクリックは今のまま取りやめ = false) */
  single?: boolean;
  /** 本文の下に出すチェックボックス(既定はオフ。B46 K12)。チェックの有無は useConfirmWithOption() で受け取る */
  option?: ConfirmOption;
};
type ConfirmResult = { confirmed: boolean; optionChecked: boolean };
type Ask = (options: ConfirmOptions) => Promise<boolean>;
type AskWithOption = (options: ConfirmOptions & { option: ConfirmOption }) => Promise<ConfirmResult>;

/** askHold の確定の後に呼び出し元が持つ口。close = 閉じる / fail = 失敗を中に出して開いたまま(もう一度の確定で true、取り消しで false) */
export type ConfirmHold = { close(): void; fail(error: string): Promise<boolean> };
export type ConfirmHoldResult = { confirmed: false } | { confirmed: true; hold: ConfirmHold };
type AskHold = (options: ConfirmOptions & { busyLabel: string }) => Promise<ConfirmHoldResult>;

/** 待ち行列の 1 件。pending = 今待っている Promise の解き方と、取り消しで解く値(解いたら null) */
type Entry = {
  /** 確認ごとの番号(ConfirmDialog の requestKey。開いたまま次の確認に替わったとき、チェック・0.5 秒の時計・フォーカスを取り直す) */
  id: number;
  owner: string | null;
  hold: boolean;
  options: ConfirmOptions & { busyLabel?: string };
  pending: { resolve: (value: never) => void; cancelValue: unknown } | null;
  /** hold.fail で出す失敗の文 */
  error: string | null;
};
type View = { entry: Entry; phase: ConfirmPhase; error: string | null } | null;

let nextEntryId = 0;
const CANCELLED: ConfirmResult = { confirmed: false, optionChecked: false };

type ContextValue = {
  open(options: ConfirmOptions, owner: string | null): Promise<ConfirmResult>;
  openHold(options: ConfirmOptions & { busyLabel: string }, owner: string | null): Promise<ConfirmHoldResult>;
};
const ConfirmContext = createContext<ContextValue | null>(null);

/** 待っている Promise を value で解く(1 回だけ) */
function resolvePending(entry: Entry, value: unknown): void {
  const p = entry.pending;
  entry.pending = null;
  (p?.resolve as ((v: unknown) => void) | undefined)?.(value);
}
const settleCancelled = (entries: Entry[]) => {
  for (const e of entries) resolvePending(e, e.pending?.cancelValue);
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queue = useRef<ConfirmQueue<Entry>>(emptyQueue());
  const [view, setView] = useState<View>(null);
  /** 待ち行列を替え、表示をそろえる。取り消されたものは取り消しの値で解く */
  const apply = useCallback((next: ConfirmQueue<Entry>, cancelled: Entry[] = []) => {
    queue.current = next;
    const cur = next.current;
    setView(cur ? { entry: cur.req, phase: cur.phase, error: cur.phase === "failed" ? cur.req.error : null } : null);
    settleCancelled(cancelled);
  }, []);

  // ページを移動したら、開いている確認も待たせている確認もキャンセル扱いで閉じる(Provider は root layout にあり移動で消えないため。
  // 開いたまま戻る / 進むで移ると、移動前の画面の操作を新しい画面の上で実行してしまう)
  const pathname = usePathname();
  useEffect(() => {
    const q = queue.current;
    if (!q.current && q.waiting.length === 0) return;
    const r = releaseAll(q);
    apply(r.queue, r.cancelled);
  }, [pathname, apply]);

  // 持ち主の範囲(BusyScope)が unmount したら、その持ち主の確認を片付ける(呼び出し元が close も fail も呼ばずに消えたときも同じ道)
  useEffect(
    () =>
      onConfirmOwnerReleased((owner) => {
        const r = releaseOwner(queue.current, owner);
        if (r.cancelled.length > 0) apply(r.queue, r.cancelled);
      }),
    [apply],
  );

  const push = useCallback(
    (entry: Entry) => {
      const r = enqueue(queue.current, entry);
      apply(r.queue, r.cancelled);
    },
    [apply],
  );

  const [value] = useState<ContextValue>(() => ({
    open: (options, owner) =>
      new Promise<ConfirmResult>((resolve) => {
        push({ id: ++nextEntryId, owner, hold: false, options, pending: { resolve: resolve as (v: never) => void, cancelValue: CANCELLED }, error: null });
      }),
    openHold: (options, owner) =>
      new Promise<ConfirmHoldResult>((resolve) => {
        push({ id: ++nextEntryId, owner, hold: true, options, pending: { resolve: resolve as (v: never) => void, cancelValue: { confirmed: false } }, error: null });
      }),
  }));
  // value は最初の描画で 1 度だけ作る。push は apply にしか依らず安定しているので、最初のものを使ってよい

  /** entry が今の表示か(閉じた後・差し替えられた後の close / fail を何もしないため) */
  const isCurrent = (entry: Entry) => queue.current.current?.req === entry;

  const holdFor = (entry: Entry): ConfirmHold => ({
    close: () => {
      if (!isCurrent(entry)) return;
      resolvePending(entry, false);
      apply(finishCurrent(queue.current));
    },
    fail: (error) => {
      if (!isCurrent(entry) || queue.current.current?.phase !== "holding") return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        entry.error = error;
        entry.pending = { resolve: resolve as (v: never) => void, cancelValue: false };
        apply(failHold(queue.current));
      });
    },
  });

  const onConfirm = (optionChecked: boolean) => {
    const cur = queue.current.current;
    if (!cur) return;
    const r = confirmCurrent(queue.current);
    if (r.ignored) return;
    const entry = cur.req;
    if (r.held) {
      // 初めての確定は { confirmed: true, hold } で、失敗の後のもう一度の確定は fail() の Promise を true で解く
      const first = cur.phase === "shown";
      entry.error = null;
      apply(r.queue);
      resolvePending(entry, first ? { confirmed: true, hold: holdFor(entry) } : true);
      return;
    }
    apply(r.queue);
    resolvePending(entry, { confirmed: true, optionChecked });
  };
  const onCancel = () => {
    const r = cancelCurrent(queue.current);
    if (r.cancelled.length > 0) apply(r.queue, r.cancelled);
  };

  const current = view?.entry.options;
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={view !== null}
        requestKey={view?.entry.id}
        title={current?.title ?? ""}
        confirmLabel={current?.confirmLabel ?? ""}
        tone={current?.tone ?? "danger"}
        cancelLabel={current?.cancelLabel}
        emphasizeCancel={current?.emphasizeCancel}
        single={current?.single}
        option={current?.option}
        busyLabel={view?.phase === "holding" ? (current?.busyLabel ?? null) : null}
        error={view?.error ?? null}
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        {current?.body ? typeof current.body === "string" ? <p>{current.body}</p> : <div>{current.body}</div> : null}
      </ConfirmDialog>
    </ConfirmContext.Provider>
  );
}

function useConfirmContext(): ContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm は ConfirmProvider の中で使う(app/layout.tsx)");
  return ctx;
}

/** 実行したかだけを返す(今までどおり)。囲んでいる BusyScope を持ち主にする */
export function useConfirm(): Ask {
  const ctx = useConfirmContext();
  const owner = useBusyScopeId();
  return useCallback<Ask>(async (options) => (await ctx.open(options, owner)).confirmed, [ctx, owner]);
}

/** チェックボックスを 1 つ足した確認(B46 K12)。実行したかと、チェックを入れたかを返す */
export function useConfirmWithOption(): AskWithOption {
  const ctx = useConfirmContext();
  const owner = useBusyScopeId();
  return useCallback<AskWithOption>((options) => ctx.open(options, owner), [ctx, owner]);
}

/**
 * 確定の後も開いたまま、書き込みを待つ確認(B173 第 2 段)。BusyScope の run の confirm の中で使い、書き込みの後に hold.close()、
 * 失敗なら hold.fail(error) を呼ぶ。持ち主の BusyScope が消えたら、閉じて取り消し(false)で解く
 */
export function useConfirmHold(): AskHold {
  const ctx = useConfirmContext();
  const owner = useBusyScopeId();
  return useCallback<AskHold>((options) => ctx.openHold(options, owner), [ctx, owner]);
}
