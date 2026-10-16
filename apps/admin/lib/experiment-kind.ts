import type { ExperimentKind } from "@wtt/core";

/** 決定 51・決定 54: 種別の画面の表記(API は test / single のまま) */
export const KIND_JA: Record<ExperimentKind, string> = { test: "テスト", single: "パーソナライズ" };
export const KIND_HINT: Record<ExperimentKind, string> = {
  test: "2 つ以上のパターンに訪問者を振り分けて比べます",
  single: "1 つのパターンを、条件に合う訪問者全員に表示します。振り分けや比較はしません",
};
export function createButtonLabel(kind: ExperimentKind): string {
  return kind === "single" ? "作成(パターン A を 1 つ用意します)" : "作成(パターン A / B を 50:50 で用意します)";
}
