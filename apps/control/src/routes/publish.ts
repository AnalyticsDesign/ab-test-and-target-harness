import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import type { ExperimentRow } from "../db";
import { notFound, validationFailed } from "../errors";
import { overlapWarnings } from "../experiment-order";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { canReadRawPublishError, loadSite } from "../roles";
import { compile, CompileError, usesCondition, type CompiledConfig } from "@wtt/core";
import { buildCompileInput, describeCompileFailure, loadActiveConfig, publicPublishResult, publishErrorCode, publishSite } from "../publish";
import { requestStaticDeploy } from "../static-delivery";
import { audienceUsage } from "./audiences";

export const publishRoutes = new Hono<AppEnv>();

/**
 * spec §13.6: Publish の結果。失敗も HTTP 200 + `ok: false` で返す(決定 17。UI がアラートを出して再試行する)。
 * Task 7 の `POST …/status` も応答の `publish` フィールドにこの同じ schema を使う(export してそちらから import する)
 */
export const PublishResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    needsProfile: z.boolean().describe("この config が Profile(履歴条件 / 割当固定)を要求する"),
    superseded: z.boolean().describe("活性化の直前に新しい version が active になったため、この version は履歴のみ"),
    staticDeploy: z
      .enum(["deployed", "pending", "skipped"])
      .describe(
        "設置タグの配信ファイルの更新。deployed = 反映済み(訪問者のブラウザには 60 秒以内に届く)/ pending = まだ反映されていない(自動で再試行する。サイトの staticStale が true になり、続くときは POST /sites/:sid/static/redeploy で作り直せる)/ skipped = 更新しなかった。superseded が true のときは、より新しい公開が更新するため。superseded が false のときは、配信ファイルを更新する仕組みが設定されていないため",
      ),
    warnings: z.array(z.object({ path: z.string(), message: z.string() })).describe(
        "公開の警告(拒否はしない)。dataLayer の名札(GA4 で値が破棄される可能性)、配信するタグの大きさ(path = bootstrap)、同じ対象 URL で同じ要素を変えるエクスペリエンスの組(path = experiments.<優先の低い方の ID>。どちらが優先されるかを message に書く)",
      ),
  }),
  z.object({
    ok: z.literal(false),
    version: z.number().int().nullable(),
    error: z.string().describe("機械可読コード(kv_put_failed / kv_verify_failed / kv_rate_limited / legacy_targeting / unknown_audience / within_days_exceeds_retention …)"),
    message: z.string(),
    hint: z.string().optional(),
  }),
]);

const PublishListItemSchema = z.object({
  version: z.number().int(),
  status: z
    .enum(["reserved", "failed", "active", "superseded"])
    .describe(
      "その版に起きたこと(出来事の記録)。`active` は activation に成功した記録で「いま配信中」ではない — 過去に成功した版は `active` のまま残るので、いま配信中かは `GET /sites/:sid` の `activeVersion` と突き合わせる",
    ),
  publishedBy: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  activatedAt: z.number().int().nullable().describe("epoch ミリ秒"),
  needsProfile: z.boolean().nullable(),
  error: z
    .string()
    .nullable()
    .describe("失敗理由。管理者以上には `<code>: <生テキスト>`、閲覧者 / 編集者には機械可読コードだけ(生の例外文字列は内部情報のため)"),
});

const PublishDetailSchema = z.object({ version: z.number().int(), config: z.unknown().describe("compiled config の本体") });

/** spec §13.9: Publish 確認画面のサマリ本体(誰が・いつ・Code Change かどうか) */
const ActorSchema = z.object({ id: z.string(), name: z.string() });
const ChangedChangeSchema = z.object({
  variantId: z.string(),
  id: z.string(),
  type: z.enum(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  updatedBy: ActorSchema,
});
const PublishPreviewExperimentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["draft", "running", "paused", "archived"]),
  publishedStatus: z.enum(["draft", "running", "paused", "archived"]).nullable(),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  updatedBy: ActorSchema,
  hasCodeChange: z.boolean().describe("HTML / CSS / CUSTOM_JS の変更を含むか(コードレビューを促す印)"),
  changedChanges: z.array(ChangedChangeSchema),
});
const RefSchema = z.object({ id: z.string(), name: z.string() });
const PublishPreviewSchema = z.object({
  experiments: z.array(PublishPreviewExperimentSchema),
  siteLevelChanged: z.boolean().describe("目標 / オーディエンス / タイムゾーンなどサイト直下の設定が前回 activation より後に変わったか"),
  lastActivatedAt: z.number().int().nullable().describe("epoch ミリ秒"),
  audienceChanges: z
    .array(RefSchema.extend({ updatedAt: z.number().int().describe("epoch ミリ秒"), experiments: z.array(RefSchema) }))
    .describe("前回の activation より後に作成・更新されたオーディエンスと、それを参照する配信中のエクスペリエンス(次の公開で配信対象が変わる)"),
  droppedPageConditions: z
    .array(z.object({ part: z.enum(["url", "path", "host"]), op: z.string(), value: z.string() }))
    .describe("次の公開で数えるのをやめるページの条件(公開中の設定にあり、いまの下書きの設定に無い)。これまでの閲覧回数は消える"),
  viewportExperiments: z.array(RefSchema).describe("画面の幅の条件を使う running のエクスペリエンス。タグが viewport の meta より前にある・meta が無いページでは配信されない"),
  compileError: z
    .object({ error: z.string(), message: z.string(), hint: z.string().optional() })
    .nullable()
    .describe("いまの下書きを公開すると止まる理由(止まらなければ null)"),
  overlaps: z
    .array(z.object({ path: z.string(), message: z.string(), experimentIds: z.array(z.string()).describe("[優先の低い方, 高い方]") }))
    .describe(
      "同じ対象 URL の条件で同じ要素(セレクタの文字列が同じ)を変える、配信中のエクスペリエンスの組。後に並ぶものが優先される(パーソナライズよりテスト、テストどうしは先に開始・再開したもの、パーソナライズどうしは後に作成したもの)。starting を付けたときは、その下書き・一時停止中のテストを今開始・再開したとして並べ、その ID を含む組だけ",
    ),
});

/** HTML / CSS / CUSTOM_JS はコードレビューが要る Change(spec §13.9 の「Code Change の印」) */
const CODE_CHANGE_TYPES = new Set(["HTML", "CSS", "CUSTOM_JS"]);

/** 公開履歴の本体は version 単位。`:version` は 10 進の整数だけを受ける */
const VersionParam = z.object({ sid: z.string(), version: z.string().regex(/^\d+$/, "version must be a positive integer") });

/** spec §13.2 / §13.6: Publish は ADMIN 以上。body は取らないので validator は付けない(POST …/reset-link と同じ形) */
publishRoutes.post(
  "/sites/:sid/publish",
  describeRoute({
    tags: ["publish"],
    summary: "サイトを公開(管理者以上)。失敗も 200 + ok:false で返す",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "公開の結果(成功 / 失敗の両方)", content: { "application/json": { schema: resolver(PublishResultSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    return c.json(publicPublishResult(await publishSite(c.env, c.get("db"), site, c.get("user").id)));
  },
);

publishRoutes.post(
  "/sites/:sid/static/redeploy",
  describeRoute({
    tags: ["publish"],
    summary: "設置タグの配信ファイルを今の公開内容で作り直す(管理者以上)。公開の後に配信ファイルの更新が済んでいないときに使う",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "結果", content: { "application/json": { schema: resolver(z.object({ staticDeploy: z.enum(["deployed", "pending", "skipped"]) })) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const db = c.get("db");
    // 7i plan K23: 途中で止まった削除を取りやめる(削除の印を消す)。この後に古い削除が D1 を消そうとしても、印が違うので消えない
    await db.updateTable("sites").set({ static_removing: null }).where("id", "=", site.id).execute();
    // 作り直しは前回と同じ中身でもデプロイさせる(配信専用の Worker の実物が記録とずれたときの直し)。
    // 削除の墓標に負けていれば、epoch を墓標 + 1 に進めて 1 回だけ出し直す(復旧はこの操作だけ。plan K2)
    const outcome = await requestStaticDeploy(c.env, db, site.id, { force: true, recoverTombstone: true });
    return c.json({ staticDeploy: outcome.state });
  },
);

publishRoutes.get(
  "/sites/:sid/publishes",
  describeRoute({
    tags: ["publish"],
    summary: "公開履歴の一覧(閲覧者以上)。新しい順・最大 100 件",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "公開履歴", content: { "application/json": { schema: resolver(z.array(PublishListItemSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site, role } = await loadSite(c, c.req.param("sid"), "viewer");
    const rows = await c
      .get("db")
      .selectFrom("publishes")
      .leftJoin("user", "user.id", "publishes.published_by")
      .select([
        "publishes.version",
        "publishes.status",
        "publishes.created_at",
        "publishes.activated_at",
        "publishes.needs_profile",
        "publishes.error",
        "publishes.published_by",
        "user.name as publisher_name",
      ])
      .where("publishes.site_id", "=", site.id)
      .orderBy("publishes.version", "desc")
      .limit(100)
      .execute();
    return c.json(
      rows.map((r) => ({
        version: r.version,
        status: r.status,
        createdAt: r.created_at,
        activatedAt: r.activated_at,
        needsProfile: r.needs_profile === null ? null : r.needs_profile === 1,
        error: r.error === null ? null : canReadRawPublishError(role) ? r.error : publishErrorCode(r.error),
        publishedBy: { id: r.published_by, name: r.publisher_name ?? "(削除済み)" },
      })),
    );
  },
);

/** 公開履歴の本体(compiled config)は ADMIN 以上。siteSalt を含むので VIEWER には返さない */
publishRoutes.get(
  "/sites/:sid/publishes/:version",
  describeRoute({
    tags: ["publish"],
    summary: "公開履歴の本体(管理者以上)。その version の compiled config",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "compiled config", content: { "application/json": { schema: resolver(PublishDetailSchema) } } },
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("param", VersionParam, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const version = Number(c.req.valid("param").version);
    const row = await c
      .get("db")
      .selectFrom("publishes")
      .select(["version", "config_json"])
      .where("site_id", "=", site.id)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!row || !row.config_json) throw notFound();
    return c.json({ version: row.version, config: JSON.parse(row.config_json) });
  },
);

/**
 * spec §13.9: Publish 確認画面(バナー / 確認サマリ)用。前回 activation(`sites.last_activated_at`)以降に
 * 触られた Experiment と、その中の Change を「誰が・いつ・Code Change か」付きで返す。Site 直下(Goal / オーディエンス)の
 * 変更は Experiment 単位に落とせないので `siteLevelChanged` に別枠でまとめる(GET /sites/:sid の `hasUnpublishedChanges`
 * と同じ 2 本立ての判定)。一度編集して元の値に戻しても「変更あり」のままなのは仕様(誤検知は許容。§13.9)
 */
publishRoutes.get(
  "/sites/:sid/publish-preview",
  describeRoute({
    tags: ["publish"],
    summary: "公開の確認サマリ(閲覧者以上)。前回 activation 以降に変更されたエクスペリエンス / 変更",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "未公開の編集サマリ", content: { "application/json": { schema: resolver(PublishPreviewSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  validator(
    "query",
    z.object({
      starting: z
        .string()
        .regex(SLUG_RE)
        .optional()
        .describe("下書きまたは一時停止中のエクスペリエンス ID を指定すると、それを今開始・再開したとして重なり(overlaps)だけを計算する。ほかの項目には効かない"),
    }),
    (r) => {
      if (!r.success) throw validationFailed(r.error);
    },
  ),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const since = site.last_activated_at ?? 0;
    const exps = await db
      .selectFrom("experiments")
      .leftJoin("user", "user.id", "experiments.updated_by")
      .selectAll("experiments")
      .select("user.name as updated_by_name")
      .where("experiments.site_id", "=", site.id)
      .where("experiments.updated_at", ">", since)
      .orderBy("experiments.updated_at", "desc")
      .execute();
    const changes = await db
      .selectFrom("changes")
      .leftJoin("user", "user.id", "changes.updated_by")
      .selectAll("changes")
      .select("user.name as updated_by_name")
      .where("changes.site_id", "=", site.id)
      .where("changes.updated_at", ">", since)
      .execute();
    // 決定 49: オーディエンスの変更と、いまの下書きを compile した結果(公開中の設定と比べる。設計書 §5.3・§11)
    const changedAudiences = await db
      .selectFrom("audiences")
      .select(["id", "name", "updated_at"])
      .where("site_id", "=", site.id)
      .where("updated_at", ">", since)
      .orderBy("updated_at", "desc")
      .execute();
    const usage = await audienceUsage(db, site.id);
    const startingId = c.req.valid("query").starting ?? null;
    let next: CompiledConfig | null = null;
    let compileError: { error: string; message: string; hint?: string } | null = null;
    let overlaps: ReturnType<typeof overlapWarnings> = [];
    try {
      const input = await buildCompileInput(db, site, (site.active_version ?? 0) + 1);
      // compile の前の入力から出す(compile に失敗しても重なりは見せる)
      if (startingId === null) overlaps = overlapWarnings(input.experiments);
      next = compile(input);
    } catch (e) {
      const code = e instanceof CompileError ? e.code : "compile_failed";
      // compile 以外の例外(D1 の一時障害など)は応答では compile_failed に丸めるので、原因を追えるよう生のエラーをログに残す
      if (!(e instanceof CompileError)) console.error("publish-preview failed (compile_failed)", e);
      compileError = { error: code, ...describeCompileFailure(code, e instanceof Error ? e.message : String(e)) };
    }
    if (startingId !== null) {
      // 決定 51(K7): その下書き・一時停止中のテストを「今開始・再開した」として並べた入力から、重なりだけを出す(ほかの項目は今の下書きのまま)
      try {
        const rows = (await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute()).map(
          (r): ExperimentRow => (r.id === startingId && (r.status === "draft" || r.status === "paused") ? { ...r, status: "running", last_started_at: Date.now() } : r),
        );
        const hypo = await buildCompileInput(db, site, (site.active_version ?? 0) + 1, rows);
        overlaps = overlapWarnings(hypo.experiments).filter((o) => o.experimentIds.includes(startingId));
      } catch (e) {
        console.error("publish-preview overlaps for starting failed", e); // 警告だけなので空で返す
      }
    }
    const active = await loadActiveConfig(db, site);
    const nextPatterns = next?.patterns;
    const droppedPageConditions =
      nextPatterns && active
        ? Object.entries(active.patterns)
            .filter(([id]) => !Object.prototype.hasOwnProperty.call(nextPatterns, id))
            .map(([, p]) => ({ part: p.part ?? "url", op: p.op, value: p.value }))
        : [];
    return c.json({
      audienceChanges: changedAudiences.map((a) => ({
        id: a.id,
        name: a.name,
        updatedAt: a.updated_at,
        experiments: (usage.get(a.id) ?? []).filter((u) => u.status === "running").map(({ id, name }) => ({ id, name })),
      })),
      droppedPageConditions,
      viewportExperiments: (next?.experiments ?? []).filter((e) => usesCondition(e.targeting, "viewport")).map((e) => ({ id: e.id, name: e.name })),
      compileError,
      overlaps,
      lastActivatedAt: site.last_activated_at,
      siteLevelChanged: site.content_updated_at > since,
      experiments: exps.map((e) => {
        const mine = changes.filter((ch) => ch.experiment_id === e.id);
        return {
          id: e.id,
          name: e.name,
          status: e.status,
          publishedStatus: e.published_status,
          updatedAt: e.updated_at,
          updatedBy: { id: e.updated_by, name: e.updated_by_name ?? "(削除済み)" },
          hasCodeChange: mine.some((ch) => CODE_CHANGE_TYPES.has(ch.type)),
          changedChanges: mine.map((ch) => ({
            variantId: ch.variant_id,
            id: ch.id,
            type: ch.type,
            updatedAt: ch.updated_at,
            updatedBy: { id: ch.updated_by, name: ch.updated_by_name ?? "(削除済み)" },
          })),
        };
      }),
    });
  },
);
