/** spec §13.5: Experiment / Variant / Change / Goal / URL Pattern のスラッグ ID(作成後は変更不可) */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * JavaScript のオブジェクトが継承する名前(Object.prototype のプロパティ)。SLUG_RE を通るのは constructor だけ。
 * 設置タグ(runtime)は配る設定を素のオブジェクトとして ID で引くので、この名前の ID は継承したものと取り違える(B136)。
 * エクスペリエンス・パターン・目標の作成の入力で断る(既存の行には効かない)
 */
export const isReservedId = (id: string): boolean => Object.hasOwn(Object.prototype, id);
/** 利用者に見える文言。管理画面の lib/slug-id.ts と同じ文 */
export const reservedIdMessage = (id: string): string => `${id} は JavaScript で特別な意味を持つ名前なので ID に使えません`;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomSlug(len = 10): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}
export const newId = (prefix: string) => `${prefix}_${randomSlug()}`;

/** siteSalt(spec §4.3)など。base64url */
export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb) && a.length === b.length;
}
