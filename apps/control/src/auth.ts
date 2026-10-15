import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { apiKey, bearer, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { D1Dialect } from "kysely-d1";
import { sql } from "kysely";
import type { Env } from "./env";
import { hasAccess, hasLiveInvitation } from "./access";
import { getDb } from "./db";
import { timingSafeEqualString } from "./ids";

/** spec §13.2 の Role 4 種。Better Auth の member.role にこの文字列を入れる */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

// Better Auth 側の権限(招待の作成など、プラグイン自身のエンドポイントで効く)。control の Role 判定は roles.ts が D1 で行う
const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  editor: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
};

/** requestPasswordReset が sendResetPassword に渡す URL を、reset-link API(Task 2)が回収する一時置き場(メール送信基盤を持たない。spec §13.3) */
export const pendingResetLinks = new Map<string, string>(); // email(小文字)→ url

/** 決定 34 / spec §13.3: API キーの接頭辞。平文は発行応答限りで、保存も再表示もしない */
export const API_KEY_PREFIX = "wtt_";

/**
 * リクエストから API キーを取り出す(決定 34)。`x-api-key` と `Authorization: Bearer wtt_…` の両方を受ける。
 * Bearer はセッショントークンにも使うので、接頭辞が `wtt_` のときだけ鍵として扱う
 */
export function apiKeyFromHeaders(headers: Headers | null | undefined): string | null {
  const direct = headers?.get("x-api-key");
  if (direct) return direct;
  const authorization = headers?.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(authorization);
  return m?.[1]?.startsWith(API_KEY_PREFIX) ? m[1] : null;
}

/**
 * backlog B42(差分レビュー r2 の B1): 要求が API キーを**運んでいそうか**(断る側の判定。広く取る)。
 * `x-api-key`、または `Authorization` の値が `Bearer` の有無・大文字小文字・前後の空白に関わらず `wtt_` で始まるもの。
 * 認証に使う `apiKeyFromHeaders` は厳密な形のまま(Better Auth に渡す値は変えない)。こちらはセッションのみの口で鍵を断るためだけに使う
 */
export function carriesApiKey(headers: Headers | null | undefined): boolean {
  if (headers?.get("x-api-key")) return true;
  const value = (headers?.get("authorization") ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  return value.startsWith(API_KEY_PREFIX);
}

/** 決定 46: Google の OAuth クライアントが両方そろっているか */
export const googleConfigured = (env: Env): boolean => Boolean(env.AB_GOOGLE_CLIENT_ID?.trim() && env.AB_GOOGLE_CLIENT_SECRET?.trim());

function buildAuth(env: Env) {
  const db = getDb(env);
  const orgCount = async () => {
    const r = await sql<{ n: number }>`select count(*) as n from organization`.execute(db);
    return Number(r.rows[0]?.n ?? 0);
  };
  /** R13: Google の token は使わないので保存しない(ログイン後に Google の API を呼ばない) */
  const dropOAuthTokens = async <T extends Record<string, unknown>>(account: T) =>
    account.providerId === "google" || "accessToken" in account || "idToken" in account
      ? { data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } }
      : undefined;
  /**
   * レビュー r2 CX-High-1 (b): `/reset-password` は token を読んだ後に hash してから account を更新し、更新の直前に token を再照合しない
   * (Better Auth 1.4.21 `api/routes/password.mjs`)。所属の変化で token を消しても、読み取り済みの要求はパスワードを変えてしまうので、
   * account の create / update の直前(databaseHooks)で token がまだ在ることを確かめ、無ければ INVALID_TOKEN で止める(パスワードは変わらない)。
   * ctx は endpoint の文脈(path と body)。他の経路(sign-up・Google の link)は path が違うので素通し
   */
  const requireLiveResetToken = async (ctx: { path?: string; body?: { token?: unknown } } | null | undefined) => {
    if (ctx?.path !== "/reset-password") return;
    const token = typeof ctx.body?.token === "string" ? ctx.body.token : null;
    const row = token ? await db.selectFrom("verification").select("id").where("identifier", "=", `reset-password:${token}`).executeTakeFirst() : undefined;
    if (!row) throw new APIError("BAD_REQUEST", { message: "INVALID_TOKEN" });
  };
  const accountBefore = async <T extends Record<string, unknown>>(account: T, ctx: unknown) => {
    await requireLiveResetToken(ctx as Parameters<typeof requireLiveResetToken>[0]);
    return dropOAuthTokens(account);
  };
  const setupOpen = async () => {
    const r = await sql<{ n: number; c: number }>`select count(*) as n, coalesce(max(completed), 0) as c from setup_lock`.execute(db);
    const row = r.rows[0];
    return Number(row?.n ?? 0) === 1 && Number(row?.c ?? 0) === 0;
  };
  return betterAuth({
    baseURL: env.AB_CONTROL_URL,
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
    trustedOrigins: [env.AB_ADMIN_URL],
    // OAuth の途中で Better Auth が自前のエラーページ(/auth/error。公開していない)へ飛ばそうとする場合の行き先
    onAPIError: { errorURL: `${env.AB_ADMIN_URL}/login` },
    socialProviders: googleConfigured(env)
      ? { google: { clientId: env.AB_GOOGLE_CLIENT_ID!, clientSecret: env.AB_GOOGLE_CLIENT_SECRET!, prompt: "select_account" } }
      : undefined,
    account: {
      // Google を trustedProviders に入れない = 既存 user への結びつけは「Google が検証済みのメール」のときだけ(plan R1)
      accountLinking: { enabled: true },
      // R15: state は暗号化 Cookie。無認証の start が D1 に書かない
      storeStateStrategy: "cookie",
      // R13: フックで落とし損ねた場合の保険
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        create: {
          /**
           * allowlist: 素通しにするのは sign-up/email だけ(setup と、非常時の招待受諾。hooks.before のゲートが見る)。
           * それ以外 — OAuth callback も、endpoint の文脈が取れない呼び出しも — は「Google が検証済み + 有効な招待」を必須にする。
           * 文脈が取れなくなったとき(better-auth の内部が変わったとき)に、誰でも user を作れる側へ倒れないため
           */
          before: async (user, ctx) => {
            if (ctx?.path === "/sign-up/email") return;
            if (user.emailVerified !== true) throw new APIError("FORBIDDEN", { message: "email_not_verified" });
            // 決定 46 (5): social 経由の新規 user は、pending・未失効の招待があるメールだけ
            if (!(await hasLiveInvitation(db, user.email))) throw new APIError("FORBIDDEN", { message: "not_invited" });
          },
        },
      },
      session: {
        create: {
          /**
           * backlog B20: Workspace に無関係な user はログイン状態を持てない。
           * allowlist は sign-up/email だけ — /setup は「user を作る → セッション → Workspace を作る」の順で、
           * この時点ではまだ Member でない(この経路は下の hooks.before が setup token / 有効な招待で守っている)。
           * それ以外 — OAuth callback も /sign-in/email も、文脈が取れない呼び出しも — は検査する(fail-closed)
           */
          before: async (session, ctx) => {
            if (ctx?.path === "/sign-up/email") return;
            if (!(await hasAccess(db, session.userId))) throw new APIError("FORBIDDEN", { message: "not_invited" });
          },
        },
      },
      account: { create: { before: accountBefore }, update: { before: accountBefore } },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // パスワードの再設定でそれまでのセッションを全部切る(Better Auth の既定は残す)。
      // リセットリンクは非常時に他人が発行するものなので、再設定の前に張られたセッションを生かしておく理由が無い
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        pendingResetLinks.set(user.email.toLowerCase(), url);
      },
    },
    plugins: [
      bearer(),
      organization({
        ac,
        roles,
        invitationExpiresIn: 60 * 60 * 24 * 7, // 招待リンクは 7 日
        sendInvitationEmail: async () => {}, // メールは送らない(リンク発行方式、spec §13.3)
      }),
      // 決定 34: API キーはその所有者の Role をそのまま引き継ぐ(鍵ごとのスコープは持たない)。
      // enableSessionForAPIKeys が false だと auth.api.getSession が鍵で何も返さず、鍵の話が丸ごと成立しない
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        enableSessionForAPIKeys: true,
        customAPIKeyGetter: (ctx) => apiKeyFromHeaders(ctx.headers ?? ctx.request?.headers),
        // POST /me/api-keys の name(1..100 文字)と揃える。既定の 32 文字だと 33 文字以上が BAD_REQUEST になる
        maximumNameLength: 100,
        // 決定 34 / 35: プラグインの既定は 1 鍵 10 req / 24h で、エージェントの往復が 11 回目から 401 になる(2026-09-07 本番で実測)。
        // 鍵単位の枠は持たず、DoS 抑止は経路 + IP の AUTH_RATE_LIMITER に委ねる。この設定は行の rateLimitEnabled より先に評価されるので既存の鍵にも効く
        rateLimit: { enabled: false },
        // backlog B33 / 決定 48: 鍵ごとの権限の上限(roleCap)を metadata に持つ(列は 0001 の時点からある。マイグレーション不要)
        enableMetadata: true,
      }),
    ],
    hooks: {
      // spec §13.3: サインアップは閉鎖。初回セットアップ(トークン + user 0 件)か有効な招待のときだけ通す
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const setupToken = ctx.headers?.get("x-setup-token");
        if (setupToken && env.AB_SETUP_TOKEN && (await timingSafeEqualString(setupToken, env.AB_SETUP_TOKEN))) {
          if ((await orgCount()) === 0 && (await setupOpen())) return;
          throw new APIError("FORBIDDEN", { message: "setup already completed" });
        }
        const invitationId = ctx.headers?.get("x-invitation-id");
        if (invitationId) {
          const inv = await ctx.context.adapter.findOne<{ email: string; status: string; expiresAt: string | number | Date }>({
            model: "invitation",
            where: [{ field: "id", value: invitationId }],
          });
          const email = String((ctx.body as { email?: string } | undefined)?.email ?? "").toLowerCase();
          if (inv && inv.status === "pending" && new Date(inv.expiresAt).getTime() > Date.now() && inv.email.toLowerCase() === email) return;
        }
        throw new APIError("FORBIDDEN", { message: "sign-up requires an invitation" });
      }),
    },
  });
}
export type Auth = ReturnType<typeof buildAuth>;

// isolate ごとに 1 回だけ組み立てる(env.DB を鍵にする。vitest のテストファイル単位の隔離とも整合)
const cache = new WeakMap<D1Database, Auth>();
export function getAuth(env: Env): Auth {
  let a = cache.get(env.DB);
  if (!a) cache.set(env.DB, (a = buildAuth(env)));
  return a;
}

export const bearerHeaders = (token: string) => new Headers({ authorization: `Bearer ${token}` });
