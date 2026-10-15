import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { TargetingInputSchema, targetingReferences } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import type { AudienceRow, Db, ExperimentRow } from "../db";
import { ApiError, notFound } from "../errors";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { loadSite } from "../roles";
import { assertTargetingRefs, normalizedTargeting, targetingValidationFailed, touchSite } from "../validation";

/**
 * 決定 49(設計書 §5): オーディエンス = Site ごとの名前付きの条件。エクスペリエンスの配信条件から `{ "audience": id }` で参照し、
 * Publish がその時点の定義に展開する。編集は次の Publish で参照するすべてのエクスペリエンスに効く。権限は Goal と同じ
 */
export const audienceRoutes = new Hono<AppEnv>();

const STATUSES = ["draft", "running", "paused", "archived"] as const;
const Definition = TargetingInputSchema.describe(
  "オーディエンスの条件(配信条件と同じ DSL。and / or / not の入れ子を一番外側の中に 4 段まで使える。{ \"audience\": … } は使えない)。保存する値は正規化した後のもの",
);
const Name = z.string().min(1).max(100);
const Description = z.string().max(500);
const AudienceCreate = z.strictObject({
  // new は管理画面の新規作成の画面(/audiences/new)と重なるので予約する(plan ② P19)。ほかの ID の検査と同じ 422 validation_failed
  id: z
    .string()
    .regex(SLUG_RE)
    .refine((v) => v !== "new", { message: "new は新規作成の画面と重なるので ID に使えません" })
    .describe("サイト内で一意。作成後は変えられない"),
  name: Name,
  description: Description.default(""),
  definition: Definition,
});
const AudiencePatch = z.strictObject({ name: Name.optional(), description: Description.optional(), definition: Definition.optional() });
const UsedBySchema = z
  .array(z.object({ id: z.string(), name: z.string(), status: z.enum(STATUSES) }))
  .describe("このオーディエンスを配信条件で参照しているエクスペリエンス(状態を問わずすべて)");
const AudienceJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: Definition,
  usedBy: UsedBySchema,
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});

export type AudienceUsage = Map<string, Array<{ id: string; name: string; status: ExperimentRow["status"] }>>;

/** オーディエンス id → それを配信条件で参照しているエクスペリエンス(状態を問わずすべて。作成順)。古い書式の行でも落ちない */
export async function audienceUsage(db: Db, siteId: string): Promise<AudienceUsage> {
  const rows = await db
    .selectFrom("experiments")
    .select(["id", "name", "status", "targeting_json"])
    .where("site_id", "=", siteId)
    .where("targeting_json", "is not", null)
    .orderBy("created_at")
    .execute();
  const out: AudienceUsage = new Map();
  for (const r of rows) {
    for (const a of targetingReferences(JSON.parse(r.targeting_json!)).audiences) {
      const list = out.get(a) ?? [];
      list.push({ id: r.id, name: r.name, status: r.status });
      out.set(a, list);
    }
  }
  return out;
}

function audienceJson(row: AudienceRow, usage: AudienceUsage) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition_json),
    usedBy: usage.get(row.id) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadAudience(db: Db, siteId: string, aid: string): Promise<AudienceRow> {
  const row = await db.selectFrom("audiences").selectAll().where("site_id", "=", siteId).where("id", "=", aid).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

audienceRoutes.get(
  "/sites/:sid/audiences",
  describeRoute({
    tags: ["audiences"],
    summary: "サイトのオーディエンス一覧(閲覧者以上)。参照しているエクスペリエンス(usedBy)を含む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "オーディエンス一覧", content: { "application/json": { schema: resolver(z.array(AudienceJsonSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const rows = await db.selectFrom("audiences").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    const usage = await audienceUsage(db, site.id);
    return c.json(rows.map((r) => audienceJson(r, usage)));
  },
);

audienceRoutes.post(
  "/sites/:sid/audiences",
  describeRoute({
    tags: ["audiences"],
    summary: "オーディエンスを作成(編集者以上)。定義は正規化して保存し、参照する目標の存在と、期間が訪問者データの保存期間以下であることを検査する",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成したオーディエンス", content: { "application/json": { schema: resolver(AudienceJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", AudienceCreate, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "definition");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const body = c.req.valid("json");
    const db = c.get("db");
    if (await db.selectFrom("audiences").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst())
      throw new ApiError(409, "id_taken", { message: "この ID は既に使われています", hint: "別の ID を指定してください" });
    const definition = normalizedTargeting(body.definition, "audience", "definition")!;
    await assertTargetingRefs(db, site, definition, "definition");
    const now = Date.now();
    const row: AudienceRow = { site_id: site.id, id: body.id, name: body.name, description: body.description, definition_json: JSON.stringify(definition), created_at: now, updated_at: now };
    await db.insertInto("audiences").values(row).execute();
    await touchSite(db, site.id, now);
    return c.json(audienceJson(row, new Map()), 201);
  },
);

audienceRoutes.get(
  "/sites/:sid/audiences/:aid",
  describeRoute({
    tags: ["audiences"],
    summary: "オーディエンスを 1 件取得(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "オーディエンス", content: { "application/json": { schema: resolver(AudienceJsonSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const row = await loadAudience(db, site.id, c.req.param("aid"));
    return c.json(audienceJson(row, await audienceUsage(db, site.id)));
  },
);

audienceRoutes.patch(
  "/sites/:sid/audiences/:aid",
  describeRoute({
    tags: ["audiences"],
    summary: "オーディエンスを更新(編集者以上)。id は不変。定義の変更は次の公開で、参照するすべてのエクスペリエンスに効く",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のオーディエンス", content: { "application/json": { schema: resolver(AudienceJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", AudiencePatch, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "definition");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const row = await loadAudience(db, site.id, c.req.param("aid"));
    const body = c.req.valid("json");
    const now = Date.now();
    const patch: Partial<AudienceRow> = { updated_at: now };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.definition !== undefined) {
      const definition = normalizedTargeting(body.definition, "audience", "definition")!;
      await assertTargetingRefs(db, site, definition, "definition");
      patch.definition_json = JSON.stringify(definition);
    }
    await db.updateTable("audiences").set(patch).where("site_id", "=", site.id).where("id", "=", row.id).execute();
    await touchSite(db, site.id, now);
    return c.json(audienceJson({ ...row, ...patch }, await audienceUsage(db, site.id)));
  },
);

audienceRoutes.delete(
  "/sites/:sid/audiences/:aid",
  describeRoute({
    tags: ["audiences"],
    summary: "オーディエンスを削除(編集者以上)。参照しているエクスペリエンスがあれば 409(状態を問わず)",
    security: [{ bearer: [] }],
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409) },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const row = await loadAudience(db, site.id, c.req.param("aid"));
    const users = (await audienceUsage(db, site.id)).get(row.id) ?? [];
    if (users.length > 0)
      throw new ApiError(409, "audience_in_use", {
        experiments: users.map((u) => u.id),
        message: "このオーディエンスはエクスペリエンスから参照されています",
        hint: `参照しているエクスペリエンス: ${users.map((u) => u.name).join("、")}。配信条件から外してから削除してください`,
      });
    await db.deleteFrom("audiences").where("site_id", "=", site.id).where("id", "=", row.id).execute();
    await touchSite(db, site.id, Date.now());
    return c.body(null, 204);
  },
);
