import type { Env } from "../env";

/**
 * D9 ③(plan ③ の K13、設計書 §6.9): 計測用 D1(wtt-results)の読み取りの予約。
 * 外側(結果の API・終了・Cron の 1 件・purgeRun)が openRead で予算の DO に見込みの行数を予約し、中の関数には ReadSession を渡す。
 * 中の関数は自分で reserveRead を呼ばない(予約は導入全体で同時に 1 つなので、入れ子にすると自分の予約に断られる)。
 *
 * - batch: env.RESULTS_DB.batch をそのまま呼び、各結果の meta.rows_read を足す
 * - close: 足した rows_read で 1 回だけ settleRead する(何度呼んでもよい。finally で必ず呼ぶ)。
 *   精算に失敗しても投げない(予約は 60 秒で解け、見込みを使ったまま = 安全側。読んだ結果は捨てない)
 */
export type ReadSession = { batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>; close(): Promise<void> };

/**
 * 予約が断られたら `{ refused }`(budget = その日の読み取りの予算が足りない / busy = ほかの再計算・削除が予約を持っている)。
 * 計測用 D1 か予算の DO の binding が無いときは投げる(呼び出し側が resultsStore(env) と binding で先に分ける)
 */
export async function openRead(env: Env, day: string, estimate: number, now: number): Promise<ReadSession | { refused: "budget" | "busy" }> {
  const db = env.RESULTS_DB;
  const ns = env.RESULTS_BUDGET;
  if (!db || !ns) throw new Error("openRead: RESULTS_DB or RESULTS_BUDGET binding is missing");
  const budget = ns.get(ns.idFromName("global"));
  // DO の reserveRead は 1 以上の整数だけを受ける
  const rows = Math.max(1, Math.ceil(Number.isFinite(estimate) ? estimate : 1));
  const r = await budget.reserveRead(day, rows, now);
  if (!r.ok) return { refused: r.reason };
  const token = r.token;
  let rowsRead = 0;
  let closed = false;
  return {
    async batch(stmts) {
      if (closed) throw new Error("read session is closed");
      const out = await db.batch(stmts);
      for (const res of out) rowsRead += res.meta?.rows_read ?? 0;
      return out;
    },
    async close() {
      // 精算の前に印を立てる(同時に 2 回呼ばれても settleRead は 1 回)
      if (closed) return;
      closed = true;
      try {
        await budget.settleRead(token, rowsRead);
      } catch (e) {
        console.error("settleRead failed (the reservation expires by itself)", e);
      }
    },
  };
}

/** 前回の読み取り行数も人数も無いときの見込み */
const DEFAULT_READ_ESTIMATE = 10_000;

/** 保存した速報の人数の合計(読めなければ null) */
function cachedParticipants(resultJson: string): number | null {
  try {
    const variants = (JSON.parse(resultJson) as { variants?: Array<{ n?: unknown }> }).variants;
    if (!Array.isArray(variants) || variants.length === 0) return null;
    let n = 0;
    for (const v of variants) {
      if (typeof v.n !== "number" || !Number.isFinite(v.n)) return null;
      n += v.n;
    }
    return n;
  } catch {
    return null;
  }
}

/**
 * 読み取りの見込み(K13)= 前回までに測った rows_read(保存した速報)、無ければ前回までに数えた参加者数 × (2 + ほかの目標の数)、
 * どちらも無ければ 10,000 行
 */
export function readEstimate(cache: { rows_read: number; result_json: string } | undefined, otherGoals: number): number {
  if (cache && cache.rows_read > 0) return cache.rows_read;
  const n = cache ? cachedParticipants(cache.result_json) : null;
  if (n !== null && n > 0) return n * (2 + otherGoals);
  return DEFAULT_READ_ESTIMATE;
}
