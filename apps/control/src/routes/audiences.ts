import { Hono, type Context } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { expressionBuilder, sql, type ExpressionBuilder } from "kysely";
import { z } from "zod";
import { TargetingInputSchema, targetingReferences } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { auditActor, auditChanged, auditStatement, changedFieldsDetail, sameJsonText, unchangedValues, type AuditDetail, type AuditFieldChange, type AuditSql } from "../audit";
import { toStatement, type AudienceRow, type Db, type ExperimentRow, type SiteRow, type Tables } from "../db";
import { ApiError, notFound } from "../errors";
import { SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { loadSite } from "../roles";
import { archivedTestsHint } from "../test-locks";
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

/**
 * B129(spec §3.1 の区分 content): オーディエンスの記録。目標と同じ形(1 文の execute を `env.DB.batch([操作, 記録])` に。往復は 1 回のまま。
 * 作成は insert の後、変更・削除は操作の文の前に、操作の文と同じ条件(thisAudience)の targetFrom で置く)
 */
const thisAudience = (siteId: string, aid: string) => (eb: ExpressionBuilder<Tables, "audiences">) => eb.and([eb("site_id", "=", siteId), eb("id", "=", aid)]);
function audienceAudit(
  c: Context<AppEnv>,
  site: Pick<SiteRow, "id" | "workspace_id">,
  aid: string,
  action: "audience.create" | "audience.update" | "audience.delete",
  detail: AuditDetail | AuditSql,
  label?: string,
) {
  const event =
    label !== undefined
      ? { target: { type: "audience" as const, id: aid, label } }
      : {
          target: { type: "audience" as const },
          // 変更の記録は今の値(name・description・definition_json)を t から読んで比べる
          targetFrom: sql`select id as target_id, name as target_label, name, description, definition_json from audiences where ${thisAudience(site.id, aid)(expressionBuilder<Tables, "audiences">())}`,
        };
  return auditStatement(c.env.DB, auditActor(c), { action, workspaceId: site.workspace_id, siteId: site.id, detail, ...event });
}
/**
 * オーディエンスの PATCH の欄(記録の detail.fields の順)と比べる列。名前だけで値は持たない(定義の中身も持たない)。
 * json = 鍵の順を問わずに読んだ行と比べる。B129 final review(R64): 記録するのは値が変わった欄だけ
 */
const AUDIENCE_PATCH_FIELDS = [
  { key: "name", col: "name" },
  { key: "description", col: "description" },
  { key: "definition", col: "definition_json", json: true },
] as const satisfies ReadonlyArray<{ key: string; col: keyof AudienceRow; json?: true }>;

export type AudienceUsage = Map<string, Array<{ id: string; name: string; status: ExperimentRow["status"]; kind: ExperimentRow["kind"] }>>;

/** オーディエンス id → それを配信条件で参照しているエクスペリエンス(状態を問わずすべて。作成順)。古い書式の行でも落ちない */
export async function audienceUsage(db: Db, siteId: string): Promise<AudienceUsage> {
  const rows = await db
    .selectFrom("experiments")
    .select(["id", "name", "status", "kind", "targeting_json"])
    .where("site_id", "=", siteId)
    .where("targeting_json", "is not", null)
    .orderBy("created_at")
    .execute();
  const out: AudienceUsage = new Map();
  for (const r of rows) {
    for (const a of targetingReferences(JSON.parse(r.targeting_json!)).audiences) {
      const list = out.get(a) ?? [];
      list.push({ id: r.id, name: r.name, status: r.status, kind: r.kind });
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
    usedBy: (usage.get(row.id) ?? []).map((u) => ({ id: u.id, name: u.name, status: u.status })),
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
    await c.env.DB.batch([toStatement(c.env, db.insertInto("audiences").values(row)), audienceAudit(c, site, row.id, "audience.create", {}, row.name)]);
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
    // 送った欄のうち、書く値(patch)が記録の文の中の今の行(t)と違う欄だけを記録する(変わらなければ fields: []。updated_at は進む)
    const changes: AuditFieldChange[] = AUDIENCE_PATCH_FIELDS.filter((f) => body[f.key] !== undefined).map((f) => ({
      key: f.key,
      changed: auditChanged(sql`t.${sql.ref(f.col)}`, unchangedValues(patch[f.col] ?? null, row[f.col], "json" in f ? sameJsonText : undefined)),
    }));
    await c.env.DB.batch([audienceAudit(c, site, row.id, "audience.update", changedFieldsDetail(changes)), toStatement(c.env, db.updateTable("audiences").set(patch).where(thisAudience(site.id, row.id)))]);
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
    if (users.length > 0) {
      // D9 ③(K10): 終了したテストは読み取り専用で配信条件を外せないので、外せるものと分けて案内する(行き止まりの案内にしない)。
      // 終了したテストの参照も数えるのは、複製や下書きの組み立てが終了したテストの配信条件をそのまま使うため
      const archived = users.filter((u) => u.kind === "test" && u.status === "archived");
      const editable = users.filter((u) => !(u.kind === "test" && u.status === "archived"));
      const hints = [
        ...(editable.length > 0 ? [`参照しているエクスペリエンス: ${editable.map((u) => u.name).join("、")}。配信条件から外してから削除してください`] : []),
        ...(archived.length > 0 ? [archivedTestsHint(archived.map((u) => u.name))] : []),
      ];
      throw new ApiError(409, "audience_in_use", {
        experiments: users.map((u) => u.id),
        ...(archived.length > 0 ? { archivedTests: archived.map((u) => u.id) } : {}),
        message: "このオーディエンスはエクスペリエンスから参照されています",
        hint: hints.join("。"),
      });
    }
    await c.env.DB.batch([audienceAudit(c, site, row.id, "audience.delete", {}), toStatement(c.env, db.deleteFrom("audiences").where(thisAudience(site.id, row.id)))]);
    await touchSite(db, site.id, Date.now());
    return c.body(null, 204);
  },
);
