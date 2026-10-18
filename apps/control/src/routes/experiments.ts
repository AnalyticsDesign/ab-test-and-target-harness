import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import type { ExpressionBuilder } from "kysely";
import { z } from "zod";
import {
  ChangeSchema,
  EXPERIMENT_KINDS,
  ExperimentAnalyticsRequestSchema,
  ExperimentAnalyticsSchema,
  PageMatchInputSchema,
  TargetingInputSchema,
  VariantAnalyticsRequestSchema,
  VariantAnalyticsSchema,
  duplicateIdCandidates,
  duplicateName,
  type Change,
  type ExperimentAnalytics,
  type ExperimentKind,
  type VariantAnalytics,
  newRunId,
} from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { resultsStore } from "../capabilities";
import { toStatement, type Db, type ExperimentRow, type SiteRow, type Tables, type VariantRow } from "../db";
import { copyChangesQuery, copyVariantsQuery, duplicateExperimentRow, insertExperimentQuery, retiredIds } from "../duplicate";
import { ApiError, notFound, validationFailed } from "../errors";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { publicPublishResult, publishSite, type PublishResult } from "../publish";
import { loadSite } from "../roles";
import { PublishResultSchema } from "./publish";
import { experimentJson } from "../serialize";
import {
  ANALYTICS_REQUEST_DESCRIPTION,
  assertAnalyticsValues,
  assertDescription,
  assertExperimentAnalytics,
  assertName,
  assertTargetingRefs,
  normalizedPageMatch,
  normalizedTargeting,
  parseChange,
  targetingValidationFailed,
} from "../validation";

export const experimentRoutes = new Hono<AppEnv>();

/** D9 ②(設計書 §6.3): 一度開始したエクスペリエンスの ID(削除済み)を指定した作成・複製 */
const retiredIdTaken = (id: string) =>
  new ApiError(409, "id_taken", {
    id,
    message: "このエクスペリエンス ID は使い直せません",
    hint: "この ID は以前に開始したエクスペリエンスで使われていました。別の ID を指定してください",
  });

// spec §13.1: id は Site 内一意のスラッグで作成後は変更不可(割当ハッシュの入力なので特に)。status は Task 7 の /status 専用
const ExperimentName = z.string().min(1);
const Targeting = TargetingInputSchema.nullable().describe(
  "配信条件。条件 1 つ、否定の形を持つ条件の not、または and / or の下に条件か否定の形を持つ条件の not が並ぶ形だけを受けます。入れ子やグループの除外はオーディエンスで作ります",
);
const Traffic = z.number().int().min(1).max(100).describe("1〜100。0 は paused で表現する");
/** B77(K12): 受け口は値を文字列として受けるだけ(値の検査は assertAnalyticsValues)。応答は保存する形 */
const Analytics = ExperimentAnalyticsRequestSchema.nullable().describe(ANALYTICS_REQUEST_DESCRIPTION);
const AnalyticsJson = ExperimentAnalyticsSchema.nullable();
const Description = z.string().describe("メモ(社内用。外部には出力されない)。1,000 字まで");
const KIND_DESCRIPTION =
  "種別。test = テスト(2 つ以上のパターンに訪問者を振り分けて比べる)、single = パーソナライズ(パターン 1 つ・重み 100。振り分けず、条件に合う訪問者全員に表示する)。作成後は変えられない(変えたいときは複製する)";
const Kind = z.enum(EXPERIMENT_KINDS).describe(KIND_DESCRIPTION);

const ExperimentCreate = z.strictObject({
  id: z.string().regex(SLUG_RE),
  name: ExperimentName,
  kind: Kind.default("test"),
  urlMatch: PageMatchInputSchema,
  targeting: Targeting.optional(),
  trafficPercentage: Traffic.default(100),
  persistAssignment: z.boolean().default(false),
  analytics: Analytics.optional(),
  description: Description.optional(),
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
  description: Description.optional().describe("メモ(社内用。外部には出力されない)。1,000 字まで。body がこのキーだけのときは状態にかかわらず受け、未公開の編集にしない"),
});

/** 決定 51: パターンの数は種別で決まる(テストは 2 つ以上・パーソナライズは 1 つ)。数はルートで `variant_count_invalid` にする。weight の合計は 100(ルート側で `variant_weights_invalid` にする) */
const VariantsPut = z
  .array(
    z.strictObject({
      id: z.string().regex(SLUG_RE),
      name: z.string().min(1),
      weight: z.number().int().min(0).max(100),
      analytics: VariantAnalyticsRequestSchema.nullable().optional().describe(ANALYTICS_REQUEST_DESCRIPTION),
      // B77(K8): 省いたら保存済みの値を保つ(新しいパターンは false / '')。deploy の途中で古い管理画面が送らなくても印とメモが消えない
      original: z
        .boolean()
        .optional()
        .describe("オリジナル(変更を持たず、元のページをそのまま見せるパターン)。true にするとそのパターンの変更を消す。テストだけ。省略時は保存済みの値を保つ"),
      description: Description.optional().describe("メモ(社内用。外部には出力されない)。1,000 字まで。省略時は保存済みの値を保つ"),
    }),
  )
  .min(1);
/** B77(K9): パターンのメモだけを更新する。ほかのキーは受けない */
const VariantPatch = z.strictObject({ description: Description });
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
  description: z.string().describe("メモ(社内用。外部には出力されない)"),
  kind: Kind,
  status: z.enum(["draft", "running", "paused", "archived"]),
  publishedStatus: z.enum(["draft", "running", "paused", "archived"]).nullable().describe("前回公開時の status"),
  urlMatch: PageMatchInputSchema,
  targeting: Targeting,
  trafficPercentage: z.number().int(),
  persistAssignment: z.boolean(),
  analytics: AnalyticsJson,
  runId: z
    .string()
    .nullable()
    .describe("結果の記録の ID。結果を記録するサイトでテストを開始したときに 1 回だけ振る。下書き・パーソナライズ・結果を記録しないサイトで開始したテストは null"),
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
const VariantJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number().int(),
  original: z.boolean().describe("オリジナル(変更を持たず、元のページをそのまま見せるパターン)"),
  description: z.string().describe("メモ(社内用。外部には出力されない)"),
  analytics: VariantAnalyticsSchema.nullable(),
});
const ExperimentDetailJsonSchema = ExperimentJsonSchema.extend({
  variants: z.array(VariantJsonSchema.extend({ changes: z.array(ChangeJsonSchema) })),
});

/** B77(K8): オリジナルのパターンへの変更の保存 */
const variantOriginal = () =>
  new ApiError(422, "variant_original", {
    message: "オリジナルのパターンには変更を保存できません",
    hint: "オリジナルは元のページをそのまま表示します。変更を加えるときは、オリジナルを外すか別のパターンに保存してください",
  });

/** spec §13.8: draft → running、running ↔ paused、running | paused → archived(復帰不可)。表外は 409 invalid_transition */
const TRANSITIONS: Record<ExperimentRow["status"], Array<ExperimentRow["status"]>> = {
  draft: ["running"],
  running: ["paused", "archived"],
  paused: ["running", "archived"],
  archived: [],
};
const DuplicateBody = z
  .strictObject({
    mode: z.enum(["same", "variant"]).describe("same = 同じ内容(種別・すべてのパターンと設定)の下書き。variant = 選んだパターンだけを表示するパーソナライズの下書き(配信率 100%・割当の固定 off)"),
    variantId: z.string().optional().describe("mode が variant のとき必須。表示するパターンの ID"),
    id: z.string().regex(SLUG_RE).optional().describe("新しいエクスペリエンス ID。省略時は <元の ID>-copy、-copy-2 … の空いているもの"),
    name: ExperimentName.optional().describe("省略時は「<元の名前> のコピー」または「<元の名前>(<パターン名> だけを表示)」"),
  })
  .refine((b) => b.mode !== "variant" || b.variantId !== undefined, { message: "variantId is required when mode is variant", path: ["variantId"] });
const StatusBody = z.strictObject({ status: z.enum(["running", "paused", "archived"]) });
const StatusResponseSchema = z.object({
  experiment: ExperimentJsonSchema,
  publish: PublishResultSchema,
  warnings: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .describe("遷移は成功したが知らせたいこと(いつも配列。無ければ空)。結果を記録しないテストを開始したときは path = results"),
});
/** D9 ②(設計書 §5.2): 結果を記録しないテストの開始で応答に足す警告。拒否はしない(画面は確認のモーダルで出す) */
const RESULTS_NOT_RECORDED = { path: "results", message: "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません" };

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

const variantJson = (v: VariantRow) => ({
  id: v.id,
  name: v.name,
  weight: v.weight,
  original: v.original === 1,
  description: v.description,
  analytics: v.analytics_json ? (JSON.parse(v.analytics_json) as VariantAnalytics) : null,
});

/** B77(K8): パターンがオリジナルである(`variants as ov` の副問い合わせ)。PUT …/changes の条件付きの DELETE と親の更新の条件に使う */
const variantIsOriginal = (siteId: string, eid: string, vid: string) => (eb: ExpressionBuilder<Tables, any>) =>
  eb.exists(eb.selectFrom("variants as ov").select("ov.id").where("ov.site_id", "=", siteId).where("ov.experiment_id", "=", eid).where("ov.id", "=", vid).where("ov.original", "=", 1));

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

/** 決定 51(設計書 §3.1): テストは 2 つ以上、パーソナライズはちょうど 1 つ。重みの合計 100 は別の検査(variant_weights_invalid) */
function assertVariantCount(kind: ExperimentKind, count: number): void {
  if (kind === "single" ? count === 1 : count >= 2) return;
  throw new ApiError(422, "variant_count_invalid", {
    kind,
    count,
    message: kind === "single" ? "パーソナライズのパターンは 1 つだけです" : "テストのパターンは 2 つ以上必要です",
    hint: kind === "single" ? "パターンを比べるときは、種別「テスト」のエクスペリエンスを作成してください" : "パターンを 2 つ以上にしてください",
  });
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
    summary: "エクスペリエンスを作成(編集者以上)。テストの既定は A パターン(オリジナル)/ B パターン(ID a / b、重み 50 / 50)、パーソナライズは A パターン(ID a、重み 100)を自動作成する",
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
    if ((await retiredIds(db, site.id)).has(body.id)) throw retiredIdTaken(body.id);
    assertName(body.name, ["name"]);
    if (body.description !== undefined) assertDescription(body.description, ["description"]);
    assertAnalyticsValues(body.analytics, null, ["analytics"]);
    const urlMatch = normalizedPageMatch(body.urlMatch, ["urlMatch"]);
    const targeting = normalizedTargeting(body.targeting ?? null, "experiment", "targeting");
    await assertTargetingRefs(db, site, targeting, "targeting");
    // 決定 51(設計書 §3.1): テストは A / B(50:50)、パーソナライズは A(重み 100)を 1 つ。
    // B77(K8、設計書 Q6): テストの A はオリジナル(元のページ)。パーソナライズはオリジナルを持たない
    const defaults =
      body.kind === "single"
        ? [{ id: "a", name: "A", weight: 100, original: 0 }]
        : [{ id: "a", name: "A", weight: 50, original: 1 }, { id: "b", name: "B", weight: 50, original: 0 }];
    assertExperimentAnalytics({ id: body.id, name: body.name, analytics: body.analytics ?? undefined }, defaults);
    const now = Date.now();
    const user = c.get("user").id;
    const row: ExperimentRow = {
      site_id: site.id,
      id: body.id,
      name: body.name,
      kind: body.kind,
      status: "draft",
      published_status: null,
      url_match_json: JSON.stringify(urlMatch),
      targeting_json: targeting ? JSON.stringify(targeting) : null,
      traffic_percentage: body.trafficPercentage,
      persist_assignment: body.persistAssignment ? 1 : 0,
      analytics_json: body.analytics ? JSON.stringify(body.analytics) : null,
      started_at: null,
      stopped_at: null,
      last_started_at: null,
      run_id: null,
      results_purged_at: null,
      description: body.description ?? "",
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
          defaults.map((v, i) => ({ site_id: site.id, experiment_id: row.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: null, original: v.original, description: "" })),
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
        ...variantJson(v),
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
    summary: "エクスペリエンスを更新(編集者以上)。id は不変、status は変更できない(status は /status で変更する)。メモ(description)だけの更新は状態にかかわらず可で、公開の対象にならない",
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
    if (body.description !== undefined) assertDescription(body.description, ["description"]);
    // B77(K9、設計書 Q26〜Q29): メモだけの更新は config に出ないので、updated_at / updated_by を進めない(未公開の印を付けない)。
    // 状態も問わない(終了したエクスペリエンスにも経緯を書ける)。外部計測の検査も、何も変わらないので通さない
    const keys = Object.keys(body);
    if (keys.length === 1 && keys[0] === "description") {
      await db.updateTable("experiments").set({ description: body.description }).where("site_id", "=", site.id).where("id", "=", exp.id).execute();
      const next: ExperimentRow = { ...exp, description: body.description! };
      return c.json(experimentJson(next, { unpublished: isUnpublished(next, site) }));
    }
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
    if (body.analytics !== undefined) {
      assertAnalyticsValues(body.analytics, parseExperimentAnalytics(exp) ?? null, ["analytics"]);
      set.analytics_json = body.analytics ? JSON.stringify(body.analytics) : null;
    }
    if (body.description !== undefined) set.description = body.description;
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
    summary: "エクスペリエンスを削除(編集者以上)。draft / archived のみ。一度開始したエクスペリエンスの ID は、削除した後もこのサイトでは作成・複製に使えない",
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
    // D9 ②(設計書 §6.3、K16): 一度開始した(started_at がある)ものは ID を退役させる。読んだ行ではなく D1 の中の行で判定し、
    // 削除と同じ batch = 1 トランザクションで書く(退役の記録だけ・削除だけが残らない)
    await c.env.DB.batch([
      toStatement(
        c.env,
        db
          .insertInto("retired_experiment_ids")
          .columns(["site_id", "experiment_id", "retired_at"])
          .expression((eb) =>
            eb
              .selectFrom("experiments")
              .select((s) => ["site_id", "id", s.val(Date.now()).as("retired_at")])
              .where("site_id", "=", site.id)
              .where("id", "=", exp.id)
              .where("started_at", "is not", null),
          )
          .onConflict((oc) => oc.doNothing()),
      ),
      toStatement(c.env, db.deleteFrom("experiments").where("site_id", "=", site.id).where("id", "=", exp.id)), // variants / changes は CASCADE
    ]);
    return c.body(null, 204);
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants",
  describeRoute({
    tags: ["experiments"],
    summary:
      "パターンの集合を全置換(編集者以上)。テストは 2 つ以上、パーソナライズは 1 つ。weight の合計 100。残るパターンの変更は保持される(オリジナルにしたパターンの変更は消す)。original / description を省いたパターンは保存済みの値を保つ。下書きのときだけ可",
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
        hint: "配信中または終了済みのエクスペリエンスのパターンは変更できません。複製して新しいエクスペリエンスを作成してください",
      });
    }
    const body = c.req.valid("json");
    const ids = new Set(body.map((v) => v.id));
    if (ids.size !== body.length) throw new ApiError(422, "duplicate_variant_id", { message: "パターン ID が重複しています" });
    assertVariantCount(exp.kind, body.length);
    const sum = body.reduce((a, v) => a + v.weight, 0);
    if (sum !== 100) throw new ApiError(422, "variant_weights_invalid", { message: `重みの合計は 100 である必要があります(現在 ${sum})`, sum });
    for (const v of body) {
      assertName(v.name, ["variants", v.id, "name"]);
      if (v.description !== undefined) assertDescription(v.description, ["variants", v.id, "description"]);
      // B77(K8、設計書 Q7): パーソナライズは選んだパターンを全員に見せるもので、元のページを見せるパターンは意味を持たない
      if (exp.kind === "single" && v.original === true)
        throw new ApiError(422, "original_not_allowed", {
          path: ["variants", v.id, "original"],
          message: "パーソナライズのパターンはオリジナルにできません",
          hint: "オリジナルはテストのパターンだけに使えます",
        });
    }
    // B77(K12): 比べる保存済みの値は同じ ID のパターンのもの(新しいパターンは null)
    const stored = new Map((await loadVariants(db, site.id, exp.id)).map((v) => [v.id, parseVariantAnalytics(v) ?? null]));
    for (const v of body) assertAnalyticsValues(v.analytics, stored.get(v.id) ?? null, ["variants", v.id, "analytics"]);
    assertExperimentAnalytics(
      { id: exp.id, name: exp.name, analytics: parseExperimentAnalytics(exp) },
      body.map((v) => ({ id: v.id, name: v.name, analytics: v.analytics ?? undefined })),
    );
    const now = Date.now();
    // 消える Variant の Change は CASCADE で消え、残る Variant の Change は保持される(id で突き合わせ)。
    // D1 batch で 1 トランザクション(途中で失敗しても集合が壊れない)
    const analyticsJson = (v: (typeof body)[number]) => (v.analytics ? JSON.stringify(v.analytics) : null);
    // B77(K8): original / description は指定したときだけ doUpdateSet に入れる。省いたら既存の行の値を保ち(読んで埋めない。
    // 読んでから書くまでに PATCH …/variants/:vid が書いたメモを古い値で潰さない)、新しい行は列の既定値と同じ 0 / '' で入る。
    // 1 文のバインドは最大 15(values 9 + doUpdateSet 6)で、D1 の上限 100 より十分小さい
    const flags = (v: (typeof body)[number]) => ({
      ...(v.original !== undefined ? { original: v.original ? 1 : 0 } : {}),
      ...(v.description !== undefined ? { description: v.description } : {}),
    });
    // オリジナルにしたパターンの変更は同じ batch で消す(設計書 Q5)。対象はこのエクスペリエンスのパターンだけ
    const originalIds = body.filter((v) => v.original === true).map((v) => v.id);
    await c.env.DB.batch([
      toStatement(c.env, db.deleteFrom("variants").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("id", "not in", [...ids])),
      ...body.map((v, i) =>
        toStatement(
          c.env,
          db
            .insertInto("variants")
            .values({ site_id: site.id, experiment_id: exp.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v), original: v.original ? 1 : 0, description: v.description ?? "" })
            .onConflict((oc) =>
              oc.columns(["site_id", "experiment_id", "id"]).doUpdateSet({ name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v), ...flags(v) }),
            ),
        ),
      ),
      ...(originalIds.length > 0
        ? [toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "in", originalIds))]
        : []),
      toStatement(c.env, db.updateTable("experiments").set({ updated_at: now, updated_by: c.get("user").id }).where("site_id", "=", site.id).where("id", "=", exp.id)),
    ]);
    return c.json({ ok: true });
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants/:vid/changes",
  describeRoute({
    tags: ["experiments"],
    summary:
      "パターンの変更を全置換(編集者以上)。1 件でも保存時検証に落ちれば何も書かない。オリジナルのパターンには変更を保存できない(空配列は受けて何もしない)",
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
      .select(["id", "original"])
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("id", "=", vid)
      .executeTakeFirst();
    if (!variant) throw notFound();
    const raw = c.req.valid("json");
    // B77(K8): オリジナルは変更を持たない。空配列は受けて何もしない(エージェントや deploy の途中の古い管理画面が全パターンに [] を送っても失敗させない)
    if (variant.original === 1) {
      if (raw.length === 0) return c.json({ ok: true, count: 0 });
      throw variantOriginal();
    }
    // 全件を検証してから書く(1 件でも不正なら何も書かない)
    const changes: Change[] = raw.map((r) => parseChange(c.env, site.id, r));
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
    const inserts = chunk(changeRows, 8).map((rows) => toStatement(c.env, db.insertInto("changes").values(rows)));
    const isOriginal = variantIsOriginal(site.id, exp.id, vid);
    const results = await c.env.DB.batch([
      toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "=", vid)),
      ...inserts,
      // B77(K8): 上の読みの後に同じパターンがオリジナルになっていたら(並行する PUT …/variants)、いま入れた変更を同じトランザクションで消す。
      // 最後はオリジナルに変更が残らない。消した行があれば 422 で返す(batch の後なのでロールバックにはならない)
      toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "=", vid).where(isOriginal)),
      // 拒否になる保存は親の帳簿(未公開の印と更新者)を変えない
      toStatement(
        c.env,
        db
          .updateTable("experiments")
          .set({ updated_at: now, updated_by: user })
          .where("site_id", "=", site.id)
          .where("id", "=", exp.id)
          .where((eb) => eb.not(isOriginal(eb))),
      ),
    ]);
    if ((results[1 + inserts.length]?.meta.changes ?? 0) > 0) throw variantOriginal();
    return c.json({ ok: true, count: changes.length });
  },
);

// B77(K9、設計書 Q26〜Q29): パターンのメモ。config に出ないので状態を問わず受け、親の updated_at / updated_by を進めない
experimentRoutes.patch(
  "/sites/:sid/experiments/:eid/variants/:vid",
  describeRoute({
    tags: ["experiments"],
    summary: "パターンのメモを更新(編集者以上)。状態にかかわらず可。公開の対象にならない",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のパターン", content: { "application/json": { schema: resolver(VariantJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", VariantPatch, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const { description } = c.req.valid("json");
    assertDescription(description, ["description"]);
    const row = await db
      .updateTable("variants")
      .set({ description })
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("id", "=", c.req.param("vid"))
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound();
    return c.json(variantJson(row));
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
    summary: "エクスペリエンスの status を遷移する(管理者以上)。成功した遷移は必ずサイトを自動公開する。結果を記録しないテストを開始したときは warnings で知らせる",
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
    // D9 ②(plan ② の K14、設計書 §5.2・§6.3): 開始(draft → running)のテストで、Site が結果を記録し計測用 D1 があるときだけ run_id を振る。
    // 再開(paused → running)では振らない(run_id の無いまま一時停止していたテストも再開はできる)。
    // `where run_id is null` は付けない: draft → running は 1 回だけで、下の status の CAS が二重の発行を防ぐ
    const starting = exp.status === "draft" && body.status === "running";
    const isTest = exp.kind === "test";
    const issue = starting && isTest && exp.run_id === null && site.results_enabled === 1 && resultsStore(c.env);
    const warnings = starting && isTest && !issue ? [RESULTS_NOT_RECORDED] : [];
    const stamps = {
      ...(body.status === "running" && exp.started_at === null ? { started_at: now } : {}),
      // 決定 51(K5、2026-10-06 ユーザー決定): 配信に入った時刻。開始・再開のたびに更新し、テストどうしの優先の順に使う
      ...(body.status === "running" ? { last_started_at: now } : {}),
      ...(body.status === "archived" ? { stopped_at: now } : {}),
      ...(issue ? { run_id: newRunId() } : {}),
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
    return c.json({ experiment: experimentJson(fresh, { unpublished: isUnpublished(fresh, freshSite) }), publish: publicPublishResult(publish), warnings });
  },
);

/**
 * 決定 51(設計書 §4.1): 複製(編集者以上。下書きを作るだけで公開しないため)。元の状態は問わず、元には何も書かない。
 * 写さないもの: 状態(いつも draft)・開始 / 終了の時刻・公開の履歴・結果の記録の ID(run_id。D9 ②)
 */
experimentRoutes.post(
  "/sites/:sid/experiments/:eid/duplicate",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを複製して下書きを作る(編集者以上)。元のエクスペリエンスは変わらない。パーソナライズの元は mode = same だけ",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成した下書き", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", DuplicateBody, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const src = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    if (body.mode === "variant" && src.kind === "single")
      throw new ApiError(422, "duplicate_mode_not_allowed", {
        message: "パーソナライズのエクスペリエンスは「同じ内容」でだけ複製できます",
        hint: "mode を same にしてください",
      });
    const variants = await loadVariants(db, site.id, src.id);
    const picked = body.mode === "variant" ? variants.find((v) => v.id === body.variantId) : undefined;
    if (body.mode === "variant" && !picked)
      throw new ApiError(422, "unknown_variant", { path: ["variantId"], message: "指定したパターンがこのエクスペリエンスにありません" });
    // B77(K8): オリジナルは元のページそのもので、パーソナライズにしても何も表示しない
    if (picked?.original === 1)
      throw new ApiError(422, "duplicate_original_variant", {
        path: ["variantId"],
        message: "オリジナルのパターンはパーソナライズに複製できません",
        hint: "変更のあるパターンを選んでください",
      });
    const idTaken = (id: string) => new ApiError(409, "id_taken", { id, message: "このエクスペリエンス ID は既に使われています", hint: "別の ID を指定してください" });
    const allTaken = () => new ApiError(409, "id_taken", { message: "複製の ID の候補がすべて使われています", hint: "使っていない複製を削除してから、もう一度複製してください(API では id を指定できます)" });
    // 使われている ID に、一度開始してから削除した ID を足して判定する(D9 ②、K16)
    const freeId = async (): Promise<string | undefined> => {
      const taken = await retiredIds(db, site.id);
      for (const r of await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).execute()) taken.add(r.id);
      return duplicateIdCandidates(src.id).find((x) => !taken.has(x));
    };
    if (body.id !== undefined && (await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst())) throw idTaken(body.id);
    if (body.id !== undefined && (await retiredIds(db, site.id)).has(body.id)) throw retiredIdTaken(body.id);
    const firstId = body.id ?? (await freeId());
    if (firstId === undefined) throw allTaken();
    const name = body.name ?? duplicateName(body.mode, src.name, picked?.name);
    assertName(name, ["name"]);
    const user = c.get("user").id;
    const kept = body.mode === "variant" ? [picked!] : variants; // 外部計測の名前の検査に使う(写すのは batch の中の INSERT … SELECT)
    const isUniqueViolation = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));
    /** エクスペリエンス・パターン・変更を 1 batch = 1 トランザクションの 3 文で書く(片方だけ残らない。パターンと変更は元の行から INSERT … SELECT)。
     *  3 文とも「元が読んだ版のまま」のときだけ書くので、読んだ設定・検査と写す中身はいつも同じ版になる */
    const write = async (id: string): Promise<ExperimentRow> => {
      const o = { siteId: site.id, sourceId: src.id, mode: body.mode, variantId: body.variantId, id, name, user, now: Date.now(), sourceUpdatedAt: src.updated_at };
      const row = duplicateExperimentRow(src, o);
      assertExperimentAnalytics(
        { id: row.id, name: row.name, analytics: parseExperimentAnalytics(row) },
        kept.map((v) => ({ id: v.id, name: v.name, analytics: parseVariantAnalytics(v) })),
      );
      const results = await c.env.DB.batch([
        toStatement(c.env, insertExperimentQuery(db, row, o)),
        toStatement(c.env, copyVariantsQuery(db, o)),
        toStatement(c.env, copyChangesQuery(db, o)),
      ]);
      // 読んだ後に元が編集・削除された(3 文とも 0 行で、何も残っていない)。版の混ざった下書きやパターン 0 個の下書きを作らない
      if ((results[0]?.meta.changes ?? 0) === 0)
        throw new ApiError(409, "duplicate_source_changed", { message: "複製の元のエクスペリエンスが、複製の途中で変更されました", hint: "もう一度複製してください" });
      return row;
    };
    let row: ExperimentRow;
    try {
      row = await write(firstId);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (body.id !== undefined) throw idTaken(body.id); // 調べてから書くまでの間に同じ ID が作られた
      // 自動の ID が同時の複製と衝突した。空いている次の候補で 1 回だけやり直す
      const retryId = await freeId();
      if (retryId === undefined) throw allTaken();
      try {
        row = await write(retryId);
      } catch (e2) {
        if (isUniqueViolation(e2)) throw new ApiError(409, "id_taken", { message: "複製の ID が同時の操作と重なりました", hint: "もう一度複製してください" });
        throw e2;
      }
    }
    return c.json(experimentJson(row, { unpublished: true }), 201);
  },
);
