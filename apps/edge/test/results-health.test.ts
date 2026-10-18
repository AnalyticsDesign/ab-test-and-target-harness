import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createHealthBuffer, healthStub, type ResultsHealth } from "../src/results-health";
import type { Env } from "../src/env";

// 収集の失敗の記録(K11・設計書 §6.7)。DO はテストごとに別の名前で作り、状態を共有しない
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 16, 12, 34, 56); // 2026-10-16 12:34:56 UTC
const H0 = T0 - (T0 % HOUR); // 12:00 UTC の先頭
const fresh = () => env.RESULTS_HEALTH!.get(env.RESULTS_HEALTH!.idFromName(crypto.randomUUID()));

describe("ResultsHealth DO (K11)", () => {
  it("add accumulates the same (run_id, hour)", async () => {
    const stub = fresh();
    await stub.add([{ runId: "runA", hour: H0, failed: 2 }]);
    await stub.add([
      { runId: "runA", hour: H0, failed: 3 },
      { runId: "runA", hour: H0 + HOUR, failed: 1 },
      { runId: "runB", hour: H0, failed: 7 },
    ]);
    expect(await stub.read("runA", H0, H0 + 2 * HOUR)).toEqual([
      { hour: H0, failed: 5 },
      { hour: H0 + HOUR, failed: 1 },
    ]);
    expect(await stub.read("runB", H0, H0 + HOUR)).toEqual([{ hour: H0, failed: 7 }]);
  });

  it("add merges duplicate keys inside one call", async () => {
    const stub = fresh();
    await stub.add([
      { runId: "runA", hour: H0, failed: 1 },
      { runId: "runA", hour: H0, failed: 4 },
    ]);
    expect(await stub.read("runA", H0, H0 + HOUR)).toEqual([{ hour: H0, failed: 5 }]);
  });

  it("read returns only hours in [fromHour, toHour) ordered by hour", async () => {
    const stub = fresh();
    await stub.add([
      { runId: "runA", hour: H0 + 2 * HOUR, failed: 3 },
      { runId: "runA", hour: H0 - HOUR, failed: 1 },
      { runId: "runA", hour: H0, failed: 2 },
      { runId: "runA", hour: H0 + 3 * HOUR, failed: 9 },
    ]);
    expect(await stub.read("runA", H0, H0 + 3 * HOUR)).toEqual([
      { hour: H0, failed: 2 },
      { hour: H0 + 2 * HOUR, failed: 3 },
    ]);
    expect(await stub.read("runA", H0 + 10 * HOUR, H0 + 11 * HOUR)).toEqual([]);
    expect(await stub.read("unknown", H0 - 5 * HOUR, H0 + 5 * HOUR)).toEqual([]);
  });

  it("add rejects broken rows without writing any of them", async () => {
    // RPC 越しの throw は workerd が DO 側の未処理の拒否として vitest に報告するので、インスタンスを直接呼んで確かめる(results-budget.test.ts と同じ)
    await runInDurableObject(fresh(), async (instance) => {
      const health = instance as ResultsHealth;
      const good = { runId: "runA", hour: H0, failed: 1 };
      for (const bad of [
        { runId: "", hour: H0, failed: 1 },
        { runId: "runA", hour: H0 + 1, failed: 1 }, // 時の先頭でない
        { runId: "runA", hour: H0, failed: 0 },
        { runId: "runA", hour: H0, failed: 1.5 },
        { runId: "runA", hour: Number.NaN, failed: 1 },
      ]) {
        await expect(health.add([good, bad])).rejects.toThrow(TypeError);
      }
      expect(await health.read("runA", H0 - HOUR, H0 + HOUR)).toEqual([]);
    });
  });

  it("add prunes rows older than 400 days lazily and keeps recent ones", async () => {
    const stub = fresh();
    const nowHour = Date.now() - (Date.now() % HOUR);
    const old = nowHour - 401 * 24 * HOUR;
    const recent = nowHour - 399 * 24 * HOUR;
    await runInDurableObject(stub, (_i, state) => {
      // 古い行は add の入口を通さずに直接入れる(次の add の掃除で消える)
      state.storage.sql.exec(`INSERT INTO counts (run_id, hour, failed) VALUES ('runA', ?, 5), ('runA', ?, 6)`, old, recent);
    });
    await stub.add([{ runId: "runA", hour: nowHour, failed: 1 }]);
    expect(await stub.read("runA", old - HOUR, nowHour + HOUR)).toEqual([
      { hour: recent, failed: 6 },
      { hour: nowHour, failed: 1 },
    ]);
  });

  it("prune and read use indexes (no full table scan)", async () => {
    const stub = fresh();
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      const queries: Array<[string, unknown[]]> = [
        [`DELETE FROM counts WHERE hour < ?`, [0]],
        [`SELECT hour, failed FROM counts WHERE run_id = ? AND hour >= ? AND hour < ? ORDER BY hour`, ["r", 0, 1]],
      ];
      for (const [q, args] of queries) {
        const plan = JSON.stringify(sql.exec(`EXPLAIN QUERY PLAN ${q}`, ...(args as [])).toArray());
        expect(plan).toMatch(/USING (COVERING )?INDEX|PRIMARY KEY/);
        expect(plan).not.toMatch(/SCAN counts/);
      }
    });
  });

  it("sites get separate DOs by name", async () => {
    const a = healthStub(env as Env, `site-${crypto.randomUUID()}`);
    const b = healthStub(env as Env, `site-${crypto.randomUUID()}`);
    await a.add([{ runId: "runA", hour: H0, failed: 1 }]);
    expect(await a.read("runA", H0, H0 + HOUR)).toEqual([{ hour: H0, failed: 1 }]);
    expect(await b.read("runA", H0, H0 + HOUR)).toEqual([]);
  });
});

describe("HealthBuffer (K11)", () => {
  /** add の呼び出しを記録する fake。本物の DO には触れない */
  const makeBuffer = (opts: { fail?: boolean } = {}) => {
    const calls: Array<{ siteId: string; rows: Array<{ runId: string; hour: number; failed: number }> }> = [];
    const buffer = createHealthBuffer({
      async add(_env, siteId, rows) {
        calls.push({ siteId, rows });
        if (opts.fail) throw new Error("do unreachable");
      },
    });
    return { buffer, calls };
  };
  const dummyEnv = {} as Env;

  it("results_health_flushes_at_most_once_per_minute_per_isolate", async () => {
    const { buffer, calls } = makeBuffer();
    for (let i = 0; i < 10; i++) buffer.count("siteA", "runA", T0 + i);
    // 初めての Site は due
    const p = buffer.flushIfDue(dummyEnv, T0 + 10);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ siteId: "siteA", rows: [{ runId: "runA", hour: H0, failed: 10 }] });
    // 直後に数えても、60 秒たつまでは flush しない
    buffer.count("siteA", "runA", T0 + 20_000);
    expect(buffer.flushIfDue(dummyEnv, T0 + 20_000)).toBeNull();
    expect(buffer.flushIfDue(dummyEnv, T0 + 10 + 59_999)).toBeNull();
    expect(calls).toHaveLength(1);
    // 61 秒後にもう 1 回(溜めた分だけ)
    await buffer.flushIfDue(dummyEnv, T0 + 10 + 61_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.rows).toEqual([{ runId: "runA", hour: H0, failed: 1 }]);
  });

  it("flushIfDue returns null when nothing was counted (and does not reset the clock)", async () => {
    const { buffer, calls } = makeBuffer();
    expect(buffer.flushIfDue(dummyEnv, T0)).toBeNull();
    // 何も数えていない呼び出しは時計を進めない = 最初に数えた直後に flush できる
    buffer.count("siteA", "runA", T0 + 1);
    await buffer.flushIfDue(dummyEnv, T0 + 1);
    expect(calls).toHaveLength(1);
    expect(buffer.flushIfDue(dummyEnv, T0 + 120_000)).toBeNull(); // 数えたものが無い
  });

  it("merges per site and per (run, hour), and flushes each due site separately", async () => {
    const { buffer, calls } = makeBuffer();
    buffer.count("siteA", "runA", T0);
    buffer.count("siteA", "runA", T0 + 1);
    buffer.count("siteA", "runB", T0);
    buffer.count("siteA", "runA", T0 + HOUR); // 次の時
    buffer.count("siteB", "runC", T0);
    await buffer.flushIfDue(dummyEnv, T0 + 2);
    expect(calls).toHaveLength(2);
    const a = calls.find((c) => c.siteId === "siteA")!;
    expect([...a.rows].sort((x, y) => x.runId.localeCompare(y.runId) || x.hour - y.hour)).toEqual([
      { runId: "runA", hour: H0, failed: 2 },
      { runId: "runA", hour: H0 + HOUR, failed: 1 },
      { runId: "runB", hour: H0, failed: 1 },
    ]);
    expect(calls.find((c) => c.siteId === "siteB")!.rows).toEqual([{ runId: "runC", hour: H0, failed: 1 }]);
  });

  it("a site flushed recently is skipped while another site is still due", async () => {
    const { buffer, calls } = makeBuffer();
    buffer.count("siteA", "runA", T0);
    await buffer.flushIfDue(dummyEnv, T0);
    buffer.count("siteA", "runA", T0 + 30_000);
    buffer.count("siteB", "runB", T0 + 30_000); // 初めての Site
    await buffer.flushIfDue(dummyEnv, T0 + 30_000);
    expect(calls.map((c) => c.siteId)).toEqual(["siteA", "siteB"]);
  });

  it("drops counts when the flush fails (no retry, no throw)", async () => {
    const { buffer, calls } = makeBuffer({ fail: true });
    buffer.count("siteA", "runA", T0);
    await expect(buffer.flushIfDue(dummyEnv, T0)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    // 次の due でも前の分は再送されない
    buffer.count("siteA", "runA", T0 + 61_000);
    await buffer.flushIfDue(dummyEnv, T0 + 61_000);
    expect(calls[1]?.rows).toEqual([{ runId: "runA", hour: H0, failed: 1 }]);
  });

  it("counts that arrive during a flush are kept for the next one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: number[] = [];
    const buffer = createHealthBuffer({
      async add(_env, _s, rows) {
        calls.push(rows[0]?.failed ?? -1);
        await gate;
      },
    });
    buffer.count("siteA", "runA", T0);
    const p = buffer.flushIfDue(dummyEnv, T0)!;
    buffer.count("siteA", "runA", T0 + 1); // 送信中に数える
    release();
    await p;
    await buffer.flushIfDue(dummyEnv, T0 + 61_000);
    expect(calls).toEqual([1, 1]);
  });

  it("missing RESULTS_HEALTH binding is dropped without throwing (default deps)", async () => {
    const buffer = createHealthBuffer();
    buffer.count("siteA", "runA", T0);
    await expect(buffer.flushIfDue({} as Env, T0)).resolves.toBeUndefined();
  });

  it("flushes into the real DO through the default deps", async () => {
    const siteId = `site-${crypto.randomUUID()}`;
    const buffer = createHealthBuffer();
    buffer.count(siteId, "runA", T0);
    buffer.count(siteId, "runA", T0 + 1);
    await buffer.flushIfDue(env as Env, T0 + 2);
    expect(await healthStub(env as Env, siteId).read("runA", H0, H0 + HOUR)).toEqual([{ hour: H0, failed: 2 }]);
  });
});
