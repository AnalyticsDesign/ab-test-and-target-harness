import type { Context } from "hono";
import { sql } from "kysely";
import type { AppEnv } from "./app";
import { pendingResetLinks } from "./auth";
import type { Db } from "./db";
import { ApiError } from "./errors";

/**
 * Better Auth の requestPasswordReset が sendResetPassword に渡す URL から token だけ取り出し、管理画面のリセットページの URL にする
 * (決定 35 (2)。control 側の GET /auth/reset-password/<token> は公開しない)。Member 用の発行と break-glass の両方が使う
 */
export async function issueResetUrl(c: Context<AppEnv>, rawEmail: string): Promise<string> {
  const email = rawEmail.toLowerCase();
  pendingResetLinks.delete(email);
  await c.get("auth").api.requestPasswordReset({ body: { email, redirectTo: `${c.env.AB_ADMIN_URL}/reset` } });
  const issued = pendingResetLinks.get(email);
  pendingResetLinks.delete(email);
  if (!issued) throw new ApiError(500, "reset_link_unavailable");
  const rawToken = new URL(issued).pathname.split("/").pop();
  if (!rawToken) throw new ApiError(500, "reset_link_unavailable");
  // pathname は percent-encoded なので、searchParams.set で再エンコードする前に一度戻す
  const url = new URL("/reset", c.env.AB_ADMIN_URL);
  url.searchParams.set("token", decodeURIComponent(rawToken));
  return url.toString();
}

/**
 * その user に発行済みで未使用のパスワード再設定リンクをすべて消す。Better Auth は `verification` に
 * identifier = `reset-password:<token>`、value = user ID で保存する(決定 53 (9) / K9 が昇格で行っているのと同じ消し方)。
 * 呼ぶ場面 = 所属が変わったとき(招待の受諾・Role の変更)。発行時の認可は発行時の所属で判定しているので、
 * 所属が変わった後に古いリンクが使えると、認可の無い人のリンクで他所のワークスペースに入れてしまう(レビュー r1 CX-High-1)
 */
export async function invalidateResetLinks(db: Db, userId: string): Promise<void> {
  await sql`delete from verification where identifier like 'reset-password:%' and value = ${userId}`.execute(db);
}
