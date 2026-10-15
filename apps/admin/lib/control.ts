import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { API_CONTRACT_VERSION, CLIENT_VERSION_HEADER } from "@wtt/core";
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
 * backlog D13 / 決定 56 (1): control へのすべての要求で、この admin がビルドされた時点の API 契約の版を名乗る。
 * ブラウザではなく BFF が付ける(古いのは BFF 自身で、ブラウザが名乗る値は信用できない)。control を呼ぶ fetch はすべてこれを headers に混ぜる
 * (漏れは test/control-headers.test.ts が止める)
 */
export function clientVersionHeaders(): Record<string, string> {
  return { [CLIENT_VERSION_HEADER]: String(API_CONTRACT_VERSION) };
}

export const SESSION_COOKIE = "wtt_session";

/**
 * control に届かなかったときの封筒。BFF の応答は必ず封筒である(= `lib/client.ts` の `api` が
 * 常に `ApiClientError` に変換できる)という約束を、control 側の障害でも破らないための 502
 */
export const controlUnreachable = (): Response =>
  Response.json({ error: "control_unreachable", message: "control に接続できませんでした", hint: "しばらく待ってから再試行してください" }, { status: 502 });

/**
 * サーバーコンポーネント / Route Handler から control を呼ぶ。Cookie のセッショントークンを Bearer にする(spec §13.4)。
 * control に届かない場合も throw せず `{ status: 502 }` を返す(サーバーコンポーネントを 500 で落とさない)
 */
export async function controlFetch<T>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(clientVersionHeaders())) headers.set(k, v);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  const res = await fetch(`${controlUrl()}${path}`, { ...init, headers, cache: "no-store" }).catch(() => null);
  if (!res) return { status: 502, data: null as T };
  const data = (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  return { status: res.status, data };
}

export async function requireUser(): Promise<SessionUser> {
  const r = await controlFetch<SessionUser>("/me");
  if (r.status !== 200) redirect("/login");
  return r.data;
}

/**
 * セッション Cookie の属性(Global Constraints)。HttpOnly なので JS からは読めず、BFF だけが Bearer に載せ替える。
 * SameSite=Lax は同一オリジンの fetch には常に付き、他サイトからの POST には付かない
 */
export function sessionCookie(token: string, secure: boolean) {
  return { name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: "lax" as const, path: "/", secure, maxAge: 60 * 60 * 24 * 7 };
}

const forwarded = (req: Request, name: string) => req.headers.get(name)?.split(",")[0]?.trim();

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
 * Better Auth(control の `/auth/*`)は origin を検証する。サーバー間 fetch には Sec-Fetch-* が自動で付くため、
 * origin が無いと 403 MISSING_OR_NULL_ORIGIN になる。control の trustedOrigins は AB_ADMIN_URL(= admin のオリジン)。
 * **ブラウザが付けた Origin をそのまま渡すだけ**にして、BFF が admin を名乗って control の CSRF 検査を
 * 素通りさせない(無ければ何も付けず、control 側に fail-closed で弾かせる)
 */
export function originHeader(req: Request): Record<string, string> {
  const origin = browserOrigin(req);
  return origin ? { origin } : {};
}

/**
 * 状態を変える session ルート(login / setup / accept-invite)の Origin ゲート。
 * fetch() の POST は必ず Origin を付け、他サイトからの form POST にも現代のブラウザは Origin を付けるので、
 * 「Origin が無い」= ブラウザ以外か、CSRF 検査を外しにきた要求 → 403。有るなら admin 自身と一致していること(`originVerdict`)。
 * control 側の照合(Better Auth の trustedOrigins)は `/auth/*` だけに効き、招待受諾は通らない。
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
 * セッションは失効させたいので admin 自身のオリジンを名乗る(logout の CSRF は「勝手にログアウトさせられる」だけで、
 * Cookie の削除はどのみち起きる。逆に失効させ損ねると盗まれたトークンが 7 日間生き続ける)
 */
export function originOrSelfHeader(req: Request): Record<string, string> {
  return { origin: browserOrigin(req) ?? selfOrigin(req) };
}
