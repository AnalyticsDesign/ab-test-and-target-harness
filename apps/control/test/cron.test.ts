// apps/control/test/cron.test.ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronFrozen, runCron, type CronContext, type CronJob } from "../src/cron/runner";
import { CRON_JOBS } from "../src/cron/jobs";
import { resultsAccountGuard } from "../src/cron/account-guard";
import { resultsCapacityJob, resultsCollectUntilJob, resultsDailyJob, resultsDeliveryJob, resultsPurgeJob } from "../src/cron/results-jobs";
import { getDb } from "../src/db";
import type { Env, ResultsBudgetRpc } from "../src/env";
import { writeInstanceSettings } from "../src/instance-settings";
import { resetUsageCache } from "../src/usage";
import { kvKeys } from "@wtt/core";
import { siteSettingsRefreshJob } from "../src/cron/site-settings-refresh";
import { breakGlassSweep } from "../src/cron/break-glass-sweep";
import { configCleanupJob } from "../src/cron/config-cleanup";
import { publishSite } from "../src/publish";
import { siteToSettings } from "../src/site-settings";
import { call, createExperiment, createSite, failingKv, fakeDeployer, runDirect, setupOwner, siteRow, siteWithRunning, testEnv, TEXT_CHANGE } from "./helpers";

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
    // D9 ③(K17): 結果のジョブ 5 本を results-account-guard の後に、この順で(どれも wtt-control に書く)
    expect(CRON_JOBS).toEqual([resultsAccountGuard, resultsDeliveryJob, resultsCollectUntilJob, resultsDailyJob, resultsCapacityJob, resultsPurgeJob, siteSettingsRefreshJob, breakGlassSweep, configCleanupJob]);
    expect(CRON_JOBS.slice(1).map((j) => [j.name, j.cadence, j.writesControl])).toEqual([
      ["results-delivery", { every: "tick" }, true],
      ["results-collect-until", { every: "tick" }, true],
      ["results-daily", { daily: { afterUtcHour: 0 } }, true],
      ["results-capacity", { every: "tick" }, true],
      ["results-purge", { daily: { afterUtcHour: 23 } }, true],
      ["site-settings-refresh", { daily: { afterUtcHour: 0 } }, true],
      ["break-glass-sweep", { every: "tick" }, true],
      ["config-cleanup", { daily: { afterUtcHour: 1 } }, true],
    ]);
    // plan12 K13: 配分(queryShare)を持たない(結果のジョブの配分表を変えない)
    expect(breakGlassSweep.queryShare).toBeUndefined();
    expect(configCleanupJob.queryShare).toBeUndefined();
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
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
    expect(budget.names).toEqual(["global"]);

    // 8 割の手前では止めない
    resetUsageCache();
    vi.restoreAllMocks();
    const below = fakeBudget();
    mockGraphql(workers(79_999));
    await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: below.ns }), NOW, [resultsAccountGuard]);
    expect(below.stop).not.toHaveBeenCalled();
  });

  it("account guard uses d1_rows_written too", async () => {
    const budget = fakeBudget();
    mockGraphql({ ...workers(10), ...d1Written(80_000) });
    await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, [resultsAccountGuard]);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
  });

  it("account guard does nothing on paid or without usage config", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // 使用量の設定が無い: ログだけ(失敗にしない。設定していない導入で 15 分ごとに失敗を出さない)
    const unconfigured = fakeBudget();
    const fetchSpy = mockGraphql(workers(100_000));
    expect(await runCron(envWith({ RESULTS_BUDGET: unconfigured.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(unconfigured.stop).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain("results-account-guard");

    // Paid: 日次の上限が無いので判定しない
    await writeInstanceSettings(getDb(env), { cloudflarePlan: "paid" }, null);
    const paid = fakeBudget();
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: paid.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(paid.stop).not.toHaveBeenCalled();

    // 予算の DO の binding が無い(vitest の既定 = 今の control): 何もしない
    await writeInstanceSettings(getDb(env), { cloudflarePlan: "free" }, null);
    resetUsageCache();
    expect(await runCron(envWith({ ...CONFIGURED }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
  });

  it("account guard logs and does nothing when the usage query fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const budget = fakeBudget();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("account guard fails when the budget DO rejects the stop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const budget = fakeBudget();
    budget.stop.mockRejectedValueOnce(new Error("unreachable"));
    mockGraphql(workers(90_000));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "failed" }]);
    expect(error).toHaveBeenCalled();
  });

  it("account guard runs while frozen", async () => {
    await freeze();
    const budget = fakeBudget();
    mockGraphql(workers(80_000));
    expect(await runCron(envWith({ ...CONFIGURED, RESULTS_BUDGET: budget.ns }), NOW, [resultsAccountGuard])).toEqual([{ job: "results-account-guard", outcome: "ran" }]);
    expect(budget.stop).toHaveBeenCalledExactlyOnceWith("account_usage", NEXT_MIDNIGHT, NOW);
    expect(await jobRuns()).toEqual([]); // wtt-control に書かない(成功の記録も書かない)
  });
});

// plan12 K10: site-settings-refresh(KV の Site の設定の記録を D1 + プランの既定から組み立て直して合わせる)
describe("site-settings-refresh (plan12 K10)", () => {
  afterEach(() => vi.restoreAllMocks());
  const T = at("2026-10-21T00:30:00Z");
  const kvRaw = (sid: string) => env.CONFIG_KV.get(kvKeys.settings(sid));
  const kvJson = async (sid: string) => JSON.parse((await kvRaw(sid))!) as Record<string, unknown>;
  /** put の回数を数える KV(他の操作は本物に委譲) */
  function countingKv() {
    const puts: string[] = [];
    const kv = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "put") return (key: string, ...rest: unknown[]) => (puts.push(key), (v as Function).call(target, key, ...rest));
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { kv, puts };
  }
  /** 予算の入る前の記録(この plan を deploy した直後の既存サイト)に戻す */
  const stripBudget = async (sid: string) => env.CONFIG_KV.put(kvKeys.settings(sid), JSON.stringify(siteToSettings(await siteRow(sid))));

  it("is registered as a daily job that writes control", () => {
    expect(siteSettingsRefreshJob).toMatchObject({ name: "site-settings-refresh", cadence: { daily: { afterUtcHour: 0 } }, writesControl: true });
    expect(CRON_JOBS).toContain(siteSettingsRefreshJob);
  });

  it("writes the budget into existing records and puts only the sites whose record differs", async () => {
    const owner = await setupOwner();
    const a = await createSite(owner.token, owner.workspaceId);
    const b = await createSite(owner.token, owner.workspaceId, { domain: "b.example.com" });
    await stripBudget(a.id);
    const { kv, puts } = countingKv();
    expect(await runCron({ ...testEnv, CONFIG_KV: kv }, T, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "ran" }]);
    expect((await kvJson(a.id)).newProfileBudget).toEqual({ perDay: 20_000, instancePerDay: 20_000 });
    expect(puts).toEqual([kvKeys.settings(a.id)]); // b は同じなので put しない
    expect(await kvRaw(b.id)).not.toBeNull();
  });

  it("repairs a stale value left by the residual patch race (CL-Medium-11)", async () => {
    const owner = await setupOwner();
    const a = await createSite(owner.token, owner.workspaceId);
    await call("PATCH", `/sites/${a.id}`, { token: owner.token, body: { newProfileBudgetPerDay: 5000 } });
    // PATCH の KV の put と D1 の確定の間に、古い行で組み立てた記録が KV に残った状態
    await env.CONFIG_KV.put(kvKeys.settings(a.id), JSON.stringify({ ...siteToSettings(await siteRow(a.id)), newProfileBudget: { perDay: 20_000, instancePerDay: 20_000 } }));
    await runCron(testEnv, T, [siteSettingsRefreshJob]);
    expect((await kvJson(a.id)).newProfileBudget).toEqual({ perDay: 5000, instancePerDay: 20_000 });
  });

  it("does nothing while frozen and catches up after", async () => {
    const owner = await setupOwner();
    const a = await createSite(owner.token, owner.workspaceId);
    await stripBudget(a.id);
    await freeze();
    expect(await runCron(testEnv, T, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "skipped_frozen" }]);
    expect((await kvJson(a.id)).newProfileBudget).toBeUndefined();
    await unfreeze();
    expect(await runCron(testEnv, T + 15 * 60_000, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "ran" }]);
    expect((await kvJson(a.id)).newProfileBudget).toBeDefined();
  });

  it("stops without writing when the freeze starts after the run began", async () => {
    const owner = await setupOwner();
    const a = await createSite(owner.token, owner.workspaceId);
    await stripBudget(a.id);
    const kv = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "get") return async (...args: unknown[]) => ((await freeze()), (v as Function).apply(target, args));
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(await runCron({ ...testEnv, CONFIG_KV: kv }, T, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "stopped_frozen" }]);
    expect((await kvJson(a.id)).newProfileBudget).toBeUndefined();
  });

  it("carries the position over to the next day unless it is END", async () => {
    const owner = await setupOwner();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createSite(owner.token, owner.workspaceId, { domain: `c${i}.example.com` })).id);
    ids.sort();
    for (const id of ids) await stripBudget(id);
    // 前日に途中まで回った(ids[0] まで)。今日はその続きから: ids[0] は触らず、ids[1]・ids[2] を直す
    await env.DB.prepare("insert into cron_cursors (job, day, cursor) values ('site-settings-refresh', '2026-10-20', ?)").bind(ids[0]).run();
    expect(await runCron(testEnv, T, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "ran" }]);
    expect((await kvJson(ids[0]!)).newProfileBudget).toBeUndefined();
    expect((await kvJson(ids[1]!)).newProfileBudget).toBeDefined();
    expect((await kvJson(ids[2]!)).newProfileBudget).toBeDefined();
    // 末尾まで回ったので位置は END(その日は終わり)。翌日は先頭から全サイトを見直す
    expect(await env.DB.prepare("select day, cursor from cron_cursors where job = 'site-settings-refresh'").first()).toEqual({ day: "2026-10-21", cursor: "#end" });
    await stripBudget(ids[0]!);
    expect(await runCron(testEnv, T + 24 * 3_600_000, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "ran" }]);
    expect((await kvJson(ids[0]!)).newProfileBudget).toBeDefined();
  });

  it("covers more sites than one page across runs and records success only at the end", async () => {
    const owner = await setupOwner();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await createSite(owner.token, owner.workspaceId, { domain: `s${i}.example.com` })).id);
    for (const id of ids) await stripBudget(id);
    const first = await runCron(testEnv, T, [siteSettingsRefreshJob]);
    expect(first).toEqual([{ job: "site-settings-refresh", outcome: "continued" }]);
    expect((await jobRuns()).find((r) => r.job === "site-settings-refresh")).toBeUndefined();
    expect(await runCron(testEnv, T + 15 * 60_000, [siteSettingsRefreshJob])).toEqual([{ job: "site-settings-refresh", outcome: "ran" }]);
    for (const id of ids) expect((await kvJson(id)).newProfileBudget).toBeDefined();
  });
});

// plan12 K14 (b): config-cleanup(古い版の config を公開の無い日にも消す)
describe("config-cleanup (plan12 K14 (b))", () => {
  afterEach(() => vi.restoreAllMocks());
  const t0 = 1_800_000_000_000; // 公開の時刻(テスト用の固定値)
  const T = t0 + 2 * 3_600_000; // 公開の 2 時間後(UTC の時刻は 1 時以降になるよう下で確かめる)
  /** 配信ファイルが配る版を記録させるため、常に deployed を返す偽のデプロイ専用の Worker を入れる(これが無いと掃除は何も消さない) */
  const deployEnv = (over: Partial<Env> = {}): Env => ({ ...testEnv, DEPLOYER: fakeDeployer(), ...over });
  const configExists = async (sid: string, v: number) => (await env.CONFIG_KV.get(kvKeys.config(sid, v))) !== null;
  /** 公開を n 回する(時刻は 1 秒ずつ。5 分以内なので公開のときの掃除は何も消さない) */
  async function publishTimes(owner: Awaited<ReturnType<typeof setupOwner>>, sid: string, n: number) {
    for (let i = 0; i < n; i++) expect((await publishSite(deployEnv(), getDb(env), await siteRow(sid), owner.userId, t0 + i * 1000)).ok).toBe(true);
  }
  async function secondSite(owner: Awaited<ReturnType<typeof setupOwner>>) {
    const { id: sid } = await createSite(owner.token, owner.workspaceId, { id: "site_second", domain: "second.example.com" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_second" });
    await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await runDirect(sid, eid);
    return sid;
  }

  it("is registered last as a daily job that writes control and has no query share", () => {
    expect(new Date(T).getUTCHours()).toBeGreaterThanOrEqual(1);
    expect(configCleanupJob).toMatchObject({ name: "config-cleanup", cadence: { daily: { afterUtcHour: 1 } }, writesControl: true });
    expect(configCleanupJob.queryShare).toBeUndefined();
    expect(CRON_JOBS.at(-1)).toBe(configCleanupJob);
  });

  it("deletes the retired versions on a day without a publish and keeps the served one", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishTimes(owner, sid, 3);
    for (let v = 1; v <= 3; v++) expect(await configExists(sid, v)).toBe(true); // 公開のときの掃除は 5 分以内の版を消さない
    expect(await runCron(deployEnv(), T, [configCleanupJob])).toEqual([{ job: "config-cleanup", outcome: "ran" }]);
    expect(await configExists(sid, 1)).toBe(false);
    expect(await configExists(sid, 2)).toBe(false);
    expect(await configExists(sid, 3)).toBe(true);
    const marks = await getDb(env).selectFrom("publishes").select(["version", "kv_deleted"]).where("site_id", "=", sid).orderBy("version").execute();
    expect(marks.map((r) => [r.version, r.kv_deleted])).toEqual([[1, 1], [2, 1], [3, 0]]);
    // 位置は「その日は終わり」になる
    expect(await env.DB.prepare("select day, cursor from cron_cursors where job = 'config-cleanup'").first()).toEqual({ day: new Date(T).toISOString().slice(0, 10), cursor: "#end" });
  });

  it("deletes nothing for a site whose kv cannot be read (fail-closed) and still cleans the others", async () => {
    const { owner, sid } = await siteWithRunning();
    const other = await secondSite(owner);
    await publishTimes(owner, sid, 3);
    await publishTimes(owner, other, 3);
    const run = await runCron(deployEnv({ CONFIG_KV: failingKv(new RegExp(`^${kvKeys.active(sid)}$`), "get") }), T, [configCleanupJob]);
    expect(run).toEqual([{ job: "config-cleanup", outcome: "ran" }]);
    for (let v = 1; v <= 3; v++) expect(await configExists(sid, v)).toBe(true); // 読めないサイトは何も消さない
    expect(await configExists(other, 1)).toBe(false);
    expect(await configExists(other, 2)).toBe(false);
    expect(await configExists(other, 3)).toBe(true);
  });

  it("does nothing while frozen, and stops before deleting when the freeze starts during the run", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishTimes(owner, sid, 3);
    await freeze();
    expect(await runCron(deployEnv(), T, [configCleanupJob])).toEqual([{ job: "config-cleanup", outcome: "skipped_frozen" }]);
    for (let v = 1; v <= 3; v++) expect(await configExists(sid, v)).toBe(true);
    await unfreeze();
    // 実行の最初は凍結していないが、KV の active を読んだ後(消す直前の確かめの前)に凍結が入る
    const freezingKv = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "get")
          return async (key: string, ...rest: unknown[]) => {
            const r = await (target.get as (...a: unknown[]) => unknown).apply(target, [key, ...rest]);
            if (key === kvKeys.active(sid)) await freeze();
            return r;
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as KVNamespace;
    expect(await runCron(deployEnv({ CONFIG_KV: freezingKv }), T, [configCleanupJob])).toEqual([{ job: "config-cleanup", outcome: "stopped_frozen" }]);
    for (let v = 1; v <= 3; v++) expect(await configExists(sid, v)).toBe(true);
    await unfreeze();
    // 凍結が明けた次の実行で消える(日の記録は成功したときだけ)
    expect(await runCron(deployEnv(), T + 15 * 60_000, [configCleanupJob])).toEqual([{ job: "config-cleanup", outcome: "ran" }]);
    expect(await configExists(sid, 1)).toBe(false);
  });

  it("leaves a site without an active version alone and ends the day", async () => {
    const owner = await setupOwner();
    await createSite(owner.token, owner.workspaceId); // 公開していない(active_version が無い)サイトは対象外
    expect(await runCron(deployEnv(), T, [configCleanupJob])).toEqual([{ job: "config-cleanup", outcome: "ran" }]);
    expect(await env.DB.prepare("select cursor from cron_cursors where job = 'config-cleanup'").first()).toEqual({ cursor: "#end" });
  });
});
