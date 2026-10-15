import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  ChangeSchema,
  ExperimentAnalyticsSchema,
  PageMatchInputSchema,
  TargetingInputSchema,
  VariantAnalyticsSchema,
  type Change,
  type ExperimentAnalytics,
  type VariantAnalytics,
} from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { toStatement, type Db, type ExperimentRow, type SiteRow, type VariantRow } from "../db";
import { ApiError, notFound, validationFailed } from "../errors";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { publicPublishResult, publishSite, type PublishResult } from "../publish";
import { loadSite } from "../roles";
import { PublishResultSchema } from "./publish";
import { experimentJson } from "../serialize";
import { assertExperimentAnalytics, assertName, assertTargetingRefs, normalizedPageMatch, normalizedTargeting, parseChange, targetingValidationFailed } from "../validation";

export const experimentRoutes = new Hono<AppEnv>();

// spec §13.1: id は Site 内一意のスラッグで作成後は変更不可(割当ハッシュの入力なので特に)。status は Task 7 の /status 専用
const ExperimentName = z.string().min(1);
const Targeting = TargetingInputSchema.nullable().describe(
  "配信条件。条件 1 つ、否定の形を持つ条件の not、または and / or の下に条件か否定の形を持つ条件の not が並ぶ形だけを受けます。入れ子やグループの除外はオーディエンスで作ります",
);
const Traffic = z.number().int().min(1).max(100).describe("1〜100。0 は paused で表現する");
const Analytics = ExperimentAnalyticsSchema.nullable();

const ExperimentCreate = z.strictObject({
  id: z.string().regex(SLUG_RE),
  name: ExperimentName,
  urlMatch: PageMatchInputSchema,
  targeting: Targeting.optional(),
  trafficPercentage: Traffic.default(100),
  persistAssignment: z.boolean().default(false),
  analytics: Analytics.optional(),
});
/**
 * PATCH は全フィールド任意。`ExperimentCreate.partial()` から導出しないのは、zod の `.partial()` が
 * 内側の `.default()` を残す(キー未指定でも 100 / false が入る)ため — PATCH のたびに
 * trafficPercentage / persistAssignment が既定値に戻ってしまう
 */
const ExperimentPatch = z.strictObject({
  name: ExperimentName.optional(),
  urlMatch: PageMatchInputSchema.optional(),
  targeting: Targeting.optional(),
  trafficPercentage: Traffic.optional(),
  persistAssignment: z.boolean().optional(),
  analytics: Analytics.optional(),
});

/** spec §6.4: Variant は 2 つ以上・weight の合計は 100(合計はルート側で `variant_weights_invalid` にする) */
const VariantsPut = z
  .array(
    z.strictObject({
      id: z.string().regex(SLUG_RE),
      name: z.string().min(1),
      weight: z.number().int().min(0).max(100),
      analytics: VariantAnalyticsSchema.nullable().optional(),
    }),
  )
  .min(2);
/** spec §11 / 決定 35 (7): 1 Variant の Change は 100 件まで(保存時の件数上限。Publish の 512KB 上限は別途) */
const MAX_CHANGES_PER_VARIANT = 100;
/**
 * core の Change(spec §11: TEXT / IMAGE / HIDE / ATTRIBUTE / HTML / CSS / CUSTOM_JS)の配列。
 * ここで `ChangeSchema` を使わないのは、個々の Change の失敗を `parseChange` が機械可読コード
 * (`attribute_not_allowed` / `change_too_large` / `image_outside_r2_domain` …)に変換するため。
 * この validator は「JSON の配列であること」だけを見る(requestBody は validator からしか組み立てられず、
 * describeRoute 側で宣言し直しても validator 由来の schema が勝つ)。
 * ただし zod 4 は `.meta()` のキーを `z.toJSONSchema` の出力にマージするので、`items` だけは
 * core の ChangeSchema から与える — parse は緩いまま、doc には本当の要素の形が載る(決定 34)
 */
const ChangesPut = z
  .array(z.unknown())
  .max(MAX_CHANGES_PER_VARIANT, { message: "too_many_changes" })
  .meta({
    description: `変更の配列。全置換(空配列でそのパターンの変更を全消し)。最大 ${MAX_CHANGES_PER_VARIANT} 件`,
    items: z.toJSONSchema(ChangeSchema) as Record<string, unknown>,
  });

const ExperimentJsonSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  status: z.enum(["draft", "running", "paused", "archived"]),
  publishedStatus: z.enum(["draft", "running", "paused", "archived"]).nullable().describe("前回公開時の status"),
  urlMatch: PageMatchInputSchema,
  targeting: Targeting,
  trafficPercentage: z.number().int(),
  persistAssignment: z.boolean(),
  analytics: Analytics,
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  unpublished: z.boolean().describe("前回の公開以降に変更されている"),
});
const ChangeJsonSchema = z.object({
  id: z.string(),
  type: z.enum(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]),
  selector: z.string().optional(),
  payload: z.unknown(),
  updatedBy: z.string(),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});
const ExperimentDetailJsonSchema = ExperimentJsonSchema.extend({
  variants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      weight: z.number().int(),
      analytics: VariantAnalyticsSchema.nullable(),
      changes: z.array(ChangeJsonSchema),
    }),
  ),
});

/** spec §13.8: draft → running、running ↔ paused、running | paused → archived(復帰不可)。表外は 409 invalid_transition */
const TRANSITIONS: Record<ExperimentRow["status"], Array<ExperimentRow["status"]>> = {
  draft: ["running"],
  running: ["paused", "archived"],
  paused: ["running", "archived"],
  archived: [],
};
const StatusBody = z.strictObject({ status: z.enum(["running", "paused", "archived"]) });
const StatusResponseSchema = z.object({ experiment: ExperimentJsonSchema, publish: PublishResultSchema });

/** spec §13.9: Experiment 単位の「未公開の変更」。Site の最終 Publish 時刻より後に触られていれば未公開 */
export const isUnpublished = (exp: ExperimentRow, site: Pick<SiteRow, "last_activated_at">): boolean => exp.updated_at > (site.last_activated_at ?? 0);

async function loadExperiment(db: Db, siteId: string, eid: string): Promise<ExperimentRow> {
  const row = await db.selectFrom("experiments").selectAll().where("site_id", "=", siteId).where("id", "=", eid).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

export async function loadVariants(db: Db, siteId: string, eid: string): Promise<VariantRow[]> {
  return db.selectFrom("variants").selectAll().where("site_id", "=", siteId).where("experiment_id", "=", eid).orderBy("position").execute();
}

const parseVariantAnalytics = (v: VariantRow): VariantAnalytics | undefined => (v.analytics_json ? (JSON.parse(v.analytics_json) as VariantAnalytics) : undefined);
const parseExperimentAnalytics = (e: ExperimentRow): ExperimentAnalytics | undefined => (e.analytics_json ? (JSON.parse(e.analytics_json) as ExperimentAnalytics) : undefined);

/**
 * D1 は 1 文あたりのバインドパラメータ数に 100 の上限がある(公式 docs "too many SQL variables")。
 * changes の多行 INSERT は 1 行 12 パラメータなので、9 行目で単一の INSERT 文だと上限を超えて 500 になる
 * (Task 13 の E2E で発覚)。ここで行を 8 行ずつ(12 × 8 = 96 < 100)に分け、複数の INSERT 文として
 * 同じ `env.DB.batch([...])` に積む — batch 全体は変わらず 1 トランザクションのままなので、
 * どこかの分割 INSERT だけが失敗しても delete 側も含めて丸ごとロールバックされる
 */
function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// spec §13.1: 子(Variant / Change / analytics)への書込みは親 Experiment の updated_at / updated_by を必ず更新する
// → 各 PUT の batch の最後の文で行う(別トランザクションにしない)

experimentRoutes.get(
  "/sites/:sid/experiments",
  describeRoute({
    tags: ["experiments"],
    summary: "サイトのエクスペリエンス一覧(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "エクスペリエンス一覧", content: { "application/json": { schema: resolver(z.array(ExperimentJsonSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const rows = await c.get("db").selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    return c.json(rows.map((r) => experimentJson(r, { unpublished: isUnpublished(r, site) })));
  },
);

experimentRoutes.post(
  "/sites/:sid/experiments",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを作成(編集者以上)。パターン a / b を 50 / 50 で自動作成する",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成したエクスペリエンス", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", ExperimentCreate, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "targeting");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const body = c.req.valid("json");
    const db = c.get("db");
    if (await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst()) {
      throw new ApiError(409, "id_taken", { id: body.id, message: "このエクスペリエンス ID は既に使われています", hint: "別の ID を指定してください" });
    }
    assertName(body.name, ["name"]);
    const urlMatch = normalizedPageMatch(body.urlMatch, ["urlMatch"]);
    const targeting = normalizedTargeting(body.targeting ?? null, "experiment", "targeting");
    await assertTargetingRefs(db, site, targeting, "targeting");
    const defaults = [
      { id: "a", name: "A", weight: 50 },
      { id: "b", name: "B", weight: 50 },
    ];
    assertExperimentAnalytics({ id: body.id, name: body.name, analytics: body.analytics ?? undefined }, defaults);
    const now = Date.now();
    const user = c.get("user").id;
    const row: ExperimentRow = {
      site_id: site.id,
      id: body.id,
      name: body.name,
      status: "draft",
      published_status: null,
      url_match_json: JSON.stringify(urlMatch),
      targeting_json: targeting ? JSON.stringify(targeting) : null,
      traffic_percentage: body.trafficPercentage,
      persist_assignment: body.persistAssignment ? 1 : 0,
      analytics_json: body.analytics ? JSON.stringify(body.analytics) : null,
      started_at: null,
      stopped_at: null,
      created_by: user,
      updated_by: user,
      created_at: now,
      updated_at: now,
    };
    // Experiment 行と既定 Variant を 1 batch = 1 トランザクションで書く(片方だけ残らない)
    await c.env.DB.batch([
      toStatement(c.env, db.insertInto("experiments").values(row)),
      toStatement(
        c.env,
        db.insertInto("variants").values(
          defaults.map((v, i) => ({ site_id: site.id, experiment_id: row.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: null })),
        ),
      ),
    ]);
    return c.json(experimentJson(row, { unpublished: true }), 201);
  },
);

experimentRoutes.get(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを 1 件取得(閲覧者以上)。パターンと変更を含む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "エクスペリエンス(パターン / 変更付き)", content: { "application/json": { schema: resolver(ExperimentDetailJsonSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const variants = await loadVariants(db, site.id, exp.id);
    const changes = await db
      .selectFrom("changes")
      .selectAll()
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .orderBy("position")
      .execute();
    return c.json({
      ...experimentJson(exp, { unpublished: isUnpublished(exp, site) }),
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        weight: v.weight,
        analytics: v.analytics_json ? JSON.parse(v.analytics_json) : null,
        changes: changes
          .filter((ch) => ch.variant_id === v.id)
          .map((ch) => ({
            id: ch.id,
            type: ch.type,
            ...(ch.selector ? { selector: ch.selector } : {}),
            payload: JSON.parse(ch.payload_json),
            updatedBy: ch.updated_by,
            updatedAt: ch.updated_at,
          })),
      })),
    });
  },
);

experimentRoutes.patch(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを更新(編集者以上)。id は不変、status は変更できない(status は /status で変更する)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のエクスペリエンス", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", ExperimentPatch, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "targeting");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    // 触る列だけを set に積む(status / published_status / started_at / stopped_at は Task 6 / 7 の帳簿。
    // 読んだ行をまるごと書き戻すと、並行する status 変更を古い値で潰しうる)
    const set: Partial<ExperimentRow> = { updated_at: Date.now(), updated_by: c.get("user").id };
    if (body.name !== undefined) {
      assertName(body.name, ["name"]);
      set.name = body.name;
    }
    if (body.urlMatch !== undefined) set.url_match_json = JSON.stringify(normalizedPageMatch(body.urlMatch, ["urlMatch"]));
    if (body.targeting !== undefined) {
      const targeting = normalizedTargeting(body.targeting, "experiment", "targeting");
      await assertTargetingRefs(db, site, targeting, "targeting");
      set.targeting_json = targeting ? JSON.stringify(targeting) : null;
    }
    if (body.trafficPercentage !== undefined) set.traffic_percentage = body.trafficPercentage;
    if (body.persistAssignment !== undefined) set.persist_assignment = body.persistAssignment ? 1 : 0;
    if (body.analytics !== undefined) set.analytics_json = body.analytics ? JSON.stringify(body.analytics) : null;
    const next: ExperimentRow = { ...exp, ...set };
    const variants = await loadVariants(db, site.id, exp.id);
    assertExperimentAnalytics(
      { id: next.id, name: next.name, analytics: parseExperimentAnalytics(next) },
      variants.map((v) => ({ id: v.id, name: v.name, analytics: parseVariantAnalytics(v) })),
    );
    await db.updateTable("experiments").set(set).where("site_id", "=", site.id).where("id", "=", exp.id).execute();
    return c.json(experimentJson(next, { unpublished: isUnpublished(next, site) }));
  },
);

experimentRoutes.delete(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを削除(編集者以上)。draft / archived のみ",
    security: [{ bearer: [] }],
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409) },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    if (exp.status === "running" || exp.status === "paused")
      throw new ApiError(409, "experiment_active", { message: "配信中のエクスペリエンスは削除できません", hint: "終了(archived)してから削除してください" });
    await db.deleteFrom("experiments").where("site_id", "=", site.id).where("id", "=", exp.id).execute(); // variants / changes は CASCADE
    return c.body(null, 204);
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants",
  describeRoute({
    tags: ["experiments"],
    summary: "パターンの集合を全置換(編集者以上)。2 つ以上・weight の合計 100。残るパターンの変更は保持される。draft のときだけ可",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "置換した", content: { "application/json": { schema: resolver(z.object({ ok: z.literal(true) })) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", VariantsPut, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    // spec §7.2: Variant の id / 重みは割当ハッシュの入力。running / paused の間に全置換すると配信中の訪問者を
    // 無言で再バケットしてしまう。archived は復帰不可(TRANSITIONS.archived = [])なので「Stop してから編集」という
    // 案内は行き止まりになる — さらに archived な Experiment の variant id は過去の analytics イベントが参照している
    // 履歴データでもあるので、そこを書き換えるのは「配信中の再バケット」とは別の理由で危険。
    // どちらも draft でしか安全に編集できないので、許可するのは draft のときだけにする(レビュー指摘で running/paused
    // のみの guard から拡張。同じ 409 experiment_active を流用 — code の分割は最終レビューに持ち越し)
    if (exp.status !== "draft") {
      throw new ApiError(409, "experiment_active", {
        message: "このエクスペリエンスのパターンは変更できません",
        hint: "配信中または終了済みのエクスペリエンスのパターンは変更できません。パターンを組み直すときは、新しいエクスペリエンスを作成してください",
      });
    }
    const body = c.req.valid("json");
    const ids = new Set(body.map((v) => v.id));
    if (ids.size !== body.length) throw new ApiError(422, "duplicate_variant_id", { message: "パターン ID が重複しています" });
    const sum = body.reduce((a, v) => a + v.weight, 0);
    if (sum !== 100) throw new ApiError(422, "variant_weights_invalid", { message: `重みの合計は 100 である必要があります(現在 ${sum})`, sum });
    for (const v of body) assertName(v.name, ["variants", v.id, "name"]);
    assertExperimentAnalytics(
      { id: exp.id, name: exp.name, analytics: parseExperimentAnalytics(exp) },
      body.map((v) => ({ id: v.id, name: v.name, analytics: v.analytics ?? undefined })),
    );
    const now = Date.now();
    // 消える Variant の Change は CASCADE で消え、残る Variant の Change は保持される(id で突き合わせ)。
    // D1 batch で 1 トランザクション(途中で失敗しても集合が壊れない)
    const analyticsJson = (v: (typeof body)[number]) => (v.analytics ? JSON.stringify(v.analytics) : null);
    await c.env.DB.batch([
      toStatement(c.env, db.deleteFrom("variants").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("id", "not in", [...ids])),
      ...body.map((v, i) =>
        toStatement(
          c.env,
          db
            .insertInto("variants")
            .values({ site_id: site.id, experiment_id: exp.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v) })
            .onConflict((oc) =>
              oc.columns(["site_id", "experiment_id", "id"]).doUpdateSet({ name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v) }),
            ),
        ),
      ),
      toStatement(c.env, db.updateTable("experiments").set({ updated_at: now, updated_by: c.get("user").id }).where("site_id", "=", site.id).where("id", "=", exp.id)),
    ]);
    return c.json({ ok: true });
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants/:vid/changes",
  describeRoute({
    tags: ["experiments"],
    summary: "パターンの変更を全置換(編集者以上)。1 件でも保存時検証に落ちれば何も書かない",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "置換した", content: { "application/json": { schema: resolver(z.object({ ok: z.literal(true), count: z.number().int() })) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", ChangesPut, (r) => {
    if (r.success) return;
    // 件数超過だけは専用コード(zod の issue message に "too_many_changes" を入れて見分ける)
    if (r.error.some((i) => i.message === "too_many_changes")) {
      throw new ApiError(422, "too_many_changes", {
        max: MAX_CHANGES_PER_VARIANT,
        message: `変更は 1 パターンあたり ${MAX_CHANGES_PER_VARIANT} 件までです`,
        hint: "変更を分割するか、不要な変更を削除してください",
      });
    }
    throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const vid = c.req.param("vid");
    const variant = await db
      .selectFrom("variants")
      .select("id")
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("id", "=", vid)
      .executeTakeFirst();
    if (!variant) throw notFound();
    // 全件を検証してから書く(1 件でも不正なら何も書かない)
    const changes: Change[] = c.req.valid("json").map((r) => parseChange(c.env, site.id, r));
    const ids = new Set(changes.map((ch) => ch.id));
    if (ids.size !== changes.length) throw new ApiError(422, "duplicate_change_id", { message: "変更の ID が重複しています" });
    for (const ch of changes)
      if (!SLUG_RE.test(ch.id)) throw new ApiError(422, "invalid_change_id", { changeId: ch.id, message: `変更の ID(${ch.id})の形式が不正です(スラッグのみ)` });
    const now = Date.now();
    const user = c.get("user").id;
    const existing = await db
      .selectFrom("changes")
      .select(["id", "created_by", "created_at"])
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("variant_id", "=", vid)
      .execute();
    const prev = new Map(existing.map((e) => [e.id, e]));
    const changeRows = changes.map((ch, i) => ({
      site_id: site.id,
      experiment_id: exp.id,
      variant_id: vid,
      id: ch.id,
      type: ch.type,
      selector: "selector" in ch ? ch.selector : null,
      payload_json: JSON.stringify(ch.payload),
      position: i,
      created_by: prev.get(ch.id)?.created_by ?? user,
      created_at: prev.get(ch.id)?.created_at ?? now,
      updated_by: user,
      updated_at: now,
    }));
    // D1 batch で 1 トランザクション(途中で失敗しても集合が壊れない)。
    // 8 行(12 パラメータ/行 × 8 = 96)ずつに分けた複数の INSERT 文として積む(上のコメント参照)
    await c.env.DB.batch([
      toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "=", vid)),
      ...chunk(changeRows, 8).map((rows) => toStatement(c.env, db.insertInto("changes").values(rows))),
      toStatement(c.env, db.updateTable("experiments").set({ updated_at: now, updated_by: user }).where("site_id", "=", site.id).where("id", "=", exp.id)),
    ]);
    return c.json({ ok: true, count: changes.length });
  },
);

/**
 * spec §13.8 / 決定 17: status 変更(ADMIN 以上)。遷移が成功したら Site を自動 Publish する。
 * Publish が失敗しても D1 の status は戻さない — `published_status` は前回 activation の値のままなので
 * 応答の `experiment.status` と `experiment.publishedStatus` の差が「未反映」の目印になる(UI はここでアラートを出す)。
 * status の CAS 更新が成功した後は、publishSite 自体や応答の組み立てで何がこけても 200(`publish.ok: false`)を返す —
 * 500 にすると、既に成功している status 変更を operator がもう一度やり直そうとして
 * 409 invalid_transition(自分自身の変更と競合)という行き止まりに落ちる
 */
experimentRoutes.post(
  "/sites/:sid/experiments/:eid/status",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスの status を遷移する(管理者以上)。成功した遷移は必ずサイトを自動公開する",
    security: [{ bearer: [] }],
    responses: {
      200: {
        description: "遷移後のエクスペリエンスと公開の結果(公開失敗も 200 の ok:false で返る)",
        content: { "application/json": { schema: resolver(StatusResponseSchema) } },
      },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", StatusBody, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    if (!TRANSITIONS[exp.status].includes(body.status)) throw new ApiError(409, "invalid_transition", { from: exp.status, to: body.status });
    const now = Date.now();
    // 決定 34: analytics-recipe の期間に使う。started_at は最初の running のみ(Pause → Resume で動かさない)、stopped_at は archived
    const stamps = {
      ...(body.status === "running" && exp.started_at === null ? { started_at: now } : {}),
      ...(body.status === "archived" ? { stopped_at: now } : {}),
    };
    // 読んだ status のままであることを条件に更新する(並行 status 変更の stale read を弾く。負けた側は 409 で上書きしない)
    const upd = await db
      .updateTable("experiments")
      .set({ status: body.status, ...stamps, updated_at: now, updated_by: c.get("user").id })
      .where("site_id", "=", site.id)
      .where("id", "=", exp.id)
      .where("status", "=", exp.status)
      .executeTakeFirst();
    if (Number(upd.numUpdatedRows) === 0) {
      const fresh = await loadExperiment(db, site.id, exp.id);
      throw new ApiError(409, "invalid_transition", { from: fresh.status, to: body.status, hint: "別の操作と競合しました。再読込してください" });
    }
    // status の CAS は既に成功して D1 に着地している。ここから先(publishSite 自体、および応答を組み立てる 2 回の
    // 読み直し)のどこで D1 / KV がこけても、それを 500 として返してはいけない — status 変更そのものは成功しているので、
    // 再試行した operator は「もう一度 running にしようとして 409 invalid_transition(自分の変更と競合)」という
    // 行き止まりに落ちる(レビュー指摘)。1 つの try で 3 呼び出しをまとめて囲み、フォールバックは D1 を再度叩かない
    // (直前に自分が書いた値からその場で組み立てる)
    let publish: PublishResult;
    let fresh: ExperimentRow;
    let freshSite: Pick<SiteRow, "last_activated_at">;
    try {
      publish = await publishSite(c.env, db, site, c.get("user").id);
      fresh = await loadExperiment(db, site.id, exp.id);
      freshSite = await db.selectFrom("sites").select("last_activated_at").where("id", "=", site.id).executeTakeFirstOrThrow();
    } catch (e) {
      console.error("status change committed but publish (or its follow-up read) failed", e);
      publish = { ok: false, version: null, error: "publish_failed", message: e instanceof Error ? e.message : String(e) };
      fresh = { ...exp, status: body.status, ...stamps, updated_at: now, updated_by: c.get("user").id };
      freshSite = site; // この失敗パスでは activation まで届いていないので last_activated_at は進んでいない
    }
    return c.json({ experiment: experimentJson(fresh, { unpublished: isUnpublished(fresh, freshSite) }), publish: publicPublishResult(publish) });
  },
);
