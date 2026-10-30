// B139: 訪問者 ID の Cookie を複数ホストで共有するときの共通部品(zod-free。edge・control・runtime が使う。
// runtime の gzip に入るので短く保つ。Object.hasOwn は使わない)
import { isCanonicalModeAId } from "./id";

/** Cookie ヘッダーか document.cookie の文字列から、同じ名前の値を出てきた順にすべて返す(値はそのまま。"=" の無い組は飛ばす) */
export function cookieValues(header: string, name: string): string[] {
  const out: string[] = [];
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i >= 0 && pair.slice(0, i).trim() === name) out.push(pair.slice(i + 1).trim());
  }
  return out;
}

/**
 * 同じ名前の Cookie が複数あるとき(Domain 付きと host 限定の併存)の値の選び方(B139 §3.4)。
 * 正しい形の ID だけを種類で数える。1 種類 → その値。useMarker(共有が ON)で、ちょうど 2 種類のうち片方が marker と同じ → もう片方。
 * それ以外の 2 種類以上 → 呼び出し側が新しい ID を発行する(fresh)。0 種類 → 値なし
 */
export function chooseVisitorId(
  values: string[],
  marker: string | undefined,
  useMarker: boolean,
): { id: string | null; fresh: boolean } {
  const ids = Array.from(new Set(values.filter(isCanonicalModeAId)));
  if (ids.length === 1) return { id: ids[0]!, fresh: false };
  if (ids.length === 2 && useMarker && marker !== undefined && ids.includes(marker)) {
    return { id: ids[0] === marker ? ids[1]! : ids[0]!, fresh: false };
  }
  return { id: null, fresh: ids.length > 1 };
}

/** Cookie の Domain にする範囲を選ぶ(呼び出し側は、末尾のドットが無い小文字のホスト名を渡す)。ホスト名が範囲そのもの、またはそのサブドメインである最初の範囲。無ければ null(ホスト限定) */
export function pickCookieDomain(hostname: string, scopes: readonly string[]): string | null {
  return scopes.find((s) => hostname === s || hostname.endsWith("." + s)) ?? null;
}

/** ブラウザ(runtime)が ID を書いたことを示す印の Cookie 名 */
export const markerCookieName = (visitorCookieName: string): string => visitorCookieName + "_js";
