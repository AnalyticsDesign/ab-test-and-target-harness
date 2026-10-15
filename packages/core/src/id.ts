/** 文字種と長さのみの緩い形式(22 or 43 文字)。API の受理判定には使わない — isAcceptableVisitorId(§9.5)を使うこと */
export const VISITOR_ID_RE = /^(?:[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(acc >> bits) & 63];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (6 - bits)) & 63];
  return out;
}

/**
 * 決定 49(設計書 §7.1): 正本は UUIDv7 互換(RFC 9562)。先頭 48 bit = 発行時刻の Unix ミリ秒(big-endian)、version = 7、
 * variant = RFC 4122、残り 74 bit が乱数。表記は今までどおり 22 文字の base64url
 */
export function generateVisitorId(
  random: (buf: Uint8Array) => void = (b) => crypto.getRandomValues(b as Uint8Array<ArrayBuffer>),
  now: number = Date.now(),
): string {
  const buf = new Uint8Array(16);
  random(buf);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    buf[i] = t % 256;
    t = Math.floor(t / 256);
  }
  buf[6] = (buf[6]! & 0x0f) | 0x70;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  return toBase64Url(buf); // 16 bytes -> 22 chars
}

/** 文字種と長さのみの緩い形式(22 or 43 文字)。API の受理判定には使わない — isAcceptableVisitorId(§9.5)を使うこと */
export function isValidVisitorId(id: string): boolean {
  return VISITOR_ID_RE.test(id);
}

const MODE_A_RE = /^[A-Za-z0-9_-]{22}$/;
const UUID_V4_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fromBase64Url(s: string): Uint8Array | null {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out.length === 16 ? new Uint8Array(out) : null;
}

/**
 * spec §5.4 / §9.5: Mode A の受理集合。canonical(再エンコード一致)+ version / variant ビットを検証する。
 * 決定 49: v4(v1.0 より前に発行した ID)と v7(v1.0 から発行する ID)の両方を受ける
 */
export function isCanonicalModeAId(id: string): boolean {
  if (!MODE_A_RE.test(id)) return false;
  const bytes = fromBase64Url(id);
  if (!bytes) return false;
  if (toBase64Url(bytes) !== id) return false; // 末尾 4 bit の padding が 0 でない表現を拒否(単射性)
  const version = bytes[6]! & 0xf0;
  return (version === 0x40 || version === 0x70) && (bytes[8]! & 0xc0) === 0x80;
}

/**
 * 決定 49(設計書 §7.3): 正本の ID の発行時刻(epoch ミリ秒)= 初回の訪問。v7 の先頭 48 bit。
 * v4(v1.0 より前に発行)や Mode A の ID でないものは null(発行時刻が不明)
 */
export function visitorIdIssuedAt(id: string): number | null {
  if (!isCanonicalModeAId(id)) return null;
  const b = fromBase64Url(id)!;
  if ((b[6]! & 0xf0) !== 0x70) return null;
  let t = 0;
  for (let i = 0; i < 6; i++) t = t * 256 + b[i]!;
  return t;
}

/** spec §9.5: Mode C(SHA-256 base64url)は文字種と長さのみで判定する */
export const MODE_C_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** spec §9.5: API が受理する visitorId の全集合(edge の 400 判定に使う) */
export function isAcceptableVisitorId(id: string): boolean {
  return isCanonicalModeAId(id) || MODE_C_ID_RE.test(id);
}

/** 16 バイトを UUID の文字列(小文字の 8-4-4-4-12)にする */
function toUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** spec §9.5: Mode A ID(22 文字)と UUID 文字列は同じ 128 ビットの別表記(正本の表記変換)。strict validator(§5.4)を通らない ID と Mode C(43 文字)は null。外部連携用 UUID Cookie には使わない(deriveExternalUuid) */
export function visitorIdToUuid(id: string): string | null {
  if (!isCanonicalModeAId(id)) return null;
  return toUuid(fromBase64Url(id)!);
}

/** 復元方向は厳格に UUIDv4 / v7 のみ受理(fail-closed)。出力は canonical な 22 文字。 */
export function uuidToVisitorId(uuid: string): string | null {
  const lower = uuid.toLowerCase();
  if (!UUID_V4_V7_RE.test(lower)) return null;
  const hex = lower.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return toBase64Url(bytes);
}

/**
 * spec §4.3: Mode C(BYOID)は runtime 内で SHA-256(site_salt + value) にハッシュ化してから送る。出力は base64url 43 文字(§9.5)。
 * 既定値は `globalThis.crypto` ではなく素の `crypto` を見る: control の tsconfig は DOM lib を外していて
 * (@cloudflare/workers-types の `declare const crypto` だけが効く)、`typeof globalThis` に crypto が乗らないため
 */
export async function hashByoidValue(siteSalt: string, value: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(siteSalt + value)));
  return toBase64Url(digest); // 32 bytes -> 43 文字
}

/**
 * 決定 49(設計書 §7.2): 外部連携用 UUID Cookie(`_ab_uuid`)の値 = 正本から導出した UUIDv4。
 * SHA-256("ab-uuid/v1" + siteSalt + 正本の ID) の先頭 16 バイトに v4 の version / variant ビットを立てる。
 * 決定的(同じ訪問者には同じ値。自動修復に乗る)・一方向(正本へ戻せない)・発行時刻を含まない。BYOID(43 文字)の ID からも導出できる。
 * 接頭辞の版(v1)を上げると、内部の ID と割当を変えずに外部の ID だけを作り直せる
 */
export async function deriveExternalUuid(siteSalt: string, visitorId: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const d = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`ab-uuid/v1${siteSalt}${visitorId}`)));
  d[6] = (d[6]! & 0x0f) | 0x40;
  d[8] = (d[8]! & 0x3f) | 0x80;
  return toUuid(d);
}
