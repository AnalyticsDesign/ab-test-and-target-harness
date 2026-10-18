import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RESULTS_BUDGET_DEFAULTS } from "@wtt/core";
import { STOPS_SQL, budgetLimits, budgetStub, type ResultsBudget } from "../src/results-budget";

// 予算の DO(K10・設計書 §6.9)。テストの予算は vitest.config.ts の miniflare.bindings で書き込み 1000 行にしてある
// (読み取り・枠は wrangler.jsonc の既定のまま)。DO はテストごとに別の名前で作り、状態を共有しない
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 16, 12); // 2026-10-16 12:00 UTC
const day = "2026-10-16";
const fresh = () => env.RESULTS_BUDGET!.get(env.RESULTS_BUDGET!.idFromName(crypto.randomUUID()));

describe("ResultsBudget.lease (K10)", () => {
  it("budget_lease_never_exceeds_budget", async () => {
    const stub = fresh();
    // 予算 1000・枠 200 のとき、5 回で 1000 を配り終え、6 回目は ok:false
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await stub.lease(day, 200, T0));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results.slice(0, 5).reduce((n, r) => n + (r.ok ? r.rows : 0), 0)).toBe(1000);
    expect(results[5]).toEqual({ ok: false, stoppedUntil: Date.UTC(2026, 9, 17) });
    expect((await stub.status(T0)).writeUsed).toBe(1000);
  });
  it("partial lease when the remainder is smaller than requested", async () => {
    const stub = fresh();
    expect(await stub.lease(day, 900, T0)).toEqual({ ok: true, day, rows: 900 });
    expect(await stub.lease(day, 200, T0)).toEqual({ ok: true, day, rows: 100 });
    expect((await stub.lease(day, 200, T0)).ok).toBe(false);
  });
  it("new UTC day resets the write budget", async () => {
    const stub = fresh();
    await stub.lease(day, 1000, T0);
    expect((await stub.lease(day, 1, T0)).ok).toBe(false);
    const next = Date.UTC(2026, 9, 17, 0, 0, 1);
    expect(await stub.lease("2026-10-17", 200, next)).toEqual({ ok: true, day: "2026-10-17", rows: 200 });
    expect((await stub.status(next)).writeUsed).toBe(200);
  });
  it("write_budget exhaustion records a stop period until next midnight", async () => {
    const stub = fresh();
    await stub.lease(day, 600, T0);
    const exhaustedAt = T0 + 5_000;
    expect(await stub.lease(day, 600, exhaustedAt)).toEqual({ ok: true, day, rows: 400 }); // ここで配り終える
    expect(await stub.lease(day, 200, T0 + 9_000)).toEqual({ ok: false, stoppedUntil: Date.UTC(2026, 9, 17) });
    expect(await stub.stopPeriods(T0, T0 + DAY)).toEqual([{ reason: "write_budget", from: exhaustedAt, to: Date.UTC(2026, 9, 17) }]);
    // 尽きた後の check は停止を返す(枠を持つ isolate も 60 秒以内に止まる)
    expect(await stub.check(T0 + 10_000)).toEqual({ stoppedUntil: Date.UTC(2026, 9, 17) });
  });
  it("stop() extends the same reason and keeps other reasons separate", async () => {
    const stub = fresh();
    const midnight = Date.UTC(2026, 9, 17);
    await stub.stop("account_usage", midnight - 3_600_000, T0);
    await stub.stop("account_usage", midnight, T0 + 60_000); // 続いている間の 2 回目は延ばすだけ
    await stub.stop("d1_limit", midnight, T0 + 120_000);
    expect(await stub.stopPeriods(T0, T0 + DAY)).toEqual([
      { reason: "account_usage", from: T0, to: midnight },
      { reason: "d1_limit", from: T0 + 120_000, to: midnight },
    ]);
    expect(await stub.check(T0 + 130_000)).toEqual({ stoppedUntil: midnight });
    expect(await stub.lease(day, 200, T0 + 130_000)).toEqual({ ok: false, stoppedUntil: midnight }); // 停止中は枠を配らない
    expect((await stub.status(T0 + 130_000)).writeUsed).toBe(0);
  });
  it("stop() closes at the next UTC midnight and a new day starts a new period", async () => {
    const stub = fresh();
    const midnight = Date.UTC(2026, 9, 17);
    await stub.stop("account_usage", midnight + DAY, T0); // 日付の変わり目で閉じる
    expect(await stub.check(midnight)).toEqual({ stoppedUntil: null });
    await stub.stop("account_usage", midnight + DAY, midnight + 1_000);
    expect(await stub.stopPeriods(T0, midnight + DAY)).toEqual([
      { reason: "account_usage", from: T0, to: midnight },
      { reason: "account_usage", from: midnight + 1_000, to: midnight + DAY },
    ]);
    expect(await stub.stopPeriods(midnight + DAY, midnight + 2 * DAY)).toEqual([]);
  });
});

describe("ResultsBudget の stops の読み方(DO の SQLite の読み取り行数)", () => {
  it("stop queries read only active rows through the to_ms index", async () => {
    await runInDurableObject(fresh(), async (instance, state) => {
      const budget = instance as ResultsBudget;
      const sql = state.storage.sql;
      const midnight = Date.UTC(2026, 9, 17);
      // 400 日分の終わった停止(1 日 2 件 = 800 行)を置き、今日の停止を 1 つ立てる
      for (let i = 1; i <= 800; i++) sql.exec(`INSERT INTO stops (reason, from_ms, to_ms) VALUES ('account_usage', ?, ?)`, T0 - i * (DAY / 2) - 1_000, T0 - i * (DAY / 2));
      await budget.stop("account_usage", midnight, T0);
      const cases: Array<[string, unknown[]]> = [
        [STOPS_SQL.activeUntil, [T0 + 1]],
        [STOPS_SQL.openOfReason, [T0 + 1, "account_usage"]],
        [STOPS_SQL.periods, [T0, T0 + DAY]],
      ];
      for (const [query, args] of cases) {
        const cursor = sql.exec(query, ...args);
        expect(cursor.toArray().length).toBeGreaterThan(0);
        expect(cursor.rowsRead).toBeLessThanOrEqual(2); // 終わった 800 行は読まない
        const plan = JSON.stringify(sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...args).toArray());
        expect(plan).toMatch(/USING (COVERING )?INDEX stops_to_ms/);
      }
      // RPC も同じ SQL を使う(結果が合う)
      expect(await budget.check(T0 + 1)).toEqual({ stoppedUntil: midnight });
      expect(await budget.stopPeriods(T0, T0 + DAY)).toEqual([{ reason: "account_usage", from: T0, to: midnight }]);
      expect(await budget.lease(day, 3, T0 + 1)).toEqual({ ok: false, stoppedUntil: midnight });
    });
  });
});

describe("ResultsBudget.reserveRead / settleRead (K10)", () => {
  it("reserveRead allows one reservation at a time and expires after 60s", async () => {
    const stub = fresh();
    const first = await stub.reserveRead(day, 1_000, T0);
    expect(first).toEqual({ ok: true, token: expect.any(String), expiresAt: T0 + 60_000 });
    expect(await stub.reserveRead(day, 1_000, T0 + 59_999)).toEqual({ ok: false, reason: "busy" });
    const third = await stub.reserveRead(day, 1_000, T0 + 60_000);
    expect(third.ok).toBe(true);
    // 期限切れの予約は見込みの行数をその日に使ったものとして数える
    expect((await stub.status(T0 + 60_000)).readUsed).toBe(2_000);
  });
  it("reserveRead refuses when the remaining read budget is smaller than the estimate", async () => {
    const stub = fresh();
    expect(await stub.reserveRead(day, RESULTS_BUDGET_DEFAULTS.readRows + 1, T0)).toEqual({ ok: false, reason: "budget" });
    const r = await stub.reserveRead(day, RESULTS_BUDGET_DEFAULTS.readRows - 10, T0);
    if (!r.ok) throw new Error("expected ok");
    await stub.settleRead(r.token, RESULTS_BUDGET_DEFAULTS.readRows - 10);
    expect(await stub.reserveRead(day, 11, T0 + 1)).toEqual({ ok: false, reason: "budget" });
    expect((await stub.reserveRead(day, 10, T0 + 1)).ok).toBe(true);
  });
  it("read_reservation_is_settled_with_actual_rows_read", async () => {
    const stub = fresh();
    const r = await stub.reserveRead(day, 5_000, T0);
    if (!r.ok) throw new Error("expected ok");
    expect((await stub.status(T0)).readUsed).toBe(5_000);
    expect((await stub.status(T0)).readReservation).toEqual({ day, rows: 5_000, expiresAt: T0 + 60_000 });
    await stub.settleRead(r.token, 3_200);
    const s = await stub.status(T0 + 1);
    expect(s.readUsed).toBe(3_200);
    expect(s.readReservation).toBeNull();
    expect((await stub.reserveRead(day, 1, T0 + 1)).ok).toBe(true); // 精算で排他も解ける
  });
  it("expired_read_settlement_does_not_release_new_reservation", async () => {
    const stub = fresh();
    const old = await stub.reserveRead(day, 5_000, T0);
    if (!old.ok) throw new Error("expected ok");
    const fresh2 = await stub.reserveRead(day, 7_000, T0 + 61_000); // 期限切れの後の新しい予約
    if (!fresh2.ok) throw new Error("expected ok");
    await stub.settleRead(old.token, 1_000); // 古い token の精算は元の日の使用量だけを直す
    const s = await stub.status(T0 + 62_000);
    expect(s.readUsed).toBe(1_000 + 7_000);
    expect(s.readReservation).toEqual({ day, rows: 7_000, expiresAt: T0 + 61_000 + 60_000 });
    expect(await stub.reserveRead(day, 1, T0 + 62_000)).toEqual({ ok: false, reason: "busy" }); // 新しい予約の排他は残る
  });
  it("read_settlement_is_idempotent", async () => {
    const stub = fresh();
    const r = await stub.reserveRead(day, 5_000, T0);
    if (!r.ok) throw new Error("expected ok");
    await stub.settleRead(r.token, 4_000);
    await stub.settleRead(r.token, 10); // 2 回目は何もしない
    await stub.settleRead("unknown-token", 10); // 知らない token も何もしない
    expect((await stub.status(T0 + 1)).readUsed).toBe(4_000);
  });
  it("read_reservation_settles_against_original_day", async () => {
    const stub = fresh();
    const lateNight = Date.UTC(2026, 9, 16, 23, 59, 30);
    const r = await stub.reserveRead(day, 5_000, lateNight);
    if (!r.ok) throw new Error("expected ok");
    const after = Date.UTC(2026, 9, 17, 0, 0, 10);
    const nextDay = await stub.reserveRead("2026-10-17", 2_000, after + 60_000);
    if (!nextDay.ok) throw new Error("expected ok");
    await stub.settleRead(r.token, 1_500); // 0 時を過ぎてから届いた精算
    expect((await stub.status(lateNight)).readUsed).toBe(1_500); // 元の日だけが実際の行数に直る
    expect((await stub.status(after + 60_000)).readUsed).toBe(2_000); // 新しい日には触れない
  });
});

describe("ResultsBudget の設定と入口 (K10)", () => {
  it("budget values are read from env with defaults for missing or invalid values", () => {
    expect(budgetLimits({})).toEqual(RESULTS_BUDGET_DEFAULTS);
    expect(budgetLimits({ RESULTS_WRITE_BUDGET: "500", RESULTS_READ_BUDGET: "9000", RESULTS_LEASE_ROWS: "50" })).toEqual({ writeRows: 500, readRows: 9000, leaseRows: 50 });
    expect(budgetLimits({ RESULTS_WRITE_BUDGET: "abc", RESULTS_READ_BUDGET: "-1", RESULTS_LEASE_ROWS: "0" })).toEqual(RESULTS_BUDGET_DEFAULTS);
  });
  it("the DO reads its budget from the worker env", async () => {
    const s = await fresh().status(T0);
    expect(s).toMatchObject({ day, writeBudget: 1000, writeUsed: 0, readBudget: RESULTS_BUDGET_DEFAULTS.readRows, readUsed: 0, leaseRows: RESULTS_BUDGET_DEFAULTS.leaseRows, stoppedUntil: null, readReservation: null });
  });
  it("budgetStub addresses the single global instance", async () => {
    const a = budgetStub(env);
    const b = env.RESULTS_BUDGET!.get(env.RESULTS_BUDGET!.idFromName("global"));
    await a.lease("2030-01-01", 7, Date.UTC(2030, 0, 1));
    expect((await b.status(Date.UTC(2030, 0, 1))).writeUsed).toBe(7);
  });
  it("rejects malformed arguments", async () => {
    // RPC 越しの throw は workerd が DO 側の未処理の拒否として vitest に報告するので、インスタンスを直接呼んで確かめる
    await runInDurableObject(fresh(), async (instance) => {
      const budget = instance as ResultsBudget;
      await expect(budget.lease("2026/10/16", 3, T0)).rejects.toThrow(TypeError);
      await expect(budget.lease(day, 0, T0)).rejects.toThrow(TypeError);
      await expect(budget.lease(day, 1.5, T0)).rejects.toThrow(TypeError);
      await expect(budget.reserveRead(day, -1, T0)).rejects.toThrow(TypeError);
      await expect(budget.stop("other" as never, T0 + 1, T0)).rejects.toThrow(TypeError);
      expect((await budget.status(T0)).writeUsed).toBe(0);
    });
  });
});
