import { sql } from "kysely";
import { compareGeneration, SITE_REMOVED_SEQ, toRuntimeSettings, type StaticDeployResult, type StaticGeneration } from "@wtt/core";
import { edgeOrigin } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { siteToSettings } from "./site-settings";

/**
 * 決定 52: 配信ファイル(`/s/<siteId>.js`)の出し直しをデプロイ専用の Worker に頼む。
 * 入力は control が D1 から作って渡す(plan K1)。世代番号は D1 で原子的に進め、同じ行から入力を作る(plan K2)。
 * 出し直しが済まないあいだは sites.static_stale = 1(管理画面の警告。plan K4)
 */
export type StaticDeployState = "deployed" | "pending" | "skipped";
/** Publish・設定の保存で出し直しの完了を待つ上限。超えたら pending(デプロイ専用の Worker は続きを自分で流す) */
export const STATIC_WAIT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

/** サイト・ワークスペースの削除で、配信ファイルを消せなかった(または墓標が受け付けられたと確かめられなかった)ときの 503 */
export const staticRemoveFailed = () =>
  new ApiError(503, "static_remove_failed", { message: "配信ファイルを削除できませんでした", hint: "しばらくしてからもう一度削除してください" });
/** 削除の途中で「配信ファイルを作り直す」が削除の印を消した(配信を戻した)ので、削除を取りやめたときの 409 */
export const staticRemoveConflict = () =>
  new ApiError(409, "static_remove_conflict", { message: "配信ファイルが作り直されたため、削除を取りやめました", hint: "削除するときは、もう一度削除してください" });

/**
 * requestStaticDeploy の結果。generation = この依頼に割り当てた世代(D9 が Publish の行と結びつける)、
 * version = その世代で焼いた版(削除の依頼なら null。publishSite は自分の版のときだけ世代を返す)、deployedAt = その世代そのものを配り終えた時刻
 */
export type StaticDeployOutcome = { state: StaticDeployState; generation: StaticGeneration | null; version: number | null; deployedAt: string | null };

/** 世代。epoch = max(created_at, static_epoch)(新しい Site は static_epoch = 0 なので created_at。plan K2) */
export const genOf = (row: SiteRow): StaticGeneration => ({ epoch: Math.max(row.created_at, row.static_epoch), seq: row.static_seq });

/**
 * D1 に行が残っている Site の世代が、削除の墓標に負けている(削除の途中、または途中で止まった削除・ワークスペースの同時削除で残った Site)。
 * 自動では戻さない。戻すのは「配信ファイルを作り直す」(recoverTombstone)だけ(plan K2・K23)
 */
export function isTombstoneOver(g: StaticGeneration | null, mine: StaticGeneration): boolean {
  return g !== null && g.seq === SITE_REMOVED_SEQ && g.epoch >= mine.epoch;
}

/**
 * epoch を墓標の epoch + 1 に進め、seq を進めて印を立てる。ほかの処理が先に epoch を進めていれば null(その処理が出し直す)。
 * 削除の印(static_removing)が立っていても null: 作り直しが印を消した後に新しい削除が始まっていたら、epoch を進めない(配信を戻さない)。
 * 進めると、その削除が D1 の行を消した後に配信ファイルだけが残るため(plan K23)
 */
async function advanceEpoch(db: Db, row: SiteRow, tombstone: StaticGeneration): Promise<SiteRow | null> {
  const upd = await db
    .updateTable("sites")
    .set({ static_epoch: tombstone.epoch + 1, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
    .where("id", "=", row.id)
    .where("static_epoch", "=", row.static_epoch)
    .where("static_removing", "is", null)
    .returningAll()
    .executeTakeFirst();
  return upd ?? null;
}

/** 公開中の版の config(D1 の公開履歴。KV と同じ本体)。無ければ null */
async function activeConfigJson(db: Db, row: SiteRow): Promise<unknown | null> {
  if (row.active_version === null) return null;
  const pub = await db.selectFrom("publishes").select("config_json").where("site_id", "=", row.id).where("version", "=", row.active_version).executeTakeFirst();
  return pub?.config_json ? JSON.parse(pub.config_json) : null;
}

/**
 * 配っている版を記録する UPDATE の set(plan K20)。版が今と違うときだけ、同じ文で前の版(static_prev_served_version)と
 * 切り替えの時刻(static_served_at)を残す。SET の右辺は更新前の行の値で評価される。同じ版なら前の版と時刻は動かさない
 */
function servedVersionSet(servedVersion: number | null, now: number) {
  return {
    static_served_version: servedVersion,
    static_prev_served_version: sql<number | null>`case when static_served_version is ${servedVersion} then static_prev_served_version else static_served_version end`,
    static_served_at: sql<number | null>`case when static_served_version is ${servedVersion} then static_served_at else ${now} end`,
  };
}

/**
 * 出し直しが済んだ印(static_stale)を下ろし、配っている版(servedVersion)を記録する(plan K20)。settle と reconcileStatic の共通の UPDATE。
 * 下ろすのは同じ Site(created_at)・同じ epoch・同じ seq のときだけ(より新しい依頼・作り直した Site・epoch を進めた後の古い結果では下ろさない)。
 * 戻り値 = 更新した行数(0 なら条件が合わず、印は下りていない)
 */
async function clearStaticStale(db: Db, row: SiteRow, seq: number, servedVersion: number | null): Promise<number> {
  const upd = await db
    .updateTable("sites")
    .set({ static_stale: 0, ...servedVersionSet(servedVersion, Date.now()) })
    .where("id", "=", row.id)
    .where("created_at", "=", row.created_at)
    .where("static_epoch", "=", row.static_epoch)
    .where("static_seq", "=", seq)
    .executeTakeFirst();
  return Number(upd.numUpdatedRows);
}

/**
 * 墓標が自分の世代より新しく、deployer が受け付けた(accepted)か配り終えた(deployed)なら、その墓標を返す(無ければ null)。
 * 受け付けただけの墓標(CF API の失敗で alarm の再試行待ち)も含める。見落とすと、依頼は deployer に捨てられ、後の alarm でファイルが消える
 */
function tombstoneOver(result: StaticDeployResult, gen: StaticGeneration): StaticGeneration | null {
  if (isTombstoneOver(result.deployed, gen)) return result.deployed;
  if (isTombstoneOver(result.accepted, gen)) return result.accepted;
  return null;
}

/**
 * 結果を見て、依頼した世代かそれより新しい中身が配られていれば印を下ろす(clearStaticStale)。
 * 受け付けられた・配られているのが削除の墓標なら "tombstone"(「配信済み」にしない。呼び出し側は、recoverTombstone のときだけ epoch を進めて出し直す)
 */
async function settle(db: Db, row: SiteRow, gen: StaticGeneration, servedVersion: number | null, result: StaticDeployResult): Promise<StaticDeployState | "tombstone"> {
  if (tombstoneOver(result, gen)) return "tombstone";
  if (result.deployed && compareGeneration(result.deployed, gen) >= 0) {
    await clearStaticStale(db, row, gen.seq, servedVersion);
    return "deployed";
  }
  if (result.state === "rejected") console.error("static deploy rejected", result.error);
  return "pending";
}

/**
 * Site の配信ファイルを今の D1 の状態で出し直す。公開中の版が無ければ削除を頼む。例外は投げない(Publish の成功を覆さない)。
 * force = 前回と同じ中身でもデプロイさせる(管理画面の「配信ファイルを作り直す」)。
 * recoverTombstone = 「配信ファイルを作り直す」だけが渡す。結果が墓標なら epoch を墓標 + 1 に進めて 1 回だけ出し直す(plan K2・K23)
 */
export async function requestStaticDeploy(env: Env, db: Db, siteId: string, opts: { force?: boolean; recoverTombstone?: boolean } = {}): Promise<StaticDeployOutcome> {
  let generation: StaticGeneration | null = null;
  let version: number | null = null;
  try {
    // 世代を進める UPDATE も try の中(D1 の失敗も pending にする。印は activation・設定の保存の UPDATE で立っているので、自己修復が拾う)
    const row = await db
      .updateTable("sites")
      .set({ static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "=", siteId)
      .returningAll()
      .executeTakeFirst();
    if (!row) return { state: "skipped", generation: null, version: null, deployedAt: null };
    generation = genOf(row);
    version = row.active_version; // この世代の入力の版(公開中の版が無ければ削除の依頼で null)
    if (!env.DEPLOYER) {
      console.error("static deploy skipped: DEPLOYER binding is not configured");
      return { state: "skipped", generation, version, deployedAt: null };
    }
    const config = await activeConfigJson(db, row);
    if (config === null) version = null;
    const call =
      config === null
        ? env.DEPLOYER.removeSite({ protocol: 1, siteId, generation })
        : env.DEPLOYER.redeploySite({ protocol: 1, siteId, generation, config, settings: siteToSettings(row), apiBase: edgeOrigin(env), ...(opts.force ? { force: true } : {}) });
    const result = await withTimeout(call, STATIC_WAIT_MS);
    if (result === "timeout") return { state: "pending", generation, version, deployedAt: null };
    const state = await settle(db, row, generation, version, result);
    if (state === "tombstone") {
      // 削除の墓標に負けている(削除の途中、または途中で止まった削除)。「配信済み」にせず pending(印は立ったまま)。自動では戻さない(plan K2・K23)。
      // 「配信ファイルを作り直す」(recoverTombstone。削除の印を消した後に呼ぶ)のときだけ、epoch を墓標 + 1 に進めて 1 回だけ出し直す(再帰では渡さない。ループしない)
      const tomb = tombstoneOver(result, generation)!; // settle が "tombstone" を返したので必ずある
      if (!opts.recoverTombstone || !(await advanceEpoch(db, row, tomb))) return { state: "pending", generation, version, deployedAt: null };
      return requestStaticDeploy(env, db, siteId, opts.force ? { force: true } : {});
    }
    const exact = state === "deployed" && result.deployed !== null && compareGeneration(result.deployed, generation) === 0;
    return { state, generation, version, deployedAt: exact ? result.deployedAt : null };
  } catch (e) {
    console.error("static deploy request failed", e);
    return { state: "pending", generation, version, deployedAt: null };
  }
}

/**
 * Site の削除の前に配信ファイルを消す(plan K23)。token = 削除ごとの印(呼び出し側が D1 の削除の条件に使う)。
 * 最初に印(static_removing = token)と static_stale = 1 を立て、返った行(最新)から墓標の世代を作る(古い行を使わない)。
 * 削除へ進んでよいのは、結果の accepted がちょうど送った墓標の世代のときだけ(deployed = 配り終えた / pending = 受け付けて alarm で再試行する)。
 * 届かない・待ち切れない・rejected・accepted が送った墓標でない(より新しい通常の世代に追い越された等)ときは throw(呼び出し側が 503 にして Site を残す)。
 * skipped = 行が無い、または binding が無い(テストとローカル開発だけ)。binding が無くても印は先に立てる(D1 の削除の条件が通る)
 */
export async function requestStaticRemoval(env: Env, db: Db, siteId: string, token: string): Promise<StaticDeployState> {
  const row = await db
    .updateTable("sites")
    .set({ static_removing: token, static_stale: 1 })
    .where("id", "=", siteId)
    .returningAll()
    .executeTakeFirst();
  if (!row) return "skipped";
  if (!env.DEPLOYER) return "skipped";
  const generation = { epoch: genOf(row).epoch, seq: SITE_REMOVED_SEQ };
  const result = await withTimeout(env.DEPLOYER.removeSite({ protocol: 1, siteId, generation }), STATIC_WAIT_MS);
  // 待ち切れなかった: 墓標を受け付けたか分からない(配信ファイルが消えているかもしれない)ので、印を残して throw する
  // (画面に「削除が途中で止まっています」が出て、もう一度削除するか作り直しで戻す)
  if (result === "timeout") throw new Error("static remove timed out");
  // rejected・accepted が送った墓標でない: 墓標は受け付けられていない(何も消していない)。自分の印だけを消してから throw する
  // (「削除が途中で止まっています」を出さない。後から別の削除が立てた印は消さない)
  const notAccepted =
    result.state === "rejected"
      ? `static remove rejected: ${result.error ?? ""}`
      : result.accepted === null || compareGeneration(result.accepted, generation) !== 0
        ? "static remove overtaken: the accepted generation is not this tombstone"
        : null;
  if (notAccepted !== null) {
    await db.updateTable("sites").set({ static_removing: null }).where("id", "=", siteId).where("static_removing", "=", token).execute();
    throw new Error(notAccepted);
  }
  return result.state === "deployed" ? "deployed" : "pending";
}

/**
 * GET /sites/:sid の自己修復(plan K5 ④)。stale のときだけデプロイ専用の Worker の状態を見る(API は呼ばない)。
 * 済んでいれば印を下ろす。墓標に負けていても何もしない(自動では戻さない。plan K2・K23)。
 * 依頼が届いていなければ(移行の直後・取りこぼし)waitUntil で依頼し直す。戻り値 = 呼び出し後も stale か
 */
export async function reconcileStatic(env: Env, db: Db, site: SiteRow, waitUntil: (p: Promise<unknown>) => void): Promise<boolean> {
  if (site.static_stale !== 1) return false;
  if (!env.DEPLOYER) return true;
  try {
    const st = await withTimeout(env.DEPLOYER.siteStatus(site.id), 2_000);
    if (st === "timeout") return true;
    const mine = genOf(site);
    if (isTombstoneOver(st.deployed, mine)) {
      // 削除の墓標が配られている Site(削除の途中、または途中で止まった削除・同時削除で残った)。「配信済み」にせず、epoch も進めない。
      // 印は stale のまま返し、管理画面が(static_removing が立っていれば「削除が途中で止まっています」と)「配信ファイルを作り直す」を出す
      return true;
    }
    // 墓標を受け付けただけで、まだ配っていない(削除の途中か、デプロイの再試行中)。こちらも何もしない
    if (isTombstoneOver(st.accepted, mine)) return true;
    if (st.deployed && compareGeneration(st.deployed, mine) >= 0) {
      // where の条件が同じ世代(Site・epoch・seq)なので、その世代で焼いた版は今の行の active_version と一致する
      return (await clearStaticStale(db, site, site.static_seq, site.active_version)) === 0;
    }
    if (!st.accepted || compareGeneration(st.accepted, mine) < 0) waitUntil(requestStaticDeploy(env, db, site.id));
    return true;
  } catch (e) {
    console.error("static status failed", e);
    return true;
  }
}

/** bootstrap に焼く設定(runtime 向けの部分)が変わったか(plan K5 ②) */
export function bootstrapSettingsChanged(before: SiteRow, after: SiteRow): boolean {
  return JSON.stringify(toRuntimeSettings(siteToSettings(before))) !== JSON.stringify(toRuntimeSettings(siteToSettings(after)));
}
