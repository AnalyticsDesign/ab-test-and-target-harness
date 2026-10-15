export type LoginView = { google: boolean; passwordLogin: boolean };

/**
 * ログイン画面の出し分け(control の GET /login-options から)。取得できない・形が違うときは「Google のみ」に倒す
 * — パスワード欄を誤って出しても control が 404 で断るだけだが、普段の画面に総当たりの的を見せない
 */
export function loginView(res: { status: number; data: unknown }): LoginView {
  if (res.status !== 200 || typeof res.data !== "object" || res.data === null) return { google: true, passwordLogin: false };
  const d = res.data as Record<string, unknown>;
  return { google: d.google !== false, passwordLogin: d.passwordLogin === true };
}
