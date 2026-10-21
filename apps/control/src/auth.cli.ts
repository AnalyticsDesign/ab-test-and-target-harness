// @better-auth/cli generate 用。本番の getAuth(env) と同じプラグイン構成を、D1 の代わりに in-memory SQLite で組む。
// プラグイン(organization / bearer / apiKey)の有無がテーブル集合を決めるため、src/auth.ts の plugins と必ず一致させる
// session.loginMethod の列は migrations/0018 が持つ。0001 を作り直すときに additionalFields をここへ写さない(写すと 0018 の ALTER が列の重複で失敗する)
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { apiKey, bearer, organization } from "better-auth/plugins";

export const auth = betterAuth({
  database: new Database(":memory:"),
  emailAndPassword: { enabled: true },
  // customAPIKeyGetter はリクエスト依存なのでここには置けない(スキーマには影響しない)
  plugins: [bearer(), organization({}), apiKey({ defaultPrefix: "wtt_", enableSessionForAPIKeys: true, maximumNameLength: 100 })],
});
