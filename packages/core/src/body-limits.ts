import { LIMITS } from "./schema";

/**
 * 要求の本文の上限(backlog B154)。control の入口・ルートの bodyLimit と、管理画面の BFF(Content-Length の無い本文)が使う。
 * 値の根拠は下の各定数のコメント。どれかを変えるときは control と admin の両方のテストを流す
 */

const MiB = 1024 * 1024;

/**
 * JSON の API の既定の上限。配る設定(compiled config)の上限 512KB の 2 倍。
 * 1 回の要求で送る定義(エクスペリエンス・オーディエンス・目標・サイトの設定)は、どれもサイト全体の配る設定より小さくないと公開できないので、
 * それを超える本文は保存しても公開できない。2 倍の余白は、非 ASCII の文字を `\uXXXX` で送る(Python の json.dumps の既定)と本文が最大 2 倍になるため
 */
export const JSON_BODY_MAX_BYTES = 2 * LIMITS.configMaxBytes;

/** 1 つのパターンの変更の件数の上限(保存時。control の変更の全置換 PUT が見る) */
export const MAX_CHANGES_PER_VARIANT = 100;

/**
 * 変更の全置換 PUT(`PUT /sites/:sid/experiments/:eid/variants/:vid/changes`)だけの上限(約 13.5MB)。
 * 保存できる最大の内容が、どの書き方で送っても 413 にならない値にする。1 件あたり:
 * - 値(payload)は UTF-8 で 64KB まで。非 ASCII を `\uXXXX` で送ると 3 バイトの文字が 6 バイトになるので 2 倍
 * - selector は 500 文字まで。全部を `\uXXXX` で送ると 1 文字 6 バイト
 * - id・type・キーの名前などの余白 1KB
 * 公開できるのは配る設定の 512KB までだが、保存はこれまでどおり受ける
 */
export const CHANGES_PUT_BODY_MAX_BYTES = MAX_CHANGES_PER_VARIANT * (2 * LIMITS.changeValueMaxBytes + 6 * LIMITS.selectorMax + 1024);

/** 画像のアップロードの上限の既定(MB。control の env `AB_ASSET_MAX_MB` が無い・読めないとき) */
export const DEFAULT_ASSET_MAX_MB = 5;

/** multipart の区切り・ヘッダー・`experimentId` の欄のための余白(画像 1 枚の上限に足す) */
export const MULTIPART_OVERHEAD_BYTES = 1 * MiB;

/** `AB_ASSET_MAX_MB` の文字列 → MB。正の有限の数でなければ既定 */
export function assetMaxMb(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ASSET_MAX_MB;
}

/** 画像のアップロードの要求の本文の上限(画像 1 枚の上限 + multipart の余白) */
export function assetUploadBodyMaxBytes(maxMb: number): number {
  return Math.ceil(maxMb * MiB) + MULTIPART_OVERHEAD_BYTES;
}
