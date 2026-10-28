import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHANGES_PUT_BODY_MAX_BYTES, JSON_BODY_MAX_BYTES, assetMaxMb, assetUploadBodyMaxBytes } from "@wtt/core";
import type { AppEnv } from "./app";
import { ApiError } from "./errors";

/**
 * 要求の本文の上限(backlog B154 / security triage v2 G19)。
 * 本文を読む前(認証・検証・ルートの処理の前)に、Content-Length があればその値で、無ければ数えながら読んで上限で打ち切る。
 * Content-Length の無い本文は hono の bodyLimit が上限まで読み、`c.req.raw` を読んだ分のストリームに差し替える
 * (後ろの `/auth/*` の素通しが Better Auth に渡す `c.req.raw` もこの差し替えた要求になる)。
 *
 * 経路は Hono がルートを選ぶのと同じデコードした path(`c.req.path`)で見る。エンコードした別名で上限を選び分けられないように
 */

const BODY_TOO_LARGE_HINT = "一度に送る内容が大きすぎます。内容を減らしてから、もう一度送ってください";

/** 画像のアップロード(`POST /sites/:sid/assets`) */
const ASSET_UPLOAD_PATH = /^\/sites\/[^/]+\/assets$/;
/** 変更の全置換(`PUT /sites/:sid/experiments/:eid/variants/:vid/changes`) */
const CHANGES_PUT_PATH = /^\/sites\/[^/]+\/experiments\/[^/]+\/variants\/[^/]+\/changes$/;

/**
 * 入口の上限(バイト)。null = 入口では掛けない: 既定より大きい上限を持つ経路(画像のアップロード・変更の全置換)は、
 * ルートの中で認証(画像は権限も)を確かめた後に掛ける。入口で大きい上限を掛けると、Content-Length の無い本文を
 * ログインしていない人からもその上限まで読んでしまう
 */
export function entranceBodyLimit(method: string, path: string): number | null {
  if (method === "POST" && ASSET_UPLOAD_PATH.test(path)) return null;
  if (method === "PUT" && CHANGES_PUT_PATH.test(path)) return null;
  return JSON_BODY_MAX_BYTES;
}

const tooLarge = (hint: string) => (): never => {
  throw new ApiError(413, "payload_too_large", { hint });
};

/** 入口の上限(createApp が回数の上限の後に置く) */
export const requestBodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  // hono の bodyLimit は Content-Length を parseInt で読み、NaN だと上限を掛けずに通す。数字だけでない値は読む前に断る
  const declared = c.req.raw.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared)) throw new ApiError(400, "bad_request", { hint: "Content-Length が数字ではありません" });
  const maxSize = entranceBodyLimit(c.req.method, c.req.path);
  if (maxSize === null) return next();
  return bodyLimit({ maxSize, onError: tooLarge(BODY_TOO_LARGE_HINT) })(c, next);
};

/** 変更の全置換の上限。`requireSession` の後・本文の解析の前に置く */
export const changesPutBodyLimit: MiddlewareHandler<AppEnv> = bodyLimit({ maxSize: CHANGES_PUT_BODY_MAX_BYTES, onError: tooLarge(BODY_TOO_LARGE_HINT) });

/**
 * 画像のアップロードの上限(`AB_ASSET_MAX_MB` + multipart の余白)。ルートの権限の確かめの後・本文の解析の前に置く。
 * 超えたときは、読んだ後の 1 枚の上限の判定と同じ 413 `asset_too_large` にそろえる(Content-Length があれば `size` も返す)
 */
export const assetUploadBodyLimit: MiddlewareHandler<AppEnv> = async (c: Context<AppEnv>, next) => {
  const maxMb = assetMaxMb(c.env.AB_ASSET_MAX_MB);
  const onError = (): never => {
    const declared = c.req.raw.headers.get("content-length");
    const size = declared !== null && !c.req.raw.headers.has("transfer-encoding") ? Number(declared) : undefined;
    throw new ApiError(413, "asset_too_large", { maxMb, ...(size !== undefined ? { size } : {}), message: "画像が大きすぎます", hint: `1 枚あたり ${maxMb}MB までです` });
  };
  return bodyLimit({ maxSize: assetUploadBodyMaxBytes(maxMb), onError })(c, next);
};
