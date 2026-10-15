import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { sql } from "kysely";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import { revokeSessionsIfNoAccess } from "../access";
import { ApiError, notFound, validationFailed } from "../errors";
import { grantInstanceAdmin, listInstanceAdminCandidates, listInstanceAdmins, revokeInstanceAdmin } from "../instance-admins";
import { errorResponses } from "../openapi";
import { requireInstanceAdmin } from "../roles";

/** backlog B36 / 決定 53: システム管理者の一覧・昇格・降格(システム管理者だけ。昇格・降格はセッションのみ = 決定 53 (10)) */
export const instanceAdminRoutes = new Hono<AppEnv>();

const InstanceAdminSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  createdAt: z.number().describe("epoch ミリ秒"),
  priorRoles: z
    .array(z.object({ workspaceId: z.string(), workspaceName: z.string(), role: z.string() }))
    .describe("システム管理者になる前に参加していたワークスペースとロール。外すと、これらのワークスペースではこのロールに戻り、それ以外のワークスペースからは外れる(空 = すべてのワークスペースから外れる)"),
});
const PromoteSchema = z.strictObject({ email: z.string().email() });

instanceAdminRoutes.use("/instance-admins", requireSession, requireInstanceAdmin);
instanceAdminRoutes.use("/instance-admins/*", requireSession, requireInstanceAdmin);

instanceAdminRoutes.get(
  "/instance-admins",
  describeRoute({
    tags: ["instance-admins"],
    summary: "システム管理者の一覧(システム管理者のみ。上限付き・ワークスペース指定の API キーは不可)。システム管理者は、この導入のすべてのワークスペースのオーナーを兼ねる",
    responses: {
      200: { description: "システム管理者", content: { "application/json": { schema: resolver(z.array(InstanceAdminSchema)) } } },
      ...errorResponses(401, 403),
    },
  }),
  async (c) => c.json(await listInstanceAdmins(c.get("db"))),
);

instanceAdminRoutes.post(
  "/instance-admins",
  describeRoute({
    tags: ["instance-admins"],
    summary: "どこかのワークスペースのメンバーをメールアドレスで指定してシステム管理者にする(システム管理者のみ・セッションのみ。メンバーでなければ 404)。すべてのワークスペースのオーナーになり(それまでのロールは外したときに戻すために記録する)、その人宛ての未受諾の招待は取り消される。既にシステム管理者なら 200",
    responses: {
      201: { description: "システム管理者にした", content: { "application/json": { schema: resolver(z.object({ userId: z.string() })) } } },
      200: { description: "既にシステム管理者だった", content: { "application/json": { schema: resolver(z.object({ userId: z.string() })) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  validator("json", PromoteSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const { email } = c.req.valid("json");
    const userNotFound = () =>
      new ApiError(404, "user_not_found", { hint: "先にどこかのワークスペースへ招待し、受諾してもらってからシステム管理者にしてください" });
    const r = await sql<{ id: string }>`select id from "user" where lower(email) = ${email.toLowerCase()}`.execute(c.get("db"));
    const userId = r.rows[0]?.id;
    if (!userId) throw userNotFound();
    // backlog B41 (1): メンバーから外した人(user 行は残る)は昇格させない。判定は昇格の文の条件で行う
    const result = await grantInstanceAdmin(c.env, userId, c.get("user").id, { requireMember: true });
    if (result === "not_member") throw userNotFound();
    return c.json({ userId }, result === "granted" ? 201 : 200);
  },
);

const CandidateSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.string().describe("そのワークスペースでのロール") })),
});

instanceAdminRoutes.get(
  "/instance-admins/candidates",
  describeRoute({
    tags: ["instance-admins"],
    summary: "システム管理者にできる人の一覧(システム管理者のみ。上限付き・ワークスペースの API キーは不可)。どこかのワークスペースのメンバーで、まだシステム管理者でない人を、参加しているワークスペースとそこでのロール付きで返す",
    responses: {
      200: { description: "候補", content: { "application/json": { schema: resolver(z.array(CandidateSchema)) } } },
      ...errorResponses(401, 403),
    },
  }),
  async (c) => c.json(await listInstanceAdminCandidates(c.get("db"))),
);

const RevokeQuerySchema = z.strictObject({
  restore: z.enum(["true", "false"]).optional().describe("false なら元のロールに戻さず、すべてのワークスペースから外す(省略時は true = 元のロールに戻す)"),
});

instanceAdminRoutes.delete(
  "/instance-admins/:userId",
  describeRoute({
    tags: ["instance-admins"],
    summary: "システム管理者から外す(システム管理者のみ・セッションのみ)。システム管理者になる前に参加していたワークスペースでは元のロールに戻り、それ以外のワークスペースからは外れる。`?restore=false` なら元のロールに戻さず、すべてのワークスペースから外す。最後の 1 人は外せない",
    responses: { 204: { description: "外した" }, ...errorResponses(401, 403, 404, 409, 422) },
  }),
  validator("query", RevokeQuerySchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const userId = c.req.param("userId");
    const query = c.req.valid("query");
    const result = await revokeInstanceAdmin(c.env, userId, { restore: query.restore !== "false" });
    if (result === "not_admin") throw notFound();
    if (result === "last") throw new ApiError(409, "last_instance_admin", { hint: "先に別のユーザーをシステム管理者にしてください" });
    // 元のロールに戻ったワークスペースが無く、有効な招待も無ければログイン状態を切る(B20 と同じ。自分を外した場合は自分も)
    await revokeSessionsIfNoAccess(c.get("db"), userId);
    return c.body(null, 204);
  },
);
