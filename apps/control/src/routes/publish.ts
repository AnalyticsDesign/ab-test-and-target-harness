import { diffCompiledConfigs } from "../config-diff";
import { reviewMarkOf } from "../review-marks";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import { guardAssets } from "../asset-guard";
import { auditActor, auditStatement } from "../audit";
import { toStatement, type ChangeRow, type ExperimentRow } from "../db";
import { ApiError, notFound, publishBodyPruned, validationFailed } from "../errors";
import { overlapWarnings } from "../experiment-order";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { canReadRawPublishError, loadSite } from "../roles";
import { compile, CompileError, usesCondition, type CompiledConfig, parseCompiledConfig } from "@wtt/core";
import { COMPILE_ROW_STATEMENTS, compileRowStatements, parseCompileRows, buildCompileInputFromRows, compileInputDigest, applyTransitionToRows, buildCompileInput, describeCompileFailure, type StoredCompileInput, loadActiveConfig, publicPublishResult, publishErrorCode, publishSite } from "../publish";
import { requestStaticDeploy } from "../static-delivery";
import { audienceUsage } from "./audiences";

export const publishRoutes = new Hono<AppEnv>();

/**
 * 公開の準備の失敗は HTTP 200 + `ok: false`、確定したか分からない場合は 503 の封筒で返す。
 * Task 7 の `POST …/status` も応答の `publish` フィールドにこの同じ schema を使う(export してそちらから import する)
 */
/** B68: 公開する設定の中の、見つからない画像・別のサイトの画像と、それを含む変更(公開の失敗・確認の画面・状態を変える口の 409 が同じ形) */
export const AssetProblemSchema = z.object({
  url: z.string().describe("設定の中にそのまま書かれた画像の URL"),
  reason: z
    .enum(["missing", "other_site"])
    .describe("missing = このサイトの画像の一覧に無い画像・消すと決まった画像(削除待ちの間は通る) / other_site = 同じ導入の別のサイトの画像・別のサイトの画像アップローダーの URL"),
  experimentId: z.string(),
  variantId: z.string(),
  changeId: z.string(),
});

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
        "公開の警告(拒否はしない)。dataLayer の名札(GA4 で値が破棄される可能性)、配信するタグの大きさ(path = bootstrap)、同じ対象 URL で同じ要素を変えるエクスペリエンスの組(path = experiments.<優先の低い方の ID>。どちらが優先されるかを message に書く)。path が delivery のときは公開は確定し、配信への反映だけが遅れている(自動で反映する)",
      ),
  }),
  z.object({
    ok: z.literal(false),
    version: z.number().int().nullable(),
    error: z.string().describe("機械可読コード(kv_put_failed / kv_verify_failed / publish_record_missing / state_changed(準備の間にエクスペリエンスの状態が変わった。もう一度公開する) / publish_reservation_expired(準備に時間がかかりすぎた。もう一度公開する) / stale_preview / legacy_targeting / unknown_audience / within_days_exceeds_retention / asset_missing / asset_other_site …)。確定したかを確かめられないときは 503 publish_outcome_unknown の封筒を返す。送り直す前に公開履歴と状態を読み直す"),
    message: z.string(),
    hint: z.string().optional(),
    assetProblems: z
      .array(AssetProblemSchema)
      .optional()
      .describe(
        "error が asset_missing(このサイトの画像の一覧に無い画像・消すと決まった画像。削除待ちの間は通る)/ asset_other_site(同じ導入の別のサイトの画像・別のサイトの画像アップローダーの URL)のとき: 問題の画像の URL と、それを含む変更。同じ URL を複数の変更が含めば、それぞれ 1 件。パターンの変更から外すか、このサイトの画像に差し替えて、もう一度公開する",
      ),
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
  bodyPrunedAt: z.number().int().nullable().describe("この版の公開の本体を、保存の上限を過ぎたため消した時刻(epoch ミリ秒)。null は本体が残っているか、もともと無い(予約・失敗の版)。消した版は GET /sites/:sid/publishes/:version が 404"),
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
  reviewMark: z.enum(["code", "external_url"]).nullable().describe("コード、または外部の URL を含む可能性がある変更の印"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  updatedBy: ActorSchema,
});
const PublishPreviewExperimentSchema = z.object({
  detectedBy: z.enum(["time", "config"]).describe("更新時刻、または公開中の設定との比較で見つかった変更"),
  id: z.string(),
  name: z.string(),
  status: z.enum(["draft", "running", "paused", "archived"]),
  publishedStatus: z.enum(["draft", "running", "paused", "archived"]).nullable(),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  updatedBy: ActorSchema,
  hasCodeChange: z.boolean().describe("HTML / CSS / CUSTOM_JS、または <style> などの要素に当たりうる TEXT / ATTRIBUTE を含むか"),
  hasExternalUrl: z.boolean().describe("外部の URL を含む ATTRIBUTE があるか"),
  changedChanges: z.array(ChangedChangeSchema),
});
const RefSchema = z.object({ id: z.string(), name: z.string() });
const PublishPreviewSchema = z.object({
  digest: z.string().nullable().describe("現在の公開入力の sha256。公開の expectDigest に送る"),
  transitionDigest: z.string().nullable().describe("指定した状態に変更した後の公開入力の sha256。状態の変更の expectDigest に送る。遷移できない場合は null"),
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
  assetProblems: z
    .array(AssetProblemSchema)
    .describe("いまの下書きを公開すると、画像の確かめで止まる参照(見つからない画像・別のサイトの画像)と、それを含む変更。無ければ空の配列。starting には効かない"),
  overlaps: z
    .array(z.object({ path: z.string(), message: z.string(), experimentIds: z.array(z.string()).describe("[優先の低い方, 高い方]") }))
    .describe(
      "同じ対象 URL の条件で同じ要素(セレクタの文字列が同じ)を変える、配信中のエクスペリエンスの組。後に並ぶものが優先される(パーソナライズよりテスト、テストどうしは先に開始・再開したもの、パーソナライズどうしは後に作成したもの)。starting を付けたときは、その下書き・一時停止中のテストを今開始・再開したとして並べ、その ID を含む組だけ",
    ),
});

/** 公開履歴の本体は version 単位。`:version` は 10 進の整数だけを受ける */
const VersionParam = z.object({ sid: z.string(), version: z.string().regex(/^\d+$/, "version must be a positive integer") });

export const PublishBodySchema = z.strictObject({ expectDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() });

/** 空の本文も受けるが、読めない JSON や未知のキーで束縛が外れないようにする。 */
publishRoutes.post(
  "/sites/:sid/publish",
  describeRoute({
    tags: ["publish"],
    summary: "サイトを公開(管理者以上)。expectDigest を付けると、確認画面で見た内容のときだけ公開する。準備の失敗は 200 + ok:false、確定したか不明なら 503 publish_outcome_unknown の封筒を返す",
    requestBody: { required: false, content: { "application/json": { schema: z.toJSONSchema(PublishBodySchema) as Record<string, unknown> } } },
    security: [{ bearer: [] }],
    responses: {
      200: { description: "公開の結果(成功 / 失敗の両方)", content: { "application/json": { schema: resolver(PublishResultSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422, 503),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const text = await c.req.text();
    let raw: unknown = {};
    if (text !== "") {
      try { raw = JSON.parse(text); } catch { throw new ApiError(400, "bad_request"); }
    }
    const parsed = PublishBodySchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    return c.json(publicPublishResult(await publishSite(c.env, c.get("db"), site, auditActor(c), undefined, parsed.data)));
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
    // 7i plan K23: 途中で止まった削除を取りやめる(削除の印を消す)。この後に古い削除が D1 を消そうとしても、印が違うので消えない。
    // B129: 同じ batch に publish.static_redeploy の記録(UPDATE の後。UPDATE に条件が無いので無条件。1 文の execute を 2 文の batch にした)
    await c.env.DB.batch([
      toStatement(c.env, db.updateTable("sites").set({ static_removing: null }).where("id", "=", site.id)),
      auditStatement(c.env.DB, auditActor(c), { action: "publish.static_redeploy", workspaceId: site.workspace_id, siteId: site.id, target: { type: "site", id: site.id, label: site.name }, detail: {} }),
    ]);
    // 作り直しは前回と同じ中身でもデプロイさせる(配信専用の Worker の実物が記録とずれたときの直し)。
    // 削除の墓標に負けている・デプロイ専用の Worker の記録が D1 より先行している・同じ世代で中身が違う(D1 を戻した後など)なら、
    // epoch をその受け付け済みの世代 + 1 に進めて 1 回だけ出し直す(自動では戻さない。戻すのはこの操作だけ。plan K2、7o K7)
    const outcome = await requestStaticDeploy(c.env, db, site.id, { force: true, recover: true });
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
        "publishes.body_pruned_at",
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
        bodyPrunedAt: r.body_pruned_at,
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
    summary: "公開履歴の本体(管理者以上)。その version の compiled config。古い版の本体は残らないことがある(404 の bodyPrunedAt)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "compiled config", content: { "application/json": { schema: resolver(PublishDetailSchema) } } },
      ...errorResponses(401, 403, 404, 422),
      404: { ...errorResponses(404)[404], description: "版が無いか、本体がありません。保存の上限を過ぎて本体を消した版は bodyPrunedAt(epoch ミリ秒)と hint を返します" },
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
      .select(["version", "config_json", "body_pruned_at"])
      .where("site_id", "=", site.id)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!row || !row.config_json) {
      if (row?.body_pruned_at !== null && row?.body_pruned_at !== undefined) throw publishBodyPruned(row.body_pruned_at);
      throw notFound();
    }
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
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  validator(
    "query",
    z.object({
      transition: z.string().regex(new RegExp(`^${SLUG_RE.source.replace(/^\^|\$$/g, "")}:(running|paused|archived)$`)).optional().describe("対象のエクスペリエンス ID と変更先の状態。transitionDigest を状態の変更の expectDigest に送る"),
      starting: z
        .string()
        .regex(SLUG_RE)
        .optional()
        .describe("下書きまたは一時停止中のエクスペリエンス ID を指定すると、それを今開始・再開したとして重なり(overlaps)だけを計算する。transition=<id>:running の別名"),
    }).refine((v) => !(v.transition && v.starting), { message: "transition と starting は同時に指定できません" }),
    (r) => {
      if (!r.success) throw validationFailed(r.error);
    },
  ),
  async (c) => {
    const { site: authorizedSite } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const siteId = authorizedSite.id;
    const batch = await c.env.DB.batch([
      ...compileRowStatements(c.env, db, siteId),
      toStatement(c.env, db.selectFrom("experiments").leftJoin("user", "user.id", "experiments.updated_by").selectAll("experiments").select("user.name as updated_by_name").where("experiments.site_id", "=", siteId).orderBy("experiments.updated_at", "desc")),
      toStatement(c.env, db.selectFrom("changes").leftJoin("user", "user.id", "changes.updated_by").selectAll("changes").select("user.name as updated_by_name").where("changes.site_id", "=", siteId)),
      toStatement(c.env, db.selectFrom("publishes").select("config_json").where("site_id", "=", siteId).where("version", "=", db.selectFrom("sites").select("active_version").where("id", "=", siteId))),
    ]);
    const rows = parseCompileRows(batch.slice(0, COMPILE_ROW_STATEMENTS));
    const { site } = rows;
    const since = site.last_activated_at ?? 0;
    const [experimentEdits, changeEdits, activePublish] = batch.slice(COMPILE_ROW_STATEMENTS);
    const allExps = experimentEdits!.results as Array<ExperimentRow & { updated_by_name: string | null }>;
    const exps = allExps.filter((e) => e.updated_at > since);
    const changes = (changeEdits!.results as Array<ChangeRow & { updated_by_name: string | null }>).filter((ch) => ch.updated_at > since);
    const changedAudiences = rows.audiences.filter((a) => a.updated_at > since).sort((a, b) => b.updated_at - a.updated_at);
    const usage = await audienceUsage(db, site.id);
    const query = c.req.valid("query");
    const transition = query.transition ?? (query.starting ? `${query.starting}:running` : null);
    const [transitionId, transitionTo] = transition?.split(":") ?? [];
    let digest: string | null = null;
    let transitionDigest: string | null = null;
    let transitionInput: StoredCompileInput | null = null;
    let transitionNext: CompiledConfig | null = null;
    let next: CompiledConfig | null = null;
    let compileError: { error: string; message: string; hint?: string } | null = null;
    let overlaps: ReturnType<typeof overlapWarnings> = [];
    let input: StoredCompileInput | null = null;
    try {
      input = buildCompileInputFromRows((site.active_version ?? 0) + 1, rows);
      digest = await compileInputDigest(input);
      // compile の前の入力から出す(compile に失敗しても重なりは見せる)
      if (transition === null) overlaps = overlapWarnings(input.experiments);
      next = compile(input);
    } catch (e) {
      const code = e instanceof CompileError ? e.code : "compile_failed";
      // compile 以外の例外(D1 の一時障害など)は応答では compile_failed に丸めるので、原因を追えるよう生のエラーをログに残す
      if (!(e instanceof CompileError)) console.error("publish-preview failed (compile_failed)", e);
      compileError = { error: code, ...describeCompileFailure(code, e instanceof Error ? e.message : String(e)) };
    }
    if (transitionId && transitionTo) {
      try {
        const now = Date.now();
        const hypothetical = applyTransitionToRows(rows, {
          experimentId: transitionId, to: transitionTo as "running" | "paused" | "archived",
          stamps: transitionTo === "running" ? { last_started_at: now, started_at: now } : transitionTo === "archived" ? { stopped_at: now } : {},
        });
        if (hypothetical) {
          transitionInput = buildCompileInputFromRows((site.active_version ?? 0) + 1, hypothetical);
          transitionDigest = await compileInputDigest(transitionInput);
          overlaps = transitionTo === "running" ? overlapWarnings(transitionInput.experiments).filter((o) => o.experimentIds.includes(transitionId)) : [];
          transitionNext = compile(transitionInput);
        }
      } catch (e) { console.error("publish-preview transition failed", e); }
    }
    // B68(spec §22.5): 公開と同じ画像の確かめ。管理する画像の URL があるときだけ D1 を 1 回読む。別のサイトの URL は読まずに other_site。
    // compile に失敗したときは出さない(公開は compile で止まる)。starting の仮の入力には当てない
    const assetGuard = next && input ? await guardAssets(c.env, db, site, input, JSON.stringify(next), { readD1: true }) : null;
    const assetProblems = assetGuard && !assetGuard.ok ? assetGuard.assetProblems : [];
    let active: CompiledConfig | null = null;
    const activeJson = (activePublish!.results[0] as { config_json: string | null } | undefined)?.config_json;
    if (activeJson) { try { active = parseCompiledConfig(JSON.parse(activeJson)); } catch { /* 読めない過去の版は比較しない */ } }
    const nextPatterns = next?.patterns;
    const droppedPageConditions =
      nextPatterns && active
        ? Object.entries(active.patterns)
            .filter(([id]) => !Object.prototype.hasOwnProperty.call(nextPatterns, id))
            .map(([, p]) => ({ part: p.part ?? "url", op: p.op, value: p.value }))
        : [];
    // B77: compiled config は名前を持たないので、名前は D1 の行から ID で引く(無ければ ID)。
    // exps は前回の activation 以降に変わった行だけなので使えず(変えずに running のままのエクスペリエンスが漏れる)、サイトの行を読む
    const viewport = (next?.experiments ?? []).filter((e) => usesCondition(e.targeting, "viewport")).map((e) => e.id);
    const viewportNames = new Map(allExps.map((e) => [e.id, e.name]));
    const comparisonNext = transition ? transitionNext : next;
    const comparisonInput = transition ? transitionInput : input;
    const diff = comparisonNext && active ? diffCompiledConfigs(comparisonNext, active) : { experimentIds: [], siteLevel: false };
    const configIds = new Set(diff.experimentIds);
    const timeIds = new Set(exps.map((e) => e.id));
    let siteLevelChanged = site.content_updated_at > since || diff.siteLevel;
    for (const id of configIds) {
      if (timeIds.has(id)) continue;
      const row = allExps.find((e) => e.id === id);
      if (row) exps.push(row);
      else siteLevelChanged = true;
    }
    return c.json({
      digest, transitionDigest,
      audienceChanges: changedAudiences.map((a) => ({
        id: a.id,
        name: a.name,
        updatedAt: a.updated_at,
        experiments: (usage.get(a.id) ?? []).filter((u) => u.status === "running").map(({ id, name }) => ({ id, name })),
      })),
      droppedPageConditions,
      viewportExperiments: viewport.map((id) => ({ id, name: viewportNames.get(id) ?? id })),
      compileError,
      assetProblems,
      overlaps,
      lastActivatedAt: site.last_activated_at,
      siteLevelChanged,
      experiments: exps.map((e) => {
        const mine = timeIds.has(e.id) ? changes.filter((ch) => ch.experiment_id === e.id) : [];
        const marks = configIds.has(e.id)
          ? (comparisonInput?.experiments.find((x) => x.id === e.id)?.variants.flatMap((v) => v.changes) ?? []).map(reviewMarkOf)
          : mine.map((ch) => reviewMarkOf({ ...ch, payload: JSON.parse(ch.payload_json) }));
        return {
          detectedBy: timeIds.has(e.id) ? "time" : "config",
          id: e.id,
          name: e.name,
          status: e.status,
          publishedStatus: e.published_status,
          updatedAt: e.updated_at,
          updatedBy: { id: e.updated_by, name: e.updated_by_name ?? "(削除済み)" },
          hasCodeChange: marks.includes("code"),
          hasExternalUrl: marks.includes("external_url"),
          changedChanges: mine.map((ch) => ({
            variantId: ch.variant_id,
            id: ch.id,
            type: ch.type,
            reviewMark: reviewMarkOf({ ...ch, payload: JSON.parse(ch.payload_json) }),
            updatedAt: ch.updated_at,
            updatedBy: { id: ch.updated_by, name: ch.updated_by_name ?? "(削除済み)" },
          })),
        };
      }),
    });
  },
);
