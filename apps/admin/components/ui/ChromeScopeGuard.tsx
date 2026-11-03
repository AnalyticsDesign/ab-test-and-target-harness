"use client";
import { useMemo, type ReactNode } from "react";
import { useFeedbackSelector } from "@/lib/use-feedback";
import { selectScopeSkeleton } from "@/lib/feedback-store";
import styles from "./TopBar.module.css";

/**
 * 上部バーを、見せる状態の遷移の行き先と照らす(B173 第 1 段)。TopBar(サーバー部品)が中で上部バーを包む。
 * 遷移の行き先の範囲(ワークスペース・サイト。lib/feedback-store.ts の targetScope)が、上部バーを描いた範囲(scope)と違えば、
 * 押してから 150 ms を過ぎた後は中身を出さず、上部バーと同じ高さの空の帯を出す。届くまで前の画面が残る経路(loading.tsx の無い画面)で、
 * 上部バーに前のサイト・ワークスペースの名前と公開のリンクが出たままにしないため。行き先の画面が描かれて遷移が終わると中身に戻る。
 * scope: サイトの画面は { wid, sid }、ワークスペースの画面は { wid, sid: null }、ホームと個人の画面(/w・/w/me/*)は両方 null
 */
export function ChromeScopeGuard({ scope, children }: { scope: { wid: string | null; sid: string | null }; children: ReactNode }) {
  // 選ぶ関数は scope が変わったときだけ作り直す(描くたびに作っても値は基本の値なので描き直しは増えないが、購読の取り直しを避ける)
  const select = useMemo(() => selectScopeSkeleton({ wid: scope.wid, sid: scope.sid }), [scope.wid, scope.sid]);
  const skeleton = useFeedbackSelector(select);
  if (!skeleton) return <>{children}</>;
  return <div className={styles.bar} aria-hidden="true" data-testid="topbar-skeleton" />;
}
