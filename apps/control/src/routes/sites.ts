import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import { resultsStore } from "../capabilities";
import { toStatement, type SiteRow } from "../db";
import { ApiError, siteIdTaken, validationFailed } from "../errors";
import { newId, randomToken } from "../ids";
import { errorResponses } from "../openapi";
import { reconcileActive } from "../publish";
import { capacityLevel } from "../evaluation-plan";
import { collectUntilMap } from "../results/collect-until";
import { enqueuePurgeQuery, kickOffPurgeForSites } from "../results/purge";
import { retentionConflicts, retentionShrinkError } from "../retention";
import { actsAsInstanceAdmin, canViewWorkspace, loadSite, requireWorkspaceRole } from "../roles";
import { isRetiredSiteIdAbort, readSiteIdState, reassignRetiredStatement, retiredSiteIdTaken } from "../retired-sites";
import { siteJson, SiteJsonSchema } from "../serialize";
import { bootstrapSettingsChanged, reconcileStatic, requestStaticDeploy, requestStaticRemoval, staticRemoveConflict, staticRemoveFailed } from "../static-delivery";
import { touchSite } from "../validation";
import { isWriteFrozen } from "../write-freeze";
import {
  applySitePatch,
  assertHostsFree,
  claimHosts,
  compileUpdate,
  deleteSiteAssets,
  deleteSiteRecords,
  SiteCreateSchema,
  SitePatchSchema,
  putSiteRecords,
  releaseHosts,
} from "../site-settings";
import { readCloudflarePlan } from "../instance-settings";
import {
  claimHolder,
  claimsGrow,
  claimsOf,
  claimStatements,
  findSharingConflict,
  findSharingConflicts,
  isClaimConflict,
  SHARING_CONFLICT_CREATE_HINT,
  SHARING_CONFLICT_HINT,
  sharingConflictError,
  siteScopedCookieName,
  type SharingConflict,
} from "../sharing-conflict";
import type { Context } from "hono";

export const siteRoutes = new Hono<AppEnv>();

/** spec §13.9: `GET /sites/:sid` は siteJson に badge/banner 用の 1 フラグを足して返す */
const SiteGetSchema = SiteJsonSchema.extend({
  hasUnpublishedChanges: z.boolean().describe("エクスペリエンスのいずれかが unpublished、または目標 / パターン / タイムゾーン / 結果の記録の切り替えが前回 activation より後"),
  staticMismatch: z
    .boolean()
    .describe(
      "設置タグの配信ファイルの記録が食い違っている(デプロイ専用の Worker の記録が、データベースより新しい世代や削除の記録を持っている、または同じ世代で中身が違う。データベースを過去の時点に戻した後などに起きる)。POST /sites/:sid/static/redeploy か、システム管理者の POST /static/rebuild で直る",
    ),
  resultsCapacity: z
    .object({
      sizeBytes: z.number().int().describe("計測用のデータベースの大きさ(バイト)"),
      measuredAt: z.number().int().describe("測った時刻(epoch ミリ秒)"),
      level: z.enum(["ok", "warning", "stopped"]).describe("ok = 上限の 80% 未満、warning = 80% 以上、stopped = 95% 以上(参加と CV の記録を止めている)"),
    })
    .nullable()
    .describe("計測用のデータベースの使用量(導入全体。15 分ごとに測る)。まだ測っていなければ null"),
});

/** B139(spec Q29): 作成の応答。衝突を避けるために共有か Cookie 名を変えたときだけ sharingAdjusted を足す */
const SiteCreatedSchema = SiteJsonSchema.extend({
  sharingAdjusted: z
    .object({
      reason: z.literal("conflict").describe("同じ登録ドメインの別のサイトと、訪問者 ID の Cookie がぶつかった"),
      shareSubdomains: z.boolean().describe("作ったサイトの共有の切り替え(相手が共有していなければ false にして作る)"),
      visitorCookieName: z.string().describe("作ったサイトの訪問者 ID の Cookie 名(相手が共有していれば、サイト ID を付けた名前に変えて作る)"),
    })
    .optional()
    .describe("訪問者 ID の Cookie が同じ登録ドメインの別のサイトとぶつかったため、共有をオフにするか Cookie 名を変えて作ったときだけ返す。何を変えたかを利用者に知らせる"),
});

/**
 * B174: 新しいサイトの Cookie の既定の名前(`_ab` の接頭辞は、ほかのツールの Cookie と名前がぶつかりうるため `_wtt` にした)。
 * 作成では D1 の行に明示して保存するので、今あるサイト(`_ab_vid` など)は D1 に保存した名前のまま変わらない(0003 の列の既定は使わない)
 */
const DEFAULT_VISITOR_COOKIE_NAME = "_wtt_vid";
const DEFAULT_UUID_COOKIE_NAME = "_wtt_uuid";

/** 衝突の相手から 422 sharing_conflict を作る。相手のワークスペースを見られる人にだけサイト名を出す(spec Q23) */
async function conflictError(c: Context<AppEnv>, conflict: Pick<SharingConflict, "siteId" | "workspaceId" | "domain"> | null, hint: string) {
  if (!conflict) return sharingConflictError(null, null, hint);
  const visible = await canViewWorkspace(c, conflict.workspaceId);
  const name = visible ? ((await c.get("db").selectFrom("sites").select("name").where("id", "=", conflict.siteId).executeTakeFirst())?.name ?? null) : null;
  return sharingConflictError(conflict.domain, name, hint);
}

siteRoutes.get(
  "/workspaces/:wid/sites",
  describeRoute({
    tags: ["sites"],
    summary: "ワークスペース配下のサイト一覧(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "サイト一覧", content: { "application/json": { schema: resolver(z.array(SiteJsonSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "viewer");
    const rows = await c.get("db").selectFrom("sites").selectAll().where("workspace_id", "=", wid).orderBy("created_at").execute();
    return c.json(rows.map(siteJson));
  },
);

siteRoutes.post(
  "/workspaces/:wid/sites",
  describeRoute({
    tags: ["sites"],
    summary: "サイトを作成(管理者以上)",
    description:
      "削除したサイトの ID は、そのサイトがあったワークスペースでだけ作り直せる。別のワークスペースからは 409 `site_id_taken`。元のワークスペースを見られる人にだけ `reason` が `retired_elsewhere` になり、見られない人には今あるサイトと同じ応答を返す。ワークスペースごと削除したサイトの ID は、システム管理者だけが作れる",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成したサイト", content: { "application/json": { schema: resolver(SiteCreatedSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422, 503),
    },
  }),
  requireSession,
  validator("json", SiteCreateSchema, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "admin");
    const body = c.req.valid("json");
    const db = c.get("db");
    const now = Date.now();
    const id = body.id ?? newId("site");
    // B155(G26): 同じ ID のサイトと、退役の行(とその元のワークスペースの有無)を 1 文で読む(往復は今までの確かめと同じ 1 回)
    const state = await readSiteIdState(c.env.DB, id);
    if (state.live) throw siteIdTaken(id);
    let reclaimFrom: string | null = null; // システム管理者の取り直しのときだけ、確かめで読んだ元のワークスペース(batch の先頭で付け替える。Q10)
    if (state.retiredWorkspaceId !== null && state.retiredWorkspaceId !== wid) {
      if (state.retiredWorkspaceExists) throw await retiredSiteIdTaken(c, id, state.retiredWorkspaceId, "elsewhere"); // 見られるかの確かめの往復はこの枝だけ(Q7)
      if (!(await actsAsInstanceAdmin(c))) throw await retiredSiteIdTaken(c, id, state.retiredWorkspaceId, "admin_only"); // 往復が増えるのはこの枝だけ
      reclaimFrom = state.retiredWorkspaceId;
    }
    // spec §4.1: allowedOrigins は domain から初期値。Mode B(サーバー発行 Cookie、旧称 D-lite)は hosts = [domain]
    const base: SiteRow = {
      id, workspace_id: wid, name: body.name, domain: body.domain, mode: "A", id_source: "ab", site_salt: randomToken(16),
      allowed_origins_json: JSON.stringify([`https://${body.domain}`]), hosts_json: "[]", retention_days: body.retentionDays,
      consent_mode: body.consentMode, decision_timeout_ms: 1000, visitor_cookie_name: body.visitorCookieName ?? DEFAULT_VISITOR_COOKIE_NAME, uuid_cookie_enabled: 0, uuid_cookie_name: body.uuidCookieName ?? DEFAULT_UUID_COOKIE_NAME,
      previous_cookie_names_json: "[]", forget_on_revoke: 1, timezone: "Asia/Tokyo", analytics_json: null, ga4_property_id: null, bigquery_dataset: null, bridge_secret: null, bridge_secret_prev: null, bridge_secret_rotated_at: null,
      active_version: null, active_kv_stale: 0, last_activated_at: null, content_updated_at: now, created_at: now, updated_at: now,
      // 列の既定と同じ値(世代の epoch は created_at になる)
      static_seq: 0, static_stale: 0, static_epoch: 0, static_served_version: null, static_prev_served_version: null, static_served_at: null, static_removing: null,
      // D9 ②(設計書 §6.6): 新しい Site は、計測用 D1 がある導入なら結果を記録する(無ければ 0。後から有効にできる)
      results_enabled: resultsStore(c.env) ? 1 : 0, results_retention_days: 90,
      // D9 ③(K11): 列の既定と同じ値
      collect_until_dirty: 0,
      // plan12 K10: null = Cloudflare のプランの既定
      new_profile_budget_per_day: null,
      // B139: 新しい Site は共有をオンで作る。自動の移行(既存の行だけ)の対象にはしない
      share_subdomains: 1, previous_cookie_domains_json: "[]", share_migration_pending: 0,
    };
    // Cookie 名は base に直接入れる(patch で渡すと、新しいサイトなのに既定の名前を旧名として残し、旧名の後始末と共有の衝突の検査の対象にしてしまう)
    const patch = { mode: body.mode, hosts: body.mode === "B" ? [body.domain] : [], uuidCookieEnabled: body.uuidCookieEnabled };
    let { next, error } = applySitePatch(base, patch, now);
    if (error) throw error;
    // B139(spec Q29): 同じ導入の別のサイトと訪問者 ID の Cookie がぶつかるなら、作成は止めずに 1 回だけ調整する。
    // 相手が共有していれば Cookie 名をサイト ID 付きに変え(共有はオンのまま。共有をオフにしても解けない)、相手が共有していなければ共有をオフにして作る
    const nowSec = Math.floor(now / 1000);
    const conflicts = await findSharingConflicts(c.env.DB, next, nowSec);
    let adjusted = false;
    if (conflicts.length > 0) {
      adjusted = true;
      if (conflicts.some((x) => x.otherShares)) {
        const uuidClash = next.uuid_cookie_enabled === 1 && conflicts.some((x) => x.otherNames.includes(next.uuid_cookie_name));
        const renamed: SiteRow = {
          ...base,
          visitor_cookie_name: await siteScopedCookieName(DEFAULT_VISITOR_COOKIE_NAME, id),
          uuid_cookie_name: uuidClash ? await siteScopedCookieName(DEFAULT_UUID_COOKIE_NAME, id) : base.uuid_cookie_name,
        };
        ({ next, error } = applySitePatch(renamed, patch, now));
        if (error) throw error;
      } else {
        next = { ...next, share_subdomains: 0 };
      }
      // 調整は 1 回だけ。それでも残る(その名前が手で付けられていた)ときは 422 にして、作り直しを案内する
      const left = await findSharingConflict(c.env.DB, next, nowSec);
      if (left) throw await conflictError(c, left, SHARING_CONFLICT_CREATE_HINT);
    }
    // 順序: sites 行(FK の親)+ 共有の予約(同じ batch。同時の作成で予約に負けたら行も残さず 422)→ host 所有権 → KV。
    // claimHosts が 409 なら sites 行を消して返す(review r2 CX-High-6。予約は FK の CASCADE で消える)
    const claims = claimsOf(next, nowSec);
    // B155: 取り直しの付け替えは INSERT の前(守りの文は置かない。別のワークスペースの退役の ID への INSERT は D1 のトリガーが断る。Q10)
    try {
      await c.env.DB.batch([
        ...(reclaimFrom !== null ? [reassignRetiredStatement(c.env.DB, id, wid, reclaimFrom)] : []),
        toStatement(c.env, db.insertInto("sites").values(next)),
        ...claimStatements(c.env.DB, next.id, claims, nowSec),
      ]);
    } catch (e) {
      // ここまで KV にも host にも何も書いていない
      if (isClaimConflict(e)) throw await conflictError(c, await claimHolder(c.env.DB, next.id, claims, nowSec), SHARING_CONFLICT_CREATE_HINT);
      if (isRetiredSiteIdAbort(e)) {
        // 確かめの後の重なりでトリガーが断った(とてもまれ)。409 の文を決めるために 1 回だけ読み直す
        const again = await readSiteIdState(c.env.DB, id);
        // 今サイトがある・退役の行が作る先のもの(断られた後に別の要求が同じ ID を取り直した)・行が無い → 今あるサイトと同じ 409
        if (again.live || again.retiredWorkspaceId === null || again.retiredWorkspaceId === wid) throw siteIdTaken(id);
        throw await retiredSiteIdTaken(c, id, again.retiredWorkspaceId, again.retiredWorkspaceExists ? "elsewhere" : "admin_only");
      }
      // B155 Review Focus 5: 同じ新しい ID の作成の重なりで負けた側(sites の主キーの違反)は 500 ではなく 409
      if (/UNIQUE constraint failed: sites\.id/.test(String(e))) throw siteIdTaken(id);
      throw e;
    }
    try {
      await claimHosts(db, next.id, JSON.parse(next.hosts_json));
    } catch (e) {
      await db.deleteFrom("sites").where("id", "=", next.id).execute();
      throw e;
    }
    // Plan 2 繰越の順序契約: settings record(+ host)を先に書き、config は Publish で書く
    try {
      await putSiteRecords(c.env, next, { plan: await readCloudflarePlan(db), collectUntil: {} }); // 新しい Site には run が無い(収集の締め切りの表は空)
    } catch (e) {
      await db.deleteFrom("sites").where("id", "=", next.id).execute(); // site_hosts は CASCADE
      // settings の put だけ成功して host の put で落ちた場合、KV に孤児の settings record が残る。
      // D1 を巻き戻したなら KV も巻き戻す(ベストエフォート。失敗しても元の 503 を返す)
      await deleteSiteRecords(c.env, db, next, []).catch(() => {});
      throw e;
    }
    const sharingAdjusted = adjusted ? { reason: "conflict" as const, shareSubdomains: next.share_subdomains === 1, visitorCookieName: next.visitor_cookie_name } : undefined;
    return c.json({ ...siteJson(next), ...(sharingAdjusted ? { sharingAdjusted } : {}) }, 201);
  },
);

siteRoutes.get(
  "/sites/:sid",
  describeRoute({
    tags: ["sites"],
    summary: "サイトを 1 件取得(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "サイト", content: { "application/json": { schema: resolver(SiteGetSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    // Task 6 の publish の続き: KV active が D1 と食い違ったまま(active_kv_stale)なら読み取りのたびに自己修復を試みる。
    // `reconcileActive` は構造的に throw しない(内部を丸ごと 1 つの try で囲んである。review r1 finding 1)ので、
    // ここで await が投げて GET を失敗させることはない。戻り値は「呼び出し後に整合しているか」— これで直った瞬間の
    // 応答が読み込み時点の古い `activeKvStale` を返して自己矛盾するのを防ぐ(review r1 finding 2)
    // backlog D13 / 決定 56 (7): 凍結中は自己修復を見送り、読んだ時点の印のまま応答する(解除後の GET で直る)。
    // 凍結の読み取りが失敗したときも isWriteFrozen は true(見送る側に倒す)。
    // スイッチを読むのは直すものがある(読んだ行に印が立っている)ときだけ — 印が無ければどちらも書かないので、GET ごとの D1 読み取りを省く。
    // reconcileStatic は自分で static_stale を見て、0 なら何も問い合わせず { stale: false, mismatch: false } を返す。reconcileActive は行を読み直すので、
    // loadSite の後に別の要求が印を立てた瞬間だけは書き得る — 凍結中に書かないよう、読んだ行に印が無ければ呼ばない
    // (読んだ行に印が無ければ、応答は呼んだときと同じ activeKvStale = false。直すのは次の GET に回る)
    const needsRepair = site.active_kv_stale === 1 || site.static_stale === 1;
    const frozen = needsRepair && (await isWriteFrozen(db));
    const reconciled = site.active_kv_stale !== 1 ? true : frozen ? false : await reconcileActive(c.env, db, site.id);
    // 決定 52 / plan K5 ④: 配信ファイルの出し直しが済んでいない Site は、デプロイ専用の Worker の状態を見て印を下ろす(届いていなければ依頼し直す)。
    // 7o K6: 記録の食い違い(先行・同じ世代の別の中身・墓標)も返す。凍結中は問い合わせないので false
    const { stale: staticStale, mismatch: staticMismatch } = frozen
      ? { stale: site.static_stale === 1, mismatch: false }
      : await reconcileStatic(c.env, db, site, (p) => c.executionCtx.waitUntil(p));
    // spec §13.9: いずれかの Experiment が unpublished、または Goal / パターンの変更(sites.content_updated_at)が
    // 前回 activation より後 なら badge/banner を立てる。Experiment 側は 1 件でも該当すれば十分なので limit(1)
    const since = site.last_activated_at ?? 0;
    const dirty = await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("updated_at", ">", since).limit(1).executeTakeFirst();
    // D9 ③(plan ③ の K18): 計測用 D1 の使用量(results-capacity が測った最後の値)
    const store = await db.selectFrom("results_store_status").select(["size_bytes", "measured_at"]).where("id", "=", 1).executeTakeFirst();
    return c.json({
      ...siteJson(site),
      activeKvStale: reconciled ? false : site.active_kv_stale === 1,
      staticStale,
      staticMismatch,
      hasUnpublishedChanges: dirty !== undefined || site.content_updated_at > since,
      resultsCapacity: store ? { sizeBytes: store.size_bytes, measuredAt: store.measured_at, level: capacityLevel(store.size_bytes) } : null,
    });
  },
);

siteRoutes.patch(
  "/sites/:sid",
  describeRoute({
    tags: ["sites"],
    summary: "サイト設定を更新(管理者以上)。訪問者 ID / 外部計測の名前は設置タグの配信ファイルを作り直して反映するので、公開は不要。タイムゾーンと結果の記録の切り替えは次の公開で効く",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のサイト", content: { "application/json": { schema: resolver(SiteJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422, 503),
    },
  }),
  requireSession,
  validator("json", SitePatchSchema, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const body = c.req.valid("json");
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const { next, error } = applySitePatch(site, body, nowMs);
    if (error) throw error;
    // B139: 共有の切り替えを含む保存は、利用者が選んだ値として自動の移行の対象から外す(同じ batch で印を 0 にする)
    const choosesSharing = body.shareSubdomains !== undefined;
    if (choosesSharing) next.share_migration_pending = 0;
    // D9 ②(設計書 §6.6): 計測用 D1 が無い導入では、結果の記録を有効にする操作を拒む(既存の導入先の更新で、D1 を作る前に有効にしても壊れない)。
    // 判定は無効 → 有効の切り替えだけ(有効のまま D1 が外れた Site で、ほかの設定の保存まで止めない)。無効にする向きは受ける
    if (next.results_enabled === 1 && site.results_enabled === 0 && !resultsStore(c.env))
      throw new ApiError(409, "results_store_missing", {
        path: ["resultsEnabled"],
        message: "結果を記録するためのデータベースが導入されていません",
        hint: "導入ガイドの手順で計測用のデータベースを作り、control を設定し直してから有効にしてください",
      });
    const db = c.get("db");
    if (next.retention_days < site.retention_days) {
      const conflicts = await retentionConflicts(db, site, next.retention_days);
      if (conflicts.length > 0) throw retentionShrinkError(conflicts, next.retention_days);
    }
    const nextHosts: string[] = JSON.parse(next.hosts_json);
    /**
     * 失敗した PATCH の KV 後始末: 旧行から settings record と host キーを書き直す。
     * (1) 旧 settings record を put、(2) 旧 hosts のキーを put(putSiteRecords)、
     * (3) nextHosts のうち旧 hosts に無いキーを releaseHosts(D1 に持ち主が居ないときだけ、自 Site を指すものを delete)、をまとめてやるので、
     * 前進方向に書いた分をちょうど打ち消す。**settings record を戻さないと KV だけが D1 より先に進んだまま残り、
     * 次の PATCH が旧行から再導出して「配信中の Cookie 名」を旧名リストにも載せずに捨ててしまう。**
     * ベストエフォート(ここで失敗しても元のエラーを返す。その Site の次の PATCH が自己修復する)
     */
    // D9 ③(K11): 収集の締め切りの表は前進・戻しの両方に同じものを付ける(どちらで書いても締め切りを消さない)
    // plan12 K10: 新しい訪問者の予算の既定もプランから同じように付ける。KV に CAS が無いので、この put と D1 の確定の間に書き直し
    // (プランの変更・rewriteCollectUntil)が古い行を読むと古い記録が残りうる(CL-Medium-11)が、site-settings-refresh が翌日までに D1 の値へ直す
    const extras = { plan: await readCloudflarePlan(db), collectUntil: await collectUntilMap(db, site.id) };
    const prevHosts: string[] = JSON.parse(site.hosts_json);
    const addedHosts = nextHosts.filter((h) => !prevHosts.includes(h));
    const removedHosts = prevHosts.filter((h) => !nextHosts.includes(h));
    const restoreKv = async () => {
      await putSiteRecords(c.env, site, extras).catch(() => {});
      await releaseHosts(c.env, db, site.id, addedHosts).catch(() => {});
    };
    // (1) 衝突検査(D1)。host の取り合いと、訪問者 ID の Cookie の共有の衝突(B139 spec §6.4・Q23。予約の表は (3) の batch で必ず塞ぐ)
    await assertHostsFree(db, next.id, nextHosts);
    const conflict = await findSharingConflict(c.env.DB, next, nowSec);
    if (conflict) throw await conflictError(c, conflict, SHARING_CONFLICT_HINT);
    // 決定 52 (5) / plan K4: bootstrap に焼く設定(訪問者 ID など)が変わり、公開中の版があるときは、保存の UPDATE と同じ文で配信ファイルの印を立てる
    // (出し直しの依頼の前に処理が止まっても印が残り、GET の自己修復が拾う)
    const staticChanged = next.active_version !== null && bootstrapSettingsChanged(site, next);
    const oldClaims = claimsOf(site, nowSec);
    const newClaims = claimsOf(next, nowSec);
    const pendingStmt = choosesSharing ? [c.env.DB.prepare("update sites set share_migration_pending = 0 where id = ?").bind(next.id)] : [];
    // (3) site_hosts の入れ替え・共有の予約の入れ替え・sites の更新を 1 batch
    const writeD1 = () =>
      c.env.DB.batch([
        c.env.DB.prepare("delete from site_hosts where site_id = ?").bind(next.id),
        ...nextHosts.map((h) => c.env.DB.prepare("insert into site_hosts (host, site_id) values (?, ?)").bind(h, next.id)),
        ...claimStatements(c.env.DB, next.id, newClaims, nowSec),
        ...pendingStmt,
        ...compileUpdate(c.env, db, next, { markStaticStale: staticChanged }),
      ]);
    /** batch の失敗を封筒にする。予約の主キーの違反 = 同時の保存で共有の衝突に負けた(422)。それ以外は host の取り合い(409) */
    const batchError = async (e: unknown): Promise<ApiError> => {
      if (isClaimConflict(e)) return conflictError(c, await claimHolder(c.env.DB, next.id, newClaims, nowSec), SHARING_CONFLICT_HINT);
      // review r2 finding 4: 409 は errorHandler の 5xx ログにも乗らないので、生の例外(D1 の制約名やテーブル名を
      // 含み得る)を封筒の message に流していた ── spec §13.5 の「message は日本語の文」に反するだけでなく、
      // その内部情報を外部エージェント含む全クライアントにそのまま返してしまう。ここで診断用に一度だけログし、
      // 応答には日本語の文だけを積む
      console.error("host_in_use (batch)", e);
      return new ApiError(409, "host_in_use", { message: "ホスト名の登録が競合しました", hint: "再試行してください" });
    };
    if (claimsGrow(oldClaims, newClaims)) {
      // B139(spec Q28): 予約の集合に足すものがある保存(共有の開始・範囲の追加・正本名の変更・UUID Cookie の有効化や改名)は、D1 を先に確定してから KV を書く。
      // 予約に負けた保存の設定は KV に一度も載らない。KV の書き込みが失敗したら D1 を戻す
      try {
        await writeD1();
      } catch (e) {
        throw await batchError(e);
      }
      try {
        await putSiteRecords(c.env, next, extras);
      } catch (e) {
        // 先に D1 を旧値に戻す(releaseHosts は D1 に持ち主が居ない host だけを消すので、戻した後に呼ぶ)。予約は戻す間に他のサイトが取った組を飛ばす。
        // 配信ファイルの世代は戻さない(印が立ったままなら、旧い設定で作り直すだけ)。
        // 戻す batch 自体が落ちたら、D1 は新しい値のまま。KV は戻さず(D1 と比べる Cron が D1 に合わせる)500 にする
        try {
          await c.env.DB.batch([
            c.env.DB.prepare("delete from site_hosts where site_id = ?").bind(site.id),
            ...prevHosts.map((h) => c.env.DB.prepare("insert or ignore into site_hosts (host, site_id) values (?, ?)").bind(h, site.id)),
            ...claimStatements(c.env.DB, site.id, oldClaims, nowSec, { orIgnore: true }),
            c.env.DB.prepare("update sites set share_migration_pending = ? where id = ?").bind(site.share_migration_pending, site.id),
            ...compileUpdate(c.env, db, site),
          ]);
        } catch (err) {
          console.error(`site ${site.id}: restoring D1 after a failed settings write failed`, err);
          throw new ApiError(500, "internal");
        }
        await restoreKv();
        throw e;
      }
    } else {
      // (2) KV の put(新しい設定と新しい hosts。消さない)→ (3) D1 の batch。
      // (4) 外した host の KV を releaseHosts で消す(D1 の確定の後。plan12 K14 (c))。
      // activation = KV put なので KV が先。失敗すれば D1 は旧値のまま(= 503 で再試行できる)
      try {
        await putSiteRecords(c.env, next, extras);
      } catch (e) {
        await restoreKv(); // settings は書けたが host の put で落ちた、など途中まで進んだ場合
        throw e;
      }
      try {
        await writeD1();
      } catch (e) {
        await restoreKv();
        throw await batchError(e);
      }
    }
    // D1 が確定したので、外した host の KV を消す。D1 の site_hosts に持ち主が居ないものだけ(別の Site が取った host は消さない)。
    // 確定済みなので失敗しても保存は成功として返す(KV に残った mapping は、その host を取る Site の PATCH が上書きする)
    await releaseHosts(c.env, db, next.id, removedHosts).catch((e) => console.error("releaseHosts failed after patch", e));
    // 決定 49: タイムゾーンは compiled config で配るので、変えたら未公開の変更に数える(応答の contentUpdatedAt も合わせる)。
    // D9 ②(設計書 §6.6): 結果の記録の切り替えも次の Publish で compiled config の results が変わるので数える(保持期間だけの変更は config に載らないので数えない)
    if (next.timezone !== site.timezone || next.results_enabled !== site.results_enabled) {
      await touchSite(db, next.id, next.updated_at);
      next.content_updated_at = next.updated_at;
    }
    // 決定 52 (5): 公開中の版で配信ファイルを出し直す(公開なしで反映)
    if (staticChanged) {
      await requestStaticDeploy(c.env, db, next.id);
      Object.assign(next, await db.selectFrom("sites").select(["static_seq", "static_stale", "static_epoch", "static_served_version", "static_prev_served_version", "static_served_at"]).where("id", "=", next.id).executeTakeFirstOrThrow());
    }
    return c.json(siteJson(next));
  },
);

siteRoutes.delete(
  "/sites/:sid",
  describeRoute({
    tags: ["sites"],
    summary: "サイトを削除(オーナーのみ)。KV の settings / host / active / config と、設置タグの配信ファイルも消す。配信ファイルを消せなかったときは 503 でサイトを残す",
    security: [{ bearer: [] }],
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409, 503) },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "owner");
    const db = c.get("db");
    // Desired と Published のどちらかが running なら消せない(Stop の Publish が失敗して配信中のままの Site を守る。spec §13.8)
    const running = await db
      .selectFrom("experiments")
      .select("id")
      .where("site_id", "=", site.id)
      .where((eb) => eb.or([eb("status", "=", "running"), eb("published_status", "=", "running")]))
      .executeTakeFirst();
    if (running) throw new ApiError(409, "site_has_running_experiments", { experimentId: running.id, message: "配信中のエクスペリエンスがあります。先に終了してから削除してください" });
    // 決定 52 (5) / 7i plan K23: 削除ごとの印(token)を立ててから配信ファイルを先に消す。届かない・待ち切れない・墓標が受け付けられたと
    // 確かめられなければ Site を残して 503(消えた Site のファイルが残り続けないように)
    const token = crypto.randomUUID();
    try {
      await requestStaticRemoval(c.env, db, site.id, token);
    } catch (e) {
      console.error("static remove failed", e);
      throw staticRemoveFailed();
    }
    const versions = (await db.selectFrom("publishes").select("version").where("site_id", "=", site.id).execute()).map((r) => r.version);
    // 7i plan K23: D1 の削除は、Site の行の static_removing がまだ自分の token のときだけ。削除の途中で「配信ファイルを作り直す」が
    // 印を消していたら(配信を戻した)削除を取りやめる。子のテーブルは sites の FK CASCADE で消える
    // D9 ③(K6 (1)): 同じ batch で、削除の DELETE の前に run_id を持つエクスペリエンスを計測用 D1 の削除待ちに積む(条件は削除と同じ token)
    const now = Date.now();
    const [, del] = await c.env.DB.batch([
      toStatement(c.env, enqueuePurgeQuery(db, { kind: "site", siteId: site.id, token }, now)),
      toStatement(c.env, db.deleteFrom("sites").where("id", "=", site.id).where("static_removing", "=", token)),
    ]);
    if ((del?.meta.changes ?? 0) === 0) throw staticRemoveConflict();
    // K6・K12: 応答の後に 1 回だけ個票を消し始める(残りは Cron が queue から消す)
    if (c.env.RESULTS_DB && c.env.RESULTS_BUDGET) c.executionCtx.waitUntil(kickOffPurgeForSites(c.env, db, [site.id], now));
    // D1 の外の後片づけ(KV・R2)は D1 の削除が成功した後
    await deleteSiteRecords(c.env, db, site, versions);
    await deleteSiteAssets(c.env, site.id); // R2 の画像(ベストエフォート)
    return c.body(null, 204);
  },
);
