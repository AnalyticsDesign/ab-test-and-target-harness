/**
 * Google ログインを「始めたブラウザ」と「セッションを受け取るブラウザ」が同じであることの印(login CSRF 対策)。
 * 始めるときに HttpOnly Cookie に入れ、control を往復して戻ってきた query の flow と一致したときだけセッションを張る。
 * 他人の `/api/session/oauth?code=…` を踏まされたブラウザにはこの Cookie が無い
 */
export const FLOW_COOKIE = "wtt_oauth_flow";
/** control の routes/oauth.ts の FLOW_RE と同じ式 */
export const FLOW_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Google の認可画面で迷う時間を見て 10 分。SameSite=Lax は Google からの戻り(top-level の GET)には付く */
export const flowCookie = (value: string, secure: boolean) =>
  ({ name: FLOW_COOKIE, value, httpOnly: true, sameSite: "lax" as const, path: "/api/session", secure, maxAge: 600 });
/**
 * 失効させるときは、張ったときと同じ属性(とくに path)で maxAge 0 を set する。
 * `cookies().delete(name)` は `Path=/` の失効 Cookie を出すので、`Path=/api/session` の Cookie はブラウザから消えない
 */
export const expiredFlowCookie = (secure: boolean) => ({ ...flowCookie("", secure), maxAge: 0 });
