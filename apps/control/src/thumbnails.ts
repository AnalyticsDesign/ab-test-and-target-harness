import { assetThumbPath } from "@wtt/core";
import { imageStore } from "./capabilities";
import type { Env } from "./env";
import { NOT_FROZEN_SQL } from "./write-freeze";

/**
 * B68(spec §5): 管理画面の一覧に出す縮小版(幅 320px の WebP)。Cloudflare Images の binding(`IMAGES`)の有無がスイッチで、
 * R2 が無ければ作らない。作るのはアップロードの直後(`waitUntil`)と Cron `asset-housekeeping` の縮小版の段の 2 か所
 */

/** 縮小版の幅(px)。これより小さい画像は拡大しない(fit: scale-down) */
export const THUMB_WIDTH = 320;
/** 1 枚の試みの回数の上限。これだけ失敗したら `failed`(画面は元の画像を出し、Cron は二度と拾わない) */
export const THUMB_ATTEMPTS_MAX = 3;
/** Images の枠切れ(その月の無料の変換を使い切った)のエラーコード */
export const IMAGES_QUOTA_ERROR = 9422;

/** 縮小版の R2 のキー。元の画像のキーの形(新しい images/・前の experiments/<eid>/)によらず同じ(spec §3.2) */
export const thumbKey = (siteId: string, assetId: string): string => `sites/${siteId}/${assetThumbPath(assetId)}`;

/**
 * ready = 作って行に書いた(または、別の経路がすでに作っていた)/ retry = 失敗(呼び出し側が thumb_attempts + 1)/
 * quota = 枠切れ(回数を増やさない)/ gone = 行が消えていた(置いた縮小版は消した)/
 * frozen = 書き込みの凍結に当たって行に書けなかった(回数を増やさない。行は pending のまま、置いた縮小版は残す)
 */
export type ThumbResult = "ready" | "retry" | "quota" | "gone" | "frozen";

const isQuotaError = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === IMAGES_QUOTA_ERROR;

/**
 * バイト列を 1 chunk だけ流すストリーム。chunk は元のバイト列を共有する(コピーしない)。読み手(binding)が buffer を
 * 切り離す・書き換えることに備え、2 本を作るときは呼び出し側が別の buffer を渡す(`makeThumbnail`)
 */
export function oneChunkStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
}

/**
 * 1 枚の縮小版を作り、R2 に置き、行に書く(spec §5.1)。投げない(失敗は戻り値で返す)。
 * - 本文は 2 回読む(`info()` と変換)。元のバイト列とそのコピーから 1 chunk のストリームを 1 本ずつ作って渡す(`oneChunkStream`)。
 *   `new Blob([bytes]).stream()` だと 4KB の chunk(5MB で約 1,200 個)になり、Images の binding の層が chunk ごとに JS で読み直して
 *   詰め直すため、その分の CPU が画像の大きさに比例して増える(手元で縮小版 1 枚の Worker の CPU が約 1/3 になった)。
 *   ストリームで渡されたら先に 1 回だけ読む(5MB まで)
 * - 書き込みは spec の UPDATE と行の読み(有無と状態)を 1 つの batch(D1 の往復 1)。UPDATE には凍結の条件を入れる
 *   (入口・Cron の最初の確かめの後に凍結が入っても、この書き込みが止まる)。0 行のときは読みで 3 つに分かれる:
 *   - 行が無い → 置いた縮小版を消して `gone`
 *   - 行があって `ready` → 別の経路(アップロードの直後と Cron が重なった)が先に書いた。縮小版のキーは同じなので消さずに `ready`
 *   - 行があって `ready` でない → 凍結で止まった。縮小版は消さない(行は pending のままで、次の回に同じキーへ置き直される)。
 *     戻り値は `frozen`: `retry` にすると呼び出し側が回数を増やし、凍結が長引くと 3 回で `failed`(二度と拾わない)に進んでしまうため、
 *     回数を増やさない別の値にした。Cron はこれを受けたらその回を止める(残りの行も同じ凍結に当たり、変換の課金だけが嵩むため)
 */
export async function makeThumbnail(env: Env, asset: { id: string; site_id: string }, body: ArrayBuffer | ReadableStream, now = Date.now()): Promise<ThumbResult> {
  const store = imageStore(env);
  if (!store || !env.IMAGES) return "retry";
  const key = thumbKey(asset.site_id, asset.id);
  let width: number | null = null;
  let height: number | null = null;
  try {
    const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    // 変換に渡す 2 本目は、info に渡す前にコピーしておく(5MB を 1 つ余分に持つ)。info と同じ buffer を共有すると、binding が
    // chunk の buffer を切り離す・書き換える作りに変わったとき、2 本目が空や壊れた中身になるため(今の workerd は切り離さない)
    const copy = bytes.slice(0);
    const info = await env.IMAGES.info(oneChunkStream(bytes));
    if ("width" in info) {
      width = info.width;
      height = info.height;
    }
    const out = await env.IMAGES.input(oneChunkStream(copy))
      .transform({ width: THUMB_WIDTH, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80, anim: false });
    // R2 の put は長さの分からないストリームを受けないので、縮小版(数十 KB)はバイト列にしてから置く
    const webp = await new Response(out.image()).arrayBuffer();
    await store.bucket.put(key, webp, { httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" } });
  } catch (e) {
    if (isQuotaError(e)) return "quota";
    console.error(`thumbnail: asset ${asset.id} failed`, e);
    return "retry";
  }
  try {
    const [written, present] = await env.DB.batch([
      env.DB.prepare(`UPDATE assets SET thumb_key = ?1, thumb_state = 'ready', width = ?2, height = ?3, updated_at = ?4 WHERE id = ?5 AND thumb_state <> 'ready' AND ${NOT_FROZEN_SQL}`).bind(key, width, height, now, asset.id),
      env.DB.prepare(`SELECT thumb_state FROM assets WHERE id = ?1`).bind(asset.id),
    ]);
    if ((written?.meta.changes ?? 0) > 0) return "ready";
    const current = present?.results?.[0] as { thumb_state?: string } | undefined;
    if (current) return current.thumb_state === "ready" ? "ready" : "frozen";
    await store.bucket.delete(key).catch((e: unknown) => console.error(`thumbnail: removing the orphan of ${asset.id} failed`, e));
    return "gone";
  } catch (e) {
    console.error(`thumbnail: recording asset ${asset.id} failed`, e);
    return "retry";
  }
}

/**
 * 失敗の回数を 1 つ増やす 1 文(`retry` のとき)。上限に届いたら `failed`。作り待ち(`pending`)の行だけ。
 * 凍結中は書かない(Cron とアップロードの直後のどちらからも呼ぶ。0 行でも呼び出し側は何もしない)。
 * 縮小版を行に書く文(`makeThumbnail`)も同じく凍結の条件を持つので、アップロードの直後の経路の書き込みはすべて凍結の中に収まる
 */
export function thumbAttemptStatement(env: Env, assetId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE assets SET thumb_attempts = thumb_attempts + 1,
       thumb_state = CASE WHEN thumb_attempts + 1 >= ?3 THEN 'failed' ELSE thumb_state END, updated_at = ?2
     WHERE id = ?1 AND thumb_state = 'pending' AND ${NOT_FROZEN_SQL}`,
  ).bind(assetId, now, THUMB_ATTEMPTS_MAX);
}

/**
 * アップロードの直後に 1 回だけ作る(spec §5.2。`waitUntil` の中)。元の画像はメモリにあるので R2 から読み直さない。
 * 失敗(Images のエラー・枠切れ・時間切れ)は thumb_attempts + 1 だけ書き、pending のまま残す(Cron が拾う)
 */
export async function thumbnailAfterUpload(env: Env, asset: { id: string; site_id: string }, bytes: ArrayBuffer): Promise<void> {
  const r = await makeThumbnail(env, asset, bytes);
  if (r !== "retry" && r !== "quota") return; // ready / gone / frozen は何も書かない(frozen は行が pending のまま残り、Cron が拾う)
  try {
    await thumbAttemptStatement(env, asset.id, Date.now()).run();
  } catch (e) {
    console.error(`thumbnail: counting the attempt of ${asset.id} failed`, e);
  }
}

/** 枠切れの印(instance_settings のキー)。値は `{ "until": <epoch ミリ秒> }` = その月の末(UTC。翌月の 1 日 0 時)まで縮小版を作らない */
export const IMAGES_QUOTA_KEY = "imageThumbnailsPausedUntil";

/** その月の末(UTC)= 翌月の 1 日 0 時(epoch ミリ秒) */
export function endOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** 印の値を読む(読めない値は印が無いのと同じ = 作る側に倒す。作っても枠切れならまた印が付くだけ) */
export function parseQuotaUntil(value: unknown): number | null {
  if (typeof value !== "string") return null;
  try {
    const v = JSON.parse(value) as { until?: unknown };
    return typeof v?.until === "number" && Number.isFinite(v.until) ? v.until : null;
  } catch {
    return null;
  }
}

/** 印を読む 1 文(instance-settings.ts と同じ、キーごとの 1 行・値は JSON の形) */
export function quotaMarkReadStatement(env: Env): D1PreparedStatement {
  return env.DB.prepare(`SELECT value FROM instance_settings WHERE key = ?1`).bind(IMAGES_QUOTA_KEY);
}

/** 印を置く 1 文(凍結中は書かない。Cron の書き込み) */
export function quotaMarkWriteStatement(env: Env, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO instance_settings (key, value, updated_at, updated_by) SELECT ?1, ?2, ?3, NULL WHERE ${NOT_FROZEN_SQL}
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(IMAGES_QUOTA_KEY, JSON.stringify({ until: endOfUtcMonth(now) }), now);
}
