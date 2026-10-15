import { clientVersionHeaders, controlUnreachable, controlUrl, originHeader, requireOrigin } from "@/lib/control";

/**
 * 初回セットアップ(spec §13.3)。フォームの `setupToken` は header `x-setup-token` に移して control に渡す。
 * 応答からは画面が使う `workspaceId` だけを返す。セッションは作らない(OWNER は続けて Google でログインする)
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  const { setupToken, ...body } = (await req.json().catch(() => ({}))) as { setupToken?: unknown };
  const res = await fetch(`${controlUrl()}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": String(setupToken ?? ""), ...originHeader(req), ...clientVersionHeaders() },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return controlUnreachable();
  const data = (await res.json().catch(() => ({}))) as { workspaceId?: string };
  if (!res.ok) return Response.json(data, { status: res.status }); // control の封筒をそのまま返す
  return Response.json({ workspaceId: data.workspaceId });
}
