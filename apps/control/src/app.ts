import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { API_CONTRACT_VERSION, API_VERSION_HEADER, CLIENT_IP_HEADER, MIN_CLIENT_VERSION, MIN_CLIENT_VERSION_HEADER } from "@wtt/core";
import { KEY_EXPIRED_HINT, isKeyExpired, keyExpiresAt } from "./api-key-expiry";
import { apiKeyFromHeaders, asLoginMethod, getAuth, type Auth, type LoginMethod, type Role } from "./auth";
import { requestBodyLimit } from "./body-limit";
import { getDb, type Db } from "./db";
import { ApiError, errorHandler, notFound } from "./errors";
import type { Env } from "./env";
import { KEY_REISSUE_HINT, keyScopeFromMetadata, keyScopeRefusal, roleCapFromMetadata, type KeyScope } from "./roles";

export type SessionUser = { id: string; email: string; name: string };
/**
 * `roleCap` = この要求が API キー経由のときの権限の上限(backlog B33 / 決定 48)。セッション経由と上限なしの鍵は null。
 * `keyScope` = この要求が API キー経由のときの範囲(backlog B42。フル / 1 つのワークスペース)。セッション経由は null。
 * 判定に使うのは `roles.ts` だけ(認可の集約)
 * `sessionId` = セッション経由の要求のセッションの id(B112: 鍵の発行の口がセッションの作り方を引く)。API キー経由は null
 * `loginMethod` = セッション経由の要求の、セッションを作った経路(B112 の session."loginMethod"。印が無ければ null)。API キー経由は null
 * `apiKey` = API キー経由の要求の鍵の ID と名前(B129: 操作の記録の控え)。セッション経由は null。
 * loginMethod・apiKey は requireSession が既に読む値から作る(追加の照会なし。操作の記録の audit.ts の auditActor が使う)
 */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    auth: Auth;
    db: Db;
    user: SessionUser;
    roleCap: Role | null;
    keyScope: KeyScope | null;
    sessionId: string | null;
    loginMethod: LoginMethod | null;
    apiKey: { id: string; name: string | null } | null;
  };
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.notFound(() => { throw notFound(); });
  // backlog D13 / 決定 56 (1): 全応答に API 契約の版を付ける(判定はしない)。最初のミドルウェアにして、
  // レート制限の 429・認証の 401・404・/auth/* の素通しの応答にも付ける(onError を通った応答にも、next() の後で付く)
  // plan12 K4: 最低の版(MIN_CLIENT_VERSION)も同じ入口で付ける(判定は client-version.ts)
  app.use("*", async (c, next) => {
    await next();
    c.header(API_VERSION_HEADER, String(API_CONTRACT_VERSION));
    c.header(MIN_CLIENT_VERSION_HEADER, String(MIN_CLIENT_VERSION));
  });
  // 無認証の入口だけ経路ごとに IP 単位で 30 回 / 10 秒(Cloudflare Rate Limiting binding)。超過は 429 の封筒。
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
   * 決定 35 (3): 枠は経路ごと(鍵 = 経路種別 + IP)。ログイン失敗が招待受諾やリセットを巻き込まないようにするため。
   * IP は利用者ごと(決定 63 (6)。以前は管理画面経由の POST がすべて admin の egress IP に集約され「全員 1 枠」だった = 決定 35 (4))。
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
    // B154(G17): Hono がルートを選ぶのと同じデコードした path で分類する。生の URL の path だと `/s%65tup` などのエンコードした別名が
    // 分類に当たらないまま本物のルートに届く
    const routeClass = rateLimitRouteClass(c.req.method, c.req.path);
    if (routeClass) {
      // 決定 63 (6): admin 経由(service binding の ControlBff)なら admin が渡す利用者の IP(x-wtt-client-ip)で数える。
      // この要求は cf-connecting-ip を持たない。公開の入口ではこのヘッダーを消してから app へ渡す(index.ts の stripTrustedHeaders)ので、
      // 外から偽装して枠を選ぶことはできない。どちらも無ければ "unknown"(手元の開発など)
      const ip = c.req.header(CLIENT_IP_HEADER) ?? c.req.header("cf-connecting-ip") ?? "unknown";
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
  // B154(G19): 本文の上限。回数の上限の後(数える前に本文を読まない)、ルート・`/auth/*` の素通しより前(本文を読む処理はすべてこの後)
  app.use("*", requestBodyLimit);
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
      // 1.7.15 でも同じ(この枝が今も実際の 401 の経路): @better-auth/api-key の apikey.metadata は `type: "string"` で
      // `transform.output = parseJSON(value)`(dist/index.mjs)。parseJSON は strict で投げ、@better-auth/core の adapter factory は
      // `field.transform.output` を先に呼ぶ(safeJSONParse が効くのは `type: "json"` の列だけ)ので、SyntaxError が鍵の検証から出て、
      // 非 APIError なので hooks も投げ直す。この枝を外すと 500 になる(test/api-key-scope.test.ts の unreadable_metadata_is_401_with_reissue_hint_b179 が落ちる)。
      // D1 の障害などそれ以外は上げる(401 に丸めると本物の障害が監視に出ない)
      if (e instanceof SyntaxError) throw new ApiError(401, "unauthorized", { hint: KEY_REISSUE_HINT });
      throw e;
    });
  if (!session) throw new ApiError(401, "unauthorized");
  c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
  // B33: 鍵経由の要求では apiKey プラグインが session.id に apikey 行の id を入れる(mock session。1.7.15 の @better-auth/api-key
  // dist/index.mjs の before hook `session: { id: apiKey.id, … }` で確かめた。test/better-auth-storage.test.ts の api_key_session_id_is_key_row_id_b33 が見張る)ので、そこから上限を引く。行が無い(認証は通ったのに消えている =
  // 想定外)ときは「上限なし」に倒さず 401 で断る。metadata が NULL の既存の鍵だけが「上限なし」。
  // 見張り: 版上げ後に「すべての API キーが 401 になる」なら、まずここ(session.id の意味が変わった)を疑う
  const isApiKeyRequest = Boolean(apiKeyFromHeaders(c.req.raw.headers));
  let roleCap: Role | null = null;
  let keyScope: KeyScope | null = null;
  let apiKey: { id: string; name: string | null } | null = null;
  if (isApiKeyRequest) {
    // B42(brief K15・K14): 失効の正(apikey_revocations)と、持ち主がいまシステム管理者かを、鍵の行と 1 回で引く
    const row = await c
      .get("db")
      .selectFrom("apikey")
      .leftJoin("apikey_revocations", "apikey_revocations.key_id", "apikey.id")
      .leftJoin("instance_admins", "instance_admins.user_id", "apikey.userId")
      .select([
        "apikey.metadata as metadata",
        // B129: 操作の記録の控え(鍵の名前)。同じ照会で読む(照会は増やさない。テスト require_session_adds_no_d1_query)
        "apikey.name as name",
        "apikey.expiresAt as nativeExpiresAt",
        "apikey_revocations.revoked_at as revokedAt",
        "instance_admins.user_id as instanceAdminId",
      ])
      .where("apikey.id", "=", session.session.id)
      .executeTakeFirst();
    if (!row) throw new ApiError(401, "unauthorized");
    // 失効の正は apikey_revocations(enabled だけには頼らない)。1.4.21 の鍵の検証は読んだ行を丸ごと書き戻し、失効とすれ違うと enabled が 1 に戻りえた。
    // 1.7.15 は丸ごとは書き戻さず、lastRequest・requestCount・remaining・updatedAt だけを条件付きで更新する(@better-auth/api-key の claimUsageInDatabase)ので
    // enabled は戻らないが、読んだ後に失効された要求は Better Auth を通りうる。その要求をここで断るために失効の表を引く作りは残す
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
    apiKey = { id: session.session.id, name: row.name };
  }
  c.set("roleCap", roleCap);
  c.set("keyScope", keyScope);
  // B112: 鍵の要求では session.id が apikey の行の id(上の B33 のコメント)なので、セッションの id としては入れない
  c.set("sessionId", isApiKeyRequest ? null : session.session.id);
  // B129: セッションを作った経路は、getSession が返すセッションの追加の列(auth.ts の session.additionalFields)から読む(照会は増やさない)。
  // better-auth の getSession は session の行を読み、additionalFields の列も session.session に入れて返す(型も additionalFields から推論される)。
  // 1.7.15 で確かめた: api/routes/session.mjs が internalAdapter.findSession の結果を parseSessionOutput(db/schema.mjs)に通して返し、additionalFields(returned が false でない限り出力)の列が残る。
  // 鍵の要求の session は apiKey プラグインの作る mock(列を持たない)なので、鍵の要求では読まない。
  // 見張り(B179 の版上げ): getSession が追加の列を返さなくなると、すべてのセッションの記録の経路が unknown になる
  // (test/audit.test.ts の actor_from_google_session・actor_from_password_session が落ちる)
  c.set("loginMethod", isApiKeyRequest ? null : asLoginMethod(session.session.loginMethod));
  c.set("apiKey", apiKey);
  await next();
});
