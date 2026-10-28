import { readSessionJson } from "@/lib/body-limit";
import { controlRequest, controlUnreachable, forwardedFrom, originHeader, requireOrigin } from "@/lib/control";

/**
 * 初回セットアップ(spec §13.3)。フォームの `setupToken` は header `x-setup-token` に移して control に渡す。
 * 成功の応答は空(画面は成否しか見ない。control の応答の中身は返さない)。セッションは作らない(OWNER は続けて Google でログインする)
 */
export async function POST(req: Request): Promise<Response> {
  const noOrigin = requireOrigin(req);
  if (noOrigin) return noOrigin;
  // B154: 本文は上限(16KB)付きで読む。超えたら読まずに 413
  const read = await readSessionJson(req);
  if (!read.ok) return read.response;
  const { setupToken, ...body } = read.value as { setupToken?: unknown };
  // /setup は control の古い版の判定(426)の対象なので、ブラウザの版との小さいほうを名乗る(forwardedFrom)
  const res = await controlRequest("/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": String(setupToken ?? ""), ...originHeader(req) },
    body: JSON.stringify(body),
    ...forwardedFrom(req),
  });
  if (!res) return controlUnreachable();
  if (!res.ok) return Response.json(await res.json().catch(() => ({})), { status: res.status }); // control の封筒をそのまま返す
  return Response.json({});
}
