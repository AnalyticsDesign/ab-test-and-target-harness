"use client";
import { useCallback } from "react";
import { useConfirm } from "@/components/ConfirmProvider";
import { getSnapshot } from "@/lib/feedback-store";

/**
 * 状態の変更(開始・一時停止・再開・終了)の前の確かめ(B173 第 1 段)。どこかの節に未保存の変更があれば、
 * 「先に保存してください」だけの確認(ボタンは「閉じる」1 つ)を出して false を返す。無ければ true。
 * 状態の変更は保存済みの値で走るので、未保存の入力があるまま始めると、利用者が見ている値と違うものが配信・固定されるため。
 * 未保存の印は押した時点の store の値を読む(購読しない: 入力のたびに状態のボタンを描き直さないため)
 */
export function useStatusChangeGuard(): () => Promise<boolean> {
  const ask = useConfirm();
  return useCallback(async () => {
    if (!getSnapshot().dirty) return true;
    await ask({ title: "保存していない変更があります", body: "先に保存してください", confirmLabel: "閉じる", tone: "primary", single: true });
    return false;
  }, [ask]);
}
