"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ConfirmDialog, type ConfirmOption } from "./ui/ConfirmDialog";

/**
 * 確認のモーダルを 1 つだけ置き、どの画面からも `const ask = useConfirm(); if (!(await ask({...}))) return;` で使う(backlog B45)。
 * ブラウザ標準の confirm() は管理画面の見た目・テーマと合わないので使わない(test/hydration-guard.test.ts が止める)
 */
export type ConfirmOptions = {
  title: string;
  /** 何が起きるか(取り消せるか・誰に影響するか)を 1〜2 文で */
  body?: ReactNode;
  /** 実行のボタンの文言(「失効する」「外す」など、操作を動詞で) */
  confirmLabel: string;
  tone?: "danger" | "primary";
  /** 本文の下に出すチェックボックス(既定はオフ。B46 K12)。チェックの有無は useConfirmWithOption() で受け取る */
  option?: ConfirmOption;
};
type ConfirmResult = { confirmed: boolean; optionChecked: boolean };
type Ask = (options: ConfirmOptions) => Promise<boolean>;
type AskWithOption = (options: ConfirmOptions & { option: ConfirmOption }) => Promise<ConfirmResult>;
type Open = (options: ConfirmOptions) => Promise<ConfirmResult>;

const CANCELLED: ConfirmResult = { confirmed: false, optionChecked: false };
const ConfirmContext = createContext<Open | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((result: ConfirmResult) => void) | null>(null);
  const settle = useCallback((result: ConfirmResult) => {
    resolver.current?.(result);
    resolver.current = null;
    setCurrent(null);
  }, []);
  // ページを移動したら、開いている確認はキャンセル扱いで閉じる(Provider は root layout にあり移動で消えないため。
  // 開いたまま戻る / 進むで移ると、移動前の画面の操作を新しい画面の上で実行してしまう)
  const pathname = usePathname();
  useEffect(() => {
    if (resolver.current) settle(CANCELLED);
  }, [pathname, settle]);
  const open = useCallback<Open>(
    (options) =>
      new Promise<ConfirmResult>((resolve) => {
        resolver.current?.(CANCELLED); // 開いている確認があれば、それはキャンセル扱いで閉じる
        resolver.current = resolve;
        setCurrent(options);
      }),
    [],
  );
  return (
    <ConfirmContext.Provider value={open}>
      {children}
      <ConfirmDialog
        open={current !== null}
        title={current?.title ?? ""}
        confirmLabel={current?.confirmLabel ?? ""}
        tone={current?.tone ?? "danger"}
        option={current?.option}
        onConfirm={(optionChecked) => settle({ confirmed: true, optionChecked })}
        onCancel={() => settle(CANCELLED)}
      >
        {current?.body ? typeof current.body === "string" ? <p>{current.body}</p> : <div>{current.body}</div> : null}
      </ConfirmDialog>
    </ConfirmContext.Provider>
  );
}

function useOpenConfirm(): Open {
  const open = useContext(ConfirmContext);
  if (!open) throw new Error("useConfirm は ConfirmProvider の中で使う(app/layout.tsx)");
  return open;
}

/** 実行したかだけを返す(今までどおり) */
export function useConfirm(): Ask {
  const open = useOpenConfirm();
  return useCallback<Ask>(async (options) => (await open(options)).confirmed, [open]);
}

/** チェックボックスを 1 つ足した確認(B46 K12)。実行したかと、チェックを入れたかを返す */
export function useConfirmWithOption(): AskWithOption {
  return useOpenConfirm();
}
