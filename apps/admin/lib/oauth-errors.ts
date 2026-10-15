/**
 * Workspace に無関係な人を断るときの文言。次の 3 通りすべてに出るので、どれでも嘘にならない書き方にする:
 * (a) 招待されていない / 招待されたのと違うアカウント (b) Member から外された・招待を取り消された
 * (c) 非常用のパスワードログインで同じ理由により断られた
 */
export const NOT_INVITED =
  "このメールアドレスは、どのワークスペースにも所属しておらず、有効な招待もありません。招待されたメールアドレスと違うアカウントでログインしていないか確認し、心当たりが無ければ管理者に招待を依頼してください";

const MESSAGES: Record<string, string> = {
  not_invited: NOT_INVITED,
  unable_to_create_user: NOT_INVITED,
  email_not_verified: "この Google アカウントはメールアドレスが確認されていないため、ログインに使えません",
  account_not_linked: "この Google アカウントはメールアドレスが確認されていないため、既存のアカウントに結びつけられません",
  access_denied: "Google ログインがキャンセルされました",
};

/** control が `/login?error=<code>` に付けてくる値を画面の文言にする。未知の値はやり直しを促す */
export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? "ログインを完了できませんでした。もう一度お試しください";
}
