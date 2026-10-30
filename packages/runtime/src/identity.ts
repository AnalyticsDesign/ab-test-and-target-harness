import {
  cookieValues,
  deriveExternalUuid,
  generateVisitorId,
  hashByoidValue,
  isCanonicalModeAId,
  markerCookieName,
  pickCookieDomain,
  visitorIdIssuedAt,
} from "@wtt/core";
import type { RuntimeSettings } from "@wtt/core";

const YEAR_SECONDS = 31536000; // spec §4.1

/** firstVisitAt = 初回の訪問時刻(正本 / 参考用の匿名 Cookie の発行時刻。v4 は null。D-lite は undefined = edge が Cookie から読む) */
export type IdentityResult = { visitorId: string | null; usedByoid: boolean; firstVisitAt?: number | null };

/**
 * 同じ名前の Cookie の、形の正しい値(重複なし)。B139 §3.4 の値の選び方(edge の規則 1・3 = core の chooseVisitorId(値, undefined, false) と同じ。
 * runtime は印の規則 2 を使わないので、サイズのため 1 種類かどうかだけを見る)と、撤回の forget の宛先(Q31)に使う
 */
export const canonicalValues = (doc: { cookie: string }, name: string): string[] => Array.from(new Set(cookieValues(doc.cookie, name).filter(isCanonicalModeAId)));

/** 同じ名前の最初の値(より specific なパスが先に並ぶ) */
export const readCookie = (doc: { cookie: string }, name: string): string | undefined => cookieValues(doc.cookie, name)[0];

/**
 * spec §4.1 / §5.4 / B139 §3.1: Path / Max-Age / Secure / SameSite は正本・UUID・印とも同一。Domain は範囲付きのときだけ
 * (domain = null はホスト限定)。HttpOnly は JS からは付けられない。maxAge = 0 は削除(発行時と同じ属性。§16)
 */
function setCookie(doc: { cookie: string }, name: string, value: string, domain: string | null, maxAge = YEAR_SECONDS): void {
  doc.cookie = `${name}=${value}; Path=/;${domain ? ` Domain=${domain};` : ""} Max-Age=${maxAge}; Secure; SameSite=Lax`;
}

/**
 * B139 §3.4 / §3.5 / §3.6: 後始末。target = 今の発行先(範囲付きの範囲、null はホスト限定)。
 * 正本・UUID(有効時)・印を、発行先以外の側(範囲付きのときのホスト限定・保持期間の中で hostname が属する前の範囲。until の新しい順に最大 4)
 * で消す。all(撤回)なら発行先の側も消す。旧名と旧名から作った印は、届いたものをすべての側で消す(値は読まない。migration)。
 * edge(apps/edge/src/cookies.ts)と同じ規則
 */
function sweep(s: RuntimeSettings, doc: { cookie: string }, hostname: string, target: string | null, all?: boolean): void {
  const now = Date.now() / 1000;
  const prev = (s.previousCookieDomains ?? [])
    .filter((p) => p.until > now && p.domain !== target && pickCookieDomain(hostname, [p.domain]))
    .sort((a, b) => b.until - a.until)
    .map((p) => p.domain)
    .slice(0, 4); // 範囲は control が重複なしで持つ
  const others = [...(target !== null ? [null] : []), ...prev];
  const own = [s.visitorCookieName, markerCookieName(s.visitorCookieName)];
  if (s.uuidCookieEnabled) own.push(s.uuidCookieName);
  const sides = [target, ...others];
  for (const d of all ? sides : others) for (const n of own) setCookie(doc, n, "", d, 0);
  for (const p of s.previousCookieNames) {
    for (const n of [p, markerCookieName(p)]) if (!own.includes(n) && readCookie(doc, n) !== undefined) for (const d of sides) setCookie(doc, n, "", d, 0);
  }
}

/**
 * spec §4.1 / §4.3 / §5.4 / §9.6 / 決定 49 §7 / B139 §3: 起動時の Identity 確立。Mode A と、Mode B の Cloudflare 外のドメイン(onEdgePath が偽)で使う。
 * Cloudflare 経由のドメインの D-lite は edge 所有 — runtime.ts がここを呼ばない(document.cookie を一切読み書きしない)
 * - 値の選び方は edge の規則 1・3(1 種類ならそれ、説明のつかない 2 種類以上は新しい ID)。印の規則 2 は edge だけ
 * - 発行先は hostname(location.hostname。ポートなし)が属する共有の範囲。共有がオフ(cookieDomains が空)・どれにも入らなければホスト限定
 * - 書く前に sweep で、ホスト限定の側・前の範囲・旧名(と旧名から作った印)を消す。後始末と発行は一組(消すだけの分岐は無い)
 * - 印の規則(B139 §3.2)は Mode B の Cloudflare 外のドメインで共有がオンのときだけ: ID が無ければ ID と印を書く /
 *   印の値が ID と同じなら両方を書き直す / それ以外(サーバーが書いた ID)は何も書かない(UUID Cookie も)
 * - 正本 Cookie(Mode A の ID)は Mode A・Mode C とも常に維持し、毎ページビューで再設定(Max-Age 延長)。
 *   Mode C ではこれを**参考用**に持ち、発行時刻を初回の訪問に使う(識別には使わず、decision の body にも含めない。決定 49 §7.4)
 * - Mode C の ID は SHA-256(siteSalt + 値)。取得・ハッシュできなければ Mode A の匿名 ID にフォールバック
 * - UUID Cookie は出力専用: いかなる場合も読まず、常に ID から導出して正本と同じ Domain に上書き(自動修復)。SHA-256 が使えなければ書かない
 * - `isCurrent`: この確立の世代がまだ有効か。await(BYOID のハッシュ・`deriveExternalUuid`)の後、Cookie を書く前に毎回確かめ、
 *   false なら Cookie を書かずに戻る(撤回で消した Cookie を作り直さない・新しい世代の Cookie を古い世代が上書きしない)
 */
export async function establishIdentity(
  settings: RuntimeSettings,
  siteSalt: string,
  doc: { cookie: string },
  isCurrent: () => boolean = () => true,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
  hostname = "",
): Promise<IdentityResult> {
  const name = settings.visitorCookieName;
  const marker = markerCookieName(name);
  const scopes = settings.cookieDomains ?? [];
  const domain = pickCookieDomain(hostname, scopes);
  const ids = canonicalValues(doc, name);
  const found = ids.length === 1 ? ids[0]! : null; // 0 種類 = 無い、2 種類以上 = 新しい ID(規則 3)
  const anonymous = found ?? generateVisitorId();
  const useMarker = settings.mode === "B" && scopes.length > 0;
  const write = !useMarker || found === null || cookieValues(doc.cookie, marker).includes(found);
  if (write) {
    sweep(settings, doc, hostname, domain);
    setCookie(doc, name, anonymous, domain);
    if (useMarker) setCookie(doc, marker, anonymous, domain);
  }
  let visitorId = anonymous;
  let usedByoid = false;
  if (settings.idSource.startsWith("cookie:")) {
    const raw = readCookie(doc, settings.idSource.slice("cookie:".length));
    if (raw !== undefined && raw !== "" && subtle) {
      try {
        visitorId = await hashByoidValue(siteSalt, raw, subtle);
        usedByoid = true;
      } catch (e) {
        // 非セキュアコンテキストや subtle 障害でも起動を止めない。§4.3 のフォールバックを
        // 「値が取得できない」だけでなく「BYOID を確立できない」全体へ広げる(r1 CL-High-1)
        console.debug("wtt: byoid", e);
      }
    }
  }
  const result: IdentityResult = { visitorId, usedByoid, firstVisitAt: visitorIdIssuedAt(anonymous) };
  if (!isCurrent()) return result; // BYOID のハッシュを待つ間に撤回・再許可された(Cookie を書かない)
  if (write && settings.uuidCookieEnabled && subtle) {
    try {
      const uuid = await deriveExternalUuid(siteSalt, visitorId, subtle);
      if (!isCurrent()) return result; // 導出を待つ間に撤回・再許可された(Cookie を書かない)
      setCookie(doc, settings.uuidCookieName, uuid, domain);
    } catch {
      // SHA-256 が使えない(決定 49 §7.2: 書かない)
    }
  }
  return result;
}

/**
 * spec §16 / B139 §3.5: revoke(denied への遷移)— 正本(Mode C では参考用の匿名 Cookie)・UUID Cookie(有効時)・印を、範囲付き(hostname が属する今の範囲)・
 * ホスト限定・保持期間の中の前の範囲のすべての側で削除し、旧名と旧名から作った印も消す。Cloudflare 経由のドメインの D-lite は consent body を edge へ送る(runtime.ts)
 */
export function revokeIdentity(settings: RuntimeSettings, doc: { cookie: string }, hostname = ""): void {
  sweep(settings, doc, hostname, pickCookieDomain(hostname, settings.cookieDomains ?? []), true);
}
