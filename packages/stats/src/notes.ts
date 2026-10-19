// 注記の鍵。結果の画面・API・記録は鍵と params だけを持ち、文言は admin が付ける。
// verdict が出すのは品質・最低件数・重み 0・A/A・基準の注記だけで、そのほかの鍵(速報・記録・
// テスト中の変更など)は control が足す。

export const NOTE_KEYS = [
  "interim",
  "interim_stale",
  "aa_test",
  "baseline_not_original",
  "stopped_early",
  "min_count_not_met",
  "apply_failures",
  "collection_failures",
  "collection_stops",
  "quality_blocked_srm",
  "quality_blocked_mixed",
  "quality_blocked_stops",
  "test_changes",
  "plan_changes",
  "purged",
  "not_recorded",
  "store_missing",
  "definition_missing",
  "edited_after_evaluation",
  "unpublished_changes",
  "zero_weight",
] as const;

export type NoteKey = (typeof NOTE_KEYS)[number];

/**
 * 注記。params は鍵ごとに決まっている(割合は 0〜1 の小数、時刻は UTC のミリ秒、時間は時間):
 *   interim { evaluationAt } / interim_stale { reason: "budget" | "busy"; computedAt } /
 *   stopped_early { evaluationAt; stoppedAt } / min_count_not_met { variantId } /
 *   apply_failures { variantId; rate } / collection_failures { ratio; failedSends } /
 *   collection_stops { ratio; hours; limit } / quality_blocked_srm { p } / quality_blocked_mixed { rate } /
 *   quality_blocked_stops { ratio; limit } / test_changes { count } / plan_changes { count } / purged { days } /
 *   edited_after_evaluation { variantId } / unpublished_changes { variantId } / zero_weight { variantId }
 *   ほか(aa_test・baseline_not_original・not_recorded・store_missing・definition_missing)は params なし
 */
export type Note = { key: NoteKey; params?: Record<string, string | number> };
