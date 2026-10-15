import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { keyExpiresAt, unusableSince } from "../api-key-expiry";
import { requireSession, type AppEnv } from "../app";
import { API_KEY_PREFIX, ROLES } from "../auth";
import type { Db } from "../db";
import { ApiError, validationFailed } from "../errors";
import { errorResponses } from "../openapi";
import {
  assertCanIssueKey,
  assertCanTouchInstanceAdmin,
  assertCanTouchOwner,
  keyBelongsToWorkspace,
  keyScopeFromMetadata,
  requireWorkspaceRole,
  roleCapFromMetadata,
  type KeyScope,
} from "../roles";

/** 鍵の権限の上限。OWNER 相当の上限は「上限なし」と同じなので選べない(null で表す) */
const RoleCapSchema = z.enum(["viewer", "editor", "admin"]).nullable().describe("鍵の権限。null = 鍵の持ち主のロールと同じ。実際の権限は、ワークスペースごとのロールと鍵の権限(`roleCap`)の低い方");
const CreateBody = z.strictObject({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(365).optional().describe("有効期限(日数。1〜365)。省略 = 期限なし。期限を過ぎた鍵は 401"),
  workspaceId: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "鍵の範囲(必須)。ワークスペースの ID = そのワークスペースだけで使える鍵(そのワークスペースのメンバーなら発行できる。非メンバーは 404)/ null = すべてのワークスペース(`full`。システム管理者だけが発行・使用でき、それ以外は 403)",
    ),
  roleCap: RoleCapSchema.optional().describe(
    "鍵の権限(`roleCap`)。省略 / null = 持ち主のロールと同じ。ワークスペースの鍵はそのワークスペースでのロール、「すべてのワークスペース」の鍵は持ち主が持つ最高位のロールと同等かそれ以下だけ選べる(超えると 400 role_cap_too_high)",
  ),
});

/** B42: 鍵の範囲の表し方(発行の応答・自分の一覧・メンバーの鍵の一覧で共通) */
const ScopeFields = {
  scope: z.enum(["full", "workspace"]).nullable().describe("鍵の範囲。full = すべてのワークスペース / workspace = workspace の 1 つだけ / null = 範囲を持たない古い鍵(使えない。発行し直す)"),
  workspace: z
    .object({ id: z.string(), name: z.string().nullable().describe("ワークスペースの名前。削除済みなら null(その鍵は使えない)") })
    .nullable()
    .describe("scope が workspace のときの範囲のワークスペース。それ以外は null"),
};

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prefix: z.string().nullable(),
  roleCap: RoleCapSchema,
  createdAt: z.number().describe("epoch ミリ秒"),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z
    .number()
    .nullable()
    .describe("失効した時刻(epoch ミリ秒)。有効な鍵は null。使えなくなってから(失効か期限切れの早い方)30 日で一覧から消える"),
  ...ScopeFields,
});
const CreatedApiKeySchema = z.object({
  id: z.string(),
  key: z.string().describe("平文はこの応答限り。保存も再表示もしない"),
  name: z.string().nullable(),
  roleCap: RoleCapSchema,
  expiresAt: z.number().nullable(),
  ...ScopeFields,
});

/** 管理者向け一覧の 1 行 = 自分の一覧の形 + 所有者(Workspace での Role 付き) */
const WorkspaceApiKeySchema = ApiKeySchema.extend({
  owner: z.object({
    userId: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.enum(ROLES).describe("所有者のこのワークスペースでのロール"),
    instanceAdmin: z.boolean().describe("所有者がシステム管理者か。システム管理者の鍵を失効できるのはシステム管理者だけ"),
  }),
});

/** createApiKey が返す metadata は enableMetadata でパース済みのオブジェクト(無ければ null)。文字列で来ても読めるようにする */
const metadataText = (metadata: unknown): string | null => (metadata == null ? null : typeof metadata === "string" ? metadata : JSON.stringify(metadata));

/** ワークスペースの ID → 名前(削除済みは入らない) */
async function workspaceNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.selectFrom("organization").select(["id", "name"]).where("id", "in", unique).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** B42: 範囲を応答の形にする(`names` に無いワークスペース = 削除済み → name は null) */
const scopeView = (scope: KeyScope | null, names: Map<string, string>) => ({
  scope: scope?.kind ?? null,
  workspace: scope?.kind === "workspace" ? { id: scope.workspaceId, name: names.get(scope.workspaceId) ?? null } : null,
});

/** 時刻は epoch ミリ秒(Global Constraints) */
const epochMs = (v: string | number | Date | null | undefined): number | null => (v == null ? null : new Date(v).getTime());

/**
 * B14: 失効した鍵は 30 日間「失効済み」として一覧に残し、その後は一覧の取得時に消す(Cron を持たないための遅延削除)。
 * B43: 起点は「使えなくなった時刻」= 失効か期限切れの早い方(unusableSince)
 */
const REVOKED_RETENTION_MS = 30 * 86_400_000;

/** B43: 一覧に残す期間を過ぎたか(使えなくなってから 30 日。期限は metadata の JSON の中なので SQL ではなくここで判定する) */
const pastRetention = (revokedAt: number | null, expiresAt: number | null | "invalid", now: number): boolean => {
  const since = unusableSince(revokedAt, expiresAt, now);
  return since !== null && now - since > REVOKED_RETENTION_MS;
};

/** 一覧の応答の expiresAt。読めない期限("invalid")の鍵は入口で 401 になるが、一覧では時刻を出せないので null */
const expiresAtView = (expiresAt: number | null | "invalid"): number | null => (expiresAt === "invalid" ? null : expiresAt);

export const apiKeyRoutes = new Hono<AppEnv>();
apiKeyRoutes.use("/me/api-keys/*", requireSession);
apiKeyRoutes.use("/me/api-keys", requireSession);
// 鍵の管理はすべてセッションのみ(鍵で鍵を管理させない = 決定 48)。宣言は session-only.ts(brief K17)

/**
 * 自分の鍵の一覧。Better Auth の一覧(listApiKeys)ではなく D1 を直接読む:
 * - 失効の正は apikey_revocations(brief K15。apikey.enabled は鍵の検証の書き戻しで戻りうる)
 * - metadata を認証側(requireSession)・メンバーの鍵の一覧と同じ生の値・同じ関数で読む(Better Auth の一覧は metadata を正規化して書き戻す)
 */
apiKeyRoutes.get(
  "/me/api-keys",
  describeRoute({
    tags: ["api-keys"],
    summary: "自分の API キー一覧(平文は含まない。セッションのみ)",
    responses: {
      200: { description: "API キー一覧", content: { "application/json": { schema: resolver(z.array(ApiKeySchema)) } } },
      ...errorResponses(401, 403),
    },
  }),
  async (c) => {
    const db = c.get("db");
    const userId = c.get("user").id;
    const now = Date.now();
    const rows = await db
      .selectFrom("apikey")
      .leftJoin("apikey_revocations", "apikey_revocations.key_id", "apikey.id")
      .select([
        "apikey.id as id",
        "apikey.name as name",
        "apikey.prefix as prefix",
        "apikey.metadata as metadata",
        "apikey.createdAt as createdAt",
        "apikey.expiresAt as expiresAt",
        "apikey.lastRequest as lastRequest",
        "apikey_revocations.revoked_at as revokedAt",
      ])
      .where("apikey.userId", "=", userId)
      .orderBy("apikey.createdAt")
      .orderBy("apikey.id")
      .execute();
    const withExpiry = rows.map((k) => ({ ...k, expiry: keyExpiresAt(k.metadata, epochMs(k.expiresAt)) }));
    const gone = (k: (typeof withExpiry)[number]) => pastRetention(k.revokedAt ?? null, k.expiry, now);
    // 使えなくなってから 30 日を過ぎた鍵を消す(失効の行は FK の CASCADE で消える)。掃除に失敗しても一覧は返す(次の取得でまた試みる)。
    // 表示の期間は下の filter で別に守る(掃除の成否に依らない。差分レビュー r2 の B3)
    const purge = withExpiry.filter(gone).map((k) => k.id);
    // D1 のバインド変数の上限(100)に当たらないよう 90 件ずつ
    for (let i = 0; i < purge.length; i += 90) {
      const ids = purge.slice(i, i + 90);
      await c.env.DB.prepare(`delete from apikey where userId = ?1 and id in (${ids.map((_, j) => `?${j + 2}`).join(", ")})`)
        .bind(userId, ...ids)
        .run()
        .catch((e) => console.error("api key purge failed", e));
    }
    const visible = withExpiry.filter((k) => !gone(k));
    const scopes = new Map(visible.map((k) => [k.id, keyScopeFromMetadata(k.metadata)]));
    const names = await workspaceNames(db, [...scopes.values()].flatMap((s) => (s?.kind === "workspace" ? [s.workspaceId] : [])));
    return c.json(
      visible.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        roleCap: roleCapFromMetadata(k.metadata),
        createdAt: epochMs(k.createdAt),
        expiresAt: expiresAtView(k.expiry),
        lastUsedAt: epochMs(k.lastRequest),
        revokedAt: k.revokedAt ?? null,
        ...scopeView(scopes.get(k.id) ?? null, names),
      })),
    );
  },
);

apiKeyRoutes.post(
  "/me/api-keys",
  describeRoute({
    tags: ["api-keys"],
    summary: `API キーを発行(平文はこの応答限り。接頭辞 ${API_KEY_PREFIX}。セッションのみ)`,
    responses: {
      201: { description: "発行した API キー", content: { "application/json": { schema: resolver(CreatedApiKeySchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  validator("json", CreateBody, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const body = c.req.valid("json");
    const roleCap = body.roleCap ?? null;
    // B42 / B33: 範囲と上限の可否は roles.ts(フルはシステム管理者だけ・ワークスペースはメンバーだけ・上限はその範囲での Role 以下)
    await assertCanIssueKey(c, body.workspaceId, roleCap);
    // B42: 範囲は必ず書く(`scope` の無い鍵は使えない = fail-closed。将来 metadata にキーを足しても範囲なしに化けない)
    const scope: KeyScope = body.workspaceId === null ? { kind: "full" } : { kind: "workspace", workspaceId: body.workspaceId };
    // B43: 期限は metadata に書き、Better Auth には渡さない(expiresIn を渡すと、期限切れの鍵が失効の記録ごと Better Auth に物理削除される)。
    // 期限なしでも expiresAt: null を必ず書く(キーが無い = B43 より前の鍵 = Better Auth の列を見る、と区別する)
    const expiresAt = body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null;
    const metadata = {
      ...(scope.kind === "full" ? { scope: "full" } : { scope: "workspace", workspaceId: scope.workspaceId }),
      ...(roleCap ? { roleCap } : {}),
      expiresAt,
    };
    const k = await c.get("auth").api.createApiKey({
      body: { name: body.name, metadata },
      headers: c.req.raw.headers,
    });
    const names = await workspaceNames(c.get("db"), scope.kind === "workspace" ? [scope.workspaceId] : []);
    return c.json({ id: k.id, key: k.key, name: k.name, roleCap: roleCapFromMetadata(metadataText(k.metadata)), expiresAt, ...scopeView(scope, names) }, 201);
  },
);

apiKeyRoutes.delete(
  "/me/api-keys/:kid",
  describeRoute({
    tags: ["api-keys"],
    summary: "API キーを失効(自分の鍵のみ。他人の鍵は 404。セッションのみ)。失効した鍵は 30 日間、一覧に失効済みとして残る",
    responses: { 204: { description: "失効した" }, ...errorResponses(401, 403, 404) },
  }),
  async (c) => {
    const kid = c.req.param("kid");
    const userId = c.get("user").id;
    // brief K15: 失効の正は apikey_revocations(Better Auth の鍵の検証は行を丸ごと書き戻すので、enabled だけでは失効が消えうる)。
    // 所有者の確認と「まだ失効していない」は INSERT の条件で行う(他人の鍵・失効済みの鍵は存在を漏らさない 404)。enabled = 0 も書く
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(
        `insert into apikey_revocations (key_id, revoked_at, revoked_by)
         select id, ?1, ?2 from apikey where id = ?3 and userId = ?2 and not exists (select 1 from apikey_revocations where key_id = ?3)`,
      ).bind(Date.now(), userId, kid),
      c.env.DB.prepare(`update apikey set enabled = 0 where id = ?1 and exists (select 1 from apikey_revocations where key_id = ?1)`).bind(kid),
    ]);
    if (!inserted?.meta.changes) throw new ApiError(404, "not_found");
    return c.body(null, 204);
  },
);

/**
 * B33 / 決定 48 (8): 管理者向け。この Workspace で使える鍵を所有者付きで一覧する(ADMIN 以上、セッションのみ)。
 * B42: このワークスペースの鍵 + 持ち主がいまシステム管理者であるフルの鍵(brief K10)。
 * 失効済み・期限切れは自分の一覧と同じく使えなくなってから 30 日間だけ並べる(掃除は自分の一覧側が行うので、ここでは絞るだけ)
 */
apiKeyRoutes.get(
  "/workspaces/:wid/api-keys",
  describeRoute({
    tags: ["api-keys"],
    summary: "ワークスペースのメンバーの API キーの一覧(管理者以上・セッションのみ。平文は含まない)。このワークスペースの鍵と、システム管理者の「すべてのワークスペース」の鍵",
    responses: {
      200: { description: "メンバーの API キー一覧(所有者付き)", content: { "application/json": { schema: resolver(z.array(WorkspaceApiKeySchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const wid = c.req.param("wid");
    await requireWorkspaceRole(c, wid, "admin");
    const rows = await c
      .get("db")
      .selectFrom("apikey")
      .innerJoin("member", "member.userId", "apikey.userId")
      .innerJoin("user", "user.id", "apikey.userId")
      .leftJoin("instance_admins", "instance_admins.user_id", "apikey.userId")
      .leftJoin("apikey_revocations", "apikey_revocations.key_id", "apikey.id")
      .select([
        "apikey.id as id",
        "apikey.name as name",
        "apikey.prefix as prefix",
        "apikey.metadata as metadata",
        "apikey.createdAt as createdAt",
        "apikey.expiresAt as expiresAt",
        "apikey.lastRequest as lastRequest",
        "apikey_revocations.revoked_at as revokedAt",
        "user.id as userId",
        "user.email as email",
        "user.name as userName",
        "member.role as role",
        "instance_admins.user_id as instanceAdminId",
      ])
      .where("member.organizationId", "=", wid)
      .orderBy("user.email")
      .orderBy("apikey.createdAt")
      .execute();
    const now = Date.now();
    const names = await workspaceNames(c.get("db"), [wid]);
    return c.json(
      rows
        .map((k) => ({ ...k, scope: keyScopeFromMetadata(k.metadata) }))
        // B42: このワークスペースの鍵 + システム管理者のフルの鍵だけ(他のワークスペース向けの鍵は、ここの管理者の関心の外)
        .filter((k) => keyBelongsToWorkspace(k.scope, wid, k.instanceAdminId != null))
        .map((k) => ({ ...k, expiry: keyExpiresAt(k.metadata, epochMs(k.expiresAt)) }))
        // B43: 自分の一覧と同じく、使えなくなってから(失効か期限切れの早い方)30 日だけ並べる
        .filter((k) => !pastRetention(k.revokedAt ?? null, k.expiry, now))
        .map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          roleCap: roleCapFromMetadata(k.metadata),
          createdAt: epochMs(k.createdAt),
          expiresAt: expiresAtView(k.expiry),
          lastUsedAt: epochMs(k.lastRequest),
          revokedAt: k.revokedAt ?? null,
          owner: { userId: k.userId, email: k.email, name: k.userName, role: k.role, instanceAdmin: k.instanceAdminId != null },
          ...scopeView(k.scope, names),
        })),
    );
  },
);

/**
 * 管理者による失効(ADMIN 以上、セッションのみ)。対象は一覧と同じ集合(それ以外は 404)。
 * ADMIN は OWNER の鍵に触れない(`assertCanTouchOwner`)。システム管理者の鍵はシステム管理者だけ(決定 53 (9))
 */
apiKeyRoutes.delete(
  "/workspaces/:wid/api-keys/:kid",
  describeRoute({
    tags: ["api-keys"],
    summary:
      "ワークスペースのメンバーの API キーを失効(管理者以上・セッションのみ。オーナーの鍵はオーナーのみ)。対象は一覧と同じ(このワークスペースの鍵と、システム管理者の「すべてのワークスペース」の鍵。それ以外は 404)。システム管理者の鍵は、システム管理者のみ",
    responses: { 204: { description: "失効した" }, ...errorResponses(401, 403, 404) },
  }),
  requireSession,
  async (c) => {
    const { wid, kid } = c.req.param();
    const me = await requireWorkspaceRole(c, wid, "admin");
    const db = c.get("db");
    const findTarget = () =>
      db
        .selectFrom("apikey")
        .innerJoin("member", "member.userId", "apikey.userId")
        .leftJoin("instance_admins", "instance_admins.user_id", "apikey.userId")
        .leftJoin("apikey_revocations", "apikey_revocations.key_id", "apikey.id")
        .select(["apikey.userId as userId", "apikey.metadata as metadata", "member.role as role", "instance_admins.user_id as instanceAdminId", "apikey_revocations.key_id as revokedId"])
        .where("apikey.id", "=", kid)
        .where("member.organizationId", "=", wid)
        .executeTakeFirst();
    const target = await findTarget();
    // この Workspace の Member の鍵でない・一覧に入らない鍵(B42: 他のワークスペース向け)・失効済みは存在を漏らさない(404)
    if (!target || target.revokedId != null || !keyBelongsToWorkspace(keyScopeFromMetadata(target.metadata), wid, target.instanceAdminId != null)) {
      throw new ApiError(404, "not_found");
    }
    assertCanTouchOwner(me, target.role);
    await assertCanTouchInstanceAdmin(c, target.userId);
    // brief K18 / 差分レビュー r1 の CX-H3: 事前の判定の後に状態が変わっても誤って失効しないよう、認可の条件をすべて文に入れる
    // (対象がいまこのワークスペースのメンバー・呼ぶ人がいま ADMIN 以上・呼ぶ人が OWNER でなければ対象が OWNER でない・
    // 呼ぶ人がシステム管理者でなければ対象がシステム管理者でない・まだ失効していない)。失効の正は apikey_revocations(K15)
    const actor = c.get("user").id;
    const [inserted] = await c.env.DB.batch([
      c.env.DB.prepare(
        `insert into apikey_revocations (key_id, revoked_at, revoked_by)
         select a.id, ?1, ?2 from apikey a
         where a.id = ?3
           and not exists (select 1 from apikey_revocations r where r.key_id = a.id)
           and exists (select 1 from member t where t."organizationId" = ?4 and t."userId" = a.userId)
           and exists (select 1 from member m where m."organizationId" = ?4 and m."userId" = ?2 and m.role in ('owner', 'admin'))
           and (exists (select 1 from member m where m."organizationId" = ?4 and m."userId" = ?2 and m.role = 'owner')
                or not exists (select 1 from member t where t."organizationId" = ?4 and t."userId" = a.userId and t.role = 'owner'))
           and (exists (select 1 from instance_admins where user_id = ?2)
                or not exists (select 1 from instance_admins where user_id = a.userId))`,
      ).bind(Date.now(), actor, kid, wid),
      c.env.DB.prepare(`update apikey set enabled = 0 where id = ?1 and exists (select 1 from apikey_revocations where key_id = ?1)`).bind(kid),
    ]);
    if (!inserted?.meta.changes) {
      // 判定の後に状態が変わった。今の状態で理由を出し直す(対象が OWNER / システム管理者になった = 403、それ以外 = 404)
      const latest = await findTarget();
      if (latest && latest.revokedId == null) {
        assertCanTouchOwner(await requireWorkspaceRole(c, wid, "admin"), latest.role);
        await assertCanTouchInstanceAdmin(c, latest.userId);
      }
      throw new ApiError(404, "not_found");
    }
    return c.body(null, 204);
  },
);
