import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { describeRoute, resolver, validator } from "hono-openapi";
import { sql } from "kysely";
import { z } from "zod";
import {
  ASSET_NAME_CANDIDATES_PER_QUERY, ASSET_NAME_MAX, assetMaxMb, assetNameCandidates, assetNameKey, cleanAssetName, normalizeAssetName, pickFreeAssetName,
} from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import {
  ASSET_PURGE_GRACE_MS, assetJson, assetLimits, assetUsageOf, buildAssetList, emptyUsage, listAssetUsage, markAssetPendingDeletion,
  siteUsageQuery, usageFromResult, type AssetListRow, type AssetUsage,
} from "../asset-usage";
import { auditActor, auditStatement } from "../audit";
import { assetUploadBodyLimit } from "../body-limit";
import { imageStore, libraryDisabledHint } from "../capabilities";
import { toStatement, type Db, type SiteRow } from "../db";
import { ApiError, notFound, validationFailed } from "../errors";
import { newId } from "../ids";
import { errorResponses } from "../openapi";
import { loadSite } from "../roles";
import { thumbnailAfterUpload } from "../thumbnails";
import { readWriteFreeze, writeFrozenError } from "../write-freeze";

export const assetRoutes = new Hono<AppEnv>();

/**
 * spec §13.7: 受理する画像の種類。**宣言(multipart の Content-Type)と先頭バイトの両方**が一致したものだけを通す。
 * SVG は `<script>` を含みうる(= 配信ドメインでの XSS 経路になる)ので MVP では受けない。
 */
const AVIF_BRANDS = new Set(["avif", "avis", "mif1", "msf1"]);
export const IMAGE_TYPES: Record<string, { ext: string; label: string; magic: (b: Uint8Array) => boolean }> = {
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

/** アップロードで送ってよい項目は file と name だけ(それ以外は 422)。画像はサイトの持ち物なので experimentId は受けない */
const AssetUploadForm = z.strictObject({
  file: z.file().describe("画像ファイル(PNG / JPEG / GIF / WebP / AVIF)"),
  name: z
    .string()
    .optional()
    .describe("管理用の名前(管理画面と API の中だけで使い、公開 URL には入らない)。省略するとファイル名。100 字を超える分は拡張子を残して切る。サイトの中で重なると番号を付ける"),
});
const EXPERIMENT_ID_HINT = "画像はサイトに属します。experimentId は送らないでください";
const AssetRenameBody = z.strictObject({ name: z.string().describe("新しい管理用の名前(1〜100 字。前後の空白は落とす)") });

const UsedBySchema = z.object({ experimentId: z.string(), variantId: z.string() });
const AssetJsonSchema = z.object({
  id: z.string(),
  name: z.string().describe("管理用の名前。公開 URL・配信には出ない"),
  publicUrl: z.string().describe("公開 URL。IMAGE の変更の src に指定する"),
  thumbnailUrl: z.string().nullable().describe("縮小版(幅 320px の WebP)の URL。まだ無ければ null"),
  thumbnail: z.enum(["pending", "ready", "failed", "skipped"]).describe("縮小版の状態"),
  mime: z.string(),
  size: z.number().int().describe("バイト数"),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  createdBy: z.object({ id: z.string(), name: z.string().nullable() }),
  usedBy: z.array(UsedBySchema).describe("下書きの IMAGE の src・ATTRIBUTE の src でこの画像を使っているパターン"),
  deliveredIn: z
    .array(z.string())
    .describe("公開したときの内容(公開の記録)でこの画像を使っているエクスペリエンスの ID。空でない間は、その画像は削除できない(そのエクスペリエンスを削除するまで)"),
  inUse: z.boolean().describe("usedBy か deliveredIn が空でない。true の画像は削除待ちにできない(409 asset_in_use)"),
  keptAt: z
    .number()
    .int()
    .nullable()
    .describe("削除待ちにした画像が、使われているのが見つかって自動で一覧に戻された時刻(epoch ミリ秒)。もう一度削除待ちにするまで残る。戻されたことが無ければ null"),
});
const UsageSchema = z
  .object({
    count: z.number().int().describe("画像の枚数(削除待ちを含む)"),
    bytes: z.number().int().describe("画像の合計バイト数(削除待ちを含む)"),
    pendingCount: z.number().int().describe("削除待ちの枚数(count の内数。消えるか一覧に戻るまで count・bytes に数える)"),
    pendingBytes: z.number().int().describe("削除待ちの合計バイト数(bytes の内数。消えるか一覧に戻るまで数える)"),
    maxCount: z.number().int().describe("サイトの枚数の上限"),
    maxBytes: z.number().int().describe("サイトの合計バイト数の上限"),
    maxFileBytes: z.number().int().describe("1 枚の大きさの上限(バイト)"),
  })
  .describe("サイトの画像の使用量と上限");
const ExperimentRefSchema = z.object({
  name: z.string(),
  status: z.string(),
  variants: z.record(z.string(), z.string()).describe("パターンの ID → 名前(usedBy に出るものだけ)"),
});
/** 一覧の 1 件。URL は各件に繰り返さず、上の段の urlPrefix と path で表す(1,000 枚のときの応答を小さくするため) */
const AssetListItemSchema = AssetJsonSchema.omit({ publicUrl: true, thumbnailUrl: true, createdBy: true }).extend({
  creator: z.number().int().nonnegative().describe("作った人。上の段の creators の添字(0 から)。作った人の ID と名前は creators[creator] で引く"),
  path: z.string().optional().describe("公開 URL の urlPrefix より後ろ(例 images/<id>.png)。公開 URL = urlPrefix + path。publicUrl が入る件には無い"),
  publicUrl: z
    .string()
    .optional()
    .describe("公開 URL が urlPrefix で始まらない件(公開ベースを変える前に上げた画像)だけ入る。そのときは path の代わりにこの値をそのまま使う"),
  thumbnailUrl: z
    .string()
    .nullable()
    .optional()
    .describe("縮小版の URL が決まった形(urlPrefix + thumbs/<id>.webp、thumbnail が ready のときだけ)でない件だけ入る。無ければ決まった形で作る"),
});
const AssetListSchema = z.object({
  urlPrefix: z
    .string()
    .nullable()
    .describe("各件の公開 URL の前半(<公開ベース>/sites/<sid>/)。公開 URL = urlPrefix + path、縮小版の URL = urlPrefix + thumbs/<id>.webp(thumbnail が ready のとき)。画像のライブラリを使えない導入では null"),
  assets: z.array(AssetListItemSchema).describe("画像(新しい順。削除待ちは含まない)"),
  creators: z
    .array(z.object({ id: z.string().describe("作った人のユーザー ID"), name: z.string().nullable().describe("作った人の名前。ユーザーが消えていれば null") }))
    .describe("一覧に出る画像を作った人(一覧に最初に出た順)。各件の creator がこの配列の添字。ID と名前を各件に繰り返さないため"),
  experiments: z.record(z.string(), ExperimentRefSchema).describe("usedBy・deliveredIn に出るエクスペリエンスの名前と状態"),
  usage: UsageSchema,
});
const UploadedAssetSchema = AssetJsonSchema.extend({
  renamedFrom: z.string().optional().describe("名前が重なって番号を付けたときだけ、元の名前"),
  usage: UsageSchema,
});
/** 名前の変更の応答は使い方を読まないので、usedBy・deliveredIn は空・inUse は false で返る(使い方は一覧で読む) */
const RenamedAssetSchema = AssetJsonSchema.extend({
  usedBy: z.array(UsedBySchema).describe("名前の変更の応答では使い方を読まないため、いつも空の配列。使っているパターンは GET /sites/{sid}/assets で読む"),
  deliveredIn: z.array(z.string()).describe("名前の変更の応答では使い方を読まないため、いつも空の配列。使っているエクスペリエンスは GET /sites/{sid}/assets で読む"),
  inUse: z.boolean().describe("名前の変更の応答では使い方を読まないため、使われている画像でもいつも false。使用中かは GET /sites/{sid}/assets で読む"),
  usage: UsageSchema,
});
const PendingDeletionSchema = z.object({
  status: z.literal("pending_deletion").describe("削除待ちにした。R2 のファイルはまだ消えていない"),
  purgeAfter: z.number().int().describe("この時刻(epoch ミリ秒)の後に、どこでも使われていなければ消える"),
  usage: UsageSchema,
});

type Store = { bucket: R2Bucket; publicBase: string };
type UploadEnv = AppEnv & { Variables: { uploadSite: SiteRow; uploadStore: Store } };

/** 名前の重なりの UNIQUE(同時に同じ名前を上げた・名前の変更で重なった)。D1 は例外の message に制約の名前を入れる */
const isNameConflict = (e: unknown): boolean =>
  e instanceof Error && e.message.includes("UNIQUE constraint failed: assets.site_id, assets.name_key");

/**
 * アップロード 1 回で、名前の照会と書き込みの batch に使ってよい D1 の呼び出しの数(最初の「上限と候補」の batch を含む)。
 * 既定の上限 1,000 枚が同じ本体の名前で埋まっていても、照会 20 回(50 個ずつ)+ 窓の繰り越し 1 + 書き込み 3 回 = 24 で収まる。
 * セッション・loadSite・凍結の確かめ(最大 5)と後の縮小版の更新(最大 2)を足しても、Workers Free の 1 回の要求の上限 50 の内
 */
const UPLOAD_NAME_TRIPS_MAX = 25;
/** 名前の候補を調べ切れなかった(同じ名前の画像が多すぎる) */
const nameTakenTooMany = () =>
  new ApiError(409, "asset_name_taken", { path: ["name"], hint: "同じ名前の画像が多すぎます。別の名前を付けてアップロードしてください" });

const quotaExceeded = (usage: AssetUsage) =>
  new ApiError(409, "asset_quota_exceeded", {
    usage,
    hint: `1 サイトあたり ${usage.maxCount} 枚・合計 ${Math.floor(usage.maxBytes / 1024 / 1024)}MB までです。使っていない画像を削除してください(削除待ちの画像も、消えるまで数えます)`,
  });

/**
 * R2 なしの導入は 409。権限の確かめ(loadSite)の後に置き、権限の無い相手に構成を漏らさない。
 * hint はライブラリの口の文(B68 spec §8)。アップローダーの判定(`/capabilities.imageUploader`)はアップローダーの作業が渡す。B68 の時点ではいつも「なし」
 */
function requireStore(env: AppEnv["Bindings"]): Store {
  const store = imageStore(env);
  if (!store) throw new ApiError(409, "image_upload_disabled", { hint: libraryDisabledHint(false) });
  return store;
}

/** 1 件の行(作った人の名前を join)を読む文 */
const assetRowQuery = (db: Db, siteId: string) =>
  db
    .selectFrom("assets")
    .leftJoin("user", "user.id", "assets.created_by")
    .selectAll("assets")
    .select("user.name as creator_name")
    .where("assets.site_id", "=", siteId);

/**
 * B154(security triage v2 G19 (a)): アップロードの権限と構成を、本文を読む前に確かめる。
 * 権限の無い人(閲覧者・別のワークスペースの人)には本文を読まずに 403 / 404 を返す
 */
const uploadAccess = createMiddleware<UploadEnv>(async (c, next) => {
  // UploadEnv は AppEnv に変数を足しただけ(loadSite が読む auth / db / user はそのまま)。Context は変数の型について不変なので型だけ戻す
  const { site } = await loadSite(c as unknown as Context<AppEnv>, c.req.param("sid") ?? "", "editor");
  c.set("uploadSite", site);
  c.set("uploadStore", requireStore(c.env));
  await next();
});

/**
 * B68(spec §4.2): multipart → R2 → D1。編集者以上。画像はサイトの持ち物(エクスペリエンスに属さない)。
 * 順: 権限と構成 → 本文の上限 → 項目の検査 → 1 枚の上限(413)→ 形式(415)→ サイトの上限と名前の候補の照会(D1 1 往復)
 * → R2 に put → 上限の内に収まるときだけ足す 1 文 + 使用量の読み(同じ DB.batch)→ 201
 */
assetRoutes.post(
  "/sites/:sid/assets",
  describeRoute({
    tags: ["assets"],
    summary: "画像をサイトにアップロードする(編集者以上)。名前は管理用で、公開 URL には入らない。サイトの中で重なると番号を付ける",
    description:
      "multipart/form-data で file と name(任意)だけを送る。それ以外の項目(experimentId など)は 422。応答の publicUrl を IMAGE の変更の src に指定する。409: asset_quota_exceeded(サイトの枚数・合計の上限。削除待ちの画像も消えるまで数える)/ asset_name_taken(同時に同じ名前が上がった・同じ名前(番号違いを含む)の画像が多すぎて番号を付けられない。別の名前で送り直す)/ image_upload_disabled(この導入では画像のライブラリを使えない)。",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "アップロードした画像(一覧の 1 件と同じ形)と、足した後の使用量", content: { "application/json": { schema: resolver(UploadedAssetSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 413, 415, 422),
    },
  }),
  requireSession,
  uploadAccess,
  // B154: 本文の上限は権限の確かめの後・本文の解析(validator)の前。入口の既定の上限はこの経路に掛けない(body-limit.ts)
  assetUploadBodyLimit,
  validator("form", AssetUploadForm, (r) => {
    if (r.success) return;
    // 前の形の experimentId を送ってきたら、黙って捨てずに理由を伝える(古い手順で「紐づけたつもり」に気づけるように)
    const sentExperimentId = r.error.some((i) => "keys" in i && Array.isArray(i.keys) && i.keys.includes("experimentId"));
    if (sentExperimentId) {
      const base = validationFailed(r.error);
      throw new ApiError(422, "validation_failed", { ...base.extra, path: ["experimentId"], message: "experimentId は受け付けません", hint: EXPERIMENT_ID_HINT });
    }
    throw validationFailed(r.error);
  }),
  async (c) => {
    const site = c.get("uploadSite");
    const store = c.get("uploadStore");
    const valid = c.req.valid("form");
    // zod の `z.file()` は `typeof globalThis` から File を拾えないと出力型が `{ type, size }` まで縮む
    // (lib は ES2022 のみ + @cloudflare/workers-types。tsconfig のコメント参照)。実体は workerd の File なので戻す
    const file = valid.file as unknown as File;
    const db = c.get("db");
    const env = c.env;
    const limits = assetLimits(env);
    const maxMb = assetMaxMb(env.AB_ASSET_MAX_MB);
    if (file.size > maxMb * 1024 * 1024) throw new ApiError(413, "asset_too_large", { maxMb, size: file.size, message: "画像が大きすぎます", hint: `1 枚あたり ${maxMb}MB までです` });
    // 宣言だけでも先頭バイトだけでも足りない。両方が同じ種類を指したときだけ受ける。
    // 本体は 1 回だけ読む(先頭バイト用に slice し直すと 2 度読みになる)
    const bytes = await file.arrayBuffer();
    // IMAGE_TYPES は素のオブジェクトなので、`constructor` などの宣言で prototype のプロパティを引かないよう hasOwn で見る(B134)
    const spec = Object.hasOwn(IMAGE_TYPES, file.type) ? IMAGE_TYPES[file.type] : undefined;
    const head = new Uint8Array(bytes, 0, Math.min(MAGIC_BYTES, bytes.byteLength));
    if (!spec || head.length < MAGIC_BYTES || !spec.magic(head)) throw unsupportedImage(file.type, head);

    // 名前: 指定が無い・空ならファイル名、それも空なら「画像」。100 字を超える分は拡張子を残して切る
    const baseName = normalizeAssetName(valid.name ?? "") || normalizeAssetName(file.name) || "画像";
    /** 番号の候補のうち使われている key を引く 1 文。fromN = 2 のときは元の名前の key も入れる(pickFreeAssetName の前提) */
    const takenQuery = (fromN: number) => {
      const keys = assetNameCandidates(baseName, fromN, ASSET_NAME_CANDIDATES_PER_QUERY).map(assetNameKey);
      if (fromN === 2) keys.unshift(assetNameKey(baseName));
      return db
        .selectFrom("assets")
        .select("name_key")
        .where("site_id", "=", site.id)
        .where(sql<boolean>`name_key IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`);
    };
    const takenOf = (r: D1Result | undefined) => ((r?.results ?? []) as Array<{ name_key: string }>).map((x) => x.name_key);
    /**
     * 名前の選び方の状態。照会で分かった「使われている key」と、UNIQUE で負けた名前の key をため、
     * 候補の窓(fromN から 50 個)は前にだけ進める。書き直しのたびに最初から照会し直さない(I1: 同じ本体の名前が
     * 上限近くあるとき、書き直しごとに 20 回の照会をやり直すと D1 の呼び出しが 1 回の要求で 50 を超える)
     */
    const taken = new Set<string>();
    let fromN = 2;
    /** 名前の照会と書き込みの batch の回数(最初の「上限と候補」の batch を含む)。UPLOAD_NAME_TRIPS_MAX を超えたら 409 */
    let nameTrips = 0;
    const spendNameTrip = () => {
      if (++nameTrips > UPLOAD_NAME_TRIPS_MAX) throw nameTakenTooMany();
    };
    /** 空いている名前を選ぶ。今の窓の候補がすべて埋まっていれば、窓を 50 進めて次の 50 個だけを照会する */
    const pickName = async (): Promise<string> => {
      for (;;) {
        const picked = pickFreeAssetName(baseName, taken, fromN);
        if (picked !== null) return picked;
        fromN += ASSET_NAME_CANDIDATES_PER_QUERY;
        spendNameTrip();
        for (const k of takenOf((await env.DB.batch([toStatement(env, takenQuery(fromN))]))[0])) taken.add(k);
      }
    };

    // サイトの上限の見込みと名前の候補を 1 往復で読む(超えていれば R2 に置く前に断る)
    spendNameTrip();
    const [usedRes, takenRes] = await env.DB.batch([toStatement(env, siteUsageQuery(db, site.id)), toStatement(env, takenQuery(2))]);
    const before = usageFromResult(usedRes, limits);
    if (before.count >= limits.maxCount || before.bytes + file.size > limits.maxBytes) throw quotaExceeded(before);
    for (const k of takenOf(takenRes)) taken.add(k);
    let name = await pickName();

    const id = newId("asset");
    // 元のファイル名はキー・公開 URL・customMetadata のどれにも入れない(社内の案件名などを公開 URL に出さない)
    const key = `sites/${site.id}/images/${id}.${spec.ext}`;
    const publicUrl = `${store.publicBase}/${key}`;
    const thumbState = env.IMAGES ? "pending" : "skipped";
    const user = c.get("user");
    const now = Date.now();
    /** 上限の内に収まるときだけ行を足す 1 文(同時のアップロードでも超えない。削除待ちも数える) */
    const insertQuery = (n: string) =>
      db
        .insertInto("assets")
        .columns(["id", "site_id", "name", "name_key", "r2_key", "public_url", "mime", "size", "thumb_state", "created_by", "created_at", "updated_at"])
        .expression(
          db
            .selectFrom("sites")
            .where("sites.id", "=", site.id)
            .where(sql<number>`(SELECT count(*) FROM assets WHERE site_id = ${site.id})`, "<", limits.maxCount)
            .where(sql<number>`(SELECT coalesce(sum(size), 0) FROM assets WHERE site_id = ${site.id}) + ${file.size}`, "<=", limits.maxBytes)
            .select([
              sql.val(id).as("id"),
              sql.val(site.id).as("site_id"),
              sql.val(n).as("name"),
              sql.val(assetNameKey(n)).as("name_key"),
              sql.val(key).as("r2_key"),
              sql.val(publicUrl).as("public_url"),
              sql.val(file.type).as("mime"),
              sql.val(file.size).as("size"),
              sql.val(thumbState).as("thumb_state"),
              sql.val(user.id).as("created_by"),
              sql.val(now).as("created_at"),
              sql.val(now).as("updated_at"),
            ]),
        );

    // R2 が先。put が落ちれば D1 に行が残らない(逆順だと参照先の無い行が残る)。
    // put の後に行を足せずに終わる経路(上限・名前の使い切り・候補の取り直しの失敗を含むすべての例外)は、
    // 外側の catch で R2 の孤児を消しにいく(ベストエフォート。失敗しても元の結果を返す)
    await store.bucket.put(key, bytes, { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" } });
    let usage: AssetUsage;
    try {
      let written: D1Result | undefined;
      let usedAfter: D1Result | undefined;
      for (let attempt = 0; ; attempt++) {
        spendNameTrip();
        try {
          // 足す 1 文と使用量の読みを同じ batch に入れ、batch の時点の使用量を 201 と上限の 409 に返す。
          // B129(spec §3.1 の asset.upload): 操作の記録も同じ batch の後に置く(往復は 1 回のまま。記録が書けなければ行も残らず、R2 の孤児を消す)。
          // 足す文は上限の条件付きなので、記録は「この要求が足した行がある」ときだけ書く(上限の 409 では書かない)
          [written, usedAfter] = await env.DB.batch([
            toStatement(env, insertQuery(name)),
            toStatement(env, siteUsageQuery(db, site.id)),
            auditStatement(
              env.DB,
              auditActor(c),
              { action: "asset.upload", workspaceId: site.workspace_id, siteId: site.id, target: { type: "asset", id, label: name }, detail: { bytes: file.size, type: file.type } },
              { now, guard: sql<boolean>`exists (select 1 from assets where site_id = ${site.id} and id = ${id})` },
            ),
          ]);
          break;
        } catch (e) {
          if (!isNameConflict(e)) throw e;
          // 同時に同じ名前が上がった: 負けた名前を埋まっているものに足し、その続きから選び直して 2 回まで書き直す
          if (attempt >= 2) throw new ApiError(409, "asset_name_taken", { path: ["name"], hint: "同じ名前の画像が同時に上がりました。もう一度アップロードしてください" });
          taken.add(assetNameKey(name));
          name = await pickName();
        }
      }
      usage = usageFromResult(usedAfter, limits);
      if ((written?.meta.changes ?? 0) === 0) throw quotaExceeded(usage);
    } catch (e) {
      await store.bucket.delete(key).catch(() => {});
      throw e;
    }
    const row: AssetListRow = {
      id, site_id: site.id, name, name_key: assetNameKey(name), r2_key: key, public_url: publicUrl, mime: file.type, size: file.size,
      width: null, height: null, thumb_key: null, thumb_state: thumbState, thumb_attempts: 0,
      created_by: user.id, created_at: now, deleted_at: null, deleted_by: null, kept_at: null, purge_marked_at: null, updated_at: now,
      creator_name: user.name,
    };
    // 縮小版は応答を返した後に 1 回だけ作る(spec §5.2)。元の画像は手元の bytes を使い、R2 から読み直さない。
    // 失敗は回数を 1 つ増やして pending のまま残す(Cron が拾う)。Images の binding が無い導入は作らない(skipped)
    if (env.IMAGES) c.executionCtx.waitUntil(thumbnailAfterUpload(env, { id, site_id: site.id }, bytes));
    return c.json(
      { ...assetJson(row, store.publicBase, !!env.IMAGES, { usedBy: [], deliveredIn: [] }), ...(name !== baseName ? { renamedFrom: baseName } : {}), usage },
      201,
    );
  },
);

/**
 * B68(spec §4.1): サイトの画像の一覧と使用量。閲覧者以上。クエリの引数は持たない(前の形の `?experimentId=` は無視する)。
 * loadSite の後に、画像の行・下書きの使い方・公開したときの定義の使い方を並べて読む(D1 3 回を並列)
 */
assetRoutes.get(
  "/sites/:sid/assets",
  describeRoute({
    tags: ["assets"],
    summary: "サイトの画像の一覧と使用量(閲覧者以上)。使っているパターンは下書きの IMAGE と ATTRIBUTE の src から、公開したときの内容での使用は公開の記録から数える",
    description:
      "各件は公開 URL を持たず、urlPrefix + path が公開 URL(IMAGE の変更の src に書く値)、縮小版は thumbnail が ready のとき urlPrefix + thumbs/<id>.webp。公開ベースを変える前に上げた画像だけは path の代わりに publicUrl が入る。削除待ちの画像は assets に含まれない(usage の count・bytes には含まれ、pendingCount・pendingBytes がその分)。inUse が false でも、HTML・CSS の中だけで使っている画像は「未使用」と出る(削除待ちにした後に、見つかれば自動で戻る)。",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "画像の一覧(新しい順)・使っているエクスペリエンス・使用量", content: { "application/json": { schema: resolver(AssetListSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const limits = assetLimits(c.env);
    const store = imageStore(c.env);
    // D1 に古い行が残っていても R2 なしでは見せず、数にも入れない(決定 43 (5))
    if (!store) return c.json({ urlPrefix: null, assets: [], creators: [], experiments: {}, usage: emptyUsage(limits) });
    const db = c.get("db");
    const [rows, maps] = await Promise.all([
      assetRowQuery(db, site.id).orderBy("assets.created_at", "desc").orderBy("assets.id", "desc").execute(),
      listAssetUsage(db, site.id),
    ]);
    return c.json(buildAssetList(rows as AssetListRow[], maps, { siteId: site.id, publicBase: store.publicBase, imagesOn: !!c.env.IMAGES, limits }));
  },
);

/**
 * B68(spec §4.3): 管理用の名前を変える。編集者以上。公開 URL は変わらず、サイトの未公開の変更にも数えない。
 * 更新・使用量の読み・行の読み直しを 1 つの DB.batch で流す
 */
assetRoutes.patch(
  "/sites/:sid/assets/:aid",
  describeRoute({
    tags: ["assets"],
    summary: "画像の管理用の名前を変える(編集者以上)。公開 URL は変わらない",
    description:
      "本文は { name }(1〜100 字)だけ。公開 URL は変わらず、サイトの未公開の編集にも数えない。409 asset_name_taken: 同じ名前の画像がある(削除待ちの画像も、消えるまで名前を使っている)。応答の usedBy・deliveredIn・inUse は使い方を読まない値(空・空・false)なので、使い方は一覧で読む。",
    security: [{ bearer: [] }],
    responses: {
      200: {
        description:
          "名前を変えた画像と使用量。名前の変更の応答では使い方を読まない: usedBy・deliveredIn は空の配列、inUse は false で返る(使用中の画像でも同じ)。使い方は一覧(GET /sites/{sid}/assets)で読む",
        content: { "application/json": { schema: resolver(RenamedAssetSchema) } },
      },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", AssetRenameBody, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const store = requireStore(c.env);
    // 名前の変更は切らない(切るのはアップロードのときだけ)。整えた結果が空・101 字以上は 422
    const name = cleanAssetName(c.req.valid("json").name);
    if (name === "" || name.length > ASSET_NAME_MAX) {
      throw new ApiError(422, "validation_failed", {
        path: ["name"],
        message: name === "" ? "名前が空です" : `名前は ${ASSET_NAME_MAX} 字までです`,
        hint: `1〜${ASSET_NAME_MAX} 字の名前にしてください`,
      });
    }
    const db = c.get("db");
    const env = c.env;
    const aid = c.req.param("aid");
    const now = Date.now();
    let res: D1Result[];
    try {
      // B129(spec §3.1 の asset.rename): 記録は名前を変える文の前に置き、前の名前を同じ文で読む。guard は変える文と同じ条件
      // (無い・削除待ちの 404 では書かない)。同じ名前の 409 は batch ごと失敗するので記録も残らない。往復は 1 回のまま
      res = await env.DB.batch([
        auditStatement(
          env.DB,
          auditActor(c),
          {
            action: "asset.rename",
            workspaceId: site.workspace_id,
            siteId: site.id,
            target: { type: "asset", id: aid, label: name },
            detail: { from: sql`(select substr(name, 1, 200) from assets where site_id = ${site.id} and id = ${aid})`, to: name },
          },
          { now, guard: sql<boolean>`exists (select 1 from assets where site_id = ${site.id} and id = ${aid} and deleted_at is null)` },
        ),
        toStatement(
          env,
          db
            .updateTable("assets")
            .set({ name, name_key: assetNameKey(name), updated_at: now })
            .where("site_id", "=", site.id)
            .where("id", "=", aid)
            .where("deleted_at", "is", null),
        ),
        toStatement(env, siteUsageQuery(db, site.id)),
        toStatement(env, assetRowQuery(db, site.id).where("assets.id", "=", aid)),
      ]);
    } catch (e) {
      if (isNameConflict(e)) {
        throw new ApiError(409, "asset_name_taken", { path: ["name"], hint: "同じ名前の画像がこのサイトにあります(削除待ちの画像も含みます)。別の名前にしてください" });
      }
      throw e;
    }
    const [, written, used, read] = res;
    const row = read?.results?.[0] as AssetListRow | undefined;
    if ((written?.meta.changes ?? 0) === 0 || !row) throw notFound(); // 無い・削除待ち
    // 使い方は読まない(画面は手元の値を残す)。deliveredIn・inUse もこの応答では空として返す
    return c.json({ ...assetJson(row, store.publicBase, !!env.IMAGES, { usedBy: [], deliveredIn: [] }), usage: usageFromResult(used, assetLimits(env)) });
  },
);

/**
 * B68(spec §4.4): 画像を削除待ちにする。編集者以上。下書きの IMAGE・ATTRIBUTE の src か、公開したときの定義で使われていれば 409。
 * 判定と印は 1 文(markAssetPendingDeletion)。R2 には触れない(猶予の後に Cron が消す)
 */
assetRoutes.delete(
  "/sites/:sid/assets/:aid",
  describeRoute({
    tags: ["assets"],
    summary: "画像を削除待ちにする(編集者以上)。24 時間の後に、どこでも使われていなければ消える。パターンの変更か、公開したときの内容で使われている間は 409",
    description:
      "200 は削除待ちにしただけで、ファイルはまだ消えない(purgeAfter の後に、どこでも使われていなければ消える。使われていれば残って一覧に戻る)。409 asset_in_use: 下書きのパターンの変更(usedBy)か、公開したときの内容(deliveredIn)で使われている。usedBy のパターンの変更から外す。deliveredIn は、そのエクスペリエンスを削除するまで消せない。",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "削除待ちにした(status と、消える時刻 purgeAfter)と使用量", content: { "application/json": { schema: resolver(PendingDeletionSchema) } } },
      ...errorResponses(401, 403, 404, 409),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    requireStore(c.env);
    const db = c.get("db");
    const aid = c.req.param("aid");
    const now = Date.now();
    // 成功の経路は印の 1 文(+ 使用量の読み)の 1 往復だけ。先に行を読まない
    // B129(spec §3.1 の asset.delete): 記録は印の文の後に置き、この要求が書いた印(deleted_at = now・deleted_by = 自分)を guard にする
    // (使われている・無い・凍結で 0 行のときは書かない)。対象の名前も同じ文で読む。往復は 1 回のまま
    const uid = c.get("user").id;
    const audit = auditStatement(
      c.env.DB,
      auditActor(c),
      {
        action: "asset.delete",
        workspaceId: site.workspace_id,
        siteId: site.id,
        target: { type: "asset" },
        targetFrom: sql`select id as target_id, name as target_label from assets where site_id = ${site.id} and id = ${aid} and deleted_at = ${now} and deleted_by = ${uid}`,
      },
      { now },
    );
    const { marked, usage } = await markAssetPendingDeletion(c.env, db, site.id, aid, uid, now, [audit]);
    if (marked) return c.json({ status: "pending_deletion" as const, purgeAfter: now + ASSET_PURGE_GRACE_MS, usage });
    // 0 行のときだけ理由を読む(行の有無 1 + 使い方 1(2 文を 1 つの batch)): 無い・削除待ち → 404 / 使われている → 409
    const fresh = await db.selectFrom("assets").select(["id", "public_url", "deleted_at"]).where("site_id", "=", site.id).where("id", "=", aid).executeTakeFirst();
    if (!fresh || fresh.deleted_at !== null) throw notFound();
    const uses = await assetUsageOf(c.env, db, site.id, fresh);
    if (uses.usedBy.length === 0 && uses.deliveredIn.length === 0) {
      // 使われていないのに 0 行 = 入口の関門の後に凍結が入った(条件の NOT_FROZEN_SQL)
      const f = await readWriteFreeze(db);
      if (f) throw writeFrozenError(f, Date.now());
      throw new ApiError(409, "conflict", { hint: "別の操作と競合しました。画面を読み込み直してください" });
    }
    throw new ApiError(409, "asset_in_use", {
      usedBy: uses.usedBy,
      deliveredIn: uses.deliveredIn,
      experiments: uses.experiments,
      hint: "パターンの変更から外してください。公開したときの内容で使われている画像は、そのエクスペリエンスを削除するまで削除できません",
    });
  },
);

/**
 * ローカル開発と R2 カスタムドメイン未設定時の便宜(認証不要)。本番は R2 カスタムドメイン(Worker を経由しない、spec §13.7)。
 * `AB_ASSET_PUBLIC_BASE` が control 自身の `/dev-assets` を指すときだけ有効 = 本番設定では常に 404(review r1 CL-Medium-9)。
 * 契約(決定 34)の対象外なので describeRoute は付けない(openapi.test.ts の掃引も `/dev-assets` を除外する)。
 * キーは 3 つの形(B68): 今ある画像 `sites/<sid>/experiments/<eid>/<id>.<ext>`・新しい画像 `sites/<sid>/images/<id>.<ext>`・縮小版 `sites/<sid>/thumbs/<id>.webp`
 */
const DEV_ASSET_KEY = /^sites\/[A-Za-z0-9_-]+\/(?:experiments\/[A-Za-z0-9_-]+|images|thumbs)\/[a-z0-9_]+\.[a-z0-9]+$/;
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
