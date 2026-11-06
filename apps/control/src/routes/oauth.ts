import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "../app";
import { googleConfigured } from "../auth";
import { ApiError, validationFailed } from "../errors";
import { issueHandoff, redeemHandoff } from "../handoff";
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

/** 封筒の理由のうち、ログイン画面に出す code(auth.ts の databaseHooks が投げる APIError の message)。それ以外は oauth_failed */
const DENIED_CODES = new Set(["not_invited", "email_not_verified"]);

/**
 * Better Auth が 302 ではなく封筒を返したときの理由(`/login?error=…` に載せる値)。
 * 1.4.21 では、**セッション作成**が断られた場合(既に user 行がある人が Member でも被招待者でもなくなった = auth.ts の session フック)だけが
 * endpoint の外まで APIError が上がって 403 の封筒になり、新しい user の作成が断られた場合は `?error=<message>` の 302 で戻っていた。
 * B179(D14): 1.7.15 の callback(`api/routes/callback.mjs`)は、APIError の `body.code` があるときだけ 302 に直し、無ければ投げ直す。
 * auth.ts のフックの APIError は message だけなので、user の作成(not_invited・email_not_verified)もセッションの作成(not_invited)も
 * 403 の封筒になる。ここで message を見て、管理画面に渡る code を 1.4.21 と同じにする(知らない理由は oauth_failed)
 */
async function deniedCode(res: Response): Promise<string> {
  if (res.status !== 403) return "oauth_failed";
  const body = (await res.json().catch(() => null)) as { message?: unknown; code?: unknown } | null;
  for (const v of [body?.message, body?.code]) {
    const code = typeof v === "string" ? v.toLowerCase() : "";
    if (DENIED_CODES.has(code)) return code;
  }
  return "oauth_failed";
}

/**
 * B179(D14): Better Auth の失敗の戻り先(`${AB_ADMIN_URL}/login?error=…`)の code を、管理画面が知っている形にそろえる。
 * 1.7 は `body.code` を持つ APIError を `error=<code>`(`NOT_INVITED` のような大文字のことがある)、`message` を `error_description` に載せて戻す
 * (1.4.21 は `message` を `error=` に載せていた)。今の control のフックは code を持たない APIError を投げるので封筒で来る(上の deniedCode)が、
 * code を持つ形に変わっても管理画面に渡る値が変わらないよう、ここで小文字にそろえる。
 * 小文字にするだけで今の code(`not_invited`・`email_not_verified`・`account_not_linked`・`access_denied`)と同じになるので、対応表は持たない。
 * `error_description` は画面で使わず、Better Auth の内部の文言を管理画面の URL に出さないため落とす。ログイン画面以外の戻り先は触らない
 */
export function normalizeLoginError(location: string, adminUrl: string): string {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return location;
  }
  const login = new URL("/login", adminUrl);
  if (target.origin !== login.origin || target.pathname !== login.pathname) return location;
  const error = target.searchParams.get("error");
  if (error !== null) target.searchParams.set("error", error.toLowerCase());
  target.searchParams.delete("error_description");
  return target.toString();
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
 * 失敗の 302(`${AB_ADMIN_URL}/login?error=…`)は code を小文字にそろえて返す(normalizeLoginError)
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
    // state が無いとき、1.4.21 の Better Auth は `?state=state_not_found`(error= ではない)で戻すので画面が無言になった。1.7.15 は
    // `?error=state_not_found`(api/routes/callback.mjs)で戻すが、管理画面が知らない code なので、どちらにしても先に捕まえて oauth_failed にそろえる
    const state = c.req.query("state");
    if (!state) return redirect(loginError("oauth_failed"));
    // start が出した state と同じか(1.4.21 の Better Auth はこの構成では照合しなかった。1.7.15 は照合するが二重にしておく。上の STATE_COOKIE のコメント)。
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
      return redirect(normalizeLoginError(location, c.env.AB_ADMIN_URL)); // Better Auth が組んだ失敗の戻り先(errorCallbackURL か onAPIError.errorURL)
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
