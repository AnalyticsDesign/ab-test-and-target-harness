import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../app";
import { googleConfigured } from "../auth";
import { ApiError, validationFailed } from "../errors";
import { issueHandoff, redeemHandoff } from "../handoff";
import { isServerFaultCode, loginFailureCode, loginFailurePage, type LoginFailureCode } from "../login-failure";
import { errorResponses } from "../openapi";

/** ログイン後の戻り先として受けるのは招待ページだけ(open redirect を作らない)。admin の lib/safe-next.ts と同じ式(両側の literal をテストで固定。B21) */
export const NEXT_RE = /^\/invite\/[A-Za-z0-9_-]{1,64}$/;
/** admin が Cookie に入れた flow ID(admin の lib/oauth-flow.ts と同じ式。両側の literal をテストで固定。B21)。control は形だけ見て callbackURL に載せて返す */
export const FLOW_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const oauthRoutes = new Hono<AppEnv>();

/**
 * state を「このブラウザが始めたログイン」に結びつけるための Cookie。
 * Better Auth 1.4.21 は state を暗号化 Cookie に持たせる構成(R15)だと、戻ってきた `state` クエリを何とも突き合わせなかった
 * (`state.mjs` の parseGenericState の cookie 分岐は Cookie を復号して期限を見るだけ)。
 * そのため「攻撃者の code + 被害者の state Cookie」で callback を踏ませる login CSRF は Google 側の PKCE だけが止めていた。
 * B179: 1.7.15 は照合する(parseGenericState の cookie 分岐が、用途ごとの鍵 `oauth-state-cookie` で復号した Cookie の中の `oauthState` と
 * `state` クエリが違えば `state_security_mismatch` で断る)ので、今は Better Auth 自身も止める。それでもこの Cookie は残す = 独立の二重の守り
 * (Better Auth の設定・版が変わっても、control の入口で state を start が出したものに結びつけ続ける)。
 * 確かめ: test/oauth.test.ts の「start binds the state to this browser, and the callback refuses a state that is not the one it issued」(1.7.15 で緑。
 * Better Auth の Cookie が揃っていて結びつけ Cookie だけ無い要求は control だけが断る)。
 * ここで start が出した state のハッシュを別の Cookie に置き、callback で一致を必須にする。
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

/** Better Auth の封筒は認可を断った 403 の理由だけを使う。内部のメッセージは画面へ渡さない。 */
async function deniedCode(res: Response): Promise<LoginFailureCode> {
  if (res.status !== 403) return "oauth_failed";
  const body = (await res.json().catch(() => null)) as { message?: unknown; code?: unknown } | null;
  for (const raw of [body?.message, body?.code]) {
    const code = loginFailureCode(typeof raw === "string" ? raw : null);
    if (code === "not_invited" || code === "email_not_verified") return code;
  }
  return "oauth_failed";
}

/** ブラウザで開く失敗の応答は JSON ではなく固定の HTML。 */
const failureHtml = { description: "ログインできませんでした(理由と、やり直し方を画面に出す)", content: { "text/html": { schema: { type: "string" as const } } } };

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
      "クエリ `flow` は管理画面が発行した値で、ログイン後にそのまま管理画面へ返す。無い・形が違うときは control の上の「ログインできませんでした」の画面(400)で止まる。`next` は招待ページ(`/invite/<id>`)だけを受け、ログイン後の戻り先になる。それ以外の値は無視する",
    security: [],
    responses: { 302: { description: "Google の認可画面へ" }, 400: failureHtml, 429: failureHtml, 500: failureHtml, 503: failureHtml },
  }),
  async (c) => {
    const rawNext = c.req.query("next");
    const next = rawNext && NEXT_RE.test(rawNext) ? rawNext : null;
    const flow = c.req.query("flow");
    if (!flow || !FLOW_RE.test(flow)) return loginFailurePage("oauth_failed");
    if (!googleConfigured(c.env)) return loginFailurePage("google_not_configured");
    const back = new URL("/api/session/oauth", c.env.AB_ADMIN_URL);
    back.searchParams.set("flow", flow);
    if (next) back.searchParams.set("next", next);
    try {
      const { headers, response } = await c.get("auth").api.signInSocial({
        body: { provider: "google", callbackURL: back.toString(), disableRedirect: true },
        returnHeaders: true,
      });
      if (!response.url) return loginFailurePage("google_not_configured");
      const state = new URL(response.url).searchParams.get("state");
      if (!state) return loginFailurePage("google_not_configured");
      const out = new Headers({ location: response.url, "cache-control": "no-store" });
      for (const v of headers.getSetCookie()) out.append("set-cookie", v);
      out.append("set-cookie", stateCookie(await sha256Hex(state), STATE_TTL_SEC, isHttps(c.req.url)));
      return new Response(null, { status: 302, headers: out });
    } catch (e) {
      console.error("oauth start: failed to start Google sign-in", e);
      return loginFailurePage("oauth_failed", { status: 500 });
    }
  },
);

/**
 * Google からの戻り。Better Auth の handler に処理させ、成功(`set-auth-token` 付きの 302)なら
 * セッション Cookie を捨てて使い捨てコードを発行し、admin の BFF へ渡す。control のオリジンにセッション Cookie を残さない。
 * 失敗は Better Auth の戻り先を渡さず、control の固定の画面で終える(B231)
 */
oauthRoutes.get(
  "/auth/callback/google",
  describeRoute({
    tags: ["auth"],
    summary: "Google ログインの戻り先(Google がブラウザをここへ戻す。成功なら管理画面へ 302)",
    security: [],
    responses: { 302: { description: "管理画面へ(使い捨てコード付き)" }, ...Object.fromEntries([400, 403, 429, 500].map(status => [status, { ...failureHtml, description: "ログインできませんでした(理由のコードを画面に出す。管理画面へは戻さない)" }])) },
  }),
  async (c) => {
    const auth = c.get("auth");
    const out = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    // 成功でも失敗でも、ブラウザと state の結びつけは 1 回限り。
    out.append("set-cookie", stateCookie("", 0, isHttps(c.req.url)));
    const fail = (code: LoginFailureCode, status?: 400 | 403 | 429 | 500 | 503) => loginFailurePage(code, { status, headers: out });
    const state = c.req.query("state");
    if (!state) return fail("oauth_failed");
    const bound = readStateCookie(c.req.header("cookie"));
    // 不正な state は Better Auth と D1 に届く前に断る。
    if (!bound || bound !== (await sha256Hex(state))) return fail("oauth_failed");
    try {
      const res = await auth.handler(c.req.raw);
      // 失効だけを通し、control のオリジンにセッション Cookie を残さない。
      for (const v of res.headers.getSetCookie()) if (/max-age=0/i.test(v)) out.append("set-cookie", v);
      const sessionToken = res.headers.get("set-auth-token");
      const location = res.headers.get("location");
      if (res.status >= 500) {
        console.error("oauth callback: Better Auth returned a server error", res.status);
        return fail("oauth_failed", 500);
      }
      if (res.status !== 302 || !location) return fail(await deniedCode(res));
      let target: URL;
      try {
        target = new URL(location);
      } catch {
        return fail("oauth_failed");
      }
      const expected = new URL("/api/session/oauth", c.env.AB_ADMIN_URL);
      const isSuccessTarget = target.origin === expected.origin && target.pathname === expected.pathname;
      if (sessionToken && isSuccessTarget) {
        const code = await issueHandoff(c.get("db"), sessionToken);
        target.searchParams.set("code", code);
        // 管理画面へ Location を返せる唯一の枝。認証と利用資格が通り、使い捨てコードを出せたときだけ。
        out.set("location", target.toString());
        return new Response(null, { status: 302, headers: out });
      }
      if (sessionToken || isSuccessTarget) {
        console.error("oauth callback: inconsistent success response");
        return fail("oauth_failed", 500);
      }
      const raw = target.searchParams.get("error");
      if (isServerFaultCode(raw)) {
        console.error("oauth callback: Better Auth reported an internal fault", raw);
        return fail("oauth_failed", 500);
      }
      return fail(loginFailureCode(raw));
    } catch (e) {
      console.error("oauth callback: failed to complete Google sign-in", e);
      return fail("oauth_failed", 500);
    }
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
