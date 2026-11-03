import { useSyncExternalStore } from "react";
import { SERVER_SNAPSHOT, getSnapshot, subscribe, type FeedbackSnapshot } from "./feedback-store";

/**
 * フィードバック store(`lib/feedback-store.ts`)の値を選んで読む hook。
 * select は基本の値(boolean・string・number・null)だけを返す: 関わりの無い更新(別のリンクの遷移など)では値が変わらず、描き直さない。
 * スナップショット全体を返す hook は、全部の更新で描き直すことになるので作らない
 */
export function useFeedbackSelector<T extends boolean | string | number | null>(select: (s: FeedbackSnapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(getSnapshot()),
    () => select(SERVER_SNAPSHOT),
  );
}
