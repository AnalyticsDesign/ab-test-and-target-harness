import type { ReadSession } from "./read-session";

/**
 * D9 ③(plan ③ の K13、設計書 §7.1): 計測用 D1(wtt-results)の個票の集計。1 回の batch で、判定に使う目標のパターンごと・端末別・
 * ほかの目標のパターンごと・cutoff までの CV の行の数を読む。読み取りは渡された read だけ(予約は呼び出し元が持つ)。
 *
 * 時刻の範囲(観測窓 until_end): 参加は exposed_at <= cutoff、CV は exposed_at <= converted_at <= cutoff(参加と同じミリ秒の CV を含む)。
 * 混在・回復は mixed_at / recovered_at <= cutoff のものだけ、適用の失敗は「参加の時点で失敗、または failed_at <= cutoff」で
 * cutoff の時点で回復していない人
 */

/** パターンごとの数(判定に使う目標) */
export type VariantCounts = { variantId: string; n: number; y: number; mixed: number; applyFailed: number; applyRecovered: number };
/** 端末別・ほかの目標の数 */
export type DeviceCounts = { variantId: string; device: "desktop" | "mobile" | "tablet"; n: number; y: number };
export type GoalCounts = { variantId: string; n: number; y: number };

export type Aggregate = {
  primary: VariantCounts[];
  byDevice: DeviceCounts[];
  others: Record<string, GoalCounts[]>;
  /** cutoff までに保存できた個票の行(参加者 + CV の行。CV はすべての目標)。収集できなかった送信の割合の分母 */
  recordedRows: number;
  /** この集計の batch の rows_read の合計 */
  rowsRead: number;
};

// 設計書 §7.1 の SQL(?1 = run_id、?2 = goal_id、?3 = cutoff)
const PRIMARY_SQL = `SELECT p.variant_id,
       COUNT(*)                                        AS n,
       COUNT(c.visitor_key)                            AS y,
       SUM(p.mixed = 1 AND p.mixed_at <= ?3)           AS mixed,
       SUM((p.applied = 'failed' OR (p.applied = 'recovered' AND p.recovered_at > ?3))
           AND (p.failed_at IS NULL OR p.failed_at <= ?3))  AS apply_failed,
       SUM(p.applied = 'recovered' AND p.recovered_at <= ?3) AS apply_recovered
FROM participants p
LEFT JOIN conversions c
  ON c.run_id = p.run_id AND c.visitor_key = p.visitor_key AND c.goal_id = ?2
 AND c.converted_at >= p.exposed_at AND c.converted_at <= ?3
WHERE p.run_id = ?1 AND p.exposed_at <= ?3
GROUP BY p.variant_id`;

/** 端末別(判定に使う目標)。同じ形で GROUP BY に端末を足す */
const DEVICE_SQL = `SELECT p.variant_id, p.device, COUNT(*) AS n, COUNT(c.visitor_key) AS y
FROM participants p
LEFT JOIN conversions c
  ON c.run_id = p.run_id AND c.visitor_key = p.visitor_key AND c.goal_id = ?2
 AND c.converted_at >= p.exposed_at AND c.converted_at <= ?3
WHERE p.run_id = ?1 AND p.exposed_at <= ?3
GROUP BY p.variant_id, p.device`;

/** ほかの目標(goal_id を変えて同じ形。判定しないので人数と CV だけ) */
const GOAL_SQL = `SELECT p.variant_id, COUNT(*) AS n, COUNT(c.visitor_key) AS y
FROM participants p
LEFT JOIN conversions c
  ON c.run_id = p.run_id AND c.visitor_key = p.visitor_key AND c.goal_id = ?2
 AND c.converted_at >= p.exposed_at AND c.converted_at <= ?3
WHERE p.run_id = ?1 AND p.exposed_at <= ?3
GROUP BY p.variant_id`;

/** cutoff までに保存できた CV の行(目標を問わない。参加者の行は判定に使う目標の集計の n の合計) */
const CONVERSION_ROWS_SQL = "SELECT COUNT(*) AS rows FROM conversions WHERE run_id = ?1 AND converted_at <= ?2";

/** SUM(…) は条件が NULL の行だけのとき NULL になる(mixed_at が NULL など)。0 として数える */
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 集計する。goalIds.primary が null(判定に使う目標を選ばずに記録を始めた run)なら、判定に使う目標の CV は 0 として人数だけを数える。
 * rdb は statement を作るためだけに使う(読むのは read.batch)
 */
export async function aggregate(
  read: ReadSession,
  runId: string,
  goalIds: { primary: string | null; others: string[] },
  cutoff: number,
  rdb: D1Database,
): Promise<Aggregate> {
  const primaryGoal = goalIds.primary ?? "";
  const stmts = [
    rdb.prepare(PRIMARY_SQL).bind(runId, primaryGoal, cutoff),
    rdb.prepare(DEVICE_SQL).bind(runId, primaryGoal, cutoff),
    rdb.prepare(CONVERSION_ROWS_SQL).bind(runId, cutoff),
    ...goalIds.others.map((g) => rdb.prepare(GOAL_SQL).bind(runId, g, cutoff)),
  ];
  const results = await read.batch(stmts);
  const rowsOf = (i: number) => (results[i]?.results ?? []) as Array<Record<string, unknown>>;

  const primary = rowsOf(0).map((r) => ({
    variantId: String(r.variant_id),
    n: num(r.n),
    y: num(r.y),
    mixed: num(r.mixed),
    applyFailed: num(r.apply_failed),
    applyRecovered: num(r.apply_recovered),
  }));
  const byDevice = rowsOf(1).map((r) => ({ variantId: String(r.variant_id), device: String(r.device) as DeviceCounts["device"], n: num(r.n), y: num(r.y) }));
  const conversionRows = num(rowsOf(2)[0]?.rows);
  const others: Record<string, GoalCounts[]> = {};
  goalIds.others.forEach((g, i) => {
    others[g] = rowsOf(3 + i).map((r) => ({ variantId: String(r.variant_id), n: num(r.n), y: num(r.y) }));
  });
  const participantRows = primary.reduce((s, v) => s + v.n, 0);
  const rowsRead = results.reduce((s, r) => s + (r.meta?.rows_read ?? 0), 0);
  return { primary, byDevice, others, recordedRows: participantRows + conversionRows, rowsRead };
}
