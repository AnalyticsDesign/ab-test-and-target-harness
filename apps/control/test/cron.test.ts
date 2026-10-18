// apps/control/test/cron.test.ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronFrozen, runCron, type CronContext, type CronJob } from "../src/cron/runner";
import { CRON_JOBS } from "../src/cron/jobs";
import { resultsAccountGuard } from "../src/cron/account-guard";
import { getDb } from "../src/db";
import type { Env, ResultsBudgetRpc } from "../src/env";
import { writeInstanceSettings } from "../src/instance-settings";
import { resetUsageCache } from "../src/usage";
import { testEnv } from "./helpers";

// D9 ②(plan ② の K5・K6・K12、設計書 §9.4・§6.9)

/** 凍結の行を直接書く(運用者が deploy.md の SQL で書くのと同じ形) */
async function freeze(): Promise<void> {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null) on conflict(key) do nothing").run();
}
async function unfreeze(): Promise<void> {
  await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
}
async function jobRuns(): Promise<Array<{ job: string; last_run_day: string | null; last_success_at: number | null }>> {
  return (await env.DB.prepare("select job, last_run_day, last_success_at from cron_job_runs order by job").all<{ job: string; last_run_day: string | null; last_success_at: number | null }>()).results;
}

/** 偽のジョブ。run の中身は呼び出しごとに差し替える */
function fakeJob(name: string, opts: Partial<Omit<CronJob, "name">> = {}): CronJob & { calls: number } {
  const j = {
    name,
    cadence: opts.cadence ?? { every: "tick" as const },
    writesControl: opts.writesControl ?? true,
    calls: 0,
    async run(ctx: CronContext) {
      j.calls++;
      await opts.run?.(ctx);
    },
  };
  return j;
}

const at = (iso: string) => Date.parse(iso);

describe("cron runner (D9 ② K5・K6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cron_skips_control_writes_while_frozen", async () => {
    const writes = fakeJob("writes", { writesControl: true });
    const guard = fakeJob("guard", { writesControl: false });
    await freeze();
    const report = await runCron(testEnv, at("2026-10-17T10:00:00Z"), [writes, guard]);
    expect(report).toEqual([
      { job: "writes", outcome: "skipped_frozen" },
      { job: "guard", outcome: "ran" },
    ]);
    expect(writes.calls).toBe(0);
    expect(guard.calls).toBe(1);
    await unfreeze();
    expect(await runCron(testEnv, at("2026-10-17T10:15:00Z"), [writes, guard])).toEqual([
      { job: "writes", outcome: "ran" },
      { job: "guard", outcome: "ran" },
    ]);
  });

  it("cron_stops_job_at_next_write_after_freeze", async () => {
    const written: number[] = [];
    const job = fakeJob("batches", {
      cadence: { daily: { afterUtcHour: 0 } },
      async run(ctx) {
        await ctx.assertNotFrozen();
        written.push(1);
        await freeze(); // 1 回目の書き込みの後に、作業者が凍結を入れた
        await ctx.assertNotFrozen();
        written.push(2);
      },
    });
    const after = fakeJob("after", { writesControl: true });
    const report = await runCron(testEnv, at("2026-10-17T01:00:00Z"), [job, after]);
    // 凍結は実行の最初に 1 回だけ読むので、後のジョブは見送りではなく動く(K6: 凍結の後に残りうるのは判定を通った直後の 1 回)
    expect(report).toEqual([
      { job: "batches", outcome: "stopped_frozen" },
      { job: "after", outcome: "ran" },
    ]);
    expect(written).toEqual([1]);
    expect(await jobRuns()).toEqual([]); // 止めた日は成功として記録しない(次の回で取り直す)
  });

  it("daily job runs once per UTC day after the hour", async () => {
    const job = fakeJob("nightly", { cadence: { daily: { afterUtcHour: 23 } } });
    const run = (iso: string) => runCron(testEnv, at(iso), [job]);
    expect(await run("2026-10-17T22:45:00Z")).toEqual([{ job: "nightly", outcome: "not_due" }]);
    expect(await run("2026-10-17T23:00:00Z")).toEqual([{ job: "nightly", outcome: "ran" }]);
    expect(await jobRuns()).toEqual([{ job: "nightly", last_run_day: "2026-10-17", last_success_at: at("2026-10-17T23:00:00Z") }]);
    expect(await run("2026-10-17T23:15:00Z")).toEqual([{ job: "nightly", outcome: "not_due" }]);
    expect(await run("2026-10-18T22:45:00Z")).toEqual([{ job: "nightly", outcome: "not_due" }]);
    expect(await run("2026-10-18T23:00:00Z")).toEqual([{ job: "nightly", outcome: "ran" }]);
    expect(job.calls).toBe(2);
    expect(await jobRuns()).toEqual([{ job: "nightly", last_run_day: "2026-10-18", last_success_at: at("2026-10-18T23:00:00Z") }]);
  });

  it("daily job retries on the next tick after failure or freeze", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let mode: "throw" | "ok" | "freeze" = "throw";
    const job = fakeJob("nightly", {
      cadence: { daily: { afterUtcHour: 23 } },
      async run() {
        if (mode === "throw") throw new Error("boom");
        if (mode === "freeze") await freeze(); // 仕事は終えたが、成功を記録する直前に凍結が入った
      },
    });
    const run = (iso: string) => runCron(testEnv, at(iso), [job]);
    // 失敗 → 記録しない → 次の回で取り直す
    expect(await run("2026-10-17T23:00:00Z")).toEqual([{ job: "nightly", outcome: "failed" }]);
    expect(error).toHaveBeenCalled();
    expect(await jobRuns()).toEqual([]);
    mode = "ok";
    expect(await run("2026-10-17T23:15:00Z")).toEqual([{ job: "nightly", outcome: "ran" }]);
    expect(await jobRuns()).toEqual([{ job: "nightly", last_run_day: "2026-10-17", last_success_at: at("2026-10-17T23:15:00Z") }]);
    // 凍結で止めた日 → 記録しない → 凍結中の回は見送り → 外した後の回で取り直す
    mode = "freeze";
    expect(await run("2026-10-18T23:00:00Z")).toEqual([{ job: "nightly", outcome: "stopped_frozen" }]);
    expect((await jobRuns())[0]!.last_run_day).toBe("2026-10-17");
    mode = "ok";
    expect(await run("2026-10-18T23:15:00Z")).toEqual([{ job: "nightly", outcome: "skipped_frozen" }]);
    await unfreeze();
    expect(await run("2026-10-18T23:30:00Z")).toEqual([{ job: "nightly", outcome: "ran" }]);
    expect(await jobRuns()).toEqual([{ job: "nightly", last_run_day: "2026-10-18", last_success_at: at("2026-10-18T23:30:00Z") }]);
  });

  it("one failing job does not stop the others", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = fakeJob("first", {
      async run() {
        throw new Error("boom");
      },
    });
    const second = fakeJob("second");
    const third = fakeJob("third", {
      cadence: { daily: { afterUtcHour: 0 } },
      async run() {
        throw new CronFrozen();
      },
    });
    const fourth = fakeJob("fourth", { writesControl: false });
    expect(await runCron(testEnv, at("2026-10-17T10:00:00Z"), [first, second, third, fourth])).toEqual([
      { job: "first", outcome: "failed" },
      { job: "second", outcome: "ran" },
      { job: "third", outcome: "stopped_frozen" },
      { job: "fourth", outcome: "ran" },
    ]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("daily_job_must_write_control", async () => {
    const ok = fakeJob("ok");
    const bad = fakeJob("bad", { cadence: { daily: { afterUtcHour: 0 } }, writesControl: false });
    await expect(runCron(testEnv, at("2026-10-17T10:00:00Z"), [ok, bad])).rejects.toThrow(/bad/);
    expect(ok.calls).toBe(0); // 起動の時点で断る(登録の誤りを、どのジョブも動かす前に見つける)
    expect(bad.calls).toBe(0);
  });

  it("registers the account guard in CRON_JOBS", () => {
    expect(CRON_JOBS).toEqual([resultsAccountGuard]);
    expect(resultsAccountGuard).toMatchObject({ name: "results-account-guard", cadence: { every: "tick" }, writesControl: false });
  });
});

// K12: 使用量の 8 割で結果の収集を止める
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONFIGURED = { CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT } as const;
const emptyAccount = { workers: [], doRequests: [], doNamespaces: [], doRows: [], doStorage: [], d1: [], d1Storage: [], kv: [], kvStorage: [] };

function mockGraphql(account: Record<string, unknown[]>) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.cloudflare.com/client/v4/graphql") return Response.json({ data: { viewer: { accounts: [{ ...emptyAccount, ...account }] } }, errors: null });
    return real(input as RequestInfo, init);
  });
}
const workers = (requests: number) => ({ workers: [{ dimensions: { scriptName: "wtt-edge" }, sum: { requests } }] });
const d1Written = (rowsWritten: number) => ({ d1: [{ dimensions: { databaseId: "db" }, sum: { rowsRead: 0, rowsWritten } }] });

/** 偽の予算の DO。idFromName の名前と stop の引数を記録する */
function fakeBudget() {
  const names: string[] = [];
  const stop = vi.fn(async (_reason: string, _until: number, _now: number) => {});
  const ns = {
    idFromName: (name: string) => {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get: () => ({ stop }),
  } as unknown as DurableObjectNamespace<ResultsBudgetRpc>;
  return { ns, stop, names };
}

const NOW = Date.parse("2026-10-17T10:00:00Z");
const NEXT_MIDNIGHT = Date.parse("2026-10-18T00:00:00Z");
const envWith = (o: Partial<Env>): Env => ({ ...testEnv, ...o });

describe("results account guard (D9 ② K12)", () => {
  beforeEach(() => resetUsageCache());
  afterEach(() => vi.restoreAllMocks());

  it("account guard stops collection at 80 percent on free", async () => {
    const budget = fakeBudget();
    mockGraphql(workers(80_000));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
    expect(budget.names).toEqual(["global"]);

    // 8 割の手前では止めない
    resetUsageCache();
    vi.restoreAllMocks();
    const below = fakeBudget();
    mockGraphql(workers(79_999));
    await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: below.ns }), NOW, CRON_JOBS);
    expect(below.stop).not.toHaveBeenCalled();
  });

  it("account guard uses d1_rows_written too", async () => {
    const budget = fakeBudget();
    mockGraphql({ ...workers(10), ...d1Written(80_000) });
    await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, CRON_JOBS);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
  });

  it("account guard does nothing on paid or without usage config", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // 使用量の設定が無い: ログだけ(失敗にしない。設定していない導入で 15 分ごとに失敗を出さない)
    const unconfigured = fakeBudget();
    const fetchSpy = mockGraphql(workers(100_000));
    expect(await runCron(envWith({ RESULTS_BUDGET: unconfigured.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(unconfigured.stop).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain("results-account-guard");

    // Paid: 日次の上限が無いので判定しない
    await writeInstanceSettings(getDb(env), { cloudflarePlan: "paid" }, null);
    const paid = fakeBudget();
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: paid.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(paid.stop).not.toHaveBeenCalled();

    // 予算の DO の binding が無い(vitest の既定 = 今の control): 何もしない
    await writeInstanceSettings(getDb(env), { cloudflarePlan: "free" }, null);
    resetUsageCache();
    expect(await runCron(envWith({ ...CONFIGURED }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
  });

  it("account guard logs and does nothing when the usage query fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const budget = fakeBudget();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("account guard fails when the budget DO rejects the stop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const budget = fakeBudget();
    budget.stop.mockRejectedValueOnce(new Error("unreachable"));
    mockGraphql(workers(90_000));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "failed" }]);
    expect(error).toHaveBeenCalled();
  });

  it("account guard runs while frozen", async () => {
    await freeze();
    const budget = fakeBudget();
    mockGraphql(workers(80_000));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, CRON_JOBS)).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
    expect(await jobRuns()).toEqual([]); // wtt-control に書かない(成功の記録も書かない)
  });
});
