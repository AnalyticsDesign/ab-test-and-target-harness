import { sql } from "kysely";
import { expandAudiences, staticInputDigest, type StaticDeployHistoryEntry, type StaticGeneration, type Targeting } from "@wtt/core";
import { DEFAULT_PLAN, type EvaluationPlan } from "@wtt/stats";
import type { Db, ExperimentDeliveredDefinitionRow, ExperimentRow, SiteRow, StaticDeployRequestRow } from "../db";
import type { StoredChangeInput, StoredCompileInput } from "../publish";
import { extractAssetIds } from "../asset-refs";
import { siteToSettings } from "../site-settings";
import type { WriteGuard } from "./guard";

/**
 * D9 ③(設計書 §5.5、plan ③ の K14): 実行中のテストの「訪問者に届く定義」を Publish のたびに記録し、
 * 配信ファイルの出し直しが配られたこと(デプロイ専用の Worker の history)を確かめてから有効にする。
 * 結果の記録の写し(Task 10)・パターンの複製(Task 12)・テスト中の変更の記録は、確かめた行(delivered_from がある行)だけを使う
 */

/** 届く定義。名前は入れない(名前の変更は配信に効かない。K14) */
export type DeliveredDefinition = {
  variants: Array<{ id: string; changes: StoredChangeInput[] }>;
  urlMatch: unknown;
  /** オーディエンスの参照をその時点の定義に置き換えた形(オーディエンスの編集もテスト中の変更として拾う)。配信条件が無ければ null */
  targeting: unknown;
  /** 判定に使う目標(その時点の config)。選んでいなければ null */
  primaryGoal: { id: string; config: unknown } | null;
};

/** キーの順を揃えた JSON(同じ定義は同じ文字列 = 同じ hash。配列の順は意味があるので保つ) */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const definitionHash = (d: DeliveredDefinition): Promise<string> => sha256Hex(canonicalJson(d));

/**
 * Site の評価計画(判定に使う目標だけを使う)。行が無いテストは Map に入らない(= 判定に使う目標なし)
 */
export async function plansForDelivery(db: Db, siteId: string): Promise<Map<string, EvaluationPlan>> {
  const rows = await db.selectFrom("evaluation_plans").select(["experiment_id", "plan_json"]).where("site_id", "=", siteId).execute();
  const out = new Map<string, EvaluationPlan>();
  for (const r of rows) {
    try {
      out.set(r.experiment_id, { ...DEFAULT_PLAN, primaryGoalId: null, baselineVariantId: null, ...(JSON.parse(r.plan_json) as Partial<EvaluationPlan>) });
    } catch {
      // 読めない計画は判定に使う目標なしとして扱う(届く定義の記録で Publish を止めない)
    }
  }
  return out;
}

/**
 * compile に渡した保存済みの入力から、実行中(running)で run_id を持つテストの届く定義を作る。
 * input.experiments は running のものだけなので、一時停止中のテストは入らない(一時停止の直前の定義のまま。K14)
 */
export function deliveredDefinitionsFor(input: StoredCompileInput, rows: ExperimentRow[], plans: Map<string, EvaluationPlan>): Map<string, DeliveredDefinition> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const goals = new Map(input.goals.map((g) => [g.id, g]));
  // compile が通った後なので参照は必ず解ける。万一無ければ参照のまま残す(hash は変わるので変更として残る)
  const resolve = (id: string): Targeting => (Object.prototype.hasOwnProperty.call(input.audiences, id) ? (input.audiences[id] as Targeting) : { audience: id });
  const out = new Map<string, DeliveredDefinition>();
  for (const e of input.experiments) {
    const row = byId.get(e.id);
    if (!row || row.kind !== "test" || row.status !== "running" || row.run_id === null) continue;
    const goalId = plans.get(e.id)?.primaryGoalId ?? null;
    const goal = goalId === null ? undefined : goals.get(goalId);
    out.set(e.id, {
      variants: e.variants.map((v) => ({ id: v.id, changes: v.changes })),
      urlMatch: e.urlMatch,
      targeting: e.targeting === undefined ? null : expandAudiences(e.targeting as Targeting, resolve),
      primaryGoal: goal ? { id: goal.id, config: goal.config } : null,
    });
  }
  return out;
}

/** 世代の JSON(static_generation 列)と、照合に使うキー */
const genJson = (g: StaticGeneration): string => JSON.stringify({ epoch: g.epoch, seq: g.seq });
const genKey = (g: StaticGeneration): string => `${g.epoch}:${g.seq}`;
function parseGen(s: string | null): StaticGeneration | null {
  if (s === null) return null;
  try {
    const g = JSON.parse(s) as StaticGeneration;
    return Number.isInteger(g.epoch) && Number.isInteger(g.seq) ? g : null;
  } catch {
    return null;
  }
}

/** 記録する 1 行(hash は先に計算しておく。activation の batch の中では非同期の計算ができないため) */
export type PreparedDelivery = { experimentId: string; runId: string; json: string; hash: string };

/** 届く定義を行の形にする。run_id は compile に使った行(rows)から取る(読み直さない) */
export async function prepareDeliveredDefinitions(defs: Map<string, DeliveredDefinition>, rows: ExperimentRow[]): Promise<PreparedDelivery[]> {
  const runOf = new Map(rows.map((r) => [r.id, r.run_id]));
  const out: PreparedDelivery[] = [];
  for (const [experimentId, def] of defs) {
    const runId = runOf.get(experimentId);
    if (!runId) continue;
    const json = canonicalJson(def);
    out.push({ experimentId, runId, json, hash: await sha256Hex(json) });
  }
  return out;
}

/**
 * 届く定義の行を足す 1 文(K14)。run の定義の hash が、その run のこの版より前の最新の行と同じなら足さない。比べるのと足すのを 1 文にする。
 * fenceActive = Site の active_version がこの版のときだけ足す(publishSite は activation の CAS と同じ batch に入れる。
 * CAS が外れた試行・superseded の Publish では何も足さない = 「行がある」⇔「その版を activation した」)
 */
export function deliveredDefinitionInsert(db: Db, siteId: string, version: number, generation: StaticGeneration | null, d: PreparedDelivery, fenceActive: boolean) {
  const gen = generation ? genJson(generation) : null;
  const fence = fenceActive ? sql`and exists (select 1 from sites where id = ${siteId} and active_version = ${version})` : sql``;
  const q = sql`
    insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, static_generation, definition_json, definition_hash)
    select ${siteId}, ${d.experimentId}, ${d.runId}, ${version}, ${gen}, ${d.json}, ${d.hash}
    where not exists (select 1 from experiment_delivered_definitions where run_id = ${d.runId} and publish_version = ${version})
      and coalesce((select definition_hash from experiment_delivered_definitions
                    where run_id = ${d.runId} and publish_version < ${version} order by publish_version desc, id desc limit 1), '') <> ${d.hash}
      and exists (select 1 from experiments where site_id = ${siteId} and id = ${d.experimentId})
      ${fence}`;
  // experiments の存在を条件にする: compile の後・activation の前にエクスペリエンスが消えていたら、外部キーの違反で activation の batch ごと
  // 失敗させず、その行だけを足さない
  return { compile: () => q.compile(db) };
}

/**
 * B68(spec §3.1): 届く定義が使う画像を `asset_delivered_refs` に足す 1 文(`deliveredDefinitionInsert` の隣に同じ batch で並べる)。
 * 画像の ID は定義の JSON にそのまま現れるものだけ(`extractAssetIds`。Cron の `instr` と同じ規則。戻しはしない)。0 個なら文を作らない(null)。
 * 条件は `deliveredDefinitionInsert` にそろえる: エクスペリエンスが残っている(`INSERT OR IGNORE` は外部キーの違反を無視しないので、
 * compile の後・activation の前に消えていたら batch ごと落ちる。それを防ぐ)と、fenceActive のときの active_version。
 * 定義の hash が前と同じで定義の行を足さない公開でも書く(重なりは主キーで無視する)。画像の行は外部キーで持たない
 */
export function assetDeliveredRefsInsert(db: Db, siteId: string, version: number, d: PreparedDelivery, fenceActive: boolean) {
  const ids = extractAssetIds(d.json);
  if (ids.length === 0) return null;
  const fence = fenceActive ? sql`and exists (select 1 from sites where id = ${siteId} and active_version = ${version})` : sql``;
  const q = sql`
    insert or ignore into asset_delivered_refs (site_id, asset_id, experiment_id)
    select ${siteId}, value, ${d.experimentId} from json_each(${JSON.stringify(ids)})
    where exists (select 1 from experiments where site_id = ${siteId} and id = ${d.experimentId})
      ${fence}`;
  return { compile: () => q.compile(db) };
}

/**
 * 届く定義を直接記録する(activation の fence なし。テストと、activation の外から足す将来の補完用)。
 * publishSite は使わない(activation の batch に deliveredDefinitionInsert を入れる)
 */
export async function recordDeliveredDefinitions(
  db: Db,
  siteId: string,
  version: number,
  generation: StaticGeneration | null,
  defs: Map<string, DeliveredDefinition>,
  rows: ExperimentRow[],
): Promise<void> {
  for (const d of await prepareDeliveredDefinitions(defs, rows)) {
    const c = deliveredDefinitionInsert(db, siteId, version, generation, d, false).compile();
    await db.executeQuery(c);
    // B68: テストで作る定義でも画像の表が埋まるように、publishSite と同じ 1 文を足す
    const refs = assetDeliveredRefsInsert(db, siteId, version, d, false);
    if (refs) await db.executeQuery(refs.compile());
  }
}

/** publishSite が activation の後に、この版を焼いた出し直しの世代を行に入れる(まだ入っていないときだけ) */
export async function setDeliveredGeneration(db: Db, siteId: string, version: number, generation: StaticGeneration): Promise<void> {
  await db
    .updateTable("experiment_delivered_definitions")
    .set({ static_generation: genJson(generation) })
    .where("site_id", "=", siteId)
    .where("publish_version", "=", version)
    .where("static_generation", "is", null)
    .execute();
}

/**
 * 配信の確認がまだ要る行の条件(alias = experiment_delivered_definitions の別名)。confirmDeliveries が読む run と、
 * 15 分ごとの Cron が対象にする Site(sitesNeedingDeliveryConfirmation)は、この同じ条件で選ぶ。
 * - settled が NULL(まだ決めていない。partial で仮に確かめた行を含む)
 * - その run の最新の行が unknown(同じ定義の再公開は行を作らないので、後の世代がこの行に当たって delivered になりうる)。
 *   overtaken は後の行が確かめられたときだけ決めるので、最新の行にはならない
 */
export function needsDeliveryConfirmation(alias: string) {
  const col = (c: string) => sql.ref(`${alias}.${c}`);
  return sql<boolean>`(${col("settled")} is null or (${col("settled")} = 'unknown' and ${col("publish_version")} = (select max(x.publish_version) from experiment_delivered_definitions x where x.run_id = ${col("run_id")})))`;
}

/**
 * 配信の確認がまだ要る行を持つ Site(15 分ごとの Cron の results-delivery の対象。confirmDeliveries が読む run と同じ条件)。
 * site_id の昇順。after より後だけ・limit 件まで(Cron の続きの位置)。削除の途中の Site(static_removing)は除く
 */
export async function sitesNeedingDeliveryConfirmation(db: Db, opts: { after?: string | null; limit?: number } = {}): Promise<string[]> {
  const after = opts.after ?? null;
  const rows = await db
    .selectFrom("experiment_delivered_definitions as u")
    .innerJoin("sites as s", "s.id", "u.site_id")
    .select("u.site_id")
    .distinct()
    .where(needsDeliveryConfirmation("u"))
    .where("s.static_removing", "is", null)
    .$if(after !== null, (q) => q.where("u.site_id", ">", after!))
    .orderBy("u.site_id")
    .$if(opts.limit !== undefined, (q) => q.limit(opts.limit!))
    .execute();
  return rows.map((r) => r.site_id);
}

/** 配信の確認に渡す状態(デプロイ専用の Worker の siteStatus の history と historyFrom)。partial = Publish の応答の 1 点 */
export type DeliveryStatus = { history: StaticDeployHistoryEntry[]; historyFrom: string | null; partial?: boolean };

/**
 * 7o K24 (3): 更新前の依頼の記録(input_digest が NULL)の版から、配った入力の digest を作る関数(版ごとに覚える)。
 * 入力 = その版の config(publishes を 1 文)・今の D1 の行の設定(siteToSettings。digest の中で bootstrap に焼く部分だけを使う)・apiBase。
 * 版の config・行が無い、または digest を作れない(parse できない)なら null(照らし合わせられないので数えない)。
 * DO の値を記録に写すことはしない
 */
function legacyDigestOf(db: Db, siteId: string, apiBase: string | null): (version: number) => Promise<string | null> {
  const cache = new Map<number, Promise<string | null>>();
  let site: Promise<SiteRow | undefined> | null = null;
  const compute = async (version: number): Promise<string | null> => {
    try {
      site ??= db.selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
      const row = await site;
      const pub = await db.selectFrom("publishes").select("config_json").where("site_id", "=", siteId).where("version", "=", version).executeTakeFirst();
      if (!row || !pub?.config_json) return null;
      return await staticInputDigest({ config: JSON.parse(pub.config_json), settings: siteToSettings(row), apiBase });
    } catch {
      return null;
    }
  };
  return (version) => {
    let p = cache.get(version);
    if (!p) cache.set(version, (p = compute(version)));
    return p;
  };
}

/**
 * 7o K24 (3): 履歴の 1 点を、同じ世代の依頼の記録(req)との組で版に引く。引けなければ null(その点は数えない)。
 * rowVersion = その世代を記録に持つ届く定義の行の版(digest の無い点で、記録が無いときだけ使う = 更新前の世代)
 */
async function versionOfPoint(
  h: StaticDeployHistoryEntry,
  req: StaticDeployRequestRow | undefined,
  rowVersion: number | undefined,
  legacyDigest: (version: number) => Promise<string | null>,
): Promise<number | null> {
  if (h.digest !== undefined) {
    if (!req) return null;
    if (req.input_digest !== null) return req.input_digest === h.digest ? req.version : null;
    return (await legacyDigest(req.version)) === h.digest ? req.version : null;
  }
  if (!req) return rowVersion ?? null;
  return req.input_digest === null ? req.version : null;
}

type Work = ExperimentDeliveredDefinitionRow & { id: number; nextFrom: number | null; nextSettled: ExperimentDeliveredDefinitionRow["settled"] };

/**
 * 配信を確かめる(K14)。戻り値 = delivered_from か settled を変えた行の数。
 * - 読むのは needsDeliveryConfirmation の行を持つ run だけ(確定した run は読まない。Cron の 1 回の読み取りを抑える)
 * - history の各点を、同じ世代の依頼の記録(static_deploy_requests)との組で版 v に引く(7o K24 (3)。世代の再利用で別の中身の配信を証拠にしない):
 *   - 点に digest がある: 記録の input_digest が同じときだけ記録の版。記録の input_digest が NULL(更新前に受け付けて更新後に配った)なら、
 *     その記録の版の config・今の D1 の行の設定・apiBase から入力の digest を作り、点と同じときだけ記録の版。違う・記録が無いなら飛ばす
 *     (行の世代からの補完は使わない)
 *   - 点に digest が無い(更新前に配った): 記録が無ければその世代を記録に持つ行の版(更新前の世代)。記録の input_digest が NULL なら記録の版、
 *     digest があれば飛ばす。どれでもなければ飛ばす
 * - 各 run で「publish_version <= v で最新の行」R の delivered_from を、R に当たる点の時刻の最小値にする(後の点で先に入れていても早い方へ直す。
 *   同じ定義の再公開では前の版の行が後の世代でも確かめられ、その後で前の世代の点が見つかることがあるため)。遅い方へは動かさない
 *   (UPDATE の CASE: 並行する確認が先に早い時刻を書いていたら、それを残す)
 * - settled = 'delivered' は history の全体(partial でない)のときだけ。partial は delivered_from を仮に入れ、settled は NULL のまま
 * - overtaken / unknown も history の全体と historyFrom を受けたときだけ決める(delivered_from が無い行だけに書く)
 * - delivered_until と テスト中の変更は、行を書いた後に D1 から読み直した delivered_from で作る(並行する確認の結果も含めて付け直す)
 * guard は wtt-control に書く各文の直前に呼ぶ(凍結中なら投げる。K24)。
 * apiBase = control が出し直しに渡す apiBase(edgeOrigin(env))。更新前の記録の digest を作るときだけ使う
 */
export async function confirmDeliveries(db: Db, siteId: string, status: DeliveryStatus, now: number, guard: WriteGuard, apiBase: string | null): Promise<number> {
  void now; // 時刻はデプロイの時刻(history)を使う。now は将来の検査(未来の時刻の除外など)のために受ける
  const partial = status.partial === true;
  const rows = await db
    .selectFrom("experiment_delivered_definitions")
    .selectAll()
    .where("site_id", "=", siteId)
    .where("run_id", "in", db.selectFrom("experiment_delivered_definitions as u").select("u.run_id").where("u.site_id", "=", siteId).where(needsDeliveryConfirmation("u")))
    .orderBy("publish_version")
    .orderBy("id")
    .execute();
  if (rows.length === 0) return 0;
  const reqs = await db.selectFrom("static_deploy_requests").selectAll().where("site_id", "=", siteId).execute();
  const reqByGen = new Map(reqs.map((r) => [genKey(r), r]));
  // 依頼の記録が無い世代でも、その世代を記録に持つ行があれば、その行の版を焼いた世代とわかる(publishSite は自分の版を焼いた世代だけを入れる)
  const rowGenVersion = new Map<string, number>();
  for (const r of rows) {
    const g = parseGen(r.static_generation);
    if (g) rowGenVersion.set(genKey(g), r.publish_version);
  }
  const legacyDigest = legacyDigestOf(db, siteId, apiBase);
  const points: Array<{ version: number; at: number }> = [];
  for (const h of status.history) {
    const at = Date.parse(h.deployedAt);
    if (!Number.isFinite(at)) continue;
    const version = await versionOfPoint(h, reqByGen.get(genKey(h.generation)), rowGenVersion.get(genKey(h.generation)), legacyDigest);
    if (version !== null) points.push({ version, at });
  }
  points.sort((a, b) => a.at - b.at || a.version - b.version);
  const inHistory = new Set(status.history.map((h) => genKey(h.generation)));
  // 読めない historyFrom は「すべて切り詰められているかもしれない」として扱う(unknown 側に倒す)
  const historyFrom = status.historyFrom === null ? null : Number.isFinite(Date.parse(status.historyFrom)) ? Date.parse(status.historyFrom) : Infinity;

  const versions = [...new Set(rows.map((r) => r.publish_version))];
  const pubs = await db.selectFrom("publishes").select(["version", "published_by", "activated_at", "created_at"]).where("site_id", "=", siteId).where("version", "in", versions).execute();
  const pubByVersion = new Map(pubs.map((p) => [p.version, p]));

  const runs = new Map<string, Work[]>();
  for (const r of rows) {
    const w: Work = { ...(r as ExperimentDeliveredDefinitionRow & { id: number }), nextFrom: r.delivered_from, nextSettled: r.settled };
    const list = runs.get(r.run_id) ?? [];
    list.push(w);
    runs.set(r.run_id, list);
  }

  let changed = 0;
  for (const [runId, group] of runs) {
    // 1. 点を行に当てる(R = publish_version <= v で最新の行)。最小の時刻を取る
    for (const p of points) {
      let target: Work | undefined;
      for (const w of group) if (w.publish_version <= p.version) target = w;
      if (target && (target.nextFrom === null || p.at < target.nextFrom)) target.nextFrom = p.at;
    }
    // 2. history の全体のときだけ settled を決める(当てた後に見る: 同じ定義の再公開では自分の世代が history に無くても後の世代で配られている)
    if (!partial) {
      for (const w of group) {
        if (w.nextFrom !== null) {
          w.nextSettled = "delivered";
          continue;
        }
        if (w.nextSettled !== null) continue; // 決めた overtaken / unknown は戻さない(配られたら上で delivered になる)
        const own = parseGen(w.static_generation);
        // history にあるのに版が引けない(同じ世代に別の中身が配られた点。7o K24)。この版の配信の証拠ではないが、配られなかったとも言えないので決めない
        if (own && inHistory.has(genKey(own))) continue;
        // 出し直しを頼んだ時刻。世代が無い行(出し直しが世代を受け取れなかった)は、その版の activation の時刻で代える
        const pub = pubByVersion.get(w.publish_version);
        const requestedAt = (own ? reqByGen.get(genKey(own))?.requested_at : undefined) ?? pub?.activated_at ?? pub?.created_at ?? null;
        const covered = historyFrom === null || (requestedAt !== null && requestedAt >= historyFrom);
        const laterConfirmed = group.some((o) => o.publish_version > w.publish_version && o.nextFrom !== null);
        if (covered && laterConfirmed) w.nextSettled = "overtaken";
        else if (!covered) w.nextSettled = "unknown"; // 切り詰めた範囲より前の依頼。配られたか判断できないので使わない
      }
    }
    // 3. 行を書く(変わったものだけ)
    for (const w of group) {
      const fromChanged = w.nextFrom !== w.delivered_from;
      const settledChanged = w.nextSettled !== w.settled;
      if (!fromChanged && !settledChanged) continue;
      await guard();
      if (w.nextFrom !== null) {
        // delivered_from は遅い方へ動かさない(並行する確認が先に早い時刻を書いていたら、それを残す)
        const r = await db
          .updateTable("experiment_delivered_definitions")
          .set({
            delivered_from: sql<number>`case when delivered_from is null or delivered_from > ${w.nextFrom} then ${w.nextFrom} else delivered_from end`,
            ...(settledChanged ? { settled: w.nextSettled } : {}),
          })
          .where("id", "=", w.id)
          .executeTakeFirst();
        changed += Number(r.numUpdatedRows);
      } else {
        // overtaken / unknown。並行する確認が配信を確かめていたら(delivered_from がある)書かない
        const r = await db.updateTable("experiment_delivered_definitions").set({ settled: w.nextSettled }).where("id", "=", w.id).where("delivered_from", "is", null).executeTakeFirst();
        changed += Number(r.numUpdatedRows);
      }
    }
    // 4. 読み直した delivered_from で delivered_until を付け直す(後の版の確かめた行の delivered_from の最小値)
    const fresh = await db
      .selectFrom("experiment_delivered_definitions")
      .select(["id", "experiment_id", "publish_version", "definition_json", "delivered_from", "delivered_until"])
      .where("site_id", "=", siteId)
      .where("run_id", "=", runId)
      .orderBy("publish_version")
      .orderBy("id")
      .execute();
    const confirmed = fresh.filter((r) => r.delivered_from !== null);
    for (const r of fresh) {
      let until: number | null = null;
      if (r.delivered_from !== null)
        for (const o of confirmed) if (o.publish_version > r.publish_version && (until === null || o.delivered_from! < until)) until = o.delivered_from!;
      if (until === r.delivered_until) continue;
      await guard();
      await db.updateTable("experiment_delivered_definitions").set({ delivered_until: until }).where("id", "=", r.id).execute();
    }
    // 5. テスト中の変更(読み直した確かめた行の並びの隣どうしを比べる)。前と違えば作り直す
    const desired: Array<{ publish_version: number; at: number; by: string | null; parts_json: string }> = [];
    for (let i = 1; i < confirmed.length; i++) {
      const parts = changedParts(JSON.parse(confirmed[i - 1]!.definition_json), JSON.parse(confirmed[i]!.definition_json));
      if (parts.length === 0) continue;
      const cur = confirmed[i]!;
      desired.push({ publish_version: cur.publish_version, at: cur.delivered_from!, by: pubByVersion.get(cur.publish_version)?.published_by ?? null, parts_json: JSON.stringify(parts) });
    }
    const existing = await db
      .selectFrom("experiment_delivery_changes")
      .select(["publish_version", "at", "by", "parts_json"])
      .where("site_id", "=", siteId)
      .where("run_id", "=", runId)
      .orderBy("publish_version")
      .orderBy("id")
      .execute();
    const same =
      existing.length === desired.length &&
      existing.every((e, i) => e.publish_version === desired[i]!.publish_version && e.at === desired[i]!.at && e.by === desired[i]!.by && e.parts_json === desired[i]!.parts_json);
    if (same) continue;
    const experimentId = group[0]!.experiment_id;
    await guard();
    await db.deleteFrom("experiment_delivery_changes").where("site_id", "=", siteId).where("run_id", "=", runId).execute();
    for (const d of desired) {
      await guard();
      // 並行する作り直しで同じ版が 2 件にならないよう、無いときだけ足す
      await sql`
        insert into experiment_delivery_changes (site_id, experiment_id, run_id, publish_version, at, by, parts_json)
        select ${siteId}, ${experimentId}, ${runId}, ${d.publish_version}, ${d.at}, ${d.by}, ${d.parts_json}
        where not exists (select 1 from experiment_delivery_changes where site_id = ${siteId} and run_id = ${runId} and publish_version = ${d.publish_version})`.execute(db);
    }
  }
  return changed;
}

/**
 * at の時点で有効な届く定義(delivered_from <= at < delivered_until)。確かめていない行・overtaken・unknown は使わない。
 * partial で仮に確かめた行(settled が NULL)は使う(Cron が全体の history で確かめ直すまでの間も、写しと複製に使えるように)
 */
export async function deliveredAt(db: Db, siteId: string, experimentId: string, at: number): Promise<{ definition: DeliveredDefinition; deliveredFrom: number } | null> {
  const row = await db
    .selectFrom("experiment_delivered_definitions")
    .select(["definition_json", "delivered_from"])
    .where("site_id", "=", siteId)
    .where("experiment_id", "=", experimentId)
    .where("delivered_from", "is not", null)
    .where("delivered_from", "<=", at)
    .where((eb) => eb.or([eb("delivered_until", "is", null), eb("delivered_until", ">", at)]))
    .where((eb) => eb.or([eb("settled", "is", null), eb("settled", "=", "delivered")]))
    .orderBy("publish_version", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return { definition: JSON.parse(row.definition_json) as DeliveredDefinition, deliveredFrom: row.delivered_from! };
}

/**
 * 2 つの届く定義で変わった部分のパス(例 `["variants.b.changes", "targeting"]`)。順 = パターン(b の順、a にだけあるものは後)・urlMatch・targeting・primaryGoal
 */
export function changedParts(a: DeliveredDefinition, b: DeliveredDefinition): string[] {
  const parts: string[] = [];
  const aVar = new Map(a.variants.map((v) => [v.id, canonicalJson(v.changes)]));
  const bVar = new Map(b.variants.map((v) => [v.id, canonicalJson(v.changes)]));
  const ids = [...b.variants.map((v) => v.id), ...a.variants.map((v) => v.id).filter((id) => !bVar.has(id))];
  for (const id of ids) if (aVar.get(id) !== bVar.get(id)) parts.push(`variants.${id}.changes`);
  if (canonicalJson(a.urlMatch) !== canonicalJson(b.urlMatch)) parts.push("urlMatch");
  if (canonicalJson(a.targeting ?? null) !== canonicalJson(b.targeting ?? null)) parts.push("targeting");
  if (canonicalJson(a.primaryGoal) !== canonicalJson(b.primaryGoal)) parts.push("primaryGoal");
  return parts;
}
