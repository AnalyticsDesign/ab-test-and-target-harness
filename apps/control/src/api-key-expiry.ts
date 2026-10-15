// apps/control/src/api-key-expiry.ts — API キーの有効期限(backlog B43)。期限は Better Auth に渡さず metadata の expiresAt に持ち、control の入口で判定する。
// Better Auth 1.4.21 は期限切れの鍵を持ち主・失効に関係なく物理削除し(一括削除と、使われたときの個別削除)、失効の記録も CASCADE で消えるため。
// 見張り: Better Auth の版を上げるときは、発行時に Better Auth の expiresAt 列が null のまま(既定の期限が付かない)かを確かめる
// (test/api-key-expiry.test.ts の "never into Better Auth's column" が落ちる)。
// 検討記録 = docs/dev/api_key_expiry_study_v1.md
import { UNREADABLE, parseKeyMetadata } from "./roles";

export const KEY_EXPIRED_HINT = "この API キーは有効期限を過ぎています。管理画面で発行し直してください";

/**
 * 鍵の有効期限(epoch ミリ秒)。fail-closed:
 * - metadata の expiresAt が有限の数 = その時刻 / null = 期限なし
 * - キーが無い(B43 より前に発行した鍵)・metadata が無い(NULL・空・JSON の null)= Better Auth の列(`nativeExpiresAt`。NaN は "invalid")
 * - それ以外(読めない JSON・オブジェクトでない metadata・数でも null でもない expiresAt)= "invalid"(使えない)
 * metadata の読み方は roles.ts の上限・範囲と同じ(parseKeyMetadata)
 */
export function keyExpiresAt(metadata: string | null | undefined, nativeExpiresAt: number | null): number | null | "invalid" {
  // Better Auth の列が日時として読めない(NaN)ときも使えない側に倒す
  const native = nativeExpiresAt !== null && !Number.isFinite(nativeExpiresAt) ? "invalid" : nativeExpiresAt;
  if (metadata == null || metadata === "") return native;
  const parsed = parseKeyMetadata(metadata);
  if (parsed === UNREADABLE) return "invalid";
  if (parsed === null) return native; // Better Auth は metadata 無しの鍵を JSON の null("null")で保存する
  if (typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  if (!("expiresAt" in parsed)) return native;
  const v = (parsed as { expiresAt: unknown }).expiresAt;
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : "invalid";
}

/** 期限切れか(境界は「使えない」= expiresAt <= now。読めない期限も使えない) */
export const isKeyExpired = (expiresAt: number | null | "invalid", now: number): boolean => expiresAt === "invalid" || (expiresAt !== null && expiresAt <= now);

/**
 * 使えなくなった時刻 = 失効か期限切れの早い方(一覧に残す 30 日の起点)。期限がまだ先なら失効の時刻だけ。
 * 読めない期限は時刻が分からないので起点にしない(失効していなければ残り続け、失効させれば失効から 30 日)
 */
export function unusableSince(revokedAt: number | null, expiresAt: number | null | "invalid", now: number): number | null {
  const expired = typeof expiresAt === "number" && expiresAt <= now ? expiresAt : null;
  if (revokedAt === null) return expired;
  return expired === null ? revokedAt : Math.min(revokedAt, expired);
}
