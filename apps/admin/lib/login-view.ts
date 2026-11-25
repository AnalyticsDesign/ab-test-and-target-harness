export type LoginView = { google: boolean; passwordLogin: boolean };

/** ログイン方法が確認できる応答だけを使う。null のとき、非常口の欄を出さない。 */
export function loginView(res: { status: number; data: unknown } | null): LoginView | null {
  if (res?.status !== 200 || typeof res.data !== "object" || res.data === null) return null;
  const { google, passwordLogin } = res.data as Record<string, unknown>;
  if (typeof google !== "boolean" || typeof passwordLogin !== "boolean") return null;
  return { google, passwordLogin };
}
