// auth generate 用(pnpm -C apps/control auth:schema。CLI の auth 1.7.x は Node.js 22.12 以上が要る)。本番の getAuth(env) と同じプラグイン構成を、D1 の代わりに in-memory SQLite で組む。
// プラグイン(organization / bearer / apiKey)の有無がテーブル集合を決めるため、src/auth.ts の plugins と必ず一致させる
// session.loginMethod の列(migrations/0018)と apikey の列名の読み替え(referenceId → "userId"、configId は 0025)も src/auth.ts と同じにする(B179)。
// 作った SQL はマイグレーションの全体(0001 + 後の ALTER)と見比べるためのもので、出力は一時ファイル($TMPDIR/better-auth-schema.sql)にする。
// 適用済みのマイグレーション(0001)には書き戻さない(書き戻すと 0018・0025 の ALTER が列の重複で失敗する)。足りない列はマイグレーションを新しく足す。
// わざと残す差(apikey."userId" の外部キーなど)の一覧は docs/superpowers/plans/2026-11-02-b179-better-auth-1-7-implementation.md の Task 10。
// 表の形が合っていることそのものは test/better-auth-schema.test.ts が本番の設定で見張る(B179 Task 10)
import Database from "better-sqlite3";
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { organization } from "better-auth/plugins/organization";

export const auth = betterAuth({
  database: new Database(":memory:"),
  emailAndPassword: { enabled: true },
  session: { additionalFields: { loginMethod: { type: "string", required: false, input: false } } },
  // customAPIKeyGetter はリクエスト依存なのでここには置けない(スキーマには影響しない)
  plugins: [
    bearer(),
    organization({}),
    apiKey({
      defaultPrefix: "wtt_",
      enableSessionForAPIKeys: true,
      maximumNameLength: 100,
      enableMetadata: true,
      schema: { apikey: { fields: { referenceId: "userId" } } },
    }),
  ],
});
