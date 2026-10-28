/**
 * Google ログインを「始めたブラウザ」と「セッションを受け取るブラウザ」が同じであることの印(login CSRF 対策)。
 * 始めるときに HttpOnly Cookie に入れ、control を往復して戻ってきた query の flow と一致したときだけセッションを張る。
 * 他人の `/api/session/oauth?code=…` を踏まされたブラウザにはこの Cookie が無い。
 * 名前は https なら `__Host-` 付き(セッション Cookie と同じ理由。`sessionCookieName` の注記)。
 * 兄弟ホストが自分で始めたログインの flow を親ドメイン宛てに置き、戻りの URL を踏ませる(攻撃者のセッションが入る)のを止める
 */
export const flowCookieName = (https: boolean): string => (https ? "__Host-wtt_oauth_flow" : "wtt_oauth_flow");
/** control の routes/oauth.ts の FLOW_RE と同じ式(両側の literal をテストで固定。B21) */
export const FLOW_RE = /^[A-Za-z0-9_-]{16,64}$/;
/**
 * Google の認可画面で迷う時間を見て 10 分。SameSite=Lax は Google からの戻り(top-level の GET)には付く。
 * Path は `/`: `__Host-` の Cookie は Path=/ でないとブラウザが受け付けない。http でも同じ `/` にそろえる
 * (名前以外の属性を https と http で分けないので、失効の形も 1 つで済む。以前の `/api/session` に絞る効果は、HttpOnly で JS から見えない以上ほぼ無い)
 */
export const flowCookie = (value: string, secure: boolean) =>
  ({ name: flowCookieName(secure), value, httpOnly: true, sameSite: "lax" as const, path: "/", secure, maxAge: 600 });
/**
 * 失効させるときは、張ったときと同じ名前・属性で maxAge 0 を set する。
 * `cookies().delete(name)` は Secure を付けないので、`__Host-` の Cookie はブラウザが消さない
 */
export const expiredFlowCookie = (secure: boolean) => ({ ...flowCookie("", secure), maxAge: 0 });
