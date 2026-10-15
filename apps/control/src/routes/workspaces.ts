import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { sql } from "kysely";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import { revokeSessionsForEmailIfNoAccess, revokeSessionsIfNoAccess } from "../access";
import { bearerHeaders, ROLES } from "../auth";
import { PASSWORD_LOGIN_DISABLED_HINT, passwordLoginOpen } from "../break-glass";
import { ApiError, ROLE_JA, notFound, parseJson, validationFailed } from "../errors";
import { createWorkspace, isInstanceAdmin } from "../instance-admins";
import { errorResponses } from "../openapi";
import { invalidateResetLinks, issueResetUrl } from "../reset-link";
import { assertCanResetMember, assertCanTouchInstanceAdmin, assertCanTouchOwner, atLeast, capRole, isRole, requireInstanceAdmin, requireWorkspaceRole, scopeIncludes } from "../roles";
import { deleteSiteAssets, deleteSiteRecords } from "../site-settings";
import { requestStaticRemoval, staticRemoveConflict, staticRemoveFailed } from "../static-delivery";

/** 招待できる Role。OWNER は招待では付けない(既存 OWNER が PATCH で昇格させる) */
const INVITABLE_ROLES = ["admin", "editor", "viewer"] as const;

const NameSchema = z.strictObject({ name: z.string().min(1).max(100) });
const RoleSchema = z.strictObject({ role: z.enum(ROLES) });
const InvitationSchema = z.strictObject({ email: z.string().email(), role: z.enum(INVITABLE_ROLES) });
const AcceptSchema = z.strictObject({ name: z.string().min(1).max(100), password: z.string().min(8).max(200) });

const WorkspaceSchema = z.object({ id: z.string(), name: z.string(), role: z.enum(ROLES) });
const SiteSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  runningCount: z.number().int().describe("Desired と公開済みのどちらかが running のエクスペリエンスの数(サイト・ワークスペースの削除を断る条件と同じ)"),
});
const WorkspaceSummarySchema = WorkspaceSchema.extend({
  memberCount: z.number().int().nullable().describe("このワークスペースのメンバーの数。実効のロールが管理者以上のときだけ数を返し、それ以外は null(メンバーの一覧を見られる範囲と同じ)"),
  sites: z.array(SiteSummarySchema).describe("作成の古い順"),
});
const MemberSchema = z.object({ memberId: z.string(), userId: z.string(), email: z.string(), name: z.string(), role: z.string(), instanceAdmin: z.boolean().describe("システム管理者か(ロールの変更・削除はできない。外すときは /instance-admins から)") });
const InvitationResultSchema = z.object({
  id: z.string(),
  url: z.string(),
  expiresAt: z.number().describe("epoch ミリ秒"),
  extended: z.boolean().describe("true = 同じロールの招待が既にあり、そのリンクの期限を延ばした(id と url は前と同じ)"),
});
const InvitationListSchema = z.object({ id: z.string(), email: z.string(), role: z.string().nullable(), status: z.string(), expiresAt: z.number(), url: z.string() });
const PublicInvitationSchema = z.object({ id: z.string(), email: z.string(), role: z.string().nullable(), workspaceName: z.string(), status: z.string(), expiresAt: z.number() });
const AcceptResultSchema = z.object({ token: z.string(), workspaceId: z.string(), userId: z.string().nullable() });
const ResetLinkSchema = z.object({ url: z.string().describe("管理画面の `/reset?token=…`(本人に手渡しする)") });

/** 時刻は epoch ミリ秒(Global Constraints)。D1 の date 列は ISO 文字列で入っている */
const epochMs = (v: string | number | Date): number => new Date(v).getTime();

/** 2 つの URL / Origin 文字列が同じオリジンか(末尾スラッシュ・パスの違いは無視。読めない値は不一致) */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** member 表の UNIQUE 違反か(例外そのものと、cause の連鎖の message を見る。他の表・他の種類の失敗は false) */
function isMemberUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 5; cur = cur.cause, depth++) {
    if (/UNIQUE constraint failed: member\.organizationId/.test(cur.message)) return true;
  }
  return false;
}

export const workspaceRoutes = new Hono<AppEnv>();

workspaceRoutes.get(
  "/workspaces",
  describeRoute({
    tags: ["workspaces"],
    summary: "自分が所属するワークスペースの一覧(ロール付き)。ワークスペース指定の API キーでは、そのワークスペースだけ",
    responses: {
      200: { description: "所属ワークスペース", content: { "application/json": { schema: resolver(z.array(WorkspaceSchema)) } } },
      ...errorResponses(401),
    },
  }),
  requireSession,
  async (c) => {
    const rows = await c
      .get("db")
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .select(["organization.id as id", "organization.name as name", "member.role as role"])
      .where("member.userId", "=", c.get("user").id)
      .orderBy("organization.createdAt")
      .execute();
    // B33: 鍵経由なら実効 Role(上限を被せた値)を返す。エージェントが「この Workspace で何ができるか」をここで読むため。
    // B42: ワークスペースの鍵では範囲の 1 つだけ(他のワークスペースの存在を見せない)
    return c.json(rows.filter((r) => scopeIncludes(c, r.id)).map((r) => ({ ...r, role: isRole(r.role) ? capRole(c, r.role) : r.role })));
  },
);

workspaceRoutes.get(
  "/workspaces/summary",
  describeRoute({
    tags: ["workspaces"],
    summary: "自分が所属するワークスペースの概要(ロール・メンバー数・サイトごとの配信中のエクスペリエンスの数)。ワークスペース指定の API キーでは、そのワークスペースだけ",
    responses: {
      200: { description: "所属するワークスペースの概要", content: { "application/json": { schema: resolver(z.array(WorkspaceSummarySchema)) } } },
      ...errorResponses(401),
    },
  }),
  requireSession,
  async (c) => {
    const db = c.get("db");
    const userId = c.get("user").id;
    // 範囲と上限は GET /workspaces と同じ(B42 / B33)
    const mine = (
      await db
        .selectFrom("member")
        .innerJoin("organization", "organization.id", "member.organizationId")
        .select(["organization.id as id", "organization.name as name", "member.role as role"])
        .where("member.userId", "=", userId)
        .orderBy("organization.createdAt")
        .execute()
    ).filter((r) => scopeIncludes(c, r.id));
    if (mine.length === 0) return c.json([]);
    // 集計は「自分が所属するワークスペース」の副問い合わせで絞る(ID を列挙すると D1 のバインド変数の上限 100 に当たる)。
    // 範囲外のワークスペースの行は下の map で使わないだけ
    const myOrgs = db.selectFrom("member").select("organizationId").where("userId", "=", userId);
    const [members, sites, running] = await Promise.all([
      db.selectFrom("member").select(["organizationId", sql<number>`count(*)`.as("n")]).where("organizationId", "in", myOrgs).groupBy("organizationId").execute(),
      db.selectFrom("sites").select(["id", "workspace_id", "name", "domain"]).where("workspace_id", "in", myOrgs).orderBy("created_at").execute(),
      // 配信中 = Desired と公開済みのどちらかが running(DELETE /workspaces/:wid・DELETE /sites/:sid が断る条件と同じ)
      db
        .selectFrom("experiments")
        .innerJoin("sites", "sites.id", "experiments.site_id")
        .select(["experiments.site_id as siteId", sql<number>`count(*)`.as("n")])
        .where("sites.workspace_id", "in", myOrgs)
        .where((eb) => eb.or([eb("experiments.status", "=", "running"), eb("experiments.published_status", "=", "running")]))
        .groupBy("experiments.site_id")
        .execute(),
    ]);
    const memberCount = new Map(members.map((m) => [m.organizationId, Number(m.n)]));
    const runningBySite = new Map(running.map((r) => [r.siteId, Number(r.n)]));
    return c.json(
      mine.map((w) => {
        const role = isRole(w.role) ? capRole(c, w.role) : w.role;
        return {
          id: w.id,
          name: w.name,
          role,
          // K22: メンバー数はメンバーの一覧(GET /workspaces/:wid/members = 管理者以上)と同じ範囲にだけ見せる
          memberCount: isRole(role) && atLeast(role, "admin") ? (memberCount.get(w.id) ?? 0) : null,
          sites: sites
            .filter((s) => s.workspace_id === w.id)
            .map((s) => ({ id: s.id, name: s.name, domain: s.domain, runningCount: runningBySite.get(s.id) ?? 0 })),
        };
      }),
    );
  },
);

workspaceRoutes.post(
  "/workspaces",
  describeRoute({
    tags: ["workspaces"],
    summary: "ワークスペースを作る(システム管理者のみ・セッションのみ)。システム管理者全員がオーナーになる",
    responses: {
      201: { description: "作成したワークスペース", content: { "application/json": { schema: resolver(z.object({ id: z.string() })) } } },
      ...errorResponses(400, 401, 403, 422, 500),
    },
  }),
  requireSession,
  requireInstanceAdmin,
  validator("json", NameSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const body = c.req.valid("json");
    // 決定 53 (4)(11) / K5: organization 行とシステム管理者全員の OWNER 行を 1 つの batch で書く(作成者もシステム管理者なので含まれる)
    let id: string;
    try {
      id = await createWorkspace(c.env, body.name);
    } catch (e) {
      throw new ApiError(500, "workspace_create_failed", { detail: String(e) });
    }
    return c.json({ id }, 201);
  },
);

workspaceRoutes.delete(
  "/workspaces/:wid",
  describeRoute({
    tags: ["workspaces"],
    summary: "ワークスペースを削除(システム管理者のみ・セッションのみ)。最後に残った 1 つと、配信中のエクスペリエンスがあるワークスペースは削除できない。配下のサイトの設置タグの配信ファイルも消し、消せなかったときは 503 でワークスペースを残す",
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409, 503) },
  }),
  requireSession,
  requireInstanceAdmin,
  async (c) => {
    const wid = c.req.param("wid");
    const db = c.get("db");
    // 決定 53 (12): 削除はシステム管理者だけ(入口の requireInstanceAdmin)。システム管理者は全ワークスペースのオーナーなので、
    // ここに来るのは存在するワークスペースのオーナー。無い ID は 404
    const org = await db.selectFrom("organization").select("id").where("id", "=", wid).executeTakeFirst();
    if (!org) throw notFound();
    // 決定 53 (13): 配下のサイトに、Desired と Published のどちらかが running のエクスペリエンスがあれば消せない(サイトの削除と同じ判定)
    const running = await db
      .selectFrom("experiments")
      .innerJoin("sites", "sites.id", "experiments.site_id")
      .select(["experiments.id as experimentId", "sites.id as siteId"])
      .where("sites.workspace_id", "=", wid)
      .where((eb) => eb.or([eb("experiments.status", "=", "running"), eb("experiments.published_status", "=", "running")]))
      .executeTakeFirst();
    if (running) {
      throw new ApiError(409, "workspace_has_running_experiments", {
        siteId: running.siteId,
        experimentId: running.experimentId,
        message: "配信中のエクスペリエンスがあります",
        hint: "先にすべてのエクスペリエンスを終了してから削除してください",
      });
    }
    // 配下 Site の後始末。順序が肝: **先に消えない情報(何を消すか)を読み、次に organization を消し、最後に KV / R2**。
    // KV / R2 を先に消すと、deleteOrganization が失敗したとき「D1 には Site があるのに配信設定だけ消えた」
    // 復旧不能な状態が残る。この順なら deleteOrganization より前で失敗しても何も壊れておらず、
    // 後の KV / R2 掃除は冪等・ベストエフォート(失敗しても残骸が残るだけ)
    const sites = await db.selectFrom("sites").selectAll().where("workspace_id", "=", wid).execute();
    const versionsBySite = new Map<string, number[]>();
    for (const site of sites) {
      versionsBySite.set(site.id, (await db.selectFrom("publishes").select("version").where("site_id", "=", site.id).execute()).map((r) => r.version));
    }
    // member 行は organization と一緒に消えるので、誰が居たかは先に控える(B20 の失効判定に使う)
    const memberIds = (await db.selectFrom("member").select("userId").where("organizationId", "=", wid).execute()).map((m) => m.userId);
    // 決定 52 (5) / 7i plan K19: 配下の Site の配信ファイルを先に消す(organization の FK CASCADE で Site が消えるので、Site の削除の経路を通らない)。
    // 最後の 1 つかは配信ファイルを消す前に確かめる。消した後で下の削除が last_workspace で断られると、残ったワークスペースの
    // Site の配信ファイルが墓標で消え、作り直すまで配られないため。下の削除の文の件数の条件は残す(同時削除の最後の守り)。
    // 残る競合: 最後の 2 つを別々のシステム管理者が同時に消すと、両方がここを通り、負けた側の Site は配信ファイルを一度失う。
    // 自動では戻さない。requestStaticRemoval が立てた static_stale = 1 と static_removing により、画面に「削除が途中で止まっています」が出て、
    // もう一度削除するか「配信ファイルを作り直す」で戻す(K19・K2・K23)
    const lastWorkspace = () => new ApiError(409, "last_workspace", { message: "最後のワークスペースは削除できません", hint: "先に別のワークスペースを作ってから削除してください" });
    const orgCount = await sql<{ n: number }>`select count(*) as n from organization`.execute(db);
    if (Number(orgCount.rows[0]?.n ?? 0) <= 1) throw lastWorkspace();
    // 7i plan K23: 削除ごとの印。1 つの token を配下の全 Site に使い、下の削除の文の条件にする
    const token = crypto.randomUUID();
    for (const site of sites) {
      try {
        await requestStaticRemoval(c.env, db, site.id, token);
      } catch (e) {
        // 消し終えた Site があっても、やり直しの削除は同じ墓標を送り直すだけ(デプロイ専用の Worker は受け付け済みの同じ世代を accepted に返す)
        console.error("static remove failed", site.id, e);
        throw staticRemoveFailed();
      }
    }
    // 最後の 1 つは消させない。消すと誰もどこの Member でもなくなり、システム管理者もログインできなくなる(D1 を手で直すしか戻れない)。
    // 件数の条件を削除の文そのものに入れ、同時に最後の 2 つを消しても片方だけが消えるようにする(K15。Better Auth の
    // deleteOrganization は member → invitation → organization の 3 文で、この条件を入れられない)。
    // 7i plan K23: 配下の全 Site の static_removing が自分の token のときだけ消す(削除の途中で「配信ファイルを作り直す」が
    // 印を消した Site があれば取りやめる)。件数の条件(最後の 1 つ)と同じ 1 文に入れる。
    // member・invitation・sites / site_hosts / publishes は organization の FK CASCADE で落ちる
    const del = await sql`delete from organization where id = ${wid} and (select count(*) from organization) > 1
      and not exists (select 1 from sites where workspace_id = ${wid} and (static_removing is null or static_removing <> ${token}))`.execute(db);
    if (Number(del.numAffectedRows ?? 0) === 0) {
      // どちらの条件で 0 行になったかを、件数で返し分ける
      const n = await sql<{ n: number }>`select count(*) as n from organization`.execute(db);
      throw Number(n.rows[0]?.n ?? 0) <= 1 ? lastWorkspace() : staticRemoveConflict();
    }
    // この Workspace にしか居なかった人のログイン状態を切る(他の Workspace の Member / 有効な招待があれば残る)
    for (const userId of memberIds) await revokeSessionsIfNoAccess(db, userId);
    for (const site of sites) {
      await deleteSiteRecords(c.env, site, versionsBySite.get(site.id) ?? []);
      await deleteSiteAssets(c.env, site.id);
    }
    return c.body(null, 204);
  },
);

workspaceRoutes.get(
  "/workspaces/:wid/members",
  describeRoute({
    tags: ["members"],
    summary: "メンバー一覧(管理者以上)",
    responses: {
      200: { description: "メンバー一覧", content: { "application/json": { schema: resolver(z.array(MemberSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "admin");
    const rows = await c
      .get("db")
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .leftJoin("instance_admins", "instance_admins.user_id", "member.userId")
      .select([
        "member.id as memberId",
        "user.id as userId",
        "user.email as email",
        "user.name as name",
        "member.role as role",
        sql<number>`instance_admins.user_id is not null`.as("instanceAdmin"),
      ])
      .where("member.organizationId", "=", wid)
      .orderBy("member.createdAt")
      .execute();
    return c.json(rows.map((r) => ({ ...r, instanceAdmin: Boolean(r.instanceAdmin) })));
  },
);

workspaceRoutes.patch(
  "/workspaces/:wid/members/:memberId",
  describeRoute({
    tags: ["members"],
    summary: "メンバーのロールを変更(管理者以上・セッションのみ。owner の付け外しはオーナーのみ)。システム管理者の行は 409",
    responses: {
      200: { description: "変更後のロール", content: { "application/json": { schema: resolver(z.object({ memberId: z.string(), role: z.enum(ROLES) })) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", RoleSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const { wid, memberId } = c.req.param();
    const me = await requireWorkspaceRole(c, wid, "admin");
    const body = c.req.valid("json");
    const db = c.get("db");
    const target = await db.selectFrom("member").selectAll().where("id", "=", memberId).where("organizationId", "=", wid).executeTakeFirst();
    if (!target) throw notFound();
    // owner を付け外しできるのは owner だけ(admin が自分を owner に昇格させる経路を塞ぐ)
    assertCanTouchOwner(me, target.role, body.role);
    // 2 つの条件を同じ文に入れる: (1) 対象がシステム管理者でない(決定 53 (6) / K9。事前チェックだけだと、チェックと書き込みの間の昇格で守れない)
    // (2) 最後の OWNER を降格させない(2 人の OWNER の同時降格で 0 人にならない。review r2 CX-Medium-5)
    // Role の変更と、変わる前に発行された再設定リンクの削除を 1 つの batch で行う(どちらか片方だけが残らない。K9 の昇格と同じ流儀)。
    // 変更が 0 行(409 の分岐)でも削除は走るが、使えなくなるのは非常時専用のリンクだけなので害は無い
    const [upd] = await c.env.DB.batch([
      c.env.DB.prepare(
        `update member set role = ?1 where id = ?2 and "organizationId" = ?3
         and not exists (select 1 from instance_admins a where a.user_id = member."userId")
         and (role != 'owner' or (select count(*) from member m2 where m2."organizationId" = ?3 and m2.role = 'owner') > 1)`,
      ).bind(body.role, memberId, wid),
      c.env.DB.prepare(`delete from verification where identifier like 'reset-password:%' and value = ?1`).bind(target.userId),
    ]);
    if ((upd?.meta.changes ?? 0) === 0) {
      if (await isInstanceAdmin(db, target.userId)) {
        throw new ApiError(409, "instance_admin_member", { hint: "システム管理者から外すときは、ユーザーメニュー →「設定」→「システム管理者」から行ってください(API では DELETE /instance-admins/:userId)" });
      }
      throw new ApiError(409, "last_owner", { message: "最後のオーナーは変更できません", hint: "先に別のメンバーをオーナーにしてください" });
    }
    return c.json({ memberId, role: body.role });
  },
);

workspaceRoutes.delete(
  "/workspaces/:wid/members/:memberId",
  describeRoute({
    tags: ["members"],
    summary: "メンバーを外す(管理者以上・セッションのみ。owner を外せるのはオーナーのみ)。システム管理者の行は 409",
    responses: { 204: { description: "外した" }, ...errorResponses(401, 403, 404, 409) },
  }),
  requireSession,
  async (c) => {
    const { wid, memberId } = c.req.param();
    const me = await requireWorkspaceRole(c, wid, "admin");
    const db = c.get("db");
    const target = await db.selectFrom("member").selectAll().where("id", "=", memberId).where("organizationId", "=", wid).executeTakeFirst();
    if (!target) throw notFound();
    assertCanTouchOwner(me, target.role);
    if (target.userId === c.get("user").id) throw new ApiError(409, "cannot_remove_self", { message: "自分自身は外せません", hint: "ほかの管理者かオーナーに外してもらってください" });
    // 2 つの条件を同じ文に入れる: (1) 対象がシステム管理者でない(K9) (2) 最後の OWNER を削除させない(review r2 CX-Medium-5)
    const del = await sql`delete from member where id = ${memberId} and "organizationId" = ${wid}
      and not exists (select 1 from instance_admins a where a.user_id = member."userId")
      and (role != 'owner' or (select count(*) from member m2 where m2."organizationId" = ${wid} and m2.role = 'owner') > 1)`.execute(db);
    if (Number(del.numAffectedRows ?? 0) === 0) {
      if (await isInstanceAdmin(db, target.userId)) {
        throw new ApiError(409, "instance_admin_member", { hint: "システム管理者から外すときは、ユーザーメニュー →「設定」→「システム管理者」から行ってください(API では DELETE /instance-admins/:userId)" });
      }
      throw new ApiError(409, "last_owner", { message: "最後のオーナーは外せません", hint: "先に別のメンバーをオーナーにしてください" });
    }
    // 他の Workspace にも所属しておらず、別の有効な招待も無ければ、その人のログイン状態を切る(B20)
    await revokeSessionsIfNoAccess(db, target.userId);
    return c.body(null, 204);
  },
);

workspaceRoutes.post(
  "/workspaces/:wid/invitations",
  describeRoute({
    tags: ["invitations"],
    summary: "招待リンクを発行(管理者以上・セッションのみ)。メールは送らず url を返す。同じロールの招待が既にあればそのリンクの期限を延ばし、違うロールなら 409 で断る",
    responses: {
      201: { description: "発行した招待(`extended: true` なら既存のリンクの期限を延ばした)", content: { "application/json": { schema: resolver(InvitationResultSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", InvitationSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "admin");
    const body = c.req.valid("json");
    const db = c.get("db");
    const email = body.email.toLowerCase();
    // 同じ Workspace・同じメール宛ての pending を先に見る。Better Auth 1.4.21 の createInvitation(resend: true)は、
    // **未失効の pending があると新しい招待を作らず expiresAt だけを延ばし、Role は更新しない** —
    // 2 回目に選んだ Role が黙って捨てられるので、Role が違うときはここで断る。
    // 「未失効」の判定は Better Auth 側(adapter の findPendingInvitation が expiresAt > now で絞る)と同じ式にする。
    // 判定と発行の間に別の ADMIN が同じメールを違う Role で招待した場合は、Better Auth 側が先勝ちで期限延長に倒すだけなので受容する
    const pending = await db
      .selectFrom("invitation")
      .select(["id", "role", "expiresAt"])
      .where("organizationId", "=", wid)
      .where(sql<boolean>`lower(email) = ${email}`)
      .where("status", "=", "pending")
      .execute();
    const live = pending.filter((r) => epochMs(r.expiresAt) > Date.now());
    // role は Better Auth 側で null になり得る。null を「違う Role」と見なすと取り消すまで何もできなくなるので、
    // 衝突なし(= Better Auth に任せて期限を延ばす)として扱う
    const conflict = live.find((r) => r.role !== null && r.role !== body.role);
    if (conflict) {
      const role = ROLE_JA[conflict.role!] ?? conflict.role!;
      throw new ApiError(409, "already_invited", {
        role: conflict.role,
        message: `このメールアドレスは既に${role}で招待済みです`,
        hint: "ロールを変えるときは、先にその招待を取り消してから発行し直してください",
      });
    }
    // createInvitation は招待オブジェクト(id / expiresAt)を返す。sendInvitationEmail は no-op(spec §13.3)
    let inv;
    try {
      inv = await c.get("auth").api.createInvitation({
        body: { email, role: body.role, organizationId: wid, resend: true },
        headers: c.req.raw.headers,
      });
    } catch (e) {
      // 招待先のメールが既にこのワークスペースのメンバー。システム管理者はすべてのワークスペースのメンバーなので日常的に起こる。
      // 実測(Better Auth 1.4.21): APIError { status: "BAD_REQUEST", body: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" } }。
      // 他の BAD_REQUEST(ROLE_NOT_FOUND など)を 409 に丸めないよう code まで見る
      const { status, body: errBody } = e as { status?: string; body?: { code?: string } };
      if (status === "BAD_REQUEST" && errBody?.code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") {
        throw new ApiError(409, "already_member", { hint: "このメールアドレスのユーザーは既にこのワークスペースのメンバーです(システム管理者はすべてのワークスペースのメンバーです)" });
      }
      throw e;
    }
    // `extended` は best-effort: control の判定と Better Auth の判定の間のミリ秒で期限が切れると、新規発行なのに
    // true(逆は起こらない)になる。応答の id / url / expiresAt はどちらの経路でも Better Auth が返した本物
    const extended = live.length > 0;
    // 新規に発行したときは、同じ宛先の期限切れの pending を片づける(一覧に期限を出すと死んだ行が並んで見えるため)。
    // 対象は上で読んだ行の ID だけなので、未失効の行や別 Workspace の行には触れない。片づけの失敗で発行は失敗にしない
    const expired = pending.filter((r) => epochMs(r.expiresAt) <= Date.now()).map((r) => r.id);
    if (!extended && expired.length > 0) {
      try {
        await db.updateTable("invitation").set({ status: "canceled" }).where("id", "in", expired).where("status", "=", "pending").execute();
      } catch (e) {
        console.error("failed to tidy away expired invitations", e);
      }
    }
    return c.json({ id: inv.id, url: `${c.env.AB_ADMIN_URL}/invite/${inv.id}`, expiresAt: epochMs(inv.expiresAt), extended }, 201);
  },
);

workspaceRoutes.get(
  "/workspaces/:wid/invitations",
  describeRoute({
    tags: ["invitations"],
    summary: "まだ受けられていない招待の一覧(管理者以上)",
    responses: {
      200: { description: "招待一覧", content: { "application/json": { schema: resolver(z.array(InvitationListSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "admin");
    const rows = await c
      .get("db")
      .selectFrom("invitation")
      .select(["id", "email", "role", "status", "expiresAt"])
      .where("organizationId", "=", wid)
      // 受諾済み・取り消し済みの招待はリンク付きで並べない(期限切れの pending は今までどおり出す)
      .where("status", "=", "pending")
      .orderBy("expiresAt", "desc")
      .execute();
    return c.json(rows.map((r) => ({ ...r, expiresAt: epochMs(r.expiresAt), url: `${c.env.AB_ADMIN_URL}/invite/${r.id}` })));
  },
);

/** backlog B24: 発行した招待を取り消す。Better Auth の cancel-invitation は公開せず、control が 1 文で書き換える */
workspaceRoutes.delete(
  "/workspaces/:wid/invitations/:id",
  describeRoute({
    tags: ["invitations"],
    summary: "招待を取り消す(管理者以上・セッションのみ)。取り消した招待のリンクは使えなくなる",
    responses: { 204: { description: "取り消した" }, ...errorResponses(401, 403, 404) },
  }),
  requireSession,
  async (c) => {
    const { wid, id } = c.req.param();
    await requireWorkspaceRole(c, wid, "admin");
    const db = c.get("db");
    // 別 Workspace の ID・受諾済み・取り消し済み・存在しない、を区別させない(すべて 404)。
    // 取り消した行のメールは returning で同じ 1 文から受ける(読んでから書くと、その間の受諾とすれ違う)
    const upd = await sql<{ email: string }>`update invitation set status = 'canceled'
      where id = ${id} and "organizationId" = ${wid} and status = 'pending' returning email`.execute(db);
    const email = upd.rows[0]?.email;
    if (!email) throw notFound();
    // 招待だけを頼りにログインしていた人のログイン状態を切る(B20)。その user が居なければ何もしない
    await revokeSessionsForEmailIfNoAccess(db, email);
    return c.body(null, 204);
  },
);

/** 招待受諾画面用(認証不要)。メールと Role と Workspace 名だけを返す */
workspaceRoutes.get(
  "/invitations/:id",
  describeRoute({
    tags: ["invitations"],
    summary: "招待の内容(認証不要。受諾画面が表示するぶんだけ)",
    security: [],
    responses: {
      200: { description: "招待の内容", content: { "application/json": { schema: resolver(PublicInvitationSchema) } } },
      ...errorResponses(404),
    },
  }),
  async (c) => {
    const inv = await c
      .get("db")
      .selectFrom("invitation")
      .innerJoin("organization", "organization.id", "invitation.organizationId")
      .select([
        "invitation.id as id",
        "invitation.email as email",
        "invitation.role as role",
        "invitation.status as status",
        "invitation.expiresAt as expiresAt",
        "organization.name as workspaceName",
      ])
      .where("invitation.id", "=", c.req.param("id"))
      .executeTakeFirst();
    if (!inv) throw notFound();
    return c.json({ ...inv, expiresAt: epochMs(inv.expiresAt) });
  },
);

/**
 * 招待の受諾。Bearer が無ければ招待のメールでアカウントを作ってから参加(sign-up ゲートは x-invitation-id で通す)。
 * Bearer があれば既存ユーザーとして参加(Better Auth がメール一致を検証する → 不一致は 403)。
 * body は Bearer 無しのときだけ必須なので、`validator("json", …)`(常に JSON body を要求する)ではなく parseJson で読む
 */
workspaceRoutes.post(
  "/invitations/:id/accept",
  describeRoute({
    tags: ["invitations"],
    summary: "招待を受諾する(API キーは不可)。Bearer あり = ログイン済みのユーザーが参加(通常)。Bearer 無し = アカウント作成 + 参加(パスワードログインが有効なときだけ)",
    security: [],
    // hono-openapi が requestBody を組み立てるのは validator("json", …) からだけなので、
    // ここは自前で宣言する(resolver を解決するのは responses だけ。openapi.ts と同じく z.toJSONSchema で渡す)。
    // 決定 34: 外部エージェントがアカウントを作る唯一の入口なので、body の契約を無言にしない
    requestBody: {
      required: false,
      description: "Bearer 無しのときだけ使う(パスワードログインが有効な導入のみ)。通常は Bearer を付け、body を送らない",
      content: { "application/json": { schema: z.toJSONSchema(AcceptSchema) as Record<string, unknown> } },
    },
    responses: {
      200: { description: "参加した", content: { "application/json": { schema: resolver(AcceptResultSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 410, 422, 429),
    },
  }),
  async (c) => {
    const id = c.req.param("id");
    const auth = c.get("auth");
    const inv = await c.get("db").selectFrom("invitation").selectAll().where("id", "=", id).executeTakeFirst();
    if (!inv) throw notFound();
    if (inv.status !== "pending") throw new ApiError(410, "invitation_used", { status: inv.status });
    if (epochMs(inv.expiresAt) <= Date.now()) throw new ApiError(410, "invitation_expired");
    // Authorization は `Bearer <トークン>` の形だけを受ける(差分レビュー r2 の B1: 値をそのまま使うと、Bearer を付けない鍵が
    // セッションのみの判定をすり抜けて Better Auth に鍵として渡っていた)。形が違えば 401
    const authorization = c.req.header("authorization");
    const bearer = authorization === undefined ? null : /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (authorization !== undefined && !bearer) throw new ApiError(401, "unauthorized");
    let token = bearer?.[1] ?? null;
    if (!token) {
      // 決定 46 (2)(5): 通常は Google でログインしてから Bearer で受ける。パスワードでアカウントを作る口は非常時だけ
      if (!passwordLoginOpen(c.env)) throw new ApiError(401, "unauthorized", { hint: "Google アカウントでログインしてから招待を受けてください" });
      // ブラウザ経由(BFF が Origin をそのまま転送する)なら admin のオリジンと一致していること。Origin 無しは非ブラウザ(エージェント)で通す。
      // この経路は Better Auth の handler を通らず trustedOrigins の照合が働かないので、ここで見る(他サイトの form POST で
      // 被害者のブラウザに攻撃者のアカウントのセッションを張る login CSRF を止める)
      const origin = c.req.header("origin");
      if (origin !== undefined && !sameOrigin(origin, c.env.AB_ADMIN_URL)) {
        throw new ApiError(403, "bad_origin", { message: "この要求の送信元は受け付けられません" });
      }
      const body = await parseJson(c, AcceptSchema);
      let headers: Headers;
      try {
        ({ headers } = await auth.api.signUpEmail({
          body: { email: inv.email, name: body.name, password: body.password },
          headers: new Headers({ "x-invitation-id": id }),
          returnHeaders: true,
        }));
      } catch (e) {
        // 原因を見分ける。D1 障害などを 409 に丸めると、本物の障害が「よくある衝突」に化けて監視に出なくなる
        const { status, body: errBody } = e as { status?: string; body?: { code?: string } };
        // 既に同じメールのアカウントがある。better-call の APIError は message から code を導出するので、
        // UNPROCESSABLE_ENTITY を投げる別の理由(FAILED_TO_CREATE_USER)と取り違えない
        if (status === "UNPROCESSABLE_ENTITY" && errBody?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
          throw new ApiError(409, "account_exists", { hint: "先にログインしてからこの招待を受けてください" });
        }
        // sign-up ゲート(auth.ts hooks.before)が弾いた = この招待が並行して使われた / 失効した
        if (status === "FORBIDDEN") throw new ApiError(410, "invitation_used", { hint: "招待が既に使われたか失効しています" });
        throw e; // それ以外(D1 障害など)は 5xx のまま上げてサーバー側に記録する
      }
      token = headers.get("set-auth-token");
      if (!token) throw new ApiError(500, "no_session_token");
    }
    // K16: 既にこのワークスペースのメンバーなら断る(Better Auth の受諾は既存の Member を確かめずに行を足す。
    // システム管理者への昇格と受諾がすれ違うと重複するため。それでも抜けた重複は member の UNIQUE 索引が止める)
    const who = await auth.api.getSession({ headers: bearerHeaders(token) });
    if (who) {
      const already = await c.get("db").selectFrom("member").select("id").where("organizationId", "=", inv.organizationId).where("userId", "=", who.user.id).executeTakeFirst();
      if (already) throw new ApiError(409, "already_member", { hint: "このワークスペースには既に参加しています。招待は使わずにそのままログインしてください" });
    }
    // 所属が増える前に、それまでに発行された再設定リンクを消す(レビュー r1 CX-High-1)。受諾の中で新しく発行された token は下の 2 回目で消す
    if (who) await invalidateResetLinks(c.get("db"), who.user.id);
    try {
      await auth.api.acceptInvitation({ body: { invitationId: id }, headers: bearerHeaders(token) });
    } catch (e) {
      // K16 / r2 CX-High-3: 上の事前チェックの後に昇格が入ると、Better Auth の Member の INSERT が UNIQUE 索引で失敗する。
      // 500 にせず 409 にする。招待は Better Auth が先に accepted にしており、その人は実際にメンバーなのでそのまま残す。
      // 実測: Better Auth は D1 の例外を包まず、素の Error("D1_ERROR: UNIQUE constraint failed: member.organizationId, member.userId: …")
      // (cause に同じ内容の Error)が上がってくる。message と cause の連鎖を見て、member 表の UNIQUE 違反だけを拾う(それ以外は下で今までどおり上げる)
      if (isMemberUniqueViolation(e)) {
        throw new ApiError(409, "already_member", { hint: "このワークスペースには既に参加しています。招待は使わずにそのままログインしてください" });
      }
      const status = (e as { status?: string }).status;
      if (status === "UNAUTHORIZED") throw new ApiError(401, "unauthorized");
      if (status === "FORBIDDEN" || status === "BAD_REQUEST") throw new ApiError(403, "invitation_email_mismatch");
      throw e;
    }
    // 受諾と同時に発行された token を消す。ここの delete が D1 障害で失敗した場合だけ、受諾済みの所属と有効な token が残る(P14 の残余)
    if (who) await invalidateResetLinks(c.get("db"), who.user.id);
    return c.json({ token, workspaceId: inv.organizationId, userId: who?.user.id ?? null });
  },
);

/** spec §13.3: パスワードリセットは OWNER / ADMIN がリンクを発行して本人に渡す(メール送信基盤を持たない) */
workspaceRoutes.post(
  "/workspaces/:wid/members/:memberId/reset-link",
  describeRoute({
    tags: ["members"],
    summary: "メンバーのパスワード再設定リンクを発行(管理者以上・セッションのみ。パスワードログインが有効なときだけ)。発行先のワークスペースで管理者以上の人が、発行先だけに所属する人か自分自身に発行できる。対象が他のワークスペースにも所属するときは、そのすべてでオーナーの人かシステム管理者だけが発行できる。オーナー宛はオーナーのみ、システム管理者宛てはシステム管理者のみ",
    responses: {
      200: { description: "再設定リンク", content: { "application/json": { schema: resolver(ResetLinkSchema) } } },
      ...errorResponses(401, 403, 404, 409, 500),
    },
  }),
  requireSession,
  async (c) => {
    const { wid, memberId } = c.req.param();
    const me = await requireWorkspaceRole(c, wid, "admin");
    const db = c.get("db");
    const target = await db
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select(["user.id as userId", "user.email as email", "member.role as role"])
      .where("member.id", "=", memberId)
      .where("member.organizationId", "=", wid)
      .executeTakeFirst();
    if (!target) throw notFound();
    // OWNER のリセットリンクを発行できるのは OWNER だけ(ADMIN による乗っ取り経路を塞ぐ)
    assertCanTouchOwner(me, target.role);
    await assertCanTouchInstanceAdmin(c, target.userId);
    await assertCanResetMember(c, wid, target.userId);
    if (!passwordLoginOpen(c.env)) throw new ApiError(409, "password_login_disabled", { hint: PASSWORD_LOGIN_DISABLED_HINT });
    const url = await issueResetUrl(c, target.email);
    // K9 (2) / r2 CX-High-6: 発行の直後に読み直す。事前の判定の後に対象がシステム管理者へ昇格していたら、発行した token を消して断る
    // (Better Auth の token の作成には条件を入れられない。この読み直しの後に昇格が入った場合は、昇格の batch が token を消す)
    try {
      await assertCanTouchInstanceAdmin(c, target.userId);
      await assertCanResetMember(c, wid, target.userId); // 発行の読み取りと他所の受諾が交錯した場合(レビュー r1 CX-High-1)
      // 最終レビュー: 事前の assertCanTouchOwner の後に、OWNER が対象をこのワークスペースで owner へ昇格した場合も同じ型の交錯。
      // 昇格の batch は、その時点にある token しか消せない。外されていた(行が無い)場合は権限が減るだけなので通す
      const now = await db.selectFrom("member").select("role").where("id", "=", memberId).where("organizationId", "=", wid).executeTakeFirst();
      assertCanTouchOwner(me, now?.role);
    } catch (e) {
      const token = new URL(url).searchParams.get("token");
      if (token) await sql`delete from verification where identifier = ${`reset-password:${token}`}`.execute(db);
      throw e;
    }
    // 発行の記録(URL・メールは書かない)。管理画面の発行結果カード以外に痕跡が残らなかったので足す
    console.log("reset link issued", JSON.stringify({ by: c.get("user").id, target: target.userId, workspace: wid }));
    return c.json({ url });
  },
);
