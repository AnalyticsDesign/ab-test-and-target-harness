import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { GoalInputSchema, targetingReferences } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import type { Db } from "../db";
import { ApiError, notFound, validationFailed } from "../errors";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { loadSite } from "../roles";
import { goalJson } from "../serialize";
import { assertName, normalizedPageMatch, touchSite } from "../validation";

export const goalRoutes = new Hono<AppEnv>();

/** core の Goal(id / name / type / config)に、control 固有の id スラッグ規則を足す */
const GoalCreate = GoalInputSchema.superRefine((v, ctx) => {
  if (!SLUG_RE.test(v.id)) ctx.addIssue({ code: "custom", path: ["id"], message: "id must match slug rule" });
});
const GoalPatch = z.strictObject({ name: z.string().min(1).optional(), config: z.unknown().optional() });

const GoalJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["PAGEVIEW", "CLICK", "CUSTOM"]),
  config: z.unknown(),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});

/**
 * Goal の参照(削除の保護用。設計書 §5.3): エクスペリエンスの配信条件(archived / draft を含むすべて)と、オーディエンスの定義
 * (エクスペリエンスから使われていないものも含むすべて)。audiences は Goal id → 参照しているオーディエンスの名前
 */
export async function goalReferences(db: Db, siteId: string): Promise<{ experiments: Set<string>; audiences: Map<string, string[]> }> {
  const experiments = new Set<string>();
  const rows = await db.selectFrom("experiments").select("targeting_json").where("site_id", "=", siteId).where("targeting_json", "is not", null).execute();
  for (const r of rows) for (const g of targetingReferences(JSON.parse(r.targeting_json!)).goals) experiments.add(g);
  const audiences = new Map<string, string[]>();
  const defs = await db.selectFrom("audiences").select(["name", "definition_json"]).where("site_id", "=", siteId).execute();
  for (const a of defs) for (const g of targetingReferences(JSON.parse(a.definition_json)).goals) audiences.set(g, [...(audiences.get(g) ?? []), a.name]);
  return { experiments, audiences };
}

goalRoutes.get(
  "/sites/:sid/goals",
  describeRoute({
    tags: ["goals"],
    summary: "サイトの目標一覧(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "目標一覧", content: { "application/json": { schema: resolver(z.array(GoalJsonSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const rows = await c.get("db").selectFrom("goals").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    return c.json(rows.map(goalJson));
  },
);

goalRoutes.post(
  "/sites/:sid/goals",
  describeRoute({
    tags: ["goals"],
    summary: "目標を作成(編集者以上)。config は type ごとに検証し、PAGEVIEW のページの一致は正規化して保存(core の GoalInputSchema)",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成した目標", content: { "application/json": { schema: resolver(GoalJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", GoalCreate, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const body = c.req.valid("json");
    assertName(body.name, ["name"]);
    const config = body.type === "PAGEVIEW" ? { page: normalizedPageMatch(body.config.page, ["config", "page"]) } : body.config;
    const db = c.get("db");
    if (await db.selectFrom("goals").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst())
      throw new ApiError(409, "id_taken", { message: "この ID は既に使われています", hint: "別の ID を指定してください" });
    const now = Date.now();
    const row = { site_id: site.id, id: body.id, name: body.name, type: body.type, config_json: JSON.stringify(config), created_at: now, updated_at: now };
    await db.insertInto("goals").values(row).execute();
    await touchSite(db, site.id, now);
    return c.json(goalJson(row), 201);
  },
);

/** Goal の `type` は作成後不変(PATCH は name / config のみ受理。strictObject が他のキーを 422 で弾く) */
goalRoutes.patch(
  "/sites/:sid/goals/:gid",
  describeRoute({
    tags: ["goals"],
    summary: "目標を更新(編集者以上)。name / config のみ。type は不変",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後の目標", content: { "application/json": { schema: resolver(GoalJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", GoalPatch, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const row = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).where("id", "=", c.req.param("gid")).executeTakeFirst();
    if (!row) throw notFound();
    const body = c.req.valid("json");
    const merged = GoalInputSchema.safeParse({ id: row.id, name: body.name ?? row.name, type: row.type, config: body.config ?? JSON.parse(row.config_json) });
    if (!merged.success) throw validationFailed(merged.error);
    assertName(merged.data.name, ["name"]);
    const config = merged.data.type === "PAGEVIEW" ? { page: normalizedPageMatch(merged.data.config.page, ["config", "page"]) } : merged.data.config;
    const now = Date.now();
    // 書き戻すのは PATCH で変わり得る列だけ(全列 `set(row)` は rulings #14 が sites で禁じた形。rulings §4 CX-Medium-2)
    const patch = { name: merged.data.name, config_json: JSON.stringify(config), updated_at: now };
    await db.updateTable("goals").set(patch).where("site_id", "=", site.id).where("id", "=", row.id).execute();
    await touchSite(db, site.id, now);
    return c.json(goalJson({ ...row, ...patch }));
  },
);

goalRoutes.delete(
  "/sites/:sid/goals/:gid",
  describeRoute({
    tags: ["goals"],
    summary: "目標を削除(編集者以上)。参照するエクスペリエンスかオーディエンスがあれば 409",
    security: [{ bearer: [] }],
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409) },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const gid = c.req.param("gid");
    const db = c.get("db");
    if (!(await db.selectFrom("goals").select("id").where("site_id", "=", site.id).where("id", "=", gid).executeTakeFirst())) throw notFound();
    const refs = await goalReferences(db, site.id);
    const fromAudiences = refs.audiences.get(gid) ?? [];
    if (refs.experiments.has(gid) || fromAudiences.length > 0)
      throw new ApiError(409, "goal_in_use", {
        ...(fromAudiences.length > 0 ? { audiences: fromAudiences } : {}),
        message: "この目標はエクスペリエンスの配信条件かオーディエンスから参照されています",
        hint:
          fromAudiences.length > 0
            ? `参照しているオーディエンス: ${fromAudiences.join("、")}。参照を外してから削除してください`
            : "参照するエクスペリエンスの配信条件を外してから削除してください",
      });
    await db.deleteFrom("goals").where("site_id", "=", site.id).where("id", "=", gid).execute();
    await touchSite(db, site.id, Date.now());
    return c.body(null, 204);
  },
);
