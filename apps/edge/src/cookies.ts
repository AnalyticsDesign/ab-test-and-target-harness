import {
  chooseVisitorId,
  cookieValues,
  deriveExternalUuid,
  generateVisitorId,
  isCanonicalModeAId,
  markerCookieName,
  pickCookieDomain,
  type SiteSettings,
} from "@wtt/core";

const YEAR_SECONDS = 31536000; // spec §4.2
/** 1 応答で消す前の範囲の数の上限(B139 spec §11 の builder の選択。超えた分は until の新しい順に残す) */
const MAX_PREVIOUS_DOMAINS = 4;
/** 撤回で結果の記録を消す ID の数の上限(B139 Q31) */
const MAX_FORGET_IDS = 4;

/** Cookie の書き先。domain = null はホスト限定(Domain 属性なし) */
type CookieTarget = { domain: string | null; httpOnly: boolean };

const attrs = (o: CookieTarget, maxAge: number): string =>
  `Path=/;${o.domain !== null ? ` Domain=${o.domain};` : ""} Max-Age=${maxAge}; Secure;${o.httpOnly ? " HttpOnly;" : ""} SameSite=Lax`;

/** spec §4.2 / B139 §3.1: 訪問者の Cookie を書く。Domain は domain があるときだけ。HttpOnly は呼び出し側が決める */
export function setCookie(name: string, value: string, o: CookieTarget): string {
  return `${name}=${value}; ${attrs(o, YEAR_SECONDS)}`;
}

/** 発行時と同じ属性で削除する(spec §16)。削除の一致は name/domain/path で決まるが、契約どおり属性を揃える */
export function deleteCookie(name: string, o: CookieTarget): string {
  return `${name}=; ${attrs(o, 0)}`;
}

/** Cookie の Domain の判定に使うホスト名(小文字・末尾のドットなし。pickCookieDomain の約束) */
const normalizeHost = (host: string): string => host.toLowerCase().replace(/\.$/, "");

/** 印の Cookie の値。形の正しい最初の値(無ければ undefined) */
function markerValue(header: string, visitorCookieName: string): string | undefined {
  return cookieValues(header, markerCookieName(visitorCookieName)).find(isCanonicalModeAId);
}

/**
 * B139 §3.4 の値の選び方で、Cookie ヘッダーから訪問者 ID を選ぶ。印の規則(規則 2)は共有がオンで範囲があるときだけ。
 * fresh = 説明のつかない 2 種類以上(呼び出し側は新しい ID を発行するか、記録しない)
 */
export function chooseCookieVisitorId(cookieHeader: string | null, s: SiteSettings): { id: string | null; fresh: boolean } {
  const header = cookieHeader ?? "";
  return chooseVisitorId(
    cookieValues(header, s.visitorCookieName),
    markerValue(header, s.visitorCookieName),
    s.shareSubdomains && s.cookieDomains.length > 0,
  );
}

/** 撤回で結果の記録を消す ID: 届いた同じ名前の値のうち形の正しいものすべて(重複なし・最大 4。B139 Q31) */
export function canonicalCookieIds(cookieHeader: string | null, s: SiteSettings): string[] {
  return Array.from(new Set(cookieValues(cookieHeader ?? "", s.visitorCookieName).filter(isCanonicalModeAId))).slice(0, MAX_FORGET_IDS);
}

/** 保持期間の中で、host が属する前の範囲(until の新しい順に最大 4。exclude と同じ範囲は除く。B139 §3.6) */
function previousDomains(host: string, s: SiteSettings, nowSec: number, exclude: string | null): string[] {
  const live = s.previousCookieDomains
    .filter((p) => p.until > nowSec && p.domain !== exclude && pickCookieDomain(host, [p.domain]) !== null)
    .sort((a, b) => b.until - a.until)
    .map((p) => p.domain);
  return Array.from(new Set(live)).slice(0, MAX_PREVIOUS_DOMAINS);
}

/** 正本の Cookie の HttpOnly: ホスト限定のときだけ(Q20: 共有の Cookie は HttpOnly にしない) */
const canonicalTarget = (domain: string | null): CookieTarget => ({ domain, httpOnly: domain === null });
/** UUID Cookie・印の Cookie・旧名は HttpOnly なし */
const plainTarget = (domain: string | null): CookieTarget => ({ domain, httpOnly: false });

/**
 * 旧名(previousCookieNames)と旧名から作った印のうち、届いたものを domains のすべての側で消す(spec §5.4 migration・B139 §3.2)。
 * 旧名の発行時属性は不明。削除効力は name/domain/path で決まるため HttpOnly なしで送る
 */
function deleteRenamed(header: string, s: SiteSettings, domains: Array<string | null>): string[] {
  const current = new Set([s.visitorCookieName, markerCookieName(s.visitorCookieName)]);
  if (s.uuidCookieEnabled) current.add(s.uuidCookieName);
  const out: string[] = [];
  for (const prev of s.previousCookieNames) {
    for (const name of [prev.name, markerCookieName(prev.name)]) {
      if (current.has(name) || cookieValues(header, name).length === 0) continue;
      for (const d of domains) out.push(deleteCookie(name, plainTarget(d)));
    }
  }
  return out;
}

export type DliteIdentity = { visitorId: string; setCookies: string[] };

/**
 * spec §5.4 / §9.6 / B139 §3: 正本があれば再利用して Max-Age 再延長、無い・説明のつかない 2 種類以上(規則 3)なら新規発行(UUIDv7。決定 49)。
 * 発行先は共有がオンなら host が属する今の範囲(Domain 付き・HttpOnly なし)、オフか範囲が無ければホスト限定 + HttpOnly。
 * 同じ応答で、発行先以外の側(範囲付きで発行するときのホスト限定・保持期間の中の前の範囲)の正本・UUID・印と、届いた印を Max-Age=0 で消す。
 * ホスト限定の側は「共有を始めてから保持期間の間」に絞らず毎回消す(始めた時刻を持たないため。Set-Cookie が数行増えるだけ)。
 * UUID Cookie は出力専用 — システムはいかなる場合も読まず、常に正本から導出して上書きする(不一致は自動修復)。
 * 導出の salt は active config の siteSalt。config が無い(未 Publish)ときは UUID Cookie を出さない(決定 49 §7.2)。
 * 旧名 Cookie(previousCookieNames)と旧名から作った印は再利用せず、すべての側で Max-Age=0 で削除する(migration)。
 */
export async function resolveDliteIdentity(
  cookieHeader: string | null,
  s: SiteSettings,
  siteSalt: string | null,
  host: string,
  nowSec: number,
): Promise<DliteIdentity> {
  const header = cookieHeader ?? "";
  const h = normalizeHost(host);
  const chosen = chooseCookieVisitorId(header, s);
  const visitorId = chosen.fresh || chosen.id === null ? generateVisitorId() : chosen.id;
  const domain = s.shareSubdomains ? pickCookieDomain(h, s.cookieDomains) : null;
  const marker = markerCookieName(s.visitorCookieName);

  const setCookies = [setCookie(s.visitorCookieName, visitorId, canonicalTarget(domain))];
  if (s.uuidCookieEnabled && siteSalt !== null) setCookies.push(setCookie(s.uuidCookieName, await deriveExternalUuid(siteSalt, visitorId), plainTarget(domain)));
  // 印は edge が ID を発行し直したので要らない(B139 §3.2)。発行先の側は届いたときだけ消す
  if (cookieValues(header, marker).length > 0) setCookies.push(deleteCookie(marker, plainTarget(domain)));

  const others: Array<string | null> = [...(domain !== null ? [null] : []), ...previousDomains(h, s, nowSec, domain)];
  for (const d of others) {
    setCookies.push(deleteCookie(s.visitorCookieName, canonicalTarget(d)));
    if (s.uuidCookieEnabled) setCookies.push(deleteCookie(s.uuidCookieName, plainTarget(d)));
    setCookies.push(deleteCookie(marker, plainTarget(d)));
  }
  setCookies.push(...deleteRenamed(header, s, [domain, ...others]));
  return { visitorId, setCookies };
}

/**
 * spec §16 / B139 §3.5: revoke は正本・UUID Cookie(有効時)・印を、範囲付き(host が属する今の範囲)・ホスト限定・保持期間の中の前の範囲の
 * すべての側で削除し、旧名と旧名から作った印も掃除する。新規発行はしない。
 * 範囲付きの側は共有のオン・オフによらず消す(オフにした直後の写しも残さない)
 */
export function revokeCookies(cookieHeader: string | null, s: SiteSettings, host: string, nowSec: number): string[] {
  const header = cookieHeader ?? "";
  const h = normalizeHost(host);
  const scoped = pickCookieDomain(h, s.cookieDomains);
  const domains: Array<string | null> = [...(scoped !== null ? [scoped] : []), null, ...previousDomains(h, s, nowSec, scoped)];
  const marker = markerCookieName(s.visitorCookieName);
  const out: string[] = [];
  for (const d of domains) {
    out.push(deleteCookie(s.visitorCookieName, canonicalTarget(d)));
    if (s.uuidCookieEnabled) out.push(deleteCookie(s.uuidCookieName, plainTarget(d)));
    out.push(deleteCookie(marker, plainTarget(d)));
  }
  out.push(...deleteRenamed(header, s, domains));
  return out;
}
