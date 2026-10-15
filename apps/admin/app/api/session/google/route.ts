import { cookies } from "next/headers";
import { controlUrl, isHttps } from "@/lib/control";
import { flowCookie } from "@/lib/oauth-flow";
import { safeNext } from "@/lib/safe-next";

/**
 * Google ログインの入口。OAuth の state Cookie は control のオリジンに張る必要があるので、ブラウザごと control の start へ送る
 * (BFF の裏から呼ぶ形にはできない)。セッションはここでは作らず、このブラウザで始めた印(flow)だけを Cookie に残す
 */
export async function GET(req: Request): Promise<Response> {
  const flow = crypto.randomUUID();
  (await cookies()).set(flowCookie(flow, isHttps(req)));
  const to = new URL(`${controlUrl()}/auth/google/start`);
  to.searchParams.set("flow", flow);
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (next) to.searchParams.set("next", next);
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
}
