import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { API_CONTRACT_VERSION, API_VERSION_HEADER } from "@wtt/core";
import { KEY_EXPIRED_HINT, isKeyExpired, keyExpiresAt } from "./api-key-expiry";
import { apiKeyFromHeaders, getAuth, type Auth, type Role } from "./auth";
import { getDb, type Db } from "./db";
import { ApiError, errorHandler, notFound } from "./errors";
import type { Env } from "./env";
import { KEY_REISSUE_HINT, keyScopeFromMetadata, keyScopeRefusal, roleCapFromMetadata, type KeyScope } from "./roles";

export type SessionUser = { id: string; email: string; name: string };
/**
 * `roleCap` = この要求が API キー経由のときの権限の上限(backlog B33 / 決定 48)。セッション経由と上限なしの鍵は null。
 * `keyScope` = この要求が API キー経由のときの範囲(backlog B42。フル / 1 つのワークスペース)。セッション経由は null。
 * 判定に使うのは `roles.ts` だけ(認可の集約)
 */
export type AppEnv = { Bindings: Env; Variables: { auth: Auth; db: Db; user: SessionUser; roleCap: Role | null; keyScope: KeyScope | null } };

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(() => { throw notFound(); });
  // backlog D13 / 決定 56 (1): 全応答に API 契約の版を付ける(判定はしない)。最初のミドルウェアにして、
  // レート制限の 429・認証の 401・404・/auth/* の素通しの応答にも付ける(onError を通った応答にも、next() の後で付く)
  app.use("*", async (c, next) => {
    await next();
    c.header(API_VERSION_HEADER, String(API_CONTRACT_VERSION));
  });
  // 無認証の入口だけ経路ごとに IP 単位で 10 回 / 10 秒(Cloudflare Rate Limiting binding)。超過は 429 の封筒。
  // AUTH_ALLOW(auth-paths.ts)のうち無認証で叩ける POST と、下の GET 2 本はすべてここに入れる — sign-up / reset-password は
  // トークンのエントロピーがあるので総当たりは現実的でないが、無認証の入口を 1 つでも素通しにすると
  // 「無認証の入口には制限がある」という docs/deploy.md 7 節 の約束が崩れる(多層防御)
  const RATE_LIMITED_POST = new Set([
    "/auth/sign-in/email",
    "/auth/sign-up/email",
    "/auth/request-password-reset",
    "/auth/reset-password",
    "/auth/handoff/exchange",
    "/break-glass/reset-link",
    "/setup",
  ]);
  // 決定 46: OAuth の入口と戻り先は無認証の GET(callback は Google の token endpoint を叩く)
  const RATE_LIMITED_GET = new Set(["/auth/google/start", "/auth/callback/google"]);
  /**
   * 決定 35 (3): 枠は経路ごと(鍵 = 経路種別 + IP)。管理画面経由の無認証 POST は admin の egress IP に
   * 集約されるので(決定 35 (4))、枠を共有するとログイン失敗が招待受諾やリセットを巻き込む。
   * 招待は ID を除いて 1 種別にする(ID ごとに枠が分かれると総当たりの枠が無限になる)
   */
  const rateLimitRouteClass = (method: string, pathname: string): string | null => {
    if (method === "GET") return RATE_LIMITED_GET.has(pathname) ? pathname : null;
    if (method !== "POST") return null;
    if (RATE_LIMITED_POST.has(pathname)) return pathname;
    if (/^\/invitations\/[^/]+\/accept$/.test(pathname)) return "/invitations/*/accept";
    return null;
  };
  app.use("*", async (c, next) => {
    const routeClass = rateLimitRouteClass(c.req.method, new URL(c.req.url).pathname);
    if (routeClass) {
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      let limited = false;
      try {
        const r = await c.env.AUTH_RATE_LIMITER.limit({ key: `${routeClass}:${ip}` });
        limited = r?.success === false;
      } catch (e) {
        // 決定 29 と同方針の fail-open: レート制限は認可ではなく DoS 抑止で、limiter 障害で管理者全員を締め出さない
        console.error("AUTH_RATE_LIMITER failed (fail-open)", e);
      }
      if (limited) throw new ApiError(429, "rate_limited", { hint: "しばらく待ってから再試行してください" });
    }
    await next();
  });
  app.use("*", async (c, next) => {
    c.set("auth", getAuth(c.env));
    c.set("db", getDb(c.env));
    await next();
  });
  return app;
}

/**
 * spec §13.3: セッショントークンは Bearer(bearer プラグイン)。無効なら 401。
 * API キー(決定 34)も同じ入口。無効なセッショントークンは getSession が null を返すだけだが、
 * 失効 / 期限切れの API キーは Better Auth の apiKey プラグインが APIError(401 / 403)を投げるので、
 * どちらの経路も 401 の封筒に揃える(500 に落とさない)
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c
    .get("auth")
    .api.getSession({ headers: c.req.raw.headers })
    .catch((e: unknown) => {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 400 || status === 401 || status === 403) return null;
      // B42(brief K19): 鍵の metadata が読めない JSON だと Better Auth の変換が SyntaxError を投げる。読めない鍵は使えない = 401。
      // D1 の障害などそれ以外は上げる(401 に丸めると本物の障害が監視に出ない)
      if (e instanceof SyntaxError) throw new ApiError(401, "unauthorized", { hint: KEY_REISSUE_HINT });
      throw e;
    });
  if (!session) throw new ApiError(401, "unauthorized");
  c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
  // B33: 鍵経由の要求では apiKey プラグインが session.id に apikey 行の id を入れる(mock session。better-auth 1.4.21 の
  // plugins/api-key で確認。版を上げるときはここを再確認する)ので、そこから上限を引く。行が無い(認証は通ったのに消えている =
  // 想定外)ときは「上限なし」に倒さず 401 で断る。metadata が NULL の既存の鍵だけが「上限なし」。
  // 見張り: 版上げ後に「すべての API キーが 401 になる」なら、まずここ(session.id の意味が変わった)を疑う
  let roleCap: Role | null = null;
  let keyScope: KeyScope | null = null;
  if (apiKeyFromHeaders(c.req.raw.headers)) {
    // B42(brief K15・K14): 失効の正(apikey_revocations)と、持ち主がいまシステム管理者かを、鍵の行と 1 回で引く
    const row = await c
      .get("db")
      .selectFrom("apikey")
      .leftJoin("apikey_revocations", "apikey_revocations.key_id", "apikey.id")
      .leftJoin("instance_admins", "instance_admins.user_id", "apikey.userId")
      .select([
        "apikey.metadata as metadata",
        "apikey.expiresAt as nativeExpiresAt",
        "apikey_revocations.revoked_at as revokedAt",
        "instance_admins.user_id as instanceAdminId",
      ])
      .where("apikey.id", "=", session.session.id)
      .executeTakeFirst();
    if (!row) throw new ApiError(401, "unauthorized");
    // Better Auth の鍵の検証は行を丸ごと書き戻すので、失効とすれ違うと enabled が 1 に戻りうる。失効の表で断る
    if (row.revokedAt != null) throw new ApiError(401, "unauthorized");
    roleCap = roleCapFromMetadata(row.metadata);
    // B42: 範囲の読めない鍵・持ち主がいま範囲を使えない鍵(降格・メンバーから外す・ワークスペースの削除)は鍵ごと 401
    keyScope = keyScopeFromMetadata(row.metadata);
    const refusal = await keyScopeRefusal(c.get("db"), session.user.id, keyScope, row.instanceAdminId != null);
    if (refusal) throw new ApiError(401, "unauthorized", { hint: refusal });
    // B43: 期限は metadata(Better Auth に渡すと、期限切れの鍵が失効の記録ごと消されるため)。境界は「使えない」。
    // 範囲の判定の後に置く = 壊れた metadata の鍵は上の「発行し直す」案内のまま(期限の案内に化けない)。失効は期限より先に判定済み
    const expiresAt = keyExpiresAt(row.metadata, row.nativeExpiresAt == null ? null : new Date(row.nativeExpiresAt).getTime());
    if (isKeyExpired(expiresAt, Date.now())) throw new ApiError(401, "unauthorized", { hint: KEY_EXPIRED_HINT });
  }
  c.set("roleCap", roleCap);
  c.set("keyScope", keyScope);
  await next();
});
