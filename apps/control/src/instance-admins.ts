import { getDb, type Db } from "./db";
import type { Env } from "./env";
import { randomSlug } from "./ids";

/**
 * 決定 53(backlog B36): システム管理者のデータの読み書き。**「システム管理者として扱うか」「手を出してよいか」の判定は roles.ts**。
 * 不変条件 = システム管理者は、すべてのワークスペースに role = 'owner' の Member 行をちょうど 1 行持つ。
 * 昇格の前のロールは instance_admin_prior_roles に記録し、外すときに戻す(B46 / 決定 53 (15))。
 * 記録は書いた昇格の時刻(granted_at = instance_admins.created_at)を持ち、今の昇格の時刻と違う記録は「記録なし」として扱う(古い control を挟んだ巻き戻しの残り)。
 * instance_admins への書き込みと、ワークスペースの作成はこのファイルだけが行う
 * (Member 行を実体として持つのは、control が呼ぶ Better Auth の createInvitation が呼んだ人の Member 行を自分でも検査するため)
 */

/** SQL で足す Member 行の ID(Better Auth の date 列は ISO 文字列) */
const NEW_MEMBER_ID = "lower(hex(randomblob(16)))";

export async function isInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const row = await db.selectFrom("instance_admins").select("user_id").where("user_id", "=", userId).executeTakeFirst();
  return row !== undefined;
}

/**
 * ワークスペースを作る(K5)。organization 行と、システム管理者全員の OWNER 行を 1 つの batch(= 1 トランザクション)で書く。
 * Better Auth の createOrganization は organization と作成者の member を別々の文で書くので、途中で失敗すると半端なワークスペースが残り、
 * 昇格と競合すると行が重複する。この導入は組織のフック・チーム・activeOrganizationId を使っていないので、自前の版で挙動は同じ。
 * 呼び出し元は作成者がシステム管理者であることを確かめておく(POST /workspaces は requireInstanceAdmin、/setup は直前に登録)
 */
export async function createWorkspace(env: Env, name: string): Promise<string> {
  const id = randomSlug(32);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values (?1, ?2, ?3, ?4)`).bind(id, name, `ws-${randomSlug(8)}`, now),
    env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") select ${NEW_MEMBER_ID}, ?1, a.user_id, 'owner', ?2 from instance_admins a`).bind(id, now),
  ]);
  return id;
}

/**
 * 昇格(K2)。1 つの batch で、昇格前のロールの記録・登録・既存の Member 行を owner に・Member 行の無いワークスペースに owner の行・その人宛ての pending 招待の取り消し・
 * 未使用のパスワード再設定の token の削除。戻り値 "granted" = 新しく登録した / "already" = 既にシステム管理者(残りの 4 文は行の形を整えるためにそのまま実行する)/
 * "not_member" = `requireMember` でどこのメンバーでもなかった(どの文も行を書かない)。
 * backlog B41 (1): 昇格の API は「既存のメンバーの昇格のみ」(決定 53 (3))。メンバーであることを登録の文の条件に入れ、
 * 後ろの 4 文は「登録されている」ことを条件にする(事前の検索の後にメンバーから外されても、ワークスペースへ行を足さない)。
 * /setup は Member 行を作る前に登録するので `requireMember` を付けない
 */
export async function grantInstanceAdmin(
  env: Env,
  userId: string,
  grantedBy: string | null,
  opts: { requireMember?: boolean } = {},
): Promise<"granted" | "already" | "not_member"> {
  const now = new Date();
  const memberGuard = opts.requireMember ? `where exists (select 1 from member where "userId" = ?1)` : `where true`;
  const registeredGuard = `exists (select 1 from instance_admins where user_id = ?1)`;
  const [, , registered] = await env.DB.batch([
    // B46: まだシステム管理者でなければ、残っている記録を消す。記録は昇格のたびに作り直す(コードだけの巻き戻し = デプロイガイド 6.5 で
    // 古い control が外すと、記録が残るため)
    env.DB.prepare(`delete from instance_admin_prior_roles where user_id = ?1 and not exists (select 1 from instance_admins where user_id = ?1)`).bind(userId),
    // B46: まだシステム管理者でなければ、今の Member 行のロールを記録する(登録より前に置く。後に置くと、既にシステム管理者の人の
    // 再実行で OWNER を記録してしまう)。メンバーでなければ行が無いので何も書かない。
    // granted_at は 3 文目で instance_admins.created_at に入れる値と同じ(外すときに「今の昇格の記録か」を見分ける)
    env.DB.prepare(
      `insert into instance_admin_prior_roles (user_id, organization_id, role, granted_at)
       select ?1, m."organizationId", m.role, ?2 from member m
       where m."userId" = ?1 and not exists (select 1 from instance_admins where user_id = ?1)`,
    ).bind(userId, now.getTime()),
    env.DB.prepare(`insert into instance_admins (user_id, granted_by, created_at) select ?1, ?2, ?3 ${memberGuard} on conflict(user_id) do nothing`).bind(userId, grantedBy, now.getTime()),
    env.DB.prepare(`update member set role = 'owner' where "userId" = ?1 and role != 'owner' and ${registeredGuard}`).bind(userId),
    env.DB.prepare(
      `insert into member (id, "organizationId", "userId", role, "createdAt")
       select ${NEW_MEMBER_ID}, o.id, ?1, 'owner', ?2 from organization o
       where not exists (select 1 from member m where m."organizationId" = o.id and m."userId" = ?1) and ${registeredGuard}`,
    ).bind(userId, now.toISOString()),
    // 全ワークスペースのオーナーになったので、残っている招待は要らない(受けると Member 行が重複する。CX-High-3)
    env.DB.prepare(`update invitation set status = 'canceled' where status = 'pending' and lower(email) = (select lower(email) from "user" where id = ?1) and ${registeredGuard}`).bind(userId),
    // 昇格の前にシステム管理者でない人が発行したリセットリンクを、昇格の後に使わせない(r2 CX-High-6。Better Auth は
    // identifier = reset-password:<token>、value = user ID で保存する)
    env.DB.prepare(`delete from verification where identifier like 'reset-password:%' and value = ?1 and ${registeredGuard}`).bind(userId),
  ]);
  if ((registered?.meta.changes ?? 0) === 1) return "granted";
  return (await isInstanceAdmin(getDb(env), userId)) ? "already" : "not_member";
}

/**
 * backlog B41 (2): 昇格の候補 = どこかのワークスペースのメンバーで、まだシステム管理者でない人(メールの順)。
 * 各人の参加しているワークスペースとそこでのロールを付ける(管理画面の選択肢に出す)
 */
export async function listInstanceAdminCandidates(
  db: Db,
): Promise<Array<{ userId: string; email: string; name: string; workspaces: Array<{ id: string; name: string; role: string }> }>> {
  const rows = await db
    .selectFrom("member")
    .innerJoin("user", "user.id", "member.userId")
    .innerJoin("organization", "organization.id", "member.organizationId")
    .leftJoin("instance_admins", "instance_admins.user_id", "member.userId")
    .select(["user.id as userId", "user.email as email", "user.name as name", "organization.id as wid", "organization.name as wname", "member.role as role"])
    .where("instance_admins.user_id", "is", null)
    .orderBy("user.email")
    .orderBy("organization.createdAt")
    .orderBy("organization.id")
    .execute();
  const byUser = new Map<string, { userId: string; email: string; name: string; workspaces: Array<{ id: string; name: string; role: string }> }>();
  for (const r of rows) {
    const entry = byUser.get(r.userId) ?? { userId: r.userId, email: r.email, name: r.name, workspaces: [] };
    entry.workspaces.push({ id: r.wid, name: r.wname, role: r.role });
    byUser.set(r.userId, entry);
  }
  return [...byUser.values()];
}

/**
 * 降格(K3、B46 で改める)。1 つの batch で (a) 昇格前の記録があるワークスペースの Member 行を記録のロールに戻す
 * (b) 記録の無い Member 行(昇格で足した行・システム管理者でいる間に作られたワークスペースの行)を消す (c) 記録を消す
 * (d) instance_admins から外す。記録の無い人(/setup の最初の人・マイグレーション 0008 で登録された人)は (b) ですべての行が消える。
 * どの文にも「その人がシステム管理者で、かつシステム管理者が 2 人以上」の条件を入れる:
 * - この条件が、システム管理者でない人の Member 行を誤って書き換えないことを保証する(ID の打ち間違い・同時の降格)
 * - (d) を最後に置く。先に実行すると前の文の「その人がシステム管理者」が偽になり、行が戻らない・消えない
 * - batch は 1 トランザクションで直列なので、2 人を同時に降格しても 0 人にはならない
 * 記録は granted_at が今の instance_admins.created_at と一致するものだけを「記録」とみなす(古い control を挟んだ巻き戻しで残った古い記録では戻さない。
 * そのワークスペースの行は (b) で消え、古い記録は (c) で一緒に消える)。
 * opts.restore が false(B46 K11。退職者などを元のロールにも戻さず外す)なら、(a)(b) の代わりに、記録があっても
 * その人の Member 行をすべて消す(3 文。条件と並びは同じ)。既定は true
 */
export async function revokeInstanceAdmin(env: Env, userId: string, opts: { restore?: boolean } = {}): Promise<"revoked" | "not_admin" | "last"> {
  const restore = opts.restore ?? true;
  const guard = `exists (select 1 from instance_admins where user_id = ?1) and (select count(*) from instance_admins) > 1`;
  const prior = `select p.role from instance_admin_prior_roles p where p.user_id = ?1 and p.organization_id = member."organizationId"
    and p.granted_at = (select created_at from instance_admins where user_id = ?1)`;
  const memberStatements = restore
    ? [
        env.DB.prepare(`update member set role = (${prior}) where "userId" = ?1 and exists (${prior}) and ${guard}`).bind(userId),
        env.DB.prepare(`delete from member where "userId" = ?1 and not exists (${prior}) and ${guard}`).bind(userId),
      ]
    : [env.DB.prepare(`delete from member where "userId" = ?1 and ${guard}`).bind(userId)];
  const results = await env.DB.batch([
    ...memberStatements,
    env.DB.prepare(`delete from instance_admin_prior_roles where user_id = ?1 and ${guard}`).bind(userId),
    env.DB.prepare(`delete from instance_admins where user_id = ?1 and ${guard}`).bind(userId),
  ]);
  // 判定は最後の文(instance_admins から外す)の changes
  if ((results[results.length - 1]?.meta.changes ?? 0) === 1) return "revoked";
  const still = await env.DB.prepare(`select 1 from instance_admins where user_id = ?1`).bind(userId).first();
  return still ? "last" : "not_admin";
}

/** 一覧(昇格の古い順)。時刻は epoch ミリ秒。priorRoles = 外したときに戻るワークスペースとロール(B46。ワークスペースの作成順) */
export async function listInstanceAdmins(
  db: Db,
): Promise<Array<{ userId: string; email: string; name: string; createdAt: number; priorRoles: Array<{ workspaceId: string; workspaceName: string; role: string }> }>> {
  const admins = await db
    .selectFrom("instance_admins")
    .innerJoin("user", "user.id", "instance_admins.user_id")
    .select(["instance_admins.user_id as userId", "user.email as email", "user.name as name", "instance_admins.created_at as createdAt"])
    .orderBy("instance_admins.created_at")
    .orderBy("instance_admins.user_id")
    .execute();
  const prior = await db
    .selectFrom("instance_admin_prior_roles")
    .innerJoin("organization", "organization.id", "instance_admin_prior_roles.organization_id")
    // 今の昇格の記録だけ(granted_at が instance_admins.created_at と違う記録は、外すときに使われないので出さない)
    .innerJoin("instance_admins", (join) =>
      join.onRef("instance_admins.user_id", "=", "instance_admin_prior_roles.user_id").onRef("instance_admins.created_at", "=", "instance_admin_prior_roles.granted_at"),
    )
    .select(["instance_admin_prior_roles.user_id as userId", "organization.id as workspaceId", "organization.name as workspaceName", "instance_admin_prior_roles.role as role"])
    .orderBy("organization.createdAt")
    .orderBy("organization.id")
    .execute();
  return admins.map((a) => ({
    ...a,
    priorRoles: prior.filter((p) => p.userId === a.userId).map(({ workspaceId, workspaceName, role }) => ({ workspaceId, workspaceName, role })),
  }));
}
