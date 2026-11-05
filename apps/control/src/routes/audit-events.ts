import { Hono, type Context } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_TARGET_TYPES, AUDIT_VIAS } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import {
  AUDIT_PAGE_MAX,
  auditHistoryQuery,
  auditListQuery,
  auditPageJson,
  auditRange,
  decodeAuditCursor,
  experimentPeopleQuery,
  personJson,
  type AuditListScope,
  type AuditReadRow,
  type AuditView,
  type ExperimentPeopleRow,
} from "../audit-read";
import { sqlStatement } from "../db";
import { notFound, validationFailed } from "../errors";
import { errorResponses } from "../openapi";
import { atLeast, loadSite, requireInstanceAdmin, requireWorkspaceRole } from "../roles";

/**
 * B129(spec §6): 操作の記録を読む API 3 本(すべて GET。API キーでも読める。書き込みではないので session-only.ts には足さない)。
 * - `GET /sites/:sid/experiments/:eid/history`(変更履歴。閲覧者以上): 認証・loadSite の後に、履歴と作った人の 2 本を並べて投げる(D1 の往復は直列で +1)
 * - `GET /workspaces/:wid/audit-events`(ワークスペースの記録。管理者以上): 認証・requireWorkspaceRole の後に 1 本
 * - `GET /audit-events`(導入全体の記録。システム管理者・上限なしのすべてのワークスペースの鍵): 認証・requireInstanceAdmin の後に 1 本
 * 読む部品・索引・メールの出し分けは audit-read.ts
 */
export const auditEventRoutes = new Hono<AppEnv>();

const ACTOR_DESC =
  "操作した人(非常用トークン・定期処理の操作は null)。name は記録した時点の名前(空ならメールアドレスの @ より前)。email は記録した時点のメールアドレスで、呼び出しのロールが管理者以上のときだけ入る(編集者・閲覧者、上限が編集者・閲覧者の API キー、その人が消えているときは null)";
const PersonSchema = z.object({
  userId: z.string(),
  name: z.string().nullable().describe("今の名前(空ならメールアドレスの @ より前)。その人が消えていれば null"),
  email: z.string().nullable().describe("今のメールアドレス。呼び出しのロールが管理者以上のときだけ入る(編集者・閲覧者と、その人が消えているときは null)"),
});

const AuditEventSchema = z.object({
  id: z.string().describe("記録の ID(整数を文字列にしたもの。新しい記録ほど大きい)"),
  at: z.number().describe("操作の時刻(epoch ミリ秒)"),
  category: z.enum(AUDIT_CATEGORIES).describe("access = 人とアクセス権・導入の設定 / content = サイト・エクスペリエンス・目標・オーディエンス・公開"),
  action: z
    .enum(AUDIT_ACTIONS)
    .describe(
      "操作。invitation.*(招待の発行・取り消し・受諾)・member.*(ロールの変更・メンバーから外す・パスワード再設定リンクの発行)・instance_admin.*(システム管理者にする・外す)・api_key.*(API キーの発行・自分の鍵の失効・メンバーの鍵の失効)・workspace.*(作成・削除)・setup.complete(初期設定)・usage.settings_change(使用状況の設定)・static.rebuild(すべてのサイトの配信ファイルの作り直し)・break_glass.*(非常用トークンでの再設定リンクの発行・パスワードのログインを閉じた後の掃除)・auth.password_login(パスワードのログイン)・site.*・experiment.*・goal.*・audience.*・asset.upload・publish.*(公開・配信ファイルの作り直し)",
    ),
  workspaceId: z.string().nullable().describe("操作のワークスペース。導入全体の操作(システム管理者・使用状況の設定・非常用トークン・パスワードのログイン)は null"),
  siteId: z.string().nullable().describe("操作のサイト(サイト・エクスペリエンス・目標・オーディエンス・画像・公開の操作)。人とアクセス権・ワークスペース・導入全体の操作は null"),
  experimentId: z.string().nullable().describe("エクスペリエンスの操作(experiment.*)だけ"),
  via: z
    .enum(AUDIT_VIAS)
    .describe(
      "操作した要求の認証の形。google / password = そのログインで作ったセッション、unknown = ログインの方法の分からないセッション、api_key = API キー、break_glass = 非常用トークン、setup = 初期設定のトークン、system = 定期処理",
    ),
  actor: z.object({ userId: z.string(), email: z.string().nullable(), name: z.string().nullable() }).nullable().describe(ACTOR_DESC),
  apiKey: z.object({ id: z.string(), name: z.string().nullable().describe("記録した時点の鍵の名前") }).nullable().describe("API キーからの操作のとき、その鍵。それ以外は null"),
  target: z
    .object({
      type: z.enum(AUDIT_TARGET_TYPES),
      id: z.string().nullable().describe("対象の ID(API キーの発行の受け付けの行は null)。API キーからの呼び出しでは、招待(type = invitation)の ID は null"),
      label: z
        .string()
        .nullable()
        .describe("記録した時点の対象の名前(人と招待はメールアドレス。呼び出しのロールが管理者未満のときは @ より前だけ)"),
    })
    .nullable(),
  detail: z
    .record(z.string(), z.unknown())
    .describe("操作の要約(前後の値・件数・変えた項目の名前など。2,048 バイトを超えたものは {truncated: true})。outcome = failed は操作を試みたが失敗した行。呼び出しのロールが管理者未満のときは、メールアドレスの値を null にする"),
});
const InstanceAuditEventSchema = AuditEventSchema.extend({
  workspaceName: z.string().nullable().describe("今のワークスペースの名前(消えたワークスペースと、導入全体の操作は null)"),
});

const pageFields = {
  events: z.array(AuditEventSchema).describe("新しい順(最大 100 件)"),
  nextCursor: z.string().nullable().describe("続きがあるとき、次のページを読む cursor の値。最後のページは null"),
};
const PageSchema = z.object(pageFields);
const InstancePageSchema = z.object({ ...pageFields, events: z.array(InstanceAuditEventSchema).describe("新しい順(最大 100 件)") });
const HistorySchema = z.object({
  ...pageFields,
  createdBy: PersonSchema.describe("エクスペリエンスを作った人(記録を始める前に作られたエクスペリエンスでも入る)"),
  updatedBy: PersonSchema.describe("エクスペリエンスを最後に変えた人"),
});

const cursorField = z
  .string()
  .refine((s) => decodeAuditCursor(s) !== null, { message: "cursor が読めません。前の応答の nextCursor をそのまま渡してください" })
  .optional()
  .describe("前の応答の nextCursor。省略 = 最初のページ");
const limitField = z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional().describe(`1 回に返す件数(1〜${AUDIT_PAGE_MAX}。省略 = ${AUDIT_PAGE_MAX})`);
const epochField = (desc: string) => z.coerce.number().int().min(0).optional().describe(desc);
const listFields = {
  since: epochField("この時刻以後の記録(epoch ミリ秒)。省略 = 30 日前。365 日より前は 365 日前にする(記録は 365 日で消える)"),
  until: epochField("この時刻以前の記録(epoch ミリ秒)。省略 = 今。パスワードのログインを開いていた期間などで絞るときに使う"),
  category: z.enum(AUDIT_CATEGORIES).optional().describe("access = 人とアクセス権・導入の設定だけ / content = サイト・エクスペリエンスなどだけ。省略 = すべて"),
  elevated: z.enum(["true", "false"]).optional().describe("true = 経路が password か break_glass の記録だけ(パスワードのログイン・非常用トークンの後の確かめ)"),
  limit: limitField,
  cursor: cursorField,
};
const WorkspaceListQuery = z.object(listFields);
const InstanceListQuery = z.object({
  ...listFields,
  workspaceId: z.string().min(1).optional().describe("このワークスペースの記録だけ。none = 導入全体の操作(ワークスペースに属さない記録)だけ。省略 = すべて"),
});
const HistoryQuery = z.object({ limit: limitField, cursor: cursorField });

const queryValidator = <T extends z.ZodType>(schema: T) =>
  validator("query", schema, (r) => {
    if (!r.success) throw validationFailed(r.error);
  });

/** API キーの呼び出し(keyScope が null でない)。招待の ID を出さない(招待の一覧と同じ判定) */
const viaKey = (c: Context<AppEnv>) => c.get("keyScope") !== null;

type ListQuery = z.infer<typeof WorkspaceListQuery>;
async function listPage(c: Context<AppEnv>, scope: AuditListScope, q: ListQuery, view: AuditView) {
  const limit = q.limit ?? AUDIT_PAGE_MAX;
  const filter = {
    ...auditRange(q),
    ...(q.category ? { category: q.category } : {}),
    elevated: q.elevated === "true",
    cursor: q.cursor ? decodeAuditCursor(q.cursor) : null,
    limit,
  };
  const { results } = await sqlStatement(c.env.DB, auditListQuery(scope, filter)).all<AuditReadRow>();
  return auditPageJson(results, limit, view);
}

auditEventRoutes.get(
  "/sites/:sid/experiments/:eid/history",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスの変更履歴(閲覧者以上)。このエクスペリエンスの操作の記録を新しい順に 100 件ずつ返す",
    description:
      "同じ ID で作り直したエクスペリエンス・サイトの、前の記録は含まない(消えたエクスペリエンスの記録は、管理者がワークスペースの記録で読む)。変更の中身(HTML・CSS・JS)の違いは残らない。記録は 365 日で消える。続きは nextCursor を cursor に渡して読む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "変更履歴", content: { "application/json": { schema: resolver(HistorySchema) } } },
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  queryValidator(HistoryQuery),
  async (c) => {
    const { site, role } = await loadSite(c, c.req.param("sid"), "viewer");
    const eid = c.req.param("eid");
    const q = c.req.valid("query");
    const limit = q.limit ?? AUDIT_PAGE_MAX;
    // 履歴の文はエクスペリエンスの今の世代を自分で読むので、作った人の照会と並べて投げる(spec §10.2)。
    // Kysely(c.get("db"))は SQLite の adapter で接続の mutex を掛け、Promise.all でも 1 本ずつ流すので、D1 の binding で直接投げる
    const [history, people] = await Promise.all([
      sqlStatement(c.env.DB, auditHistoryQuery(site, eid, { cursor: q.cursor ? decodeAuditCursor(q.cursor) : null, limit })).all<AuditReadRow>(),
      sqlStatement(c.env.DB, experimentPeopleQuery(site.id, eid)).all<ExperimentPeopleRow>(),
    ]);
    const p = people.results[0];
    if (!p) throw notFound();
    const view: AuditView = { showEmail: atLeast(role, "admin"), hideInvitationIds: viaKey(c) };
    return c.json({
      ...auditPageJson(history.results, limit, view),
      createdBy: personJson(p.created_by, p.created_name, p.created_email, view),
      updatedBy: personJson(p.updated_by, p.updated_name, p.updated_email, view),
    });
  },
);

auditEventRoutes.get(
  "/workspaces/:wid/audit-events",
  describeRoute({
    tags: ["operation-log"],
    summary: "ワークスペースの操作の記録(管理者以上)。人とアクセス権の操作と、サイト・エクスペリエンスなどの変更を新しい順に 100 件ずつ返す",
    description:
      "API キーで読めるのは、このワークスペースの鍵とすべてのワークスペースの鍵のうち、持ち主のロールが管理者以上のもの(鍵にロールの上限があるときは、その上限も管理者以上のもの)だけ。範囲は since・until(既定は 30 日前から今)。記録は 365 日で消える。続きは nextCursor を cursor に渡して読む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "操作の記録", content: { "application/json": { schema: resolver(PageSchema) } } },
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  queryValidator(WorkspaceListQuery),
  async (c) => {
    const wid = c.req.param("wid");
    const role = await requireWorkspaceRole(c, wid, "admin");
    return c.json(await listPage(c, { kind: "workspace", workspaceId: wid }, c.req.valid("query"), { showEmail: atLeast(role, "admin"), hideInvitationIds: viaKey(c) }));
  },
);

auditEventRoutes.get(
  "/audit-events",
  describeRoute({
    tags: ["operation-log"],
    summary: "導入全体の操作の記録(システム管理者のみ。API キーは、権限の指定の無いすべてのワークスペースの鍵だけ)。すべてのワークスペースと導入全体の操作を新しい順に 100 件ずつ返す",
    description:
      "各行に今のワークスペースの名前(workspaceName)が付く。workspaceId で 1 つのワークスペース、none で導入全体の操作だけに絞れる。範囲は since・until(既定は 30 日前から今)。記録は 365 日で消える。続きは nextCursor を cursor に渡して読む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "操作の記録", content: { "application/json": { schema: resolver(InstancePageSchema) } } },
      ...errorResponses(401, 403, 422),
    },
  }),
  requireSession,
  requireInstanceAdmin,
  queryValidator(InstanceListQuery),
  async (c) => {
    const { workspaceId, ...q } = c.req.valid("query");
    const scope: AuditListScope = { kind: "instance", ...(workspaceId === undefined ? {} : { workspaceId: workspaceId === "none" ? null : workspaceId }) };
    return c.json(await listPage(c, scope, q, { showEmail: true, hideInvitationIds: viaKey(c) }));
  },
);
