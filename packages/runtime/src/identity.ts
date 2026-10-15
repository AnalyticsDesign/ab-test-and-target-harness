import { deriveExternalUuid, generateVisitorId, hashByoidValue, isCanonicalModeAId, visitorIdIssuedAt } from "@wtt/core";
import type { RuntimeSettings } from "@wtt/core";

const YEAR_SECONDS = 31536000; // spec §4.1

/** firstVisitAt = 初回の訪問時刻(正本 / 参考用の匿名 Cookie の発行時刻。v4 は null。D-lite は undefined = edge が Cookie から読む) */
export type IdentityResult = { visitorId: string | null; usedByoid: boolean; firstVisitAt?: number | null };

export function readCookie(doc: { cookie: string }, name: string): string | undefined {
  for (const part of doc.cookie.split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i) === name) return part.slice(i + 1); // 最初の値(より specific なパスが先に並ぶ)
  }
  return undefined;
}

function writeCookie(doc: { cookie: string }, name: string, value: string): void {
  // spec §4.1 / §5.4: Path / Max-Age / Secure / SameSite は正本・UUID とも同一。HttpOnly は JS からは付けられない
  doc.cookie = `${name}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; Secure; SameSite=Lax`;
}

function deleteCookie(doc: { cookie: string }, name: string): void {
  doc.cookie = `${name}=; Path=/; Max-Age=0; Secure; SameSite=Lax`; // 発行時と同じ Path / 属性で削除(§16)
}

/**
 * spec §4.1 / §4.3 / §5.4 / §9.6 / 決定 49 §7: 起動時の Identity 確立。
 * - D-lite(mode B)は edge 所有 — runtime は document.cookie を一切読み書きしない
 * - 旧名 Cookie(previousCookieNames)は値を読まず削除のみ(migration)
 * - 正本 Cookie(Mode A の ID)は Mode A・Mode C とも常に維持する。既存 Cookie が strict 検証を通れば必ず再利用し、毎ページビューで再設定(Max-Age 延長)。
 *   Mode C ではこれを**参考用**に持ち、発行時刻を初回の訪問に使う(識別には使わず、decision の body にも含めない。決定 49 §7.4)
 * - Mode C の ID は SHA-256(siteSalt + 値)。取得・ハッシュできなければ Mode A の匿名 ID にフォールバック
 * - UUID Cookie は出力専用: いかなる場合も読まず、常に ID から導出して上書き(自動修復)。SHA-256 が使えなければ書かない
 * - `isCurrent`: この確立の世代がまだ有効か。await(BYOID のハッシュ・`deriveExternalUuid`)の後、Cookie を書く前に毎回確かめ、
 *   false なら Cookie を書かずに戻る(撤回で消した Cookie を作り直さない・新しい世代の Cookie を古い世代が上書きしない)
 */
export async function establishIdentity(
  settings: RuntimeSettings,
  siteSalt: string,
  doc: { cookie: string },
  isCurrent: () => boolean = () => true,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<IdentityResult> {
  if (settings.mode === "B") return { visitorId: null, usedByoid: false };
  for (const prev of settings.previousCookieNames) {
    if (prev === settings.visitorCookieName) continue;
    if (settings.uuidCookieEnabled && prev === settings.uuidCookieName) continue;
    if (readCookie(doc, prev) !== undefined) deleteCookie(doc, prev);
  }
  const existing = readCookie(doc, settings.visitorCookieName);
  const anonymous = existing !== undefined && isCanonicalModeAId(existing) ? existing : generateVisitorId();
  writeCookie(doc, settings.visitorCookieName, anonymous);
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
        console.debug("wtt: byoid hash failed, falling back to anonymous id", e);
      }
    }
  }
  const result: IdentityResult = { visitorId, usedByoid, firstVisitAt: visitorIdIssuedAt(anonymous) };
  if (!isCurrent()) return result; // BYOID のハッシュを待つ間に撤回・再許可された(Cookie を書かない)
  if (settings.uuidCookieEnabled && subtle) {
    try {
      const uuid = await deriveExternalUuid(siteSalt, visitorId, subtle);
      if (!isCurrent()) return result; // 導出を待つ間に撤回・再許可された(Cookie を書かない)
      writeCookie(doc, settings.uuidCookieName, uuid);
    } catch {
      // SHA-256 が使えない(決定 49 §7.2: 書かない)
    }
  }
  return result;
}

/** spec §16: revoke(denied への遷移)— 設定された正本(Mode C では参考用の匿名 Cookie)と UUID Cookie(有効時)の両方を削除する。D-lite は consent body を edge へ送る(runtime.ts) */
export function revokeIdentity(settings: RuntimeSettings, doc: { cookie: string }): void {
  deleteCookie(doc, settings.visitorCookieName);
  if (settings.uuidCookieEnabled) deleteCookie(doc, settings.uuidCookieName);
}
