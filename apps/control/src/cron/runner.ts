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
 * - D9 ③(plan ③ の K17): run が `{ more: true }` を返したら成功を記録せず(報告は continued)、同じ日の次の実行で続ける。
 *   1 回の実行の D1 のクエリの数は QUERY_LIMIT を配分(queryShare)を持つジョブで分け合う(ctx.queries)
 */

/** 凍結中に wtt-control へ書こうとした(`assertNotFrozen` が投げる)。そのジョブはそこで止め、残りは次の回 */
export class CronFrozen extends Error {
  constructor() {
    super("write frozen");
    this.name = "CronFrozen";
  }
}

/**
 * D9 ③(plan ③ の K17): 1 回の実行の D1 のクエリの数の残り。
 * - 数えるのは、配分を持つジョブが ctx.env / ctx.db を通して D1(wtt-control・wtt-results)に出した呼び出しの実数
 *   (prepare した文の run / all / first / raw が 1 件、batch も 1 件)。ジョブの中の ctx.assertNotFrozen の読み取りも数える
 * - left() = そのジョブの配分の残りと、全体(QUERY_LIMIT)の残りの小さい方
 * - use(n) = 次の n 件を出してよいか(足りなければ false)。引くのは実際の呼び出しの数なので、use では引かない。
 *   ジョブは 1 件の処理の前に、その処理の見込みの件数で use を呼び、false なら `{ more: true }` を返して次の実行に続ける
 *   (1 件の処理は途中で止めないので、見込みを超えた分はそのジョブの残りを減らす)
 * - runner 自身(凍結・daily の記録)と、配分を持たないジョブ(results-account-guard)の分は数えない(上限 50 との差に入る)
 */
export type QueryBudget = { left(): number; use(n: number): boolean };

export type CronContext = {
  env: Env;
  db: Db;
  /** この実行の時刻(controller.scheduledTime。epoch ミリ秒) */
  now: number;
  /** wtt-control に書く直前に呼ぶ。毎回凍結を読み直し、凍結中なら CronFrozen を投げる */
  assertNotFrozen(): Promise<void>;
  /** この実行のクエリの数の残り(K17) */
  queries: QueryBudget;
};

export type CronJob = {
  name: string;
  /** tick = 毎回(15 分ごと)/ daily = UTC の afterUtcHour 時以降の最初の実行で 1 日 1 回 */
  cadence: { every: "tick" } | { daily: { afterUtcHour: number } };
  /** wtt-control に書くか。true なら凍結中は見送る。daily は成功の記録を wtt-control に書くので true に限る */
  writesControl: boolean;
  /** 1 回の実行で使ってよい D1 のクエリの数(K17)。無ければ数えない(runner の分に入る) */
  queryShare?: number;
  /** 登録の順に関係なく配分を残す(後ろにあっても、前のジョブが使い切らない。results-capacity)。allotQueries */
  queryReserved?: boolean;
  /** 1 件を処理するのに要る配分の最低(位置・対象の読み取りと位置の書き込みを含む)。配分がこれに届かない実行では動かさない。allotQueries */
  queryFloor?: number;
  /** `{ more: true }` = 配分か 1 回の量を使い切り、続きが残っている(成功を記録せず、次の実行で続ける。K17) */
  run(ctx: CronContext): Promise<void | { more: true }>;
};

export type CronRunReport = Array<{ job: string; outcome: "ran" | "continued" | "skipped_frozen" | "stopped_frozen" | "not_due" | "failed" }>;

/**
 * 1 回の実行で配分を持つジョブが出してよい D1 のクエリの数(K17)。D1 の「Queries per Worker invocation」(Free 50)から、
 * runner と results-account-guard の分を残した値。**仮の値**: batch の文を 1 件と数えるか・今も D1 独自に効く上限かは公式に未確認
 * (docs/dev/research/d1_batch_query_limits_2026-10-06.md)。ここでは batch を 1 件と数える(調査の記録: workerd は batch の全文を
 * 1 回の fetch = 1 サブリクエストで送り、D1 の表の行は Workers のサブリクエストの上限を D1 の言葉で書いたもの)。
 * 文ごとに数えられる場合の余裕は、50 との差(runner と results-account-guard の分を除いた残り)だけになる
 */
export const QUERY_LIMIT = 40;

/** 包んだ文 → 元の文(batch には元の文を渡す。workerd / miniflare の batch は文の中身を直接読むため) */
const ORIGINAL = new WeakMap<object, D1PreparedStatement>();

/** 呼び出しの数を count に渡す D1 の包み(K17) */
export function countingD1(db: D1Database, count: (n: number) => void): D1Database {
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "all" || p === "first" || p === "raw") {
          const f = Reflect.get(s, p) as (...a: unknown[]) => unknown;
          return (...args: unknown[]) => {
            count(1);
            return f.apply(s, args);
          };
        }
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
    ORIGINAL.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q));
      if (prop === "batch")
        return (stmts: D1PreparedStatement[]) => {
          count(1);
          return target.batch(stmts.map((x) => ORIGINAL.get(x) ?? x));
        };
      if (prop === "exec")
        return (q: string) => {
          count(1);
          return target.exec(q);
        };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

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


/**
 * D9 ③(plan ③ の K17、fix round 2 の controller の決定): その実行での各ジョブの配分。
 * - queryReserved のジョブ(results-capacity)は、いつも宣言した queryShare を先に残す(登録の順に関係なく)
 * - daily のジョブがどれも due でない実行: tick のジョブは宣言した queryShare
 * - daily のジョブが due の実行は、15 分の枠の番号(floor(時刻 / 15 分))の偶奇で優先を替える(どのジョブも 30 分に 1 回は進む):
 *   - 偶数 = tick 優先: tick のジョブに 1 件の最低(queryFloor)を先に残し、残りを due の daily のジョブに登録の順で配る(宣言した配分まで)
 *   - 奇数 = daily 優先: due の daily のジョブに登録の順で max(配分, 1 件の最低) を配り、残りを tick のジョブに登録の順で配る
 * - tick のジョブの配分は、宣言した queryShare と計算した残りの小さい方
 * - 配分が 1 件の最低(queryFloor)に届かないジョブは動かさない(位置も読まない。報告は continued)
 *
 * 今の登録(jobs.ts)での配分(合計は 40 以内):
 * | 実行                                   | delivery | collect-until | daily | capacity | purge |
 * | -------------------------------------- | -------- | ------------- | ----- | -------- | ----- |
 * | daily のジョブが due でない            | 10       | 8             | –     | 3        | –     |
 * | results-daily が due・tick 優先の枠    | 10       | 6             | 21    | 3        | –     |
 * | results-daily が due・daily 優先の枠   | 10       | 1(最低 6 未満で動かない) | 26 | 3 | – |
 * | results-purge が due・tick 優先の枠    | 10       | 6             | –     | 3        | 16    |
 * | results-purge が due・daily 優先の枠   | 10       | 8             | –     | 3        | 16    |
 * | 両方が due・tick 優先の枠              | 10       | 6             | 21    | 3        | 0(動かない) |
 * | 両方が due・daily 優先の枠             | 0        | 0             | 26    | 3        | 11    |
 * 1 件の最低: delivery 10・collect-until 6・daily 10(到達の確認 1 件)・purge 10(繰り返し 1 回)・capacity 2。
 * 記録 1 件(位置と対象の読み取り 3 + 記録 21 + 位置の書き込み 1 = 25)は daily 優先の枠の 26 に収まる。tick 優先の枠の 21 では到達の確認だけが進む。
 * どのジョブも、daily が due の日でも 30 分(2 枠)に 1 回は 1 件の最低以上の配分を受ける
 */
export const SLOT_MS = 15 * 60 * 1000;
export const isTickPrioritySlot = (now: number): boolean => Math.floor(now / SLOT_MS) % 2 === 0;

export function allotQueries(jobs: readonly CronJob[], due: ReadonlySet<string>, now: number): Map<string, number> {
  const out = new Map<string, number>();
  const shared = jobs.filter((j) => j.queryShare !== undefined);
  const reserved = shared.filter((j) => j.queryReserved);
  const dailies = shared.filter((j) => !j.queryReserved && "daily" in j.cadence && due.has(j.name));
  const ticks = shared.filter((j) => !j.queryReserved && !("daily" in j.cadence));
  let rest = QUERY_LIMIT;
  for (const j of reserved) {
    out.set(j.name, j.queryShare!);
    rest -= j.queryShare!;
  }
  const give = (j: CronJob, want: number) => {
    const n = Math.max(0, Math.min(want, rest));
    out.set(j.name, n);
    rest -= n;
  };
  if (dailies.length === 0) {
    for (const j of ticks) give(j, j.queryShare!);
  } else if (isTickPrioritySlot(now)) {
    for (const j of ticks) give(j, Math.min(j.queryShare!, j.queryFloor ?? j.queryShare!));
    for (const j of dailies) give(j, j.queryShare!);
  } else {
    for (const j of dailies) give(j, Math.max(j.queryShare!, j.queryFloor ?? 0));
    for (const j of ticks) give(j, j.queryShare!);
  }
  // due でない daily のジョブは動かないが、表に宣言の値を入れておく(isDue で not_due になる)
  for (const j of shared) if (!out.has(j.name)) out.set(j.name, j.queryShare!);
  return out;
}

export async function runCron(env: Env, scheduledTime: number, jobs: readonly CronJob[]): Promise<CronRunReport> {
  assertValidJobs(jobs);
  const db = getDb(env);
  const now = scheduledTime;
  // 凍結は最初に 1 回だけ読む(D1 が読めないときも凍結中 = isWriteFrozen の決まり)。書く直前の確かめは assertNotFrozen が読み直す
  const frozenAtStart = await isWriteFrozen(db);
  // 今回動くジョブ(凍結で見送るものを除く)と、daily の due を先に決める(配分を決めるため。読み取りの数は前と同じ)
  const runnable = jobs.filter((j) => !(j.writesControl && frozenAtStart));
  const due = new Map<string, boolean | Error>();
  for (const job of runnable) {
    try {
      due.set(job.name, await isDue(db, job, now));
    } catch (e) {
      due.set(job.name, e as Error);
    }
  }
  const allot = allotQueries(runnable, new Set([...due].filter(([, d]) => d === true).map(([n]) => n)), now);
  /** 動くジョブ = due で、配分が 1 件の最低に届くもの */
  const willRun = (j: CronJob) => due.get(j.name) === true && (j.queryShare === undefined || allot.get(j.name)! >= (j.queryFloor ?? 1));
  // K17: 配分を持つジョブが出したクエリの実数(全体)
  let spent = 0;
  const report: CronRunReport = [];
  for (const [i, job] of jobs.entries()) {
    if (job.writesControl && frozenAtStart) {
      report.push({ job: job.name, outcome: "skipped_frozen" });
      continue;
    }
    // 後ろで動く予定のジョブの配分。このジョブの全体の残りから引いて残す(このジョブが後ろの配分に食い込む件を始めないため)。
    // 前のジョブが 1 件の見込みを超えた分は全体の残りを減らすので、後ろのジョブが実際に使える数は配分より少なくなりうる
    // (下で実行の時点の残りを最低と比べる)
    const held = jobs
      .slice(i + 1)
      .filter((j) => runnable.includes(j) && willRun(j) && j.queryShare !== undefined)
      .reduce((s, j) => s + allot.get(j.name)!, 0);
    const ctx = jobContext(env, db, job, now, allot.get(job.name), () => spent + held, (n) => (spent += n));
    try {
      const d = due.get(job.name);
      if (d instanceof Error) throw d;
      if (!d) {
        report.push({ job: job.name, outcome: "not_due" });
        continue;
      }
      if (!willRun(job) || (job.queryShare !== undefined && ctx.queries.left() < (job.queryFloor ?? 1))) {
        // 配分か、実行の時点の残り(前のジョブが見込みを超えた分を引いた値)が 1 件の最低に届かない。位置も読まずに次の実行で取り直す
        report.push({ job: job.name, outcome: "continued" });
        continue;
      }
      const result = await job.run(ctx);
      if (result?.more) {
        // K17: 続きが残っている。成功を記録せず、同じ日の次の実行で続ける
        report.push({ job: job.name, outcome: "continued" });
        continue;
      }
      // 成功の記録は daily だけ(tick は毎回動くので記録が要らない。writesControl: false のジョブに wtt-control へ書かせない)
      if ("daily" in job.cadence) {
        if (await isWriteFrozen(db)) throw new CronFrozen();
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
  console.log("cron run", JSON.stringify({ scheduledTime: new Date(now).toISOString(), frozen: frozenAtStart, queries: spent, jobs: report }));
  return report;
}

/**
 * ジョブに渡す ctx。配分を持つジョブには呼び出しを数える binding を渡す(K17)。
 * spentOrHeld = 全体で使った数 + 後ろで動く予定のすべてのジョブに残す数(全体の残りはこれを QUERY_LIMIT から引いた値)
 */
function jobContext(env: Env, db: Db, job: CronJob, now: number, share: number | undefined, spentOrHeld: () => number, addSpent: (n: number) => void): CronContext {
  let jobSpent = 0;
  let jobEnv = env;
  let jobDb = db;
  if (share !== undefined) {
    const count = (n: number) => {
      jobSpent += n;
      addSpent(n);
    };
    jobEnv = { ...env, DB: countingD1(env.DB, count), ...(env.RESULTS_DB ? { RESULTS_DB: countingD1(env.RESULTS_DB, count) } : {}) };
    jobDb = getDb(jobEnv);
  }
  const left = () => Math.max(0, Math.min(share === undefined ? Infinity : share - jobSpent, QUERY_LIMIT - spentOrHeld()));
  return {
    env: jobEnv,
    db: jobDb,
    now,
    async assertNotFrozen() {
      if (await isWriteFrozen(jobDb)) throw new CronFrozen();
    },
    queries: { left, use: (n) => n <= left() },
  };
}
