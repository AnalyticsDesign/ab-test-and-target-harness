import { sql } from "kysely";
import type { Db } from "./db";

/**
 * 決定 46 (5) / backlog B20: 管理画面に入れる条件をここ 1 か所に置く。
 * セッション作成のフック(auth.ts)と、Member を外した / 招待を取り消したときの失効判定が同じ式を使う。
 */

/** そのメールアドレス宛ての pending・未失効の招待があるか */
export async function hasLiveInvitation(db: Db, email: string): Promise<boolean> {
  const r = await sql<{ expiresAt: string | number }>`select "expiresAt" from invitation where lower(email) = ${email.toLowerCase()} and status = 'pending'`.execute(db);
  return r.rows.some((row) => new Date(row.expiresAt).getTime() > Date.now());
}

/** どこかの Workspace の Member か(どの Workspace かは問わない) */
export async function isMemberAnywhere(db: Db, userId: string): Promise<boolean> {
  const member = await db.selectFrom("member").select("id").where("userId", "=", userId).executeTakeFirst();
  return member !== undefined;
}

/** (a) どこかの Workspace の Member、または (b) 自分のメール宛ての有効な招待がある */
export async function hasAccess(db: Db, userId: string): Promise<boolean> {
  if (await isMemberAnywhere(db, userId)) return true;
  const user = await db.selectFrom("user").select("email").where("id", "=", userId).executeTakeFirst();
  return user ? hasLiveInvitation(db, user.email) : false;
}

/**
 * 上の条件をどちらも満たさなくなった user のログイン状態を切る。
 * 失敗しても呼び出し元の操作(Member を外す / 招待を取り消す)は成功のまま返す —
 * 本体の操作は済んでおり、次のログインはセッション作成のフックが止める
 */
export async function revokeSessionsIfNoAccess(db: Db, userId: string): Promise<void> {
  try {
    if (await hasAccess(db, userId)) return;
    await sql`delete from session where "userId" = ${userId}`.execute(db);
  } catch (e) {
    console.error("failed to revoke the sessions of a user that lost access", e);
  }
}

/** 招待のメールアドレスに一致する user が居る場合だけ上を行う(居なければ何もしない) */
export async function revokeSessionsForEmailIfNoAccess(db: Db, email: string): Promise<void> {
  try {
    const r = await sql<{ id: string }>`select id from "user" where lower(email) = ${email.toLowerCase()}`.execute(db);
    const userId = r.rows[0]?.id;
    if (userId) await revokeSessionsIfNoAccess(db, userId);
  } catch (e) {
    console.error("failed to look up the user of a canceled invitation", e);
  }
}
