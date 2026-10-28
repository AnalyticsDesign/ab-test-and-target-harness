import { readSessionJson } from "@/lib/body-limit";
import { cookies } from "next/headers";
import { controlRequest, controlUnreachable, forwardedFrom, isHttps, originHeader, requireOrigin, sessionCookie } from "@/lib/control";
import { NOT_INVITED } from "@/lib/oauth-errors";

/**
 * ログイン(spec §13.4)。control が `set-auth-token` ヘッダで返すセッショントークンを HttpOnly Cookie に入れ、
 * body には決して出さない。ブラウザ側の JS はトークンを一度も見ない
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  // B154: 本文は上限(16KB)付きで読む。超えたら読まずに 413
  const read = await readSessionJson(req);
  if (!read.ok) return read.response;
  const body = read.value as { email?: unknown; password?: unknown };
  // 接続元 IP を渡す(control のログインのレート制限が利用者ごとに効く。plan12 K8)
  const res = await controlRequest("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...originHeader(req) },
    body: JSON.stringify({ email: body.email, password: body.password }),
    ...forwardedFrom(req),
  });
  if (!res) return controlUnreachable();
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    // control 自身の封筒(429 rate_limited など)はそのまま返す。Better Auth が直接返す認証失敗は英語なので
    // ここで日本語の封筒に揃える(spec §13.5 の形は保つ)
    if (data && typeof data.error === "string") return Response.json(data, { status: res.status });
    // セッション作成のフックが断った場合(その人はもうどの Workspace にも属していない)。
    // これも Better Auth 素の封筒で返るので、拾わないとパスワード誤りに丸められてしまう。
    // この 403 は「パスワードは合っている」ことを相手に教えるが、非常用の経路が開いているあいだしか到達できず、
    // その入口は control が IP 単位で 30 回 / 10 秒に絞っているので受容する(理由を隠すと運用者が原因を追えない)
    if (res.status === 403 && data?.message === "not_invited") {
      return Response.json({ error: "not_invited", message: NOT_INVITED }, { status: 403 });
    }
    return Response.json({ error: "invalid_credentials", message: "メールアドレスかパスワードが違います" }, { status: 401 });
  }
  const token = res.headers.get("set-auth-token");
  if (!token) return Response.json({ error: "no_session_token", message: "セッションを開始できませんでした" }, { status: 502 });
  (await cookies()).set(sessionCookie(token, isHttps(req)));
  return Response.json({ ok: true });
}
