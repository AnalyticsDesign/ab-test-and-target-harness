import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import type { SiteRow } from "../db";
import { ApiError, validationFailed } from "../errors";
import { newId, randomToken } from "../ids";
import { errorResponses } from "../openapi";
import { reconcileActive } from "../publish";
import { retentionConflicts, retentionShrinkError } from "../retention";
import { loadSite, requireWorkspaceRole } from "../roles";
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
  writeSiteRecords,
} from "../site-settings";

export const siteRoutes = new Hono<AppEnv>();

/** spec §13.9: `GET /sites/:sid` は siteJson に badge/banner 用の 1 フラグを足して返す */
const SiteGetSchema = SiteJsonSchema.extend({
  hasUnpublishedChanges: z.boolean().describe("エクスペリエンスのいずれかが unpublished、または目標 / パターン / タイムゾーンの変更が前回 activation より後"),
});

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
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成したサイト", content: { "application/json": { schema: resolver(SiteJsonSchema) } } },
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
    if (await db.selectFrom("sites").select("id").where("id", "=", id).executeTakeFirst())
      throw new ApiError(409, "site_id_taken", { id, message: "このサイト ID は既に使われています", hint: "別の ID を指定してください" });
    // spec §4.1: allowedOrigins は domain から初期値。Mode B(サーバー発行 Cookie、旧称 D-lite)は hosts = [domain]
    const base: SiteRow = {
      id, workspace_id: wid, name: body.name, domain: body.domain, mode: "A", id_source: "ab", site_salt: randomToken(16),
      allowed_origins_json: JSON.stringify([`https://${body.domain}`]), hosts_json: "[]", retention_days: body.retentionDays,
      consent_mode: body.consentMode, decision_timeout_ms: 1000, visitor_cookie_name: "_ab_vid", uuid_cookie_enabled: 0, uuid_cookie_name: "_ab_uuid",
      previous_cookie_names_json: "[]", forget_on_revoke: 1, timezone: "Asia/Tokyo", analytics_json: null, ga4_property_id: null, bigquery_dataset: null, bridge_secret: null, bridge_secret_prev: null, bridge_secret_rotated_at: null,
      active_version: null, active_kv_stale: 0, last_activated_at: null, content_updated_at: now, created_at: now, updated_at: now,
      // 列の既定と同じ値(世代の epoch は created_at になる)
      static_seq: 0, static_stale: 0, static_epoch: 0, static_served_version: null, static_prev_served_version: null, static_served_at: null, static_removing: null,
    };
    const { next, error } = applySitePatch(base, {
      mode: body.mode, hosts: body.mode === "B" ? [body.domain] : [],
      visitorCookieName: body.visitorCookieName, uuidCookieEnabled: body.uuidCookieEnabled, uuidCookieName: body.uuidCookieName,
    }, now);
    if (error) throw error;
    // 順序: sites 行(FK の親)→ host 所有権 → KV。claimHosts が 409 なら sites 行を消して返す(review r2 CX-High-6)
    await db.insertInto("sites").values(next).execute();
    try {
      await claimHosts(db, next.id, JSON.parse(next.hosts_json));
    } catch (e) {
      await db.deleteFrom("sites").where("id", "=", next.id).execute();
      throw e;
    }
    // Plan 2 繰越の順序契約: settings record(+ host)を先に書き、config は Publish で書く
    try {
      await writeSiteRecords(c.env, next, []);
    } catch (e) {
      await db.deleteFrom("sites").where("id", "=", next.id).execute(); // site_hosts は CASCADE
      // settings の put だけ成功して host の put で落ちた場合、KV に孤児の settings record が残る。
      // D1 を巻き戻したなら KV も巻き戻す(ベストエフォート。失敗しても元の 503 を返す)
      await deleteSiteRecords(c.env, next, []).catch(() => {});
      throw e;
    }
    return c.json(siteJson(next), 201);
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
    // reconcileStatic は自分で static_stale を見て、0 なら何も問い合わせず false を返す。reconcileActive は行を読み直すので、
    // loadSite の後に別の要求が印を立てた瞬間だけは書き得る — 凍結中に書かないよう、読んだ行に印が無ければ呼ばない
    // (読んだ行に印が無ければ、応答は呼んだときと同じ activeKvStale = false。直すのは次の GET に回る)
    const needsRepair = site.active_kv_stale === 1 || site.static_stale === 1;
    const frozen = needsRepair && (await isWriteFrozen(db));
    const reconciled = site.active_kv_stale !== 1 ? true : frozen ? false : await reconcileActive(c.env, db, site.id);
    // 決定 52 / plan K5 ④: 配信ファイルの出し直しが済んでいない Site は、デプロイ専用の Worker の状態を見て印を下ろす(届いていなければ依頼し直す)
    const staticStale = frozen ? site.static_stale === 1 : await reconcileStatic(c.env, db, site, (p) => c.executionCtx.waitUntil(p));
    // spec §13.9: いずれかの Experiment が unpublished、または Goal / パターンの変更(sites.content_updated_at)が
    // 前回 activation より後 なら badge/banner を立てる。Experiment 側は 1 件でも該当すれば十分なので limit(1)
    const since = site.last_activated_at ?? 0;
    const dirty = await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("updated_at", ">", since).limit(1).executeTakeFirst();
    return c.json({
      ...siteJson(site),
      activeKvStale: reconciled ? false : site.active_kv_stale === 1,
      staticStale,
      hasUnpublishedChanges: dirty !== undefined || site.content_updated_at > since,
    });
  },
);

siteRoutes.patch(
  "/sites/:sid",
  describeRoute({
    tags: ["sites"],
    summary: "サイトの設定を更新(管理者以上)。訪問者 ID / 外部計測の名前は設置タグの配信ファイルを作り直して反映するので、公開は不要。タイムゾーンは次の公開で効く",
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
    const { next, error } = applySitePatch(site, c.req.valid("json"), Date.now());
    if (error) throw error;
    const db = c.get("db");
    if (next.retention_days < site.retention_days) {
      const conflicts = await retentionConflicts(db, site, next.retention_days);
      if (conflicts.length > 0) throw retentionShrinkError(conflicts, next.retention_days);
    }
    const nextHosts: string[] = JSON.parse(next.hosts_json);
    /**
     * 失敗した PATCH の KV 後始末: 旧行から settings record と host キーを書き直す。
     * `writeSiteRecords(env, site, nextHosts)` は (1) 旧 settings record を put、(2) 旧 hosts のキーを put、
     * (3) nextHosts のうち旧 hosts に無く自 Site を指すキーを delete、をまとめてやるので、
     * 前進方向に書いた分をちょうど打ち消す。**settings record を戻さないと KV だけが D1 より先に進んだまま残り、
     * 次の PATCH が旧行から再導出して「配信中の Cookie 名」を旧名リストにも載せずに捨ててしまう。**
     * ベストエフォート(ここで失敗しても元のエラーを返す。その Site の次の PATCH が自己修復する)
     */
    const restoreKv = () => writeSiteRecords(c.env, site, nextHosts).catch(() => {});
    // (1) 衝突検査(D1)。(2) KV。(3) site_hosts の入れ替えと sites の更新を 1 batch。
    // activation = KV put なので KV が先。失敗すれば D1 は旧値のまま(= 503 で再試行できる)
    await assertHostsFree(db, next.id, nextHosts);
    try {
      await writeSiteRecords(c.env, next, JSON.parse(site.hosts_json));
    } catch (e) {
      await restoreKv(); // settings は書けたが host の put で落ちた、など途中まで進んだ場合
      throw e;
    }
    // 決定 52 (5) / plan K4: bootstrap に焼く設定(訪問者 ID など)が変わり、公開中の版があるときは、保存の UPDATE と同じ文で配信ファイルの印を立てる
    // (出し直しの依頼の前に処理が止まっても印が残り、GET の自己修復が拾う)
    const staticChanged = next.active_version !== null && bootstrapSettingsChanged(site, next);
    try {
      await c.env.DB.batch([
        c.env.DB.prepare("delete from site_hosts where site_id = ?").bind(next.id),
        ...nextHosts.map((h) => c.env.DB.prepare("insert into site_hosts (host, site_id) values (?, ?)").bind(h, next.id)),
        ...compileUpdate(c.env, db, next, { markStaticStale: staticChanged }),
      ]);
    } catch (e) {
      await restoreKv();
      // review r2 finding 4: 409 は errorHandler の 5xx ログにも乗らないので、生の例外(D1 の制約名やテーブル名を
      // 含み得る)を封筒の message に流していた ── spec §13.5 の「message は日本語の文」に反するだけでなく、
      // その内部情報を外部エージェント含む全クライアントにそのまま返してしまう。ここで診断用に一度だけログし、
      // 応答には日本語の文だけを積む
      console.error("host_in_use (batch)", e);
      throw new ApiError(409, "host_in_use", { message: "ホスト名の登録が競合しました", hint: "再試行してください" });
    }
    // 決定 49: タイムゾーンは compiled config で配るので、変えたら未公開の変更に数える(応答の contentUpdatedAt も合わせる)
    if (next.timezone !== site.timezone) {
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
    const del = await db.deleteFrom("sites").where("id", "=", site.id).where("static_removing", "=", token).executeTakeFirst();
    if (Number(del.numDeletedRows) === 0) throw staticRemoveConflict();
    // D1 の外の後片づけ(KV・R2)は D1 の削除が成功した後
    await deleteSiteRecords(c.env, site, versions);
    await deleteSiteAssets(c.env, site.id); // R2 の画像(ベストエフォート)
    return c.body(null, 204);
  },
);
