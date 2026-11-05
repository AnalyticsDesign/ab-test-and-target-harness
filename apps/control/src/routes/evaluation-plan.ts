import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { z } from "zod";
import { utcDay } from "@wtt/core";
import { evaluationPoint, extensionIssues, planCautions } from "@wtt/stats";
import { requireSession, type AppEnv } from "../app";
import { auditActor, auditStatement, type AuditSql } from "../audit";
import type { Db, ExperimentRow, SiteRow, VariantRow } from "../db";
import type { Env } from "../env";
import { ApiError, notFound, validationFailed } from "../errors";
import {
  assertPlanValid,
  changedPlanFields,
  draftPlanChangedDetail,
  draftPlanUpsert,
  draftPlanWritable,
  EvaluationPlanJsonSchema,
  EvaluationPlanPutSchema,
  extensionBatch,
  extensionWritable,
  loadPlan,
  mergePlan,
  samePlan,
  type LoadedPlan,
} from "../evaluation-plan";
import { errorResponses } from "../openapi";
import { checkReach, rewriteCollectUntil } from "../results/collect-until";
import { apiGuard } from "../results/guard";
import { openRead } from "../results/read-session";
import { loadSite } from "../roles";
import { archivedReadonly, assertNotArchivedTest } from "../test-locks";
import { loadVariants } from "./experiments";

/**
 * D9 ③(plan ③ の K7・K9、設計書 §5・§9.2): 評価計画の API。
 * 評価計画は compiled config に載らないので、保存しても未公開の編集にしない(touchSite を呼ばず、experiments.updated_at を進めない)
 */
export const evaluationPlanRoutes = new Hono<AppEnv>();

/** パーソナライズには評価計画と結果が無い */
export const resultsNotApplicable = () =>
  new ApiError(404, "results_not_applicable", { hint: "評価計画と結果はテストだけにあります。パーソナライズは比べずに表示するため、判定を出しません" });
const LOCKED_HINT = "早く終えるときは終了してください(判定に『評価時点前に終了』と付きます)。基準を変えるときは複製して新しいテストにしてください";
const RACE_HINT = "別の操作と競合しました。画面を読み込み直してください";

const CautionSchema = z.object({
  key: z.enum(["min_days_short", "min_days_very_short", "threshold_low", "no_target"]),
  params: z.record(z.string(), z.number()).optional(),
});
const PlanChangeSchema = z.object({
  at: z.number().int().describe("epoch ミリ秒"),
  by: z.string().nullable().describe("変更したユーザーの ID"),
  before: EvaluationPlanJsonSchema,
  after: EvaluationPlanJsonSchema,
  reason: z.string().nullable(),
});
const EvaluationPlanResponseSchema = z.object({
  plan: EvaluationPlanJsonSchema.describe("評価計画(保存していない項目は既定値で埋めた形)"),
  fixed: z.boolean().describe("開始で固定したか(結果を記録するサイトで開始したときだけ固定する)"),
  fixedAt: z.number().int().nullable().describe("固定した時刻(epoch ミリ秒)"),
  evaluation: z
    .object({
      minEnd: z.number().int().describe("最低期間の終わり(epoch ミリ秒)"),
      maxEnd: z.number().int().describe("最大期間の終わり(epoch ミリ秒)"),
      evaluationAt: z.number().int().describe("評価時点の見込み(epoch ミリ秒)。目標参加者数に届く前は最大期間の終わり"),
      reachedAt: z.number().int().nullable().describe("目標参加者数に届いた参加の時刻(記録していれば)"),
    })
    .nullable()
    .describe("評価時点の見込み。固定していない計画は null"),
  cautions: z.array(CautionSchema).describe("注意(止めない)。最低期間が短い・しきい値が低い・目標参加者数が無い"),
  changes: z.array(PlanChangeSchema).describe("開始後の計画の変更の履歴(古い順)"),
});

async function loadExperiment(db: Db, siteId: string, eid: string): Promise<ExperimentRow> {
  const row = await db.selectFrom("experiments").selectAll().where("site_id", "=", siteId).where("id", "=", eid).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

/** GET と PUT の応答 */
async function planView(db: Db, site: Pick<SiteRow, "id">, exp: ExperimentRow, variants: VariantRow[]) {
  const loaded = await loadPlan(db, site.id, exp, variants);
  const rows = await db
    .selectFrom("evaluation_plan_changes")
    .selectAll()
    .where("site_id", "=", site.id)
    .where("experiment_id", "=", exp.id)
    .orderBy("at")
    .orderBy("id")
    .execute();
  const startedAt = exp.started_at ?? loaded.fixedAt;
  let evaluation = null;
  if (loaded.fixedAt !== null && startedAt !== null) {
    const p = evaluationPoint(loaded.plan, startedAt, loaded.reachedAt, exp.status === "archived" ? exp.stopped_at : null);
    evaluation = { minEnd: p.minEnd, maxEnd: p.maxEnd, evaluationAt: p.evaluationAt, reachedAt: loaded.reachedAt };
  }
  return {
    plan: loaded.plan,
    fixed: loaded.fixedAt !== null,
    fixedAt: loaded.fixedAt,
    evaluation,
    cautions: planCautions(loaded.plan),
    changes: rows.map((r) => ({ at: r.at, by: r.by, before: JSON.parse(r.before_json), after: JSON.parse(r.after_json), reason: r.reason })),
  };
}

/** 書き込みが 0 行だったとき: 読み直して、終了していれば readonly、それ以外は locked */
async function conflictAfterRace(db: Db, siteId: string, eid: string, hint: string): Promise<ApiError> {
  const fresh = await db.selectFrom("experiments").select("status").where("site_id", "=", siteId).where("id", "=", eid).executeTakeFirst();
  if (!fresh) return notFound();
  if (fresh.status === "archived") return archivedReadonly();
  return new ApiError(409, "evaluation_plan_locked", { hint });
}

/** 到達の確認の読み取りの見込み(行数)。保存した速報の読み取り行数、無ければ 10,000 行(K13 の既定) */
const REACH_READ_ESTIMATE_DEFAULT = 10_000;
async function reachReadEstimate(db: Db, siteId: string, eid: string): Promise<number> {
  const cached = await db.selectFrom("results_interim_cache").select("rows_read").where("site_id", "=", siteId).where("experiment_id", "=", eid).executeTakeFirst();
  return cached && cached.rows_read > 0 ? cached.rows_read : REACH_READ_ESTIMATE_DEFAULT;
}

/**
 * K9: 延長の前の到達の確認。目標参加者数があり、到達をまだ記録しておらず、最大期間の終わりの前のときだけ、
 * 読み取りを予約して旧計画で checkReach を行い、計画を読み直して返す(読み直した reachedAt と version で評価時点と延長の条件を決める)。
 * 予約が断られたら 503 results_read_unavailable。計測用 D1 か予算の DO の binding が無い導入では読めないので、記録済みの値で判定する。
 * 読み直した version が読んだ値と違えば(到達の記録は version を進めないので、間に別の計画の変更が入った)409
 */
async function withReachChecked(
  env: Env,
  db: Db,
  site: Pick<SiteRow, "id">,
  exp: ExperimentRow,
  current: LoadedPlan,
  variants: VariantRow[],
  startedAt: number,
  now: number,
): Promise<LoadedPlan> {
  if (current.plan.targetPerVariant === null || current.reachedAt !== null || exp.run_id === null || current.version === null) return current;
  if (!env.RESULTS_DB || !env.RESULTS_BUDGET) return current;
  // 最大期間の終わりを過ぎていれば、到達にかかわらず評価時点の後(読まない)
  if (now >= evaluationPoint(current.plan, startedAt, null, null).maxEnd) return current;
  const session = await openRead(env, utcDay(now), await reachReadEstimate(db, site.id, exp.id), now);
  if ("refused" in session) {
    throw new ApiError(503, "results_read_unavailable", { hint: "結果の読み取りが混み合っているか、今日の読み取りの上限に達しました。時間をおいてやり直してください" });
  }
  try {
    await checkReach(env, db, site, exp, current, now, session, apiGuard(env));
  } finally {
    await session.close();
  }
  const fresh = await loadPlan(db, site.id, exp, variants);
  if (fresh.version !== current.version) throw await conflictAfterRace(db, site.id, exp.id, RACE_HINT);
  return fresh;
}

evaluationPlanRoutes.get(
  "/sites/:sid/experiments/:eid/evaluation-plan",
  describeRoute({
    tags: ["experiments"],
    summary: "テストの評価計画(閲覧者以上)。保存していない項目は既定値で埋め、固定の有無・評価時点の見込み・開始後の変更の履歴を返す。パーソナライズは 404",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "評価計画", content: { "application/json": { schema: resolver(EvaluationPlanResponseSchema) } } },
      ...errorResponses(401, 403, 404),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    if (exp.kind === "single") throw resultsNotApplicable();
    return c.json(await planView(db, site, exp, await loadVariants(db, site.id, exp.id)));
  },
);

evaluationPlanRoutes.put(
  "/sites/:sid/experiments/:eid/evaluation-plan",
  describeRoute({
    tags: ["experiments"],
    summary:
      "テストの評価計画を保存する(編集者以上)。下書きではすべての項目を変えられる。開始後は評価時点の前に、最低期間・最大期間を延ばす・目標参加者数を増やす(新しく設ける)変更だけを受け、履歴に残す。保存は公開の対象にならない",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "保存した後の評価計画", content: { "application/json": { schema: resolver(EvaluationPlanResponseSchema) } } },
      ...errorResponses(400, 401, 403, 404, 409, 422, 503),
    },
  }),
  requireSession,
  validator("json", EvaluationPlanPutSchema, (r) => {
    if (!r.success) throw validationFailed(r.error);
  }),
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "editor");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    if (exp.kind === "single") throw resultsNotApplicable();
    assertNotArchivedTest(exp);
    const body = c.req.valid("json");
    const variants = await loadVariants(db, site.id, exp.id);
    const goalIds = (await db.selectFrom("goals").select("id").where("site_id", "=", site.id).execute()).map((g) => g.id);
    const current = await loadPlan(db, site.id, exp, variants);
    const next = mergePlan(current.plan, body.plan);
    assertPlanValid(next, { variantIds: variants.map((v) => v.id), goalIds });
    const now = Date.now();
    const userId = c.get("user").id;

    // B129: 書く文の前に experiment.evaluation_plan を記録する(条件は書く文と同じ断片。detail = 読んだ計画と比べて変えた項目の名前)
    const audit = (detail: { fields: string[] } | AuditSql, targetFrom: RawBuilder<unknown>, guard?: Expression<SqlBool>) =>
      auditStatement(
        c.env.DB,
        auditActor(c),
        { action: "experiment.evaluation_plan", workspaceId: site.workspace_id, siteId: site.id, experimentId: exp.id, target: { type: "experiment" }, targetFrom, detail },
        { guard, now },
      );
    if (exp.status === "draft") {
      // 下書き: 親が下書きのまま・計画が未固定のときだけ書く(読んだ後に開始が割り込んでも、固定した計画を上書きしない)。
      // 下書きの保存は読んだ version を条件にしないので、記録の fields は記録の文の中で今の計画の行(t.plan_json)と比べて作る
      // (読んだ後に別の人の保存が入っても、この保存が実際に書き換えた項目を記録する。B129 final review 2026-11-05 FR-Medium-2)
      const draftTarget = sql`select e.id as target_id, e.name as target_label, p.plan_json as plan_json from experiments e
        left join evaluation_plans p on p.site_id = e.site_id and p.experiment_id = e.id where e.site_id = ${site.id} and e.id = ${exp.id}`;
      const [, r] = await c.env.DB.batch([
        audit(draftPlanChangedDetail(sql`t.plan_json`, current.plan, next), draftTarget, draftPlanWritable(site.id, exp.id)),
        draftPlanUpsert(c.env, { siteId: site.id, experimentId: exp.id, plan: next, userId, now }),
      ]);
      if ((r?.meta.changes ?? 0) === 0) throw await conflictAfterRace(db, site.id, exp.id, "テストが開始されました。開始後は期間と人数を延ばす変更だけができます。画面を読み込み直してください");
    } else {
      // 開始後(実行中・一時停止中)。結果を記録しないサイトで開始したテストは計画を固定していないので、変えられない
      if (current.fixedAt === null) {
        throw new ApiError(409, "evaluation_plan_locked", {
          hint: "結果を記録しないで開始したテストには、判定に使う評価計画がありません。評価計画を使うときは、結果を記録するサイトで複製して開始してください",
        });
      }
      const startedAt = exp.started_at ?? current.fixedAt;
      // K9: 目標参加者数のある固定済みの計画で到達をまだ記録していなければ、先に旧計画で到達を確かめ(checkReach)、
      // その結果の到達の時刻で評価時点を判定する(届いているのに記録していないだけの評価時点の後に、延長を受けないため)
      const plan = await withReachChecked(c.env, db, site, exp, current, variants, startedAt, now);
      if (now >= evaluationPoint(plan.plan, startedAt, plan.reachedAt, null).evaluationAt) {
        throw new ApiError(409, "evaluation_already_fixed", { hint: "評価時点を過ぎたので、判定は今の計画で固定されています。続けて確かめるときは複製して新しいテストにしてください" });
      }
      const fields = extensionIssues(plan.plan, next);
      if (fields.length > 0) throw new ApiError(409, "evaluation_plan_locked", { fields, hint: LOCKED_HINT });
      if (!samePlan(plan.plan, next) && plan.version !== null) {
        // 読んだ version・到達の時刻は、到達の確認の後に読み直した値(確認で到達を記録した直後の延長が、自分の記録で 409 にならないため)
        const ext = {
          siteId: site.id,
          experimentId: exp.id,
          before: plan.plan,
          after: next,
          readVersion: plan.version,
          readReachedAt: plan.reachedAt,
          reason: body.reason ?? null,
          userId,
          now,
        };
        // B129: 記録の対象の行は CAS の条件(extensionWritable)に合う計画の行のエクスペリエンス(理由の本文は持たない)
        const extensionTarget = sql`select e.id as target_id, e.name as target_label from evaluation_plans
          join experiments e on e.site_id = evaluation_plans.site_id and e.id = evaluation_plans.experiment_id where ${extensionWritable(ext)}`;
        const [, upd] = await c.env.DB.batch([audit({ fields: changedPlanFields(plan.plan, next) }, extensionTarget), ...extensionBatch(c.env, ext)]);
        if ((upd?.meta.changes ?? 0) === 0) throw await conflictAfterRace(db, site.id, exp.id, RACE_HINT);
        // K11: 延ばした計画(目標を増やしたときは到達を消した計画)で収集の締め切りを書き直す(投げない。失敗は印を立て Cron が直す)
        await rewriteCollectUntil(c.env, db, site.id, apiGuard(c.env));
      }
    }
    const fresh = await loadExperiment(db, site.id, exp.id);
    return c.json(await planView(db, site, fresh, variants));
  },
);
