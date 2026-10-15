import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../app";
import { googleConfigured } from "../auth";
import { ApiError, validationFailed } from "../errors";
import { issueHandoff, redeemHandoff } from "../handoff";
import { errorResponses } from "../openapi";

/** ログイン後の戻り先として受けるのは招待ページだけ(open redirect を作らない)。admin の lib/safe-next.ts と同じ式 */
export const NEXT_RE = /^\/invite\/[A-Za-z0-9_-]{1,64}$/;
/** admin が Cookie に入れた flow ID(admin の lib/oauth-flow.ts と同じ式)。control は形だけ見て callbackURL に載せて返す */
export const FLOW_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const oauthRoutes = new Hono<AppEnv>();

/**
 * state を「このブラウザが始めたログイン」に結びつけるための Cookie。
 * Better Auth 1.4.21 は state を暗号化 Cookie に持たせる構成(R15)だと、戻ってきた `state` クエリを何とも突き合わせない
 * (`state.mjs` の parseGenericState の cookie 分岐は Cookie を復号して期限を見るだけ)。
 * そのため「攻撃者の code + 被害者の state Cookie」で callback を踏ませる login CSRF は Google 側の PKCE だけが止めている。
 * ここで start が出した state のハッシュを別の Cookie に置き、callback で一致を必須にして二重にする。
 * セッションではないので「control のオリジンにセッション Cookie を残さない」制約には触れない。
 * callback のパスにだけ送られ、10 分で切れ、応答では必ず失効させる
 */
const STATE_COOKIE = "wtt_oauth_state";
const CALLBACK_PATH = "/auth/callback/google";
const STATE_TTL_SEC = 600;

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

const stateCookie = (value: string, maxAge: number, https: boolean) =>
  `${STATE_COOKIE}=${value}; Path=${CALLBACK_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}`;

const isHttps = (url: string) => new URL(url).protocol === "https:";

/**
 * Better Auth が 302 ではなく封筒を返したときの理由(`/login?error=…` に載せる値)。
 * 新規 user の作成が断られた場合は redirect に化けて戻るが、**セッション作成**が断られた場合
 * (既に user 行がある人が Member でも被招待者でもなくなった = auth.ts の session フック)は
 * endpoint の外まで APIError が上がり、403 の封筒になる。その 1 種類だけを見分けて画面に理由を出す
 */
async function deniedCode(res: Response): Promise<string> {
  if (res.status !== 403) return "oauth_failed";
  const body = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
  return body?.message === "not_invited" || body?.code === "NOT_INVITED" ? "not_invited" : "oauth_failed";
}

/** 送られてきた Cookie ヘッダから 1 つ取り出す(Hono の getCookie を使わず、この 1 つだけを見る) */
const readStateCookie = (header: string | undefined): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === STATE_COOKIE) return rest.join("=");
  }
  return null;
};

/**
 * 決定 46: Google ログインの入口。ブラウザの top-level 遷移で開く(state Cookie を control のオリジンに張るため、BFF の裏では呼べない)。
 * Better Auth の POST /auth/sign-in/social は公開せず、callbackURL をここで固定する
 */
oauthRoutes.get(
  "/auth/google/start",
  describeRoute({
    tags: ["auth"],
    summary: "Google ログインを始める(管理画面から開く。Google の認可画面へ 302)",
    description:
      "クエリ `flow` は管理画面が発行した値で、ログイン後にそのまま管理画面へ返す(無い・形が違うときは管理画面へ戻して作り直す)。`next` は招待ページ(`/invite/<id>`)だけを受け、ログイン後の戻り先になる。それ以外の値は無視する",
    security: [],
    responses: { 302: { description: "Google の認可画面へ(flow が無ければ管理画面へ)" }, ...errorResponses(429, 503) },
  }),
  async (c) => {
    const rawNext = c.req.query("next");
    const next = rawNext && NEXT_RE.test(rawNext) ? rawNext : null;
    const flow = c.req.query("flow");
    if (!flow || !FLOW_RE.test(flow)) {
      // control を直接開いた場合。flow は admin の Cookie と対なので、admin に作り直させる
      const mint = new URL("/api/session/google", c.env.AB_ADMIN_URL);
      if (next) mint.searchParams.set("next", next);
      return new Response(null, { status: 302, headers: { location: mint.toString(), "cache-control": "no-store" } });
    }
    if (!googleConfigured(c.env)) {
      throw new ApiError(503, "google_not_configured", { hint: "control に Google の OAuth クライアント(ID と secret)を設定して再デプロイしてください" });
    }
    const back = new URL("/api/session/oauth", c.env.AB_ADMIN_URL);
    back.searchParams.set("flow", flow);
    if (next) back.searchParams.set("next", next);
    const { headers, response } = await c.get("auth").api.signInSocial({
      body: {
        provider: "google",
        callbackURL: back.toString(),
        errorCallbackURL: new URL("/login", c.env.AB_ADMIN_URL).toString(),
        disableRedirect: true,
      },
      returnHeaders: true,
    });
    if (!response.url) throw new ApiError(503, "google_not_configured", { detail: "signInSocial returned no url" });
    const out = new Headers({ location: response.url, "cache-control": "no-store" });
    for (const v of headers.getSetCookie()) out.append("set-cookie", v);
    const state = new URL(response.url).searchParams.get("state");
    if (!state) throw new ApiError(503, "google_not_configured", { detail: "signInSocial returned no state" });
    out.append("set-cookie", stateCookie(await sha256Hex(state), STATE_TTL_SEC, isHttps(c.req.url)));
    return new Response(null, { status: 302, headers: out });
  },
);

/**
 * Google からの戻り。Better Auth の handler に処理させ、成功(`set-auth-token` 付きの 302)なら
 * セッション Cookie を捨てて使い捨てコードを発行し、admin の BFF へ渡す。control のオリジンにセッション Cookie を残さない。
 * 失敗の 302(`${AB_ADMIN_URL}/login?error=…`)はそのまま返す
 */
oauthRoutes.get(
  "/auth/callback/google",
  describeRoute({
    tags: ["auth"],
    summary: "Google ログインの戻り先(Google がブラウザをここへ戻す。管理画面へ 302)",
    security: [],
    responses: { 302: { description: "管理画面へ(成功なら使い捨てコード付き、失敗なら /login?error=…)" }, ...errorResponses(429) },
  }),
  async (c) => {
    const auth = c.get("auth");
    const loginError = (code: string) => {
      const u = new URL("/login", c.env.AB_ADMIN_URL);
      u.searchParams.set("error", code);
      return u.toString();
    };
    const out = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    // 結びつけ用の Cookie はこの応答で必ず失効させる(成功でも失敗でも 1 回限り)
    out.append("set-cookie", stateCookie("", 0, isHttps(c.req.url)));
    const redirect = (location: string) => {
      out.set("location", location);
      return new Response(null, { status: 302, headers: out });
    };
    // Better Auth は state が無いとき `?state=state_not_found`(error= ではない)で戻すので、画面が無言になる。先に捕まえる
    const state = c.req.query("state");
    if (!state) return redirect(loginError("oauth_failed"));
    // start が出した state と同じか(Better Auth はこの構成では照合しない。上の STATE_COOKIE のコメント)。
    // Better Auth に渡す前に断つので、攻撃者の code が交換されることもない
    const bound = readStateCookie(c.req.header("cookie"));
    if (!bound || bound !== (await sha256Hex(state))) return redirect(loginError("oauth_failed"));
    const res = await auth.handler(c.req.raw);
    // 失効させる Cookie(state)だけ通す。セッション Cookie は control のオリジンに置かない
    for (const v of res.headers.getSetCookie()) if (/max-age=0/i.test(v)) out.append("set-cookie", v);
    const sessionToken = res.headers.get("set-auth-token");
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) return redirect(loginError(await deniedCode(res)));
    const expected = new URL("/api/session/oauth", c.env.AB_ADMIN_URL);
    const target = new URL(location);
    const isSuccessTarget = target.origin === expected.origin && target.pathname === expected.pathname;
    if (!sessionToken) {
      // 成功の戻り先なのにセッショントークンが無い = bearer の after hook が効いていない(前提 B の崩れ)。原因をログに残す
      if (isSuccessTarget) {
        console.error("oauth callback: success redirect without set-auth-token");
        return redirect(loginError("oauth_failed"));
      }
      return redirect(location); // Better Auth が組んだ失敗の戻り先(errorCallbackURL か onAPIError.errorURL)
    }
    if (!isSuccessTarget) return redirect(loginError("oauth_failed"));
    // 発行に失敗しても control のオリジンに JSON の封筒を出さない(利用者はログイン画面に戻す)
    let code: string;
    try {
      code = await issueHandoff(c.get("db"), sessionToken);
    } catch (e) {
      console.error("oauth callback: failed to issue the hand-off code", e);
      return redirect(loginError("oauth_failed"));
    }
    target.searchParams.set("code", code);
    return redirect(target.toString());
  },
);

const ExchangeBody = z.strictObject({ code: z.string().min(16).max(200) });
const ExchangeResult = z.object({ token: z.string().describe("セッショントークン(Bearer で使う)") });

/**
 * 使い捨てコードをセッショントークンに引き換える(admin の BFF がサーバー側から呼ぶ)。1 分・1 回限り。
 * 資格はコードそのもの。Cookie を使わない自前ルートなので、Better Auth の origin 検査の対象ではない
 */
oauthRoutes.post(
  "/auth/handoff/exchange",
  describeRoute({
    tags: ["auth"],
    summary: "Google ログイン直後の使い捨てコードをセッショントークンに引き換える(管理画面のサーバー側が呼ぶ。1 分・1 回限り)",
    security: [],
    responses: {
      200: { description: "セッショントークン", content: { "application/json": { schema: resolver(ExchangeResult) } } },
      ...errorResponses(400, 422, 429),
    },
  }),
  validator("json", ExchangeBody, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const token = await redeemHandoff(c.get("db"), c.req.valid("json").code);
    if (!token) throw new ApiError(400, "invalid_handoff", { hint: "もう一度ログインしてください" });
    return c.json({ token }, 200, { "cache-control": "no-store" });
  },
);
