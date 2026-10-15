/**
 * backlog D10(brief K15): Cloudflare の上限と込み量。API で取れないので、ここ 1 か所に持つ。
 * 確認日 2026-10-05。出典:
 * - https://developers.cloudflare.com/workers/platform/pricing/ (Workers / DO / D1 / KV の Free の日次と Paid の月の込み量)
 * - https://developers.cloudflare.com/workers/platform/limits/ (Free の日次はアカウント単位・UTC 0 時にリセット)
 * - https://developers.cloudflare.com/d1/platform/limits/ (D1 の 1 DB の上限 Free 500 MB / Paid 10 GB)
 * 値を変えるときは確認日と docs/operations.md の表も直す。GB = 10^9 バイト
 */
export const RESOURCE_IDS = [
  "workers_requests",
  "do_requests",
  "do_rows_read",
  "do_rows_written",
  "d1_rows_read",
  "d1_rows_written",
  "kv_reads",
  "kv_writes",
  "kv_deletes",
  "kv_lists",
  "d1_storage",
  "d1_largest_db",
  "do_storage",
  "kv_storage",
] as const;
export type ResourceId = (typeof RESOURCE_IDS)[number];

const MB = 1_000_000;
const GB = 1_000_000_000;

/** 日次の資源: Free の日次上限と、Paid の月の込み量(Paid の目安 = 込み量 ÷ 30) */
export const DAILY: Partial<Record<ResourceId, { freeDaily: number; paidMonthly: number }>> = {
  workers_requests: { freeDaily: 100_000, paidMonthly: 10_000_000 },
  do_requests: { freeDaily: 100_000, paidMonthly: 1_000_000 },
  do_rows_read: { freeDaily: 5_000_000, paidMonthly: 25_000_000_000 },
  do_rows_written: { freeDaily: 100_000, paidMonthly: 50_000_000 },
  d1_rows_read: { freeDaily: 5_000_000, paidMonthly: 25_000_000_000 },
  d1_rows_written: { freeDaily: 100_000, paidMonthly: 50_000_000 },
  kv_reads: { freeDaily: 100_000, paidMonthly: 10_000_000 },
  kv_writes: { freeDaily: 1_000, paidMonthly: 1_000_000 },
  kv_deletes: { freeDaily: 1_000, paidMonthly: 1_000_000 },
  kv_lists: { freeDaily: 1_000, paidMonthly: 1_000_000 },
};

/**
 * 容量: limit = 超えると止まる上限 / reference = アカウント合計の込み量で、超えても**その超過を理由には**止まらず課金される(Paid)。
 * Durable Objects の 1 オブジェクト 10 GB などオブジェクトごとの上限は判定の対象外。
 * d1_largest_db は本製品の DB(AB_USAGE_RESOURCES.d1)の中の最大で判定する。設定が空、または設定した ID がどの DB とも一致しないなら判定しない(plan K22 / 最終レビュー finding 3)
 */
type Cap = { kind: "limit" | "reference"; value: number };
export const CAPACITY: Partial<Record<ResourceId, { free: Cap; paid: Cap }>> = {
  d1_storage: { free: { kind: "limit", value: 5 * GB }, paid: { kind: "reference", value: 5 * GB } },
  d1_largest_db: { free: { kind: "limit", value: 500 * MB }, paid: { kind: "limit", value: 10 * GB } },
  do_storage: { free: { kind: "limit", value: 5 * GB }, paid: { kind: "reference", value: 5 * GB } },
  kv_storage: { free: { kind: "limit", value: 1 * GB }, paid: { kind: "reference", value: 1 * GB } },
};

/** Paid の 1 日の目安 = 月の込み量 ÷ 30(請求の周期の日数は Billing Read なしでは分からないので固定。31 日の月は安全側) */
export const PAID_REFERENCE_DAYS = 30;
/** K12: 判定のしきい値 */
export const WARNING_RATIO = 0.7;
export const CRITICAL_RATIO = 0.9;
/** K12: 予測を出し始める経過時間(UTC 0 時のリセット直後は外れやすい) */
export const PROJECTION_MIN_ELAPSED_MS = 3_600_000;
