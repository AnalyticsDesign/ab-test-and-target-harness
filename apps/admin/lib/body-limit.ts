import { JSON_BODY_MAX_BYTES } from "@wtt/core";

/**
 * 要求の本文を上限付きで扱う(backlog B154 / security triage v2 G33)。
 * BFF(`/api/control/*`)と session のルートは認証の前に本文に触れるので、大きな本文を丸ごとメモリに読まない。
 * - Content-Length があればそれだけで判定する(上限を超えたら読まない)
 * - 無ければ(chunked)上限まで数えながら読み、超えた時点で読むのをやめる
 */

/** session のルート(ログイン・初回セットアップ・招待の受諾)の本文の上限。どれも数百バイトの JSON */
export const SESSION_BODY_MAX_BYTES = 16 * 1024;

/**
 * BFF が Content-Length 付きの本文を受ける天井(100 MiB)。Cloudflare の Free / Pro のプランの要求の本文の上限と同じ値で、
 * それより大きい本文はどのみち Workers に届かない。BFF はこの範囲の本文を読まずにストリームのまま control に渡し、
 * 経路ごとの上限(画像は control の `AB_ASSET_MAX_MB` から決まる)は control が Content-Length で判定する
 * (管理画面は `AB_ASSET_MAX_MB` を持たないので、ここで経路ごとに断ると上限を上げた導入で食い違う)
 */
export const BFF_DECLARED_BODY_CEILING_BYTES = 100 * 1024 * 1024;

/** BFF が Content-Length の無い本文を読む上限。ブラウザの fetch は本文に Content-Length を付けるので、無いのは JSON の小さな要求だけ */
export const BFF_CHUNKED_BODY_MAX_BYTES = JSON_BODY_MAX_BYTES;

/** Content-Length の値。Transfer-Encoding がある・数字でない・無いときは null(= 数えながら読む) */
export function declaredLength(headers: Headers): number | null {
  if (headers.has("transfer-encoding")) return null;
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** 読んだ結果。too_large = 上限を超えた(残りは読まない)、read_error = 読んでいる途中でストリームが失敗した */
export type LimitedBody = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "too_large" | "read_error" };

/** 本文を上限まで読む。本文が無ければ空のバイト列 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = declaredLength(req.headers);
  if (declared !== null && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // 接続が切れたなど。上限の超過とは別に扱う(呼び出し元が 400 か空の本文にする)
    return { ok: false, reason: "read_error" };
  }
  // 1 回だけ連結する(断片は連結の後に手放す)
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * session のルートの本文を JSON として読む。上限を超えたら 413 の応答。
 * 読めない JSON・読んでいる途中の失敗は `{}`(今までの `req.json().catch(() => ({}))` と同じ)
 */
export async function readSessionJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const r = await readBodyLimited(req, SESSION_BODY_MAX_BYTES);
  if (!r.ok) return r.reason === "too_large" ? { ok: false, response: payloadTooLarge() } : { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(r.bytes));
    return { ok: true, value: v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {} };
  } catch {
    return { ok: true, value: {} };
  }
}

/** 413 の封筒(control の payload_too_large と同じ形) */
export const payloadTooLarge = (): Response =>
  Response.json(
    { error: "payload_too_large", message: "リクエストが大きすぎます", hint: "一度に送る内容が大きすぎます。内容を減らしてから、もう一度送ってください" },
    { status: 413 },
  );

/** 本文を読んでいる途中で失敗したときの 400 の封筒 */
export const bodyReadFailed = (): Response =>
  Response.json({ error: "bad_request", message: "リクエストの本文を読めませんでした", hint: "もう一度送ってください" }, { status: 400 });
