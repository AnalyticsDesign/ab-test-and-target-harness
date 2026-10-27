import { sql } from "kysely";
import {
  compareGeneration,
  SITE_REMOVED_SEQ,
  STATIC_BATCH_MAX,
  staticInputDigest,
  type StaticBatchDeployRequest,
  type StaticBatchDeployResult,
  type StaticGeneration,
  type StaticInstanceStatus,
} from "@wtt/core";
import { edgeOrigin } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { siteToSettings } from "./site-settings";
import { aheadOf, compareContent, genOf, isTombstoneOver, recordDeployRequests, STATIC_WAIT_MS, withTimeout } from "./static-delivery";
import { NOT_FROZEN_SQL } from "./write-freeze";

/**
 * 7o K11・K12: デプロイ専用の Worker が持つ全サイトの状態(instanceStatus)と D1 の突き合わせ(GET /static/status・Cron)と、
 * 公開中の全サイトの配信ファイルの作り直し(POST /static/rebuild・Cron の依頼し直し)
 */

/** 1 回の作り直しで扱うサイトの数(1 回の要求の外への呼び出し = instanceStatus 1 + redeploySites 5、起動はその 2 倍で 32 に収まる。K11) */
export const STATIC_REBUILD_PAGE = 25;
/** 1 頁の公開中の config の合計の上限(compiled config の上限 512KB × 5 件 = 1 回の redeploySites で送りうる最大の量。K11) */
export const STATIC_REBUILD_PAGE_BYTES = 2_621_440;
/** 初めての公開の依頼がデプロイ専用の Worker に届く途中とみなす時間(last_activated_at から。K12) */
export const STATIC_INFLIGHT_GRACE_MS = 60_000;
/** instanceStatus を待つ上限(reconcileStatic の siteStatus と同じ) */
export const STATIC_STATUS_TIMEOUT_MS = 2_000;

const UNAVAILABLE_HINT = "しばらくしてからもう一度開いてください。続くときは、デプロイ専用の Worker がデプロイされているか(デプロイガイド 2.9)を確かめてください";

/** K21: binding が無い(not_configured)と、届かない・待ち切れない(unreachable)を封筒の reason で分ける(管理画面の帯が見分ける) */
const deployerUnavailable = (reason: "not_configured" | "unreachable", detail?: unknown) =>
  new ApiError(503, "static_deployer_unavailable", {
    message: reason === "not_configured" ? "配信ファイルを更新する仕組みが設定されていません" : "デプロイ専用の Worker の状態を取得できませんでした",
    hint: UNAVAILABLE_HINT,
    reason,
    ...(detail !== undefined ? { detail: String(detail) } : {}),
  });

/** デプロイ専用の Worker の全サイトの状態を 1 回読む。binding が無い・失敗・待ち切れないときは 503 static_deployer_unavailable を投げる(K21) */
export async function readInstanceStatus(env: Env): Promise<StaticInstanceStatus> {
  if (!env.DEPLOYER) throw deployerUnavailable("not_configured");
  let st: StaticInstanceStatus | "timeout";
  try {
    st = await withTimeout(env.DEPLOYER.instanceStatus(), STATIC_STATUS_TIMEOUT_MS);
  } catch (e) {
    throw deployerUnavailable("unreachable", e);
  }
  if (st === "timeout") throw deployerUnavailable("unreachable", "timeout");
  return st;
}

/** 状態の表(K12)。モックの 7 項目 +「更新の依頼が届いていないサイト」と、確認のモーダル・帯のための数 */
export type StaticHealth = {
  pendingSites: string[];
  removingSites: string[];
  lastError: string | null;
  failures: number;
  lastDeployedAt: number | null;
  mismatchSites: string[];
  unknownSites: string[];
  undeliveredSites: string[];
  publishedSites: number;
  unpublishedWithFiles: number;
  removingInD1: number;
  needsAttention: boolean;
};

/** ID の昇順(サイト ID は ASCII なので、SQLite の TEXT の順と同じ) */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const idsJson = (ids: Iterable<string>) => JSON.stringify([...ids]);

/**
 * K11 の頁の切り方(作り直しの頁・状態の GET の digest の比較・Cron の依頼し直しが共有する)。items の順に、
 * STATIC_REBUILD_PAGE 件まで・bytesOf の合計が STATIC_REBUILD_PAGE_BYTES を超える手前まで取る(1 件目は超えても入れる。
 * 1 件だけで上限を超える config でも、いつかは扱えるようにするため)。cut = 取り残しがある
 */
export function takeWithinPage<T>(items: readonly T[], bytesOf: (item: T) => number): { taken: T[]; cut: boolean } {
  const taken: T[] = [];
  let bytes = 0;
  for (const it of items) {
    if (taken.length === STATIC_REBUILD_PAGE) break;
    const b = bytesOf(it);
    if (taken.length > 0 && bytes + b > STATIC_REBUILD_PAGE_BYTES) break;
    bytes += b;
    taken.push(it);
  }
  return { taken, cut: taken.length < items.length };
}

/** 行の読み取りに足す列: 公開中の版の公開履歴があるか(K8)と、その config の長さ(バイト。readPage と同じ式。頁で切るため) */
type InspectRow = SiteRow & { has_publish: number; config_bytes: number | null };

/**
 * (サイト, 版) の組で公開履歴の config を 1 文で読む(今の sites.active_version とは JOIN しない。読んだ行・UPDATE が返した行の版で引く)。
 * 組に合う行が無い・config_json が無いサイトは Map に入らない(公開履歴が無い = K8)
 */
async function configsByVersion(db: Db, pairs: Array<[string, number]>): Promise<Map<string, unknown>> {
  if (pairs.length === 0) return new Map();
  const res = await sql<{ site_id: string; config_json: string | null }>`
    select p.site_id, p.config_json from publishes p join json_each(${JSON.stringify(pairs)}) as j
      on p.site_id = json_extract(j.value, '$[0]') and p.version = json_extract(j.value, '$[1]')`.execute(db);
  const out = new Map<string, unknown>();
  for (const r of res.rows) if (r.config_json) out.set(r.site_id, JSON.parse(r.config_json));
  return out;
}

/**
 * K13: Cron(static-reconcile)が staticHealth と同じ突き合わせから使う分。状態の表(StaticHealth = API の応答)には載せない。
 * - rerequest = 依頼し直すサイト(unknownSites と undeliveredSites のうち公開中の版の公開履歴があるもの。id の昇順)と、公開中の config の長さ
 *   (Cron が頁のバイト数で切る。CX-02)。公開履歴の無いサイト(K8)を先に外すのは、頁の枠を毎回それで埋めないため
 *   (UPDATE の exists の条件は競合の守りとして残る)
 * - aheadToMark = 印(static_stale = 1)だけを立てるサイトと、読み直した D1 の static_epoch・static_seq の列の値(印の文の where に使う。
 *   genOf の epoch は max(created_at, static_epoch) なので使わない)。先行を読み直しで確かめた行のうち、
 *   公開中・削除の途中でない・印の無い行で、先行が通常の世代のもの(墓標は自動で扱わない = 7i K23。未公開の行は Q4 で触らない)
 * - toClear = 印を下ろすサイト(U2)。digest を比べた行のうち "match"(DO の deployed が D1 の世代ちょうどで、digest も今の入力と同じ)のもの。
 *   reconcileStatic が印を下ろす条件と同じ。列の値は読んだ行のまま(印を下ろす文の where に使う。clearStaticStaleQuery と同じ条件)
 */
export type StaticReconcileTargets = {
  rerequest: Array<{ siteId: string; bytes: number }>;
  aheadToMark: Array<{ siteId: string; staticEpoch: number; staticSeq: number }>;
  toClear: Array<{ id: string; created_at: number; static_epoch: number; static_seq: number; servedVersion: number }>;
};

/** K12: 状態の表。中身は inspectStaticHealth の health(D1 は最大 3 文) */
export async function staticHealth(db: Db, status: StaticInstanceStatus, now: number, apiBase: string | null): Promise<StaticHealth> {
  return (await inspectStaticHealth(db, status, now, apiBase)).health;
}

/**
 * K12: instanceStatus を読んだ後に D1 と突き合わせる。D1 は最大 3 文: 行の読み取り 1 + 先行の候補の読み直し 1(候補があるとき)+
 * 同じ世代の中身を比べる config の読み取り 1(印が立っていて世代が一致する行があるとき)。どれもサイトの数に比例しない
 * (読み直しと config は ID を json_each(?) の 1 bind で渡す。D1 の 1 文の bind の上限は 100)。
 * 判定の順は 墓標 → 先行(K5 の aheadOf + 読み直し。墓標も先行に入る)→ exact + digest(K6・K23)。ログは出さない(K6)。
 * D1 では未公開の行は Q4(DO の項目が removed: false)だけで数える(U1。削除の記録が先行していても数えない。両側とも配信ファイルが無く、
 * 全サイトの作り直しの対象にもならないので、数えると押しても消えない帯になる)。
 * 同じ世代の digest の比較は、id の順に takeWithinPage の頁(25 件・config の合計のバイト数)まで(CX-01)。全サイトの作り直しの後は
 * すべての公開中のサイトに印が残るので、頁で切らないと 5 分ごとの帯の取得と 15 分ごとの Cron が全サイトの config を読んで digest を作り、
 * CPU と 1 文の結果の大きさがサイトの数に比例する。比べなかった行は食い違いに数えない(Cron が match の印を下ろすので、次の回に後ろの行へ進む)。
 * apiBase = edgeOrigin(env)(digest の入力。送る入力と同じ形にする)
 */
export async function inspectStaticHealth(
  db: Db,
  status: StaticInstanceStatus,
  now: number,
  apiBase: string | null,
): Promise<{ health: StaticHealth } & StaticReconcileTargets> {
  const index = new Map(status.sites.map((s) => [s.siteId, s]));
  // 行の読み取り(1 文)。未公開の行も読む(未公開なのに配信ファイルがあるサイトと削除の途中の数)。
  // 公開履歴の有無(K8 の除外)と公開中の config の長さ(頁で切る)は、同じ文の相関の副問い合わせで見る(文を増やさない)
  const rows: InspectRow[] = await db
    .selectFrom("sites")
    .selectAll("sites")
    .select(sql<number>`exists(select 1 from publishes p where p.site_id = sites.id and p.version = sites.active_version)`.as("has_publish"))
    .select(sql<number | null>`(select length(cast(p.config_json as blob)) from publishes p where p.site_id = sites.id and p.version = sites.active_version)`.as("config_bytes"))
    .execute();
  const inD1 = new Set(rows.map((r) => r.id));

  const pending: string[] = [];
  const removing: string[] = [];
  for (const s of status.sites) {
    const done = s.deployed !== null && compareGeneration(s.deployed, s.accepted) === 0;
    if (!s.removed && !done) pending.push(s.siteId);
    if (s.removed && (s.deployed === null || compareGeneration(s.deployed, s.accepted) < 0)) removing.push(s.siteId);
  }

  const mismatch = new Set<string>();
  const unpublishedWithFiles = new Set<string>();
  const aheadCandidates = new Map<string, StaticGeneration>();
  const digestCandidates: InspectRow[] = [];
  const unknown: string[] = [];
  const undelivered: string[] = [];
  const rerequest: StaticReconcileTargets["rerequest"] = [];
  const aheadToMark: StaticReconcileTargets["aheadToMark"] = [];
  const toClear: StaticReconcileTargets["toClear"] = [];
  let published = 0;
  let removingInD1 = 0;
  const pastGrace = (r: SiteRow) => r.last_activated_at === null || now - r.last_activated_at >= STATIC_INFLIGHT_GRACE_MS;
  const bytesOf = (r: InspectRow) => r.config_bytes ?? 0;
  for (const row of rows) {
    if (row.static_removing !== null) {
      removingInD1++;
      continue; // 削除の途中の行は数えない(削除の文言が出る)
    }
    const isPublished = row.active_version !== null;
    if (isPublished) published++;
    const st = index.get(row.id);
    if (!st) {
      // 記録に無い公開中のサイト。初めての公開の依頼が届く途中(猶予の内)は数えない
      if (isPublished && pastGrace(row)) {
        unknown.push(row.id);
        if (row.has_publish) rerequest.push({ siteId: row.id, bytes: bytesOf(row) });
      }
      continue;
    }
    if (!isPublished) {
      // Q4: D1 では未公開なのに配信ファイルがある(世代の比較によらない)。削除の記録(墓標・通常の世代の削除)のほうが新しくても
      // 先行には進めない(U1。両側とも配信ファイルが無い。後で公開すれば、公開の結果とサイトの警告帯が知らせる)
      if (!st.removed) {
        mismatch.add(row.id);
        unpublishedWithFiles.add(row.id);
      }
      continue;
    }
    // K5: 受け付け済みが D1 より新しい(墓標を含む)。読み直しで確かめるまでは候補
    const ahead = aheadOf(st, row);
    if (ahead) {
      aheadCandidates.set(row.id, ahead);
      continue;
    }
    if (row.static_stale !== 1) continue; // 印の無い行は比べない(同じ世代の別の中身は、印を立てる新しい依頼でだけ生じる)
    if (compareGeneration(st.accepted, genOf(row)) < 0) {
      // 更新の依頼が届いていない(D1 の世代が新しい)。公開履歴の無いサイト(K8)と、依頼が届く途中のサイトは除く
      if (row.has_publish && pastGrace(row)) {
        undelivered.push(row.id);
        rerequest.push({ siteId: row.id, bytes: bytesOf(row) });
      }
    } else if (!st.removed) {
      digestCandidates.push(row); // accepted が D1 の世代ちょうど: 中身(digest)を比べる
    }
  }
  // Q7: D1 に行が無いのに配信ファイルがある
  for (const s of status.sites) {
    if (!s.removed && !inD1.has(s.siteId)) {
      mismatch.add(s.siteId);
      unpublishedWithFiles.add(s.siteId);
    }
  }
  // K5: 先行の候補を 1 文で読み直す。依頼は D1 を先に進めてから送るので、並行の新しい依頼なら D1 が追いついている
  if (aheadCandidates.size > 0) {
    const fresh = await db
      .selectFrom("sites")
      .selectAll()
      .where(sql<boolean>`id in (select value from json_each(${idsJson(aheadCandidates.keys())}))`)
      .execute();
    const freshById = new Map(fresh.map((r) => [r.id, r]));
    for (const [id, g] of aheadCandidates) {
      const r = freshById.get(id);
      if (!r || compareGeneration(genOf(r), g) >= 0) continue;
      mismatch.add(id);
      // K13: Cron が印だけを立てる対象(墓標・未公開・削除の途中・印のある行は入れない)
      const st = index.get(id)!;
      const tomb = isTombstoneOver(st.accepted, genOf(r)) || isTombstoneOver(st.deployed, genOf(r));
      if (!tomb && r.active_version !== null && r.static_removing === null && r.static_stale === 0) aheadToMark.push({ siteId: id, staticEpoch: r.static_epoch, staticSeq: r.static_seq });
    }
  }
  // K23: 同じ世代で中身が違う。送る入力と同じ形(公開中の config・siteToSettings(行)・apiBase)の digest と比べる。
  // 比べるのは id の順の頁(CX-01。上の inspectStaticHealth の説明)の分だけで、config の読み取りは 1 文のまま
  const compared = takeWithinPage([...digestCandidates].sort((a, b) => byId(a.id, b.id)), bytesOf).taken;
  if (compared.length > 0) {
    const configs = await configsByVersion(db, compared.map((r) => [r.id, r.active_version!]));
    for (const row of compared) {
      const config = configs.get(row.id);
      if (config === undefined) continue;
      let expected: string;
      try {
        expected = await staticInputDigest({ config, settings: siteToSettings(row), apiBase });
      } catch {
        continue; // 作れない入力は確かめられない(食い違いとも言わない)
      }
      const content = compareContent(index.get(row.id)!, genOf(row), expected);
      if (content === "differs") mismatch.add(row.id);
      // U2: 配り終えた行。reconcileStatic と同じく、印を下ろして配っている版(この世代の版 = 今の active_version)を記録する対象
      else if (content === "match") toClear.push({ id: row.id, created_at: row.created_at, static_epoch: row.static_epoch, static_seq: row.static_seq, servedVersion: row.active_version! });
    }
  }

  const lastDeployedAt = status.lastDeployedAt === null ? null : Date.parse(status.lastDeployedAt);
  const mismatchSites = [...mismatch].sort(byId);
  const health: StaticHealth = {
    pendingSites: pending.sort(byId),
    removingSites: removing.sort(byId),
    lastError: status.lastError,
    failures: status.failures,
    lastDeployedAt: lastDeployedAt !== null && Number.isFinite(lastDeployedAt) ? lastDeployedAt : null,
    mismatchSites,
    unknownSites: unknown.sort(byId),
    undeliveredSites: undelivered.sort(byId),
    publishedSites: published,
    unpublishedWithFiles: unpublishedWithFiles.size,
    removingInD1,
    // Q5: 帯は「配置の失敗が続いている」「記録が食い違っている」ときだけ(更新待ち・削除の消え残りだけでは出さない)
    needsAttention: status.lastError !== null || status.failures > 0 || mismatchSites.length > 0 || unknown.length > 0 || undelivered.length > 0,
  };
  return {
    health,
    rerequest: rerequest.sort((a, b) => byId(a.siteId, b.siteId)),
    aheadToMark: aheadToMark.sort((a, b) => byId(a.siteId, b.siteId)),
    toClear,
  };
}

/** 作り直しで送れなかったサイトと理由(K11) */
export type RebuildFailure = { siteId: string; reason: "no_publish_record" | "rejected" | "unavailable" };
/** requested = 作り直しを受け付けられた公開中のサイト / removed = 削除を受け付けられたサイト / next = 続きの after(無ければ null) */
export type RebuildOutcome = { requested: string[]; removed: string[]; skippedRemoving: string[]; failed: RebuildFailure[]; next: string | null };

type BatchSite = StaticBatchDeployRequest["sites"][number];
/** 送る要素。deploy = 公開中(依頼の記録を先に書く)/ remove = D1 では未公開か、D1 に行が無い */
type Item =
  | { kind: "deploy"; site: BatchSite; record: { siteId: string; generation: StaticGeneration; version: number; inputDigest: string } }
  | { kind: "remove"; site: BatchSite };

/**
 * K11 の頁の読み方。(1) D1 の対象の行(公開中か、index の removed: false の ID)を after より後の id の順に 25 行 (2) index だけにある ID
 * (removed: false・after より後・D1 に行が無い)を 25 件。(3) id の順に合わせ、25 件まで・公開中の config の合計が上限を超える手前まで取る
 * (1 件目は超えても入れる)。D1 は 2 文(index の ID は json_each(?) の 1 bind)
 */
async function readPage(db: Db, after: string | null, liveIds: string[]) {
  const live = idsJson(liveIds);
  const from = after ?? "";
  const d1 = await sql<{ id: string; active_version: number | null; static_removing: string | null; bytes: number | null }>`
    select s.id, s.active_version, s.static_removing, length(cast(p.config_json as blob)) as bytes
    from sites s left join publishes p on p.site_id = s.id and p.version = s.active_version
    where (s.active_version is not null or s.id in (select value from json_each(${live}))) and s.id > ${from}
    order by s.id limit ${STATIC_REBUILD_PAGE}`.execute(db);
  const onlyInIndex =
    liveIds.length === 0
      ? []
      : (
          await sql<{ id: string }>`
            select j.value as id from json_each(${live}) as j
            where j.value > ${from} and j.value not in (select id from sites)
            order by j.value limit ${STATIC_REBUILD_PAGE}`.execute(db)
        ).rows.map((r) => r.id);
  const merged = [
    ...d1.rows.map((r) => ({ id: r.id, row: r })),
    ...onlyInIndex.map((id) => ({ id, row: null })),
  ].sort((a, b) => byId(a.id, b.id));
  const { taken, cut } = takeWithinPage(merged, (m) => (m.row && m.row.active_version !== null && m.row.static_removing === null ? (m.row.bytes ?? 0) : 0));
  // 頁が満ちた(25 件か、バイト数で切った)ら最後に取った ID を返す(ちょうど 25 件で終わりなら、次の頁は空で next: null)
  const next = cut || taken.length === STATIC_REBUILD_PAGE ? taken[taken.length - 1]!.id : null;
  return {
    next,
    skippedRemoving: taken.filter((m) => m.row && m.row.static_removing !== null).map((m) => m.id),
    d1Ids: taken.filter((m) => m.row && m.row.static_removing === null).map((m) => m.id),
    missing: taken.filter((m) => m.row === null).map((m) => m.id),
  };
}

/**
 * K11: 公開中の全サイトの配信ファイルを今の D1 の中身で作り直す(1 回に 1 頁)。判定はしない: 対象の epoch を
 * E = max(now, instanceStatus の accepted.epoch の最大 + 1) へ 1 文の UPDATE で進め(今の epoch より下げない)、
 * (a) 公開中のサイトは作り直し、(b) D1 では未公開なのに配信ファイルがあるサイトは返った行の世代の削除、
 * (c) D1 に行が無いのに配信ファイルがあるサイトは墓標 { epoch: E, seq: SITE_REMOVED_SEQ } の削除を、5 件ずつ redeploySites に送る。
 * target.siteIds(Cron)のときは頁を作らず、公開中で公開中の版の公開履歴があるサイトだけを UPDATE の条件で選び直す(K13。(b)(c) は扱わない。
 * skippedRemoving は数えない)。siteIds は STATIC_REBUILD_PAGE 件まで(UPDATE の where id in が 1 件 1 bind。D1 の 1 文の bind の上限は 100)。
 * 超えたら何も書かずに投げる(呼び出し側の誤り。黙って切ると、切った分が requested にも failed にも出ず、送らなかったことが見えない)。
 * config の合計のバイト数(STATIC_REBUILD_PAGE_BYTES)は、siteIds では呼び出し側が takeWithinPage で切ってから渡す(CX-02。Cron は
 * inspectStaticHealth が同じ行の読み取りで取った長さで切る)。ここで切り直さないのは、長さを UPDATE の前に知るには文が 1 つ増え
 * (STATIC_RECONCILE_QUERIES の内訳が変わる)、UPDATE の後で切ると、世代を進めて印を立てたのに送らないサイトが出るため。
 * 呼び出し側が読んだ後に別の公開で config が大きくなった分だけは超えうる(1 回きりで、次の回は新しい長さで切る)。
 * beforeWrite = Cron の assertNotFrozen(UPDATE の前と、各記録の INSERT の前。try の外で呼ぶので停止の例外は飲まない)、
 * notFrozenSql = UPDATE と記録の INSERT の条件に NOT_FROZEN_SQL。配置の結果は待たない。
 * D1 は 1 頁で最大 9 文(頁の読み取り 2・UPDATE 1・config 1・記録 最大 5)、RPC は redeploySites 最大 5 回。
 * beforeWrite が D1 を読むとき(Cron の assertNotFrozen)は、さらに UPDATE の前 1 + 記録の 5 件ごとに 1(最大 6。STATIC_RECONCILE_QUERIES の内訳)
 */
export async function rebuildStaticFiles(
  env: Env,
  db: Db,
  target: { after: string | null } | { siteIds: string[] },
  opts: { status: StaticInstanceStatus; now: number; force: boolean; beforeWrite?: () => Promise<void>; notFrozenSql?: boolean },
): Promise<RebuildOutcome> {
  const deployer = env.DEPLOYER;
  if (!deployer) throw deployerUnavailable("not_configured");
  const out: RebuildOutcome = { requested: [], removed: [], skippedRemoving: [], failed: [], next: null };
  // 古い状態を読んだ作り直しが後から UPDATE しても、新しい作り直しの epoch を戻さない(UPDATE の max(static_epoch, E))
  const epoch = opts.status.sites.reduce((m, s) => Math.max(m, s.accepted.epoch + 1), opts.now);
  const bySiteIds = "siteIds" in target;
  let ids: string[];
  let missing: string[] = [];
  if (bySiteIds) {
    if (target.siteIds.length > STATIC_REBUILD_PAGE) throw new Error(`rebuildStaticFiles: siteIds must have at most ${STATIC_REBUILD_PAGE} entries (got ${target.siteIds.length})`);
    ids = target.siteIds;
  } else {
    const page = await readPage(db, target.after, opts.status.sites.filter((s) => !s.removed).map((s) => s.siteId));
    out.next = page.next;
    out.skippedRemoving = page.skippedRemoving;
    ids = page.d1Ids;
    missing = page.missing;
  }

  // (a)(b) の世代を 1 文で進める。削除の途中のサイトは条件で入れ直して外す(読んだ後に削除が始まっても進めない)
  let rows: SiteRow[] = [];
  if (ids.length > 0) {
    if (opts.beforeWrite) await opts.beforeWrite();
    let q = db
      .updateTable("sites")
      .set({ static_epoch: sql<number>`max(static_epoch, ${epoch})`, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "in", ids)
      .where("static_removing", "is", null);
    if (bySiteIds) {
      // K13: Cron は公開中で公開中の版の公開履歴があるサイトだけ(15 分ごとに epoch を進め続けない)
      q = q.where("active_version", "is not", null).where(sql<boolean>`exists(select 1 from publishes p where p.site_id = sites.id and p.version = sites.active_version)`);
    }
    if (opts.notFrozenSql) q = q.where(sql.raw<boolean>(NOT_FROZEN_SQL));
    rows = await q.returningAll().execute();
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));

  // (a) の config は UPDATE が返した行の版で読む(後から別の公開が入っても、世代・config・記録する版が同じ組になる。CX-High-3)
  const configs = await configsByVersion(db, rows.filter((r) => r.active_version !== null).map((r) => [r.id, r.active_version!]));
  const apiBase = edgeOrigin(env);
  const items: Item[] = [];
  for (const id of [...rowById.keys(), ...missing].sort(byId)) {
    const row = rowById.get(id);
    if (!row) {
      items.push({ kind: "remove", site: { siteId: id, generation: { epoch, seq: SITE_REMOVED_SEQ }, remove: true } }); // (c)
      continue;
    }
    const generation = genOf(row);
    if (row.active_version === null) {
      items.push({ kind: "remove", site: { siteId: id, generation, remove: true } }); // (b) 通常の世代の削除
      continue;
    }
    const config = configs.get(id);
    if (config === undefined) {
      // K8: 公開中の版はあるのに公開履歴が無い。送らない(配信ファイルを消さない)。印は UPDATE で立ったまま
      console.error("static deploy skipped: active version has no publish record", id, row.active_version);
      out.failed.push({ siteId: id, reason: "no_publish_record" });
      continue;
    }
    const input = { config, settings: siteToSettings(row), apiBase };
    let inputDigest: string;
    try {
      inputDigest = await staticInputDigest(input); // requestStaticDeploy と同じ形の入力(digest がそろう)
    } catch (e) {
      console.error("static rebuild input invalid", id, e);
      out.failed.push({ siteId: id, reason: "rejected" });
      continue;
    }
    items.push({ kind: "deploy", site: { siteId: id, generation, ...input }, record: { siteId: id, generation, version: row.active_version, inputDigest } });
  }

  // 依頼の記録を 5 件ずつ先に書く(K24 (1))。書けなかった 5 件の公開中のサイトは送らない(印は立ったまま。自己修復か Cron が後で送る)
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += STATIC_BATCH_MAX) {
    const chunk = items.slice(i, i + STATIC_BATCH_MAX);
    const records = chunk.flatMap((it) => (it.kind === "deploy" ? [it.record] : []));
    if (records.length > 0) {
      if (opts.beforeWrite) await opts.beforeWrite(); // try の外(停止の例外を記録の失敗として飲まない)
      if (!(await recordDeployRequests(db, records, { notFrozenSql: opts.notFrozenSql }))) {
        for (const r of records) out.failed.push({ siteId: r.siteId, reason: "unavailable" });
        const rest = chunk.filter((it) => it.kind === "remove");
        if (rest.length > 0) chunks.push(rest);
        continue;
      }
    }
    chunks.push(chunk);
  }

  // 5 件ずつ送る。最後の 1 回だけ flush: "soon"(それまでは保険の遅い alarm。配置は頁ごとに 1 回)
  for (const [i, chunk] of chunks.entries()) {
    const req: StaticBatchDeployRequest = {
      protocol: 1,
      sites: chunk.map((it) => it.site),
      flush: i === chunks.length - 1 ? "soon" : "later",
      ...(opts.force ? { force: true } : {}),
    };
    let res: StaticBatchDeployResult | "timeout" | "failed";
    try {
      res = await withTimeout(deployer.redeploySites(req), STATIC_WAIT_MS);
    } catch (e) {
      console.error("static rebuild batch failed", e);
      res = "failed";
    }
    if (res === "timeout" || res === "failed") {
      // その 5 件は印が立ったまま。D1 を戻した向きのサイトは「更新の依頼が届いていないサイト」に出て、Cron と自己修復が依頼し直す(K13)
      for (const it of chunk) out.failed.push({ siteId: it.site.siteId, reason: "unavailable" });
      continue;
    }
    if (res.state === "rejected") {
      console.error("static rebuild batch rejected", res.error);
      for (const it of chunk) out.failed.push({ siteId: it.site.siteId, reason: "rejected" });
      continue;
    }
    for (const [j, it] of chunk.entries()) {
      const r = res.sites[j];
      // 応答の accepted が送った世代より新しい(並行の新しい依頼に追い越された)サイトは失敗にしない(今の D1 の中身で焼いた新しい世代がある)
      const ok = r !== undefined && r.siteId === it.site.siteId && r.error === undefined && r.accepted !== null && compareGeneration(r.accepted, it.site.generation) >= 0;
      if (!ok) out.failed.push({ siteId: it.site.siteId, reason: "rejected" });
      else (it.kind === "deploy" ? out.requested : out.removed).push(it.site.siteId);
    }
  }
  out.failed.sort((a, b) => byId(a.siteId, b.siteId));
  return out;
}
