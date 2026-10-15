import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  bakeBootstrap,
  BROWSERS,
  compile,
  CompileError,
  detectBrowser,
  detectDevice,
  detectOs,
  DEVICES,
  evaluateWhatIf,
  normalizePageMatch,
  OSES,
  PageMatchInputSchema,
  patternIdOf,
  type CompiledConfig,
  type Experiment,
  type PageContext,
  type ProfileSnapshot,
  type WhatIfInput,
} from "@wtt/core";
import { PREVIEW_SOURCE, RUNTIME_SOURCE } from "@wtt/runtime/source";
import { requireSession, type AppEnv } from "../app";
import type { Db, ExperimentRow, SiteRow, VariantRow } from "../db";
import { ApiError, notFound, validationFailed } from "../errors";
import { edgeOrigin } from "../capabilities";
import { errorResponses } from "../openapi";
import { buildCompileInput, describeCompileFailure, loadActiveConfig } from "../publish";
import { analyticsRecipe } from "../recipe";
import { loadSite } from "../roles";
import { siteToSettings } from "../site-settings";

export const agentRoutes = new Hono<AppEnv>();

/** spec §13.10: 割当 dry-run の入力。`visitorId` は省略可(決定 39 (2))、`history` は DO を見ずに入力で与える */
const HistoryEntry = {
  count: z.number().int().min(0),
  lastAt: z.number().int().min(0).optional().describe("最後の閲覧 / 達成(epoch 秒)。省略したら期間の条件は判定できない(input_missing)"),
};
const HistoryGoals = z.record(z.string().min(1), z.strictObject(HistoryEntry));
const HistoryPages = z
  .array(z.strictObject({ page: PageMatchInputSchema.describe("閲覧したページの一致の仕方(配信条件の閲覧の条件の page と同じ形)"), ...HistoryEntry }))
  .max(500)
  .describe("閲覧したページごとの回数と最後の閲覧。配信条件の閲覧の条件と同じページの一致で書く(パターン ID は書かない)");
const EvaluateBody = z.strictObject({
  url: z.string().min(1).max(2048).describe("評価する URL(絶対 URL。query・ホスト・パスは URL から導出する)"),
  device: z.enum(DEVICES).optional().describe("省略時は userAgent から判定する。device を省略して userAgent も無ければ、端末の条件は判定できない(input_missing)"),
  userAgent: z.string().max(1024).optional().describe("端末・ブラウザ・OS を判定する User-Agent。browser / os を省略して userAgent も無ければ、ブラウザ・OS の条件は判定できない(input_missing)"),
  browser: z.enum(BROWSERS).optional().describe("userAgent からの判定の代わりに直接指定する"),
  os: z.enum(OSES).optional().describe("userAgent からの判定の代わりに直接指定する"),
  viewportWidth: z.number().int().min(0).max(100000).optional().describe("画面の幅(px)。省略したら画面の幅の条件は判定できない(input_missing)"),
  now: z.number().int().min(0).optional().describe("判定時刻(epoch ミリ秒)。省略時はサーバーの現在時刻。曜日・時間帯はサイトのタイムゾーンで判定する"),
  firstVisitAt: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("初回の訪問時刻(epoch ミリ秒)。null = 発行時刻が不明(古い訪問者として扱う)。省略したら初回の訪問からの経過の条件は判定できない(input_missing)"),
  referrer: z.string().max(2048).default(""),
  query: z.record(z.string(), z.string()).optional().describe("URL から導出したクエリの上書き(省略時は url の searchParams)"),
  visitorId: z.string().min(1).max(128).optional().describe("省略時は reason / weights まで。指定時は traffic 判定と variantId まで"),
  history: z
    .strictObject({ goals: HistoryGoals.optional(), pages: HistoryPages.optional() })
    .optional()
    .describe("Visitor Profile の履歴に相当する形。DO は参照しない"),
  draft: z
    .boolean()
    .default(false)
    .describe("true = D1 の下書き(draft / paused を running とみなす)、false = D1 に記録された active な公開 config"),
});

const EvaluateResultSchema = z.object({
  source: z
    .enum(["published", "draft"])
    .describe("何を評価したか。published = D1 に記録された active な公開 config、draft = D1 の現状"),
  version: z
    .number()
    .int()
    .nullable()
    .describe(
      "評価した公開版(sites.active_version)。未公開なら null。source: draft のときは参考値。KV active や bootstrap の 60 秒キャッシュとは差が出ることがあるので、公開履歴(GET /sites/:sid/publishes)と突き合わせる",
    ),
  experiments: z.array(
    z.object({
      experimentId: z.string(),
      status: z.enum(["draft", "running", "paused", "archived"]).describe("Desired Status(D1 experiments.status そのまま)"),
      published: z.boolean().describe("公開 config にこのエクスペリエンスが載っているか"),
      eligible: z.boolean(),
      reason: z
        .enum(["not_running", "not_published", "url_mismatch", "needs_history", "input_missing", "targeting_false", "traffic_excluded"])
        .optional()
        .describe(
          "eligible: false のときだけ。判定順は not_running → not_published → url_mismatch → needs_history → input_missing → targeting_false → traffic_excluded。not_published = 未公開のサイト、または status が running なのに公開 config に無い(paused / draft / archived は not_running)。input_missing = 配信条件が使う入力(User-Agent・画面の幅・判定時刻・初回の訪問・履歴の lastAt)が欠けていて判定できない(本番では対象外になる)",
        ),
      weights: z.array(z.object({ variantId: z.string(), weight: z.number().int() })),
      variantId: z.string().optional().describe("visitorId を渡し eligible のときだけ。**保存済み割当(persistAssignment)は参照しない**ので、DO に割当を持つ訪問者は本番でこれと異なるパターンを受け取り得る"),
    }),
  ),
});

/** compile を通していない Experiment(archived / 配信中の config に無いもの)の weights 用 */
function stubExperiment(row: ExperimentRow, variants: VariantRow[]): Experiment {
  return {
    id: row.id,
    name: row.name,
    urlMatch: JSON.parse(row.url_match_json),
    ...(row.targeting_json ? { targeting: JSON.parse(row.targeting_json) } : {}),
    trafficPercentage: row.traffic_percentage,
    persistAssignment: row.persist_assignment === 1,
    variants: variants.filter((v) => v.experiment_id === row.id).map((v) => ({ id: v.id, name: v.name, weight: v.weight, changes: [] })),
  } as Experiment;
}

/**
 * 履歴のページの一致を、評価する設定の patterns のキーに写す(設計書 §13)。版 2 のキーは値のハッシュ(patternIdOf)、
 * 版 1 の公開設定のキーは旧 ID なので、一致の仕方が同じキーも探す
 */
function historyPagesFor(entries: Array<{ page: Parameters<typeof normalizePageMatch>[0]; count: number; lastAt?: number }>, patterns: CompiledConfig["patterns"] | undefined): ProfileSnapshot["pages"] {
  const out: ProfileSnapshot["pages"] = Object.create(null);
  for (const e of entries) {
    const n = normalizePageMatch(e.page);
    const entry = { count: e.count, ...(e.lastAt !== undefined ? { lastAt: e.lastAt } : {}) };
    out[patternIdOf(n)] = entry;
    for (const [id, def] of Object.entries(patterns ?? {})) if ((def.part ?? "url") === (n.part ?? "url") && def.op === n.op && def.value === n.value) out[id] = entry;
  }
  return out;
}

const DRAFT_HINT = "weight の合計 100・パターン 2 つ以上・参照する目標 / オーディエンスの存在・配信条件の形を確認してください";
/** 下書きの compile の失敗(evaluate の draft と draft-bootstrap)。場所が分かる失敗はその説明を hint に出す */
function draftCompileError(e: CompileError): ApiError {
  return new ApiError(422, "invalid_draft", { message: "下書きを compile できません", hint: describeCompileFailure(e.code, e.message).hint ?? DRAFT_HINT, compileError: e.code, detail: e.message });
}

/**
 * 評価対象の組み立て(決定 39 (7))。**下書きも配信中も同じ `buildCompileInput` → `compile` の経路**を通す
 * (Publish と同じ形の Experiment を評価するため)。返す `status` は常に **Desired Status**(D1 `experiments.status`)で、
 * 「いま配っているか」は公開 config(`publishes.config_json`)に載っているかどうか = `published` で別に返す。
 * `draft: false` の評価対象は公開 config の Experiment、`draft: true` は D1 の下書きを compile したもの
 */
async function loadTargets(
  db: Db,
  site: SiteRow,
  draft: boolean,
): Promise<{ source: "published" | "draft"; version: number | null; items: WhatIfInput[]; timezone?: string; patterns?: CompiledConfig["patterns"] }> {
  const rows = await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
  const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  // `published` は draft モードでも「公開 config に載っているか」を意味するので、active は常に読む(KV には触れない)
  const active = await loadActiveConfig(db, site);
  let config: CompiledConfig | null = active;
  if (draft) {
    const input = await buildCompileInput(db, site, site.active_version ?? 1, rows, { statuses: ["draft", "running", "paused"] });
    try {
      config = compile(input);
    } catch (e) {
      if (e instanceof CompileError) throw draftCompileError(e);
      throw e;
    }
  }
  const items = rows.map((row) => {
    const evaluated = config?.experiments.find((e) => e.id === row.id);
    return {
      // 評価に使う定義。対象の config に無い Experiment は D1 の行から組み立てる(weights を返すため)
      experiment: evaluated ?? stubExperiment(row, variants),
      status: row.status,
      published: active?.experiments.some((e) => e.id === row.id) === true,
    };
  });
  return { source: draft ? "draft" : "published", version: site.active_version, items, timezone: config?.timezone, patterns: config?.patterns };
}

agentRoutes.post(
  "/sites/:sid/evaluate",
  describeRoute({
    tags: ["agent"],
    summary:
      "割当の what-if(閲覧者以上)。なぜ入らないかを reason で返す。KV / DO / edge には触れない。draft: false は **D1 に記録された active な公開 config** を評価する — KV や bootstrap の 60 秒キャッシュとは差が出ることがあるので、`version` で公開履歴と突き合わせること。**注意**: `decide()` が持つ「Profile 取得不能(DO 障害)時の config 全体 fail-closed」はここでは再現されない — `history` を渡さない呼び出しは「履歴未提供」として扱われ、`decide()` なら空になる場面でも `eligible: true` を返し得る",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "エクスペリエンスごとの判定", content: { "application/json": { schema: resolver(EvaluateResultSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", EvaluateBody, (r) => {
    if (r.success) return;
    const pages = (r.data as { history?: { pages?: unknown } } | undefined)?.history?.pages;
    if (typeof pages === "object" && pages !== null && !Array.isArray(pages))
      throw new ApiError(422, "validation_failed", {
        path: ["history", "pages"],
        message: "history.pages は配列で渡します",
        hint: 'パターン ID ではなくページの一致で書きます(例: [{ "page": { "part": "path", "op": "startsWith", "value": "/pricing/" }, "count": 2 }])',
      });
    throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const body = c.req.valid("json");
    let derivedQuery: Record<string, string> = {};
    try {
      derivedQuery = Object.fromEntries(new URL(body.url).searchParams);
    } catch {
      derivedQuery = {}; // 相対 URL ではクエリを復元できない。ホスト・パスの条件は input_missing になる(クエリ・参照元などそれ以外の条件は評価できる)
    }
    const ua = body.userAgent;
    const ctx: PageContext = {
      url: body.url,
      query: (body.query as Record<string, string> | undefined) ?? derivedQuery,
      referrer: body.referrer,
      now: body.now ?? Date.now(),
    };
    // device も userAgent も無ければ入れない(端末の条件は判定できない = input_missing。ユーザー決定 2026-10-02)
    const device = body.device ?? (ua !== undefined ? detectDevice(ua) : undefined);
    const browser = body.browser ?? (ua !== undefined ? detectBrowser(ua) : undefined);
    const os = body.os ?? (ua !== undefined ? detectOs(ua) : undefined);
    if (device !== undefined) ctx.device = device;
    if (browser !== undefined) ctx.browser = browser;
    if (os !== undefined) ctx.os = os;
    if (body.viewportWidth !== undefined) ctx.viewportWidth = body.viewportWidth;
    if (body.firstVisitAt !== undefined) ctx.firstVisitAt = body.firstVisitAt;
    const { source, version, items, timezone, patterns } = await loadTargets(c.get("db"), site, body.draft);
    const experiments = evaluateWhatIf(items, ctx, {
      ...(body.visitorId !== undefined ? { visitorId: body.visitorId } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(patterns !== undefined ? { patterns } : {}),
      ...(body.history ? { history: { goals: body.history.goals ?? {}, pages: historyPagesFor(body.history.pages ?? [], patterns) } } : {}),
      draft: body.draft,
    });
    return c.json({ source, version, experiments });
  },
);

/** 対象 Experiment 1 件だけを、status によらず running として compile する(下書きの確認用。§13.10) */
async function compileSingleExperiment(db: Db, site: SiteRow, eid: string): Promise<CompiledConfig> {
  const input = await buildCompileInput(db, site, site.active_version ?? 1, undefined, {
    statuses: ["draft", "running", "paused", "archived"], // status を無視して 1 件だけ入れる = compile 上は running 扱い
    experimentIds: [eid],
  });
  try {
    return compile(input);
  } catch (e) {
    if (e instanceof CompileError) throw draftCompileError(e);
    throw e;
  }
}

agentRoutes.get(
  "/sites/:sid/experiments/:eid/draft-bootstrap",
  describeRoute({
    tags: ["agent"],
    summary:
      "下書きの bootstrap JS(閲覧者以上)。このエクスペリエンスだけを running として compile + bake する。KV / publishes / edge キャッシュには一切触れない。ヘッドレスブラウザに addInitScript で注入し `#__ab_preview=<eid>:<vid>` でパターンを固定する",
    security: [{ bearer: [] }],
    responses: {
      200: {
        description: "bootstrap JS(edge の /s/<siteId>.js と同形式)",
        content: { "text/javascript": { schema: resolver(z.string()) } },
      },
      ...errorResponses(401, 403, 404, 422),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const eid = c.req.param("eid");
    const row = await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", eid).executeTakeFirst();
    if (!row) throw notFound();
    const config = await compileSingleExperiment(db, site, eid);
    const body = bakeBootstrap(config, siteToSettings(site), RUNTIME_SOURCE, { previewSource: PREVIEW_SOURCE, apiBase: edgeOrigin(c.env) });
    return c.body(body, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store", // 下書きは決してキャッシュさせない(§13.10)
    });
  },
);

/** そのまま送れるリクエスト(決定 39 (5)): url に body を POST する。認証ヘッダはエージェントが付ける */
const Ga4RequestSchema = z.object({
  method: z.literal("POST"),
  url: z.string().describe("GA4 Data API v1beta の runReport エンドポイント(property は URL パスに入る)"),
  body: z.unknown().describe("runReport のリクエスト body(dateRanges / dimensions / metrics / dimensionFilter)"),
});

const AnalyticsRecipeSchema = z.object({
  experiment: z.object({
    id: z.string(),
    name: z.string(),
    startedAt: z.number().int().nullable().describe("epoch ミリ秒。最初に running になった時刻"),
    stoppedAt: z.number().int().nullable().describe("epoch ミリ秒。archived になった時刻"),
  }),
  period: z.object({ start: z.string().describe("YYYY-MM-DD(UTC)"), end: z.string().describe("YYYY-MM-DD(UTC)。停止していなければ今日") }),
  ga4: z.object({
    propertyId: z.string().describe("未設定なら {{GA4_PROPERTY_ID}}"),
    exposureByVariant: Ga4RequestSchema.describe("GA4 Data API v1beta properties.runReport(パターン別の露出ユーザー数 / セッション数 = 配分と SRM の確認)。url に body をそのまま POST する"),
    conversionsByGoal: Ga4RequestSchema.describe("同 runReport(目標別の conversion 数)。conversion にはエクスペリエンス / パターンが付かないのでパターン別 CVR は BigQuery を使う"),
  }),
  bigquery: z.object({
    dataset: z.string().describe("未設定なら {{BQ_DATASET}}"),
    visitorCvrSql: z
      .string()
      .describe("訪問者単位(user_pseudo_id)のパターン × 目標の CVR。複数パターンに露出した訪問者は初回露出に帰属させる"),
    sessionCvrSql: z.string().describe("セッション単位(user_pseudo_id + ga_session_id)の同じ集計(帰属はセッション内の初回露出)"),
    mixedExposureCountSql: z.string().describe("複数パターンに露出した訪問者数 / セッション数(帰属の妥当性を測る補助クエリ)"),
  }),
  goals: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
  notes: z.array(z.string()).describe("結果を誤読しないための注記(帰属の規則と補助クエリ)"),
});

agentRoutes.get(
  "/sites/:sid/experiments/:eid/analytics-recipe",
  describeRoute({
    tags: ["agent"],
    summary: "結果を読むためのクエリ(閲覧者以上)。命名設定・期間・外部 ID を埋めた GA4 Data API リクエストと BigQuery SQL。数値は返さない",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "レシピ", content: { "application/json": { schema: resolver(AnalyticsRecipeSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const experiment = await db
      .selectFrom("experiments")
      .selectAll()
      .where("site_id", "=", site.id)
      .where("id", "=", c.req.param("eid"))
      .executeTakeFirst();
    if (!experiment) throw notFound();
    const goals = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).orderBy("id").execute();
    return c.json(analyticsRecipe({ site, experiment, goals, now: Date.now() }));
  },
);
