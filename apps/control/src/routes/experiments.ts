import { TRANSITIONS } from "../experiment-status";
import { Hono, type Context } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { expressionBuilder, sql, type Expression, type ExpressionBuilder, type RawBuilder, type SqlBool } from "kysely";
import { z } from "zod";
import {
  ChangeSchema,
  EXPERIMENT_KINDS,
  ExperimentAnalyticsRequestSchema,
  ExperimentAnalyticsSchema,
  TargetingInputSchema,
  TargetingReadSchema,
  UrlMatchInputSchema,
  VariantAnalyticsRequestSchema,
  VariantAnalyticsSchema,
  duplicateIdCandidates,
  duplicateName,
  type Change,
  type ExperimentAnalytics,
  type ExperimentKind,
  type VariantAnalytics,
  newRunId,
  targetingReferences,
  MAX_CHANGES_PER_VARIANT,
} from "@wtt/core";
import { requireSession, type AppEnv } from "../app";
import {
  auditActor,
  auditChanged,
  auditFromTo,
  auditStatement,
  changedFieldsDetail,
  sameJsonText,
  unchangedValues,
  type AuditColumnValue,
  type AuditEvent,
  type AuditFieldChange,
  type AuditStatementOpts,
} from "../audit";
import { changesPutBodyLimit } from "../body-limit";
import { resultsStore } from "../capabilities";
import { sqlStatement, toStatement, type Db, type ExperimentRow, type SiteRow, type Tables, type VariantRow } from "../db";
import { copyChangesQuery, copyPlanQuery, copyVariantsQuery, duplicateExperimentRow, insertExperimentQuery, retiredIds, sourceUnchanged } from "../duplicate";
import { ApiError, assetGuardRejected, publishOutcomeUnknown, notFound, validationFailed } from "../errors";
import { assertStartable, capacityWarning, fixPlanStatement, loadPlan, type LoadedPlan } from "../evaluation-plan";
import { isReservedId, reservedIdMessage, SLUG_RE } from "../ids";
import { errorResponses } from "../openapi";
import { DELIVERY_DELAY_WARNING, publicPublishResult, publishWithTransition, type PublishResult, type PublishTransition } from "../publish";
import { rewriteCollectUntil } from "../results/collect-until";
import { adoptionNotAllowed, AdoptionInputSchema, AdoptionJsonSchema, adoptionSummary, resolveAdoptedVariant } from "../results/adoption";
import { deliveredAt } from "../results/delivered";
import { apiGuard } from "../results/guard";
import { readEstimate } from "../results/read-session";
import type { ResultSnapshot } from "../results/report";
import { liveFacts } from "../results/snapshot";
import { recordStop } from "../results/stop";
import { enqueuePurgeQuery, kickOffPurge } from "../results/purge";
import { loadSite } from "../roles";
import { PublishResultSchema } from "./publish";
import { experimentJson } from "../serialize";
import {
  assertNotArchivedTest,
  assertTestEditable,
  experimentPatchWritable,
  isMemoOnly,
  notArchivedTest,
  parentIsDraft,
  parentNotArchivedTest,
  thisExperiment,
} from "../test-locks";
import {
  ANALYTICS_REQUEST_DESCRIPTION,
  assertAnalyticsValues,
  assertDescription,
  assertExperimentAnalytics,
  assertName,
  assertNoRemovedPageCondition,
  assertTargetingRefs,
  normalizedTargeting,
  normalizedUrlMatch,
  parseChange,
  assertImageAssetsExist,
  targetingValidationFailed,
} from "../validation";

export const experimentRoutes = new Hono<AppEnv>();

/**
 * B129(spec §3.1 の区分 content・§5.1・§5.2): エクスペリエンスの操作の記録。記録の文は操作の batch に入れ(往復は増えない)、
 * 原則として操作の文の**前**に置いて前の値を同じ文で読み、guard は操作の文と同じ条件の断片(ExpressionBuilder を受ける関数)を使う
 * (Review Focus 1)。作成(作成・複製)だけは insert の後(無条件)か、insert と同じ条件で前に置き、世代は insert と同じ値を渡す
 */
/** 条件の断片を記録の文(Kysely の `sql`)の中で評価するための ExpressionBuilder(状態を持たない) */
const ex = expressionBuilder<Tables, "experiments">();
const anyEb = expressionBuilder<Tables, any>();
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/**
 * エクスペリエンスの記録の文。workspace_id = 認可したサイトの workspace_id、site_id・experiment_id = 対象。
 * 世代は event.generation を渡さなければ、記録の文の中で対象の行から読む(更新・削除。削除は削除の前に置くので消える前の行を読む)
 */
function experimentAudit(
  c: Context<AppEnv>,
  site: Pick<SiteRow, "id" | "workspace_id">,
  eid: string,
  event: DistributiveOmit<AuditEvent, "workspaceId" | "siteId" | "experimentId">,
  opts?: AuditStatementOpts,
): D1PreparedStatement {
  return auditStatement(c.env.DB, auditActor(c), { ...event, workspaceId: site.workspace_id, siteId: site.id, experimentId: eid }, opts);
}
/**
 * 記録の targetFrom: エクスペリエンスの行(target_id = ID・target_label = 名前)。`where` = 操作の文と同じ条件(0 行なら記録しない)。
 * `cols` = detail・guard が `t.<列>` で読む列(前の値)
 */
const experimentTarget = (where: (eb: ExpressionBuilder<Tables, "experiments">) => Expression<SqlBool>, cols: RawBuilder<unknown> = sql``) =>
  sql`select id as target_id, name as target_label${cols} from experiments where ${where(ex)}`;
/** 書き込みの文の条件: 対象のパターンの行(パターンのメモの更新と、その前に置く記録の文) */
const thisVariant = (siteId: string, eid: string, vid: string) => (eb: ExpressionBuilder<Tables, "variants">) =>
  eb.and([eb("variants.site_id", "=", siteId), eb("variants.experiment_id", "=", eid), eb("variants.id", "=", vid)]);
/** 記録の targetFrom: パターンの行(target_id = パターンの ID・target_label = 名前) */
const variantTarget = (siteId: string, eid: string, vid: string) =>
  sql`select id as target_id, name as target_label from variants where ${thisVariant(siteId, eid, vid)(expressionBuilder<Tables, "variants">())}`;
/**
 * PATCH の欄(記録の detail.fields の順)と比べる列。fromTo = 前後を持つ欄(名前・配信率・割当の固定)。ほかは名前だけ(配信条件・URL・外部計測・メモ。spec §3.2)。
 * json = JSON の列(鍵の順を問わずに読んだ行と比べる)。B129 final review(R64): 記録するのは値が変わった欄だけ
 */
const PATCH_FIELDS = [
  { key: "name", col: "name", fromTo: sql`substr(t.name, 1, 200)` },
  { key: "urlMatch", col: "url_match_json", json: true },
  { key: "targeting", col: "targeting_json", json: true },
  { key: "trafficPercentage", col: "traffic_percentage", fromTo: sql`t.traffic_percentage` },
  { key: "persistAssignment", col: "persist_assignment", fromTo: sql`json(case when t.persist_assignment = 1 then 'true' else 'false' end)`, bool: true },
  { key: "analytics", col: "analytics_json", json: true },
  { key: "description", col: "description" },
] as const satisfies ReadonlyArray<{ key: keyof z.infer<typeof ExperimentPatch>; col: keyof ExperimentRow; fromTo?: RawBuilder<unknown>; json?: true; bool?: true }>;

const experimentActive = () =>
  new ApiError(409, "experiment_active", { message: "配信中のエクスペリエンスは削除できません", hint: "終了(archived)してから削除してください" });

/** 7n: 望む状態は下書きか終了でも、終了の公開が済まず published_status が running / paused のまま(まだ配っている)。code は同じ */
const experimentStillPublished = () =>
  new ApiError(409, "experiment_active", { message: "終了の公開が済んでいないため、まだ配信中です", hint: "もう一度公開して、終了を配り終えてから削除してください" });
const isLive = (s: string | null | undefined) => s === "running" || s === "paused";

/** パターンの集合の全置換は下書きだけ(終了したテストは別のコード experiment_archived_readonly。D9 ③ の K10) */
const variantsLocked = () =>
  new ApiError(409, "experiment_active", {
    message: "このエクスペリエンスのパターンは変更できません",
    hint: "配信中または終了済みのエクスペリエンスのパターンは変更できません。複製して新しいエクスペリエンスを作成してください",
  });

/** D9 ②(設計書 §6.3): 一度開始したエクスペリエンスの ID(削除済み)を指定した作成・複製 */
const retiredIdTaken = (id: string) =>
  new ApiError(409, "id_taken", {
    id,
    message: "このエクスペリエンス ID は使い直せません",
    hint: "この ID は以前に開始したエクスペリエンスで使われていました。別の ID を指定してください",
  });

// spec §13.1: id は Site 内一意のスラッグで作成後は変更不可(割当ハッシュの入力なので特に)。status は Task 7 の /status 専用
const ExperimentName = z.string().min(1);
const TARGETING_DESCRIPTION =
  "配信条件。条件 1 つ、否定の形を持つ条件の not、または and / or の下に条件か否定の形を持つ条件の not が並ぶ形だけを受けます。入れ子やグループの除外はオーディエンスで作ります。ページの URL・ホスト・パス・パラメータは配信条件ではなく対象 URL(urlMatch)で指定します";
const Targeting = TargetingInputSchema.nullable().describe(TARGETING_DESCRIPTION);
/** 応答の配信条件。保存の前に残った、今は保存できないページの条件(url / host / path / query)も表せる */
const TargetingRead = TargetingReadSchema.nullable().describe(
  `${TARGETING_DESCRIPTION}。応答には、今は保存できないページの条件(ctx が url / host / path / query)が残っていることがあり、そのままでは保存・開始・再開できません。対象 URL に移してから保存してください`,
);
const UrlMatch = UrlMatchInputSchema.describe(
  "対象 URL。含める行(include。1〜10 行)のどれかに一致し、除く行(exclude。0〜10 行)のどれにも一致しないページが対象。行 = ページの一致(page)と、同じ行の「かつ」のページの一致(and。0〜5 個。page と同じ形)と、URL のパラメータの条件(params。0〜5 個)。行の条件をすべて満たすと一致。除く行が判定できないページは対象外。GET で読んだ行を書き戻すときは and ごと送る(落とすと条件が外れ、対象が広がる)",
);
const Traffic = z.number().int().min(1).max(100).describe("1〜100。0 は paused で表現する");
/** B77(K12): 受け口は値を文字列として受けるだけ(値の検査は assertAnalyticsValues)。応答は保存する形 */
const Analytics = ExperimentAnalyticsRequestSchema.nullable().describe(ANALYTICS_REQUEST_DESCRIPTION);
const AnalyticsJson = ExperimentAnalyticsSchema.nullable();
const Description = z.string().describe("メモ(社内用。外部には出力されない)。1,000 字まで");
const KIND_DESCRIPTION =
  "種別。test = テスト(2 つ以上のパターンに訪問者を振り分けて比べる)、single = パーソナライズ(パターン 1 つ・重み 100。振り分けず、条件に合う訪問者全員に表示する)。作成後は変えられない(変えたいときは複製する)";
const Kind = z.enum(EXPERIMENT_KINDS).describe(KIND_DESCRIPTION);

/** constructor など Object.prototype の名前は、設置タグが配る設定を ID で引くときに取り違えるので使わせない(B136。パターン・目標と共通) */
const NotReservedId = z
  .string()
  .regex(SLUG_RE, { abort: true }) // 形が違えば予約の検査は出さない(issue を 1 件にする。目標の else if と同じ)
  .refine((v) => !isReservedId(v), { error: (iss) => reservedIdMessage(String(iss.input)) });
// new は管理画面の新規作成の画面(/experiments/new)と重なるので予約する(オーディエンスと同じ。B37)。作成と複製の入力だけを見るので、既存の行には効かない
const ExperimentId = NotReservedId.refine((v) => v !== "new", { message: "new は新規作成の画面と重なるので ID に使えません" });
const ExperimentCreate = z.strictObject({
  id: ExperimentId.describe("サイト内で一意。作成後は変えられない。new と constructor は使えない"),
  name: ExperimentName,
  kind: Kind.default("test"),
  urlMatch: UrlMatch,
  targeting: Targeting.optional(),
  trafficPercentage: Traffic.default(100),
  persistAssignment: z.boolean().default(false),
  analytics: Analytics.optional(),
  description: Description.optional(),
});
/**
 * PATCH は全フィールド任意。`ExperimentCreate.partial()` から導出しないのは、zod の `.partial()` が
 * 内側の `.default()` を残す(キー未指定でも 100 / false が入る)ため — PATCH のたびに
 * trafficPercentage / persistAssignment が既定値に戻ってしまう
 */
const ExperimentPatch = z.strictObject({
  name: ExperimentName.optional(),
  urlMatch: UrlMatch.optional(),
  targeting: Targeting.optional(),
  trafficPercentage: Traffic.optional(),
  persistAssignment: z.boolean().optional(),
  analytics: Analytics.optional(),
  description: Description.optional().describe("メモ(社内用。外部には出力されない)。1,000 字まで。body がこのキーだけのときは状態にかかわらず受け、未公開の編集にしない"),
});

/** 決定 51: パターンの数は種別で決まる(テストは 2 つ以上・パーソナライズは 1 つ)。数はルートで `variant_count_invalid` にする。weight の合計は 100(ルート側で `variant_weights_invalid` にする) */
const VariantsPut = z
  .array(
    z.strictObject({
      id: NotReservedId.describe("パターン ID。constructor は使えない"),
      name: z.string().min(1),
      weight: z.number().int().min(0).max(100),
      analytics: VariantAnalyticsRequestSchema.nullable().optional().describe(ANALYTICS_REQUEST_DESCRIPTION),
      // B77(K8): 省いたら保存済みの値を保つ(新しいパターンは false / '')。deploy の途中で古い管理画面が送らなくても印とメモが消えない
      original: z
        .boolean()
        .optional()
        .describe("オリジナル(変更を持たず、元のページをそのまま見せるパターン)。true にするとそのパターンの変更を消す。テストだけ。省略時は保存済みの値を保つ"),
      description: Description.optional().describe("メモ(社内用。外部には出力されない)。1,000 字まで。省略時は保存済みの値を保つ"),
    }),
  )
  .min(1);
/** B77(K9): パターンのメモだけを更新する。ほかのキーは受けない */
const VariantPatch = z.strictObject({ description: Description });
// spec §11 / 決定 35 (7): 1 Variant の Change は 100 件まで(保存時の件数上限。Publish の 512KB 上限は別途)。
// 値は core(B154: この経路の本文の上限 CHANGES_PUT_BODY_MAX_BYTES が同じ数から決まるため)
/**
 * core の Change(spec §11: TEXT / IMAGE / HIDE / ATTRIBUTE / HTML / CSS / CUSTOM_JS)の配列。
 * ここで `ChangeSchema` を使わないのは、個々の Change の失敗を `parseChange` が機械可読コード
 * (`attribute_not_allowed` / `change_too_large` / `image_outside_r2_domain` …)に変換するため。
 * この validator は「JSON の配列であること」だけを見る(requestBody は validator からしか組み立てられず、
 * describeRoute 側で宣言し直しても validator 由来の schema が勝つ)。
 * ただし zod 4 は `.meta()` のキーを `z.toJSONSchema` の出力にマージするので、`items` だけは
 * core の ChangeSchema から与える — parse は緩いまま、doc には本当の要素の形が載る(決定 34)
 */
const ChangesPut = z
  .array(z.unknown())
  .max(MAX_CHANGES_PER_VARIANT, { message: "too_many_changes" })
  .meta({
    description: `変更の配列。全置換(空配列でそのパターンの変更を全消し)。最大 ${MAX_CHANGES_PER_VARIANT} 件`,
    items: z.toJSONSchema(ChangeSchema) as Record<string, unknown>,
  });

export const ExperimentJsonSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  description: z.string().describe("メモ(社内用。外部には出力されない)"),
  kind: Kind,
  status: z.enum(["draft", "running", "paused", "archived"]),
  publishedStatus: z.enum(["draft", "running", "paused", "archived"]).nullable().describe("前回公開時の status"),
  urlMatch: UrlMatch,
  targeting: TargetingRead,
  trafficPercentage: z.number().int(),
  persistAssignment: z.boolean(),
  analytics: AnalyticsJson,
  runId: z
    .string()
    .nullable()
    .describe("結果の記録の ID。結果を記録するサイトでテストを開始したときに 1 回だけ振る。下書き・パーソナライズ・結果を記録しないサイトで開始したテストは null"),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.number().int().describe("epoch ミリ秒"),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
  unpublished: z.boolean().describe("前回の公開以降に変更されている"),
});
const ChangeJsonSchema = z.object({
  id: z.string(),
  type: z.enum(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]),
  selector: z.string().optional(),
  payload: z.unknown(),
  updatedBy: z.string(),
  updatedAt: z.number().int().describe("epoch ミリ秒"),
});
const VariantJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number().int(),
  original: z.boolean().describe("オリジナル(変更を持たず、元のページをそのまま見せるパターン)"),
  description: z.string().describe("メモ(社内用。外部には出力されない)"),
  analytics: VariantAnalyticsSchema.nullable(),
});
export const ExperimentDetailJsonSchema = ExperimentJsonSchema.extend({
  variants: z.array(VariantJsonSchema.extend({ changes: z.array(ChangeJsonSchema) })),
});

/** D9 ③(K16、設計書 §8.1): 一覧の項目 = エクスペリエンス + 採用の要約 */
const ExperimentListItemSchema = ExperimentJsonSchema.extend({
  adoption: z
    .object({
      variantId: z.string().nullable().describe("採用したパターンの ID。null = 採用なし"),
      variantName: z
        .string()
        .nullable()
        .describe("採用したパターンの今の名前(パターンが無くなっていれば結果の記録に写した名前)。採用なし・名前が分からないときは null"),
      baseline: z.boolean().describe("基準のパターンを採用したか(正の判定の記録の評価計画の基準と同じ ID のとき true。記録が無いときは false)"),
      decidedAt: z.number().int().describe("epoch ミリ秒"),
      // 差は結果の diff と同じく事後分布(事前分布 Beta(1, 1))から出した値。結果の cvr(y / n)どうしの差とは、参加者が少ないと合わない(B109)
      summary: z
        .object({
          diffPoints: z.number().nullable().describe("基準との差の事後分布の平均(ポイント)。結果の cvr どうしの差とは、参加者が少ないと合わない"),
          relative: z.number().nullable().describe("基準との差の平均 ÷ 基準の CVR の事後分布の平均(%)"),
          probBeat: z.number().nullable().describe("基準を上回る確率(0〜1。最小改善幅を決めたときはそれを超えて上回る確率)"),
          verdict: z.enum(["blocked_quality", "adopt", "worse", "equivalent", "insufficient"]).nullable().describe("判定の状態"),
        })
        .nullable()
        .describe("正の判定の記録(評価時点の記録、評価時点の前に終了したときは終了の記録)から取った値。基準を採用したときは差・確率・判定が null。採用なし・記録が無いときは null"),
    })
    .nullable()
    .describe("採用の記録。記録していなければ null"),
});

type ListAdoption = { variantId: string | null; variantName: string | null; baseline: boolean; decidedAt: number; summary: ReturnType<typeof adoptionSummary> };

/**
 * サイトのテストの採用の要約(エクスペリエンス ID → 要約)。要約は正の判定の記録から作る。
 * baseline は記録の評価計画の基準と比べて決める(要約の値がすべて null になるのは基準のほかに、重み 0 のパターンもあるため、値からは推し量らない)。
 * 名前は今のパターンの行から取り、行が無ければ記録に写した名前を使う
 */
async function listAdoptions(db: Db, siteId: string): Promise<Map<string, ListAdoption>> {
  const adoptions = await db
    .selectFrom("adoptions as a")
    .leftJoin("variants as v", (j) => j.onRef("v.site_id", "=", "a.site_id").onRef("v.experiment_id", "=", "a.experiment_id").onRef("v.id", "=", "a.variant_id"))
    .select(["a.experiment_id", "a.variant_id", "a.decided_at", "v.name as variant_name"])
    .where("a.site_id", "=", siteId)
    .execute();
  const out = new Map<string, ListAdoption>();
  if (adoptions.length === 0) return out;
  // 採用したパターンがあるテストの記録だけを読む(IN の並びにしない = D1 の 1 文のバインドの数の上限に当たらない)
  const snaps = await db
    .selectFrom("result_snapshots as s")
    .innerJoin("adoptions as a", (j) => j.onRef("a.site_id", "=", "s.site_id").onRef("a.experiment_id", "=", "s.experiment_id"))
    .select(["s.experiment_id", "s.kind", "s.result_json"])
    .where("s.site_id", "=", siteId)
    .where("a.variant_id", "is not", null)
    .execute();
  const official = new Map<string, Pick<ResultSnapshot, "variants" | "plan">>();
  // 評価時点の記録を優先する(評価時点の記録と終了の記録は同時にはできないが、読み方を正の判定の決まりに合わせる)
  for (const kind of ["stop", "evaluation"] as const) {
    for (const r of snaps) if (r.kind === kind) official.set(r.experiment_id, JSON.parse(r.result_json) as ResultSnapshot);
  }
  for (const a of adoptions) {
    const snap = official.get(a.experiment_id) ?? null;
    const variantName = a.variant_id === null ? null : (a.variant_name ?? snap?.variants.find((v) => v.id === a.variant_id)?.name ?? null);
    const baseline = a.variant_id !== null && snap?.plan?.baselineVariantId === a.variant_id;
    out.set(a.experiment_id, { variantId: a.variant_id, variantName, baseline, decidedAt: a.decided_at, summary: adoptionSummary(a.variant_id, snap) });
  }
  return out;
}

/** B77(K8): オリジナルのパターンへの変更の保存 */
const variantOriginal = () =>
  new ApiError(422, "variant_original", {
    message: "オリジナルのパターンには変更を保存できません",
    hint: "オリジナルは元のページをそのまま表示します。変更を加えるときは、オリジナルを外すか別のパターンに保存してください",
  });

/**
 * B69(spec §6.2.1): 開始・再開の CAS の前の、外したページの条件の検査。エクスペリエンスの行は状態の変更の処理が読んだものを使い、
 * 配信条件に無ければ、参照するオーディエンスがあるときだけ、その定義を同じサイトから 1 回(`IN`)読む。D1 の読みは 0〜1 回
 */
async function assertNoMovedPageConditions(db: Db, site: SiteRow, exp: ExperimentRow): Promise<void> {
  if (exp.targeting_json === null) return;
  const targeting: unknown = JSON.parse(exp.targeting_json);
  assertNoRemovedPageCondition(targeting, {});
  const refs = targetingReferences(targeting).audiences;
  if (refs.length === 0) return;
  const rows = await db
    .selectFrom("audiences")
    .select(["id", "definition_json"])
    .where("site_id", "=", site.id)
    .where("id", "in", sql<string>`(select value from json_each(${JSON.stringify(refs)}))`)
    .execute();
  assertNoRemovedPageCondition(targeting, Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.definition_json) as unknown])));
}

const DuplicateBody = z
  .strictObject({
    mode: z.enum(["same", "variant"]).describe(
      "same = 同じ内容(種別・すべてのパターンと設定。テストは評価計画も初期値として写す)の下書き。variant = 選んだパターンだけを表示するパーソナライズの下書き(配信率 100%・割当の固定 off)。variant の変更は、テストで実際に配信していた中身(配信を確かめた定義。終了したテストは終了の直前のもの)を写し、保存したが公開していない編集は入れない。配信を確かめた定義が無ければ保存済みの変更を写す",
    ),
    variantId: z.string().optional().describe("mode が variant のとき必須。表示するパターンの ID"),
    id: ExperimentId.optional().describe("新しいエクスペリエンス ID。省略時は <元の ID>-copy、-copy-2 … の空いているもの。new と constructor は使えない"),
    name: ExperimentName.optional().describe("省略時は「<元の名前> のコピー」または「<元の名前>(<パターン名> だけを表示)」"),
  })
  .refine((b) => b.mode !== "variant" || b.variantId !== undefined, { message: "variantId is required when mode is variant", path: ["variantId"] });
const StatusBody = z.strictObject({
  expectDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  status: z.enum(["running", "paused", "archived"]),
  adoption: AdoptionInputSchema.optional().describe("テストを終了する(archived)ときだけ: 採用の記録。パーソナライズと、終了以外の遷移には付けられない(422 adoption_not_allowed)"),
});
const StatusResponseSchema = z.object({
  experiment: ExperimentJsonSchema,
  publish: PublishResultSchema,
  warnings: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .describe(
      "遷移は成功したが知らせたいこと(いつも配列。無ければ空)。結果を記録しないテストを開始したときは path = results、計測用のデータベースの容量の見込みが 80% を超えるときは path = resultsCapacity、テストの終了でパターンに未公開の編集があったときは path = variants.<パターン ID>.changes",
    ),
  results: z
    .object({ recorded: z.boolean() })
    .optional()
    .describe(
      "テストを終了したときだけ: 結果の記録と採用の記録ができたか。false のときは状態の変更は済んでおり、結果の記録は自動で作り直す。公開の結果は publish.ok で確認する。採用は PUT …/adoption で記録し直す",
    ),
});
/** D9 ③(K16、設計書 §8.2): 終了したテストのパターンに未公開の変更があった(配信していたのは変更の前の中身) */
const unpublishedChangesWarning = (variantId: string, name: string) => ({
  path: `variants.${variantId}.changes`,
  message: `パターン「${name}」に未公開の編集があります。テストで配信したのは編集の前の中身です`,
});
/** D9 ②(設計書 §5.2): 結果を記録しないテストの開始で応答に足す警告。拒否はしない(画面は確認のモーダルで出す) */
const RESULTS_NOT_RECORDED = { path: "results", message: "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません" };

/** spec §13.9: Experiment 単位の「未公開の変更」。Site の最終 Publish 時刻より後に触られていれば未公開 */
export const isUnpublished = (exp: ExperimentRow, site: Pick<SiteRow, "last_activated_at">): boolean => exp.updated_at > (site.last_activated_at ?? 0);

async function loadExperiment(db: Db, siteId: string, eid: string): Promise<ExperimentRow> {
  const row = await db.selectFrom("experiments").selectAll().where("site_id", "=", siteId).where("id", "=", eid).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

export async function loadVariants(db: Db, siteId: string, eid: string): Promise<VariantRow[]> {
  return db.selectFrom("variants").selectAll().where("site_id", "=", siteId).where("experiment_id", "=", eid).orderBy("position").execute();
}

const variantJson = (v: VariantRow) => ({
  id: v.id,
  name: v.name,
  weight: v.weight,
  original: v.original === 1,
  description: v.description,
  analytics: v.analytics_json ? (JSON.parse(v.analytics_json) as VariantAnalytics) : null,
});

/** B77(K8): パターンがオリジナルである(`variants as ov` の副問い合わせ)。PUT …/changes の条件付きの DELETE と親の更新の条件に使う */
const variantIsOriginal = (siteId: string, eid: string, vid: string) => (eb: ExpressionBuilder<Tables, any>) =>
  eb.exists(eb.selectFrom("variants as ov").select("ov.id").where("ov.site_id", "=", siteId).where("ov.experiment_id", "=", eid).where("ov.id", "=", vid).where("ov.original", "=", 1));

const parseVariantAnalytics = (v: VariantRow): VariantAnalytics | undefined => (v.analytics_json ? (JSON.parse(v.analytics_json) as VariantAnalytics) : undefined);
const parseExperimentAnalytics = (e: ExperimentRow): ExperimentAnalytics | undefined => (e.analytics_json ? (JSON.parse(e.analytics_json) as ExperimentAnalytics) : undefined);

/**
 * D1 は 1 文あたりのバインドパラメータ数に 100 の上限がある(公式 docs "too many SQL variables")。
 * changes の多行 INSERT は 1 行 12 パラメータなので、9 行目で単一の INSERT 文だと上限を超えて 500 になる
 * (Task 13 の E2E で発覚)。ここで行を 8 行ずつ(12 × 8 = 96 < 100)に分け、複数の INSERT 文として
 * 同じ `env.DB.batch([...])` に積む — batch 全体は変わらず 1 トランザクションのままなので、
 * どこかの分割 INSERT だけが失敗しても delete 側も含めて丸ごとロールバックされる
 */
function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** 決定 51(設計書 §3.1): テストは 2 つ以上、パーソナライズはちょうど 1 つ。重みの合計 100 は別の検査(variant_weights_invalid) */
function assertVariantCount(kind: ExperimentKind, count: number): void {
  if (kind === "single" ? count === 1 : count >= 2) return;
  throw new ApiError(422, "variant_count_invalid", {
    kind,
    count,
    message: kind === "single" ? "パーソナライズのパターンは 1 つだけです" : "テストのパターンは 2 つ以上必要です",
    hint: kind === "single" ? "パターンを比べるときは、種別「テスト」のエクスペリエンスを作成してください" : "パターンを 2 つ以上にしてください",
  });
}

// spec §13.1: 子(Variant / Change / analytics)への書込みは親 Experiment の updated_at / updated_by を必ず更新する
// → 各 PUT の batch の最後の文で行う(別トランザクションにしない)

experimentRoutes.get(
  "/sites/:sid/experiments",
  describeRoute({
    tags: ["experiments"],
    summary: "サイトのエクスペリエンス一覧(閲覧者以上)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "エクスペリエンス一覧", content: { "application/json": { schema: resolver(z.array(ExperimentListItemSchema)) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const rows = await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    const adoptions = await listAdoptions(db, site.id);
    return c.json(rows.map((r) => ({ ...experimentJson(r, { unpublished: isUnpublished(r, site) }), adoption: adoptions.get(r.id) ?? null })));
  },
);

experimentRoutes.post(
  "/sites/:sid/experiments",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを作成(編集者以上)。テストの既定は A パターン(オリジナル)/ B パターン(ID a / b、重み 50 / 50)、パーソナライズは A パターン(ID a、重み 100)を自動作成する",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成したエクスペリエンス", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", ExperimentCreate, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "targeting");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const body = c.req.valid("json");
    const db = c.get("db");
    if (await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst()) {
      throw new ApiError(409, "id_taken", { id: body.id, message: "このエクスペリエンス ID は既に使われています", hint: "別の ID を指定してください" });
    }
    if ((await retiredIds(db, site.id)).has(body.id)) throw retiredIdTaken(body.id);
    assertName(body.name, ["name"]);
    if (body.description !== undefined) assertDescription(body.description, ["description"]);
    assertAnalyticsValues(body.analytics, null, ["analytics"]);
    const urlMatch = normalizedUrlMatch(body.urlMatch, ["urlMatch"]);
    const targeting = normalizedTargeting(body.targeting ?? null, "experiment", "targeting");
    await assertTargetingRefs(db, site, targeting, "targeting");
    // 決定 51(設計書 §3.1): テストは A / B(50:50)、パーソナライズは A(重み 100)を 1 つ。
    // B77(K8、設計書 Q6): テストの A はオリジナル(元のページ)。パーソナライズはオリジナルを持たない
    const defaults =
      body.kind === "single"
        ? [{ id: "a", name: "A", weight: 100, original: 0 }]
        : [{ id: "a", name: "A", weight: 50, original: 1 }, { id: "b", name: "B", weight: 50, original: 0 }];
    assertExperimentAnalytics({ id: body.id, name: body.name, analytics: body.analytics ?? undefined }, defaults);
    const now = Date.now();
    const user = c.get("user").id;
    const row: ExperimentRow = {
      site_id: site.id,
      id: body.id,
      name: body.name,
      kind: body.kind,
      status: "draft",
      published_status: null,
      url_match_json: JSON.stringify(urlMatch),
      targeting_json: targeting ? JSON.stringify(targeting) : null,
      traffic_percentage: body.trafficPercentage,
      persist_assignment: body.persistAssignment ? 1 : 0,
      analytics_json: body.analytics ? JSON.stringify(body.analytics) : null,
      started_at: null,
      stopped_at: null,
      last_started_at: null,
      run_id: null,
      results_purged_at: null,
      description: body.description ?? "",
      created_by: user,
      updated_by: user,
      created_at: now,
      updated_at: now,
      // B129(Q14・Q29): エクスペリエンスの世代(同じ ID で作り直すと新しい値)
      generation: crypto.randomUUID(),
    };
    // Experiment 行と既定 Variant を 1 batch = 1 トランザクションで書く(片方だけ残らない)。
    // B129: 同じ batch の insert の後に experiment.create を記録する(無条件。世代は insert と同じ値)
    await c.env.DB.batch([
      toStatement(c.env, db.insertInto("experiments").values(row)),
      toStatement(
        c.env,
        db.insertInto("variants").values(
          defaults.map((v, i) => ({ site_id: site.id, experiment_id: row.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: null, original: v.original, description: "" })),
        ),
      ),
      experimentAudit(
        c,
        site,
        row.id,
        { action: "experiment.create", target: { type: "experiment", id: row.id, label: row.name }, detail: { kind: row.kind }, generation: { experiment: row.generation } },
        { now },
      ),
    ]);
    return c.json(experimentJson(row, { unpublished: true }), 201);
  },
);

experimentRoutes.get(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを 1 件取得(閲覧者以上)。パターンと変更を含む",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "エクスペリエンス(パターン / 変更付き)", content: { "application/json": { schema: resolver(ExperimentDetailJsonSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const variants = await loadVariants(db, site.id, exp.id);
    const changes = await db
      .selectFrom("changes")
      .selectAll()
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .orderBy("position")
      .execute();
    return c.json({
      ...experimentJson(exp, { unpublished: isUnpublished(exp, site) }),
      variants: variants.map((v) => ({
        ...variantJson(v),
        changes: changes
          .filter((ch) => ch.variant_id === v.id)
          .map((ch) => ({
            id: ch.id,
            type: ch.type,
            ...(ch.selector ? { selector: ch.selector } : {}),
            payload: JSON.parse(ch.payload_json),
            updatedBy: ch.updated_by,
            updatedAt: ch.updated_at,
          })),
      })),
    });
  },
);

experimentRoutes.patch(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary:
      "エクスペリエンスを更新(編集者以上)。id は不変、status は変更できない(status は /status で変更する)。メモ(description)だけの更新は状態にかかわらず可で、公開の対象にならない。テストの開始後は配信率を下げる・割当の固定を変えると 409 test_setting_locked、終了したテストはメモ以外 409 experiment_archived_readonly",
    description: "保存だけでは訪問者への配信は変わらない。次のサイトの公開、または同じサイトのエクスペリエンスの開始・再開・一時停止・終了による自動公開で、配信中のエクスペリエンスの保存済み編集とサイト共通の目標・オーディエンスが一緒に反映される。開始後のテストの結果は変更の前と後を合算する。大きく変える場合は複製して新しいテストを開始する。メモだけの更新は公開の対象にならない。",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のエクスペリエンス", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", ExperimentPatch, (r) => {
    if (!r.success) throw targetingValidationFailed(r.data, r.error, "targeting");
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    const keys = Object.keys(body);
    // D9 ③(K10、設計書 §5.5): 開始後のテストは配信率を下げる・割当の固定を変えると 409、終了したテストはメモ以外 409
    assertTestEditable(exp, { trafficPercentage: body.trafficPercentage, persistAssignment: body.persistAssignment, keys });
    if (body.description !== undefined) assertDescription(body.description, ["description"]);
    // B77(K9、設計書 Q26〜Q29): メモだけの更新は config に出ないので、updated_at / updated_by を進めない(未公開の印を付けない)。
    // 状態も問わない(終了したエクスペリエンスにも経緯を書ける)。外部計測の検査も、何も変わらないので通さない
    if (isMemoOnly(keys)) {
      // B129: 1 文の更新を、experiment.memo の記録(前に置く。条件 = 同じ行があること。メモの本文は持たない)との 2 文の batch にする(往復は 1 回のまま)
      const target = thisExperiment(site.id, exp.id);
      await c.env.DB.batch([
        experimentAudit(c, site, exp.id, { action: "experiment.memo", target: { type: "experiment" }, targetFrom: experimentTarget(target), detail: {} }),
        toStatement(c.env, db.updateTable("experiments").set({ description: body.description }).where(target)),
      ]);
      const next: ExperimentRow = { ...exp, description: body.description! };
      return c.json(experimentJson(next, { unpublished: isUnpublished(next, site) }));
    }
    // 触る列だけを set に積む(status / published_status / started_at / stopped_at は Task 6 / 7 の帳簿。
    // 読んだ行をまるごと書き戻すと、並行する status 変更を古い値で潰しうる)
    const now = Date.now();
    const set: Partial<ExperimentRow> = { updated_at: now, updated_by: c.get("user").id };
    if (body.name !== undefined) {
      assertName(body.name, ["name"]);
      set.name = body.name;
    }
    if (body.urlMatch !== undefined) set.url_match_json = JSON.stringify(normalizedUrlMatch(body.urlMatch, ["urlMatch"]));
    if (body.targeting !== undefined) {
      const targeting = normalizedTargeting(body.targeting, "experiment", "targeting");
      await assertTargetingRefs(db, site, targeting, "targeting");
      set.targeting_json = targeting ? JSON.stringify(targeting) : null;
    }
    if (body.trafficPercentage !== undefined) set.traffic_percentage = body.trafficPercentage;
    if (body.persistAssignment !== undefined) set.persist_assignment = body.persistAssignment ? 1 : 0;
    if (body.analytics !== undefined) {
      assertAnalyticsValues(body.analytics, parseExperimentAnalytics(exp) ?? null, ["analytics"]);
      set.analytics_json = body.analytics ? JSON.stringify(body.analytics) : null;
    }
    if (body.description !== undefined) set.description = body.description;
    const next: ExperimentRow = { ...exp, ...set };
    const variants = await loadVariants(db, site.id, exp.id);
    assertExperimentAnalytics(
      { id: next.id, name: next.name, analytics: parseExperimentAnalytics(next) },
      variants.map((v) => ({ id: v.id, name: v.name, analytics: parseVariantAnalytics(v) })),
    );
    // D9 ③(K10): 読んだ後の状態の変化も書き込みの条件で弾く(読んだ状態のまま・終了したテストでない。テストは加えて
    // 配信率は今の値以上・割当の固定は今の値のまま。下書きは下げても変えてもよい)。0 行なら読み直して該当の 409。
    // パーソナライズは編集できる中身は今のまま(状態の割り込みだけ 409 conflict になる)。
    // batch で書くのは、割り込みのテストが beforeD1Batch で差し込めるようにするため。
    // B129: 更新の文の前に experiment.update を記録する(条件は更新の文と同じ experimentPatchWritable。前の値を同じ文で読む)。
    // detail = 送った欄のうち値が変わった欄の名前と、名前・配信率・割当の固定の前後(変わった欄だけ)。比べるのは記録の文の中の今の行(t)と
    // 書く値(set)。読んだ行(exp)と鍵の順だけが違う JSON も変わらずに数える。変わった欄が無ければ fields: [](updated_at は進む)
    const writable = experimentPatchWritable(exp, { trafficPercentage: body.trafficPercentage, persistAssignment: body.persistAssignment });
    const sent = PATCH_FIELDS.filter((f) => body[f.key] !== undefined);
    const changes: AuditFieldChange[] = sent.map((f) => {
      const nextValue = set[f.col] as AuditColumnValue;
      const same = "json" in f ? sameJsonText : undefined;
      const changed = auditChanged(sql`t.${sql.ref(f.col)}`, unchangedValues(nextValue, exp[f.col] as AuditColumnValue, same));
      return "fromTo" in f ? { key: f.key, changed, fromTo: auditFromTo(f.fromTo, "bool" in f ? nextValue === 1 : nextValue) } : { key: f.key, changed };
    });
    const cols = sql.join(sent.map((f) => sql`, ${sql.ref(f.col)}`), sql``);
    const [, written] = await c.env.DB.batch([
      experimentAudit(
        c,
        site,
        exp.id,
        { action: "experiment.update", target: { type: "experiment" }, targetFrom: experimentTarget(writable, cols), detail: changedFieldsDetail(changes) },
        { now },
      ),
      toStatement(c.env, db.updateTable("experiments").set(set).where(writable)),
    ]);
    if ((written?.meta.changes ?? 0) === 0) {
      const fresh = await loadExperiment(db, site.id, exp.id);
      assertTestEditable(fresh, { trafficPercentage: body.trafficPercentage, persistAssignment: body.persistAssignment, keys });
      // 状態が変わったが、今の状態でも受けられる編集だった(例: 下書きとして読んだ後に開始され、配信率を上げる編集)。
      // 読み直した値で検査し直していないほかの欄があるので、書かずに読み直しを求める
      throw new ApiError(409, "conflict", { hint: "別の操作と競合しました。画面を読み込み直してください" });
    }
    return c.json(experimentJson(next, { unpublished: isUnpublished(next, site) }));
  },
);

experimentRoutes.delete(
  "/sites/:sid/experiments/:eid",
  describeRoute({
    tags: ["experiments"],
    summary:
      "エクスペリエンスを削除(編集者以上)。draft / archived のみ(archived にしても、終了の公開が済まず publishedStatus が running / paused の間は 409 experiment_active)。一度開始したエクスペリエンスの ID は、削除した後もこのサイトでは作成・複製に使えない。テストの結果の記録・採用・評価計画の変更の履歴も消え、計測用のデータベースの参加者ごとの記録は削除の直後から順に消す(大きなテストは数日かかる)",
    security: [{ bearer: [] }],
    responses: { 204: { description: "削除した" }, ...errorResponses(401, 403, 404, 409) },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    // 7n(G31 (b)): 望む状態(status)が下書きか終了でも、配信中の状態の写し(published_status)が running / paused なら消さない
    // (終了の公開が失敗している間は、まだ訪問者に配っている)。published_status は一度も公開していないと NULL
    if (isLive(exp.status)) throw experimentActive();
    if (isLive(exp.published_status)) throw experimentStillPublished();
    // D9 ②(設計書 §6.3、K16): 一度開始した(started_at がある)ものは ID を退役させる。読んだ行ではなく D1 の中の行で判定し、
    // 削除と同じ batch = 1 トランザクションで書く(退役の記録だけ・削除だけが残らない)。
    // D9 ③(K6 (1)): 削除の DELETE の前に、run_id を持つものを計測用 D1 の削除待ち(results_purge_queue)に積む。
    // 3 文とも「下書きか終了」を条件にする(読んだ後に開始されたら、退役・積む・削除のどれもしない = 配信中のテストを消さない)
    // B129: 4 文の前に experiment.delete を記録する(条件は削除の文と同じ deletableRow。名前と世代は消える前の行から読む)
    const now = Date.now();
    const deletable = ["draft", "archived"] as const;
    // 7n(G31 (b)): batch の各文も「配っていない」を条件にする。`not in` だけだと NULL(一度も公開していない)の行が消せなくなる
    const notPublished = (eb: ExpressionBuilder<Tables, "experiments">) =>
      eb.or([eb("experiments.published_status", "is", null), eb("experiments.published_status", "not in", ["running", "paused"])]);
    const deletableRow = (eb: ExpressionBuilder<Tables, "experiments">) => eb.and([thisExperiment(site.id, exp.id)(eb), eb("experiments.status", "in", deletable), notPublished(eb)]);
    const [, , , , deleted] = await c.env.DB.batch([
      experimentAudit(c, site, exp.id, { action: "experiment.delete", target: { type: "experiment" }, targetFrom: experimentTarget(deletableRow), detail: {} }, { now }),
      toStatement(
        c.env,
        db
          .insertInto("retired_experiment_ids")
          .columns(["site_id", "experiment_id", "retired_at"])
          .expression((eb) =>
            eb
              .selectFrom("experiments")
              .select((s) => ["site_id", "id", s.val(now).as("retired_at")])
              .where("site_id", "=", site.id)
              .where("id", "=", exp.id)
              .where("status", "in", deletable)
              .where(notPublished)
              .where("started_at", "is not", null),
          )
          .onConflict((oc) => oc.doNothing()),
      ),
      toStatement(c.env, enqueuePurgeQuery(db, { kind: "experiment", siteId: site.id, experimentId: exp.id }, now)),
      // D9 ③(K11・K17): run を持つものを消すと、KV の締め切りの表に残った項目を外す必要がある。results-collect-until が訪ねるよう印を立てる
      // (Site にほかの run が無いと Cron の対象にならないため。消し始めの waitUntil が queue を消し終えても印は残る)
      toStatement(
        c.env,
        db
          .updateTable("sites")
          .set({ collect_until_dirty: 1 })
          .where("id", "=", site.id)
          .where((w) =>
            w.exists(
              w.selectFrom("experiments").select("experiments.id").where("experiments.site_id", "=", site.id).where("experiments.id", "=", exp.id).where("experiments.status", "in", deletable).where(notPublished).where("experiments.run_id", "is not", null),
            ),
          ),
      ),
      toStatement(c.env, db.deleteFrom("experiments").where(deletableRow)), // variants / changes は CASCADE
    ]);
    if ((deleted?.meta.changes ?? 0) === 0) {
      // 読んだ後に別の要求が開始した(または先に削除した)
      const fresh = await db.selectFrom("experiments").select(["status", "published_status"]).where("site_id", "=", site.id).where("id", "=", exp.id).executeTakeFirst();
      if (!fresh) throw notFound();
      if (!isLive(fresh.status) && isLive(fresh.published_status)) throw experimentStillPublished();
      throw experimentActive();
    }
    // K6・K12: 応答の後に 1 回だけ個票を消し始める(残り・枠の無い日・停止中は Cron が queue から消す)
    if (exp.run_id !== null) {
      const purge = kickOffPurge(c.env, site.id, exp.run_id, now);
      if (purge) c.executionCtx.waitUntil(purge);
    }
    return c.body(null, 204);
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants",
  describeRoute({
    tags: ["experiments"],
    summary:
      "パターンの集合を全置換(編集者以上)。テストは 2 つ以上、パーソナライズは 1 つ。weight の合計 100。残るパターンの変更は保持される(オリジナルにしたパターンの変更は消す)。original / description を省いたパターンは保存済みの値を保つ。下書きのときだけ可",
    description: "保存だけでは訪問者への配信は変わらない。次のサイトの公開、または同じサイトのエクスペリエンスの開始・再開・一時停止・終了による自動公開で、配信中のエクスペリエンスの保存済み編集とサイト共通の目標・オーディエンスが一緒に反映される。開始後のテストの結果は変更の前と後を合算する。大きく変える場合は複製して新しいテストを開始する。",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "置換した", content: { "application/json": { schema: resolver(z.object({ ok: z.literal(true) })) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", VariantsPut, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    // D9 ③(K10): 終了したテストは読み取り専用(コードを分ける。ほかの下書き以外は下の experiment_active のまま)
    assertNotArchivedTest(exp);
    // spec §7.2: Variant の id / 重みは割当ハッシュの入力。running / paused の間に全置換すると配信中の訪問者を
    // 無言で再バケットしてしまう。archived は復帰不可(TRANSITIONS.archived = [])なので「Stop してから編集」という
    // 案内は行き止まりになる — さらに archived な Experiment の variant id は過去の analytics イベントが参照している
    // 履歴データでもあるので、そこを書き換えるのは「配信中の再バケット」とは別の理由で危険。
    // どちらも draft でしか安全に編集できないので、許可するのは draft のときだけにする(レビュー指摘で running/paused
    // のみの guard から拡張。同じ 409 experiment_active を流用 — code の分割は最終レビューに持ち越し)
    if (exp.status !== "draft") throw variantsLocked();
    const body = c.req.valid("json");
    const ids = new Set(body.map((v) => v.id));
    if (ids.size !== body.length) throw new ApiError(422, "duplicate_variant_id", { message: "パターン ID が重複しています" });
    assertVariantCount(exp.kind, body.length);
    const sum = body.reduce((a, v) => a + v.weight, 0);
    if (sum !== 100) throw new ApiError(422, "variant_weights_invalid", { message: `重みの合計は 100 である必要があります(現在 ${sum})`, sum });
    for (const v of body) {
      assertName(v.name, ["variants", v.id, "name"]);
      if (v.description !== undefined) assertDescription(v.description, ["variants", v.id, "description"]);
      // B77(K8、設計書 Q7): パーソナライズは選んだパターンを全員に見せるもので、元のページを見せるパターンは意味を持たない
      if (exp.kind === "single" && v.original === true)
        throw new ApiError(422, "original_not_allowed", {
          path: ["variants", v.id, "original"],
          message: "パーソナライズのパターンはオリジナルにできません",
          hint: "オリジナルはテストのパターンだけに使えます",
        });
    }
    // B77(K12): 比べる保存済みの値は同じ ID のパターンのもの(新しいパターンは null)
    const stored = new Map((await loadVariants(db, site.id, exp.id)).map((v) => [v.id, parseVariantAnalytics(v) ?? null]));
    for (const v of body) assertAnalyticsValues(v.analytics, stored.get(v.id) ?? null, ["variants", v.id, "analytics"]);
    assertExperimentAnalytics(
      { id: exp.id, name: exp.name, analytics: parseExperimentAnalytics(exp) },
      body.map((v) => ({ id: v.id, name: v.name, analytics: v.analytics ?? undefined })),
    );
    const now = Date.now();
    // 消える Variant の Change は CASCADE で消え、残る Variant の Change は保持される(id で突き合わせ)。
    // D1 batch で 1 トランザクション(途中で失敗しても集合が壊れない)
    const analyticsJson = (v: (typeof body)[number]) => (v.analytics ? JSON.stringify(v.analytics) : null);
    // B77(K8): original / description は指定したときだけ doUpdateSet に入れる。省いたら既存の行の値を保ち(読んで埋めない。
    // 読んでから書くまでに PATCH …/variants/:vid が書いたメモを古い値で潰さない)、新しい行は列の既定値と同じ 0 / '' で入る。
    // 1 文のバインドは最大 18(values 9 + 親の条件 3 + doUpdateSet 6)で、D1 の上限 100 より十分小さい
    const flags = (v: (typeof body)[number]) => ({
      ...(v.original !== undefined ? { original: v.original ? 1 : 0 } : {}),
      ...(v.description !== undefined ? { description: v.description } : {}),
    });
    // オリジナルにしたパターンの変更は同じ batch で消す(設計書 Q5)。対象はこのエクスペリエンスのパターンだけ
    const originalIds = body.filter((v) => v.original === true).map((v) => v.id);
    // D9 ③(K10): 各文に「親が下書きのまま」を条件に付ける(読んだ後に開始されたら、どの行も変えない)。
    // upsert は INSERT … SELECT … WHERE EXISTS の形にする(条件が偽なら行が出ず、ON CONFLICT も起きない)
    const isDraft = parentIsDraft(site.id, exp.id);
    const variantCols = ["site_id", "experiment_id", "id", "name", "weight", "position", "analytics_json", "original", "description"] as const;
    // B129: 全置換の前に experiment.variants を記録する(条件は各文と同じ parentIsDraft。前の名前と重みは同じ文で variants から位置の順に読む)
    const before = (col: "substr(name, 1, 200)" | "weight") =>
      sql`json((select json_group_array(v) from (select ${sql.raw(col)} as v from variants where site_id = ${site.id} and experiment_id = ${exp.id} order by position)))`;
    const results = await c.env.DB.batch([
      experimentAudit(
        c,
        site,
        exp.id,
        {
          action: "experiment.variants",
          target: { type: "experiment" },
          targetFrom: experimentTarget(thisExperiment(site.id, exp.id)),
          detail: {
            from: before("substr(name, 1, 200)"),
            to: body.map((v) => v.name),
            weights: sql`json(json_object('from', ${before("weight")}, 'to', json(${JSON.stringify(body.map((v) => v.weight))})))`,
          },
        },
        { guard: isDraft(anyEb), now },
      ),
      toStatement(c.env, db.deleteFrom("variants").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("id", "not in", [...ids]).where(isDraft)),
      ...body.map((v, i) => {
        const row = { site_id: site.id, experiment_id: exp.id, id: v.id, name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v), original: v.original ? 1 : 0, description: v.description ?? "" };
        return toStatement(
          c.env,
          db
            .insertInto("variants")
            .columns([...variantCols])
            .expression(db.selectNoFrom((s) => variantCols.map((col) => s.val(row[col]).as(col))).where(isDraft))
            .onConflict((oc) =>
              oc.columns(["site_id", "experiment_id", "id"]).doUpdateSet({ name: v.name, weight: v.weight, position: i, analytics_json: analyticsJson(v), ...flags(v) }),
            ),
        );
      }),
      ...(originalIds.length > 0
        ? [toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "in", originalIds).where(isDraft))]
        : []),
      toStatement(
        c.env,
        db.updateTable("experiments").set({ updated_at: now, updated_by: c.get("user").id }).where("site_id", "=", site.id).where("id", "=", exp.id).where("status", "=", "draft"),
      ),
    ]);
    if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
      // 読んだ後に開始された(または削除された)。子の行も変わっていない
      const fresh = await loadExperiment(db, site.id, exp.id);
      assertNotArchivedTest(fresh);
      throw variantsLocked();
    }
    return c.json({ ok: true });
  },
);

experimentRoutes.put(
  "/sites/:sid/experiments/:eid/variants/:vid/changes",
  describeRoute({
    tags: ["experiments"],
    summary:
      "パターンの変更を全置換(編集者以上)。1 件でも保存時検証に落ちれば何も書かない。オリジナルのパターンには変更を保存できない(空配列は受けて何もしない)。終了したテストには保存できない(空配列も 409 experiment_archived_readonly)",
    description: "保存だけでは訪問者への配信は変わらない。次のサイトの公開、または同じサイトのエクスペリエンスの開始・再開・一時停止・終了による自動公開で、配信中のエクスペリエンスの保存済み編集とサイト共通の目標・オーディエンスが一緒に反映される。開始後のテストの結果は変更の前と後を合算する。大きく変える場合は複製して新しいテストを開始する。",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "置換した", content: { "application/json": { schema: resolver(z.object({ ok: z.literal(true), count: z.number().int() })) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  // B154: この経路だけ既定(1MiB)より大きい上限。入口では掛けず、ログインを確かめた後・本文の解析の前に掛ける(body-limit.ts)
  changesPutBodyLimit,
  validator("json", ChangesPut, (r) => {
    if (r.success) return;
    // 件数超過だけは専用コード(zod の issue message に "too_many_changes" を入れて見分ける)
    if (r.error.some((i) => i.message === "too_many_changes")) {
      throw new ApiError(422, "too_many_changes", {
        max: MAX_CHANGES_PER_VARIANT,
        message: `変更は 1 パターンあたり ${MAX_CHANGES_PER_VARIANT} 件までです`,
        hint: "変更を分割するか、不要な変更を削除してください",
      });
    }
    throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    // D9 ③(K10): 終了したテストは読み取り専用(実行中・一時停止中のテストは今のとおり保存できる。設計書 §5.5)。
    // 下のオリジナルへの空配列を受ける規則(B77 の K8)より先に見るので、終了したテストへは空配列も 409
    assertNotArchivedTest(exp);
    const vid = c.req.param("vid");
    const variant = await db
      .selectFrom("variants")
      .select(["id", "original"])
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("id", "=", vid)
      .executeTakeFirst();
    if (!variant) throw notFound();
    const raw = c.req.valid("json");
    // B77(K8): オリジナルは変更を持たない。空配列は受けて何もしない(エージェントや deploy の途中の古い管理画面が全パターンに [] を送っても失敗させない)
    if (variant.original === 1) {
      if (raw.length === 0) return c.json({ ok: true, count: 0 });
      throw variantOriginal();
    }
    // 全件を検証してから書く(1 件でも不正なら何も書かない)
    const changes: Change[] = raw.map((r, i) => parseChange(c.env, site.id, r, i));
    const ids = new Set(changes.map((ch) => ch.id));
    if (ids.size !== changes.length) throw new ApiError(422, "duplicate_change_id", { message: "変更の ID が重複しています" });
    for (const ch of changes)
      if (!SLUG_RE.test(ch.id)) throw new ApiError(422, "invalid_change_id", { changeId: ch.id, message: `変更の ID(${ch.id})の形式が不正です(スラッグのみ)` });
    // B68 spec §4.5: IMAGE は画像の一覧と照らす(IMAGE がある保存だけ D1 を 1 回)。書く前に断り、下の batch とその例外の扱いは変えない
    await assertImageAssetsExist(db, c.env, site.id, changes);
    const now = Date.now();
    const user = c.get("user").id;
    const existing = await db
      .selectFrom("changes")
      .select(["id", "created_by", "created_at"])
      .where("site_id", "=", site.id)
      .where("experiment_id", "=", exp.id)
      .where("variant_id", "=", vid)
      .execute();
    const prev = new Map(existing.map((e) => [e.id, e]));
    // 行ごとに違う 7 列(残りの 5 列 site_id / experiment_id / variant_id / updated_by / updated_at は全行で同じなので、下の外側の SELECT で 1 回だけ渡す)
    const changeRows = changes.map((ch, i) => ({
      id: ch.id,
      type: ch.type,
      selector: "selector" in ch ? ch.selector : null,
      payload_json: JSON.stringify(ch.payload),
      position: i,
      created_by: prev.get(ch.id)?.created_by ?? user,
      created_at: prev.get(ch.id)?.created_at ?? now,
    }));
    // D9 ③(K10): batch の各文に「親が終了したテストでない」を条件に付ける(読んだ後に終了されたら、変更の行も親の帳簿も変えない)。
    // INSERT は INSERT … SELECT … FROM (VALUES …) WHERE EXISTS の形にする(条件は外側の WHERE に 1 回だけ置く)。
    // UNION ALL で行を並べないのは、D1 が compound SELECT の項の数を小さく制限しているため(8 行で "too many terms in compound SELECT")。
    // 複数行の VALUES はこの制限の外(SQLite の multi-row VALUES)。VALUES の列の名前は column1 … column7
    const notArchived = parentNotArchivedTest(site.id, exp.id);
    const rowCols = ["id", "type", "selector", "payload_json", "position", "created_by", "created_at"] as const;
    const insertChunk = (rows: typeof changeRows) => {
      const values = sql`(values ${sql.join(rows.map((r) => sql`(${sql.join(rowCols.map((col) => r[col]))})`))})`;
      return db
        .insertInto("changes")
        .columns(["site_id", "experiment_id", "variant_id", ...rowCols, "updated_by", "updated_at"])
        .expression(
          db
            .selectFrom(values.as("r"))
            .select((s) => [
              s.val(site.id).as("site_id"),
              s.val(exp.id).as("experiment_id"),
              s.val(vid).as("variant_id"),
              ...rowCols.map((col, i) => sql.ref(`r.column${i + 1}`).as(col)),
              s.val(user).as("updated_by"),
              s.val(now).as("updated_at"),
            ])
            .where(notArchived),
        );
    };
    // D1 batch で 1 トランザクション(途中で失敗しても集合が壊れない)。
    // 8 行ずつに分けた複数の INSERT 文として積む(上のコメント参照。1 文のバインドは 7 × 8 + 外側 5 + 親の条件 4 = 65)
    const inserts = chunk(changeRows, 8).map((rows) => toStatement(c.env, insertChunk(rows)));
    const isOriginal = variantIsOriginal(site.id, exp.id, vid);
    // B129: 全置換の前に experiment.changes を記録する(条件は各文と同じ notArchived と、オリジナルでない = 親の帳簿の文と同じ variantIsOriginal の否定。
    // 422 の分岐で書かない)。前の件数は同じ文で changes から数え、後の件数と種類ごとの数は検証した要求から作る(中身は持たない)
    const types: Record<string, number> = {};
    for (const ch of changes) types[ch.type] = (types[ch.type] ?? 0) + 1;
    const results = await c.env.DB.batch([
      experimentAudit(
        c,
        site,
        exp.id,
        {
          action: "experiment.changes",
          target: { type: "variant" },
          targetFrom: variantTarget(site.id, exp.id, vid),
          detail: {
            variant: sql`substr(t.target_label, 1, 200)`,
            from: sql`(select count(*) from changes where site_id = ${site.id} and experiment_id = ${exp.id} and variant_id = ${vid})`,
            to: changes.length,
            types,
          },
        },
        { guard: anyEb.and([notArchived(anyEb), anyEb.not(isOriginal(anyEb))]), now },
      ),
      toStatement(c.env, db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "=", vid).where(notArchived)),
      ...inserts,
      // B77(K8): 上の読みの後に同じパターンがオリジナルになっていたら(並行する PUT …/variants)、いま入れた変更を同じトランザクションで消す。
      // 最後はオリジナルに変更が残らない。消した行があれば 422 で返す(batch の後なのでロールバックにはならない)
      toStatement(
        c.env,
        db.deleteFrom("changes").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).where("variant_id", "=", vid).where(isOriginal).where(notArchived),
      ),
      // 拒否になる保存は親の帳簿(未公開の印と更新者)を変えない
      toStatement(
        c.env,
        db
          .updateTable("experiments")
          .set({ updated_at: now, updated_by: user })
          .where("site_id", "=", site.id)
          .where("id", "=", exp.id)
          .where((eb) => eb.not(isOriginal(eb)))
          .where(notArchivedTest),
      ),
    ]);
    if ((results[2 + inserts.length]?.meta.changes ?? 0) > 0) throw variantOriginal();
    if ((results[3 + inserts.length]?.meta.changes ?? 0) === 0) {
      // 親の帳簿を書けなかった: 読んだ後に終了された(変更の行も変えていない)か、オリジナルになった(空配列の保存。今のとおり何もしない)
      const fresh = await loadExperiment(db, site.id, exp.id);
      assertNotArchivedTest(fresh);
    }
    return c.json({ ok: true, count: changes.length });
  },
);

// B77(K9、設計書 Q26〜Q29): パターンのメモ。config に出ないので状態を問わず受け、親の updated_at / updated_by を進めない
experimentRoutes.patch(
  "/sites/:sid/experiments/:eid/variants/:vid",
  describeRoute({
    tags: ["experiments"],
    summary: "パターンのメモを更新(編集者以上)。状態にかかわらず可。公開の対象にならない",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "更新後のパターン", content: { "application/json": { schema: resolver(VariantJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 422),
    },
  }),
  requireSession,
  validator("json", VariantPatch, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const { description } = c.req.valid("json");
    assertDescription(description, ["description"]);
    const vid = c.req.param("vid");
    // B129: 1 文の `update … returning` を、experiment.variant_memo の記録(前に置く。条件 = 同じパターンの行があること。メモの本文は持たない)との
    // 2 文の batch にする(往復は 1 回のまま)
    const [, updated] = await c.env.DB.batch([
      experimentAudit(c, site, exp.id, {
        action: "experiment.variant_memo",
        target: { type: "variant" },
        targetFrom: variantTarget(site.id, exp.id, vid),
        detail: { variant: sql`substr(t.target_label, 1, 200)` },
      }),
      toStatement(c.env, db.updateTable("variants").set({ description }).where(thisVariant(site.id, exp.id, vid)).returningAll()),
    ]);
    const row = (updated?.results as VariantRow[] | undefined)?.[0];
    if (!row) throw notFound();
    return c.json(variantJson(row));
  },
);

/** 状態の遷移とサイトの公開を確定する。停止・終了で準備に失敗した場合は状態だけ記録する。 */
experimentRoutes.post(
  "/sites/:sid/experiments/:eid/status",
  describeRoute({
    tags: ["experiments"],
    summary:
      "エクスペリエンスの status を遷移する(管理者以上)。遷移と公開は 1 回の書き込みで一緒に確定する。開始・再開は、公開の準備(設定の作成・画像の確かめ・配信の設定の書き込み)に失敗すると状態を変えずに 409 を返す(封筒に公開の失敗のコード・message・hint・assetProblems を入れる)。一時停止・終了は、公開の準備に失敗しても状態を変え、200 の publish.ok: false で返す。結果を記録するサイトでテストの下書きを開始するときは、判定に使う目標が無い・基準の重みが 0 なら 422 evaluation_plan_incomplete で、通れば評価計画を固定する。結果を記録しないテストを開始したときは warnings で知らせる。テストの終了(archived)には採用(adoption)を付けられ、公開に成功すれば終了と公開が一緒に確定し、その後で結果と採用の記録を試みる。公開の準備に失敗して終了だけが確定した場合も、結果と採用の記録を試みる(記録の成否は results.recorded、公開の成否は publish.ok)。開始・再開は、画像の確かめに通らなければ(遷移の後に配信する内容に、見つからない画像・別のサイトの画像がある)状態を変えずに 409 asset_missing / asset_other_site を返す(封筒の assetProblems に画像の URL とそれを含む変更)。公開の準備に成功すると、一時停止・終了は画像を確かめずに状態を変えて公開する。開始・再開は、配信条件か参照するオーディエンスに、今は使えないページの条件(URL・ホスト・パス・パラメータ)が残っていれば、状態を変えずに 422 invalid_experiment_targeting を返す(対象 URL に移してから開始する)",
    description: "expectDigest(確認画面の transitionDigest)を付けると、確認画面で見た内容のときだけ状態を変えて公開する。違えば 409 stale_preview で何も変えない。確認画面を読み直して送り直す。別の公開と重なったときは状態を変えずに 409 transition_conflict を返す(一時停止・終了は 1 回だけ自動でやり直す)。公開の結果を確かめられなかったときは 503 publish_outcome_unknown を返す(公開履歴と状態を読み込み直して確かめる)",
    security: [{ bearer: [] }],
    responses: {
      200: {
        description: "遷移後のエクスペリエンスと公開の結果。一時停止・終了で公開の準備に失敗したときは publish.ok: false",
        content: { "application/json": { schema: resolver(StatusResponseSchema) } },
      },
      ...errorResponses(400, 401, 403, 404, 409, 422, 503),
    },
  }),
  requireSession,
  validator("json", StatusBody, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    if (!TRANSITIONS[exp.status].includes(body.status)) throw new ApiError(409, "invalid_transition", { from: exp.status, to: body.status });
    // B69(spec §6.2.1): 開始・再開は、外したページの条件が残っていれば状態を変えずに 422(画像の確かめの有無によらない)
    if (body.status === "running") await assertNoMovedPageConditions(db, site, exp);
    // D9 ③(K16、設計書 §8.1): 採用はテストを終了するときだけ。検査は状態を変える前に行う
    const stoppingTest = exp.kind === "test" && body.status === "archived";
    if (body.adoption !== undefined && exp.kind !== "test") throw adoptionNotAllowed(422, "パーソナライズには採用を記録しません");
    if (body.adoption !== undefined && !stoppingTest) throw adoptionNotAllowed(422, "採用はテストを終了するとき(status = archived)だけ記録できます");
    let now = Date.now();
    let adoption: { variantId: string | null; note: string } | null = null;
    let stopEstimate = 0;
    if (stoppingTest) {
      const stopVariants = await loadVariants(db, site.id, exp.id);
      if (body.adoption !== undefined) {
        // Change の無い基準は null で保存する。基準に Change があるかは終了の直前(= 今)に届いていた定義で決める
        const stopPlan = await loadPlan(db, site.id, exp, stopVariants);
        const variantId = await resolveAdoptedVariant(db, site.id, exp, stopVariants, stopPlan.plan.baselineVariantId, body.adoption.variantId, now);
        adoption = { variantId, note: body.adoption.note ?? "" };
      }
      // 記録の読み取りの見込み(保存した速報は終了の Publish で消えるので、その前に読む)
      if (exp.run_id !== null) {
        const cache = await db.selectFrom("results_interim_cache").select(["rows_read", "result_json"]).where("site_id", "=", site.id).where("experiment_id", "=", exp.id).executeTakeFirst();
        const goals = await db.selectFrom("goals").select("id").where("site_id", "=", site.id).execute();
        stopEstimate = readEstimate(cache, Math.max(0, goals.length - 1));
      }
    }
    // 決定 34: analytics-recipe の期間に使う。started_at は最初の running のみ(Pause → Resume で動かさない)、stopped_at は archived
    // D9 ②(plan ② の K14、設計書 §5.2・§6.3): 開始(draft → running)のテストで、Site が結果を記録し計測用 D1 があるときだけ run_id を振る。
    // 再開(paused → running)では振らない(run_id の無いまま一時停止していたテストも再開はできる)。
    // `where run_id is null` は付けない: draft → running は 1 回だけで、下の status の CAS が二重の発行を防ぐ
    const starting = exp.status === "draft" && body.status === "running";
    const isTest = exp.kind === "test";
    const issue = starting && isTest && exp.run_id === null && site.results_enabled === 1 && resultsStore(c.env);
    // D9 ③(K6 (2)): 下書きに run_id が既にある(今は起きない)ときは、記録しない警告を出さない
    const warnings: Array<{ path: string; message: string }> = starting && isTest && exp.run_id === null && !issue ? [RESULTS_NOT_RECORDED] : [];
    // D9 ③(K6 (2)): テストの開始は、要求の最初に読んだ Site の results_enabled のままであることも条件にする
    // (間に Site の設定が変わると、設定と合わない run_id の発行・警告になる。0 → 1 も 1 → 0 も外す)
    const siteUnchanged = starting && isTest;
    // D9 ③(K8、設計書 §5.2): 結果を記録する開始(run_id を振るとき)だけ、評価計画を検査して固定する。
    // 結果を記録しない開始・再開・パーソナライズでは検査も固定もしない(今の警告だけ)
    let plan: LoadedPlan | null = null;
    if (issue) {
      const variants = await loadVariants(db, site.id, exp.id);
      plan = await loadPlan(db, site.id, exp, variants);
      const goalIds = (await db.selectFrom("goals").select("id").where("site_id", "=", site.id).execute()).map((g) => g.id);
      assertStartable(plan.plan, variants, goalIds);
      // 容量の見込みの警告は拒否しない。CAS の前に出す(CAS の後に投げて 500 にしないため)。出せなければ警告しない
      try {
        const capacity = await capacityWarning(db, site.id, plan.plan, variants);
        if (capacity) warnings.push(capacity);
      } catch (e) {
        console.error("capacity warning failed (start continues without it)", e);
      }
    }
    const runId = issue ? newRunId() : null;
    const stampsAt = (at: number) => ({
      ...(body.status === "running" && exp.started_at === null ? { started_at: at } : {}),
      // 決定 51(K5、2026-10-06 ユーザー決定): 配信に入った時刻。開始・再開のたびに更新し、テストどうしの優先の順に使う
      ...(body.status === "running" ? { last_started_at: at } : {}),
      ...(body.status === "archived" ? { stopped_at: at } : {}),
      ...(runId ? { run_id: runId } : {}),
    });
    // 読んだ世代・状態のままであることを条件に更新する。同じ ID で作り直した下書きにも、古い要求を適用しない。
    // D9 ③(K8): 結果を記録する開始は、検査した評価計画の version のままであることも条件にする(検査の後に下書きの保存が
    // 割り込むと、検査していない計画を固定することになるため)。2 文目で同じ batch の中で計画を固定する(新しい run_id が入ったときだけ効く)
    const fixedVersion = plan?.version ?? null;
    // CAS の条件。B129: CAS の文と、その前に置く experiment.status の記録の文が使う(CAS で負けた要求は記録しない)
    const casWritable = (eb: ExpressionBuilder<Tables, "experiments">) =>
      eb.and([
        thisExperiment(site.id, exp.id)(eb),
        eb("experiments.generation", "=", exp.generation),
        eb("experiments.status", "=", exp.status),
        ...(siteUnchanged ? [eb(eb.selectFrom("sites").select("sites.results_enabled").where("sites.id", "=", site.id), "=", site.results_enabled)] : []),
        ...(fixedVersion !== null
          ? [
              eb(
                eb.selectFrom("evaluation_plans").select("evaluation_plans.version").where("evaluation_plans.site_id", "=", site.id).where("evaluation_plans.experiment_id", "=", exp.id),
                "=",
                fixedVersion,
              ),
            ]
          : []),
        // D9 ③(K8): 固定する基準のパターンが、重みが 0 より大きいまま残っていることも条件にする(検査の後にパターンの保存が割り込み、
        // 基準を消したり重みを 0 にしたりすると、判定できない計画を固定することになるため)
        ...(plan !== null
          ? [
              eb.exists(
                eb
                  .selectFrom("variants as bv")
                  .select("bv.id")
                  .where("bv.site_id", "=", site.id)
                  .where("bv.experiment_id", "=", exp.id)
                  .where("bv.id", "=", plan.plan.baselineVariantId!)
                  .where("bv.weight", ">", 0),
              ),
            ]
          : []),
      ]);
    const updatedBy = c.get("user").id;
    const statements = (guard: RawBuilder<SqlBool>, at: number, updatedAt: number | RawBuilder<number> = at) => {
      const cas = db.updateTable("experiments")
        .set({ status: body.status, ...stampsAt(at), updated_at: updatedAt, updated_by: updatedBy })
        .where(casWritable).where(guard);
      const batch = [
        experimentAudit(c, site, exp.id, {
          action: "experiment.status", target: { type: "experiment" },
          targetFrom: experimentTarget(casWritable, sql`, status`), detail: { from: sql`t.status`, to: body.status },
        }, { guard, now: at }),
        toStatement(c.env, cas),
      ];
      if (plan && runId) batch.push(fixPlanStatement(c.env, { siteId: site.id, experimentId: exp.id, plan: plan.plan, runId, userId: updatedBy, now: at }, guard));
      return batch;
    };
    const collectUntilDirty = isTest && (runId !== null || exp.run_id !== null);
    const afterActivePut = collectUntilDirty ? () => rewriteCollectUntil(c.env, db, site.id, apiGuard(c.env)) : undefined;
    const attempt = (at: number) => {
      const transition: PublishTransition = {
        experimentId: exp.id, from: exp.status, to: body.status, stamps: stampsAt(at), updatedBy, casWritable, statements, collectUntilDirty, afterActivePut,
        ...(plan && runId ? { deliveryPlanOverride: { experimentId: exp.id, plan: plan.plan } } : {}),
      };
      return publishWithTransition(c.env, db, site, auditActor(c), at, { transition, expectDigest: body.expectDigest });
    };
    let outcome = await attempt(now);
    if (outcome.kind === "conflict" && body.status !== "running") {
      now = Date.now();
      outcome = await attempt(now);
    }
    const invalidTransition = async (): Promise<never> => {
      const fresh = await db.selectFrom("experiments").select("status").where("site_id", "=", site.id).where("id", "=", exp.id).executeTakeFirst();
      const planChanged =
        fixedVersion !== null &&
        fresh?.status === exp.status &&
        (await db.selectFrom("evaluation_plans").select("version").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).executeTakeFirst())?.version !== fixedVersion;
      const baselineChanged =
        plan !== null &&
        fresh?.status === exp.status &&
        !(await db
          .selectFrom("variants")
          .select("id")
          .where("site_id", "=", site.id)
          .where("experiment_id", "=", exp.id)
          .where("id", "=", plan.plan.baselineVariantId!)
          .where("weight", ">", 0)
          .executeTakeFirst());
      throw new ApiError(409, "invalid_transition", {
        ...(fresh ? { from: fresh.status } : {}),
        to: body.status,
        hint: planChanged
          ? "評価計画が変わりました。画面を読み込み直してください"
          : baselineChanged
            ? "パターンの設定が変わりました。画面を読み込み直してください"
            : siteUnchanged
              ? "状態かサイト設定が変わりました。画面を読み込み直してください"
              : "別の操作と競合しました。再読込してください",
      });
    };
    let publish: PublishResult;
    switch (outcome.kind) {
      case "applied":
        publish = outcome.publish;
        break;
      case "outcome_unknown":
        throw publishOutcomeUnknown();
      case "invalid_transition":
        return await invalidTransition();
      case "stale_preview":
        throw new ApiError(409, "stale_preview", { hint: "公開の確認をもう一度開き、変わった内容を確かめてから公開してください" });
      case "conflict":
        throw new ApiError(409, "transition_conflict", { hint: "状態は変わっていません。読み込み直して、内容を確かめてからもう一度送ってください" });
      case "record_missing":
      case "reservation_expired":
        throw new ApiError(409, outcome.publish.error, { message: outcome.publish.message, hint: outcome.publish.hint });
      case "prepare_failed": {
        publish = outcome.publish;
        if (body.status === "running") {
          if (publish.error === "asset_missing" || publish.error === "asset_other_site") throw assetGuardRejected(publish.error, publish.assetProblems ?? []);
          const retry = ["kv_put_failed", "kv_verify_failed", "version_reservation_failed", "publish_failed"].includes(publish.error);
          throw new ApiError(409, publish.error, {
            message: publish.message, hint: retry ? "数秒後に、同じ状態の変更をもう一度送ってください" : publish.hint ?? "原因を直してからもう一度操作してください",
          });
        }
        // 停止・終了は準備の失敗でも記録する。確定するのは状態の CAS と操作の記録だけ。
        const batchAt = Date.now();
        const updatedAt = sql<number>`max(${batchAt}, coalesce((select last_activated_at from sites where id = ${site.id}), 0) + 1)`;
        const [, cas] = await c.env.DB.batch(statements(sql<SqlBool>`1`, now, updatedAt));
        if (!cas?.meta.changes) return await invalidTransition();
        await afterActivePut?.();
        break;
      }
    }
    // この先の読み取りが失敗しても、確定した状態と公開の結果から応答し、終了の記録へ進む。
    const stamps = stampsAt(now);
    let fresh: ExperimentRow = {
      ...exp, status: body.status, ...stamps, updated_at: now, updated_by: updatedBy,
      published_status: publish.ok ? body.status : exp.published_status,
    };
    let freshSite: Pick<SiteRow, "last_activated_at"> = { last_activated_at: publish.ok ? now : site.last_activated_at };
    try {
      fresh = await loadExperiment(db, site.id, exp.id);
      freshSite = await db.selectFrom("sites").select("last_activated_at").where("id", "=", site.id).executeTakeFirstOrThrow();
    } catch (e) {
      console.error("status response read failed after commit", site.id, exp.id, e);
      if (publish.ok && !publish.warnings.some((w) => w.path === "delivery")) publish.warnings.push(DELIVERY_DELAY_WARNING);
    }
    // D9 ③(K16、設計書 §8.1 の (3)): 終了したテストの結果の記録と採用の記録(状態の変更と Publish の後。失敗しても 200 で recorded: false)。
    // 終了の後は保存した速報を消す(Publish が消すが、Publish が失敗した場合にも残さない)
    let results: { recorded: boolean } | undefined;
    if (stoppingTest) {
      const stopped: ExperimentRow = { ...exp, status: "archived", ...stamps, updated_at: now, updated_by: c.get("user").id };
      // B129(2026-11-05 ユーザー決定 Q276): 終了と同時に付けた採用も experiment.adoption として記録する(PUT …/adoption と同じ形。メモの本文は持たない)
      const adoptionAudit = (guard: Expression<SqlBool> | undefined) =>
        experimentAudit(
          c,
          site,
          exp.id,
          { action: "experiment.adoption", target: { type: "experiment" }, targetFrom: experimentTarget(thisExperiment(site.id, exp.id)), detail: { variant: adoption?.variantId ?? null } },
          { guard, now },
        );
      results = { recorded: await recordStop(c.env, db, site, stopped, { adoption, adoptionAudit, userId: c.get("user").id, now, estimate: Math.max(1, stopEstimate), guard: apiGuard(c.env) }) };
      try {
        await db.deleteFrom("results_interim_cache").where("site_id", "=", site.id).where("experiment_id", "=", exp.id).execute();
      } catch (e) {
        console.error("deleting the saved interim results after stop failed", e);
      }
      // 未公開の変更(保存済みの Change と、終了の直前に配信していた定義の食い違い)を知らせる
      try {
        const live = await liveFacts(db, site.id, stopped, null, now);
        const names = new Map((await loadVariants(db, site.id, exp.id)).map((v) => [v.id, v.name]));
        for (const n of live.notes) {
          const vid = String(n.params?.variantId ?? "");
          if (n.key === "unpublished_changes") warnings.push(unpublishedChangesWarning(vid, names.get(vid) ?? vid));
        }
      } catch (e) {
        console.error("checking unpublished changes after stop failed", e);
      }
    }
    return c.json({ experiment: experimentJson(fresh, { unpublished: isUnpublished(fresh, freshSite) }), publish: publicPublishResult(publish), warnings, ...(results ? { results } : {}) });
  },
);

/**
 * D9 ③(K16、設計書 §8.1): 採用の記録(管理者以上)。終了したテストだけ。上書きでき、最後に記録した人と時刻だけを残す。
 * 終了のときに記録できなかった・採用を付けずに終了したときに使う。未公開の変更に数えない(エクスペリエンスの updated_at を進めない)
 */
experimentRoutes.put(
  "/sites/:sid/experiments/:eid/adoption",
  describeRoute({
    tags: ["experiments"],
    summary:
      "終了したテストの採用を記録する(管理者以上)。上書きできる。variantId = null は採用なし。変更の無い基準を指定すると採用なしとして記録する。終了していないテストは 409、パーソナライズは 422(adoption_not_allowed)",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "記録した採用", content: { "application/json": { schema: resolver(AdoptionJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", AdoptionInputSchema, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "admin");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    if (exp.kind !== "test") throw adoptionNotAllowed(422, "パーソナライズには採用を記録しません");
    if (exp.status !== "archived") throw adoptionNotAllowed(409, "採用は終了したテストにだけ記録できます。テストを終了するときに記録してください");
    const variants = await loadVariants(db, site.id, exp.id);
    const plan = await loadPlan(db, site.id, exp, variants);
    const variantId = await resolveAdoptedVariant(db, site.id, exp, variants, plan.plan.baselineVariantId, body.variantId, exp.stopped_at ?? Date.now());
    const now = Date.now();
    const by = c.get("user").id;
    // 終了したままであることを条件にする(終了は戻らないが、エクスペリエンスの削除と競合したときに外部キーで落とさない)。
    // B129: 1 文の upsert を、experiment.adoption の記録(前に置く。条件は upsert と同じ archived。メモの本文は持たない)との 2 文の batch にする(往復は 1 回のまま)
    const archived = sql<SqlBool>`exists (select 1 from experiments where site_id = ${site.id} and id = ${exp.id} and status = 'archived')`;
    const [, res] = await c.env.DB.batch([
      experimentAudit(
        c,
        site,
        exp.id,
        { action: "experiment.adoption", target: { type: "experiment" }, targetFrom: experimentTarget(thisExperiment(site.id, exp.id)), detail: { variant: variantId } },
        { guard: archived, now },
      ),
      sqlStatement(
        c.env.DB,
        sql`insert into adoptions (site_id, experiment_id, variant_id, note, decided_by, decided_at)
          select ${site.id}, ${exp.id}, ${variantId}, ${body.note ?? ""}, ${by}, ${now} where ${archived}
          on conflict (site_id, experiment_id) do update set
            variant_id = excluded.variant_id, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
      ),
    ]);
    if ((res?.meta.changes ?? 0) === 0) throw notFound();
    return c.json({ variantId, note: body.note ?? "", decidedAt: now, decidedBy: by });
  },
);

/**
 * 決定 51(設計書 §4.1): 複製(編集者以上。下書きを作るだけで公開しないため)。元の状態は問わず、元には何も書かない。
 * 写さないもの: 状態(いつも draft)・開始 / 終了の時刻・公開の履歴・結果の記録の ID(run_id。D9 ②)
 */
experimentRoutes.post(
  "/sites/:sid/experiments/:eid/duplicate",
  describeRoute({
    tags: ["experiments"],
    summary: "エクスペリエンスを複製して下書きを作る(編集者以上)。元のエクスペリエンスは変わらない。パーソナライズの元は mode = same だけ",
    security: [{ bearer: [] }],
    responses: {
      201: { description: "作成した下書き", content: { "application/json": { schema: resolver(ExperimentJsonSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422),
    },
  }),
  requireSession,
  validator("json", DuplicateBody, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const src = await loadExperiment(db, site.id, c.req.param("eid"));
    const body = c.req.valid("json");
    if (body.mode === "variant" && src.kind === "single")
      throw new ApiError(422, "duplicate_mode_not_allowed", {
        message: "パーソナライズのエクスペリエンスは「同じ内容」でだけ複製できます",
        hint: "mode を same にしてください",
      });
    const variants = await loadVariants(db, site.id, src.id);
    const picked = body.mode === "variant" ? variants.find((v) => v.id === body.variantId) : undefined;
    if (body.mode === "variant" && !picked)
      throw new ApiError(422, "unknown_variant", { path: ["variantId"], message: "指定したパターンがこのエクスペリエンスにありません" });
    // B77(K8): オリジナルは元のページそのもので、パーソナライズにしても何も表示しない
    if (picked?.original === 1)
      throw new ApiError(422, "duplicate_original_variant", {
        path: ["variantId"],
        message: "オリジナルのパターンはパーソナライズに複製できません",
        hint: "変更のあるパターンを選んでください",
      });
    const idTaken = (id: string) => new ApiError(409, "id_taken", { id, message: "このエクスペリエンス ID は既に使われています", hint: "別の ID を指定してください" });
    const allTaken = () => new ApiError(409, "id_taken", { message: "複製の ID の候補がすべて使われています", hint: "使っていない複製を削除してから、もう一度複製してください(API では id を指定できます)" });
    // 使われている ID に、一度開始してから削除した ID を足して判定する(D9 ②、K16)
    const freeId = async (): Promise<string | undefined> => {
      const taken = await retiredIds(db, site.id);
      for (const r of await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).execute()) taken.add(r.id);
      return duplicateIdCandidates(src.id).find((x) => !taken.has(x));
    };
    if (body.id !== undefined && (await db.selectFrom("experiments").select("id").where("site_id", "=", site.id).where("id", "=", body.id).executeTakeFirst())) throw idTaken(body.id);
    if (body.id !== undefined && (await retiredIds(db, site.id)).has(body.id)) throw retiredIdTaken(body.id);
    const firstId = body.id ?? (await freeId());
    if (firstId === undefined) throw allTaken();
    const name = body.name ?? duplicateName(body.mode, src.name, picked?.name);
    assertName(name, ["name"]);
    const user = c.get("user").id;
    const kept = body.mode === "variant" ? [picked!] : variants; // 外部計測の名前の検査に使う(写すのは batch の中の INSERT … SELECT)
    // D9 ③(設計書 §4.1): variant の複製は配信していた中身を写す。配信を確かめた届く定義のうち、終了したテストは終了の時刻に
    // 有効だった行(終了の直前に配っていた定義。終了の後に確かめた行は使わない)、それ以外は今有効な行(= 確かめた最新の行。
    // 一時停止中は行を作らないので、一時停止の直前に配っていた定義)。行が無ければ(配信の記録が無いテスト)保存済みの中身を写す
    const delivered =
      body.mode === "variant"
        ? ((await deliveredAt(db, site.id, src.id, src.status === "archived" && src.stopped_at !== null ? src.stopped_at : Date.now()))?.definition ?? null)
        : null;
    // same かつテストのときは評価計画も写す(batch の 4 文目)
    const copyPlan = body.mode === "same" && src.kind === "test";
    const isUniqueViolation = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e));
    /** エクスペリエンス・パターン・変更(テストの same は評価計画も)を 1 batch = 1 トランザクションの 3 文(4 文)で書く(片方だけ残らない。
     *  パターン・変更・計画は元の行(variant の変更は配信した定義)から INSERT … SELECT)。
     *  どの文も「元が読んだ版のまま」のときだけ書くので、読んだ設定・検査と写す中身はいつも同じ版になる */
    const write = async (id: string): Promise<ExperimentRow> => {
      const o = { siteId: site.id, sourceId: src.id, mode: body.mode, variantId: body.variantId, id, name, user, now: Date.now(), sourceUpdatedAt: src.updated_at };
      const row = duplicateExperimentRow(src, o);
      assertExperimentAnalytics(
        { id: row.id, name: row.name, analytics: parseExperimentAnalytics(row) },
        kept.map((v) => ({ id: v.id, name: v.name, analytics: parseVariantAnalytics(v) })),
      );
      // B129: insert の前に experiment.duplicate を記録する(条件は insert と同じ sourceUnchanged。対象は新しいエクスペリエンスで、世代は insert と同じ値)。
      // ID の衝突(UNIQUE)で batch ごと失敗すれば記録も残らない
      const results = await c.env.DB.batch([
        experimentAudit(
          c,
          site,
          row.id,
          { action: "experiment.duplicate", target: { type: "experiment", id: row.id, label: row.name }, detail: { source: src.id }, generation: { experiment: row.generation } },
          { guard: sourceUnchanged(o)(anyEb), now: o.now },
        ),
        toStatement(c.env, insertExperimentQuery(db, row, o)),
        toStatement(c.env, copyVariantsQuery(db, o)),
        toStatement(c.env, copyChangesQuery(db, o, delivered)),
        ...(copyPlan ? [toStatement(c.env, copyPlanQuery(db, o))] : []),
      ]);
      // 読んだ後に元が編集・削除された(3 文とも 0 行で、何も残っていない)。版の混ざった下書きやパターン 0 個の下書きを作らない
      if ((results[1]?.meta.changes ?? 0) === 0)
        throw new ApiError(409, "duplicate_source_changed", { message: "複製の元のエクスペリエンスが、複製の途中で変更されました", hint: "もう一度複製してください" });
      return row;
    };
    let row: ExperimentRow;
    try {
      row = await write(firstId);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (body.id !== undefined) throw idTaken(body.id); // 調べてから書くまでの間に同じ ID が作られた
      // 自動の ID が同時の複製と衝突した。空いている次の候補で 1 回だけやり直す
      const retryId = await freeId();
      if (retryId === undefined) throw allTaken();
      try {
        row = await write(retryId);
      } catch (e2) {
        if (isUniqueViolation(e2)) throw new ApiError(409, "id_taken", { message: "複製の ID が同時の操作と重なりました", hint: "もう一度複製してください" });
        throw e2;
      }
    }
    return c.json(experimentJson(row, { unpublished: true }), 201);
  },
);
