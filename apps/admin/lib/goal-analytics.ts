import type { Goal } from "./types";

/** 目標の保存済みの目標名の指定(無ければ空 = 指定なし = ab_goal_name は目標 ID) */
export function goalNameOf(analytics: Goal["analytics"] | undefined): string {
  return analytics?.overrides?.goalName ?? "";
}

/**
 * B77(Task 10): 目標の作成・PATCH に載せる `analytics` の部分。
 * - 名前を入れた → `{ overrides: { goalName } }`
 * - 空にして、保存済みに指定があった → `analytics: null`(上書きを消す。control の PATCH は null で消す)
 * - 空で、保存済みにも指定が無い → 何も載せない(未設定のまま。余計な書き込みをしない)
 */
export function goalAnalyticsBody(goalName: string, saved: Goal["analytics"] | undefined): { analytics?: Goal["analytics"] } {
  if (goalName !== "") return { analytics: { overrides: { goalName } } };
  return goalNameOf(saved) !== "" ? { analytics: null } : {};
}
