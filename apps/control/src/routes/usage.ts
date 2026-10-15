// apps/control/src/routes/usage.ts
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { requireSession, type AppEnv } from "../app";
import { validationFailed } from "../errors";
import { readInstanceSettings, UsageSettingsSchema, usageSettingsOf, writeInstanceSettings } from "../instance-settings";
import { errorResponses } from "../openapi";
import { assertCanReadUsage, requireInstanceAdmin } from "../roles";
import { getUsage } from "../usage";
import { usageConfig } from "../usage/fetch";
import { RESOURCE_IDS } from "../usage/limits";

/**
 * backlog D10: 使用状況(Cloudflare の日次上限 / Paid の 1 日の目安に対する当日の消費)と、その設定。
 * 通知はしない(エージェントが GET /usage を定期的に読んで知らせる)。設定の変更はシステム管理者のセッションだけ(session-only.ts)
 */
export const usageRoutes = new Hono<AppEnv>();

const Status = z.enum(["ok", "warning", "critical", "exhausted", "within_reference", "over_reference", "not_judged"]);
const ResourceSchema = z.object({
  id: z.enum(RESOURCE_IDS).describe("資源。workers_requests / do_requests / do_rows_read / do_rows_written / d1_rows_read / d1_rows_written / kv_reads / kv_writes / kv_deletes / kv_lists / d1_storage / d1_largest_db / do_storage / kv_storage"),
  kind: z.enum(["daily", "capacity"]).describe("daily = 当日(UTC 0 時から)の回数 / capacity = 保存量"),
  unit: z.enum(["count", "bytes"]),
  used: z.number().describe("アカウント全体の消費(同じアカウントの他の用途を含む)。d1_largest_db だけは本製品のデータベースの最大の大きさ"),
  limit: z.number().nullable().describe("超えると止まる上限。止まらない資源(Paid の日次・Paid の保存量)と判定しない資源は null"),
  ratio: z.number().nullable().describe("used / limit。limit が null なら null"),
  status: Status.describe("ok(70% 未満)/ warning(70% 以上)/ critical(90% 以上)/ exhausted(100% 以上)= 止まる危険。within_reference / over_reference = 止まらない資源を月額 $5 に含まれる量(日次の資源は 30 日で割った 1 日分)と比べた結果。not_judged = 判定しない(d1_largest_db で、本製品のデータベースが設定に無い、または設定した ID が一致しない)"),
  projectedExhaustAt: z.number().nullable().describe("このペースで上限に達する時刻(epoch ミリ秒)。経過 1 時間未満・次のリセットより後・止まらない資源は null"),
  reference: z.object({ value: z.number(), ratio: z.number() }).nullable().describe("止まらない資源の月額 $5 に含まれる量(Paid の日次は月の込み量 ÷ 30 の 1 日分、保存量は込み量)と、それに対する割合。管理画面の表示の設定に関わらず返す"),
  breakdown: z.array(z.object({ name: z.string(), used: z.number() })).describe("本製品の Worker / データベース / KV ごとの内訳(他のプロジェクトは出さない)"),
});
const UsageSchema = z.object({
  plan: z.enum(["free", "paid"]),
  asOf: z.number().describe("Cloudflare から取得した時刻(epoch ミリ秒)。control は 60 秒の間同じ値を返し、そのあいだは最初に取得した時刻のまま。Cloudflare 側の集計は数分遅れる"),
  resetAt: z.number().describe("日次の上限が戻る時刻(次の UTC 0 時、epoch ミリ秒)"),
  worst: z.object({ id: z.enum(RESOURCE_IDS), status: Status, ratio: z.number() }).nullable().describe("止まる危険のある資源のうち、割合が最も高いもの"),
  settings: UsageSettingsSchema,
  resources: z.array(ResourceSchema),
});
const SettingsViewSchema = UsageSettingsSchema.extend({
  configured: z.boolean().describe("Cloudflare の API トークンとアカウント ID が設定されているか(読み取り専用。PATCH では変えられない)"),
});
const PatchSchema = UsageSettingsSchema.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "変更する項目を 1 つ以上指定してください" });

usageRoutes.get(
  "/usage",
  describeRoute({
    tags: ["usage"],
    summary: "Cloudflare の使用状況(当日の消費・上限・判定・上限到達の予測)。見られる人は導入の設定による(既定 = すべてのメンバー)",
    description: "通知はしないので、監視するエージェントが定期的に読む。応答が返らない(Workers の日次上限が尽きると control も止まる)こと自体を危険信号として扱う。見られる人が『システム管理者のみ』のとき、持ち主がシステム管理者の API キーは、範囲(ワークスペース)や権限(閲覧者)に関わらず読める(この口だけの例外)",
    responses: {
      200: { description: "使用状況", content: { "application/json": { schema: resolver(UsageSchema) } } },
      ...errorResponses(401, 403, 503),
    },
  }),
  requireSession,
  async (c) => {
    const settings = await readInstanceSettings(c.get("db"));
    await assertCanReadUsage(c, settings.usageVisibility);
    return c.json(await getUsage(c.env, usageSettingsOf(settings)));
  },
);

usageRoutes.get(
  "/usage/settings",
  describeRoute({
    tags: ["usage"],
    summary: "使用状況の設定(見られる人・プラン・月額 $5 に含まれる量と比べるか)。読める人は GET /usage と同じ",
    description: "見られる人が『システム管理者のみ』のとき、持ち主がシステム管理者の API キーは、範囲(ワークスペース)や権限(閲覧者)に関わらず読める(この口だけの例外)",
    responses: {
      200: { description: "設定", content: { "application/json": { schema: resolver(SettingsViewSchema) } } },
      ...errorResponses(401, 403),
    },
  }),
  requireSession,
  async (c) => {
    const settings = await readInstanceSettings(c.get("db"));
    await assertCanReadUsage(c, settings.usageVisibility);
    return c.json({ ...usageSettingsOf(settings), configured: usageConfig(c.env) !== null });
  },
);

usageRoutes.patch(
  "/usage/settings",
  describeRoute({
    tags: ["usage"],
    summary: "使用状況の設定を変える(システム管理者のみ・セッションのみ)。送った項目だけを変える",
    responses: {
      200: { description: "変更後の設定", content: { "application/json": { schema: resolver(UsageSettingsSchema) } } },
      ...errorResponses(400, 401, 403, 422),
    },
  }),
  requireSession,
  requireInstanceAdmin,
  validator("json", PatchSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    await writeInstanceSettings(c.get("db"), c.req.valid("json"), c.get("user").id);
    return c.json(usageSettingsOf(await readInstanceSettings(c.get("db"))));
  },
);
