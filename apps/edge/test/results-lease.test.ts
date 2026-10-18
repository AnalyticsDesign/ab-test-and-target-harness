import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { RESULTS_ROWS } from "@wtt/core";
import type { LeaseResult } from "../src/results-budget";
import { createLeaseHolder, leaseHolder, resetLeaseHolderForTest, type LeaseDeps, type LeaseHolder, type LeaseTicket } from "../src/results-lease";

// isolate の枠(K10)。DO は偽物の関数で差し替える(competing_holders_share_last_lease だけ本物の ResultsBudget を使う)
const T0 = Date.UTC(2026, 9, 16, 12); // 2026-10-16 12:00 UTC
const MIDNIGHT = Date.UTC(2026, 9, 17);
const EST = RESULTS_ROWS.participant; // 参加 1 件の batch の見込み(3 行)

/** 偽物の予算の DO。配った合計・呼ばれた回数を数え、stop を外から立てられる */
function fakeBudget(opts: { budget?: number; leaseRows?: number } = {}) {
  const used = new Map<string, number>();
  const state = { handed: 0, leaseCalls: [] as Array<{ day: string; rows: number; now: number }>, checkCalls: 0, stoppedUntil: null as number | null, throwing: false };
  const deps: LeaseDeps = {
    leaseRows: opts.leaseRows ?? 200,
    warn: () => {},
    async lease(day, rows, now): Promise<LeaseResult> {
      state.leaseCalls.push({ day, rows, now });
      if (state.throwing) throw new Error("budget DO unreachable");
      if (state.stoppedUntil !== null && now < state.stoppedUntil) return { ok: false, stoppedUntil: state.stoppedUntil };
      const remaining = (opts.budget ?? Infinity) - (used.get(day) ?? 0);
      if (remaining <= 0) return { ok: false, stoppedUntil: Date.parse(`${day}T00:00:00Z`) + 86_400_000 };
      const given = Math.min(rows, remaining);
      used.set(day, (used.get(day) ?? 0) + given);
      state.handed += given;
      return { ok: true, day, rows: given };
    },
    async check(now) {
      state.checkCalls++;
      if (state.throwing) throw new Error("budget DO unreachable");
      return { stoppedUntil: state.stoppedUntil !== null && now < state.stoppedUntil ? state.stoppedUntil : null };
    },
  };
  return { deps, state };
}

async function okTicket(h: LeaseHolder, rows: number, now: number): Promise<LeaseTicket> {
  const r = await h.take(rows, now);
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
  return r.ticket;
}

describe("LeaseHolder.take (K10)", () => {
  it("write_requires_lease_for_batch_max_rows", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 5 });
    const h = createLeaseHolder(deps);
    await okTicket(h, 3, T0); // 枠 5 を受け取り、残り 2
    expect(state.leaseCalls).toHaveLength(1);
    const t = await okTicket(h, 3, T0 + 1); // 残り 2 で take(3) は DO を呼ぶ
    expect(state.leaseCalls).toHaveLength(2);
    expect(state.leaseCalls[1]).toEqual({ day: "2026-10-16", rows: 5, now: T0 + 1 });
    expect(t.rows).toBe(3);
    // 枠より大きい batch は batch の行数を受け取る
    await okTicket(h, 30, T0 + 2);
    expect(state.leaseCalls[2]!.rows).toBe(30);
  });
  it("lease_from_previous_utc_day_is_discarded", async () => {
    const { deps, state } = fakeBudget();
    const h = createLeaseHolder(deps);
    await okTicket(h, 3, MIDNIGHT - 60_000); // 23:59 に受け取り、残り 197
    const t = await okTicket(h, 3, MIDNIGHT + 1_000); // 0:00 過ぎは前の日の残りを使わない
    expect(state.leaseCalls.map((c) => c.day)).toEqual(["2026-10-16", "2026-10-17"]);
    expect(t.day).toBe("2026-10-17");
  });
  it("unused_lease_is_counted_as_used", async () => {
    const { deps, state } = fakeBudget();
    const first = createLeaseHolder(deps);
    await okTicket(first, 3, T0);
    const second = createLeaseHolder(deps); // isolate が消えた想定
    await okTicket(second, 3, T0 + 1);
    expect(state.leaseCalls).toHaveLength(2); // 前の残りは使えない
    expect(state.handed).toBe(400); // 使い残しは戻らず、配った分のまま
  });
  it("budget_do_unreachable_stops_writing", async () => {
    const { deps, state } = fakeBudget();
    state.throwing = true;
    const h = createLeaseHolder(deps);
    expect(await h.take(3, T0)).toEqual({ kind: "unreachable" }); // 書かない(呼び出し側は failed)
    expect(await h.take(3, T0 + 4_999)).toEqual({ kind: "unreachable" });
    expect(state.leaseCalls).toHaveLength(1); // 5 秒以内は DO を呼ばない
    state.throwing = false;
    await okTicket(h, 3, T0 + 5_000);
    expect(state.leaseCalls).toHaveLength(2);
    expect(h.stoppedUntil).toBeNull(); // 届かないことは停止ではない
  });
  it("hung_budget_do_call_is_detached_after_5s_as_unreachable", async () => {
    // DO の呼び出しが返らない(要求の取り消し・DO の無応答)。タイマーは使わず、後の take の now で切り離す
    const { deps, state } = fakeBudget();
    let resolveHung!: (r: LeaseResult) => void;
    let calls = 0;
    const h = createLeaseHolder({
      ...deps,
      lease: (day, rows, now) => {
        if (calls++ > 0) return deps.lease(day, rows, now);
        state.leaseCalls.push({ day, rows, now });
        return new Promise<LeaseResult>((res) => (resolveHung = res));
      },
    });
    const PENDING = Symbol("pending");
    const settledYet = (p: Promise<unknown>) => Promise.race([p, new Promise((res) => setTimeout(() => res(PENDING), 5))]);
    const p1 = h.take(3, T0); // 呼び出しを始めた要求
    const p2 = h.take(3, T0 + 4_999); // 5 秒より前は同じ呼び出しを待つ
    expect(await settledYet(p1)).toBe(PENDING);
    expect(await settledYet(p2)).toBe(PENDING);
    // 5 秒を過ぎた take は、その呼び出しを届かなかったものとして切り離し、DO を呼び直さずに unreachable を返す
    expect(await h.take(3, T0 + 5_000)).toEqual({ kind: "unreachable" });
    // すでに待っていた take も起きて unreachable になる(永久に待たない)
    expect(await p1).toEqual({ kind: "unreachable" });
    expect(await p2).toEqual({ kind: "unreachable" });
    expect(state.leaseCalls).toHaveLength(1);
    expect(await h.take(3, T0 + 9_999)).toEqual({ kind: "unreachable" }); // 届かなかった後の 5 秒の後退
    expect(state.leaseCalls).toHaveLength(1);
    // 古い呼び出しが後から解決しても、手元の枠・世代・停止・後退に触れない(DO 側では配った分として数えられ、予算の上限は崩れない)
    resolveHung({ ok: true, day: "2026-10-16", rows: 200 });
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(h.stoppedUntil).toBeNull();
    expect(await h.take(3, T0 + 9_999)).toEqual({ kind: "unreachable" }); // 後退はそのまま(古い呼び出しが縮めない)
    const t = await okTicket(h, 3, T0 + 10_000); // 古い 200 行は手元に入っていないので、DO を呼び直す
    expect(state.leaseCalls).toHaveLength(2);
    expect(t.rows).toBe(3);
  });
  it("hung_call_that_rejects_late_does_not_touch_the_new_state", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 6 });
    let rejectHung!: (e: unknown) => void;
    let calls = 0;
    const h = createLeaseHolder({
      ...deps,
      lease: (day, rows, now) => {
        if (calls++ > 0) return deps.lease(day, rows, now);
        return new Promise<LeaseResult>((_, rej) => (rejectHung = rej));
      },
    });
    const p1 = h.take(3, T0);
    expect(await h.take(3, T0 + 5_000)).toEqual({ kind: "unreachable" }); // 後退は T0 + 10 秒まで
    expect(await p1).toEqual({ kind: "unreachable" });
    // 古い呼び出しが遅れて失敗しても、古い now で後退を書き換えない(縮めると T0 + 6 秒で DO を呼び直してしまう)
    rejectHung(new Error("late failure"));
    await new Promise((res) => setTimeout(res, 0));
    expect(await h.take(3, T0 + 6_000)).toEqual({ kind: "unreachable" });
    expect(state.leaseCalls).toHaveLength(0);
    const t = await okTicket(h, 3, T0 + 10_000); // 新しい呼び出しで枠 6、残り 3
    h.settle(t, 3);
    await okTicket(h, 3, T0 + 10_001); // 新しい枠はそのまま使える
    expect(state.leaseCalls).toHaveLength(1); // fakeBudget の lease は新しい 1 回だけ
  });
  it("hung_call_settling_late_does_not_clear_a_newer_inflight_call", async () => {
    // 呼び出しごとに解決を手で持つ偽物の DO
    const pending: Array<(r: LeaseResult) => void> = [];
    const leaseCalls: number[] = [];
    const h = createLeaseHolder({
      leaseRows: 6,
      warn: () => {},
      lease: (_day, _rows, now) => {
        leaseCalls.push(now);
        return new Promise<LeaseResult>((res) => pending.push(res));
      },
      check: async () => ({ stoppedUntil: null }),
    });
    const p1 = h.take(3, T0);
    expect(await h.take(3, T0 + 5_000)).toEqual({ kind: "unreachable" });
    expect(await p1).toEqual({ kind: "unreachable" });
    const p2 = h.take(3, T0 + 10_000); // 新しい呼び出し(まだ返らない)
    expect(leaseCalls).toEqual([T0, T0 + 10_000]);
    pending[0]!({ ok: true, day: "2026-10-16", rows: 6 }); // 古い呼び出しが今ごろ返る
    await new Promise((res) => setTimeout(res, 0));
    const p3 = h.take(3, T0 + 10_001); // 新しい呼び出しを待つ(古い呼び出しの終わりで inflight が消えていれば、DO をもう一度呼んでしまう)
    expect(leaseCalls).toHaveLength(2);
    pending[1]!({ ok: true, day: "2026-10-16", rows: 6 });
    expect((await p2).kind).toBe("ok");
    expect((await p3).kind).toBe("ok"); // 新しい枠 6 を 2 本で使う。古い 6 行は手元に入っていない
    void h.take(3, T0 + 10_002); // 残り 0 → DO を呼ぶ(この呼び出しは返さない)
    expect(leaseCalls).toHaveLength(3);
  });
  it("settle subtracts actual rows and returns the unused part", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 4 });
    const h = createLeaseHolder(deps);
    const t = await okTicket(h, 3, T0); // 残り 1
    h.settle(t, 2); // 1 行戻り、残り 2
    h.settle(t, 2); // 同じ ticket の 2 回目は何もしない
    await expect(h.take(3, T0 + 1)).resolves.toMatchObject({ kind: "ok" }); // 残り 2 では足りず DO を呼ぶ
    expect(state.leaseCalls).toHaveLength(2);
    const h2 = createLeaseHolder(fakeBudget({ leaseRows: 5 }).deps);
    const t2 = await okTicket(h2, 3, T0); // 残り 2
    h2.settle(t2, 2); // 残り 3
    await okTicket(h2, 3, T0 + 1); // DO を呼ばずに足りる
  });
  it("settle charges rows written beyond the estimate to the local lease and logs it", async () => {
    const warns: string[] = [];
    const { deps, state } = fakeBudget({ leaseRows: 6 });
    const h = createLeaseHolder({ ...deps, warn: (m) => warns.push(m) });
    const t = await okTicket(h, 3, T0); // 残り 3
    h.settle(t, 4); // 見込みを 1 行超えた → 残り 2
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/estimate/);
    await okTicket(h, 3, T0 + 1); // 残り 2 では足りず DO を呼ぶ
    expect(state.leaseCalls).toHaveLength(2);
  });
  it("concurrent takes in one isolate do not double-spend", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 3 });
    const h = createLeaseHolder(deps);
    const t = await okTicket(h, 3, T0);
    h.settle(t, 0); // 残り 3
    expect(state.leaseCalls).toHaveLength(1);
    const [a, b] = await Promise.all([h.take(3, T0 + 1), h.take(3, T0 + 1)]); // 残り 3 で 2 本同時
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    expect(state.leaseCalls).toHaveLength(2); // 1 本は DO を呼ぶ
    // 受け取り中の Promise を共有する: 残り 0 で同時に 3 本 → DO の呼び出しは 1 回(枠 3 で 1 本、残りは待ってもう 1 回ずつ)
    const { deps: d2, state: s2 } = fakeBudget({ leaseRows: 9 });
    const h2 = createLeaseHolder(d2);
    const rs = await Promise.all([h2.take(3, T0), h2.take(3, T0), h2.take(3, T0)]);
    expect(rs.every((r) => r.kind === "ok")).toBe(true);
    expect(s2.leaseCalls).toHaveLength(1);
  });
  it("account_stop_is_observed_with_unused_lease", async () => {
    const { deps, state } = fakeBudget();
    const h = createLeaseHolder(deps);
    await okTicket(h, 3, T0); // 最後の確認 = T0
    const stopEnd = T0 + 300_000;
    state.stoppedUntil = stopEnd; // DO で stop("account_usage")
    await okTicket(h, 3, T0 + 60_000); // 最後の確認から 60 秒以内は手元の枠で ok
    expect(state.checkCalls).toBe(0);
    expect(await h.take(3, T0 + 60_001)).toEqual({ kind: "stopped", until: stopEnd }); // 60 秒を過ぎたら check
    expect(state.checkCalls).toBe(1);
    expect(h.stoppedUntil).toBe(stopEnd);
    expect(await h.take(3, T0 + 120_000)).toEqual({ kind: "stopped", until: stopEnd }); // 期限まで DO を呼ばない
    expect(state.checkCalls).toBe(1);
    expect(state.leaseCalls).toHaveLength(1);
    // 停止が解けた後は、手元の枠(残り 194)を捨てたので同じ日でも新しい枠を受け取る
    await okTicket(h, 3, stopEnd);
    expect(state.leaseCalls).toHaveLength(2);
    expect(h.stoppedUntil).toBeNull();
  });
  it("check that is not stopped keeps using the same lease", async () => {
    const { deps, state } = fakeBudget();
    const h = createLeaseHolder(deps);
    await okTicket(h, 3, T0);
    await okTicket(h, 3, T0 + 61_000);
    expect(state.checkCalls).toBe(1);
    await okTicket(h, 3, T0 + 100_000); // 確認から 60 秒以内
    expect(state.checkCalls).toBe(1);
    expect(state.leaseCalls).toHaveLength(1);
  });
  it("low_rate_collection_does_not_exhaust_budget_by_lease_refresh", async () => {
    const start = Date.UTC(2026, 9, 16); // 1 日の中に収める
    for (const [count, interval] of [[1_416, 61_000], [10_000, 8_640]] as const) {
      const { deps, state } = fakeBudget();
      const h = createLeaseHolder(deps);
      let written = 0;
      for (let i = 0; i < count; i++) {
        const t = await okTicket(h, EST, start + i * interval);
        h.settle(t, EST);
        written += EST;
      }
      expect(state.handed).toBeLessThanOrEqual(written + deps.leaseRows); // 実際の書き込み + 枠 1 つ分以内
      expect(state.checkCalls).toBeGreaterThan(0);
      if (interval > 60_000) expect(state.leaseCalls.length).toBe(Math.ceil(written / deps.leaseRows)); // lease は呼び直さない
    }
  });
  it("d1_limit_discards_local_lease", async () => {
    const { deps, state } = fakeBudget();
    const h = createLeaseHolder(deps);
    const t = await okTicket(h, 3, T0);
    h.discard(); // D1 の上限エラー
    h.settle(t, 0); // 捨てた後の精算は枠を生き返らせない
    await okTicket(h, 3, T0 + 1);
    expect(state.leaseCalls).toHaveLength(2);
  });
  it("late_settlement_does_not_credit_new_day_lease", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 3 });
    const h = createLeaseHolder(deps);
    const yesterday = await okTicket(h, 3, MIDNIGHT - 1_000); // 残り 0
    const today = await okTicket(h, 3, MIDNIGHT + 1_000); // 新しい日の枠、残り 0
    h.settle(yesterday, 0); // 前の日の ticket の精算は戻さない
    h.settle(today, 3);
    await okTicket(h, 3, MIDNIGHT + 2_000);
    expect(state.leaseCalls).toHaveLength(3);
  });
  it("out_of_order_settlements_credit_only_current_generation", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 3 });
    const h = createLeaseHolder(deps);
    const g1 = await okTicket(h, 3, T0); // 世代 1、残り 0
    const g2 = await okTicket(h, 3, T0 + 1); // 受け取り直し = 世代 2、残り 0
    expect(g2.gen).toBeGreaterThan(g1.gen);
    h.settle(g1, 0); // 前の世代の ticket は今の枠に戻さない
    await okTicket(h, 3, T0 + 2);
    expect(state.leaseCalls).toHaveLength(3);
    const g3 = await okTicket(h, 3, T0 + 3); // さらに受け取り直し、残り 0
    h.settle(g3, 0); // 今の世代は戻す
    await okTicket(h, 3, T0 + 4);
    expect(state.leaseCalls).toHaveLength(4);
  });
  it("partial_lease_smaller_than_batch_returns_stopped", async () => {
    const { deps, state } = fakeBudget({ budget: 203, leaseRows: 201 });
    const h = createLeaseHolder(deps);
    for (let i = 0; i < 67; i++) h.settle(await okTicket(h, 3, T0 + i), 3); // 201 行を使い切り、手元の残り 0
    expect(await h.take(3, T0 + 100)).toEqual({ kind: "stopped", until: MIDNIGHT }); // DO が配れた 2 行では batch に足りない
    expect(state.leaseCalls.map((c) => c.rows)).toEqual([201, 201]);
    expect(state.handed).toBe(203);
    expect(await h.take(3, T0 + 200)).toEqual({ kind: "stopped", until: MIDNIGHT });
    expect(state.leaseCalls).toHaveLength(2); // 次の UTC 0 時まで DO を呼ばない
  });
  it("ok:false from the budget DO stops until the returned time", async () => {
    const { deps, state } = fakeBudget({ budget: 0 });
    const h = createLeaseHolder(deps);
    expect(await h.take(3, T0)).toEqual({ kind: "stopped", until: MIDNIGHT });
    expect(await h.take(3, MIDNIGHT - 1)).toEqual({ kind: "stopped", until: MIDNIGHT });
    expect(state.leaseCalls).toHaveLength(1);
  });
});

describe("LeaseHolder の入力の検査と binding が無いとき", () => {
  it("take and settle reject malformed numbers before touching state", async () => {
    const { deps, state } = fakeBudget({ leaseRows: 6 });
    const h = createLeaseHolder(deps);
    for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await expect(h.take(bad, T0)).rejects.toThrow(TypeError);
    await expect(h.take(3, Number.NaN)).rejects.toThrow(TypeError);
    expect(state.leaseCalls).toHaveLength(0); // DO に渡していない(届かない扱いの 5 秒にもならない)
    const t = await okTicket(h, 3, T0); // 残り 3
    for (const bad of [-1, 0.5, Number.NaN]) expect(() => h.settle(t, bad)).toThrow(TypeError);
    h.settle(t, 0); // 検査で拒否した呼び出しは精算済みにしない → ここで 3 行戻り、残り 6
    await okTicket(h, 6, T0 + 1);
    expect(state.leaseCalls).toHaveLength(1);
  });
  it("missing RESULTS_BUDGET binding makes the holder unreachable (fail-closed)", async () => {
    resetLeaseHolderForTest();
    try {
      const h = leaseHolder({ ...env, RESULTS_BUDGET: undefined });
      expect(await h.take(3, T0)).toEqual({ kind: "unreachable" });
    } finally {
      resetLeaseHolderForTest();
    }
  });
});

describe("LeaseHolder と本物の ResultsBudget (K10 の予算の保証)", () => {
  it("competing_holders_share_last_lease", async () => {
    const day = "2026-10-16";
    // (a) 実際の行数がすべて見込み以下。予算 1000(vitest.config.ts)を 2 つの holder が枠 7 行ずつで取り合い、尽きるまで書く
    {
      const stub = env.RESULTS_BUDGET!.get(env.RESULTS_BUDGET!.idFromName(crypto.randomUUID()));
      let handed = 0;
      let leaseNo = 0;
      const mk = (): LeaseHolder =>
        createLeaseHolder({
          leaseRows: 7,
          warn: () => {},
          lease: async (d, rows, now) => {
            const late = leaseNo++ % 3 === 0;
            const r = await stub.lease(d, rows, now);
            if (r.ok) handed += r.rows;
            // 3 回に 1 回は応答を遅らせ、同時に出したもう一方の holder の応答が先に返るようにする(応答の順の逆転)
            if (late) await new Promise((res) => setTimeout(res, 3));
            return r;
          },
          check: (now) => stub.check(now),
        });
      const holders = [mk(), mk()];
      const stopped = [false, false];
      let written = 0;
      let prev: Array<{ h: LeaseHolder; t: LeaseTicket; actual: number }> = [];
      let now = T0;
      for (let round = 0; !(stopped[0] && stopped[1]) && round < 5_000; round++) {
        const rs = await Promise.all(holders.map((h, i) => (stopped[i] ? null : h.take(EST, now))));
        // 精算の前に次の要求を出す: 前の回の batch は、この回の take の後で精算する
        for (const p of prev) p.h.settle(p.t, p.actual);
        prev = [];
        rs.forEach((r, i) => {
          if (r === null) return;
          if (r.kind === "stopped") return void (stopped[i] = true);
          if (r.kind !== "ok") throw new Error("unexpected unreachable");
          const actual = [3, 2, 0, 1, 3][(round + i) % 5]!; // すべて見込み(3)以下
          written += actual;
          prev.push({ h: holders[i]!, t: r.ticket, actual });
        });
        now += 10;
      }
      for (const p of prev) p.h.settle(p.t, p.actual);
      const s = await stub.status(now);
      expect(stopped).toEqual([true, true]);
      expect(handed).toBe(s.writeUsed);
      expect(s.writeUsed).toBeLessThanOrEqual(1000); // DO の配った合計 ≤ 予算
      expect(written).toBeLessThanOrEqual(1000); // 実際の書き込みの合計 ≤ 予算
      expect(s.writeUsed).toBe(1000); // 最後の枠まで取り合って配り終えている
    }
    // (b) 見込み 3・実際 0 の重複の batch を各 holder が 2 回ずつ流した後、両方が見込み 3・実際 4 の batch を同時に流す
    {
      const stub = env.RESULTS_BUDGET!.get(env.RESULTS_BUDGET!.idFromName(crypto.randomUUID()));
      // ほかの isolate が 994 行を受け取って使い切った(書き込みも 994 行)。残りは 6 行 = 最後の枠 2 つ分
      expect(await stub.lease(day, 994, T0)).toEqual({ ok: true, day, rows: 994 });
      let written = 994;
      const warns: string[] = [];
      const mk = (): LeaseHolder =>
        createLeaseHolder({ leaseRows: EST, warn: (m) => warns.push(m), lease: (d, r, n) => stub.lease(d, r, n), check: (n) => stub.check(n) });
      const [a, b] = [mk(), mk()];
      for (const h of [a, b]) {
        for (let k = 0; k < 2; k++) {
          const t = await okTicket(h, EST, T0 + 1);
          h.settle(t, 0); // 重複で書かれなかった(見込みより 3 少ない)
        }
      }
      expect((await stub.status(T0 + 1)).writeUsed).toBe(1000); // 最後の 6 行を 2 つの holder が 3 行ずつ受け取った
      // 両方が同時に見込み 3・実際 4 の batch を流す
      const [ta, tb] = await Promise.all([okTicket(a, EST, T0 + 2), okTicket(b, EST, T0 + 2)]);
      written += 4 + 4;
      a.settle(ta, 4);
      b.settle(tb, 4);
      expect(warns).toHaveLength(2); // 見込みを超えた batch はログに残す
      // 少なかった分(重複の batch)で上限は広がらない: 以後はどちらも書けない
      for (const h of [a, b]) for (let k = 0; k < 3; k++) expect((await h.take(EST, T0 + 3 + k)).kind).toBe("stopped");
      const overrun = 2 * (4 - EST); // 見込みを超えた分の和
      expect(written).toBeLessThanOrEqual(1000 + overrun);
      expect(written).toBe(1000 + overrun); // この例では上限ちょうどまで届く(最後の枠を本当に取り合っている)
      expect((await stub.status(T0 + 10)).writeUsed).toBe(1000);
    }
  });
});
