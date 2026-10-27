// apps/control/src/cron/static-reconcile.ts
import type { StaticInstanceStatus } from "@wtt/core";
import { sql } from "kysely";
import { edgeOrigin } from "../capabilities";
import { toStatement } from "../db";
import { clearStaticStaleQuery } from "../static-delivery";
import { inspectStaticHealth, readInstanceStatus, rebuildStaticFiles, takeWithinPage, type StaticReconcileTargets } from "../static-health";
import { NOT_FROZEN_SQL } from "../write-freeze";
import type { CronJob } from "./runner";

/**
 * 7o K13(K2 の自動の範囲): 15 分ごとに、デプロイ専用の Worker(DO)の記録が D1 より古い向きのサイトだけを自動で直す。
 * - 依頼し直す: 「公開中なのに DO の記録に無いサイト」(unknownSites)と「更新の依頼が DO に届いていない公開中のサイト」(undeliveredSites)を、
 *   全サイトの作り直しと同じ rebuildStaticFiles({ siteIds })で 1 回にまとめて送る(force なし。公開履歴の無いサイト(K8)は UPDATE の条件で外れ、
 *   epoch を進め続けない)。1 回に送るのは、候補(id の順)を 15 分の枠の番号で回した位置から、25 件と config の合計のバイト数で切った分
 *   (CX-02・CX-03。rotateForSlot)。残りは次の実行で
 * - 印だけを立てる: DO が D1 より新しい向き(D1 を Time Travel で戻した)の公開中のサイト。自動で epoch を進めると、戻らない KV の config と
 *   ずれるので、人が判断する(static_stale = 1 で帯に出す)。墓標が先行しているサイトは印を立てない(墓標を自動で扱わない = 7i K23)
 * - 印を下ろす(U2。ユーザー決定 2026-10-27): DO が D1 の世代ちょうどを、今の入力と同じ digest で配り終えた公開中のサイト(inspectStaticHealth の
 *   toClear)。GET /sites/:sid の reconcileStatic が印を下ろすときと同じ条件・同じ SET(clearStaticStaleQuery)で、印が立っていること・削除の途中で
 *   ないこと・凍結の印が無いことを足す。作り直しの後、人が開かないサイトの印が残り続け、状態の GET の digest の比較が減らないことを防ぐ。
 *   D9 の配信の確認(confirmFromStatus)はここでは呼ばない(results-delivery が static_stale によらず確かめる。instanceStatus には履歴が無い)
 * - 消さない: D1 では未公開なのに DO が配信ファイルを持っているサイト(Q4)と、D1 に行が無いのに持っているサイト(Q7)は、消さず印も立てない
 *   (戻した向きなので人が判断する。未公開の行に印を立てると、DO が先行していない場合に GET /sites/:sid の自己修復が削除を依頼してしまう)
 * - 凍結(決定 56): writesControl: true(凍結中は runner が丸ごと見送る)。書く直前に毎回 assertNotFrozen(作り直しの UPDATE と記録の INSERT の前は
 *   beforeWrite、印の batch の前は直接)、書く文に NOT_FROZEN_SQL(作り直しは notFrozenSql)。停止の例外は飲まずに runner に返す(stopped_frozen)
 * - binding が無い導入では何もしない。instanceStatus が失敗したら console.error して終える(次の実行で取り直す。次のジョブを止めない)
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(break-glass-sweep と同じ。登録は最後)。
 * D1 のクエリは段ごとに、その段の最大(STATIC_RECONCILE_STAGE)が全体の残りに収まるかを ctx.queries.use で確かめ、足りない段から先は
 * 行わずに `{ more: true }` で次の実行に回す(CL-4。結果のジョブが配分を使い切った枠でも、読むだけの突き合わせと前の段は進める)
 */
const NAME = "static-reconcile";

/**
 * 段ごとの D1 の文の最大(実数。CL-4)。
 * - inspect 3 = 突き合わせ(inspectStaticHealth): 行の読み取り 1 + 先行の候補の読み直し 1 + 同じ世代の中身を比べる config の読み取り 1
 * - rebuild 13 = 作り直し(rebuildStaticFiles。siteIds は 25 件まで): UPDATE の前の凍結の確かめ 1 + UPDATE 1 + config の読み取り 1 +
 *   記録 5 回(25 件を 5 件ずつ)×(凍結の確かめ 1 + INSERT 1)
 * - mark 2 = 印を立てる: 凍結の確かめ 1 + batch 1(batch は何文でも 1 件と数える = runner の countingD1)
 * - clear 2 = 印を下ろす(U2): 凍結の確かめ 1 + batch 1
 */
export const STATIC_RECONCILE_STAGE = { inspect: 3, rebuild: 13, mark: 2, clear: 2 } as const;
/**
 * 1 回の実行の D1 の文の最大 = 段の合計 20(3 + 13 + 2 + 2。印を下ろす段を足す前は 18)。ほかに DO への RPC が instanceStatus 1 + redeploySites 最大 5
 */
export const STATIC_RECONCILE_QUERIES =
  STATIC_RECONCILE_STAGE.inspect + STATIC_RECONCILE_STAGE.rebuild + STATIC_RECONCILE_STAGE.mark + STATIC_RECONCILE_STAGE.clear;

/** 15 分の枠(Cron の間隔。CX-03 の回し方の単位) */
const SLOT_MS = 900_000;

/** 印の文(K13 の条件のとおり: 読み直した世代のまま・印が無い・凍結の印が無い) */
const MARK_SQL = `update sites set static_stale = 1 where id = ? and static_epoch = ? and static_seq = ? and static_stale = 0 and ${NOT_FROZEN_SQL}`;

/**
 * CX-03: 依頼し直しの候補(id の順)の始まりを、15 分の枠の番号(floor(now / 15 分))を候補の数で割った余りの位置にし、末尾から先頭へ回り込む。
 * 状態は持たない。入力を作れない・DO が断り続けるサイトが id の順の先頭に 25 件以上あっても、枠ごとに窓がずれるので、後ろのサイトにも順番が来る
 */
export function rotateForSlot<T>(items: readonly T[], now: number): T[] {
  if (items.length === 0) return [];
  const start = Math.floor(now / SLOT_MS) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export const staticReconcileJob: CronJob = {
  name: NAME,
  cadence: { every: "tick" },
  writesControl: true,
  async run(ctx) {
    if (!ctx.env.DEPLOYER) return; // 配信ファイルを使わない導入
    // 段ごとの予約。runner は配分を持たないジョブの呼び出しを数えない(left() はこの実行のあいだ変わらない)ので、
    // 前の段の分を足した累計で確かめる(足さないと、各段は収まっても合計が残りを超える)
    let reserved = 0;
    const reserve = (stage: keyof typeof STATIC_RECONCILE_STAGE): boolean => {
      if (!ctx.queries.use(reserved + STATIC_RECONCILE_STAGE[stage])) {
        console.log(`cron ${NAME}: no query budget left for the ${stage} stage in this run; retrying on the next run`);
        return false;
      }
      reserved += STATIC_RECONCILE_STAGE[stage];
      return true;
    };

    if (!reserve("inspect")) return { more: true };
    let status: StaticInstanceStatus;
    try {
      status = await readInstanceStatus(ctx.env);
    } catch (e) {
      console.error(`cron ${NAME}: reading the deployer status failed; retrying on the next run`, e);
      return;
    }
    const { rerequest, aheadToMark, toClear } = await inspectStaticHealth(ctx.db, status, ctx.now, edgeOrigin(ctx.env));

    // DO が D1 より古い向き: 依頼し直す(枠の番号で回した位置から、25 件と config の合計のバイト数まで)
    let requested = 0;
    let failed = 0;
    let left = 0;
    if (rerequest.length > 0) {
      if (!reserve("rebuild")) return { more: true };
      const { taken } = takeWithinPage(rotateForSlot(rerequest, ctx.now), (r) => r.bytes);
      left = rerequest.length - taken.length;
      const out = await rebuildStaticFiles(
        ctx.env,
        ctx.db,
        { siteIds: taken.map((r) => r.siteId) },
        { status, now: ctx.now, force: false, beforeWrite: () => ctx.assertNotFrozen(), notFrozenSql: true },
      );
      requested = out.requested.length;
      failed = out.failed.length;
    }

    // DO が D1 より新しい向き: 直さず印だけを立てる(1 つの batch)
    let marked = 0;
    if (aheadToMark.length > 0) {
      if (!reserve("mark")) return { more: true };
      await ctx.assertNotFrozen();
      const results = await ctx.env.DB.batch(aheadToMark.map((s) => ctx.env.DB.prepare(MARK_SQL).bind(s.siteId, s.staticEpoch, s.staticSeq)));
      marked = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }

    // 配り終えた向き(U2): 印を下ろし、配っている版を記録する(1 つの batch。件数は inspectStaticHealth の比べる頁 = 25 件まで)
    let cleared = 0;
    if (toClear.length > 0) {
      if (!reserve("clear")) return { more: true };
      await ctx.assertNotFrozen();
      const results = await ctx.env.DB.batch(toClear.map((r) => toStatement(ctx.env, clearQuery(ctx, r))));
      cleared = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }

    // 件数だけを出す(残りは次の実行で続ける)
    if (requested > 0 || failed > 0 || marked > 0 || cleared > 0 || left > 0) {
      console.log(
        `cron ${NAME}: requested ${requested} site(s), failed ${failed}, marked ${marked} site(s) whose deployer record is ahead, cleared ${cleared} deployed site(s), ${left} left for the next run`,
      );
    }
  },
};

/**
 * 印を下ろす 1 文(U2)。条件は clearStaticStaleQuery(reconcileStatic と同じ: id・created_at・static_epoch・static_seq)に、
 * 印が立っていること・削除の途中でないこと(削除が始まった行の印は削除の流れのもの)・凍結の印が無いこと(書く直前に凍結が入っても書かない)を足す
 */
function clearQuery(ctx: { db: Parameters<typeof clearStaticStaleQuery>[0] }, r: StaticReconcileTargets["toClear"][number]) {
  return clearStaticStaleQuery(ctx.db, r, r.static_seq, r.servedVersion, Date.now())
    .where("static_stale", "=", 1)
    .where("static_removing", "is", null)
    .where(sql.raw<boolean>(NOT_FROZEN_SQL));
}
