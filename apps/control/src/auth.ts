import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
// B179: 1.5 から API キーのプラグインは別のパッケージ(1.7 の better-auth/plugins は apiKey を export しない)
import { apiKey } from "@better-auth/api-key";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { sql } from "kysely";
import type { Env } from "./env";
import { hasAccess, hasLiveInvitation } from "./access";
import { actorFromUser, writeAuditAfterDb } from "./audit";
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

/** B112: セッションを作った経路。D1 の session."loginMethod" に入る値(NULL = 分からない) */
export type LoginMethod = "password" | "google";

/**
 * B112: endpoint の path(basePath の /auth を含まない。Google の戻りは `/callback/:id`)から、セッションを作った経路を決める。
 * パスワード = /sign-in/email・/sign-up/email、Google = /callback/ で始まる経路。それ以外・path が取れないときは null(= 分からない)
 */
export function loginMethodOf(path: string | undefined): LoginMethod | null {
  if (path === "/sign-in/email" || path === "/sign-up/email") return "password";
  if (path?.startsWith("/callback/")) return "google";
  return null;
}

/**
 * B129: D1 の session."loginMethod" に入っている値を LoginMethod に読む(想定外の値・NULL は null = 分からない)。
 * requireSession が getSession の返すセッションの追加の列から読み、操作の記録の経路(google / password / unknown)にする
 */
export function asLoginMethod(v: unknown): LoginMethod | null {
  return v === "password" || v === "google" ? v : null;
}

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
   * レビュー r2 CX-High-1 (b): 所属の変化で再設定の token を消した後に、読み取り済みの `/reset-password` がパスワードを変えないこと。
   * 1.4.21 は token を読んだ後に hash してから account を更新し、更新の直前に token を再照合しなかったので、ここ(account の create / update の
   * 直前)で token がまだ在ることを確かめていた。B179: 1.7.15 の `/reset-password`(`api/routes/password.mjs` が resetCredentialPassword に
   * consumeResetToken を渡す。`utils/password.mjs` の resetCredentialPassword)は、account の書き込みより**前に**(セッションの取り消しよりも前に)
   * token を 1 行の削除(`internalAdapter.consumeVerificationValue` = `delete … returning`。消せなければ INVALID_TOKEN)で使い切るので、
   * 同じことを Better Auth 自身が守る。ここで token を探すと、自分が使い切った token が無いので毎回断ってしまう。そのため確かめは外した
   * (守りは test/workspaces.test.ts の「reset: a token invalidated after it was read does not change the password」が見張る。1.7.15 で緑)
   */
  const accountBefore = async <T extends Record<string, unknown>>(account: T) => dropOAuthTokens(account);
  const setupOpen = async () => {
    const r = await sql<{ n: number; c: number }>`select count(*) as n, coalesce(max(completed), 0) as c from setup_lock`.execute(db);
    const row = r.rows[0];
    return Number(row?.n ?? 0) === 1 && Number(row?.c ?? 0) === 0;
  };
  return betterAuth({
    // Better Auth 内蔵のレート制限は切る(7q / K7)。経路 + IP の AUTH_RATE_LIMITER に一本化するため:
    // 内蔵は本番で NODE_ENV=production により有効になっていたが、memory 保存でアイソレートごとに数え、x-forwarded-for を鍵にするので効き方が読めない。
    // AUTH_RATE_LIMITER なら 429 の形も control の封筒にそろう(apiKey の rateLimit は下で別に切っている)
    rateLimit: { enabled: false },
    baseURL: env.AB_CONTROL_URL,
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    // B179(D6): Better Auth 1.7 の組み込みの D1(@better-auth/kysely-adapter の D1SqliteDialect)に D1 をそのまま渡す。
    // 組み込みの driver は結果に `numUpdatedOrDeletedRows` を付けないので、B162 の kysely の警告の包み(auth-d1-dialect.ts)は要らない。
    // 型は sqlite(日時は ISO の文字列・真偽は 0/1 のまま)、対話型のトランザクションは使わない(包みのときと同じ)
    database: env.DB,
    // B179(D13): Better Auth 1.7 の実行時の表の形の検査(既定でオン)を切る。表の形の正は D1 のマイグレーションで、合っているかはテストが見張る。
    // オンだと列が 1 本足りないだけで(マイグレーションの前に control を deploy した場合など)ログイン・鍵の検証の全経路が例外になり、
    // isolate を起こすたびに全表の introspection が D1 に走る
    advanced: { database: { validateSchema: false } },
    trustedOrigins: [env.AB_ADMIN_URL],
    // B231: callback が失敗を固定の画面で終えるので、この URL はブラウザには届かない。
    // Better Auth の既定の行き先にも管理画面を置かない二重の守り。/auth/error は公開せず 404。
    onAPIError: { errorURL: `${env.AB_CONTROL_URL}/auth/error` },
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
    session: {
      // B112: セッションの作り方の印(migrations/0018)。input: false = 要求の body から書かせない(値は下の create.before が決める)
      additionalFields: { loginMethod: { type: "string", required: false, input: false } },
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
            // B112: どの経路で作ったセッションかの印。作った時に決まって変わらないので、後から非常口の掃除とすれ違わない。
            // null は「分からない」(経路が取れない・想定外の経路)で、鍵の発行の口がパスワードの記録の有無で判定する(fail-closed)。
            // before が返した data は Better Auth が書く値に混ぜる(additionalFields の input: false は要求の body からの入力を止めるだけ)
            const data = { ...session, loginMethod: loginMethodOf(ctx?.path) };
            if (ctx?.path === "/sign-up/email") return { data };
            if (!(await hasAccess(db, session.userId))) throw new APIError("FORBIDDEN", { message: "not_invited" });
            return { data };
          },
          /**
           * plan12 K13(r4 CX-High-2): パスワードの経路(sign-in/email・sign-up/email)で作ったセッションは、保存した後に
           * その人のパスワードの記録(account の providerId = 'credential')がまだあるかを確かめる。
           * Better Auth はパスワードの記録を読んで検証してからセッションを作り、作る前に読み直さないので、非常口を閉じた後の掃除
           * (cron/break-glass-sweep.ts)の前に始まったログインが、掃除の後にセッションを作れてしまう。記録が無ければそのセッションを消して断る。
           * 掃除の 2 つの削除は 1 つの batch なので、保存が掃除の前ならその batch が消し、後ならこの確かめが消す(どちらの順でも残らない)。
           * ctx.path は basePath(/auth)を含まない endpoint の path(上の before と同じ)
           *
           * B129(spec §3.1・Q13): 確かめが通ったら、/sign-in/email のときだけ auth.password_login を「後」の書き方で記録する
           * (/sign-up/email = 初期設定・招待の Bearer 無しの受諾は、setup.complete・invitation.accept の行がある)。断ったログインは記録しない。
           * 書けなくてもログインは成功のまま(ログだけ)。操作した人の控え(メール・名前)は確かめの 1 文で一緒に読む(往復は記録の +1 だけ)。
           * ctx は endpoint の文脈。1.7.15 では databaseHooks が AsyncLocalStorage の `tryGetCurrentAuthEndpointContext()`(@better-auth/core の
           * context/endpoint-context.mjs。db/with-hooks.mjs が呼ぶ)から取り、path は dispatchAuthEndpoint(api/dispatch.mjs)が `endpoint.path` から入れる
           * (1.4.21 は getCurrentAuthContext() で、path は toAuthEndpoints が入れた)。path の入り方が変わると、loginMethod の印と同じくここも
           * 記録しなくなる。hooks_see_endpoint_path_on_1_7_b179(test/better-auth-storage.test.ts)と password_login_is_recorded(test/audit-after.test.ts)が落ちて気づける
           */
          after: async (session, ctx) => {
            if (!session || (ctx?.path !== "/sign-in/email" && ctx?.path !== "/sign-up/email")) return;
            const r = await sql<{ n: number; email: string | null; name: string | null }>`
              select count(*) as n, (select email from "user" where id = ${session.userId}) as email, (select name from "user" where id = ${session.userId}) as name
              from account where "userId" = ${session.userId} and "providerId" = 'credential'`.execute(db);
            const row = r.rows[0];
            if (Number(row?.n ?? 0) > 0) {
              if (ctx?.path === "/sign-in/email") {
                await writeAuditAfterDb(env.DB, () => {
                  if (typeof row?.email !== "string") throw new Error("no user for the session");
                  const user = { id: session.userId, email: row.email, name: row.name ?? "" };
                  return { actor: actorFromUser(user, "password"), event: { action: "auth.password_login", target: { type: "user", id: user.id, label: user.email } } };
                });
              }
              return;
            }
            await sql`delete from session where id = ${session.id}`.execute(db);
            throw new APIError("UNAUTHORIZED", { message: "password_login_disabled" });
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
        // B179(D2): 1.5 から持ち主の列は referenceId。今の "userId" の列(user への外部キー・on delete cascade・索引)をそのまま使うため列名を読み替える。
        // control の SQL も apikey."userId" を直接読む。configId の列は migrations/0025 が足す(既存の鍵は 'default')
        schema: { apikey: { fields: { referenceId: "userId" } } },
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
