import { matchesUrl, type CompiledConfig, type Goal } from "@wtt/core";

/**
 * spec §10.6 / 決定 37 (4): Goals 検知。PAGEVIEW は起動時に URL 条件へ照合して 1 回、CLICK は document への
 * 委譲 click リスナ 1 つ(capture)で `target.closest(selector)` を照合し一致のたびに発火。CUSTOM は AB.track。
 * runtime に重複排除の状態は持たない。戻り値の停止関数は revoke(§16)で呼び、再 grant で新世代として張り直す
 */
export function startGoalDetection(config: CompiledConfig, doc: Document, url: string, onGoal: (goal: Goal) => void): () => void {
  for (const g of config.goals) {
    if (g.type === "PAGEVIEW" && matchesUrl(url, g.config.page)) onGoal(g);
  }
  const clicks = config.goals.filter((g) => g.type === "CLICK");
  if (clicks.length === 0) return () => {};
  const handler = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    for (const g of clicks) {
      if (g.type !== "CLICK") continue;
      try {
        if (target.closest(g.config.selector)) onGoal(g);
      } catch {
        // 不正なセレクタは黙って無視(§10.7: 例外でサイトを壊さない)
      }
    }
  };
  doc.addEventListener("click", handler, true);
  return () => doc.removeEventListener("click", handler, true);
}
