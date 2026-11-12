/**
 * Workspace に無関係な人を断るときの文言。次の 3 通りすべてに出るので、どれでも嘘にならない書き方にする:
 * (a) 招待されていない / 招待されたのと違うアカウント (b) Member から外された・招待を取り消された
 * (c) 非常用のパスワードログインで同じ理由により断られた
 * Google の経路は control の画面(src/login-failure.ts)に移った。同じ literal を apps/control/test/login-failure.test.ts が固定する
 */
export const NOT_INVITED =
  "このメールアドレスは、どのワークスペースにも所属しておらず、有効な招待もありません。招待されたメールアドレスと違うアカウントでログインしていないか確認し、心当たりが無ければ管理者に招待を依頼してください";

/** 管理画面自身が付ける失敗の code はやり直しの案内にする。 */
export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return "ログインを完了できませんでした。もう一度お試しください";
}
