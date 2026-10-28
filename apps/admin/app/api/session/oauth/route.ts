import { cookies } from "next/headers";
import { controlRequest, forwardedFrom, isHttps, selfOrigin, sessionCookie } from "@/lib/control";
import { FLOW_RE, expiredFlowCookie, flowCookieName } from "@/lib/oauth-flow";
import { safeNext } from "@/lib/safe-next";

/**
 * Google ログインの戻り。control が付けた使い捨てコード(1 分・1 回限り)をサーバー側でセッショントークンに交換し、
 * 従来どおり HttpOnly Cookie に入れる。ブラウザの URL に載るのは使い捨てコードだけで、セッショントークンは JS から見えない。
 *
 * 状態を変える GET なので、ほかの session ルートのような Origin ゲート(requireOrigin)は掛けられない(top-level の遷移に Origin は無い)。
 * 代わりに「このブラウザが始めたログインか」を flow Cookie で確かめる — 他人の URL を踏まされたブラウザには Cookie が無く、交換に進まない
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const go = (path: string) => new Response(null, { status: 302, headers: { location: new URL(path, selfOrigin(req)).toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  const jar = await cookies();
  const https = isHttps(req);
  // https では __Host- の名前だけを見る(兄弟ホストが親ドメイン宛てに置いた今の名前の flow は使わない)
  const expected = jar.get(flowCookieName(https))?.value;
  jar.set(expiredFlowCookie(https)); // 成否にかかわらず 1 回で使い切る(delete(name) は Secure を付けないので __Host- の Cookie が消えない)
  const flow = url.searchParams.get("flow");
  const code = url.searchParams.get("code");
  if (!expected || !flow || !FLOW_RE.test(flow) || flow !== expected || !code) return go("/login?error=oauth_failed");
  // top-level の遷移なのでブラウザは版を名乗れず 0 になるが、宛先の /auth/* は古い版の判定の対象外(plan12 K3)
  const res = await controlRequest("/auth/handoff/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
    ...forwardedFrom(req),
  });
  const data = res?.ok ? ((await res.json().catch(() => null)) as { token?: unknown } | null) : null;
  const session = typeof data?.token === "string" && data.token !== "" ? data.token : null;
  if (!session) return go("/login?error=oauth_failed");
  jar.set(sessionCookie(session, https));
  return go(safeNext(url.searchParams.get("next")) ?? "/w");
}
