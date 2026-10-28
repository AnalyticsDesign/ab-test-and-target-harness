import { cookies } from "next/headers";
import { BFF_CHUNKED_BODY_MAX_BYTES, BFF_DECLARED_BODY_CEILING_BYTES, bodyReadFailed, declaredLength, payloadTooLarge, readBodyLimited } from "@/lib/body-limit";
import { badOrigin, controlRequest, controlUnreachable, forwardedFrom, originHeader, originVerdict, SESSION_COOKIE } from "@/lib/control";

/**
 * BFF(spec §13.4)。ブラウザは同一オリジンの `/api/control/*` だけを叩き、ここが Cookie のセッショントークンを
 * Bearer に載せ替えて control に転送する。control の URL もトークンもブラウザには出さない。
 * multipart は content-type ごとそのまま流す(Task 12 の Asset アップロード)
 */

/**
 * セッショントークンを発行する(= 応答の body / ヘッダにトークンが載る)control のパスは、この汎用プロキシからは通さない。
 * トークンを扱う経路は `/api/session/*` だけで、そこは必ず HttpOnly Cookie に入れて body には出さない。
 * ここを開けておくと、ブラウザの JS が同じ入口からトークンを読み出せてしまう(Global Constraints)。
 * 前方一致で止める(`auth/get-session/x` のような下位パスも塞ぐ)。control 側の `AUTH_ALLOW`(完全一致のみ。決定 35 (2))
 * と対になる 2 枚目の門なので、片方だけが緩まないよう広げるときは両方を見ること。
 * Google ログインの 3 ルート(決定 46)も同じ理由でここを通さない: `auth/handoff/exchange` は応答 body にセッショントークンを返し、
 * `auth/google/start` と `auth/callback/google` はブラウザの top-level 遷移で control のオリジンを直接開く経路(fetch で叩く意味が無い)。
 * `break-glass/*` は非常用トークンを照合する運用者向けの入口で、画面からは呼ばない
 * `draft-bootstrap` は下書きの config を `text/javascript`(`self.__WTT_BOOT__=…`)で返す外部エージェント向けの経路で、管理画面は使わない。
 * ブラウザから届くと `<script src>` で読まれて下書きが漏れる(同一オリジンの門で止めるが、実行可能な応答はそもそも中継しない)
 */
const BROWSER_BLOCKED = [
  /^auth\/sign-in\/email(?:\/|$)/,
  /^auth\/sign-up\/email(?:\/|$)/,
  /^auth\/sign-out(?:\/|$)/,
  /^auth\/get-session(?:\/|$)/,
  /^auth\/list-sessions(?:\/|$)/,
  /^auth\/token(?:\/|$)/,
  /^auth\/handoff(?:\/|$)/,
  /^auth\/google(?:\/|$)/,
  /^auth\/callback(?:\/|$)/,
  /^break-glass(?:\/|$)/,
  /^setup(?:\/|$)/,
  /^invitations\/[^/]+\/accept(?:\/|$)/,
];
/** 実行可能な応答を返す経路(トークンは扱わないが、ブラウザには中継しない) */
const EXECUTABLE_RESPONSE = [/^sites\/[^/]+\/experiments\/[^/]+\/draft-bootstrap(?:\/|$)/];

const envelope = (status: number, error: string, message: string, hint?: string) =>
  Response.json({ error, message, ...(hint ? { hint } : {}) }, { status });

/**
 * B154(security triage v2 G33): 本文を丸ごとメモリに読まずに control へ渡す。BFF は認証の前(トークンの有無にかかわらず)本文に触れる。
 * `/reset` の画面が無認証で再設定を呼ぶので、トークンの有無では分けない。
 * - Content-Length があり天井(100 MiB)以内: 読まずにストリームのまま渡す。経路ごとの上限は control が同じ Content-Length で判定する
 *   (画像の上限は control の `AB_ASSET_MAX_MB` で決まり、管理画面はその値を持たないため)
 * - Content-Length が天井を超える: 読まずに 413
 * - Content-Length が無い(chunked): どの経路でも JSON の既定(1 MiB)まで数えながら読み、超えたら 413。
 *   途中で打ち切るストリームを渡すと control に届かず 502 になるので、読み切ってから渡す。読んでいる途中の失敗は 400
 * ストリームの本文には `duplex: "half"` が要る(Node の fetch / Request は無いと TypeError。workerd は付けても害は無い)
 */
async function forwardBody(req: Request, headers: Headers): Promise<{ body?: BodyInit; duplex?: "half" } | Response> {
  if (req.method === "GET" || req.method === "HEAD" || !req.body) return {};
  const declared = declaredLength(req.headers);
  if (declared !== null) {
    if (declared > BFF_DECLARED_BODY_CEILING_BYTES) return payloadTooLarge();
    headers.set("content-length", String(declared));
    return { body: req.body, duplex: "half" };
  }
  const r = await readBodyLimited(req, BFF_CHUNKED_BODY_MAX_BYTES);
  if (r.ok) return { body: r.bytes };
  return r.reason === "too_large" ? payloadTooLarge() : bodyReadFailed();
}

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  // 出自の門は Cookie を読む前(Cookie に触れない要求は Bearer を作らない)
  if (originVerdict(req) !== "ok") return badOrigin();
  const { path } = await ctx.params;
  // `.` / `..` / 空セグメントは URL の正規化で control の別のパスに化ける。転送する前に断る
  if (path.length === 0 || path.some((s) => s === "" || s === "." || s === "..")) {
    return envelope(400, "bad_request", "リクエストパスが不正です");
  }
  // control の Hono ルーティングは今のところ大文字小文字を区別するが、2 つの門が互いの大小文字に依存しないよう畳んで判定する
  const joined = path.join("/").toLowerCase();
  if (BROWSER_BLOCKED.some((re) => re.test(joined))) {
    return envelope(403, "forbidden", "このパスはブラウザからは呼べません", "セッションを作る操作は /api/session/* を使ってください");
  }
  if (EXECUTABLE_RESPONSE.some((re) => re.test(joined))) {
    return envelope(403, "forbidden", "このパスはブラウザからは呼べません", "下書きの確認は、API キーで control の draft-bootstrap を直接呼んでください(エージェント向けガイドのレシピ)");
  }
  const url = new URL(req.url);
  const target = `/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // ブラウザから来たヘッダは引き継がない(authorization / x-setup-token / x-api-key / x-wtt-client-ip の持ち込みや header injection を断つ)。
  // 必要なものだけを組み立て直す: content-type(multipart の boundary ごと)/ Bearer / Origin
  // (Origin はブラウザが名乗ったものだけを渡し、無ければ付けない)。版と接続元 IP は controlRequest が付ける(plan12 K3 / K8)
  const headers = new Headers(originHeader(req));
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const forwarded = await forwardBody(req, headers);
  if (forwarded instanceof Response) return forwarded;
  const res = await controlRequest(target, { method: req.method, headers, ...forwarded, ...forwardedFrom(req) });
  // control に届かないときも封筒を返す(ブラウザ側の `api()` は「非 2xx は必ず封筒」を前提にしている)
  if (!res) return controlUnreachable();
  // 応答も素通しにはしない。control の set-auth-token / set-cookie をブラウザに渡さない。
  // 引き継ぐのは content-type と、キャッシュ・型の判定に関わる 2 つ(下書きの応答を中間でキャッシュさせない・MIME を推測させない)。
  // CORP は same-site の別オリジンからの no-cors 読み込み(<script> / <img>)をブラウザに断らせる(出自の門の多層防御)
  const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json", "cross-origin-resource-policy": "same-origin" });
  for (const name of ["x-content-type-options", "cache-control"]) {
    const v = res.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
