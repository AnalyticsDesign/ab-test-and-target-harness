import { controlRequest, controlUnreachable, forwardedFrom, originHeader, requireOrigin } from "@/lib/control";

/**
 * 初回セットアップ(spec §13.3)。フォームの `setupToken` は header `x-setup-token` に移して control に渡す。
 * 応答からは画面が使う `workspaceId` だけを返す。セッションは作らない(OWNER は続けて Google でログインする)
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  const { setupToken, ...body } = (await req.json().catch(() => ({}))) as { setupToken?: unknown };
  // /setup は control の古い版の判定(426)の対象なので、ブラウザの版との小さいほうを名乗る(forwardedFrom)
  const res = await controlRequest("/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": String(setupToken ?? ""), ...originHeader(req) },
    body: JSON.stringify(body),
    ...forwardedFrom(req),
  });
  if (!res) return controlUnreachable();
  const data = (await res.json().catch(() => ({}))) as { workspaceId?: string };
  if (!res.ok) return Response.json(data, { status: res.status }); // control の封筒をそのまま返す
  return Response.json({ workspaceId: data.workspaceId });
}
