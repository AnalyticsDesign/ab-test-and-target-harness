import { utcDay } from "@wtt/core";
import type { Db, ExperimentRow, SiteRow } from "../db";
import type { Env } from "../env";
import { loadPlan, type LoadedPlan } from "../evaluation-plan";
import { adoptionUpsert } from "./adoption";
import { checkReach } from "./collect-until";
import type { WriteGuard } from "./guard";
import { openRead } from "./read-session";
import { evaluationOf } from "./report";
import { computeSnapshot, readOfficialSnapshot, snapshotInsert, snapshotTarget } from "./snapshot";

/**
 * D9 ③(plan ③ の K16・K13・K15、設計書 §8.1 の手順 (3)・§7.5): 終了の処理の結果の記録と採用の記録。
 * 状態の CAS と自動 Publish の後に呼ぶ(配信を止めることを先にする)。戻り値 = 記録できたか(results.recorded)。投げない。
 *
 * - 評価時点の前の終了: cutoff = 終了の時刻の「終了の記録」を作る
 * - 評価時点の後の終了: 終了の記録は作らない。評価時点の記録が無ければ、ここで先に作る(cutoff = 評価時点)
 * - 結果の記録と採用の記録は同じ D1 の batch で書く(どちらかだけが残らない)。記録の計算・書き込みに失敗したら採用も書かずに false
 * - 読み取りの予約は 1 つ(到達の確認 → 評価時点を決める → 集計)。断られたら記録せずに false(採用も未記録。記録は Cron が作り、
 *   採用は PUT …/adoption で記録し直す)
 * - 記録を作れないテスト(結果を記録していない・計測用 D1 が無い・個票を消した後)と、評価時点の記録が既にあるテストは、
 *   読まずに採用だけを書く(true = 記録できるものはすべて記録した)
 */
export async function recordStop(
  env: Env,
  db: Db,
  site: SiteRow,
  /** 終了した後の行(status = archived、stopped_at = 終了の時刻) */
  exp: ExperimentRow,
  a: { adoption: { variantId: string | null; note: string } | null; userId: string; now: number; estimate: number; guard: WriteGuard },
): Promise<boolean> {
  const adoptionOf = (requireSnapshot: boolean) =>
    a.adoption ? [adoptionUpsert(env, site.id, exp.id, { variantId: a.adoption.variantId, note: a.adoption.note, by: a.userId, at: a.now }, { requireSnapshot })] : [];
  const adoption = adoptionOf(false);
  const write = async (stmts: D1PreparedStatement[]): Promise<D1Result[]> => {
    if (stmts.length === 0) return [];
    await a.guard();
    return env.DB.batch(stmts);
  };
  try {
    if (exp.run_id === null || exp.results_purged_at !== null || !env.RESULTS_DB || !env.RESULTS_BUDGET || (await readOfficialSnapshot(db, site.id, exp.id)) !== null) {
      await write(adoption);
      return true;
    }
    const session = await openRead(env, utcDay(a.now), a.estimate, a.now);
    if ("refused" in session) return false;
    try {
      const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).where("experiment_id", "=", exp.id).orderBy("position").execute();
      const plan = await loadPlan(db, site.id, exp, variants);
      // 到達をまだ記録していなければ確かめる(到達で評価時点が早まり、評価時点の後の終了になりうる)
      const reachedAt = await checkReach(env, db, site, exp, plan, a.now, session, a.guard);
      const current: LoadedPlan = { ...plan, reachedAt: reachedAt ?? plan.reachedAt };
      // 種類と cutoff は共通の規則(到達の確認の後)。終了の時刻 = now なので、評価時点の前の終了は stop、後は evaluation
      const target = snapshotTarget(evaluationOf(current, exp), a.now);
      if (target === null) {
        await write(adoption);
        return true;
      }
      const snap = await computeSnapshot(env, db, site, exp, target.kind, target.cutoff, a.now, session, { plan: current });
      // 採用は記録があるときだけ書く(記録の INSERT が 0 行で、記録も無いときは採用も書かない = 同じ batch の決まり)
      const [inserted] = await write([snapshotInsert(env, site.id, exp, target.kind, snap), ...adoptionOf(true)]);
      if ((inserted?.meta.changes ?? 0) > 0) return true;
      // 0 行: 並行する結果の API か Cron が先に正の判定の記録を書いた(採用も書けている)か、エクスペリエンスが変わった(何も書いていない)
      return (await readOfficialSnapshot(db, site.id, exp.id)) !== null;
    } finally {
      await session.close();
    }
  } catch (e) {
    console.error("recording the results on stop failed (the cron records them later)", e);
    return false;
  }
}
