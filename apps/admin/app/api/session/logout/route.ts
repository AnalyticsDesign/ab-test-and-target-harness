import { cookies } from "next/headers";
import { controlRequest, expiredSessionCookie, forwardedFrom, isHttps, originOrSelfHeader, originVerdict, sessionCookieName } from "@/lib/control";

// layout の <form method="post"> から呼ばれる。`Response.redirect` はヘッダが immutable で Set-Cookie を足せないので使わない。
// location は相対にする(プロキシの後ろでは req.url が内部 URL になり、絶対 URL だと外から辿れない)
const toLogin = () => new Response(null, { status: 303, headers: { location: "/login" } });
// 出自の門で断ったときの行き先。/ はログイン中なら /w、未ログインなら /login に移す(app/page.tsx)ので、
// 断られた本人には「ログアウトできていない」ことが画面で分かる(/login に送ると、ログアウトできたように見える)
const toHome = () => new Response(null, { status: 303, headers: { location: "/" } });

/** ログアウト。control のセッションを失効させてから Cookie を消す(control 側が落ちていても Cookie は必ず消す) */
export async function POST(req: Request): Promise<Response> {
  // 出自の門: 別のオリジン(same-site の兄弟ホストを含む)から送られたものは、control も呼ばず Cookie も消さずに / へ。
  // 外部のページのフォームの自動送信で管理者を勝手にログアウトさせない。Origin も Sec-Fetch-Site も無い要求は今どおり通す
  // (form POST で Origin が落ちても失効させる。originOrSelfHeader の注記)
  if (originVerdict(req) !== "ok") return toHome();
  const jar = await cookies();
  const https = isHttps(req);
  const token = jar.get(sessionCookieName(https))?.value;
  // Better Auth の sign-out は body を取らないが content-type が無いと 415 になる。
  // origin はこのルートだけ「無ければ admin 自身を名乗る」— form POST で Origin が落ちても
  // control 側のセッションを確実に失効させるため(失効し損ねると盗まれたトークンが 7 日間生きる)。
  // form POST はヘッダーを付けられないので版は 0 を名乗るが、宛先の /auth/sign-out は古い版の判定の対象外(plan12 K3)
  if (token) {
    await controlRequest("/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...originOrSelfHeader(req) },
      body: "{}",
      ...forwardedFrom(req),
    });
  }
  // 張ったときと同じ名前・属性で失効させる(`delete(name)` は Secure を付けないので __Host- の Cookie が消えない)。
  // 名前を変える前に張られた今の名前の Cookie は消さない(試験運用の版で互換の処理を残さない方針。7 日で切れる)
  jar.set(expiredSessionCookie(https));
  return toLogin();
}
