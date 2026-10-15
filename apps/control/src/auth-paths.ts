// apps/control/src/auth-paths.ts
/**
 * Better Auth のうち MVP で使うパスだけを公開する(organization/* などプラグインのエンドポイントは control の自前ルートに閉じる)。
 * 完全一致のみ(決定 35 (2))。前方一致にすると `/auth/list-sessions` や `/auth/token`(セッショントークンを返す)まで開く。
 * backlog D13: 書き込みの凍結は /auth/* をすべて通すので、ここに業務の書き込みを足すと凍結から素通しになる。足すなら凍結の判定を見直す
 * (test/write-freeze.test.ts の `exempt routes are only login and evaluate` が中身を固定している)
 */
export const AUTH_ALLOW: readonly string[] = ["/auth/sign-in/email", "/auth/sign-out", "/auth/sign-up/email", "/auth/get-session", "/auth/request-password-reset", "/auth/reset-password"];
