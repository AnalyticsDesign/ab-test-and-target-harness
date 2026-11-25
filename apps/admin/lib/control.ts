import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { API_CONTRACT_VERSION, CLIENT_IP_HEADER, CLIENT_VERSION_HEADER, lowerClientVersion } from "@wtt/core";
import { controlBinding } from "./control-binding";
import { sendOncePerRender } from "./control-dedupe";
import type { SessionUser } from "./types";

/**
 * control の公開 URL。**呼ばれるたびに** process.env を動的キーで読む。
 * 定数にしない理由: vinext(Vite)は production build でも .env.local を読むため、モジュール読み込み時に
 * `process.env.AB_CONTROL_URL` と書くと開発者の localhost 値がビルドに焼き込まれうる。動的キーなら define 置換の対象にならず、
 * Workers 起動時に vars から埋まった process.env(nodejs_compat + compatibility_date >= 2025-04-01)を読む
 */
export function controlUrl(): string {
  const key = "AB_CONTROL_URL";
  return (process.env[key] ?? "http://localhost:8788").replace(/\/+$/, "");
}

/**
 * セッション Cookie の名前。https では `__Host-` を付ける: 管理画面を自分のドメインのサブドメインに置く構成では、
 * 同じ登録ドメインの兄弟ホスト(設置サイト)が親ドメイン宛てに同じ名前の Cookie を置けて、どちらの値が使われるかは
 * Cookie の並びしだいになる(攻撃者のセッションで作業させる・でたらめな値で締め出す)。`__Host-` の名前はブラウザが
 * 「このホストが Secure・Path=/・Domain 無しで置いたもの」しか受け付けないので、植えられた Cookie はこの名前にならない。
 * http(手元の `next dev`・E2E)では `__Host-` が使えない(Secure が必須)ので今の名前のまま。
 * https では `__Host-` の名前**だけ**を読み、今の名前へは戻らない(戻ると、ログアウト中の人に植えられた今の名前の Cookie が使われる)
 */
export const sessionCookieName = (https: boolean): string => (https ? "__Host-wtt_session" : "wtt_session");

/** control への要求の名乗り。版(x-wtt-client-version)と接続元 IP(x-wtt-client-ip)。付けるのは controlRequest だけ */
export type ControlRequestInit = RequestInit & {
  /** 利用者の接続元 IP。null / 未指定なら x-wtt-client-ip を付けない(空の値は送らない) */
  clientIp?: string | null;
  /** 名乗る版。未指定ならこの admin の版(サーバー側の呼び出し)。ブラウザから受けた要求は forwardedFrom(req) の値を渡す */
  clientVersion?: number;
};

/** ローカル E2E の認証診断。記録する値は固定のパス、時刻、status、例外の種類だけ。 */
function recordControlDiagnostic(path: string, status: number, error?: unknown): void {
  if (path !== "/me" && path !== "/login-options") return;
  const key = "WTT_E2E_CONTROL_DIAGNOSTICS";
  if (process.env[key] !== "1") return;
  const name = error instanceof Error ? error.name : "Other";
  const exception = error === undefined ? null
    : ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(name) ? name
    : "Other";
  console.info(`[wtt:e2e-control] ${JSON.stringify({ at: new Date().toISOString(), path, status, exception })}`);
}

/**
 * control を呼ぶ唯一の入口(plan12 K8。ほかの場所に fetch を書くと test/control-headers.test.ts が落ちる)。
 * - 版(backlog D13 / 決定 56 (1)・plan12 K3)と接続元 IP は、ここで付け直す。呼び出し元の headers に同じ名前があっても上書き・削除する
 *   (ブラウザが名乗った x-wtt-client-ip を control に渡さない。control の BFF の入口はこの値を接続元 IP として信じる)
 * - binding(wrangler.jsonc の services)があれば `env.CONTROL.fetch`、無い構成(手元の `next dev` を含む)だけ公開 URL の fetch。
 *   binding があるのに throw したら null(呼び出し元は 502 control_unreachable にする)で、公開 URL には戻さない
 *   (黙って戻すと、利用者ごとのレート制限の枠が気づかれずに全員 1 枠に戻るため)
 * - ページの描画中の同じ GET は 1 回だけ送る(`sendOncePerRender`。書き込みはまとめず、その要求の覚えを捨てる)
 * - 届かなかったときは throw せず null を返す。binding の相手が無いときに返る 503 などの応答は、そのまま返す(手を加えない)
 */
export async function controlRequest(path: string, init: ControlRequestInit = {}): Promise<Response | null> {
  const { clientIp, clientVersion = API_CONTRACT_VERSION, ...rest } = init;
  const binding = await controlBinding();
  // ヘッダーの組み立ても try の中に置く: 利用者が入力した値(初回セットアップの x-setup-token など)に改行や全角の文字が
  // 入っていると `new Headers` / `set` が同期で TypeError を投げる。投げさせると Route Handler が封筒でない 500 になるので、
  // 届かないときと同じ null(= 呼び出し元の 502 の封筒)にする
  try {
    const headers = new Headers(rest.headers);
    headers.set(CLIENT_VERSION_HEADER, String(clientVersion));
    headers.delete(CLIENT_IP_HEADER);
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
    const url = `${controlUrl()}${path}`;
    const requestInit: RequestInit = { ...rest, headers, cache: "no-store" };
    // ページの描画中の同じ GET は 1 回だけ送る(lib/control-dedupe.ts。binding の fetch は vinext の fetch のまとめの外を通るため)
    return await sendOncePerRender(url, requestInit, async () => {
      try {
        const response = binding ? await binding.fetch(new Request(url, requestInit)) : await fetch(url, requestInit);
        recordControlDiagnostic(path, response.status);
        return response;
      } catch (error) {
        recordControlDiagnostic(path, 502, error);
        return null;
      }
    });
  } catch (error) {
    recordControlDiagnostic(path, 502, error);
    return null;
  }
}

/**
 * BFF が受けた要求の接続元 IP。Cloudflare が付ける cf-connecting-ip だけを見る(Cloudflare が接続元で上書きするのでブラウザは偽れない)。
 * ブラウザが名乗れる x-wtt-client-ip は見ない。空なら null(手元の開発など、Cloudflare を通らない要求)
 */
export function clientIpOf(headers: Headers): string | null {
  const ip = headers.get("cf-connecting-ip")?.trim();
  return ip ? ip : null;
}

/**
 * ブラウザから受けた要求を control へ渡すときの名乗り(Route Handler 用。controlRequest の init に混ぜる)。
 * 版は自分とブラウザの小さいほう(plan12 K3): admin を更新した後も開いたままの古いタブは名乗らない = 0 になり、
 * その書き込みを control が 426 で止められる。宛先が判定の対象外(/auth/* など)なら 0 でも困らない
 */
export function forwardedFrom(req: Request): { clientIp: string | null; clientVersion: number } {
  return { clientIp: clientIpOf(req.headers), clientVersion: lowerClientVersion(API_CONTRACT_VERSION, req.headers.get(CLIENT_VERSION_HEADER)) };
}

/**
 * 手元の開発で使うホスト名(ポートは問わない)。`[::1]` は host ヘッダーでは角かっこ付きで届く。
 * 手元の http で動かせるのは、これらの名前から開いたときだけ。LAN・Tailscale の名前や 0.0.0.0 から http で開くと、
 * Route Handler は req.url で http と見て今の名前の Cookie を張り、Server Component は(明示が無いので)`__Host-` の名前を読むため、ログインがループする
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** host ヘッダーのホスト名部分(ポートを除く。IPv6 は角かっこごと)。無ければ null */
function hostnameOf(host: string | null): string | null {
  const h = host?.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h : h.slice(0, close + 1);
  }
  return h.split(":")[0] ?? null;
}

/** `cf-visitor` の scheme、なければ `x-forwarded-proto` が明示している scheme(https / http 以外・読めない値は無いものとする) */
function explicitScheme(h: Headers): "https" | "http" | null {
  const visitor = h.get("cf-visitor");
  if (visitor) {
    try {
      const scheme = (JSON.parse(visitor) as { scheme?: unknown } | null)?.scheme;
      if (scheme === "https" || scheme === "http") return scheme;
    } catch {
      // 読めない値は無いものとして x-forwarded-proto を見る
    }
  }
  const proto = forwardedProto(h);
  return proto === "https" || proto === "http" ? proto : null;
}

/**
 * Server Component から見た、いま描いている画面の要求が https か。Server Component には要求の URL が渡らない
 * (vinext の `headers()` は要求のヘッダーだけ。手元の preview・`next dev` で中身を確かめた)ので、ヘッダーから決める。
 * **既定は https**。http とするのは次のどちらかのときだけ:
 * 1. `cf-visitor` の scheme(Cloudflare が利用者との接続の scheme を入れる)か `x-forwarded-proto` が明示的に http
 *    (`next dev` は自分で `x-forwarded-proto: http` を入れる)
 * 2. 明示が無く、host のホスト名が手元(`localhost`・`127.0.0.1`・`[::1]`)。E2E と手元の preview(workerd)は
 *    どちらのヘッダーも付けないので、ここで http になる
 * 明示の https は host が手元でも https とする(手元で https を試すときに、張る側の Route Handler(req.url が https)と名前がそろう)。
 * 既定を https に倒すのは、本番の Workers にこれらのヘッダーが付くかを手元で確かめられないため: 付かなくても、本番では
 * Route Handler が張る `__Host-` の名前を読むので、張る名前と読む名前が食い違って全員がログインを繰り返すことにならない。
 * ブラウザが名乗れる値でもよい理由: ここで決めるのは**読む Cookie の名前**だけで、Cookie を張るのは req.url で決める Route Handler。
 * 守る相手(兄弟ホスト)が操れるのは被害者の Cookie で、被害者のブラウザが送るヘッダーではない(別オリジンの fetch が
 * これらのヘッダーを付けると CORS の事前確認になり、管理画面は許可しないので本体の要求は送られない)。被害者の本番への要求は
 * http を名乗らず、host も手元にならないので、本番では常に `__Host-` の名前だけを読む。自分の要求で偽っても、自分が読む名前が変わるだけ。
 * 「http を名乗らない」は、custom ドメインなら Always Use HTTPS を有効にしている前提(workers.dev は `.dev` が HSTS preload で常に https)。
 * http で開かせられる構成では、そこでは今の名前の Cookie が張られ・読まれるので、`__Host-` の守りの外になる
 */
export function httpsFromHeaders(h: Headers): boolean {
  const scheme = explicitScheme(h);
  if (scheme) return scheme === "https";
  const hostname = hostnameOf(h.get("host"));
  return !(hostname !== null && LOCAL_HOSTNAMES.has(hostname));
}

/**
 * Server Component がいま読むべきセッション Cookie の名前(`httpsFromHeaders`)。headers() が読めないときも https の名前にする:
 * 読めないのは要求の外で呼ばれたとき(本番の描画では起きない想定)で、既定を https に倒す理由は httpsFromHeaders と同じ
 */
async function renderingSessionCookieName(): Promise<string> {
  try {
    return sessionCookieName(httpsFromHeaders(await headers()));
  } catch {
    return sessionCookieName(true);
  }
}

/** Server Component から見た、いま描いている画面の要求の接続元 IP(読めなければ null) */
export async function requestClientIp(): Promise<string | null> {
  try {
    return clientIpOf(await headers());
  } catch {
    return null;
  }
}

/**
 * control に届かなかったときの封筒。BFF の応答は必ず封筒である(= `lib/client.ts` の `api` が
 * 常に `ApiClientError` に変換できる)という約束を、control 側の障害でも破らないための 502
 */
export const controlUnreachable = (): Response =>
  Response.json({ error: "control_unreachable", message: "control に接続できませんでした", hint: "しばらく待ってから再試行してください" }, { status: 502 });

/**
 * controlFetch に渡されたパスが、そのままの宛先で control に届くか。画面の URL の値(vinext がデコードした後の値)を
 * エンコードせずに埋めるので、`../../../auth/get-session` のような値で宛先が変わりうる(get-session の応答にはセッションの
 * トークンが載り、それが画面のデータとしてブラウザに渡る)。見るのは `?`・`#` より前だけ(query は通す)。次のどれかなら断る:
 * - 先頭が `/` でない
 * - `%2F`・`%2E`・`%5C`(大小文字を問わず)・`\` を含む(URL の解釈で `/`・`.` として扱われうる)
 * - `/` で区切ったセグメントに `.`・`..`・空がある
 * - control の URL に付けて解釈した pathname が、渡したものと変わる(上で拾えない正規化の取りこぼしの保険)
 */
function isSafeControlPath(path: string): boolean {
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  if (!pathname.startsWith("/")) return false;
  if (/%2f|%2e|%5c|\\/i.test(pathname)) return false;
  if (pathname.slice(1).split("/").some((s) => s === "" || s === "." || s === "..")) return false;
  try {
    const base = new URL(controlUrl()).pathname.replace(/\/$/, "");
    return new URL(`${controlUrl()}${pathname}`).pathname === `${base}${pathname}`;
  } catch {
    return false;
  }
}

/**
 * サーバーコンポーネント / Route Handler から control を呼ぶ。Cookie のセッショントークンを Bearer にする(spec §13.4)。
 * ブラウザを介さない呼び出しなので、版はこの admin の版をそのまま名乗る(plan12 K3)。接続元 IP は画面の要求の cf-connecting-ip。
 * control に届かない場合も throw せず `{ status: 502 }` を返す(サーバーコンポーネントを 500 で落とさない)
 */
export async function controlFetch<T>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  // パスの門は Cookie を読む前(断る要求には Bearer を作らない)。呼び出し元(app/w/** の各ページ・lib/loaders.ts)は
  // 画面の URL の値をそのまま埋めるので、ここで一括に止める。400 を受けた画面は status を見て notFound() などで止まる
  if (!isSafeControlPath(path)) return { status: 400, data: null as T };
  const token = (await cookies()).get(await renderingSessionCookieName())?.value;
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  const res = await controlRequest(path, { ...init, headers, clientIp: await requestClientIp() });
  if (!res) return { status: 502, data: null as T };
  const data = (res.status === 204 ? null : await res.json().catch((error) => {
    recordControlDiagnostic(path, res.status, error);
    return null;
  })) as T;
  return { status: res.status, data };
}

/**
 * ログイン中の利用者。取れなければ /login へ redirect する(throw)。
 * React の cache で包み、同じ描画(1 リクエスト)の中の layout とページが 1 つの結果(redirect の throw も含む)を使う(admin speed B)
 */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const r = await controlFetch<SessionUser>("/me");
  if (r.status !== 200) redirect("/login");
  return r.data;
});

/**
 * セッション Cookie の属性(Global Constraints)。HttpOnly なので JS からは読めず、BFF だけが Bearer に載せ替える。
 * SameSite=Lax は同一オリジンの fetch には常に付き、他サイトからの POST には付かない。
 * 名前は `sessionCookieName(secure)`(https = `__Host-`。Secure・Path=/・Domain 無しはその条件でもある)
 */
export function sessionCookie(token: string, secure: boolean) {
  return { name: sessionCookieName(secure), value: token, httpOnly: true, sameSite: "lax" as const, path: "/", secure, maxAge: 60 * 60 * 24 * 7 };
}

/**
 * セッション Cookie を消すときは、張ったときと同じ名前・属性で maxAge 0 を set する。
 * `cookies().delete(name)` は Secure を付けないので、`__Host-` の Cookie はブラウザが消さない
 */
export const expiredSessionCookie = (secure: boolean) => ({ ...sessionCookie("", secure), maxAge: 0 });

const forwarded = (req: Request, name: string) => req.headers.get(name)?.split(",")[0]?.trim();
const forwardedProto = (h: Headers) => h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();

/**
 * https で配信されているか。req.url が https ならそれを採用する。Workers は直受けで前段プロキシが無いため、
 * `x-forwarded-proto` はクライアントが名乗った値でしかなく、req.url が http のときの補助にとどめる
 * (ローカルの http では Secure を付けない = Cookie が届かなくならない)
 */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  const proto = forwarded(req, "x-forwarded-proto")?.toLowerCase();
  return proto === "https";
}

/**
 * admin 自身の公開オリジン。https の要求は `req.url` が公開 URL そのもの(admin は Workers 直受けで前段プロキシが無い)なので
 * それを使い、`x-forwarded-host` は見ない — クライアントが名乗れる値を Origin の照合に使うと門が開く(backlog B16)。
 * http(ローカルの `next dev`)だけ従来どおり転送ヘッダ / host を見る
 */
export function selfOrigin(req: Request): string {
  const url = new URL(req.url);
  if (url.protocol === "https:") return url.origin;
  const host = forwarded(req, "x-forwarded-host") ?? req.headers.get("host");
  return host ? `${isHttps(req) ? "https" : "http"}://${host}` : url.origin;
}

/** ブラウザが名乗った Origin。`null`(sandbox / data: など不透明なオリジン)は無いものとして扱う */
const browserOrigin = (req: Request): string | null => {
  const origin = req.headers.get("origin");
  return origin && origin !== "null" ? origin : null;
};

export type OriginVerdict = "ok" | "cross_site" | "bad_origin";

/**
 * 要求の出自。Cookie を Bearer に載せ替える前に、ブラウザの**同一オリジン**の要求かを確かめる(汎用プロキシと session ルート)。
 * SameSite=Lax の Cookie は cross-site には付かないが、same-site cross-origin(admin.example.com に対する www.example.com)には付く。
 * 設置サイトは第三者タグや公開済みの Code Change が動く場所なので、そこを same-site の攻撃者とみなす。
 * 1. `Origin` が有れば admin 自身と一致していること(Fetch Metadata の値にかかわらず)
 * 2. `Sec-Fetch-Site` が有れば `same-origin` / `none` だけ通す
 * 3. どちらも無い = 出自不明(非ブラウザを含む)として通す
 * 凍結中(503)より先に判定されるが、同一オリジンの要求だけが control に届くので順序の問題は無い
 */
export function originVerdict(req: Request): OriginVerdict {
  const origin = req.headers.get("origin");
  if (origin !== null && (origin === "null" || origin.trim() !== selfOrigin(req))) return "bad_origin";
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return site === "same-origin" || site === "none" ? "ok" : "cross_site";
  return "ok";
}

/** 出自のゲートの 403。制御文字・パスは入れない(封筒の規則) */
export const badOrigin = (): Response =>
  Response.json({ error: "bad_origin", message: "この要求の送信元は受け付けられません", hint: "管理画面を開き直してから操作してください" }, { status: 403 });

/**
 * ブラウザが付けた Origin を control に渡す。control の trustedOrigins は AB_ADMIN_URL(= admin のオリジン)で、
 * 招待の受諾の Bearer 無しの分岐はこの Origin を照合する。**ブラウザが付けた Origin をそのまま渡すだけ**にして、
 * BFF が admin を名乗って control の照合を素通りさせない(無ければ何も付けない)。
 * Better Auth(control の `/auth/*`)の origin の検査は、Cookie も Sec-Fetch-* も無い要求では行われない。
 * BFF は Cookie ではなく Bearer で呼び、service binding・サーバー間の fetch のどちらにも Sec-Fetch-* は付かない
 * (手元で確かめた)ので、ログイン系の経路では control 側の検査は効かない。門は BFF の requireOrigin / originVerdict。
 * Sec-Fetch-* を BFF が作って付けることはしない(ブラウザの値ではないものを名乗らない)
 */
export function originHeader(req: Request): Record<string, string> {
  const origin = browserOrigin(req);
  return origin ? { origin } : {};
}

/**
 * 状態を変える session ルート(login / setup / accept-invite)の Origin ゲート。
 * fetch() の POST は必ず Origin を付け、他サイトからの form POST にも現代のブラウザは Origin を付けるので、
 * 「Origin が無い」= ブラウザ以外か、CSRF 検査を外しにきた要求 → 403。有るなら admin 自身と一致していること(`originVerdict`)。
 * control 側の Better Auth の origin の検査は、BFF の要求(Bearer・Sec-Fetch-* 無し)では行われない(originHeader の注記)ので、
 * login / setup の門はここだけ。
 * 招待受諾の Bearer 無し分岐は、ここの門に加えて control も転送された Origin を AB_ADMIN_URL と照合する(二重の門)
 */
export function requireOrigin(req: Request): Response | null {
  if (!browserOrigin(req)) {
    return Response.json({ error: "missing_origin", message: "Origin ヘッダのないリクエストは受け付けません" }, { status: 403 });
  }
  return originVerdict(req) === "ok" ? null : badOrigin();
}

/**
 * logout だけの例外。`<form method="post">` からの呼び出しで Origin が無かった場合でも control 側の
 * セッションは失効させたいので admin 自身のオリジンを名乗る(失効させ損ねると盗まれたトークンが 7 日間生き続ける)。
 * 名乗るのは出自の門(`originVerdict` が "ok")を通った要求だけ: 別のオリジンを示す Origin・Sec-Fetch-Site の要求は、
 * logout のルートが control を呼ばず Cookie も消さずに断る。ここで自分を名乗るのは、Origin も Sec-Fetch-Site も無い要求のとき。
 * いまの BFF の要求には Better Auth の origin の検査が掛からない(originHeader の注記)が、検査が効く形に変わっても失効が止まらないよう名乗り続ける
 */
export function originOrSelfHeader(req: Request): Record<string, string> {
  return { origin: browserOrigin(req) ?? selfOrigin(req) };
}
