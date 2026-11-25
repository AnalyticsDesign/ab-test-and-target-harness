/**
 * `POST /auth/reset-password` の失敗を画面の 1 文にする。
 * 中継は認証ライブラリの `{ code, message }` のコードを日本語にし、画面は封筒 `{ error, message, hint? }` から案内を組み立てる
 */
const BY_CODE: Record<string, string> = {
  INVALID_TOKEN: "このリンクは使えません。URL が途中で切れていないか確認し(末尾までコピーして開く)、それでも開けなければ期限切れか使用済みなので、リンクを発行し直してください",
  PASSWORD_TOO_SHORT: "パスワードが短すぎます。8 文字以上にしてください",
  PASSWORD_TOO_LONG: "パスワードが長すぎます。短くしてください",
};

export function resetErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { code?: unknown; error?: unknown; message?: unknown; hint?: unknown };
    if (typeof b.code === "string") return Object.hasOwn(BY_CODE, b.code) ? BY_CODE[b.code]! : `パスワードを変更できませんでした(${b.code})。リンクを発行し直してください`;
    if (typeof b.error === "string" && typeof b.message === "string" && b.message) return [b.message, typeof b.hint === "string" ? b.hint : ""].filter(Boolean).join(" ");
  }
  return `パスワードを変更できませんでした(HTTP ${status})。しばらく待ってからやり直してください`;
}
