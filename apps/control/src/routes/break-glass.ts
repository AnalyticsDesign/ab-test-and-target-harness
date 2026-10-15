import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../app";
import { googleConfigured } from "../auth";
import { breakGlassToken, passwordLoginOpen } from "../break-glass";
import { notFound, validationFailed } from "../errors";
import { timingSafeEqualString } from "../ids";
import { errorResponses } from "../openapi";
import { issueResetUrl } from "../reset-link";

const LoginOptionsSchema = z.object({
  google: z.boolean().describe("Google ログインが設定されているか"),
  passwordLogin: z.boolean().describe("メール + パスワードのログインが開いているか(非常時だけ true)"),
});
const BreakGlassBody = z.strictObject({ token: z.string().min(1).max(500), email: z.string().email() });
const ResetLinkSchema = z.object({ url: z.string().describe("管理画面のパスワード再設定ページの URL(1 回限り)") });

export const breakGlassRoutes = new Hono<AppEnv>();

/** ログイン画面(認証前)が出し分けに使う。秘密は含まない */
breakGlassRoutes.get(
  "/login-options",
  describeRoute({
    tags: ["auth"],
    summary: "この導入で使えるログイン方法(認証不要)",
    security: [],
    responses: { 200: { description: "ログイン方法", content: { "application/json": { schema: resolver(LoginOptionsSchema) } } }, ...errorResponses(500) },
  }),
  (c) => c.json({ google: googleConfigured(c.env), passwordLogin: passwordLoginOpen(c.env) }),
);

/**
 * 決定 46 (3): 非常口。Cloudflare 側で secret を立てられる人だけが、OWNER のパスワード再設定リンクを得られる。
 * 閉じている・token 違い・OWNER でないメールは区別せず 404(何が違ったかを教えない)
 */
breakGlassRoutes.post(
  "/break-glass/reset-link",
  describeRoute({
    tags: ["auth"],
    summary: "非常時: オーナーのパスワード再設定リンクを発行する(パスワードログインが有効なときだけ)",
    description: "control の secret に置いた非常用トークンとオーナーのメールアドレスを送る。条件を満たさない要求はすべて 404",
    security: [],
    responses: { 200: { description: "再設定リンク", content: { "application/json": { schema: resolver(ResetLinkSchema) } } }, ...errorResponses(400, 404, 422, 429, 500) },
  }),
  validator("json", BreakGlassBody, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const body = c.req.valid("json");
    const expected = breakGlassToken(c.env);
    if (!expected || !(await timingSafeEqualString(body.token, expected))) throw notFound();
    const owner = await c
      .get("db")
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select(["user.email as email"])
      .where("member.role", "=", "owner")
      .where("user.email", "=", body.email.toLowerCase())
      .executeTakeFirst();
    if (!owner) throw notFound();
    return c.json({ url: await issueResetUrl(c, owner.email) });
  },
);
