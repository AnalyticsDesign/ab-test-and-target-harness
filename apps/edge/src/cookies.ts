import { deriveExternalUuid, generateVisitorId, isCanonicalModeAId, type SiteSettings } from "@wtt/core";

const YEAR_SECONDS = 31536000; // spec §4.2

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i);
    if (out[name] === undefined) out[name] = part.slice(i + 1); // RFC 6265: より specific なパスの Cookie が先に並ぶため最初の値を採用
  }
  return out;
}

/** spec §4.2 / §9.6: 正本 Cookie は HttpOnly・edge 所有 */
export function canonicalSetCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

/** spec §5.4: UUID Cookie は正本と同属性で HttpOnly なし(JS 可読が目的) */
export function uuidSetCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; Secure; SameSite=Lax`;
}

/** 発行時と同じ属性で削除する(spec §16)。削除の一致は name/path で決まるが、契約どおり属性を揃える */
export function deleteCookie(name: string, httpOnly: boolean): string {
  return `${name}=; Path=/; Max-Age=0; Secure;${httpOnly ? " HttpOnly;" : ""} SameSite=Lax`;
}

export type DliteIdentity = { visitorId: string; setCookies: string[] };

/**
 * spec §5.4 / §9.6: 正本があれば必ず再利用して Max-Age 再延長、strict 検証を通らない・無い場合は新規発行(UUIDv7。決定 49)。
 * UUID Cookie は出力専用 — システムはいかなる場合も読まず、常に正本から導出して上書きする(不一致は自動修復)。
 * 導出の salt は active config の siteSalt。config が無い(未 Publish)ときは UUID Cookie を出さない(決定 49 §7.2)。
 * 旧名 Cookie(previousCookieNames)は再利用せず Max-Age=0 で削除する(migration)。
 */
export async function resolveDliteIdentity(cookieHeader: string | null, s: SiteSettings, siteSalt: string | null): Promise<DliteIdentity> {
  const cookies = parseCookies(cookieHeader);
  const existing = cookies[s.visitorCookieName];
  const visitorId = existing !== undefined && isCanonicalModeAId(existing) ? existing : generateVisitorId();
  const setCookies = [canonicalSetCookie(s.visitorCookieName, visitorId)];
  if (s.uuidCookieEnabled && siteSalt !== null) setCookies.push(uuidSetCookie(s.uuidCookieName, await deriveExternalUuid(siteSalt, visitorId)));
  for (const prev of s.previousCookieNames) {
    if (prev.name === s.visitorCookieName) continue;
    if (s.uuidCookieEnabled && prev.name === s.uuidCookieName) continue;
    // 旧名の発行時属性は不明。削除効力は name/path で決まるため HttpOnly なしで送る
    if (cookies[prev.name] !== undefined) setCookies.push(deleteCookie(prev.name, false));
  }
  return { visitorId, setCookies };
}

/** spec §16: revoke は設定された正本 + UUID Cookie(有効時)を削除し、旧名も掃除する。新規発行はしない */
export function revokeCookies(cookieHeader: string | null, s: SiteSettings): string[] {
  const cookies = parseCookies(cookieHeader);
  const out = [deleteCookie(s.visitorCookieName, true)];
  if (s.uuidCookieEnabled) out.push(deleteCookie(s.uuidCookieName, false));
  for (const prev of s.previousCookieNames) {
    if (prev.name === s.visitorCookieName) continue;
    if (s.uuidCookieEnabled && prev.name === s.uuidCookieName) continue;
    // 旧名の発行時属性は不明。削除効力は name/path で決まるため HttpOnly なしで送る
    if (cookies[prev.name] !== undefined) out.push(deleteCookie(prev.name, false));
  }
  return out;
}
