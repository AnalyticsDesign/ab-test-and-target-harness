import { sql } from "kysely";
import type { Db } from "./db";
import type { Env } from "./env";

/** 短い値は未設定と同じに扱う(/break-glass/reset-link を総当たりの標的にしない。fail-closed) */
const MIN_TOKEN_LENGTH = 16;

export function breakGlassToken(env: Env): string | null {
  const t = env.AB_BREAK_GLASS_TOKEN?.trim() ?? "";
  return t.length >= MIN_TOKEN_LENGTH ? t : null;
}

/** 決定 46 (2): メール + パスワードの経路が開いているか。判定はこの 1 か所 */
export const passwordLoginOpen = (env: Env): boolean => breakGlassToken(env) !== null;

/** 閉じているあいだ 404 にする Better Auth の経路(index.ts の /auth/* が見る) */
export const PASSWORD_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/auth/sign-in/email",
  "/auth/sign-up/email",
  "/auth/request-password-reset",
  "/auth/reset-password",
]);

export const PASSWORD_LOGIN_DISABLED_HINT = "パスワードでのログインは無効です。ログインは Google アカウントで行います";

export const PASSWORD_SESSION_KEY_HINT = "Google アカウントでログインし直してから発行してください";

/**
 * B112: このセッションから API キーを発行してよいか。非常口を閉じても、パスワードのセッションで作った鍵は残るため、
 * パスワードのセッションでは発行させない。
 * - "gone" = セッションの行が無い(判定の直前に消えた)/ "password" = パスワードで作ったセッション、または印が無い(経路が分からない)のに
 *   持ち主がパスワードの記録(account の providerId = 'credential')を持つ(fail-closed)/ "ok" = それ以外
 * 1 回の照会で両方を読む: 非常口の掃除(cron/break-glass-sweep.ts)はセッションとパスワードの記録を 1 つの batch で消すので、
 * 同じ照会で読めば、すれ違っても「記録が消えたのにセッションが残っている」状態は見えない(掃除の後なら行が無く "gone")。
 * 列の別名 b112_login_method は、テスト(beforeD1Query)がこの照会だけを狙うための印(Better Auth の照会と見分ける)
 */
export async function passwordSessionVerdict(db: Db, sessionId: string): Promise<"ok" | "password" | "gone"> {
  const r = await sql<{ b112_login_method: string | null; has_password: number }>`
    select s."loginMethod" as b112_login_method,
      exists(select 1 from account a where a."userId" = s."userId" and a."providerId" = 'credential') as has_password
    from session s where s.id = ${sessionId}`.execute(db);
  const row = r.rows[0];
  if (!row) return "gone";
  if (row.b112_login_method === "password") return "password";
  if (row.b112_login_method !== "google" && Number(row.has_password) > 0) return "password";
  return "ok";
}
