import { cookies } from "next/headers";
import { clientVersionHeaders, controlUnreachable, controlUrl, isHttps, originHeader, requireOrigin, SESSION_COOKIE, sessionCookie } from "@/lib/control";

/**
 * 招待の受諾(spec §13.3)。既にログイン中なら Bearer だけを送って既存アカウントで参加し、
 * 未ログインなら body(name / password)で招待されたメールのアカウントを作る。どちらでも新しいトークンを Cookie に入れる
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  const { id, ...body } = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== "string" || id === "") return Response.json({ error: "bad_request", message: "招待 ID がありません" }, { status: 400 });
  const jar = await cookies();
  const existing = jar.get(SESSION_COOKIE)?.value;
  const headers: Record<string, string> = { "content-type": "application/json", ...originHeader(req), ...clientVersionHeaders() };
  if (existing) headers.authorization = `Bearer ${existing}`;
  const res = await fetch(`${controlUrl()}/invitations/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify(existing ? {} : body),
  }).catch(() => null);
  if (!res) return controlUnreachable();
  const data = (await res.json().catch(() => ({}))) as { token?: string; workspaceId?: string };
  if (!res.ok) return Response.json(data, { status: res.status }); // control の封筒をそのまま返す
  if (!data.token) return Response.json({ error: "no_session_token", message: "セッションを開始できませんでした" }, { status: 502 });
  jar.set(sessionCookie(data.token, isHttps(req)));
  return Response.json({ workspaceId: data.workspaceId });
}
