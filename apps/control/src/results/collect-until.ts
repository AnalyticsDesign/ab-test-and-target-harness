import { collectUntilFor, DEFAULT_PLAN, type EvaluationPlan } from "@wtt/stats";
import type { Db, ExperimentRow, SiteRow } from "../db";
import type { Env } from "../env";
import type { LoadedPlan } from "../evaluation-plan";
import { putSettingsRecord } from "../site-settings";
import { WriteFrozen, type WriteGuard } from "./guard";
import type { ReadSession } from "./read-session";

/**
 * D9 ③(plan ③ の K11・K9・K24、設計書 §5.3・§5.4): 収集の締め切り(KV の Site の設定の記録の `resultsCollectUntil`)と、
 * 目標参加者数の到達の記録。
 *
 * - 締め切りの値は D1 から毎回計算する(`collectUntilFor`)。KV の settings を書くのは site-settings.ts の putSettingsRecord
 *   (writeSiteRecords もこれを使う)だけで、呼び出し元はすべて collectUntilMap の表を渡す(Site の PATCH で書き直しても締め切りが消えない)
 * - 開始・計画の変更・到達の記録・終了のときは rewriteCollectUntil で settings だけを書き直す(bootstrap には焼かないので、
 *   静的ファイルの出し直しは要らない)。失敗したら sites.collect_until_dirty = 1 にし、15 分ごとの Cron が書き直す
 */

/** 締め切りの計算に使う計画の項目(保存した plan_json に無い項目は既定値) */
type PlanTiming = Pick<EvaluationPlan, "minDays" | "maxWeeks" | "targetPerVariant">;
function timingOf(planJson: string | null): PlanTiming {
  // 計画の行が無い run(計画を固定する前に振った run_id)は既定の計画で数える(loadPlan と同じ既定値)
  const stored = planJson ? (JSON.parse(planJson) as Partial<EvaluationPlan>) : {};
  return { ...DEFAULT_PLAN, ...stored };
}

/**
 * その Site の run ごとの締め切り(K11)。対象 = run_id を持つエクスペリエンスのうち、実行中・一時停止中のもの、
 * または個票をまだ消していない(results_purged_at が無い)もの。終了したものは個票を消すまで残し、
 * 実行中のまま期限で個票を消しても締め切りは消えない。
 * 開始の時刻は started_at(無ければ計画の fixed_at)。終了の時刻は終了したものだけ(評価時点の前の終了なら終了の時刻が締め切り)
 */
export async function collectUntilMap(db: Db, siteId: string): Promise<Record<string, number>> {
  const rows = await db
    .selectFrom("experiments as e")
    .leftJoin("evaluation_plans as p", (j) => j.onRef("p.site_id", "=", "e.site_id").onRef("p.experiment_id", "=", "e.id"))
    .select(["e.run_id", "e.status", "e.started_at", "e.stopped_at", "p.plan_json", "p.fixed_at", "p.reached_at"])
    .where("e.site_id", "=", siteId)
    .where("e.run_id", "is not", null)
    .where((w) => w.or([w("e.status", "in", ["running", "paused"]), w("e.results_purged_at", "is", null)]))
    .orderBy("e.run_id")
    .execute();
  const out: Record<string, number> = {};
  for (const r of rows) {
    const startedAt = r.started_at ?? r.fixed_at;
    if (r.run_id === null || startedAt === null) continue;
    const stoppedAt = r.status === "archived" ? r.stopped_at : null;
    out[r.run_id] = collectUntilFor(timingOf(r.plan_json), startedAt, r.reached_at ?? null, stoppedAt);
  }
  return out;
}

/**
 * KV の Site の設定の記録を、D1 から計算した締め切りで書き直す(settings だけ。host キーは変えない)。
 * 例外は投げない: 失敗したら collect_until_dirty = 1 にして、15 分ごとの Cron に任せる。凍結中(guard が投げる)は印も書かない。
 * 成功しても印は 0 に戻さない(並行して失敗した、より新しい書き直しの印を消さないため。0 に戻すのは Cron)
 */
export async function rewriteCollectUntil(env: Env, db: Db, siteId: string, guard: WriteGuard): Promise<void> {
  try {
    const row = await db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
    if (!row) return; // Site が消えた(削除が KV も消す)
    // settings だけを書く(host キーは変わらないので書かない。KV の書き込みの回数を増やさない)
    await putSettingsRecord(env, row, await collectUntilMap(db, siteId));
  } catch (e) {
    console.error("collect-until rewrite failed (the cron retries)", e);
    try {
      await guard();
      await db.updateTable("sites").set({ collect_until_dirty: 1 }).where("id", "=", siteId).execute();
    } catch (e2) {
      // 凍結中は印を書かない。印の書き込みの失敗も投げない(Cron は KV と D1 の違いでも書き直す。K11)
      if (!(e2 instanceof WriteFrozen)) console.error("collect_until_dirty write failed", e2);
    }
  }
}

/** 到達の確認の SQL(パターンごと。target 人目の参加の時刻) */
const NTH_EXPOSURE = "SELECT exposed_at FROM participants WHERE run_id = ?1 AND variant_id = ?2 ORDER BY exposed_at LIMIT 1 OFFSET ?3";

/**
 * 計測用 D1 から到達の時刻を求める(書き込みなし)。重みが 0 より大きい各パターンの target 人目の exposed_at のうち最も遅いもの。
 * どれかが届いていなければ null。読み取りは渡された read だけ(1 回の batch)
 */
export async function findReach(env: Env, read: ReadSession, runId: string, variantIds: string[], target: number): Promise<number | null> {
  const rdb = env.RESULTS_DB;
  if (!rdb || variantIds.length === 0) return null;
  const results = await read.batch(variantIds.map((vid) => rdb.prepare(NTH_EXPOSURE).bind(runId, vid, target - 1)));
  let reachedAt = -Infinity;
  for (const r of results) {
    const at = (r.results?.[0] as { exposed_at?: number } | undefined)?.exposed_at;
    if (typeof at !== "number") return null;
    reachedAt = Math.max(reachedAt, at);
  }
  return reachedAt;
}

/**
 * 目標参加者数の到達を確かめて記録する(K9・K11・K13・K24、設計書 §5.3)。戻り値 = 到達した参加の時刻(未到達・目標なしは null)。
 * - 到達を記録済みなら読まずにその時刻を返す(以後の撤回で未到達に戻らない)
 * - 全対象パターン(重み 0 は外す)が届いていれば、reached_at に到達した参加の時刻、reached_recorded_at に now を記録して
 *   締め切りを書き直す。記録は「到達がまだ空で、読んだ計画の version のまま」を条件にする
 *   (間に目標を増やした変更が到達を消していたら、古い目標の到達を書かない)。0 行なら記録を読み直して返す
 * - 読み取りは渡された read だけを使う(予約は呼び出し元が持つ = K13)。wtt-control に書く前に guard を呼ぶ。
 *   API の凍結(WriteFrozen)は捕まえて、記録せずに確かめた値だけを返す(K24)。それ以外(Cron の凍結など)は投げる
 */
export async function checkReach(
  env: Env,
  db: Db,
  site: Pick<SiteRow, "id">,
  exp: Pick<ExperimentRow, "id" | "run_id">,
  plan: LoadedPlan,
  now: number,
  read: ReadSession,
  guard: WriteGuard,
): Promise<number | null> {
  const target = plan.plan.targetPerVariant;
  if (target === null || exp.run_id === null || plan.fixedAt === null || plan.version === null) return null;
  if (plan.reachedAt !== null) return plan.reachedAt;
  const variants = await db.selectFrom("variants").select("id").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("weight", ">", 0).orderBy("position").execute();
  const reachedAt = await findReach(env, read, exp.run_id, variants.map((v) => v.id), target);
  if (reachedAt === null) return null;
  try {
    await guard();
  } catch (e) {
    if (e instanceof WriteFrozen) return reachedAt;
    throw e;
  }
  const res = await db
    .updateTable("evaluation_plans")
    .set({ reached_at: reachedAt, reached_recorded_at: now })
    .where("site_id", "=", site.id)
    .where("experiment_id", "=", exp.id)
    .where("reached_at", "is", null)
    .where("version", "=", plan.version)
    .where("fixed_at", "is not", null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) {
    const fresh = await db.selectFrom("evaluation_plans").select("reached_at").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).executeTakeFirst();
    return fresh?.reached_at ?? null;
  }
  await rewriteCollectUntil(env, db, site.id, guard);
  return reachedAt;
}
