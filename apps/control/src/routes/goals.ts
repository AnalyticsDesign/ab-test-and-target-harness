import { Hono, type Context } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { expressionBuilder, sql, type ExpressionBuilder } from "kysely";
import { z } from "zod";
import { GoalAnalyticsRequestSchema, GoalAnalyticsSchema, GoalInputSchema, targetingReferences, type GoalAnalytics } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { auditActor, auditChanged, auditStatement, changedFieldsDetail, sameJsonText, unchangedValues, type AuditDetail, type AuditFieldChange, type AuditSql } from "../audit";
import { toStatement, type Db, type GoalRow, type SiteRow, type Tables } from "../db";
import { ApiError, notFound, validationFailed } from "../errors";
import { isReservedId, reservedIdMessage, SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { loadSite } from "../roles";
import { goalJson } from "../serialize";
import { archivedTestsHint } from "../test-locks";
import { GOAL_ANALYTICS_REQUEST_DESCRIPTION, assertAnalyticsValues, assertName, normalizedPageMatch, touchSite } from "../validation";

export const goalRoutes = new Hono<AppEnv>();

/**
 * B77(K12): 受け口の analytics は値を文字列として受けるだけ(キーの規則と strict は同じ)。値の検査は assertAnalyticsValues。
 * 作成で null は指定なし、PATCH で null は消す
 */
const GoalAnalyticsRequest = GoalAnalyticsRequestSchema.nullable().describe(GOAL_ANALYTICS_REQUEST_DESCRIPTION);
const [pageviewInput, clickInput, customInput] = GoalInputSchema.options;
/** core の Goal(id / name / type / config / analytics)の analytics を受け口の形に差し替え、control 固有の id スラッグ規則を足す */
const GoalCreate = z
  .discriminatedUnion("type", [
    pageviewInput.extend({ analytics: GoalAnalyticsRequest.optional() }),
    clickInput.extend({ analytics: GoalAnalyticsRequest.optional() }),
    customInput.extend({ analytics: GoalAnalyticsRequest.optional() }),
  ])
  .superRefine((v, ctx) => {
    if (!SLUG_RE.test(v.id)) ctx.addIssue({ code: "custom", path: ["id"], message: "id must match slug rule" });
    // constructor など Object.prototype の名前は、設置タグが配る設定を目標 ID で引くときに取り違えるので使わせない(B136)
    else if (isReservedId(v.id)) ctx.addIssue({ code: "custom", path: ["id"], message: reservedIdMessage(v.id) });
  });
const GoalPatch = z.strictObject({ name: z.string().min(1).optional(), config: z.unknown().optional(), analytics: GoalAnalyticsRequest.optional() });

/**
 * B129(spec §3.1 の区分 content): 目標の記録。1 文の execute だった書き込みを `env.DB.batch([操作, 記録])` にする(往復は 1 回のまま)。
 * 作成は insert の後(無条件)、変更・削除は操作の文の前に、操作の文と同じ条件(thisGoal)の targetFrom で置く(0 行なら記録しない)
 */
const thisGoal = (siteId: string, gid: string) => (eb: ExpressionBuilder<Tables, "goals">) => eb.and([eb("site_id", "=", siteId), eb("id", "=", gid)]);
function goalAudit(c: Context<AppEnv>, site: Pick<SiteRow, "id" | "workspace_id">, gid: string, action: "goal.create" | "goal.update" | "goal.delete", detail: AuditDetail | AuditSql, label?: string) {
  const event =
    label !== undefined
      ? { target: { type: "goal" as const, id: gid, label } }
      : {
          target: { type: "goal" as const },
          // 変更の記録は今の値(name・config_json・analytics_json)を t から読んで比べる
          targetFrom: sql`select id as target_id, name as target_label, name, config_json, analytics_json from goals where ${thisGoal(site.id, gid)(expressionBuilder<Tables, "goals">())}`,
        };
  return auditStatement(c.env.DB, auditActor(c), { action, workspaceId: site.workspace_id, siteId: site.id, detail, ...event });
}
/**
 * 目標の PATCH の欄(記録の detail.fields の順)と比べる列。名前だけで値は持たない。json = 鍵の順を問わずに読んだ行と比べる。
 * B129 final review(R64): 記録するのは値が変わった欄だけ
 */
const GOAL_PATCH_FIELDS = [
  { key: "name", col: "name" },
  { key: "config", col: "config_json", json: true },
  { key: "analytics", col: "analytics_json", json: true },
] as const satisfies ReadonlyArray<{ key: keyof z.infer<typeof GoalPatch>; col: keyof GoalRow; json?: true }>;

const parseGoalAnalytics = (json: string | null): GoalAnalytics | null => (json ? (JSON.parse(json) as GoalAnalytics) : null);

const GoalJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["PAGEVIEW", "CLICK", "CUSTOM"]),
  config: z.unknown(),
  analytics: GoalAnalyticsSchema.nullable().describe("外部計測(dataLayer に出す目標名の指定)。指定が無ければ null"),
  runningTests: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .describe("この目標を配信条件(使っているオーディエンスを含む)か評価計画(判定に使う目標)で参照している、実行中・一時停止中のテスト(作成順)。目標の定義を変えると、次の公開でこれらのテストに効く"),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});

/**
 * Goal の参照(削除の保護用。設計書 §5.3): エクスペリエンスの配信条件(archived / draft を含むすべて)と、オーディエンスの定義
 * (エクスペリエンスから使われていないものも含むすべて)。audiences は Goal id → 参照しているオーディエンスの名前。
 * plans = 下書き・実行中・一時停止中のテストの評価計画が判定に使う目標(D9 ③ Task 5、設計書 §9.1)。終了したテストの計画は数えない
 * (結果の記録が目標の名前を写すので、削除しても読める)
 */
export async function goalReferences(
  db: Db,
  siteId: string,
): Promise<{ experiments: Set<string>; archivedTests: Map<string, Array<{ id: string; name: string }>>; audiences: Map<string, string[]>; plans: Set<string> }> {
  // experiments = 配信条件を外せるエクスペリエンスからの参照。archivedTests = 終了したテストからの参照(D9 ③ の K10 で読み取り専用。
  // 配信条件を外せないので、削除の案内を分ける)。どちらも削除を止める
  const experiments = new Set<string>();
  const archivedTests = new Map<string, Array<{ id: string; name: string }>>();
  const rows = await db
    .selectFrom("experiments")
    .select(["id", "name", "kind", "status", "targeting_json"])
    .where("site_id", "=", siteId)
    .where("targeting_json", "is not", null)
    .orderBy("created_at")
    .execute();
  for (const r of rows) {
    const archived = r.kind === "test" && r.status === "archived";
    for (const g of targetingReferences(JSON.parse(r.targeting_json!)).goals) {
      if (archived) archivedTests.set(g, [...(archivedTests.get(g) ?? []), { id: r.id, name: r.name }]);
      else experiments.add(g);
    }
  }
  const audiences = new Map<string, string[]>();
  const defs = await db.selectFrom("audiences").select(["name", "definition_json"]).where("site_id", "=", siteId).execute();
  for (const a of defs) for (const g of targetingReferences(JSON.parse(a.definition_json)).goals) audiences.set(g, [...(audiences.get(g) ?? []), a.name]);
  const plans = new Set<string>();
  const planRows = await db
    .selectFrom("evaluation_plans as p")
    .innerJoin("experiments as e", (j) => j.onRef("e.site_id", "=", "p.site_id").onRef("e.id", "=", "p.experiment_id"))
    .select("p.plan_json")
    .where("p.site_id", "=", siteId)
    .where("e.status", "in", ["draft", "running", "paused"])
    .execute();
  for (const r of planRows) {
    const goal = (JSON.parse(r.plan_json) as { primaryGoalId?: unknown }).primaryGoalId;
    if (typeof goal === "string") plans.add(goal);
  }
  return { experiments, archivedTests, audiences, plans };
}

export type GoalRunningTests = Map<string, Array<{ id: string; name: string }>>;

/**
 * D9 ③(K10、設計書 §5.5): 目標 id → それを参照している実行中・一時停止中のテスト(作成順・重複なし)。
 * 参照は配信条件(使っているオーディエンスの定義を展開した分を含む)と、評価計画の判定に使う目標。パーソナライズ・下書き・終了したテストは数えない
 * (保存の確認に「参照している実行中のテスト」の件数を出すため)
 */
export async function goalRunningTests(db: Db, siteId: string): Promise<GoalRunningTests> {
  const rows = await db
    .selectFrom("experiments as e")
    .leftJoin("evaluation_plans as p", (j) => j.onRef("p.site_id", "=", "e.site_id").onRef("p.experiment_id", "=", "e.id"))
    .select(["e.id", "e.name", "e.targeting_json", "p.plan_json"])
    .where("e.site_id", "=", siteId)
    .where("e.kind", "=", "test")
    .where("e.status", "in", ["running", "paused"])
    .orderBy("e.created_at")
    .orderBy("e.id")
    .execute();
  // オーディエンス id → その定義が参照する目標(オーディエンスはオーディエンスを参照できないので 1 段で足りる)
  const audienceGoals = new Map<string, string[]>();
  const defs = await db.selectFrom("audiences").select(["id", "definition_json"]).where("site_id", "=", siteId).execute();
  for (const a of defs) audienceGoals.set(a.id, targetingReferences(JSON.parse(a.definition_json)).goals);
  const out: GoalRunningTests = new Map();
  for (const r of rows) {
    const refs = r.targeting_json ? targetingReferences(JSON.parse(r.targeting_json)) : { goals: [], audiences: [] };
    const goals = new Set([...refs.goals, ...refs.audiences.flatMap((a) => audienceGoals.get(a) ?? [])]);
    const primary = r.plan_json ? (JSON.parse(r.plan_json) as { primaryGoalId?: unknown }).primaryGoalId : undefined;
    if (typeof primary === "string") goals.add(primary);
    for (const g of goals) out.set(g, [...(out.get(g) ?? []), { id: r.id, name: r.name }]);
  }
  return out;
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
    const db = c.get("db");
    const rows = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    const running = await goalRunningTests(db, site.id);
    return c.json(rows.map((r) => goalJson(r, running.get(r.id) ?? [])));
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
    assertAnalyticsValues(body.analytics, null, ["analytics"]);
    const config = body.type === "PAGEVIEW" ? { page: normalizedPageMatch(body.config.page, ["config", "page"]) } : body.config;
    const db = c.get("db");
    if (await db.selectFrom("goals").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst())
      throw new ApiError(409, "id_taken", { message: "この ID は既に使われています", hint: "別の ID を指定してください" });
    const now = Date.now();
    const row = { site_id: site.id, id: body.id, name: body.name, type: body.type, config_json: JSON.stringify(config), analytics_json: body.analytics ? JSON.stringify(body.analytics) : null, created_at: now, updated_at: now };
    await c.env.DB.batch([toStatement(c.env, db.insertInto("goals").values(row)), goalAudit(c, site, row.id, "goal.create", {}, row.name)]);
    await touchSite(db, site.id, now);
    return c.json(goalJson(row, (await goalRunningTests(db, site.id)).get(row.id) ?? []), 201);
  },
);

/** Goal の `type` は作成後不変(PATCH は name / config / analytics のみ受理。strictObject が他のキーを 422 で弾く) */
goalRoutes.patch(
  "/sites/:sid/goals/:gid",
  describeRoute({
    tags: ["goals"],
    summary: "目標を更新(編集者以上)。name / config / analytics のみ。type は不変",
    description: "保存だけでは訪問者への配信は変わらない。次のサイトの公開、または同じサイトのエクスペリエンスの開始・再開・一時停止・終了による自動公開で、配信中のエクスペリエンスの保存済み編集とサイト共通の目標・オーディエンスが一緒に反映される。開始後のテストの結果は変更の前と後を合算する。大きく変える場合は複製して新しいテストを開始する。",
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
    // B77(K12): 保存済みの同じ場所と同じ値は見ない(古い値があっても他の欄の保存を止めない)。省いたら保存済みの値を保つ
    if (body.analytics !== undefined) assertAnalyticsValues(body.analytics, parseGoalAnalytics(row.analytics_json), ["analytics"]);
    const config = merged.data.type === "PAGEVIEW" ? { page: normalizedPageMatch(merged.data.config.page, ["config", "page"]) } : merged.data.config;
    const now = Date.now();
    // 書き戻すのは PATCH で変わり得る列だけ(全列 `set(row)` は rulings #14 が sites で禁じた形。rulings §4 CX-Medium-2)
    const patch = {
      name: merged.data.name,
      config_json: JSON.stringify(config),
      ...(body.analytics !== undefined ? { analytics_json: body.analytics ? JSON.stringify(body.analytics) : null } : {}),
      updated_at: now,
    };
    // 送った欄のうち、書く値(patch)が記録の文の中の今の行(t)と違う欄だけを記録する(変わらなければ fields: []。updated_at は進む)
    const changes: AuditFieldChange[] = GOAL_PATCH_FIELDS.filter((f) => body[f.key] !== undefined).map((f) => ({
      key: f.key,
      changed: auditChanged(sql`t.${sql.ref(f.col)}`, unchangedValues(patch[f.col] ?? null, row[f.col], "json" in f ? sameJsonText : undefined)),
    }));
    await c.env.DB.batch([goalAudit(c, site, row.id, "goal.update", changedFieldsDetail(changes)), toStatement(c.env, db.updateTable("goals").set(patch).where(thisGoal(site.id, row.id)))]);
    await touchSite(db, site.id, now);
    return c.json(goalJson({ ...row, ...patch }, (await goalRunningTests(db, site.id)).get(row.id) ?? []));
  },
);

goalRoutes.delete(
  "/sites/:sid/goals/:gid",
  describeRoute({
    tags: ["goals"],
    summary: "目標を削除(編集者以上)。参照するエクスペリエンスの配信条件・オーディエンス・テスト(下書き・配信中・一時停止中)の評価計画があれば 409",
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
    const fromExperiments = refs.experiments.has(gid);
    const fromPlans = refs.plans.has(gid);
    const fromArchived = refs.archivedTests.get(gid) ?? [];
    if (fromExperiments || fromArchived.length > 0 || fromAudiences.length > 0 || fromPlans) {
      const sources = [
        ...(fromExperiments || fromArchived.length > 0 ? ["エクスペリエンスの配信条件"] : []),
        ...(fromAudiences.length > 0 ? ["オーディエンス"] : []),
        ...(fromPlans ? ["テストの評価計画"] : []),
      ];
      const removable = [
        ...(fromAudiences.length > 0 ? [`参照しているオーディエンス: ${fromAudiences.join("、")}`] : []),
        ...(fromExperiments ? ["参照するエクスペリエンスの配信条件を外してください"] : []),
        ...(fromPlans ? ["評価計画で判定に使う目標に選んでいるテスト(下書き・配信中・一時停止中)で、別の目標を選んでください"] : []),
      ];
      // 外せる参照には今の案内を、終了したテストの参照には「テストを削除すると削除できる」を出す(D9 ③ の K10。外せない参照を「外して」と案内しない)
      const hints = [
        ...(removable.length > 0 ? [`${removable.join("。")}。参照を外してから削除してください`] : []),
        ...(fromArchived.length > 0 ? [archivedTestsHint(fromArchived.map((e) => e.name))] : []),
      ];
      throw new ApiError(409, "goal_in_use", {
        ...(fromAudiences.length > 0 ? { audiences: fromAudiences } : {}),
        ...(fromArchived.length > 0 ? { archivedTests: fromArchived.map((e) => e.id) } : {}),
        message: `この目標は${sources.join("・")}から参照されています`,
        hint: hints.join("。"),
      });
    }
    await c.env.DB.batch([goalAudit(c, site, gid, "goal.delete", {}), toStatement(c.env, db.deleteFrom("goals").where(thisGoal(site.id, gid)))]);
    await touchSite(db, site.id, Date.now());
    return c.body(null, 204);
  },
);
