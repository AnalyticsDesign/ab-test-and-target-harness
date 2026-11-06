/**
 * 画像のライブラリの一覧(`GET /sites/:sid/assets`)の各件の URL の組み立て(B68)。
 * 一覧の応答は、各件に URL を繰り返さず、上の段の `urlPrefix`(`<公開ベース>/sites/<siteId>/`)と各件の `path` で URL を表す
 * (1,000 枚のときの応答の大きさを抑えるため)。control(一覧を組み立てる側)と管理画面(URL に戻す側)が同じ関数を使い、
 * 戻した URL が IMAGE の `src` に書く値(D1 の `public_url`)と一字一句同じになるようにする。runtime には入らない。
 *
 * - `publicUrl` = `urlPrefix + path`。公開ベースを後から変えた導入では、前に上げた画像の `public_url` が今の `urlPrefix` で始まらないので、
 *   その件だけ `path` の代わりに `publicUrl` をそのまま載せる
 * - 縮小版の URL = `urlPrefix + "thumbs/<id>.webp"`(`thumbnail` が `ready` のときだけ)。それと違う値になる件だけ `thumbnailUrl` を載せる
 */

/** 一覧の件のうち、URL に戻すのに使う項目 */
export type AssetUrlFields = { id: string; thumbnail: string; path?: string; publicUrl?: string; thumbnailUrl?: string | null };

/** 一覧の上の段の `urlPrefix`。`<公開ベース>/sites/<siteId>/`(末尾の `/` を含む) */
export function assetUrlPrefix(publicBase: string, siteId: string): string {
  return `${publicBase}/sites/${siteId}/`;
}

/** 縮小版の `urlPrefix` からの相対の位置(control の縮小版のキー `sites/<sid>/thumbs/<id>.webp` と同じ形) */
export function assetThumbPath(assetId: string): string {
  return `thumbs/${assetId}.webp`;
}

/** 一覧の 1 件 → 公開 URL と縮小版の URL(縮小版がまだ無ければ null) */
export function assetItemUrls(urlPrefix: string, item: AssetUrlFields): { publicUrl: string; thumbnailUrl: string | null } {
  const publicUrl = item.publicUrl ?? urlPrefix + (item.path ?? "");
  const thumbnailUrl = item.thumbnailUrl !== undefined ? item.thumbnailUrl : item.thumbnail === "ready" ? urlPrefix + assetThumbPath(item.id) : null;
  return { publicUrl, thumbnailUrl };
}

/**
 * 1 件の URL(公開 URL と縮小版の URL)→ 一覧に載せる URL の項目。`assetItemUrls` で戻すと元の 2 つと同じになる最小の形を返す
 * (ふつうは `path` だけ。公開ベースを変えた前の画像は `publicUrl`。縮小版の URL が決まった形でないときだけ `thumbnailUrl`)
 */
export function compactAssetUrls(
  urlPrefix: string,
  item: { id: string; thumbnail: string; publicUrl: string; thumbnailUrl: string | null },
): { path?: string; publicUrl?: string; thumbnailUrl?: string | null } {
  const out: { path?: string; publicUrl?: string; thumbnailUrl?: string | null } = {};
  if (item.publicUrl.startsWith(urlPrefix) && item.publicUrl.length > urlPrefix.length) out.path = item.publicUrl.slice(urlPrefix.length);
  else out.publicUrl = item.publicUrl;
  if (assetItemUrls(urlPrefix, { id: item.id, thumbnail: item.thumbnail }).thumbnailUrl !== item.thumbnailUrl) out.thumbnailUrl = item.thumbnailUrl;
  return out;
}
