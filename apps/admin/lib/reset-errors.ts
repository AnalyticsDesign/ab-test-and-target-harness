/**
 * `POST /auth/reset-password` の失敗を画面の 1 文にする。
 * 応答は 2 通り: 認証ライブラリの素の形 `{ code, message }`(英語)か、control / 管理画面の中継が出す封筒 `{ error, message, hint? }`(日本語)。
 * 前者はコードごとに日本語にし、後者は message と hint をそのまま出す
 */
const BY_CODE: Record<string, string> = {
  INVALID_TOKEN: "このリンクは使えません。URL が途中で切れていないか確認し(末尾までコピーして開く)、それでも開けなければ期限切れか使用済みなので、リンクを発行し直してください",
  PASSWORD_TOO_SHORT: "パスワードが短すぎます。8 文字以上にしてください",
  PASSWORD_TOO_LONG: "パスワードが長すぎます。短くしてください",
};

export function resetErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { code?: unknown; error?: unknown; message?: unknown; hint?: unknown };
    if (typeof b.code === "string") return BY_CODE[b.code] ?? `パスワードを変更できませんでした(${b.code})。リンクを発行し直してください`;
    if (typeof b.error === "string" && typeof b.message === "string" && b.message) return [b.message, typeof b.hint === "string" ? b.hint : ""].filter(Boolean).join(" ");
  }
  return `パスワードを変更できませんでした(HTTP ${status})。しばらく待ってからやり直してください`;
}
