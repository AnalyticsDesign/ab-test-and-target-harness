import { RELEASE_VERSION } from "./generated/release";
import { z } from "zod";
import { API_CONTRACT_VERSION, MIN_CLIENT_VERSION } from "@wtt/core";
import { passwordLoginOpen } from "./break-glass";
import type { Env } from "./env";

/**
 * 決定 43 (4): R2 の有効 / 無効は「binding と公開ベースの両方があるときだけ有効」の 1 か所で決める。
 * アップロード・IMAGE の検証・/dev-assets・/capabilities がこれを共有する(Site 削除の後始末は binding の有無だけを見る。Task 2)。
 * binding があって公開ベースが空・不正なのは設定漏れ(公開 URL を組み立てられない)なので無効側に倒す。
 * 入力ファイルの `none` を誤って env に写した場合も URL でないので無効になる
 */
export function imageStore(env: Env): { bucket: R2Bucket; publicBase: string } | null {
  if (!env.ASSETS) return null;
  const raw = env.AB_ASSET_PUBLIC_BASE?.trim() ?? "";
  let base: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    base = u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (base === "") return null;
  return { bucket: env.ASSETS, publicBase: base };
}

/**
 * B68 spec §4.5(正はアップローダーの spec §5.1「公開ベースの形」): R2 なしの画像アップローダーの公開ベース(origin)。
 * 前後の空白を落とした値が URL として読め、`https:`(ホスト名が `localhost`・`127.0.0.1` のときだけ `http:` も受ける)、
 * 利用者名・パスワード・クエリ・フラグメントが無く、パスが無いか `/` だけのときだけ、末尾の `/` を落とした形を返す。外れる値・空は null。
 * `imageStore` とは別の関数(あちらは `/dev-assets` のためにどのホストの `http:` も受け、パスも許す)。
 * **公開ベースの判定はここ 1 か所だけ**: IMAGE の確かめる順の 1・公開と開始・再開の取り出し・確認の画面・アップローダーの `uploaderEnabled(env)` がこの値を使う
 */
export function uploaderPublicBase(env: Env): string | null {
  const raw = env.AB_UPLOADER_PUBLIC_BASE?.trim() ?? "";
  if (raw === "") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  // `?`・`#` だけ(中身が空)でも search / hash は空になるので、元の文字列でも見る
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(raw)) return null;
  if (u.pathname !== "/") return null;
  return u.origin;
}

/**
 * IMAGE の 422 image_upload_disabled(R2 もアップローダーも無い導入)の hint。代替は ATTRIBUTE の src。
 * B285(v1.0): アップローダーは公開文書に説明が無いので、案内は R2 だけにする(ライブラリの口のアップローダーなしの文と同じ)。
 * アップローダーの作業が公開されるときに、案内の文を決め直す。文言は公開物なので設計記録への参照を書かない
 */
export const IMAGE_DISABLED_HINT =
  "画像の差し替えは ATTRIBUTE の src で行えます。有効にするには R2 バケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定して再デプロイします";

/**
 * B68 spec §8: ライブラリの口(POST /sites/:sid/assets・PATCH・DELETE …/assets/:aid)の 409 image_upload_disabled の hint。
 * IMAGE の 422 と定数を分ける(アップローダーのある導入で、設定済みの変数を「設定して」と案内しないため)
 */
export const LIBRARY_DISABLED_HINT = {
  noUploader:
    "画像の差し替えは ATTRIBUTE の src で行えます。有効にするには R2 バケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定して再デプロイします",
  withUploader: "この導入では、画像は左メニューの「画像」からアップロードします(API は /sites/<siteId>/uploads)",
} as const;
/** `uploaderOn` は `/capabilities.imageUploader` と同じ判定(アップローダーの作業が渡す。B68 では false) */
export const libraryDisabledHint = (uploaderOn: boolean): string => (uploaderOn ? LIBRARY_DISABLED_HINT.withUploader : LIBRARY_DISABLED_HINT.noUploader);

/** 決定 44 (4): edge の公開 origin。不正な値・未設定は null(既存導入では帯を出さない) */
export function edgeOrigin(env: Env): string | null {
  const raw = env.AB_EDGE_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** 決定 52 (7) / plan K11: 設置タグの origin(配信専用の Worker)。AB_STATIC_ORIGIN が無ければ edge と同じホスト */
export function tagOrigin(env: Env): string | null {
  const raw = env.AB_STATIC_ORIGIN?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // 不正な値は edge と同じホストとみなす
    }
  }
  return edgeOrigin(env);
}

export function edgeOnWorkersDev(env: Env): boolean {
  const origin = edgeOrigin(env);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return host === "workers.dev" || host.endsWith(".workers.dev");
}

/**
 * D9 ②(設計書 §6.6): 計測用 D1(wtt-results)の binding があるか。無ければ Site で結果の記録を有効にできず(409 results_store_missing)、
 * 開始してもテストに run_id を振らない。edge 側の準備(binding と secret)は導入の手順で確かめる
 */
export function resultsStore(env: Env): boolean {
  return env.RESULTS_DB !== undefined;
}

export const CapabilitiesSchema = z.object({
  productVersion: z.string().describe("この導入の製品の版名(公開リポジトリの Release と同じ v1.0 の形)。公開版でない build では dev。ログインした人と API キーにだけ返す"),
  imageUpload: z.boolean().describe("画像アップロードと IMAGE の変更が使えるか(R2 と公開ベース URL が設定されているとき true)"),
  edgeOrigin: z.string().nullable().describe("edge(訪問者のブラウザが decision / event を送る先)の公開 origin。未設定なら null"),
  tagOrigin: z.string().nullable().describe("設置タグ(/s/<siteId>.js)を配る公開 origin。未設定なら null"),
  edgeOnWorkersDev: z.boolean().describe("edge を *.workers.dev で公開しているか(ゾーンの WAF・キャッシュ・Mode B(サーバー発行 Cookie)が使えない構成)"),
  passwordLogin: z.boolean().describe("メール + パスワードのログインが開いているか(非常時だけ true。普段は Google ログインのみ)"),
  resultsStore: z.boolean().describe("結果を記録するための計測用データベースが導入されているか"),
  imageThumbnails: z.boolean().describe("画像の一覧に出す縮小版を作れるか(Cloudflare Images の binding があるとき true。無ければ一覧は元の画像を出す)"),
  writeFreeze: z
    .object({
      reason: z.string().nullable().describe("凍結の理由。null = 凍結の設定が読めない(凍結中として扱う)"),
      until: z.string().nullable().describe("再開の見込み(ISO 8601。表示だけで、過ぎても自動では外れない)"),
      since: z.number().nullable().describe("凍結を入れた時刻(epoch ミリ秒)"),
    })
    .nullable()
    .describe("書き込みの凍結(メンテナンス中)の状態。null = 凍結していない。凍結中はログイン以外の変更操作が 503 write_frozen になる"),
  apiVersion: z.number().describe("この control の API 契約の版(全応答のヘッダー x-wtt-api-version と同じ値)"),
  minClientVersion: z.number().describe("この control が受け付ける最低のクライアントの版。x-wtt-client-version で名乗った版がこれより古いと、変更操作が 426 client_too_old になる"),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** env だけで決まる部分。凍結は D1 を読むのでルートで足す(writeFreeze) */
export function capabilities(env: Env): Omit<Capabilities, "writeFreeze"> {
  return {
    productVersion: RELEASE_VERSION,
    apiVersion: API_CONTRACT_VERSION, minClientVersion: MIN_CLIENT_VERSION, // plan12 K6: 管理画面の版のバナーが読む
    imageUpload: imageStore(env) !== null, edgeOrigin: edgeOrigin(env), tagOrigin: tagOrigin(env), edgeOnWorkersDev: edgeOnWorkersDev(env), passwordLogin: passwordLoginOpen(env),
    resultsStore: resultsStore(env), imageThumbnails: env.IMAGES !== undefined,
  };
}
