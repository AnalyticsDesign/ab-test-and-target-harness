import { RESULTS_ROWS, matchesUrl, type CompiledConfig, type GoalConversionBody, type ResultOutcome, type SiteSettings } from "@wtt/core";
import type { Env } from "./env";
import { healthBuffer } from "./results-health";
import { leaseHolder } from "./results-lease";
import {
  FAILED,
  IGNORED,
  IGNORED_FINAL,
  activeResultsConfig,
  failAll,
  keyOrNull,
  pastCollectUntil,
  write,
  type Ctx,
  type WaitUntil,
} from "./results";

/**
 * 目標だけの CV(B139 §5.2・Q14・Q22)。run は送らず、edge が D1 の参加の記録(`participants_by_visitor`)から引く。
 * 別のサブドメインで参加した人の CV も、同じ訪問者 ID(共有の Cookie)なら記録できる。
 *
 * 入口は 3 つ:
 * - 送られた目標だけの CV(`{type:"conversion", v:2, goalIds}`。/v1/ と /__ab/ の event)
 * - /__ab/decision への便乗: ページの URL に当たる「ページの表示」の目標(Cloudflare 経由のドメインではタグが送らない)
 * - type:"goal" への便乗: 履歴(Profile)の記録とは別に記録する(needsProfile のときタグは CV を別に送らない)
 * 便乗は waitUntil に回し、配信・goal の応答(status・本文・Cookie)は記録を待たず、記録の結果も載せない
 */

/** 参加の記録を引く文(索引 participants_by_visitor (site_id, visitor_key) で引く) */
const LOOKUP_SQL = "SELECT run_id FROM participants WHERE site_id = ?1 AND visitor_key = ?2";

/**
 * 目標 1 つ分の CV を、参加の行がある run すべてにまとめて入れる文(目標ごとに 1 文。run の数で文を増やさない)。
 * D1 の 1 回の呼び出しの上限は Free でも 1,000(batch は 1 件と数える。2026-10-20 の実測。control の cron/runner.ts の QUERY_LIMIT の注釈)で、
 * 文の数そのものは厳しくない。ただ 1 文の bind の数(100)の上限と、run の数に比例して文が増えるのを避けるため、
 * run の一覧は JSON の配列 1 つ(?5)で渡す。重複は主キー (run_id, goal_id, visitor_key) で防ぐ(今の CV と同じ)
 */
const GOAL_CONVERSION_SQL = `INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at)
SELECT run_id, ?1, visitor_key, ?2 FROM participants
 WHERE site_id = ?3 AND visitor_key = ?4 AND run_id IN (SELECT value FROM json_each(?5))
ON CONFLICT (run_id, goal_id, visitor_key) DO NOTHING`;

/** 目標だけの CV の停止は、`until` と送り直さない印を必ず返す(spec §5.2 の応答の形。版 1 の CV の応答は変えない) */
const stoppedGoalCv = (until: number): ResultOutcome => ({ result: "stopped", until, retry: false });

/**
 * 目標だけの CV を記録する(共通の入口)。判定はすべて active の config で行う(decision の要求の版の config は配信の判定にだけ使う)。
 * 順は: active の config の goals で目標を絞る → results.runs のうち収集の締め切り前の run(実行中と一時停止中)→
 * 予算の停止を知っていれば D1 を引かない → D1 の participants を 1 回引く → 参加した run に絞る →
 * 1 回の write(見込み = 目標の数 × run の数 × RESULTS_ROWS.conversionPerRun)で目標 × run の行をまとめて書く → 精算。
 * 分岐(spec §5.2 の表): 参加ゼロ = ignored(失敗に数えない)/ 引く処理の失敗 = failed(対象の各 run を失敗に数える)/
 * 計測用 D1・鍵が無い = 今の CV と同じ failed / 予算の停止 = stopped と until。
 * 数えた失敗は、後続の送信が無くても ResultsHealth に届くよう flushIfDue を waitUntil に登録する
 */
export async function recordGoalConversion(c: Ctx, settings: SiteSettings, goalIds: string[], visitorId: string): Promise<ResultOutcome> {
  const out = await recordInner(c, settings, goalIds, visitorId);
  const flush = healthBuffer().flushIfDue(c.env, c.now);
  if (flush) c.ctx.waitUntil(flush);
  return out;
}

async function recordInner(c: Ctx, settings: SiteSettings, goalIds: string[], visitorId: string): Promise<ResultOutcome> {
  let config: Awaited<ReturnType<typeof activeResultsConfig>>;
  try {
    config = await activeResultsConfig(c.env, c.siteId);
  } catch (e) {
    // KV が読めない。D1 の失敗ではないので数えない(今の CV と同じ)
    console.error("wtt-edge: results config read failed", e);
    return FAILED;
  }
  if (!config) return IGNORED;
  // 重複を除き、active の config に無い目標は捨てる(エラーにしない)
  const known = new Set(config.goals.map((g) => g.id));
  const goals = [...new Set(goalIds)].filter((id) => known.has(id));
  if (goals.length === 0) return IGNORED_FINAL;
  const candidates = [...new Set(Object.values(config.results.runs))].filter((runId) => !pastCollectUntil(settings, runId, c.now));
  if (candidates.length === 0) return IGNORED; // 結果を集めるテストが無い。D1 を引かない

  // 予算の停止を知っていれば D1 を引かない(停止の間は記録しない。spec §5.2)
  const until = leaseHolder(c.env).stoppedUntil;
  if (until !== null && c.now < until) return stoppedGoalCv(until);

  const key = await keyOrNull(c, visitorId);
  const db = c.env.RESULTS_DB;
  if (!db || !key) return failAll(c, candidates).outcome;
  let found: string[];
  try {
    const res = await db.prepare(LOOKUP_SQL).bind(c.siteId, key).all<{ run_id: string }>();
    found = res.results.map((r) => r.run_id);
  } catch (e) {
    // 引けなければ書かない。対象の run ごとに失敗を 1 つ数える(サイト単位の指標は作らない)
    console.error("wtt-edge: results participant lookup failed", e);
    return failAll(c, candidates).outcome;
  }
  const participated = new Set(found);
  const runs = candidates.filter((runId) => participated.has(runId));
  if (runs.length === 0) return IGNORED; // 参加ゼロ(失敗に数えない)

  // 文は目標ごとに 1 つ(参加の行がある run にだけ入る)。枠の見込みは書きうる行(目標 × run)で取り、精算は書いた実数で行う
  const runsJson = JSON.stringify(runs);
  const stmts = goals.map((goalId) => db.prepare(GOAL_CONVERSION_SQL).bind(goalId, c.now, c.siteId, key, runsJson));
  const out = (await write(c, db, stmts, runs, RESULTS_ROWS.conversionPerRun * goals.length * runs.length)).outcome;
  return out.result === "stopped" ? stoppedGoalCv(out.until!) : out;
}

/** 送られた目標だけの CV(版 2)の受信。応答は全体の結果だけ(run ごとの `runs` は持たない) */
export function handleGoalConversion(
  env: Env,
  ctx: WaitUntil,
  siteId: string,
  settings: SiteSettings,
  body: GoalConversionBody,
  visitorId: string,
  now: number,
): Promise<ResultOutcome> {
  return recordGoalConversion({ env, ctx, siteId, now }, settings, body.goalIds, visitorId);
}

/** 結果を集める run があるか(便乗の前の確かめ。無ければ D1 にも予算にも触れない) */
const collectsResults = (config: CompiledConfig | null): boolean => !!config?.results && Object.keys(config.results.runs).length > 0;

/** 便乗の記録を waitUntil に回す。失敗はログだけ(配信・goal の応答に影響させない) */
function piggyback(c: Ctx, settings: SiteSettings, goalIds: string[], visitorId: string): void {
  c.ctx.waitUntil(recordGoalConversion(c, settings, goalIds, visitorId).catch((e) => console.error("wtt-edge: results piggyback conversion failed", e)));
}

/**
 * /__ab/decision への便乗(Q22 の 1)。`activeConfig` は active の config(要求の版の config ではない)。
 * ページの URL に当たる「ページの表示」の目標をまとめて 1 回で記録する。そのページで初めて参加した 1 回は、
 * 参加の記録より先に届くので入らない(受け入れる)
 */
export function piggybackPageviewGoals(c: Ctx, settings: SiteSettings, activeConfig: CompiledConfig | null, url: string, visitorId: string): void {
  if (!activeConfig || !collectsResults(activeConfig)) return;
  const goalIds = activeConfig.goals.filter((g) => g.type === "PAGEVIEW" && matchesUrl(url, g.config.page)).map((g) => g.id);
  if (goalIds.length > 0) piggyback(c, settings, goalIds, visitorId);
}

/**
 * type:"goal" への便乗(Q22 の 2)。履歴(Profile)の記録とは別に記録する(互いの失敗に影響されない)。
 * `cloudflareHost`(/__ab/event)では「ページの表示」の目標を除く(/__ab/decision で記録するので、D1 を二重に引かない)。
 * active の config の読み取りも waitUntil の中で行う(goal の応答を待たせない)
 */
export function piggybackGoalEvent(c: Ctx, settings: SiteSettings, goalId: string, visitorId: string, cloudflareHost: boolean): void {
  c.ctx.waitUntil(
    (async () => {
      const config = await activeResultsConfig(c.env, c.siteId);
      if (!config || !collectsResults(config)) return;
      const goal = config.goals.find((g) => g.id === goalId);
      if (!goal || (cloudflareHost && goal.type === "PAGEVIEW")) return;
      await recordGoalConversion(c, settings, [goalId], visitorId);
    })().catch((e) => console.error("wtt-edge: results piggyback conversion failed", e)),
  );
}
