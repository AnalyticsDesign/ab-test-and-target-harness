import { cookies } from "next/headers";
import { clientVersionHeaders, controlUrl, originOrSelfHeader, SESSION_COOKIE } from "@/lib/control";

/** ログアウト。control のセッションを失効させてから Cookie を消す(control 側が落ちていても Cookie は必ず消す) */
export async function POST(req: Request): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  // Better Auth の sign-out は body を取らないが content-type が無いと 415 になる。
  // origin はこのルートだけ「無ければ admin 自身を名乗る」— form POST で Origin が落ちても
  // control 側のセッションを確実に失効させるため(失効し損ねると盗まれたトークンが 7 日間生きる)
  if (token) {
    await fetch(`${controlUrl()}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...originOrSelfHeader(req), ...clientVersionHeaders() },
      body: "{}",
    }).catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
  // layout の <form method="post"> から呼ばれる。`Response.redirect` はヘッダが immutable で Set-Cookie を足せないので使わない。
  // location は相対にする(プロキシの後ろでは req.url が内部 URL になり、絶対 URL だと外から辿れない)
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
