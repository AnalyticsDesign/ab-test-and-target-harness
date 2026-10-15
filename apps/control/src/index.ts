import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { createApp, requireSession } from "./app";
import { AUTH_ALLOW } from "./auth-paths";
import { PASSWORD_AUTH_PATHS, passwordLoginOpen } from "./break-glass";
import { notFound } from "./errors";
import { errorResponses, mountOpenApi } from "./openapi";
import { AGENT_GUIDE } from "./generated/agent-guide";
import { agentRoutes } from "./routes/agent";
import { apiKeyRoutes } from "./routes/api-keys";
import { assetRoutes } from "./routes/assets";
import { breakGlassRoutes } from "./routes/break-glass";
import { capabilityRoutes } from "./routes/capabilities";
import { experimentRoutes } from "./routes/experiments";
import { oauthRoutes } from "./routes/oauth";
import { audienceRoutes } from "./routes/audiences";
import { goalRoutes } from "./routes/goals";
import { publishRoutes } from "./routes/publish";
import { setupRoutes } from "./routes/setup";
import { siteRoutes } from "./routes/sites";
import { instanceAdminRoutes } from "./routes/instance-admins";
import { usageRoutes } from "./routes/usage";
import { workspaceRoutes } from "./routes/workspaces";
import { actsAsInstanceAdmin } from "./roles";
import { refuseApiKey, SESSION_ONLY } from "./session-only";
import { writeFreezeGuard } from "./write-freeze";

export const app = createApp();

// backlog B42 / brief K17: 人とアクセス権の書き込みは API キーでは断る。各ルートの認証・検証より前に効かせるため、ルートの登録より先に置く
for (const r of SESSION_ONLY) {
  if (r.method === "ALL") app.use(r.path, refuseApiKey(r.hint));
  else app.on(r.method, r.path, refuseApiKey(r.hint));
}
// backlog D13 / 決定 56 (4): 書き込みの凍結。ルートごとの認証より前に効かせる(後から足したルートが漏れないように)。
// 認証より前なので、ログインしていない要求にも 503 と理由が返る(理由に秘密を書かないことを deploy.md に書く)
app.use("*", writeFreezeGuard);

app.get("/", (c) => c.text("wtt-control", 200));
/**
 * spec §13.10: エージェントの入口。`docs/agent-guide.md` をビルド時に埋め込んで配る(認証不要)。
 * 契約そのものは `/openapi.json`。ここは「どう繋ぐか」を書いた散文
 */
app.get(
  "/llms.txt",
  describeRoute({
    tags: ["agent"],
    summary: "エージェント向けガイド(docs/agent-guide.md の写し。認証不要)",
    security: [], // 無認証の入口(決定 39 (6))。文書全体の security: [{ bearer: [] }] をこのルートだけ打ち消す
    responses: {
      200: { description: "ガイド本文", content: { "text/plain": { schema: resolver(z.string()) } } },
      ...errorResponses(500),
    },
  }),
  (c) => c.body(AGENT_GUIDE, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" }),
);
// 決定 46: Google ログインの自前ルート(/auth/google/start・/auth/callback/google・/auth/handoff/exchange)。
// Hono は登録順に当てるので、下の `/auth/*` catch-all より**前**に置く(後ろだと catch-all の 404 が先に勝つ)
app.route("/", oauthRoutes);
/**
 * 再設定リンクは `POST …/members/:memberId/reset-link` が管理画面の `/reset?token=…` を配るので、
 * Better Auth の `GET /auth/reset-password/<token>` を公開する必要は無い
 */
app.all("/auth/*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (!AUTH_ALLOW.includes(pathname)) throw notFound();
  // 決定 46 (2): メール + パスワードの経路は非常時だけ。閉じているあいだは存在しない経路と同じ 404
  if (PASSWORD_AUTH_PATHS.has(pathname) && !passwordLoginOpen(c.env)) throw notFound();
  return c.get("auth").handler(c.req.raw);
});
app.route("/", setupRoutes);
app.route("/", workspaceRoutes);
app.route("/", instanceAdminRoutes);
app.route("/", siteRoutes);
app.route("/", goalRoutes);
app.route("/", audienceRoutes);
app.route("/", experimentRoutes);
app.route("/", publishRoutes);
app.route("/", apiKeyRoutes);
app.route("/", assetRoutes);
app.route("/", capabilityRoutes);
app.route("/", usageRoutes);
app.route("/", breakGlassRoutes);
app.route("/", agentRoutes);

const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  roleCap: z.enum(["viewer", "editor", "admin"]).nullable().describe("API キー経由のとき、その鍵の権限。セッション経由と上限なしの鍵は null"),
  instanceAdmin: z.boolean().describe("システム管理者として扱われるか(ワークスペースの作成・システム管理者の一覧ができる。昇格・降格はセッションのみ)。上限付き・ワークスペース指定の API キーでは常に false"),
  keyScope: z.enum(["full", "workspace"]).nullable().describe("API キー経由のとき、その鍵の範囲(full = すべてのワークスペース / workspace = keyWorkspaceId の 1 つだけ)。セッション経由は null"),
  keyWorkspaceId: z.string().nullable().describe("keyScope が workspace のとき、その鍵が使えるワークスペースの ID。それ以外は null"),
});

/** spec §13.3: セッション(または API キー)の持ち主を返す。B33 / B42: 鍵経由なら鍵の上限と範囲も返す(エージェントが自分の権限を確かめる口) */
app.get(
  "/me",
  describeRoute({
    tags: ["me"],
    summary: "現在のセッションの持ち主と、API キー経由ならその鍵の権限と範囲と、システム管理者として扱われるかを返す",
    responses: {
      200: { description: "セッションの持ち主", content: { "application/json": { schema: resolver(SessionUserSchema) } } },
      ...errorResponses(401),
    },
  }),
  requireSession,
  async (c) => {
    const scope = c.get("keyScope");
    return c.json({
      ...c.get("user"),
      roleCap: c.get("roleCap"),
      instanceAdmin: await actsAsInstanceAdmin(c),
      keyScope: scope?.kind ?? null,
      keyWorkspaceId: scope?.kind === "workspace" ? scope.workspaceId : null,
    });
  },
);

// GET /openapi.json(決定 34)。全ルートを登録し終えてから文書を公開する
mountOpenApi(app);

export default app;
