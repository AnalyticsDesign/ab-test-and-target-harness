import { sql } from "kysely";
import { compareGeneration, SITE_REMOVED_SEQ, staticInputDigest, toRuntimeSettings, type StaticDeployResult, type StaticGeneration, type StaticSiteStatus } from "@wtt/core";
import { edgeOrigin } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { confirmDeliveries } from "./results/delivered";
import { apiGuard } from "./results/guard";
import { siteToSettings } from "./site-settings";
import { isWriteFrozen, NOT_FROZEN_SQL } from "./write-freeze";

/**
 * 決定 52: 配信ファイル(`/s/<siteId>.js`)の出し直しをデプロイ専用の Worker に頼む。
 * 入力は control が D1 から作って渡す(plan K1)。世代番号は D1 で原子的に進め、同じ行から入力を作る(plan K2)。
 * 出し直しが済まないあいだは sites.static_stale = 1(管理画面の警告。plan K4)
 */
export type StaticDeployState = "deployed" | "pending" | "skipped";
/** Publish・設定の保存で出し直しの完了を待つ上限。超えたら pending(デプロイ専用の Worker は続きを自分で流す) */
export const STATIC_WAIT_MS = 8_000;

/** p と ms の早い方。待ち切れなければ "timeout"(p は止めない) */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
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
 * version = その世代で焼いた版(削除の依頼なら null。publishSite は自分の版のときだけ世代を返す)、deployedAt = その世代そのもの(中身も同じ)を配り終えた時刻。
 * digest = 送った入力の digest(7o K24。pending でも送ったなら入る)。送っていない(skipped・削除の依頼・依頼の記録を書けなかった・
 * 公開履歴が無い)なら null。publishSite は null なら届く定義の行に世代を書かない
 */
export type StaticDeployOutcome = { failed?: true; state: StaticDeployState; generation: StaticGeneration | null; version: number | null; deployedAt: string | null; digest: string | null };

/** 世代。epoch = max(created_at, static_epoch)(新しい Site は static_epoch = 0 なので created_at。plan K2) */
export const genOf = (row: SiteRow): StaticGeneration => ({ epoch: Math.max(row.created_at, row.static_epoch), seq: row.static_seq });

/**
 * 7o K5: デプロイ専用の Worker の受け付け済みの世代(accepted)が D1 の行の世代より新しければ、その世代(墓標も返す。墓標かどうかは呼び出し側が
 * 先に isTombstoneOver で分ける)。accepted は deployed 以上なので accepted だけを見る。読み直しで確かめる前の候補(confirmAhead)
 */
export function aheadOf(st: { accepted: StaticGeneration | null }, row: SiteRow): StaticGeneration | null {
  return st.accepted && compareGeneration(st.accepted, genOf(row)) > 0 ? st.accepted : null;
}

/**
 * 7o K5: D1 の行を読み直し、その世代がまだ g より古いときだけ true(行が無ければ false)。依頼は必ず D1 を先に進めてから送るので、
 * デプロイ専用の Worker の状態を読んだ後に D1 を読み直せば、並行する新しい依頼なら D1 が追いついている(先行ではない)
 */
export async function confirmAhead(db: Db, siteId: string, g: StaticGeneration): Promise<boolean> {
  const row = await db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
  return row !== undefined && compareGeneration(genOf(row), g) < 0;
}

/**
 * 7o K6・K23: 世代 gen の結果を、期待する digest(expected。送った入力・D1 の今の入力の digest。削除なら undefined)と比べる。
 * - "match": 配った世代が gen ちょうどで、その digest が期待と同じ(削除は digest が無いこと)
 * - "differs": 受け付けた・配った世代が gen ちょうどで、digest が期待と違う(D1 を戻して seq が同じ値に戻った)
 * - "unknown": どちらでもない(まだ配っていない・配った世代が違う・digest が分からない古い応答)。digest が不明なことを理由に「済み」にしない
 * settle・reconcileStatic・状態の GET(static-health.ts の staticHealth)が共有する
 */
export function compareContent(
  st: { accepted: StaticGeneration | null; deployed: StaticGeneration | null; acceptedDigest?: string; deployedDigest?: string },
  gen: StaticGeneration,
  expected: string | undefined,
): "match" | "differs" | "unknown" {
  const at = (g: StaticGeneration | null) => g !== null && compareGeneration(g, gen) === 0;
  // 期待が digest のときは、相手の digest があって違うときだけ「違う」。削除(期待が undefined)のときは、相手に digest があれば中身がある
  const differs = (d: string | undefined) => d !== undefined && d !== expected;
  if ((at(st.accepted) && differs(st.acceptedDigest)) || (at(st.deployed) && differs(st.deployedDigest))) return "differs";
  if (at(st.deployed) && st.deployedDigest === expected) return "match";
  return "unknown";
}

/**
 * D1 に行が残っている Site の世代が、削除の墓標に負けている(削除の途中、または途中で止まった削除・ワークスペースの同時削除で残った Site)。
 * 自動では戻さない。戻すのは「配信ファイルを作り直す」(recover)だけ(plan K2・K23)
 */
export function isTombstoneOver(g: StaticGeneration | null, mine: StaticGeneration): boolean {
  return g !== null && g.seq === SITE_REMOVED_SEQ && g.epoch >= mine.epoch;
}

/**
 * epoch を g(デプロイ専用の Worker が受け付け済みの世代: 削除の墓標か、D1 より先行した世代か、同じ世代の別の中身。7o K7)の epoch + 1 に進め、
 * seq を進めて印を立てる。ほかの処理が先に epoch を進めていれば null(その処理が出し直す)。
 * 削除の印(static_removing)が立っていても null: 作り直しが印を消した後に新しい削除が始まっていたら、epoch を進めない(配信を戻さない)。
 * 進めると、その削除が D1 の行を消した後に配信ファイルだけが残るため(plan K23)
 */
async function advanceEpoch(db: Db, row: SiteRow, g: StaticGeneration): Promise<SiteRow | null> {
  const upd = await db
    .updateTable("sites")
    .set({ static_epoch: g.epoch + 1, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
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
 * 出し直しが済んだ印(static_stale)を下ろし、配っている版(servedVersion)を記録する UPDATE(plan K20)。
 * settle・reconcileStatic(clearStaticStale)と、15 分ごとの Cron の印を下ろす段(7o U2。条件を足して batch に入れる)が共有する。
 * 下ろすのは同じ Site(created_at)・同じ epoch・同じ seq のときだけ(より新しい依頼・作り直した Site・epoch を進めた後の古い結果では下ろさない)
 */
export function clearStaticStaleQuery(
  db: Db,
  row: { id: string; created_at: number; static_epoch: number },
  seq: number,
  servedVersion: number | null,
  now: number,
) {
  return db
    .updateTable("sites")
    .set({ static_stale: 0, ...servedVersionSet(servedVersion, now) })
    .where("id", "=", row.id)
    .where("created_at", "=", row.created_at)
    .where("static_epoch", "=", row.static_epoch)
    .where("static_seq", "=", seq);
}

/** clearStaticStaleQuery を 1 文で流す(settle と reconcileStatic)。戻り値 = 更新した行数(0 なら条件が合わず、印は下りていない) */
async function clearStaticStale(db: Db, row: SiteRow, seq: number, servedVersion: number | null): Promise<number> {
  const upd = await clearStaticStaleQuery(db, row, seq, servedVersion, Date.now()).executeTakeFirst();
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
 * 結果を見て、依頼した世代そのもの(中身も同じ)が配られていれば印を下ろす(clearStaticStale)。判定の順は 墓標 → 先行 → exact + digest(7o K5・K6・K23)。
 * - "tombstone": 受け付けられた・配られているのが削除の墓標(「配信済み」にしない)
 * - "ahead": デプロイ専用の Worker の受け付け済みの世代が D1 より新しい(D1 を読み直して確かめた)か、同じ世代で中身(digest)が違う。
 *   accepted が先行していれば、deployed が依頼の世代と同じでもここで止まる
 * - "deployed": 配った世代が依頼の世代ちょうどで、digest が送った入力と同じ(digest が分からない古い応答では「済み」にしない)
 * 呼び出し側は "tombstone" と "ahead" を同じに扱い、recover のときだけ epoch を進めて出し直す。
 * ログ(先行・同じ世代の別の中身)はここだけで出す(自己修復と状態の GET では出さない。秘密・config は出さない)。
 * expected = 送った入力の digest(削除の依頼は undefined)
 */
async function settle(
  db: Db,
  row: SiteRow,
  gen: StaticGeneration,
  servedVersion: number | null,
  result: StaticDeployResult,
  expected: string | undefined,
): Promise<StaticDeployState | "tombstone" | "ahead"> {
  if (tombstoneOver(result, gen)) return "tombstone";
  // row は世代を進めた UPDATE が返した行なので genOf(row) = gen。並行する新しい依頼に追い越されただけなら、読み直した D1 が追いついている
  const ahead = aheadOf(result, row);
  if (ahead && (await confirmAhead(db, row.id, ahead))) {
    console.error("static generation ahead of D1", row.id, { d1: gen, deployer: ahead });
    return "ahead";
  }
  const content = compareContent(result, gen, expected);
  if (content === "differs") {
    console.error("static content differs at the same generation", row.id, { generation: gen });
    return "ahead";
  }
  if (content === "match") {
    await clearStaticStale(db, row, gen.seq, servedVersion);
    return "deployed";
  }
  if (result.state === "rejected") console.error("static deploy rejected", result.error);
  return "pending";
}

/**
 * 「世代 → この出し直しで焼いた版」と送る入力の digest を残す(7o K24)。依頼を送る前の必須の手順で、書けたかを返す
 * (書けなければ呼び出し側は送らない。更新の後に送る依頼には必ず digest 付きの記録があり、記録が無いのは更新前の世代だけになる)。
 * 同じ世代の記録が既にあれば足さない(その記録を使う)。
 * onConflict doNothing の前提: 同じ (サイト, 世代) の行が既にあれば、その input_digest が今回と違っても成功として扱う。
 * D1 を過去の時点に戻すと sites と static_deploy_requests は一緒に戻るので、再利用された世代の古い行が戻した後に残ることは無い
 * (同じ世代の行があるのは、同じ依頼を送り直したときだけ)。recordDeployRequests も同じ前提
 */
async function recordDeployRequest(db: Db, siteId: string, generation: StaticGeneration, version: number, digest: string): Promise<boolean> {
  try {
    await db
      .insertInto("static_deploy_requests")
      .values({ site_id: siteId, epoch: generation.epoch, seq: generation.seq, version, requested_at: Date.now(), input_digest: digest })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return true;
  } catch (e) {
    console.error("static deploy request record failed", e);
    return false;
  }
}

/**
 * 7o K11・K24: 「世代 → 焼いた版」と送る入力の digest を、5 行(STATIC_BATCH_MAX)までまとめて 1 文で残す(全サイトの作り直しと Cron の依頼し直し)。
 * recordDeployRequest と同じ扱い: 送る前の必須の手順で、書けなければ false(console.error は残す)。呼び出し側はその要素を redeploySites に送らない。
 * onConflict doNothing の前提も recordDeployRequest と同じ(D1 を戻すと sites と一緒に戻るので、同じ世代の古い行は残らない)。
 * notFrozenSql = Cron から呼ぶとき。INSERT … SELECT … WHERE NOT_FROZEN_SQL にし、入った行の数が rows と違えば false
 * (凍結が書く直前に入ると 0 行で、例外にならないため。新しい世代の行が既にあることは無いので、数の違いは凍結として扱う)。
 * 凍結の停止の例外(beforeWrite)は呼び出し側が try の外で投げるので、ここでは飲まない
 */
export async function recordDeployRequests(
  db: Db,
  rows: Array<{ siteId: string; generation: StaticGeneration; version: number; inputDigest: string }>,
  opts: { notFrozenSql?: boolean } = {},
): Promise<boolean> {
  if (rows.length === 0) return true;
  // 行は 1 パラメータの JSON で渡し、json_each で行にする(行の数にかかわらずパラメータは一定)
  const items = JSON.stringify(rows.map((r) => [r.siteId, r.generation.epoch, r.generation.seq, r.version, r.inputDigest]));
  try {
    const res = await sql`
      insert into static_deploy_requests (site_id, epoch, seq, version, requested_at, input_digest)
      select json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), ${Date.now()}, json_extract(j.value, '$[4]')
      from json_each(${items}) as j
      where ${opts.notFrozenSql ? sql.raw(NOT_FROZEN_SQL) : sql`1`}
      on conflict do nothing`.execute(db);
    if (opts.notFrozenSql && Number(res.numAffectedRows ?? 0n) !== rows.length) {
      console.warn("static deploy request record skipped (write freeze)", rows.length);
      return false;
    }
    return true;
  } catch (e) {
    console.error("static deploy request record failed", e);
    return false;
  }
}

/**
 * Site の配信ファイルを今の D1 の状態で出し直す。公開中の版が無ければ削除を頼む。例外は投げない(Publish の成功を覆さない)。
 * force = 前回と同じ中身でもデプロイさせる(管理画面の「配信ファイルを作り直す」)。
 * recover = 「配信ファイルを作り直す」だけが渡す。結果が墓標・D1 より先行した世代・同じ世代の別の中身なら、epoch を結果の accepted + 1 に進めて
 * 1 回だけ出し直す(plan K2・K23、7o K7)
 */
export async function requestStaticDeploy(env: Env, db: Db, siteId: string, opts: { force?: boolean; recover?: boolean } = {}): Promise<StaticDeployOutcome> {
  let generation: StaticGeneration | null = null;
  let version: number | null = null;
  let digest: string | null = null;
  try {
    // 世代を進める UPDATE も try の中(D1 の失敗も pending にする。印は activation・設定の保存の UPDATE で立っているので、自己修復が拾う)
    const row = await db
      .updateTable("sites")
      .set({ static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "=", siteId)
      .returningAll()
      .executeTakeFirst();
    if (!row) return { state: "skipped", generation: null, version: null, deployedAt: null, digest: null };
    generation = genOf(row);
    version = row.active_version; // この世代の入力の版(公開中の版が無ければ削除の依頼で null)
    if (!env.DEPLOYER) {
      console.error("static deploy skipped: DEPLOYER binding is not configured");
      return { state: "skipped", generation, version, deployedAt: null, digest: null };
    }
    const config = await activeConfigJson(db, row);
    if (config === null && row.active_version !== null) {
      // 7o K8: 公開中の版はあるのに公開履歴の行が無い(手で SQL を流した復旧など)。削除の依頼を送らない(配信ファイルを消さない)。
      // 印は世代を進めた UPDATE で立ったまま。自己修復と Cron はこのサイトを依頼し直さない
      console.error("static deploy skipped: active version has no publish record", siteId, row.active_version);
      return { state: "pending", generation, version: null, deployedAt: null, digest: null };
    }
    let call: Promise<StaticDeployResult>;
    if (config === null) {
      version = null;
      call = env.DEPLOYER.removeSite({ protocol: 1, siteId, generation });
    } else {
      const input = { config, settings: siteToSettings(row), apiBase: edgeOrigin(env) };
      // 送る入力の digest を 1 回だけ作る(D1 から作って検証済みの入力なので、throw は不具合。下の catch で pending にする)
      const sent = await staticInputDigest(input);
      // D9 ③(plan ③ の K14)・7o K24: 「世代 → この出し直しで焼いた版」と送る入力の digest を、依頼の前に書く(待ち切れない・失敗した依頼の世代も、
      // 後で配られたら引けるように)。書けなければ送らない(stale は立ったまま。自己修復か Cron の依頼し直しが後で送る)
      if (!(await recordDeployRequest(db, siteId, generation, version!, sent))) return { failed: true, state: "pending", generation, version, deployedAt: null, digest: null };
      digest = sent;
      call = env.DEPLOYER.redeploySite({ protocol: 1, siteId, generation, ...input, ...(opts.force ? { force: true } : {}) });
    }
    const result = await withTimeout(call, STATIC_WAIT_MS);
    if (result === "timeout") return { state: "pending", generation, version, deployedAt: null, digest };
    const state = await settle(db, row, generation, version, result, digest ?? undefined);
    if (state === "tombstone" || state === "ahead") {
      // 削除の墓標に負けている(削除の途中、または途中で止まった削除)か、D1 より先行した世代・同じ世代の別の中身を持っている(D1 を戻した後など)。
      // 「配信済み」にせず pending(印は立ったまま)。自動では戻さない(plan K2・K23、7o K2)。
      // 「配信ファイルを作り直す」(recover。削除の印を消した後に呼ぶ)のときだけ、epoch を結果の accepted + 1 に進めて 1 回だけ出し直す
      // (再帰では recover を渡さない。ループしない)
      const over = result.accepted ?? tombstoneOver(result, generation) ?? generation; // accepted は deployed 以上なので、墓標でも先行でも accepted を使う
      if (!opts.recover || !(await advanceEpoch(db, row, over))) return { state: "pending", generation, version, deployedAt: null, digest };
      return requestStaticDeploy(env, db, siteId, opts.force ? { force: true } : {});
    }
    // "deployed" は世代と digest の両方が一致したときだけ(settle)なので、その時刻はこの世代そのものを配り終えた時刻
    return { state, generation, version, deployedAt: state === "deployed" ? result.deployedAt : null, digest };
  } catch (e) {
    console.error("static deploy request failed", e);
    return { failed: true, state: "pending", generation, version, deployedAt: null, digest };
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
 * 判定の順は 墓標 → 先行 → exact + digest(7o K5・K6・K23)。済んでいれば印を下ろす。
 * 墓標に負けている・D1 より先行している・同じ世代で中身が違うときは何もしない(自動では戻さない。plan K2・K23、7o K2)で、mismatch = true。
 * 公開履歴が無いサイト(7o K8)は依頼し直さない。依頼が届いていなければ(移行の直後・取りこぼし)waitUntil で依頼し直す。
 * ログは出さない(食い違いのあいだ、GET のたびに出ないように。出すのは settle だけ)。
 * 戻り値 = stale: 呼び出し後も stale か / mismatch: デプロイ専用の Worker の記録が D1 と食い違っている(墓標・先行・同じ世代の別の中身)
 */
export async function reconcileStatic(env: Env, db: Db, site: SiteRow, waitUntil: (p: Promise<unknown>) => void): Promise<{ stale: boolean; mismatch: boolean }> {
  const stale = { stale: true, mismatch: false };
  const mismatch = { stale: true, mismatch: true };
  if (site.static_stale !== 1) return { stale: false, mismatch: false };
  if (!env.DEPLOYER) return stale;
  try {
    const st = await withTimeout(env.DEPLOYER.siteStatus(site.id), 2_000);
    if (st === "timeout") return stale;
    const mine = genOf(site);
    // 削除の墓標が配られている・受け付けられている Site(削除の途中、または途中で止まった削除・同時削除で残った)。「配信済み」にせず、epoch も進めない。
    // 管理画面は(static_removing が立っていれば「削除が途中で止まっています」と)「配信ファイルを作り直す」を出す
    if (isTombstoneOver(st.deployed, mine) || isTombstoneOver(st.accepted, mine)) return mismatch;
    // 7o K6: 公開中の config を 1 文で読む(D1 の今の入力の digest を作るためと、公開履歴の有無を見るため)
    const config = await activeConfigJson(db, site);
    // D9 ③(plan ③ の K14・K24): 配った世代の履歴の全体で届く定義の配信を確かめる。凍結中は書かない(確かめるのは解除後の自己修復か Cron)
    await confirmFromStatus(env, db, site.id, st);
    // 7o K5: 受け付け済みが D1 より新しい(読み直しで確かめた)。依頼し直しても捨てられるので何もしない
    const ahead = aheadOf(st, site);
    if (ahead && (await confirmAhead(db, site.id, ahead))) return mismatch;
    // 7o K8: 公開中の版はあるのに公開履歴が無い。digest を作れず、依頼し直しても何も送らないので、印を残すだけ
    if (config === null && site.active_version !== null) return stale;
    // 7o K23: D1 の今の入力から digest を作って比べる(削除なら digest は無い)。作れない入力は確かめられないので下ろさない(外の catch)
    const expected = config === null ? undefined : await staticInputDigest({ config, settings: siteToSettings(site), apiBase: edgeOrigin(env) });
    const content = compareContent(st, mine, expected);
    if (content === "differs") return mismatch;
    if (content === "match") {
      // where の条件が同じ世代(Site・epoch・seq)なので、その世代で焼いた版は今の行の active_version と一致する
      return { stale: (await clearStaticStale(db, site, site.static_seq, site.active_version)) === 0, mismatch: false };
    }
    if (!st.accepted || compareGeneration(st.accepted, mine) < 0) waitUntil(requestStaticDeploy(env, db, site.id));
    return stale;
  } catch (e) {
    console.error("static status failed", e);
    return stale;
  }
}

/** 自己修復の中の配信の確認。失敗しても自己修復を止めない(Cron が確かめ直す) */
async function confirmFromStatus(env: Env, db: Db, siteId: string, st: StaticSiteStatus): Promise<void> {
  try {
    if (await isWriteFrozen(db)) return;
    await confirmDeliveries(db, siteId, { history: st.history, historyFrom: st.historyFrom }, Date.now(), apiGuard(env));
  } catch (e) {
    console.error("delivery confirmation failed", e);
  }
}

/** bootstrap に焼く設定(runtime 向けの部分)が変わったか(plan K5 ②) */
export function bootstrapSettingsChanged(before: SiteRow, after: SiteRow): boolean {
  return JSON.stringify(toRuntimeSettings(siteToSettings(before))) !== JSON.stringify(toRuntimeSettings(siteToSettings(after)));
}
