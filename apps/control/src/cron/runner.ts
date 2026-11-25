// apps/control/src/cron/runner.ts
import { utcDay } from "@wtt/core";
import { getDb, type Db } from "../db";
import type { Env } from "../env";
import { readCloudflarePlan, type CloudflarePlan } from "../instance-settings";
import { migrateSharing } from "../sharing-conflict";
import { isWriteFrozen } from "../write-freeze";
import { readCronRunState, type CronRunState } from "./run-state";

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
 * - B182(推す 1): 実行の最初の読み取り(凍結・daily の記録・プラン・共有の移行待ち・導入の印)は D1 の batch 1 回(run-state.ts)。
 *   batch が失敗した回だけ、前と同じ 1 つずつの読み取り(凍結 → daily の記録 → プラン)に戻る。読み取りの失敗の扱いはどちらも同じ
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
 * - runner 自身(実行の最初の batch、戻る回の凍結・daily の記録・Paid の実行かの読み取り、daily の成功の記録)と、配分を持たないジョブ(results-account-guard)の分は数えない(上限 1,000 との差に入る)
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
  run?: { state: CronRunState | null; reserved: boolean; outside: QueryBudget & { env: Env } };
};

export type CronRunFacts = { now: number; due: ReadonlySet<string>; state: CronRunState | null };

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
  reserveWhen?: (facts: CronRunFacts) => boolean;
  /** 1 件を処理するのに要る配分の最低(位置・対象の読み取りと位置の書き込みを含む)。配分がこれに届かない実行では動かさない。allotQueries */
  queryFloor?: number;
  /**
   * B93: インスタンス設定の Cloudflare のプランが Paid の実行でだけ、配分に足す数(全体の上限 QUERY_LIMIT にも同じ数を足す)。
   * ほかのジョブの配分は変えない。今は results-purge だけ(Free の配分は変えない = 2026-10-20 ユーザー決定)
   */
  paidExtraShare?: number;
  /** `{ more: true }` = 配分か 1 回の量を使い切り、続きが残っている(成功を記録せず、次の実行で続ける。K17) */
  run(ctx: CronContext): Promise<void | { more: true }>;
};

export type CronRunReport = Array<{ job: string; outcome: "ran" | "continued" | "skipped_frozen" | "stopped_frozen" | "not_due" | "failed" }>;

/**
 * 1 回の実行で配分を持つジョブが出してよい D1 のクエリの数(K17)。Paid の実行では、due のジョブの paidExtraShare の分だけ足す(B93)。
 * D1 の 1 回の呼び出しの上限は、Free でも 1,000(2026-10-20 の実測。D1 の Limits の表の「50 (Free)」は古い)で、batch は 1 件と数える
 * (D9 ③ の実装の記録 9 節の前提 1。docs/dev/research/d1_batch_query_limits_2026-10-06.md の未確認の点は、この実測で解消した)。
 * 40 は上限ではなく、Free の D1 の 1 日の書き込み 10 万行(アカウント全体)を配信・記録と取り合わないための量の値で、
 * Free では上げない(2026-10-20 ユーザー決定。backlog B93)。runner と配分を持たないジョブの分は、この外(上限 1,000 との差)に入る
 */
export const QUERY_LIMIT = 40;
const REPAIR_OUTSIDE_QUERIES = 2;

/** 今回確保しないジョブは、配分を持たないジョブとして直近の照合だけを動かす。 */
export function effectiveJobs(jobs: readonly CronJob[], facts: CronRunFacts): CronJob[] {
  return jobs.map(job => {
    if (!job.reserveWhen || job.reserveWhen(facts)) return job;
    const { queryShare, queryFloor, queryReserved, ...unshared } = job;
    return unshared;
  });
}

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

/** daily のジョブが今日まだ成功しておらず、UTC の時が afterUtcHour 以上か。lastRunDay = 実行の最初の batch で読んだ記録(B182) */
export function isDueFrom(job: CronJob, now: number, lastRunDay: ReadonlyMap<string, string>): boolean {
  if (!("daily" in job.cadence)) return true;
  if (new Date(now).getUTCHours() < job.cadence.daily.afterUtcHour) return false;
  return lastRunDay.get(job.name) !== utcDay(now);
}

/** isDueFrom と同じ判定を、そのジョブの記録を D1 から 1 つ読んで行う(B182: batch が失敗した回の戻る読み取り) */
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
 * | daily のジョブが due でない            | 10       | 10            | –     | 3        | –     |
 * | results-daily が due・tick 優先の枠    | 10       | 7             | 20    | 3        | –     |
 * | results-daily が due・daily 優先の枠   | 10       | 1(最低 7 未満で動かない) | 26 | 3 | – |
 * | results-purge が due・tick 優先の枠    | 10       | 7             | –     | 3        | 16    |
 * | results-purge が due・daily 優先の枠   | 10       | 10            | –     | 3        | 16    |
 * | 両方が due・tick 優先の枠              | 10       | 7             | 20    | 3        | 0(動かない) |
 * | 両方が due・daily 優先の枠             | 0        | 0             | 26    | 3        | 11    |
 *
 * 修復の候補がある回の配分:
 * | due         | 優先  | delivery | collect-until | daily | capacity | purge | publish-repair |
 * | ----------- | ----- | -------- | ------------- | ----- | -------- | ----- | -------------- |
 * | なし        | 両枠  | 10       | 10            | –     | 3        | –     | 7              |
 * | daily       | tick  | 10       | 7             | 13    | 3        | –     | 7              |
 * | daily       | daily | 4        | 0             | 26    | 3        | –     | 7              |
 * | purge       | tick  | 10       | 7             | –     | 3        | 13    | 7              |
 * | purge       | daily | 10       | 4             | –     | 3        | 16    | 7              |
 * | daily/purge | tick  | 10       | 7             | 13    | 3        | 0     | 7              |
 * | daily/purge | daily | 0        | 0             | 26    | 3        | 11    | –              |
 * 1 件の最低: delivery 10・collect-until 7・daily 10(到達の確認 1 件)・purge 10(繰り返し 1 回)・capacity 2。
 * (B94 で collect-until を 8 / 6 → 10 / 7 にした。tick 優先の枠の daily は 21 → 20)
 * 記録 1 件(位置と対象の読み取り 3 + 記録 21 + 位置の書き込み 1 = 25)は daily 優先の枠の 26 に収まる。tick 優先の枠の 20 では到達の確認だけが進む。
 * どのジョブも、daily が due の日でも 30 分(2 枠)に 1 回は 1 件の最低以上の配分を受ける。
 * Paid の実行(B93): results-purge が due なら、上の表の purge の列に 100 を足し、全体の上限も 140 にする(ほかの列は変わらない)
 */
export const SLOT_MS = 15 * 60 * 1000;
export const isTickPrioritySlot = (now: number): boolean => Math.floor(now / SLOT_MS) % 2 === 0;

/**
 * B93: その実行の全体の上限 = QUERY_LIMIT + Paid の実行で due のジョブの paidExtraShare の合計。
 * Free の実行(と、プランを読めなかった実行)は QUERY_LIMIT のまま
 */
export function queryLimitFor(jobs: readonly CronJob[], due: ReadonlySet<string>, plan: CloudflarePlan): number {
  if (plan !== "paid") return QUERY_LIMIT;
  return jobs.reduce((s, j) => s + (j.queryShare !== undefined && due.has(j.name) ? (j.paidExtraShare ?? 0) : 0), QUERY_LIMIT);
}

/**
 * 配分の表。plan が paid なら、上の表で決めた配分に、due のジョブの paidExtraShare を足す(B93。足すのは上限に足した分だけなので、
 * ほかのジョブの配分は Free と同じ。results-purge は、上の表で 0 の枠でも足した分で動く)
 */
export function allotQueries(jobs: readonly CronJob[], due: ReadonlySet<string>, now: number, plan: CloudflarePlan = "free"): Map<string, number> {
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
  if (plan === "paid") for (const j of shared) if (j.paidExtraShare && due.has(j.name)) out.set(j.name, out.get(j.name)! + j.paidExtraShare);
  return out;
}

/** B93: Paid の配分を足しうる実行か(paidExtraShare を持つジョブが due)。そうでなければプランに依らず Free の配分 */
const needsPlan = (jobs: readonly CronJob[], due: ReadonlySet<string>): boolean => jobs.some((j) => j.paidExtraShare && j.queryShare !== undefined && due.has(j.name));

/**
 * Paid の実行かを読む(B93。B182 からは batch が失敗した回の戻る読み取りだけ)。読むのは、paidExtraShare を持つジョブが due のときだけ。
 * 読めなければ Free とみなす(足さない側に倒す)
 */
async function planForRun(db: Db, jobs: readonly CronJob[], due: ReadonlySet<string>): Promise<CloudflarePlan> {
  if (!needsPlan(jobs, due)) return "free";
  try {
    return await readCloudflarePlan(db);
  } catch (e) {
    console.error("cron: reading the Cloudflare plan failed; using the free allotment", e);
    return "free";
  }
}

/** 実行の最初に決める 4 つ(B182: batch で読めた回も、戻った回も、この形にしてから後ろの配分・ジョブの実行に渡す) */
type RunStart = { frozen: boolean; due: Map<string, boolean | Error>; plan: CloudflarePlan; runSharing: boolean };

/**
 * B182: 共有の自動の移行(終わった後は、導入の印を確かめるだけ)をこの回に動かすか。batch が読めた回だけで使う。
 * 凍結中は動かさない。移行待ちのサイトがある回と、導入の印が D1 に無い回は、どの枠でも動かす。
 * それ以外(終わっている回)は、15 分の枠 4 つに 1 つ(時の最初の枠)だけ確かめる。
 * KV の印のずれの直しは 1 時間に 1 回で足りる(サイトの保存でもその場で直る)
 */
export function shouldRunSharingMigration(state: CronRunState, now: number): boolean {
  return !state.frozen && (state.sharingPending || !state.installMarkerInD1 || Math.floor(now / SLOT_MS) % 4 === 0);
}

/** batch で読めた回: D1 を読まずに決める */
function startFromState(state: CronRunState, jobs: readonly CronJob[], now: number): RunStart {
  const runnable = jobs.filter((j) => !(j.writesControl && state.frozen));
  const due = new Map<string, boolean | Error>(runnable.map((j) => [j.name, isDueFrom(j, now, state.lastRunDay)]));
  const dueNames = new Set([...due].filter(([, d]) => d === true).map(([n]) => n));
  return { frozen: state.frozen, due, plan: needsPlan(runnable, dueNames) ? state.plan : "free", runSharing: shouldRunSharingMigration(state, now) };
}

/** batch が失敗した回: 前と同じ 1 つずつの読み取り(凍結は D1 が読めなければ凍結中・daily の記録の失敗はそのジョブの Error・プランは読めなければ Free) */
async function startFromSeparateReads(db: Db, jobs: readonly CronJob[], now: number): Promise<RunStart> {
  const frozen = await isWriteFrozen(db);
  const runnable = jobs.filter((j) => !(j.writesControl && frozen));
  const due = new Map<string, boolean | Error>();
  for (const job of runnable) {
    try {
      due.set(job.name, await isDue(db, job, now));
    } catch (e) {
      due.set(job.name, e as Error);
    }
  }
  const dueNames = new Set([...due].filter(([, d]) => d === true).map(([n]) => n));
  // 移行待ちの有無を読めていないので、共有の移行は前と同じく凍結でなければ動かす
  return { frozen, due, plan: await planForRun(db, runnable, dueNames), runSharing: !frozen };
}

export async function runCron(env: Env, scheduledTime: number, jobs: readonly CronJob[]): Promise<CronRunReport> {
  assertValidJobs(jobs);
  const db = getDb(env);
  const now = scheduledTime;
  // B182: 凍結・daily の記録・プランを最初に batch 1 回で読む(書く直前の確かめは assertNotFrozen が読み直す)。
  // batch が失敗した回だけ、前と同じ 1 つずつの読み取りに戻る
  const state = await readCronRunState(env.DB, jobs.filter((j) => "daily" in j.cadence).map((j) => j.name), now);
  const { frozen: frozenAtStart, due, plan, runSharing } = state ? startFromState(state, jobs, now) : await startFromSeparateReads(db, jobs, now);
  // B139: 共有の自動の移行(一度きり)を実行の最初に進める。wtt-control に書くので凍結中は見送る。
  // B182: 動かすかは shouldRunSharingMigration が決める(batch が読めた回)。移行待ちのサイトがある回と、導入の印が D1 に無い回はどの枠でも、
  // 終わっている回は時の最初の枠だけ(動けば移行待ちの SELECT と導入の印の SELECT で D1 2 回・KV の get 1 回、KV が D1 と違えば put 1 回)。
  // batch が失敗して 1 つずつの読み取りに戻った回は、移行待ちの有無が分からないので、凍結でなければ動かす。
  // 配分の外(runner の分)で動かす。1 回に 25 サイトまでで、D1 の呼び出しは多くて 60 件ほど(上限 1,000 との差に入る)。
  // 失敗はログに残し、ジョブは止めない(次の実行で続きから)
  if (runSharing) {
    try {
      await migrateSharing(env, env.DB, Math.floor(now / 1000));
    } catch (e) {
      console.error("cron: sharing migration failed", e);
    }
  }
  // 今回動くジョブ(凍結で見送るものを除く)。daily の due は上で決めた(配分を決めるため)
  const dueNames = new Set([...due].filter(([, d]) => d === true).map(([n]) => n));
  const effective = effectiveJobs(jobs, { now, due: dueNames, state });
  const runnable = effective.filter((j) => !(j.writesControl && frozenAtStart));
  const allot = allotQueries(runnable, dueNames, now, plan);
  const limit = queryLimitFor(runnable, dueNames, plan);
  /** 動くジョブ = due で、配分が 1 件の最低に届くもの */
  const willRun = (j: CronJob) => due.get(j.name) === true && (j.queryShare === undefined || allot.get(j.name)! >= (j.queryFloor ?? 1));
  // K17: 配分を持つジョブが出したクエリの実数(全体)
  let spent = 0;
  let outsideQueries = 0;
  const outside = (limit: number) => {
    const left = () => Math.max(0, limit - outsideQueries);
    const count = (n: number) => {
      if (n > left()) throw new Error("cron outside query allowance exhausted");
      outsideQueries += n;
    };
    return {
      left, use: (n: number) => n <= left(),
      env: { ...env, DB: countingD1(env.DB, count), ...(env.RESULTS_DB ? { RESULTS_DB: countingD1(env.RESULTS_DB, count) } : {}) },
    };
  };
  const noOutside = outside(0);
  const report: CronRunReport = [];
  for (const [i, job] of effective.entries()) {
    if (job.writesControl && frozenAtStart) {
      report.push({ job: job.name, outcome: "skipped_frozen" });
      continue;
    }
    // 後ろで動く予定のジョブの配分。このジョブの全体の残りから引いて残す(このジョブが後ろの配分に食い込む件を始めないため)。
    // 前のジョブが 1 件の見込みを超えた分は全体の残りを減らすので、後ろのジョブが実際に使える数は配分より少なくなりうる
    // (下で実行の時点の残りを最低と比べる)
    const held = effective
      .slice(i + 1)
      .filter((j) => runnable.includes(j) && willRun(j) && j.queryShare !== undefined)
      .reduce((s, j) => s + allot.get(j.name)!, 0);
    const ctx = jobContext(env, db, now, limit, allot.get(job.name), () => spent + held, (n) => (spent += n));
    ctx.run = { state, reserved: !!job.queryReserved, outside: job.name === "publish-repair" ? outside(REPAIR_OUTSIDE_QUERIES) : noOutside };
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
  console.log("cron run", JSON.stringify({ scheduledTime: new Date(now).toISOString(), frozen: frozenAtStart, queries: spent, outsideQueries, queryLimit: limit, jobs: report }));
  return report;
}

/**
 * ジョブに渡す ctx。配分を持つジョブには呼び出しを数える binding を渡す(K17)。
 * limit = その実行の全体の上限(queryLimitFor)。spentOrHeld = 全体で使った数 + 後ろで動く予定のすべてのジョブに残す数
 * (全体の残りはこれを limit から引いた値)
 */
function jobContext(env: Env, db: Db, now: number, limit: number, share: number | undefined, spentOrHeld: () => number, addSpent: (n: number) => void): CronContext {
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
  const left = () => Math.max(0, Math.min(share === undefined ? Infinity : share - jobSpent, limit - spentOrHeld()));
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
