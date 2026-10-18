// apps/control/src/cron/runner.ts
import { utcDay } from "@wtt/core";
import { getDb, type Db } from "../db";
import type { Env } from "../env";
import { isWriteFrozen } from "../write-freeze";

/**
 * D9 ②(plan ② の K5・K6、設計書 §9.4): control の Cron の実行の枠。Cron Trigger は 1 本(15 分ごと。wrangler.jsonc の triggers)だけで、
 * ジョブは jobs.ts の登録表に足す(D14・D5 も Trigger を増やさずここに足す想定。採否は各 plan)。
 *
 * - 1 回の実行でジョブを登録の順に 1 本ずつ走らせる。1 本の例外はほかのジョブを止めない(どのジョブも冪等に作る)
 * - 凍結(D13 / 決定 56)は実行の最初に 1 回読み、`writesControl: true` のジョブは凍結中なら丸ごと見送る(K6 案 A)。
 *   さらにジョブは wtt-control に書く区切り(1 回の batch / 1 文)の直前に毎回 `ctx.assertNotFrozen()` を呼ぶ。
 *   凍結の後に残りうる Cron の書き込みは、判定を通った直後の 1 回だけになる
 * - `writesControl: false` のジョブ(予算の DO にだけ書く安全装置など)は凍結中も動かす(spec §13.11 の規則は wtt-control に書く Cron)
 * - `daily` は UTC のその時以降の最初の実行で 1 日 1 回。成功したら cron_job_runs に記録し、失敗・凍結で止めた日は次の実行で取り直す
 */

/** 凍結中に wtt-control へ書こうとした(`assertNotFrozen` が投げる)。そのジョブはそこで止め、残りは次の回 */
export class CronFrozen extends Error {
  constructor() {
    super("write frozen");
    this.name = "CronFrozen";
  }
}

export type CronContext = {
  env: Env;
  db: Db;
  /** この実行の時刻(controller.scheduledTime。epoch ミリ秒) */
  now: number;
  /** wtt-control に書く直前に呼ぶ。毎回凍結を読み直し、凍結中なら CronFrozen を投げる */
  assertNotFrozen(): Promise<void>;
};

export type CronJob = {
  name: string;
  /** tick = 毎回(15 分ごと)/ daily = UTC の afterUtcHour 時以降の最初の実行で 1 日 1 回 */
  cadence: { every: "tick" } | { daily: { afterUtcHour: number } };
  /** wtt-control に書くか。true なら凍結中は見送る。daily は成功の記録を wtt-control に書くので true に限る */
  writesControl: boolean;
  run(ctx: CronContext): Promise<void>;
};

export type CronRunReport = Array<{ job: string; outcome: "ran" | "skipped_frozen" | "stopped_frozen" | "not_due" | "failed" }>;

/** 登録の誤りは、どのジョブも動かす前に断る(K5: daily かつ writesControl: false は成功を記録できない) */
function assertValidJobs(jobs: readonly CronJob[]): void {
  for (const job of jobs) {
    if ("daily" in job.cadence) {
      if (!job.writesControl) throw new Error(`cron job ${job.name}: a daily job must have writesControl: true (its success is recorded in wtt-control)`);
      const h = job.cadence.daily.afterUtcHour;
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`cron job ${job.name}: afterUtcHour must be an integer 0-23`);
    }
  }
}

/** daily のジョブが今日まだ成功しておらず、UTC の時が afterUtcHour 以上か */
async function isDue(db: Db, job: CronJob, now: number): Promise<boolean> {
  if (!("daily" in job.cadence)) return true;
  if (new Date(now).getUTCHours() < job.cadence.daily.afterUtcHour) return false;
  const row = await db.selectFrom("cron_job_runs").select("last_run_day").where("job", "=", job.name).executeTakeFirst();
  return row?.last_run_day !== utcDay(now);
}

async function recordSuccess(db: Db, job: CronJob, now: number): Promise<void> {
  await db
    .insertInto("cron_job_runs")
    .values({ job: job.name, last_run_day: utcDay(now), last_success_at: now })
    .onConflict((oc) => oc.column("job").doUpdateSet((eb) => ({ last_run_day: eb.ref("excluded.last_run_day"), last_success_at: eb.ref("excluded.last_success_at") })))
    .execute();
}

export async function runCron(env: Env, scheduledTime: number, jobs: readonly CronJob[]): Promise<CronRunReport> {
  assertValidJobs(jobs);
  const db = getDb(env);
  const now = scheduledTime;
  // 凍結は最初に 1 回だけ読む(D1 が読めないときも凍結中 = isWriteFrozen の決まり)。書く直前の確かめは assertNotFrozen が読み直す
  const frozenAtStart = await isWriteFrozen(db);
  const ctx: CronContext = {
    env,
    db,
    now,
    async assertNotFrozen() {
      if (await isWriteFrozen(db)) throw new CronFrozen();
    },
  };
  const report: CronRunReport = [];
  for (const job of jobs) {
    if (job.writesControl && frozenAtStart) {
      report.push({ job: job.name, outcome: "skipped_frozen" });
      continue;
    }
    try {
      if (!(await isDue(db, job, now))) {
        report.push({ job: job.name, outcome: "not_due" });
        continue;
      }
      await job.run(ctx);
      // 成功の記録は daily だけ(tick は毎回動くので記録が要らない。writesControl: false のジョブに wtt-control へ書かせない)
      if ("daily" in job.cadence) {
        await ctx.assertNotFrozen();
        await recordSuccess(db, job, now);
      }
      report.push({ job: job.name, outcome: "ran" });
    } catch (e) {
      if (e instanceof CronFrozen) {
        report.push({ job: job.name, outcome: "stopped_frozen" });
      } else {
        console.error(`cron job ${job.name} failed`, e);
        report.push({ job: job.name, outcome: "failed" });
      }
    }
  }
  console.log("cron run", JSON.stringify({ scheduledTime: new Date(now).toISOString(), frozen: frozenAtStart, jobs: report }));
  return report;
}
