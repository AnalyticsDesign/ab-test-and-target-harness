// apps/control/test/cron-audit-retention.test.ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROX_COUNT_SQL,
  AUDIT_RETENTION_DAILY_CAP,
  auditRetentionJob,
  auditRetentionJobWith,
  retentionSql,
  retentionStatements,
} from "../src/cron/audit-retention";
import { CRON_JOBS } from "../src/cron/jobs";
import { countingD1, CronFrozen, runCron, type CronContext, type CronJob } from "../src/cron/runner";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { CONTROL_DB_SIZE_KEY } from "../src/instance-settings";
import { resetUsageCache } from "../src/usage";
import { isWriteFrozen } from "../src/write-freeze";
import { beforeD1Batch, call, failingD1Query, json, setupOwner, testEnv } from "./helpers";

/**
 * B129 Task 9(spec §8・§10.3・§10.4): 操作の記録の保持の Cron(audit-retention)。
 * 366 日より前の行を 1 日 5,000 行まで消す。1 日の枠は audit_retention_state と batch 1 つ(2 文)で守る(Q15・Q26)。
 * 日付は D1 の時計(strftime('%Y-%m-%d','now'))。D1 の now は差し替えられないので、日付を変えるテストは
 * T を bind する内部の口(auditRetentionJobWith({ day }) / retentionStatements の day)で書く
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** n 行の記録を 1 文で入れる(at = from + i。access × password = 1 行で索引の項目が最も多い記録) */
async function fill(n: number, from: number, o: { category?: string; via?: string } = {}): Promise<void> {
  await env.DB.prepare(
    `insert into audit_events (at, category, action, workspace_id, via)
     with recursive c(x) as (select 0 union all select x + 1 from c where x + 1 < ?1)
     select ?2 + x, ?3, 'member.role', 'w1', ?4 from c`,
  )
    .bind(n, from, o.category ?? "access", o.via ?? "password")
    .run();
}
const count = async (where = "1 = 1"): Promise<number> => (await env.DB.prepare(`select count(*) as n from audit_events where ${where}`).first<{ n: number }>())!.n;
type State = { day: string; deleted: number; run_id: string; last_limit: number };
const state = async (): Promise<State> => (await env.DB.prepare("select day, deleted, run_id, last_limit from audit_retention_state").first<State>())!;
const setState = (day: string, deleted: number) => env.DB.prepare("update audit_retention_state set day = ?1, deleted = ?2 where id = 1").bind(day, deleted).run();
const d1Today = async (): Promise<string> => (await env.DB.prepare("select strftime('%Y-%m-%d','now') as d").first<{ d: string }>())!.d;

async function freeze(): Promise<void> {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null) on conflict(key) do nothing").run();
}
async function unfreeze(): Promise<void> {
  await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
}

/** job.run を直接呼ぶ ctx(runner と同じ凍結の確かめ。クエリの残りは 40) */
function ctxOf(e: Env = testEnv, over: Partial<CronContext> = {}): CronContext {
  const d = getDb(e);
  return {
    env: e,
    db: d,
    now: Date.now(),
    async assertNotFrozen() {
      if (await isWriteFrozen(d)) throw new CronFrozen();
    },
    queries: { left: () => 40, use: (k) => k <= 40 },
    ...over,
  };
}

/** runner を通す実行の時刻(UTC 20 時。afterUtcHour 19 の後)。offset = 0 は昨日の 20 時(いつも過去)、1 は今日の 20 時 */
const runAt = (offset: number): number => Math.floor(Date.now() / DAY) * DAY - DAY + 20 * HOUR + offset * DAY;
/** 消す側の行の時刻(どの実行の cutoff = 今 − 366 日よりも前で、トリガーの 365 日よりも前) */
const OLD = (): number => Date.now() - 400 * DAY;

const dayA = "2026-01-10";
const dayB = "2026-01-11";
const jobOn = (day: string): CronJob => auditRetentionJobWith({ day: () => day });

describe("audit-retention (B129 Task 9)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes_only_older_than_366_days", async () => {
    const now = Date.now();
    await fill(3, now - 367 * DAY);
    await fill(2, now - 365.5 * DAY);
    await fill(2, now - 10 * DAY);
    await auditRetentionJob.run(ctxOf(testEnv, { now }));
    expect(await count()).toBe(4);
    expect(await count(`at < ${now - 366 * DAY}`)).toBe(0);
  });

  it("cutoff_has_one_day_margin", async () => {
    // Worker の時刻が D1 より半日進んでいても、cutoff(Worker の今 − 366 日)はトリガーの線(D1 の今 − 365 日)より古い
    const real = Date.now();
    const now = real + 12 * HOUR;
    await fill(3, real - 366 * DAY); // cutoff(real − 365.5 日)より前 = 消す。トリガーの線より前なので断られない
    await fill(2, real - 365.5 * DAY + HOUR); // 365 日と 366 日のあいだ(cutoff より後)= 残す
    await fill(2, real - 364 * DAY); // 365 日以内 = トリガーが守る行。条件付きの DELETE が混ざった表で通ること
    await fill(2, real - DAY);
    await auditRetentionJob.run(ctxOf(testEnv, { now }));
    expect(await count()).toBe(6);
    expect(await count(`at < ${real - 365.5 * DAY}`)).toBe(0);
    expect((await state()).deleted).toBe(3);
    // 365 日以内の行が混ざった表で、条件付きの DELETE(366 日より前)そのものもトリガーに断られない(batch ごと失敗しない)
    await fill(1, real - 367 * DAY);
    const [, removed] = await env.DB.batch(retentionStatements(env.DB, { runId: "margin", cutoff: real - 366 * DAY }));
    expect(removed!.meta.changes).toBe(1);
    expect(await count()).toBe(6);
  });

  it("deletes_up_to_daily_cap_of_5000", async () => {
    await fill(21_000, OLD());
    // 1 回目: 5,000 行
    expect(await jobOn(dayA).run(ctxOf())).toBeUndefined();
    expect(await count()).toBe(16_000);
    expect(await state()).toMatchObject({ day: dayA, deleted: AUDIT_RETENTION_DAILY_CAP, last_limit: 5000 });
    // 同じ UTC 日の 2 回目: 上限 L = 0 で何も消さず、more を返さない
    expect(await jobOn(dayA).run(ctxOf())).toBeUndefined();
    expect(await count()).toBe(16_000);
    expect(await state()).toMatchObject({ day: dayA, deleted: 5000, last_limit: 0 });
    // 翌日は runner を通して続きを消す
    expect(await runCron(testEnv, runAt(1), [jobOn(dayB)])).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    expect(await count()).toBe(11_000);
    expect(await state()).toMatchObject({ day: dayB, deleted: 5000 });
  });

  it("audit_retention_does_not_continue_past_daily_cap", async () => {
    await fill(30_000, OLD());
    // 消し残しがあっても more を返さず成功を記録する(daily のジョブはその日の残りの実行では動かない)
    expect(await runCron(testEnv, runAt(0), [jobOn(dayA)])).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    expect(await count()).toBe(25_000);
    expect(await runCron(testEnv, runAt(0) + HOUR, [jobOn(dayA)])).toEqual([{ job: "audit-retention", outcome: "not_due" }]);
    // 同じ UTC 日に(runner の外から)もう一度動いても、その日の枠を使い切っているので消さない
    await jobOn(dayA).run(ctxOf());
    expect(await count()).toBe(25_000);
    // 翌日は runner を通して続ける
    expect(await runCron(testEnv, runAt(1), [jobOn(dayB)])).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    expect(await count()).toBe(20_000);
  });

  /** 削除の後の段を失敗させる env(件数・大きさの保存・成功の記録)と、削除の batch の後に凍結を入れる env */
  function afterBatch(db: D1Database, hook: () => Promise<unknown>): D1Database {
    return new Proxy(db, {
      get(t, p) {
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            const out = await t.batch(stmts);
            // 保持の batch(① が RETURNING で last_limit を返す)の後だけ
            const first = out[0]?.results?.[0] as Record<string, unknown> | undefined;
            if (first && "last_limit" in first) await hook();
            return out;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
  }
  const injections: Array<[string, () => Env, string]> = [
    ["count", () => ({ ...testEnv, DB: failingD1Query(env.DB, /max\(rowid\)/, 99) }), "ran"],
    ["size", () => ({ ...testEnv, DB: failingD1Query(env.DB, new RegExp(CONTROL_DB_SIZE_KEY), 99) }), "failed"],
    ["success record", () => ({ ...testEnv, DB: failingD1Query(env.DB, /insert into "cron_job_runs"/, 99) }), "failed"],
    ["freeze", () => ({ ...testEnv, DB: afterBatch(env.DB, freeze) }), "stopped_frozen"],
  ];
  it.each(injections)("daily_cap_holds_when_later_steps_fail (%s)", async (_name, failing, outcome) => {
    await fill(12_000, OLD());
    expect(await runCron(failing(), runAt(0), [jobOn(dayA)])).toEqual([{ job: "audit-retention", outcome }]);
    expect(await count()).toBe(7_000);
    await unfreeze();
    // 同じ UTC 日の次の実行(runner が取り直す)は、その日の残りの枠(0)までしか消さない
    for (const t of [runAt(0) + 15 * 60_000, runAt(0) + 30 * 60_000]) await runCron(testEnv, t, [jobOn(dayA)]);
    await jobOn(dayA).run(ctxOf());
    expect(await count()).toBe(7_000);
    expect(await state()).toMatchObject({ day: dayA, deleted: 5000 });
  });

  it("concurrent_runs_delete_once", async () => {
    await fill(12_000, OLD());
    await setState(dayA, 1_000); // その日に 1,000 行を消した後
    await Promise.all([jobOn(dayA).run(ctxOf()), jobOn(dayA).run(ctxOf()), jobOn(dayA).run(ctxOf())]);
    // 後の batch の ① は前の batch が書いた状態から P を計算する。その日の合計は 5,000 行
    expect(await count()).toBe(8_000);
    expect(await state()).toMatchObject({ day: dayA, deleted: 5000, last_limit: 0 });
  });

  it("first_run_initializes_and_deletes", async () => {
    // テストで状態の行を入れない(マイグレーションの初めの行から動く)。本番の口 = D1 の時計の日付
    expect(await state()).toEqual({ day: "1970-01-01", deleted: 0, run_id: "", last_limit: 0 });
    await fill(7, OLD());
    await auditRetentionJob.run(ctxOf());
    expect(await count()).toBe(0);
    const s = await state();
    expect(s).toMatchObject({ day: await d1Today(), deleted: 7, last_limit: 5000 });
    expect(s.run_id).not.toBe("");
  });

  it("first_runs_race_delete_once", async () => {
    await fill(9_000, OLD());
    await Promise.all([auditRetentionJob.run(ctxOf()), auditRetentionJob.run(ctxOf())]);
    expect(await count()).toBe(4_000);
    expect(await state()).toMatchObject({ day: await d1Today(), deleted: 5000 });
  });

  it("batch_crossing_utc_midnight", async () => {
    await fill(12_000, OLD());
    await setState(dayA, 4_000);
    // ② は日付を評価しない(① が決めた last_limit を使う)。① と ② の間で D1 の日付が変わっても、② が選ぶ行は ① の count と同じ
    for (const bindDay of [false, true]) {
      const { consume, remove } = retentionSql(bindDay);
      expect(remove).toContain("DELETE FROM audit_events");
      expect(remove).not.toMatch(/strftime|'now'|date\(|\?3/i);
      // ① は T を評価する(本番 = D1 の時計、テスト = bind した ?3)
      expect(consume).toContain(bindDay ? "?3" : "strftime('%Y-%m-%d','now')");
    }
    const [first, removed] = await env.DB.batch(retentionStatements(env.DB, { runId: "r1", cutoff: Date.now() - 366 * DAY, day: dayA }));
    expect(first!.results).toEqual([{ deleted: 5000, last_limit: 1000 }]);
    expect(removed!.meta.changes).toBe(1000);
    // 日付が変わった後の実行は新しい日の枠で数える。dayA の合計は 5,000 のまま
    await jobOn(dayB).run(ctxOf());
    expect(await count()).toBe(12_000 - 1_000 - 5_000);
    expect(await state()).toMatchObject({ day: dayB, deleted: 5000 });
  });

  it("stale_day_cannot_reopen_quota", async () => {
    await fill(8_000, OLD());
    await setState(dayB, 5_000);
    // 状態の日より古い日付(時計が戻った・古い日付の扱い)では、枠を開け直さない(① が 0 行 → run_id が付かず ② も消さない)
    await jobOn(dayA).run(ctxOf());
    expect(await count()).toBe(8_000);
    expect(await state()).toMatchObject({ day: dayB, deleted: 5000, run_id: "" });
    await jobOn(dayB).run(ctxOf());
    expect(await count()).toBe(8_000);
  });

  it("skips_when_frozen", async () => {
    await fill(10, OLD());
    await freeze();
    expect(await runCron(testEnv, runAt(0), [auditRetentionJob])).toEqual([{ job: "audit-retention", outcome: "skipped_frozen" }]);
    await expect(auditRetentionJob.run(ctxOf())).rejects.toBeInstanceOf(CronFrozen);
    expect(await count()).toBe(10);
    await unfreeze();
    // 確かめと batch の間に凍結が入った: ① が 0 行なので ② も消さず、枠も使わない
    const racing: Env = { ...testEnv, DB: beforeD1Batch(env.DB, freeze) };
    let checks = 0;
    const real = ctxOf(racing);
    const ctx = ctxOf(racing, { assertNotFrozen: async () => (checks++ === 0 ? undefined : real.assertNotFrozen()) });
    await expect(auditRetentionJob.run(ctx)).rejects.toBeInstanceOf(CronFrozen);
    expect(await count()).toBe(10);
    expect(await state()).toMatchObject({ day: "1970-01-01", deleted: 0, run_id: "" });
  });

  it("uses_query_budget", async () => {
    await fill(10, OLD());
    let n = 0;
    const counted = { ...testEnv, DB: countingD1(env.DB, (k) => (n += k)) } as Env;
    // 残りが足りなければ more: true で何もしない(D1 を読まない)
    expect(await auditRetentionJob.run(ctxOf(counted, { queries: { left: () => 4, use: (k) => k <= 4 } }))).toEqual({ more: true });
    expect(n).toBe(0);
    expect(await count()).toBe(10);
    // 足りれば、凍結の確かめ 1 + batch 1 + 件数 1 + 大きさの保存 1
    expect(await auditRetentionJob.run(ctxOf(counted, { queries: { left: () => 5, use: (k) => k <= 5 } }))).toBeUndefined();
    expect(n).toBe(4);
    expect(await count()).toBe(0);
  });

  it("daily_cadence", async () => {
    expect(auditRetentionJob).toMatchObject({ name: "audit-retention", cadence: { daily: { afterUtcHour: 19 } }, writesControl: true });
    // 配分(queryShare)を持たない(結果のジョブの配分表を変えない)。登録表の最後
    expect(auditRetentionJob.queryShare).toBeUndefined();
    expect(CRON_JOBS.at(-1)).toBe(auditRetentionJob);
    await fill(3, OLD());
    expect(await runCron(testEnv, runAt(0) - 2 * HOUR, [auditRetentionJob])).toEqual([{ job: "audit-retention", outcome: "not_due" }]);
    expect(await count()).toBe(3);
    expect(await runCron(testEnv, runAt(0), [auditRetentionJob])).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    expect(await count()).toBe(0);
  });

  it("logs_approximate_count", async () => {
    const approx = async () => (await env.DB.prepare(APPROX_COUNT_SQL).first<{ approx: number | null }>())!.approx;
    expect(await approx()).toBeNull(); // 空の表
    await fill(1, Date.now());
    expect(await approx()).toBe(0); // 1 行
    await fill(4, Date.now());
    expect(await approx()).toBe(4);
    // 表の両端だけを読む(SCAN でない)
    const plan = (await env.DB.prepare(`explain query plan ${APPROX_COUNT_SQL}`).all<{ detail: string }>()).results.map((r) => r.detail);
    const scans = plan.filter((d) => /^SCAN audit_events/.test(d));
    expect(scans).toEqual([]);
    expect(plan.some((d) => /^SEARCH audit_events/.test(d))).toBe(true);

    await fill(2, OLD());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await auditRetentionJob.run(ctxOf());
    const lines = log.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("audit-retention"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deleted 2 row\(s\)/);
    expect(lines[0]).toMatch(/approximately 4 row\(s\)/);
    expect(lines[0]).not.toContain("@");
  });

  it("records_control_db_size", async () => {
    const now = Date.now();
    await auditRetentionJob.run(ctxOf(testEnv, { now }));
    const row = await env.DB.prepare("select value, updated_at, updated_by from instance_settings where key = ?1").bind(CONTROL_DB_SIZE_KEY).first<{ value: string; updated_at: number; updated_by: string | null }>();
    const value = JSON.parse(row!.value) as { sizeBytes: number; measuredAt: number };
    expect(value.sizeBytes).toBeGreaterThan(0);
    expect(Number.isInteger(value.sizeBytes)).toBe(true);
    expect(value.measuredAt).toBe(now);
    expect(row).toMatchObject({ updated_at: now, updated_by: null });
    // 次の実行は上書きする(行は 1 つ)
    await auditRetentionJob.run(ctxOf(testEnv, { now: now + 1 }));
    const rows = await env.DB.prepare("select value from instance_settings where key = ?1").bind(CONTROL_DB_SIZE_KEY).all<{ value: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.parse(rows.results[0]!.value).measuredAt).toBe(now + 1);
  });

  it("delete_5000_rows_time", { timeout: 60_000 }, async () => {
    // 計測だけ(spec §10.3・Q28)。消す 5,000 行がすべて access × password(1 行で主キー 1 + 索引 6 = 7 項目)。
    // ほかに消さない行(content の行・新しい access の行)も入れる
    await fill(5_000, OLD());
    await fill(3_000, Date.now() - 30 * DAY, { category: "content", via: "google" });
    await fill(1_000, Date.now() - 30 * DAY);
    /** D1 の呼び出しごとの rows_written(runner の分を含む) */
    const writes: Array<{ sql: string; written: number; ms: number }> = [];
    const metered = (db: D1Database): D1Database =>
      new Proxy(db, {
        get(t, p) {
          if (p === "batch")
            return async (stmts: D1PreparedStatement[]) => {
              const t0 = performance.now();
              const out = await t.batch(stmts);
              const ms = performance.now() - t0;
              out.forEach((r, i) => writes.push({ sql: `batch[${i}]`, written: r.meta.rows_written ?? 0, ms: i === 0 ? ms : 0 }));
              return out;
            };
          if (p === "prepare")
            return (q: string) => {
              const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(s, {
                  get(st, k) {
                    if (k === "bind") return (...a: unknown[]) => wrap(st.bind(...a));
                    if (k === "run" || k === "all")
                      return async () => {
                        const r = await (Reflect.get(st, k) as () => Promise<D1Result>).call(st);
                        writes.push({ sql: q.replace(/\s+/g, " ").slice(0, 60), written: r.meta.rows_written ?? 0, ms: 0 });
                        return r;
                      };
                    const v = Reflect.get(st, k);
                    return typeof v === "function" ? v.bind(st) : v;
                  },
                });
              return wrap(t.prepare(q));
            };
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as D1Database;
    const e: Env = { ...testEnv, DB: metered(env.DB) };
    const t0 = performance.now();
    expect(await runCron(e, runAt(0), [auditRetentionJob])).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    const total = performance.now() - t0;
    expect(await count()).toBe(4_000);
    const written = writes.reduce((s, w) => s + w.written, 0);
    const batchMs = writes.find((w) => w.sql === "batch[0]")!.ms;
    console.log(`delete_5000_rows_time: batch ${batchMs.toFixed(1)} ms, whole run ${total.toFixed(1)} ms, rows_written ${written}`, JSON.stringify(writes.filter((w) => w.written > 0)));
    // 合否(Q28): ジョブ全体(削除 + 状態の行 + 容量の保存 + 成功の記録)の rows_written が 5,000 × 7 + 固定の数行 以下
    expect(written).toBeLessThanOrEqual(5_000 * 7 + 20);
  });
});

describe("controlCapacity on GET /usage (B129 Task 9, Q10・Q24)", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const CONFIGURED = { CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT } as const;
  const emptyAccount = { workers: [], doRequests: [], doNamespaces: [], doRows: [], doStorage: [], d1: [], d1Storage: [], kv: [], kvStorage: [] };
  beforeEach(() => resetUsageCache());
  /** Cloudflare の使用状況の API の偽物(setupOwner の後に入れる。usage-routes.test.ts と同じ) */
  const mockGraphql = () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.cloudflare.com/client/v4/graphql") return Response.json({ data: { viewer: { accounts: [emptyAccount] } }, errors: null });
      return real(input as RequestInfo, init);
    });
  };
  afterEach(() => vi.restoreAllMocks());
  const usage = async (token: string) => {
    const res = await call("GET", "/usage", { token, envOverride: CONFIGURED });
    expect(res.status).toBe(200);
    return json<{ controlCapacity: { sizeBytes: number; measuredAt: number; level: string } | null }>(res);
  };
  const writeSize = (sizeBytes: number, measuredAt: number) =>
    env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values (?1, ?2, ?3, null) on conflict(key) do update set value = excluded.value")
      .bind(CONTROL_DB_SIZE_KEY, JSON.stringify({ sizeBytes, measuredAt }), measuredAt)
      .run();

  it("control_capacity_null_before_first_run", async () => {
    const owner = await setupOwner();
    mockGraphql();
    expect((await usage(owner.token)).controlCapacity).toBeNull();
    // 読めない値も null(設定の破損で使用状況の口を止めない)
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values (?1, 'not json', 1, null)").bind(CONTROL_DB_SIZE_KEY).run();
    expect((await usage(owner.token)).controlCapacity).toBeNull();
  });

  it("records_control_db_size (GET /usage)", async () => {
    const owner = await setupOwner();
    mockGraphql();
    const now = Date.now();
    await auditRetentionJob.run(ctxOf(testEnv, { now }));
    const cap = (await usage(owner.token)).controlCapacity;
    expect(cap).toMatchObject({ measuredAt: now, level: "ok" });
    expect(cap!.sizeBytes).toBeGreaterThan(0);
    // level は結果の D1 の capacityLevel と同じ閾値(500 MB の 80% / 95%)
    await writeSize(399_999_999, now);
    expect((await usage(owner.token)).controlCapacity).toEqual({ sizeBytes: 399_999_999, measuredAt: now, level: "ok" });
    await writeSize(400_000_000, now);
    expect((await usage(owner.token)).controlCapacity!.level).toBe("warning");
    await writeSize(475_000_000, now);
    expect((await usage(owner.token)).controlCapacity!.level).toBe("critical"); // 計測用の D1 の stopped と同じ閾値(95%)
  });

  /** GET /usage/settings の controlCapacity(使用量の取得が未設定・失敗で GET /usage が 503 でも、画面に大きさを出すため) */
  const settingsCapacity = async (token: string, envOverride?: Record<string, string>) => {
    const res = await call("GET", "/usage/settings", { token, envOverride });
    expect(res.status).toBe(200);
    return (await json<{ controlCapacity: unknown }>(res)).controlCapacity;
  };

  it("control_capacity_on_usage_settings_when_usage_fails", async () => {
    const owner = await setupOwner();
    // まだ測っていなければ null(未設定 = GET /usage は 503)
    expect((await call("GET", "/usage", { token: owner.token })).status).toBe(503);
    expect(await settingsCapacity(owner.token)).toBeNull();
    const now = Date.now();
    await auditRetentionJob.run(ctxOf(testEnv, { now }));
    // 未設定で GET /usage が 503 でも、GET /usage/settings には出る
    expect((await call("GET", "/usage", { token: owner.token })).status).toBe(503);
    expect(await settingsCapacity(owner.token)).toMatchObject({ measuredAt: now, level: "ok" });
    // Cloudflare 側の失敗で GET /usage が 503 でも出る
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    expect((await call("GET", "/usage", { token: owner.token, envOverride: CONFIGURED })).status).toBe(503);
    await writeSize(475_000_000, now);
    expect(await settingsCapacity(owner.token, CONFIGURED)).toEqual({ sizeBytes: 475_000_000, measuredAt: now, level: "critical" });
  });

  it("usage_settings_reads_control_size_in_the_same_select", async () => {
    const owner = await setupOwner();
    await writeSize(1_000, 1);
    // 設定と大きさを instance_settings の 1 回の SELECT で読む(往復は増えない)
    const seen: string[] = [];
    const real = env.DB;
    const db = new Proxy(real, {
      get(t, p) {
        if (p === "prepare") return (q: string) => (q.includes("instance_settings") && seen.push(q), t.prepare(q));
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    const res = await call("GET", "/usage/settings", { token: owner.token, envOverride: { DB: db } as Partial<Env> });
    expect((await json<{ controlCapacity: unknown }>(res)).controlCapacity).toEqual({ sizeBytes: 1_000, measuredAt: 1, level: "ok" });
    const selects = seen.filter((q) => /^select/i.test(q.trim()) && !/writeFreeze/.test(q));
    expect(selects).toHaveLength(1);
  });
});
