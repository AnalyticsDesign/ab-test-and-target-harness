import { cookies } from "next/headers";
import { clientVersionHeaders, controlUnreachable, controlUrl, isHttps, originHeader, requireOrigin, sessionCookie } from "@/lib/control";
import { NOT_INVITED } from "@/lib/oauth-errors";

/**
 * ログイン(spec §13.4)。control が `set-auth-token` ヘッダで返すセッショントークンを HttpOnly Cookie に入れ、
 * body には決して出さない。ブラウザ側の JS はトークンを一度も見ない
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const res = await fetch(`${controlUrl()}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...originHeader(req), ...clientVersionHeaders() },
    body: JSON.stringify({ email: body.email, password: body.password }),
  }).catch(() => null);
  if (!res) return controlUnreachable();
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    // control 自身の封筒(429 rate_limited など)はそのまま返す。Better Auth が直接返す認証失敗は英語なので
    // ここで日本語の封筒に揃える(spec §13.5 の形は保つ)
    if (data && typeof data.error === "string") return Response.json(data, { status: res.status });
    // セッション作成のフックが断った場合(その人はもうどの Workspace にも属していない)。
    // これも Better Auth 素の封筒で返るので、拾わないとパスワード誤りに丸められてしまう。
    // この 403 は「パスワードは合っている」ことを相手に教えるが、非常用の経路が開いているあいだしか到達できず、
    // その入口は control が IP 単位で 10 回 / 10 秒に絞っているので受容する(理由を隠すと運用者が原因を追えない)
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
