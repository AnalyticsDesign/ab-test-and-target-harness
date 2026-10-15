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
