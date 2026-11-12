/** Google のログイン失敗は固定の理由と案内だけを返す。要求の値は本文に埋め込まない。 */
export type LoginFailureCode = "not_invited" | "email_not_verified" | "account_not_linked" | "access_denied" | "rate_limited" | "google_not_configured" | "oauth_failed";

export const NOT_INVITED = "このメールアドレスは、どのワークスペースにも所属しておらず、有効な招待もありません。招待されたメールアドレスと違うアカウントでログインしていないか確認し、心当たりが無ければ管理者に招待を依頼してください";
export const LOGIN_FAILURE_GUIDE = "管理画面のログイン画面を開き直して、もう一度ログインしてください。招待リンクから始めた場合は、招待リンクを開き直してください。この画面から管理画面へは移動できません。管理画面のアドレスが分からないときは、管理画面を案内した人に確かめてください";

const MESSAGES: Record<LoginFailureCode, string> = {
  not_invited: NOT_INVITED,
  email_not_verified: "この Google アカウントはメールアドレスが確認されていないため、ログインに使えません",
  account_not_linked: "この Google アカウントを、同じメールアドレスの既存のアカウントに結びつけられませんでした。Google アカウントのメールアドレスが確認済みであることを確かめてください。確認済みなら、非常用のパスワードで作られたアカウントのため、自動では結びつきません。管理者に、あなたを同じメールアドレスで招待し直すよう依頼してください",
  access_denied: "Google ログインがキャンセルされました",
  rate_limited: "短い時間にログインの要求が多すぎたため、受け付けませんでした。少し待ってから、もう一度ログインしてください",
  google_not_configured: "この導入では Google ログインの設定が済んでいません。管理画面を案内した人に確かめてください",
  oauth_failed: "ログインを完了できませんでした。もう一度お試しください",
};

/** Better Auth の理由を一覧に閉じる。制限と設定不足は control が自分で選ぶ。 */
export function loginFailureCode(raw: string | null | undefined): LoginFailureCode {
  switch (raw?.toLowerCase()) {
    case "not_invited": return "not_invited";
    case "email_not_verified": return "email_not_verified";
    case "account_not_linked": return "account_not_linked";
    case "access_denied": return "access_denied";
    default: return "oauth_failed";
  }
}

const SERVER_FAULTS = new Set(["internal_server_error", "unable_to_create_user", "unable_to_link_account", "unable_to_update_account", "unable_to_create_session"]);
export function isServerFaultCode(raw: string | null | undefined): boolean {
  return SERVER_FAULTS.has(raw?.toLowerCase() ?? "");
}

export function loginFailureStatus(code: LoginFailureCode): 400 | 403 | 429 | 503 {
  if (code === "not_invited" || code === "email_not_verified" || code === "account_not_linked") return 403;
  if (code === "rate_limited") return 429;
  if (code === "google_not_configured") return 503;
  return 400;
}

/** Cookie の失効を保ち、遷移先を含みうるヘッダーは呼び出し側からも受け取らない。 */
export function loginFailurePage(code: LoginFailureCode, opts: { status?: 400 | 403 | 429 | 500 | 503; headers?: Headers } = {}): Response {
  const headers = new Headers(opts.headers);
  for (const name of ["location", "refresh", "link"]) headers.delete(name);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  // code は閉じた型、文言は固定値だけなので、要求に含まれる任意の文字列を差し込まない。
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>ログインできませんでした</title><style>body{font-family:system-ui;margin:0;padding:2rem}main{max-width:40rem;margin:2rem auto}p{line-height:1.8}</style></head><body><main data-code="${code}"><h1>ログインできませんでした</h1><p>${MESSAGES[code]}</p><p>${LOGIN_FAILURE_GUIDE}</p><p>理由のコード: <code>${code}</code></p></main></body></html>`;
  return new Response(html, { status: opts.status ?? loginFailureStatus(code), headers });
}
