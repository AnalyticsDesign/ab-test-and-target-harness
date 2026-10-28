import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { assetMaxMb } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { assetUploadBodyLimit } from "../body-limit";
import { imageStore, IMAGE_DISABLED_HINT } from "../capabilities";
import { ApiError, notFound, validationFailed } from "../errors";
import { newId, SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import type { SiteRow } from "../db";
import { loadSite } from "../roles";

export const assetRoutes = new Hono<AppEnv>();

/**
 * spec §13.7: 受理する画像の種類。**宣言(multipart の Content-Type)と先頭バイトの両方**が一致したものだけを通す。
 * SVG は `<script>` を含みうる(= 配信ドメインでの XSS 経路になる)ので MVP では受けない。
 */
const AVIF_BRANDS = new Set(["avif", "avis", "mif1", "msf1"]);
const IMAGE_TYPES: Record<string, { ext: string; label: string; magic: (b: Uint8Array) => boolean }> = {
  "image/png": { ext: "png", label: "PNG", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { ext: "jpg", label: "JPEG", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", label: "GIF", magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  "image/webp": {
    ext: "webp",
    label: "WebP",
    magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  // ISO-BMFF: 4 バイトの box size に続く `ftyp`、その次の 4 バイトが major brand。
  // `ftyp` だけを見ると MP4 / MOV / HEIC など**あらゆる ISO-BMFF コンテナ**が image/avif を名乗って通ってしまうので、
  // brand まで確かめる(`avif` = 静止画、`avis` = シーケンス、`mif1` / `msf1` = AVIF が使う HEIF 系ブランド)
  "image/avif": {
    ext: "avif",
    label: "AVIF",
    magic: (b) =>
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70 &&
      AVIF_BRANDS.has(String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!)),
  },
};
/** 先頭バイトの判定に必要な最小長(WebP の `WEBP` が 8〜11 バイト目に来る) */
const MAGIC_BYTES = 12;
/** 先頭バイトから実際の形式を探す(受け付ける形式のどれでもない・短すぎるときは undefined) */
const detectImageType = (head: Uint8Array): string | undefined =>
  head.length < MAGIC_BYTES ? undefined : Object.keys(IMAGE_TYPES).find((mime) => IMAGE_TYPES[mime]!.magic(head));
const SUPPORTED_LABELS = Object.values(IMAGE_TYPES).map((t) => t.label).join(" / ");

/**
 * 415 の封筒。backlog B66 / install_review W9: 中身が JPEG の `.png` で、対応形式を並べるだけの hint では原因が分からなかった。
 * 中身が受け付ける画像で宣言と違うときは、実際の形式を伝える。
 * - 宣言が受け付ける画像の種類(ブラウザは拡張子から宣言を決める)= 拡張子の不一致なので、合わせるべき拡張子を伝える
 * - 宣言がそれ以外(空・`application/octet-stream`・`image/jpg` のような非標準の名前)= 拡張子は正しいことがある
 *   (curl は .webp / .avif を application/octet-stream で送る)ので、拡張子の不一致とは言わず、送るときの Content-Type を伝える
 * それ以外(受け付ける形式のどれでもない・短すぎる)は不一致と言い切れないので、対応形式を並べる
 */
function unsupportedImage(declared: string, head: Uint8Array): ApiError {
  const detected = detectImageType(head);
  if (detected && detected !== declared) {
    const actual = IMAGE_TYPES[detected]!;
    // IMAGE_TYPES は素のオブジェクトなので、`constructor` などの宣言を受け付ける種類と取り違えないよう hasOwn で見る
    const declaredImage = Object.hasOwn(IMAGE_TYPES, declared) ? IMAGE_TYPES[declared]! : undefined;
    if (declaredImage) {
      return new ApiError(415, "unsupported_media_type", {
        declared,
        detected,
        message: "ファイルの拡張子と、画像の実際の形式が合っていません",
        hint: `ファイルの中身は ${actual.label} ですが、${declaredImage.label} として送られています。拡張子を実際の形式に合わせて(.${actual.ext})、もう一度アップロードしてください`,
      });
    }
    // 宣言はそのまま書く(API から送った人が Content-Type を探せるように)
    const sentAs = declared ? `形式の指定が ${declared} になっています` : "形式の指定がないまま送られています";
    return new ApiError(415, "unsupported_media_type", {
      declared,
      detected,
      message: "画像の形式の指定が、受け付ける画像の種類になっていません",
      hint: `ファイルの中身は ${actual.label} ですが、${sentAs}。API から送るときは、ファイルの Content-Type を ${detected} にしてください。管理画面から送るときは、ファイル名の拡張子が .${actual.ext} になっているかを確かめてください`,
    });
  }
  return new ApiError(415, "unsupported_media_type", {
    declared,
    message: "この画像はアップロードできません",
    hint: `${SUPPORTED_LABELS} の画像だけをアップロードできます(SVG は受け付けません)。形式は、拡張子とファイルの中身の両方で確かめています`,
  });
}
const AssetUploadForm = z.object({
  file: z.file().describe("画像ファイル(PNG / JPEG / GIF / WebP / AVIF)"),
  // R2 のキーにそのまま入るので、Experiment と同じスラッグ形(`/` や `..` を含みえない)に絞る。
  // 実在確認は D1 で別途行う(不明なら 404)
  experimentId: z.string().regex(SLUG_RE).describe("この画像をぶら下げるエクスペリエンスの ID"),
});
const AssetListQuery = z.object({ experimentId: z.string().optional().describe("指定するとそのエクスペリエンスの画像だけに絞る") });

const UploadedAssetSchema = z.object({
  id: z.string(),
  publicUrl: z.string().describe("R2 の公開 URL。IMAGE の変更の src に指定できるのはこの配下だけ"),
  mime: z.string(),
  size: z.number().int().describe("バイト数"),
  key: z.string().describe("R2 のキー(`sites/<sid>/experiments/<eid>/<id>.<ext>`)"),
});
const AssetJsonSchema = z.object({
  id: z.string(),
  experimentId: z.string(),
  publicUrl: z.string(),
  mime: z.string(),
  size: z.number().int(),
  createdAt: z.number().int().describe("epoch ミリ秒"),
});

type UploadEnv = AppEnv & { Variables: { uploadSite: SiteRow; uploadStore: { bucket: R2Bucket; publicBase: string } } };

/**
 * B154(security triage v2 G19 (a)): アップロードの権限と構成を、本文を読む前に確かめる。
 * 権限の無い人(閲覧者・別のワークスペースの人)には本文を読まずに 403 / 404 を返す。
 * `experimentId` は本文にあるので、ここで見るのはサイトの権限だけ(エクスペリエンスの実在は本文を読んだ後)
 */
const uploadAccess = createMiddleware<UploadEnv>(async (c, next) => {
  // UploadEnv は AppEnv に変数を足しただけ(loadSite が読む auth / db / user はそのまま)。Context は変数の型について不変なので型だけ戻す
  const { site } = await loadSite(c as unknown as Context<AppEnv>, c.req.param("sid") ?? "", "editor");
  // 決定 43 (5): R2 なし構成は 409。Role 判定(loadSite)の後に置き、権限の無い相手に構成を漏らさない
  const store = imageStore(c.env);
  if (!store) throw new ApiError(409, "image_upload_disabled", { hint: IMAGE_DISABLED_HINT });
  c.set("uploadSite", site);
  c.set("uploadStore", store);
  await next();
});

/**
 * spec §13.5 / §13.7: multipart → R2。EDITOR 以上(認可判定は roles.ts の `loadSite`)。
 * 画像以外は 415 `unsupported_media_type`、上限(env `AB_ASSET_MAX_MB`、既定 5MB)超は 413 `asset_too_large`、
 * `experimentId` が不明なら 404(その Site の Experiment だけを見るのでテナントを越えて存在を漏らさない)
 */
assetRoutes.post(
  "/sites/:sid/assets",
  describeRoute({
    tags: ["assets"],
    summary: "画像を R2 にアップロードする(編集者以上)",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "アップロードした画像", content: { "application/json": { schema: resolver(UploadedAssetSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 413, 415, 422),
    },
  }),
  requireSession,
  uploadAccess,
  // B154: 本文の上限は権限の確かめの後・本文の解析(validator)の前。入口の既定の上限はこの経路に掛けない(body-limit.ts)
  assetUploadBodyLimit,
  validator("form", AssetUploadForm, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const site = c.get("uploadSite");
    const store = c.get("uploadStore");
    const valid = c.req.valid("form");
    const experimentId = valid.experimentId;
    // zod の `z.file()` は `typeof globalThis` から File を拾えないと出力型が `{ type, size }` まで縮む
    // (lib は ES2022 のみ + @cloudflare/workers-types。tsconfig のコメント参照)。実体は workerd の File なので戻す
    const file = valid.file as unknown as File;
    const db = c.get("db");
    const exp = await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", experimentId).executeTakeFirst();
    if (!exp) throw notFound();
    const maxMb = assetMaxMb(c.env.AB_ASSET_MAX_MB);
    if (file.size > maxMb * 1024 * 1024) throw new ApiError(413, "asset_too_large", { maxMb, size: file.size, message: "画像が大きすぎます", hint: `1 枚あたり ${maxMb}MB までです` });
    // 宣言だけでも先頭バイトだけでも足りない。両方が同じ種類を指したときだけ受ける。
    // 本体は 1 回だけ読む(先頭バイト用に slice し直すと 2 度読みになる)
    const bytes = await file.arrayBuffer();
    // IMAGE_TYPES は素のオブジェクトなので、`constructor` などの宣言で prototype のプロパティを引かないよう hasOwn で見る(B134)
    const spec = Object.hasOwn(IMAGE_TYPES, file.type) ? IMAGE_TYPES[file.type] : undefined;
    const head = new Uint8Array(bytes, 0, Math.min(MAGIC_BYTES, bytes.byteLength));
    if (!spec || head.length < MAGIC_BYTES || !spec.magic(head)) throw unsupportedImage(file.type, head);
    const id = newId("asset");
    const key = `sites/${site.id}/experiments/${experimentId}/${id}.${spec.ext}`;
    const publicUrl = `${store.publicBase}/${key}`;
    // R2 が先。put が落ちれば D1 に行が残らない(逆順だと参照先の無い行が残る)。
    // D1 が落ちたら R2 の孤児を消しにいく(ベストエフォート。失敗しても元のエラーを返す)
    await store.bucket.put(key, bytes, { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" } });
    try {
      await db
        .insertInto("assets")
        .values({
          id, site_id: site.id, experiment_id: experimentId, r2_key: key, public_url: publicUrl,
          mime: file.type, size: file.size, created_by: c.get("user").id, created_at: Date.now(),
        })
        .execute();
    } catch (e) {
      await store.bucket.delete(key).catch(() => {});
      throw e;
    }
    return c.json({ id, publicUrl, mime: file.type, size: file.size, key }, 201);
  },
);

/** spec §13.7: Site(必要なら Experiment)配下の画像一覧。VIEWER 以上 */
assetRoutes.get(
  "/sites/:sid/assets",
  describeRoute({
    tags: ["assets"],
    summary: "サイト配下の画像一覧(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "画像の一覧(新しい順)", content: { "application/json": { schema: resolver(z.array(AssetJsonSchema)) } } },
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("query", AssetListQuery, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    if (!imageStore(c.env)) return c.json([], 200); // D1 に古い行が残っていても R2 なしでは見せない(決定 43 (5))
    let q = c.get("db").selectFrom("assets").selectAll().where("site_id", "=", site.id).orderBy("created_at", "desc");
    const { experimentId } = c.req.valid("query");
    if (experimentId) q = q.where("experiment_id", "=", experimentId);
    const rows = await q.execute();
    return c.json(rows.map((a) => ({ id: a.id, experimentId: a.experiment_id, publicUrl: a.public_url, mime: a.mime, size: a.size, createdAt: a.created_at })));
  },
);

/**
 * ローカル開発と R2 カスタムドメイン未設定時の便宜(認証不要)。本番は R2 カスタムドメイン(Worker を経由しない、spec §13.7)。
 * `AB_ASSET_PUBLIC_BASE` が control 自身の `/dev-assets` を指すときだけ有効 = 本番設定では常に 404(review r1 CL-Medium-9)。
 * 契約(決定 34)の対象外なので describeRoute は付けない(openapi.test.ts の掃引も `/dev-assets` を除外する)
 */
const DEV_ASSET_KEY = /^sites\/[A-Za-z0-9_-]+\/experiments\/[A-Za-z0-9_-]+\/[a-z0-9_]+\.[a-z0-9]+$/;
assetRoutes.get("/dev-assets/*", async (c) => {
  const store = imageStore(c.env);
  if (!store || store.publicBase !== `${c.env.AB_CONTROL_URL}/dev-assets`) throw notFound();
  const key = c.req.path.replace(/^\/dev-assets\//, "");
  if (!DEV_ASSET_KEY.test(key)) throw notFound(); // 走査・パストラバーサル避け(R2 の配下だけを読む)
  const obj = await store.bucket.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});
