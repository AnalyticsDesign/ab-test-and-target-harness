import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { SITE_ID_RE } from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import { auditActor, writeAuditBefore } from "../audit";
import { edgeOrigin } from "../capabilities";
import { validationFailed } from "../errors";
import { errorResponses } from "../openapi";
import { requireInstanceAdmin } from "../roles";
import { readInstanceStatus, rebuildStaticFiles, staticHealth } from "../static-health";

/**
 * 7o K11・K12: 設置タグの配信ファイルのインスタンス全体の状態と、公開中の全サイトの作り直し(システム管理者のみ)。
 * 状態の GET はシステム管理者のセッションと、システム管理者の「すべてのワークスペース」の権限を絞っていない鍵で読める(actsAsInstanceAdmin)。
 * 作り直しはセッションのみ(session-only.ts の SESSION_ONLY。Q8)。凍結中の作り直しは writeFreezeGuard が 503 にする(読み取りは通る)
 */
export const staticDeliveryRoutes = new Hono<AppEnv>();

const StaticHealthSchema = z.object({
  pendingSites: z.array(z.string()).describe("更新待ちのサイト(デプロイ専用の Worker が受け付けたが、まだ配り終えていない)"),
  removingSites: z.array(z.string()).describe("削除を受け付けたが、まだ消えていないサイト"),
  lastError: z.string().nullable().describe("配置の最後のエラー(続いている間だけ。成功すると null)"),
  failures: z.number().int().describe("配置の連続の失敗の回数"),
  lastDeployedAt: z.number().nullable().describe("Cloudflare への配置が最後に成功した時刻(epoch ミリ秒)。無ければ null"),
  mismatchSites: z
    .array(z.string())
    .describe(
      "記録が食い違っているサイト(デプロイ専用の Worker の記録が、データベースより新しい世代や削除の記録を持っている・同じ世代で中身が違う・データベースでは未公開か、データベースに無いのに配信ファイルが残っている)。データベースを過去の時点に戻した後などに起きる",
    ),
  unknownSites: z.array(z.string()).describe("デプロイ専用の Worker の記録に無い公開中のサイト(公開して 1 分以内のサイトは除く)"),
  undeliveredSites: z.array(z.string()).describe("更新の依頼が届いていない公開中のサイト(データベースでは内容が新しくなっているのに、デプロイ専用の Worker に依頼が届いていない。15 分ごとの定期処理が依頼し直す)"),
  publishedSites: z.number().int().describe("公開中のサイトの数(削除の途中のサイトを除く)。作り直しの対象の数"),
  unpublishedWithFiles: z.number().int().describe("mismatchSites のうち、データベースでは未公開か、データベースに無いのに配信ファイルが残っているサイトの数(作り直しで配信ファイルを消す)"),
  removingInD1: z.number().int().describe("削除の途中のサイトの数(作り直しの対象外)"),
  needsAttention: z.boolean().describe("配置の失敗が続いている(lastError か failures)か、記録が食い違っている(mismatchSites・unknownSites・undeliveredSites)。更新待ち・削除の消え残りだけなら false"),
});
const RebuildBodySchema = z.strictObject({
  after: z.string().regex(SITE_ID_RE).optional().describe("前の応答の next。省略すると最初の頁から"),
});
const RebuildResultSchema = z.object({
  requested: z.number().int().describe("作り直しを受け付けた公開中のサイトの数"),
  removed: z.number().int().describe("配信ファイルの削除を受け付けたサイトの数(データベースでは未公開か、データベースに無いサイト)"),
  skippedRemoving: z.number().int().describe("削除の途中のため対象外にしたサイトの数"),
  failed: z
    .array(z.object({ siteId: z.string(), reason: z.enum(["no_publish_record", "rejected", "unavailable"]) }))
    .describe("受け付けられなかったサイト。no_publish_record = 公開履歴が無い(そのサイトを公開し直す)/ rejected = 入力を受け付けられなかった / unavailable = デプロイ専用の Worker に届かなかった(時間をおいてもう一度呼ぶ)"),
  next: z.string().nullable().describe("続きがあれば、次の呼び出しの after に渡す ID。null なら終わり"),
});

staticDeliveryRoutes.get(
  "/static/status",
  describeRoute({
    tags: ["static"],
    summary:
      "設置タグの配信ファイルの配置の状態(システム管理者のみ。すべてのワークスペース)。更新待ち・削除の消え残り・最後のエラー・記録の食い違い・デプロイ専用の Worker の記録に無い公開中のサイト・更新の依頼が届いていない公開中のサイト",
    description: "デプロイ専用の Worker が無い・応答しないときは 503 static_deployer_unavailable(封筒の reason が not_configured = 設定されていない / unreachable = 届かない)",
    responses: {
      200: { description: "状態", content: { "application/json": { schema: resolver(StaticHealthSchema) } } },
      ...errorResponses(401, 403, 503),
    },
  }),
  requireSession,
  requireInstanceAdmin,
  async (c) => {
    const status = await readInstanceStatus(c.env);
    return c.json(await staticHealth(c.get("db"), status, Date.now(), edgeOrigin(c.env)));
  },
);

staticDeliveryRoutes.post(
  "/static/rebuild",
  describeRoute({
    tags: ["static"],
    summary:
      "公開中の全サイトの設置タグの配信ファイルを、今の公開内容で作り直す(システム管理者のみ。管理画面のセッションからのみ呼べる。1 回に 25 サイトまで。応答の next が null でなければ after に渡して続ける)。デプロイ専用の Worker を作り直した後や、データベースを過去の時点に戻した後に使う。データベースでは未公開か、データベースに無いのに配信ファイルが残っているサイトは、配信ファイルを消す。削除の途中のサイトは対象外。配置の完了は待たない",
    description: "デプロイ専用の Worker が無い・応答しないときは 503 static_deployer_unavailable(封筒の reason が not_configured / unreachable)",
    responses: {
      200: { description: "受け付けた結果", content: { "application/json": { schema: resolver(RebuildResultSchema) } } },
      ...errorResponses(400, 401, 403, 422, 503),
    },
  }),
  requireSession,
  requireInstanceAdmin,
  validator("json", RebuildBodySchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const { after } = c.req.valid("json");
    const status = await readInstanceStatus(c.env);
    // B129(spec §3.1・§5.3): 作り直しは多くのサイトへの依頼に分かれて 1 つの batch に入らないので、始める前に記録する(「前」。往復 +1)。
    // 書けなければそのまま投げて 500 にし、作り直しを始めない。デプロイ専用の Worker に届かない(上の 503)ときは何もしないので記録しない
    await writeAuditBefore(c.env.DB, auditActor(c), { action: "static.rebuild", workspaceId: null, target: { type: "instance" }, detail: { after: after ?? null } });
    const out = await rebuildStaticFiles(c.env, c.get("db"), { after: after ?? null }, { status, now: Date.now(), force: true });
    return c.json({ requested: out.requested.length, removed: out.removed.length, skippedRemoving: out.skippedRemoving.length, failed: out.failed, next: out.next });
  },
);
