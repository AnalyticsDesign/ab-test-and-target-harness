import { sql } from "kysely";
import { sqlStatement } from "./db";

/**
 * B179 Task 2(D4): 招待を出すときに、同じメールの「確かめられていないパスワードの人」の記録を消す文。
 *
 * 対象 = 次のすべてを満たす user:
 * - emailVerified = 0(メールの本人確認が無い)
 * - パスワード以外の account(Google の結びつき)が無い
 * - どのワークスペースのメンバーでもない・システム管理者でもない
 * - 有効なセッションが無い。Better Auth の受諾は招待を accepted に書いた後、別の文で member を足す(1.7.15 の crud-invites.mjs の acceptInvitation も同じ順。
 *   D1 の adapter はトランザクションを使わない)ので、その途中で消すと
 *   member の文が外部キーで落ち、「招待は accepted・member 0」が残る。受諾にはその人のセッションが要るので、この条件で受諾の途中の人は必ず残る
 *   (パスワードのセッションは、非常口を閉じた後の掃除 cron/break-glass-sweep.ts が消す)
 * こういう人は better-auth 1.7 では Google でログインできず(未確認のメールに Google を結びつけない。oauth2/link-account.mjs の
 * `requireLocalEmailVerified && !dbUser.user.emailVerified`。test/better-auth-storage.test.ts の unverified_password_user_google_link)、招待し直しても入れない。
 * 記録を消せば、招待を受けて同じメールの新しい user で入り直せる。
 *
 * 条件は 3 文それぞれの中に同じ形で書く(判定と削除の間に隙を作らない)。(1)(2) は (3) より前に置く:
 * (1) その人が出した招待を、いま招待を出す人へ付け替える(invitation.inviterId は user を CASCADE で持つので、付け替えないと招待が消える)
 * (2) その人の再設定の token を消す(verification は外部キーが無く CASCADE で消えない。reset-link.ts の invalidateResetLinks と同じ形)
 * (3) user を消す(session・account・apikey(と apikey_revocations)・instance_admin_prior_roles は CASCADE で消える)
 * (1)(2) は条件に関わる表を変えないので、3 文とも同じ人を指す。
 * `lower(email) = ?` は索引を使わず user の表を読む(導入の人の数 = 数十〜数百行。3 文で 3 回)。
 * 大文字と小文字だけが違うメールの user が 2 行あり得る(email の UNIQUE は大文字と小文字を区別する)ので、`= (…)` ではなく `in (…)` で全部を指す
 */
export function removeUnprovenUserStatements(DB: D1Database, opts: { email: string; reassignTo: string }): D1PreparedStatement[] {
  // session."expiresAt" は Better Auth が ISO 文字列で書く(date 列)。同じ形の文字列で比べる(handoff.ts の verification と同じ)
  const now = new Date().toISOString();
  const target = sql`select u.id from "user" u where lower(u.email) = ${opts.email.toLowerCase()} and u."emailVerified" = 0
    and not exists (select 1 from account a where a."userId" = u.id and a."providerId" != 'credential')
    and not exists (select 1 from member m where m."userId" = u.id)
    and not exists (select 1 from instance_admins ia where ia.user_id = u.id)
    and not exists (select 1 from session s where s."userId" = u.id and s."expiresAt" > ${now})`;
  return [
    sqlStatement(DB, sql`update invitation set "inviterId" = ${opts.reassignTo} where "inviterId" in (${target})`),
    sqlStatement(DB, sql`delete from verification where identifier like 'reset-password:%' and value in (${target})`),
    // returning: 消した人の数を数える(meta.changes は CASCADE で消えた行も数える)
    sqlStatement(DB, sql`delete from "user" where id in (${target}) returning id`),
  ];
}
