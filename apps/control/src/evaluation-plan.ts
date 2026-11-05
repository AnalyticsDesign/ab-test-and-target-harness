// D9 ③(plan ③ の K7・K8・K9、設計書 §5): 評価計画の受け口(zod)・読み込み・開始の検査・容量の見込み・書き込みの文。
// 型・既定値・範囲の規則は packages/stats の evaluation-plan.ts が正(ここでは zod で型と整数だけを見て、範囲は planIssues に任せる)
import { sql, type SqlBool } from "kysely";
import { z } from "zod";
import { DEFAULT_PLAN, defaultBaseline, planIssues, type EvaluationDefinition, type EvaluationPlan } from "@wtt/stats";
import { changedFieldsDetail, type AuditSql } from "./audit";
import { sqlStatement, type Db, type ExperimentRow, type VariantRow } from "./db";
import type { Env } from "./env";
import { ApiError } from "./errors";

/**
 * 評価計画の受け口。範囲(しきい値 90〜99.9 など)は planIssues が見る(zod と planIssues で 2 通りの 422 を出さない)。
 * 日数・週数・人数は planIssues も整数を求めるので、zod でも整数にする(zod を通ったのに planIssues が型で断る、を作らない)
 */
export const EvaluationPlanSchema = z.strictObject({
  primaryGoalId: z.string().min(1).nullable().describe("判定に使う目標の ID。結果を記録するサイトでテストを開始するときは必須"),
  baselineVariantId: z
    .string()
    .min(1)
    .nullable()
    .describe("基準のパターンの ID。null か、今のパターンに無い ID のときは、オリジナルの中で先頭のパターン(オリジナルが無ければ先頭のパターン)"),
  minDays: z.number().int().describe("最低期間(日)。1 日〜最大期間"),
  maxWeeks: z.number().int().describe("最大期間(週)。2〜26 週"),
  targetPerVariant: z.number().int().nullable().describe("パターンごとの目標参加者数。100 以上。null = 設けない"),
  delta: z.number().describe("最小改善幅(ポイント)。0 以上"),
  rope: z.number().nullable().describe("同等とみなす幅(ポイント)。0 より大きい。null = 設けない"),
  threshold: z.number().describe("確率のしきい値(%)。90〜99.9"),
  definition: z.unknown().optional().describe("集計の定義(表示のみ)。送っても無視し、既定の定義を入れる"),
});

/** PUT の body。plan は変える項目だけを送る(送らない項目は保存済みの値のまま) */
export const EvaluationPlanPutSchema = z.strictObject({
  plan: EvaluationPlanSchema.partial(),
  reason: z.string().max(500).optional().describe("変更の理由(任意、500 字まで)。開始後の変更の履歴に残す"),
});

const DefinitionJsonSchema = z.object({
  version: z.literal(1),
  observationWindow: z.object({ kind: z.literal("until_end") }),
  denominator: z.literal("displayed"),
  mixed: z.literal("keep_first"),
  model: z.object({ name: z.literal("beta-binomial"), prior: z.tuple([z.number(), z.number()]), version: z.literal(1) }),
});
/** 応答の評価計画(既定値で埋めた形) */
export const EvaluationPlanJsonSchema = z.object({
  primaryGoalId: z.string().nullable(),
  baselineVariantId: z.string().nullable(),
  minDays: z.number().int(),
  maxWeeks: z.number().int(),
  targetPerVariant: z.number().int().nullable(),
  delta: z.number(),
  rope: z.number().nullable(),
  threshold: z.number(),
  definition: DefinitionJsonSchema.describe("集計の定義(表示のみ)"),
});

export type LoadedPlan = {
  plan: EvaluationPlan;
  fixedAt: number | null;
  reachedAt: number | null;
  /** 計画の行の version(PUT・開始のたびに 1 進む)。行が無ければ null */
  version: number | null;
};

type BaselineInput = Pick<VariantRow, "id" | "position" | "original">;
/**
 * 保存した計画の行を既定値に重ねる(基準は直さない。loadPlan がパターンを見て直す)。集計の定義は、固定した計画では保存した定義、
 * 下書きでは既定。loadPlan と Cron(results-daily の並べ替え・到達の確認)が使う
 */
export function mergeStoredPlan(row: { plan_json: string; fixed_at: number | null }): EvaluationPlan {
  const stored = JSON.parse(row.plan_json) as Partial<EvaluationPlan>;
  return {
    ...DEFAULT_PLAN,
    primaryGoalId: null,
    baselineVariantId: null,
    ...stored,
    definition: row.fixed_at !== null && stored.definition ? stored.definition : DEFAULT_PLAN.definition,
  };
}

const baselineOf = (variants: BaselineInput[]) => defaultBaseline(variants.map((v) => ({ id: v.id, position: v.position, original: v.original === 1 })));

/**
 * 評価計画を読む(K7)。行が無ければ既定値で埋めた形。基準が null か今のパターンに無ければ既定の基準。
 * 集計の定義は、固定した計画では保存した定義、下書きでは既定(今は版 1 だけ)
 */
export async function loadPlan(db: Db, siteId: string, exp: Pick<ExperimentRow, "id">, variants: BaselineInput[]): Promise<LoadedPlan> {
  const row = await db
    .selectFrom("evaluation_plans")
    .select(["plan_json", "version", "fixed_at", "reached_at"])
    .where("site_id", "=", siteId)
    .where("experiment_id", "=", exp.id)
    .executeTakeFirst();
  const baseline = baselineOf(variants);
  if (!row) return { plan: { ...DEFAULT_PLAN, primaryGoalId: null, baselineVariantId: baseline }, fixedAt: null, reachedAt: null, version: null };
  const plan = mergeStoredPlan(row);
  if (plan.baselineVariantId === null || !variants.some((v) => v.id === plan.baselineVariantId)) plan.baselineVariantId = baseline;
  return { plan, fixedAt: row.fixed_at, reachedAt: row.reached_at, version: row.version };
}

/** 受けた部分を今の計画に重ねる(集計の定義は送られても使わない = 今の計画の定義のまま) */
export function mergePlan(current: EvaluationPlan, patch: z.infer<typeof EvaluationPlanPutSchema>["plan"]): EvaluationPlan {
  const { definition: _ignored, ...rest } = patch;
  return { ...current, ...rest, definition: current.definition };
}

const definitionEquals = (a: EvaluationDefinition, b: EvaluationDefinition) => JSON.stringify(a) === JSON.stringify(b);
/** 2 つの計画が同じか(保存しても何も変わらないときは書かない) */
export function samePlan(a: EvaluationPlan, b: EvaluationPlan): boolean {
  return (
    a.primaryGoalId === b.primaryGoalId &&
    a.baselineVariantId === b.baselineVariantId &&
    a.minDays === b.minDays &&
    a.maxWeeks === b.maxWeeks &&
    a.targetPerVariant === b.targetPerVariant &&
    a.delta === b.delta &&
    a.rope === b.rope &&
    a.threshold === b.threshold &&
    definitionEquals(a.definition, b.definition)
  );
}

/** 計画の項目(B129: experiment.evaluation_plan の記録の detail.fields の順。集計の定義は PUT で変えられないので含めない) */
const PLAN_FIELDS = ["primaryGoalId", "baselineVariantId", "minDays", "maxWeeks", "targetPerVariant", "delta", "rope", "threshold"] as const;
/** B129: 2 つの計画で値が違う項目の名前(記録の detail.fields) */
export function changedPlanFields(a: EvaluationPlan, b: EvaluationPlan): string[] {
  return PLAN_FIELDS.filter((k) => a[k] !== b[k]);
}

/**
 * B129 final review(2026-11-05 FR-Medium-2):下書きの計画の保存の記録の detail(`{fields}`)を、記録の文の中で今の計画の行と比べて作る。
 * 下書きの保存は読んだ version を条件にしないので、読んだ後に別の人の保存が入ると、読んだ計画との比べ(changedPlanFields)では
 * 実際に書き換えた項目(別の人の値を戻した項目)が抜けるため。`planJson` = 記録の文で読む今の行の plan_json(行が無ければ NULL)。
 * 行が無いときは読んだ計画(既定の計画)と比べる(行が無いまま書く INSERT の枝は、読んだときも行が無かった)。往復は増えない
 */
export function draftPlanChangedDetail(planJson: AuditSql, read: EvaluationPlan, next: EvaluationPlan): AuditSql {
  return changedFieldsDetail(
    PLAN_FIELDS.map((k) => ({
      key: k,
      changed: sql<SqlBool>`case when ${planJson} is null then ${sql.lit(read[k] !== next[k] ? 1 : 0)}
        else not (json_extract(${planJson}, ${sql.lit(`$.${k}`)}) is ${next[k]}) end`,
    })),
  );
}

/**
 * 範囲と存在の検査(planIssues)→ 422 validation_failed。path は body の位置(["plan", 項目])。
 * 目標の「無い」は stats の文言ではなく画面の用語(サイト)の文言にする
 */
export function assertPlanValid(plan: EvaluationPlan, ctx: { variantIds: string[]; goalIds: string[] }): void {
  const issues = planIssues(plan, ctx).map((i) => ({
    path: ["plan", i.path],
    message: i.path === "primaryGoalId" && i.code === "unknown" ? "判定に使う目標が、このサイトにありません" : i.message,
  }));
  if (issues.length === 0) return;
  throw new ApiError(422, "validation_failed", { path: issues[0]!.path, message: issues[0]!.message, issues });
}

/**
 * 開始の検査(K8)。結果を記録する開始(run_id を振るとき)だけ呼ぶ。
 * 判定に使う目標が無い・サイトに無い、基準の重みが 0 → 422 evaluation_plan_incomplete
 */
export function assertStartable(plan: EvaluationPlan, variants: Pick<VariantRow, "id" | "weight">[], goalIds: string[]): void {
  if (plan.primaryGoalId === null || !goalIds.includes(plan.primaryGoalId)) {
    throw new ApiError(422, "evaluation_plan_incomplete", {
      path: ["plan", "primaryGoalId"],
      hint: "評価計画のタブで判定に使う目標を選んでください",
    });
  }
  const baseline = variants.find((v) => v.id === plan.baselineVariantId);
  if (!baseline || baseline.weight <= 0) {
    throw new ApiError(422, "evaluation_plan_incomplete", {
      path: ["plan", "baselineVariantId"],
      hint: "基準のパターンの重みを 0 より大きくしてください",
    });
  }
}

/** 計測用 D1 の容量(Free の上限)。80% を超える見込みで警告する(K8)。MB は 1,000,000 バイト(早めに警告する側) */
export const RESULTS_STORE_LIMIT_BYTES = 500 * 1000 * 1000;
export const RESULTS_CAPACITY_WARNING_RATIO = 0.8;
/** 収集を止める大きさの割合(D9 ③ の K18。Cron の results-capacity) */
export const RESULTS_CAPACITY_STOP_RATIO = 0.95;

export type ResultsCapacityLevel = "ok" | "warning" | "stopped";
/** 計測用 D1 の大きさの段階(GET /sites/:sid の resultsCapacity.level と Cron の停止の判定) */
export function capacityLevel(sizeBytes: number): ResultsCapacityLevel {
  if (sizeBytes >= RESULTS_STORE_LIMIT_BYTES * RESULTS_CAPACITY_STOP_RATIO) return "stopped";
  if (sizeBytes >= RESULTS_STORE_LIMIT_BYTES * RESULTS_CAPACITY_WARNING_RATIO) return "warning";
  return "ok";
}
/** 参加 1 件が計測用 D1 で使う大きさ(PoC の実測) */
export const PARTICIPANT_ROW_BYTES = 169;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 保存した速報の参加の速さ(人 / 日)。速報の形(result_json)は結果の API が決める。ここでは `variants[].n` の合計だけを読み、
 * 読めない形なら null(警告の見込みに使わない)。経過が 1 日に満たないときは 1 日として数える(開始直後の速さを大きく見積もらない)
 */
export function participantRate(resultJson: string, startedAt: number | null, computedAt: number): number | null {
  if (startedAt === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  const variants = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;
  let total = 0;
  for (const v of variants) {
    const n = (v as { n?: unknown }).n;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    total += n;
  }
  return total / Math.max(1, (computedAt - startedAt) / DAY_MS);
}

/**
 * 容量の見込みの警告(K8)。開始の応答の warnings に足す 1 行。拒否はしない。
 * 見込み = max(目標参加者数 × 重みが 0 より大きいパターンの数, 同じサイトの実行中のテストの保存した速報の参加の速さの平均 × 最大期間の日数) × 169 B。
 * 最後に測った大きさ(results_store_status)が無い・見込みが出せないときは警告しない。
 * 実行中のテストは同じサイトに限る(新しいテストの参加の速さの目安として、同じサイトの流入を使うため)
 */
export async function capacityWarning(
  db: Db,
  siteId: string,
  plan: EvaluationPlan,
  variants: Pick<VariantRow, "weight">[],
): Promise<{ path: string; message: string } | null> {
  const store = await db.selectFrom("results_store_status").select("size_bytes").where("id", "=", 1).executeTakeFirst();
  if (!store) return null;
  const byTarget = plan.targetPerVariant !== null ? plan.targetPerVariant * variants.filter((v) => v.weight > 0).length : null;
  const cached = await db
    .selectFrom("results_interim_cache as c")
    .innerJoin("experiments as e", (j) => j.onRef("e.site_id", "=", "c.site_id").onRef("e.id", "=", "c.experiment_id"))
    .select(["c.result_json", "c.computed_at", "e.started_at"])
    .where("c.site_id", "=", siteId)
    .where("e.status", "=", "running")
    .execute();
  const rates = cached.map((r) => participantRate(r.result_json, r.started_at, r.computed_at)).filter((r): r is number => r !== null);
  const byRate = rates.length > 0 ? (rates.reduce((a, b) => a + b, 0) / rates.length) * plan.maxWeeks * 7 : null;
  if (byTarget === null && byRate === null) return null;
  const projected = store.size_bytes + Math.max(byTarget ?? 0, byRate ?? 0) * PARTICIPANT_ROW_BYTES;
  if (projected <= RESULTS_STORE_LIMIT_BYTES * RESULTS_CAPACITY_WARNING_RATIO) return null;
  return {
    path: "resultsCapacity",
    message: `計測用のデータベースの空きが少なくなります(見込み 約 ${Math.ceil(projected / 1_000_000)} MB)。保持期間を短くするか、終了したテストの記録を整理してください`,
  };
}

/**
 * 開始で計画を固定する upsert(K8)。開始の batch の 2 文目。
 * 1 文目(状態の CAS)が通って新しい run_id が入ったときだけ効く(INSERT と UPDATE の両方の枝を `run_id = 新しい run_id` の EXISTS で絞る)。
 * 既に固定した行は上書きしない(fixed_at IS NULL)
 */
export function fixPlanStatement(
  env: Env,
  a: { siteId: string; experimentId: string; plan: EvaluationPlan; runId: string; userId: string; now: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO evaluation_plans (site_id, experiment_id, plan_json, version, update_token, fixed_at, updated_by, updated_at)
     SELECT ?1, ?2, ?3, 1, ?4, ?5, ?6, ?5
     WHERE EXISTS (SELECT 1 FROM experiments WHERE site_id = ?1 AND id = ?2 AND run_id = ?7)
     ON CONFLICT (site_id, experiment_id) DO UPDATE SET
       plan_json = excluded.plan_json, version = evaluation_plans.version + 1, update_token = excluded.update_token,
       fixed_at = excluded.fixed_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at
     WHERE evaluation_plans.fixed_at IS NULL
       AND EXISTS (SELECT 1 FROM experiments WHERE site_id = ?1 AND id = ?2 AND run_id = ?7)`,
  ).bind(a.siteId, a.experimentId, JSON.stringify(a.plan), crypto.randomUUID(), a.now, a.userId, a.runId);
}

/**
 * 下書きの計画の保存が書く条件: 親が下書きで、計画がまだ固定されていない(行が無ければ固定されていない)。
 * B129: draftPlanUpsert の INSERT と UPDATE の両方の枝と、その前に置く experiment.evaluation_plan の記録の文が使う
 */
export const draftPlanWritable = (siteId: string, eid: string) =>
  sql<SqlBool>`exists (select 1 from experiments where site_id = ${siteId} and id = ${eid} and status = 'draft')
    and not exists (select 1 from evaluation_plans where site_id = ${siteId} and experiment_id = ${eid} and fixed_at is not null)`;

/**
 * 下書きの計画の保存(K9)。親が下書きで、計画がまだ固定されていないときだけ書く(INSERT と UPDATE の両方の枝で絞る)。
 * 読んだ後に開始が割り込んでも、固定した計画を上書きしない
 */
export function draftPlanUpsert(
  env: Env,
  a: { siteId: string; experimentId: string; plan: EvaluationPlan; userId: string; now: number },
): D1PreparedStatement {
  const writable = draftPlanWritable(a.siteId, a.experimentId);
  return sqlStatement(
    env.DB,
    sql`INSERT INTO evaluation_plans (site_id, experiment_id, plan_json, version, update_token, updated_by, updated_at)
     SELECT ${a.siteId}, ${a.experimentId}, ${JSON.stringify(a.plan)}, 1, ${crypto.randomUUID()}, ${a.userId}, ${a.now}
     WHERE ${writable}
     ON CONFLICT (site_id, experiment_id) DO UPDATE SET
       plan_json = excluded.plan_json, version = evaluation_plans.version + 1, update_token = excluded.update_token,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at
     WHERE ${writable}`,
  );
}

/**
 * 開始後の延長の 1 文目(CAS)の条件: 読んだ version・読んだ到達の時刻のまま・固定済み・親が実行中か一時停止中(K9)。
 * B129: extensionBatch の 1 文目と、その前に置く experiment.evaluation_plan の記録の文が使う(`evaluation_plans` の行を読む文の中で使う)
 */
export const extensionWritable = (a: { siteId: string; experimentId: string; readVersion: number; readReachedAt: number | null }) =>
  sql<SqlBool>`evaluation_plans.site_id = ${a.siteId} and evaluation_plans.experiment_id = ${a.experimentId}
    and evaluation_plans.version = ${a.readVersion} and evaluation_plans.reached_at is ${a.readReachedAt} and evaluation_plans.fixed_at is not null
    and exists (select 1 from experiments where site_id = ${a.siteId} and id = ${a.experimentId} and status in ('running', 'paused'))`;

/**
 * 開始後の延長の batch(K9)。1 文目の UPDATE は「読んだ version・読んだ到達の時刻のまま」「固定済み」「親が実行中か一時停止中」の
 * すべてを条件にし、要求ごとの乱数 update_token を書く。2 文目以降(変更履歴・到達の消去・保存した速報の削除)は、どれも
 * 「計画の行の update_token がこの要求のもの」を条件にする(新しい version だけを条件にすると、同じ version を読んだ別の要求が
 * 作った version で通ってしまうため)。1 文目が 0 行なら、ほかの文も何も変えない
 */
export function extensionBatch(
  env: Env,
  a: {
    siteId: string;
    experimentId: string;
    before: EvaluationPlan;
    after: EvaluationPlan;
    readVersion: number;
    readReachedAt: number | null;
    reason: string | null;
    userId: string;
    now: number;
  },
): D1PreparedStatement[] {
  const token = crypto.randomUUID();
  const mine = "EXISTS (SELECT 1 FROM evaluation_plans WHERE site_id = ?1 AND experiment_id = ?2 AND update_token = ?3)";
  const stmts = [
    sqlStatement(
      env.DB,
      sql`UPDATE evaluation_plans SET plan_json = ${JSON.stringify(a.after)}, version = version + 1, update_token = ${token}, updated_by = ${a.userId}, updated_at = ${a.now}
       WHERE ${extensionWritable(a)}`,
    ),
    env.DB.prepare(
      `INSERT INTO evaluation_plan_changes (site_id, experiment_id, at, by, before_json, after_json, reason)
       SELECT ?1, ?2, ?4, ?5, ?6, ?7, ?8 WHERE ${mine}`,
    ).bind(a.siteId, a.experimentId, token, a.now, a.userId, JSON.stringify(a.before), JSON.stringify(a.after), a.reason),
  ];
  // 目標参加者数を増やした・新しく設けた: 到達の記録を消し、新しい目標で確かめ直す(到達の確認の日付も消して、同じ日のうちに確かめ直せるようにする)
  if (a.before.targetPerVariant !== a.after.targetPerVariant) {
    stmts.push(
      env.DB.prepare(
        `UPDATE evaluation_plans SET reached_at = NULL, reached_recorded_at = NULL, reach_checked_day = NULL
         WHERE site_id = ?1 AND experiment_id = ?2 AND update_token = ?3`,
      ).bind(a.siteId, a.experimentId, token),
    );
  }
  // 保存した速報は計画の変更で消す(評価時点や目標が変わると、速報の見方が変わるため)
  stmts.push(env.DB.prepare(`DELETE FROM results_interim_cache WHERE site_id = ?1 AND experiment_id = ?2 AND ${mine}`).bind(a.siteId, a.experimentId, token));
  return stmts;
}
