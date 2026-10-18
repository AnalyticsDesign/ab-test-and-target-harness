import { DurableObject } from "cloudflare:workers";
import { RESULTS_BUDGET_DEFAULTS, nextUtcMidnight, utcDay } from "@wtt/core";
import type { Env } from "./env";

/**
 * 結果の収集の日次の予算(D9 ② K10・設計書 §6.9)。導入全体で 1 つの SQLite の DO(`idFromName("global")`)。
 * D1 の日次の上限はアカウントで分け合うので Site ごとに分けない。
 *
 * - 書き込み: edge の isolate(results-lease.ts の LeaseHolder)が書く前に行の枠をまとめて受け取る。
 *   配った枠は使ったものとして数え、戻さない(isolate が消えて使い残しても安全側。戻す口を作ると、
 *   戻した後に古い isolate が書き続けたときに予算を超える)
 * - 読み取り: control が速報の再計算の前に見込みの行数を予約する(導入全体で同時に 1 つ、60 秒で自動で解く)
 * - 停止: 予算が尽きた・D1 の上限・アカウントの使用量・容量で止めた時間帯を残し、control が結果に出す
 *
 * タイマー(setTimeout・alarm)は使わない。期限(読み取りの予約の 60 秒・停止の終わり・日付の変わり目)は、
 * すべて次の呼び出しの `now` で遅れて判定する。何も待っていない DO は hibernation できるので、DO の時間の課金が増えない。
 * 各 RPC は await を挟まない同期の SQL だけで書くので、1 つの呼び出しの中の読みと書きの間に別の呼び出しが割り込まない
 */

export type StopReason = "write_budget" | "d1_limit" | "account_usage" | "capacity";
export type LeaseResult = { ok: true; day: string; rows: number } | { ok: false; stoppedUntil: number };
export type ReadReservation = { ok: true; token: string; expiresAt: number } | { ok: false; reason: "budget" | "busy" };
export type StopPeriod = { reason: StopReason; from: number; to: number };
export type BudgetStatus = {
  day: string;
  writeBudget: number;
  writeUsed: number;
  readBudget: number;
  readUsed: number;
  leaseRows: number;
  /** 今かかっている停止の終わり(停止中でなければ null) */
  stoppedUntil: number | null;
  /** 解けていない読み取りの予約(期限切れ・精算済みは含めない) */
  readReservation: { day: string; rows: number; expiresAt: number } | null;
};
export type BudgetLimits = { writeRows: number; readRows: number; leaseRows: number };

const DAY_MS = 86_400_000;
const READ_RESERVATION_MS = 60_000;
/** `days`・`reservation` を残す日数(今日の分と遅れて届く精算に足りればよい) */
const KEEP_DAYS = 8;
/** `stops` を残す日数。③ の結果の記録(止めた期間)が写すまで残す */
const KEEP_STOP_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STOP_REASONS: readonly StopReason[] = ["write_budget", "d1_limit", "account_usage", "capacity"];

/**
 * `stops` を読む SQL。`stops` は 400 日分残るが、check・lease は LeaseHolder の数 × 1 分に 1 回呼ばれる。
 * DO の SQLite は読んだ行数で課金され(Free は 1 日 500 万行を VisitorProfile と分け合う)、表を毎回なめると
 * isolate 20 × 1,440 回 × 数百行で上限を超える。そこで索引 `stops_to_ms(to_ms, from_ms)` の範囲 `to_ms > now` から読み、
 * 終わった停止の行には触れない(test/results-budget.test.ts の索引のテストが行数と実行計画で固定する)
 */
export const STOPS_SQL = {
  index: `CREATE INDEX IF NOT EXISTS stops_to_ms ON stops (to_ms, from_ms)`,
  /** 今かかっている停止のうち、いちばん遅い終わり(?1 = now) */
  activeUntil: `SELECT MAX(to_ms) AS until FROM stops WHERE to_ms > ?1 AND from_ms <= ?1`,
  /** 同じ理由で続いている停止(?1 = now, ?2 = reason) */
  openOfReason: `SELECT id, to_ms FROM stops WHERE to_ms > ?1 AND from_ms <= ?1 AND reason = ?2 ORDER BY to_ms DESC LIMIT 1`,
  /** [?1, ?2) に重なる停止 */
  periods: `SELECT reason, from_ms, to_ms FROM stops WHERE to_ms > ?1 AND from_ms < ?2 ORDER BY from_ms, id`,
} as const;

/** 正の整数の文字列だけを採る。無い・壊れた値・"0" は既定値(設定の書き間違いで予算 0 や NaN にしない。収集を止めたいときは Site の設定で結果の記録を無効にする) */
function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** 予算の値(edge の vars。無ければ RESULTS_BUDGET_DEFAULTS)。LeaseHolder の枠の大きさも同じ値を使う */
export function budgetLimits(env: Pick<Env, "RESULTS_WRITE_BUDGET" | "RESULTS_READ_BUDGET" | "RESULTS_LEASE_ROWS">): BudgetLimits {
  return {
    writeRows: positiveInt(env.RESULTS_WRITE_BUDGET, RESULTS_BUDGET_DEFAULTS.writeRows),
    readRows: positiveInt(env.RESULTS_READ_BUDGET, RESULTS_BUDGET_DEFAULTS.readRows),
    leaseRows: positiveInt(env.RESULTS_LEASE_ROWS, RESULTS_BUDGET_DEFAULTS.leaseRows),
  };
}

function assertDay(day: string): void {
  if (typeof day !== "string" || !DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new TypeError(`invalid day: ${day}`);
}
function assertRows(rows: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(rows) || rows < (allowZero ? 0 : 1)) throw new TypeError(`invalid rows: ${rows}`);
}
function assertTime(ms: number): void {
  if (!Number.isFinite(ms)) throw new TypeError(`invalid time: ${ms}`);
}
/** その日の次の UTC 0 時(予算が尽きた停止の終わり) */
const dayEnd = (day: string): number => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

export class ResultsBudget extends DurableObject<Env> {
  private readonly limits: BudgetLimits;
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = budgetLimits(env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, write_used INTEGER NOT NULL DEFAULT 0, read_used INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stops (id INTEGER PRIMARY KEY, reason TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL)`);
    this.sql.exec(STOPS_SQL.index);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS reservation (token TEXT PRIMARY KEY, day TEXT NOT NULL, rows INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0)`,
    );
  }

  /**
   * 書き込みの枠を配る。停止中・予算が尽きていれば `ok: false`(停止の終わりまで呼ばないでよい)。
   * 残りが求めた行数より少なければ残りだけを配る。配り終えた時刻から次の UTC 0 時までを `write_budget` の停止として残す
   * (尽きた後は check も停止を返すので、枠を持っている isolate も最後の確認から 60 秒以内に止まる)
   */
  async lease(day: string, rows: number, now: number): Promise<LeaseResult> {
    assertDay(day);
    assertRows(rows, false);
    assertTime(now);
    const stoppedUntil = this.activeStopUntil(now);
    if (stoppedUntil !== null) return { ok: false, stoppedUntil };
    const used = this.ensureDay(day, now).write_used;
    const remaining = this.limits.writeRows - used;
    if (remaining <= 0) {
      // 予算を下げた設定で、すでに使った分が新しい予算を超えているとき(普段は配り終えた時点で停止が立っている)
      this.openStop("write_budget", dayEnd(day), now);
      return { ok: false, stoppedUntil: this.activeStopUntil(now) ?? dayEnd(day) };
    }
    const given = Math.min(rows, remaining);
    this.sql.exec(`UPDATE days SET write_used = write_used + ? WHERE day = ?`, given, day);
    if (given === remaining) this.openStop("write_budget", dayEnd(day), now);
    return { ok: true, day, rows: given };
  }

  /** 停止を立てる。同じ理由の停止が続いていれば延ばすだけ。停止は次の UTC 0 時で閉じる(翌日は新しい期間) */
  async stop(reason: StopReason, until: number, now: number): Promise<void> {
    if (!STOP_REASONS.includes(reason)) throw new TypeError(`invalid reason: ${reason}`);
    assertTime(until);
    assertTime(now);
    this.openStop(reason, until, now);
  }

  /** 停止中かどうかと、その終わりだけを返す。書き込みも枠の消費もしない(LeaseHolder が 60 秒ごとに呼ぶ) */
  async check(now: number): Promise<{ stoppedUntil: number | null }> {
    assertTime(now);
    return { stoppedUntil: this.activeStopUntil(now) };
  }

  /**
   * 読み取りの見込みの行数を予約する(導入全体で同時に 1 つ)。予約した時点で見込みをその日に使ったものとして数え、
   * settleRead で実際の行数に直す。60 秒を過ぎた予約は排他を解く(見込みは使ったまま。精算が届けば元の日だけ直す)
   */
  async reserveRead(day: string, rows: number, now: number): Promise<ReadReservation> {
    assertDay(day);
    assertRows(rows, false);
    assertTime(now);
    const busy = this.sql.exec(`SELECT 1 FROM reservation WHERE settled = 0 AND expires_at > ? LIMIT 1`, now).toArray();
    if (busy.length > 0) return { ok: false, reason: "busy" };
    const used = this.ensureDay(day, now).read_used;
    if (this.limits.readRows - used < rows) return { ok: false, reason: "budget" };
    const token = crypto.randomUUID();
    const expiresAt = now + READ_RESERVATION_MS;
    this.sql.exec(`UPDATE days SET read_used = read_used + ? WHERE day = ?`, rows, day);
    this.sql.exec(`INSERT INTO reservation (token, day, rows, expires_at) VALUES (?, ?, ?, ?)`, token, day, rows, expiresAt);
    return { ok: true, token, expiresAt };
  }

  /**
   * 読み取りの予約を実際の行数で精算する。予約した日(day)の使用量だけを直し、今の予約の排他や別の日には触れない。
   * 同じ token の 2 回目と知らない token は何もしない(control の再送で二重に引かない)
   */
  async settleRead(token: string, actualRows: number): Promise<void> {
    assertRows(actualRows, true);
    const r = this.sql.exec<{ day: string; rows: number }>(`SELECT day, rows FROM reservation WHERE token = ? AND settled = 0`, String(token)).toArray()[0];
    if (!r) return;
    this.sql.exec(`UPDATE reservation SET settled = 1 WHERE token = ?`, String(token));
    // 使用量が負にならないようにする(古い日の行が掃除済みなら UPDATE は 0 行で何もしない)
    this.sql.exec(`UPDATE days SET read_used = MAX(0, read_used + ?) WHERE day = ?`, actualRows - r.rows, r.day);
  }

  async status(now: number): Promise<BudgetStatus> {
    assertTime(now);
    const day = utcDay(now);
    const d = this.sql.exec<{ write_used: number; read_used: number }>(`SELECT write_used, read_used FROM days WHERE day = ?`, day).toArray()[0];
    const r = this.sql
      .exec<{ day: string; rows: number; expires_at: number }>(`SELECT day, rows, expires_at FROM reservation WHERE settled = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`, now)
      .toArray()[0];
    return {
      day,
      writeBudget: this.limits.writeRows,
      writeUsed: d?.write_used ?? 0,
      readBudget: this.limits.readRows,
      readUsed: d?.read_used ?? 0,
      leaseRows: this.limits.leaseRows,
      stoppedUntil: this.activeStopUntil(now),
      readReservation: r ? { day: r.day, rows: r.rows, expiresAt: r.expires_at } : null,
    };
  }

  /** [from, to) に重なる停止の期間(③ の結果の画面・記録が「収集を止めた期間」として読む) */
  async stopPeriods(from: number, to: number): Promise<StopPeriod[]> {
    assertTime(from);
    assertTime(to);
    return this.sql
      .exec<{ reason: StopReason; from_ms: number; to_ms: number }>(STOPS_SQL.periods, from, to)
      .toArray()
      .map((s) => ({ reason: s.reason, from: s.from_ms, to: s.to_ms }));
  }

  /** 今かかっている停止のうち、いちばん遅い終わり。停止中でなければ null */
  private activeStopUntil(now: number): number | null {
    const row = this.sql.exec<{ until: number | null }>(STOPS_SQL.activeUntil, now).toArray()[0];
    return row?.until ?? null;
  }

  /** 同じ理由の停止が続いていれば延ばし、無ければ now から始める。終わりは now の次の UTC 0 時を超えない */
  private openStop(reason: StopReason, until: number, now: number): void {
    const end = Math.min(until, nextUtcMidnight(now));
    if (end <= now) return;
    const cur = this.sql.exec<{ id: number; to_ms: number }>(STOPS_SQL.openOfReason, now, reason).toArray()[0];
    if (cur) {
      if (end > cur.to_ms) this.sql.exec(`UPDATE stops SET to_ms = ? WHERE id = ?`, end, cur.id);
      return;
    }
    this.sql.exec(`INSERT INTO stops (reason, from_ms, to_ms) VALUES (?, ?, ?)`, reason, now, end);
  }

  /**
   * その日の行を返す(無ければ作る)。新しい日の行を作るときだけ古い行を掃除する(1 日に 1 回程度。
   * 毎回の DELETE を避けて DO の SQLite の書き込み・読み取りの行数を増やさない)
   */
  private ensureDay(day: string, now: number): { write_used: number; read_used: number } {
    const d = this.sql.exec<{ write_used: number; read_used: number }>(`SELECT write_used, read_used FROM days WHERE day = ?`, day).toArray()[0];
    if (d) return d;
    this.sql.exec(`INSERT INTO days (day) VALUES (?)`, day);
    const keepFrom = utcDay(now - KEEP_DAYS * DAY_MS);
    this.sql.exec(`DELETE FROM days WHERE day < ?`, keepFrom);
    this.sql.exec(`DELETE FROM reservation WHERE day < ?`, keepFrom);
    this.sql.exec(`DELETE FROM stops WHERE to_ms < ?`, now - KEEP_STOP_DAYS * DAY_MS);
    return { write_used: 0, read_used: 0 };
  }
}

/**
 * 導入全体で 1 つの予算の DO(K10)。binding が無い(古い wrangler.jsonc のまま deploy した)ときは throw し、
 * LeaseHolder はそれを「届かない」として書かずに failed にする(fail-closed)
 */
export function budgetStub(env: Env): DurableObjectStub<ResultsBudget> {
  const ns = env.RESULTS_BUDGET;
  if (!ns) throw new Error("RESULTS_BUDGET binding is missing");
  return ns.get(ns.idFromName("global"));
}
