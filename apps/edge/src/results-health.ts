import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * 収集の失敗の記録(D9 ② K11・設計書 §6.7)。Site ごとの SQLite の DO(`idFromName(siteId)`)。
 * 計測用 D1 への書き込みが失敗した送信(予算の DO に届かず書けなかった送信も含む)を、run × UTC の時(1 時間)で数える。
 * D1 とは別の場所で数えるのは、D1 の日次の上限に達したときにも失敗を数えるため。
 *
 * - DO(ResultsHealth): 表 `counts(run_id, hour, failed)`。RPC は `add`(加算)と `read`(範囲の読み取り。control が使う)
 * - isolate(HealthBuffer): メモリで合算し、DO を呼ぶのは「数えたものがある Site」について 1 分に 1 回まで。
 *   失敗が集中しても DO の呼び出しは isolate の数 × Site 数 × 1 分に 1 回で頭打ちになる(Free の DO の上限と両立させるため)
 *
 * タイマー(setTimeout・alarm)は使わず、hibernation できる形にする(ResultsBudget と同じ)。
 * 400 日の掃除も 60 秒の間隔も、すべて呼び出しの引数と `Date.now()` で遅れて判定する
 */

const HOUR_MS = 3_600_000;
/** `counts` を残す日数。③ の結果の記録が写すまで、テストの最長の期間より十分長く残す */
const KEEP_DAYS = 400;
/** isolate が同じ Site について DO を呼ぶ最短の間隔 */
const FLUSH_INTERVAL_MS = 60_000;

export type HealthRow = { runId: string; hour: number; failed: number };

/** `hour` = UTC の時の先頭の epoch ミリ秒 */
export const hourOf = (ms: number): number => ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);

/**
 * DO の SQL。DO の SQLite は読み書きした行数で課金されるので、行数が増えない形にする:
 * - 加算は upsert 1 文。すでにある `(run_id, hour)` は `failed` だけを書き換える(索引の列は変わらないので索引は書かれない)
 * - 範囲の読み取りは主キー `(run_id, hour)` の範囲だけをなめる
 * - 400 日の掃除は `hour` だけの条件なので主キー(2 列目)では引けない。専用の索引 `counts_hour` を持ち、
 *   add のたびに 1 回「古い行があるか」を索引で見る(消す行が無ければ読む行は 0〜1)。表の全走査は無い。
 *   索引を足す代償は、新しい `(run_id, hour)` を入れるときの索引の書き込み 1 行(run × 時ごとに 1 回)
 */
export const HEALTH_SQL = {
  table: `CREATE TABLE IF NOT EXISTS counts (run_id TEXT NOT NULL, hour INTEGER NOT NULL, failed INTEGER NOT NULL, PRIMARY KEY (run_id, hour))`,
  index: `CREATE INDEX IF NOT EXISTS counts_hour ON counts (hour)`,
  upsert: `INSERT INTO counts (run_id, hour, failed) VALUES (?1, ?2, ?3) ON CONFLICT (run_id, hour) DO UPDATE SET failed = failed + excluded.failed`,
  prune: `DELETE FROM counts WHERE hour < ?1`,
  read: `SELECT hour, failed FROM counts WHERE run_id = ?1 AND hour >= ?2 AND hour < ?3 ORDER BY hour`,
} as const;

function assertRow(row: HealthRow): void {
  if (!row || typeof row.runId !== "string" || row.runId === "") throw new TypeError("invalid runId");
  if (!Number.isSafeInteger(row.hour) || row.hour % HOUR_MS !== 0) throw new TypeError(`invalid hour: ${row.hour}`);
  if (!Number.isSafeInteger(row.failed) || row.failed < 1) throw new TypeError(`invalid failed: ${row.failed}`);
}

export class ResultsHealth extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(HEALTH_SQL.table);
    this.sql.exec(HEALTH_SQL.index);
  }

  /**
   * 失敗の回数を加算する。壊れた行が 1 つでもあれば、何も書かずに TypeError で拒否する(途中まで書かない)。
   * 同じ `(run_id, hour)` は呼び出しの中で先に合算してから upsert するので、書き込みは異なるキーの数だけになる
   */
  async add(rows: HealthRow[]): Promise<void> {
    if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
    rows.forEach(assertRow);
    const merged = new Map<string, HealthRow>();
    for (const r of rows) {
      const key = `${r.runId}\u0000${r.hour}`;
      const prev = merged.get(key);
      if (prev) prev.failed += r.failed;
      else merged.set(key, { runId: r.runId, hour: r.hour, failed: r.failed });
    }
    this.ctx.storage.transactionSync(() => {
      for (const r of merged.values()) this.sql.exec(HEALTH_SQL.upsert, r.runId, r.hour, r.failed);
      // 400 日より古い行を消す(タイマーは使わず、add の呼び出しのたびに遅れて掃除する)
      this.sql.exec(HEALTH_SQL.prune, hourOf(Date.now() - KEEP_DAYS * 24 * HOUR_MS));
    });
  }

  /** run の `[fromHour, toHour)` の時ごとの失敗の回数(時の昇順。失敗の無い時は含めない) */
  async read(runId: string, fromHour: number, toHour: number): Promise<Array<{ hour: number; failed: number }>> {
    if (typeof runId !== "string") throw new TypeError("invalid runId");
    if (!Number.isFinite(fromHour) || !Number.isFinite(toHour)) throw new TypeError("invalid range");
    return this.sql.exec<{ hour: number; failed: number }>(HEALTH_SQL.read, runId, fromHour, toHour).toArray();
  }
}

/**
 * Site ごとの失敗の記録の DO(K11)。binding が無い(古い wrangler.jsonc のまま deploy した)ときは throw し、
 * HealthBuffer はその失敗を捨てる(数えられないだけで、リクエストの経路は止めない)
 */
export function healthStub(env: Env, siteId: string): DurableObjectStub<ResultsHealth> {
  const ns = env.RESULTS_HEALTH;
  if (!ns) throw new Error("RESULTS_HEALTH binding is missing");
  return ns.get(ns.idFromName(siteId));
}

export type HealthDeps = {
  /** DO の add。throw は「届かなかった」として捨てる */
  add(env: Env, siteId: string, rows: HealthRow[]): Promise<void>;
};

export type HealthBuffer = {
  /** 失敗を 1 つ数える(同期・throw しない)。runId が空・now が数でないときは何もしない */
  count(siteId: string, runId: string, now: number): void;
  /**
   * 前回の flush から 60 秒以上たった Site(まだ flush していない Site も対象)のうち、数えたものがある Site を DO に送る。
   * 送るものが無ければ null。あれば Promise(呼び出し側が `ctx.waitUntil` に渡す。reject しない)。
   * 送る分はここでバッファから外す。送信に失敗した分は捨てる(再送しない)
   */
  flushIfDue(env: Env, now: number): Promise<void> | null;
};

type SiteBuffer = {
  /** runId → hour → 回数 */
  runs: Map<string, Map<number, number>>;
  lastFlushAt: number | null;
};

export function createHealthBuffer(deps: HealthDeps = { add: (env, siteId, rows) => healthStub(env, siteId).add(rows) }): HealthBuffer {
  const sites = new Map<string, SiteBuffer>();

  const take = (site: SiteBuffer): HealthRow[] => {
    const rows: HealthRow[] = [];
    for (const [runId, hours] of site.runs) for (const [hour, failed] of hours) rows.push({ runId, hour, failed });
    site.runs = new Map();
    return rows;
  };

  return {
    count(siteId, runId, now) {
      if (typeof runId !== "string" || runId === "" || !Number.isFinite(now)) return;
      let site = sites.get(siteId);
      if (!site) sites.set(siteId, (site = { runs: new Map(), lastFlushAt: null }));
      let hours = site.runs.get(runId);
      if (!hours) site.runs.set(runId, (hours = new Map()));
      const hour = hourOf(now);
      hours.set(hour, (hours.get(hour) ?? 0) + 1);
    },

    flushIfDue(env, now) {
      const sends: Array<Promise<void>> = [];
      for (const [siteId, site] of sites) {
        if (site.runs.size === 0) continue; // 数えたものが無ければ時計も進めない(最初の失敗はすぐ送れる)
        if (site.lastFlushAt !== null && now - site.lastFlushAt < FLUSH_INTERVAL_MS) continue;
        site.lastFlushAt = now;
        const rows = take(site);
        // 失敗(binding が無い・DO に届かない)は捨てる。同期の throw も拾うため async の中で呼ぶ
        sends.push((async () => deps.add(env, siteId, rows))().catch(() => {}));
      }
      return sends.length === 0 ? null : Promise.all(sends).then(() => undefined);
    },
  };
}

let shared: HealthBuffer | null = null;

/** isolate に 1 つの HealthBuffer */
export function healthBuffer(): HealthBuffer {
  return (shared ??= createHealthBuffer());
}

/** テストで isolate の作り直しを再現する */
export function resetHealthBufferForTest(): void {
  shared = null;
}
