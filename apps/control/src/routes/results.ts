import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { utcDay } from "@wtt/core";
import { NOTE_KEYS } from "@wtt/stats";
import { requireSession, type AppEnv } from "../app";
import type { Db, ExperimentRow, SiteRow } from "../db";
import type { Env } from "../env";
import { ApiError, notFound } from "../errors";
import { EvaluationPlanJsonSchema, loadPlan, type LoadedPlan } from "../evaluation-plan";
import { errorResponses } from "../openapi";
import { checkReach } from "../results/collect-until";
import { apiGuard, WriteFrozen, type WriteGuard } from "../results/guard";
import { openRead, readEstimate, type ReadSession } from "../results/read-session";
import { buildReport, controlFacts, emptyReport, evaluationOf, type ResultReport, type ResultSnapshot } from "../results/report";
import { ensureSnapshot, liveFacts, readOfficialSnapshot, serveSnapshot, snapshotTarget, withLiveFacts } from "../results/snapshot";
import { loadSite } from "../roles";
import { resultsNotApplicable } from "./evaluation-plan";
import { loadVariants } from "./experiments";

/**
 * D9 ③(plan ③ の K13・K24、設計書 §6.9・§7・§9.2): テストの結果の API。
 * 評価時点の前は速報(判定のラベルを出さない)。速報の再計算は読み取りの予約(導入全体で同時に 1 つ)の中で、
 * 到達の確認 → cutoff を決める → 集計の順に読み、5 分以内の保存した速報は読まずに返す。予約を断られたら保存した速報(古い値)を返す
 */
export const resultsRoutes = new Hono<AppEnv>();

/** 保存した速報を読まずに返す時間 */
export const INTERIM_REUSE_MS = 5 * 60 * 1000;
export { readEstimate };

const NoteSchema = z.object({
  key: z.enum(NOTE_KEYS).describe("注記の鍵。文言は管理画面と説明の原稿が鍵から付ける"),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("注記の値。割合は 0〜1、時刻は epoch ミリ秒、時間は時間"),
});
// 差・区間・確率・期待損失は事後分布(事前分布 Beta(1, 1))から出す。cvr(観測の値 y / n)どうしの差とは、参加者が少ないと合わない(B109)
const DiffSummarySchema = z.object({
  mean: z.number().describe("基準との差の事後分布の平均(ポイント)。cvr どうしの差とは、参加者が少ないと合わない"),
  ci95: z.tuple([z.number(), z.number()]).describe("差の 95% 区間(ポイント)"),
  relMean: z.number().nullable().describe("差の平均 ÷ 基準の CVR の事後分布の平均(%)。基準の CV が 0 件なら null"),
  relCi95: z.tuple([z.number(), z.number()]).nullable().describe("差の 95% 区間 ÷ 基準の CVR の事後分布の平均(%)"),
  pAboveDelta: z.number().describe("基準を最小改善幅より大きく上回る確率(0〜1)"),
  pBelowZero: z.number().describe("基準より悪い確率(0〜1)"),
  pWithinRope: z.number().nullable().describe("差が同等とみなす幅に収まる確率(0〜1)。幅を決めていなければ null"),
  expectedLossPer10k: z.number().describe("採用して実は基準より悪かった場合に失う CV の見込み(1 万人あたり)"),
});
const NormalDiffSchema = z.object({ mean: z.number(), ci95: z.tuple([z.number(), z.number()]) }).describe("基準との差(ポイント)。事後分布を正規分布で近似した参考値で、cvr どうしの差とは、参加者が少ないと合わない");
const StateSchema = z.enum(["blocked_quality", "adopt", "worse", "equivalent", "insufficient"]);

export const ResultReportSchema = z.object({
  phase: z.enum(["interim", "fixed", "stopped"]).describe("interim = 速報(評価時点の前。判定のラベルを出さない)、fixed = 評価時点の記録、stopped = 評価時点前に終了したときの記録"),
  stoppedEarly: z.boolean().describe("評価時点の前に終了したか"),
  quality: z.enum(["ok", "warning", "blocked"]).describe("データの品質。blocked は判定しない(数値は参考)"),
  records: z.enum(["available", "purged"]).describe("参加者ごとの記録が残っているか。purged は保持期間を過ぎて削除済み"),
  collection: z
    .enum(["enabled", "site_disabled", "store_missing", "not_recorded"])
    .describe("収集の状態。site_disabled = サイトで結果の記録を無効にしている、store_missing = 計測用のデータベースが導入されていない、not_recorded = 結果を記録せずに開始したテスト"),
  persisted: z.boolean().describe("この結果を保存したか(書き込みの凍結中や、保存しなかった計算は false)"),
  computedAt: z.number().int().nullable().describe("計算した時刻(epoch ミリ秒)。数値が無い応答は null"),
  cutoff: z.number().int().nullable().describe("集計に含めた最後の時刻(epoch ミリ秒)。速報は計算した時刻、記録は評価時点"),
  plan: EvaluationPlanJsonSchema.nullable().describe("評価計画(基準は判定に使った値)"),
  evaluation: z
    .object({
      minEnd: z.number().int(),
      maxEnd: z.number().int(),
      evaluationAt: z.number().int().describe("評価時点(評価時点の前に終了したときは終了の時刻)"),
      reachedAt: z.number().int().nullable().describe("目標参加者数に届いた参加の時刻"),
    })
    .nullable(),
  variants: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        original: z.boolean(),
        weight: z.number(),
        n: z.number().int().describe("参加者"),
        y: z.number().int().describe("判定に使う目標で CV した人"),
        cvr: z.number().describe("CVR(0〜1)= y ÷ n(記録の数をそのまま割った観測の値)。参加者 0 人なら 0。cvrCi95 と diff は事後分布から出すので、参加者が少ないと合わない"),
        cvrCi95: z.tuple([z.number(), z.number()]).describe("CVR の 95% 信用区間(0〜1)。事後分布(事前分布 Beta(1, 1))の 2.5% 点と 97.5% 点。CV が 0 件のパターンでは cvr がこの区間の外に出る"),
        diff: DiffSummarySchema.nullable().describe("基準との差。基準は null"),
        state: StateSchema.nullable().describe("判定の状態。速報・基準・重み 0 のパターン(配信していない)は null"),
        probBest: z.number().nullable().describe("最良である確率(配信中のパターンが 3 つ以上のとき)"),
        applyFailed: z.number().int().describe("変更が効かず、計算の時点で回復していない参加者"),
        applyRecovered: z.number().int().describe("変更が後から効いた参加者"),
        minCountMet: z.boolean().nullable().describe("判定に要る最低の件数を満たすか。基準は null"),
      }),
    )
    .describe("パターンごとの数値。数値が無い応答は空"),
  qualityDetail: z.object({
    srmP: z.number().nullable().describe("割り振りの偏りの検定の値"),
    mixedRate: z.number().describe("複数のパターンを見た参加者の割合(0〜1)"),
    stopRatio: z.number().describe("収集を止めていた時間の割合(0〜1)"),
    stopLimit: z.number().describe("収集を止めていた時間の割合の上限(これを超えると判定しない)"),
    stopPeriods: z.array(z.object({ reason: z.string(), from: z.number().int(), to: z.number().int() })).describe("収集を止めていた期間"),
    failedSends: z.number().int().describe("収集できなかった送信の数(集計に含めた最後の時刻を含む 1 時間は数えない)"),
    failureRatio: z.number().describe("収集できなかった送信の割合の目安(0〜1)"),
  }),
  byDevice: z
    .array(z.object({ variantId: z.string(), device: z.enum(["desktop", "mobile", "tablet"]), n: z.number().int(), y: z.number().int(), cvr: z.number(), diff: NormalDiffSchema.nullable() }))
    .describe("端末別(判定しない参考の値)"),
  otherGoals: z
    .array(
      z.object({
        goalId: z.string(),
        name: z.string(),
        variants: z.array(z.object({ variantId: z.string(), n: z.number().int(), y: z.number().int(), cvr: z.number(), diff: NormalDiffSchema.nullable() })),
      }),
    )
    .describe("判定に使う目標以外の目標(判定しない参考の値)"),
  planChanges: z.number().int().describe("開始後の評価計画の変更の件数"),
  deliveryChanges: z.array(z.object({ at: z.number().int(), parts: z.array(z.string()), version: z.number().int() })).describe("テスト中の配信の変更"),
  adoption: z
    .object({ variantId: z.string().nullable(), note: z.string(), decidedAt: z.number().int(), decidedBy: z.string().nullable() })
    .nullable()
    .describe("採用の記録"),
  snapshots: z.object({ evaluation: z.boolean(), stop: z.boolean() }).describe("固定した結果の記録の有無"),
  notes: z.array(NoteSchema),
  statsVersion: z.string().describe("計算の版"),
  helpKeys: z.array(z.string()).describe("説明の項目の鍵"),
  deliveredChanges: z
    .record(z.string(), z.boolean())
    .nullable()
    .describe("配信していた定義(実行中は今、終了したテストは終了の直前)で、パターンごとに変更があるか。配信を確かめた定義が無ければ null(保存済みの変更で判断する)"),
  definition: z
    .object({
      variants: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()) })),
      urlMatch: z
        .unknown()
        .describe("対象 URL(含める行 include・除く行 exclude)。対象 URL の形が行の形に変わる前に作られた記録では、古い形(1 つのページの一致 { part, op, value })のまま"),
      targeting: z.unknown(),
      primaryGoal: z.object({ id: z.string(), config: z.unknown() }).nullable(),
    })
    .nullable()
    .optional()
    .describe("結果の記録に写した、集計に含めた最後の時刻に配信していたテストの定義(記録の応答だけ)。写せなかったときは null と注記 definition_missing"),
  names: z
    .object({
      experiment: z.string(),
      variants: z.record(z.string(), z.object({ name: z.string(), original: z.boolean() })),
      goals: z.record(z.string(), z.string()).describe("目標の ID → 名前(記録を作った時点のサイトの目標。後で削除した目標も読める)"),
    })
    .optional()
    .describe("記録を作った時点の名前(記録の応答だけ)"),
});

async function loadExperiment(db: Db, siteId: string, eid: string): Promise<ExperimentRow> {
  const row = await db.selectFrom("experiments").selectAll().where("site_id", "=", siteId).where("id", "=", eid).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

/** 読んだ行数を数える(保存した速報の rows_read = 次の再計算の見込み。予約の精算は元の session が行う) */
function countingSession(read: ReadSession): ReadSession & { rowsRead(): number } {
  let rows = 0;
  return {
    async batch(stmts) {
      const out = await read.batch(stmts);
      for (const r of out) rows += r.meta?.rows_read ?? 0;
      return out;
    },
    close: () => read.close(),
    rowsRead: () => rows,
  };
}

/** guard が凍結で断ったかを覚える(checkReach は凍結を捕まえて値だけを返すので、persisted を決めるのに使う) */
function trackingGuard(base: WriteGuard): { guard: WriteGuard; frozen(): boolean } {
  let frozen = false;
  return {
    guard: async () => {
      try {
        await base();
      } catch (e) {
        if (e instanceof WriteFrozen) frozen = true;
        throw e;
      }
    },
    frozen: () => frozen,
  };
}

/**
 * 保存した速報を書く(K13・K24)。読み始めた後に公開・計画の変更・状態の変更が入っていたら書かない(それぞれが速報を消すので、
 * 古い速報を後から書き戻さない)。凍結中は書かない。戻り値 = 書いたか
 */
async function saveInterim(
  env: Env,
  site: Pick<SiteRow, "id" | "active_version">,
  exp: Pick<ExperimentRow, "id" | "status" | "run_id">,
  plan: LoadedPlan,
  report: ResultReport,
  rowsRead: number,
  guard: WriteGuard,
): Promise<boolean> {
  try {
    await guard();
  } catch (e) {
    if (e instanceof WriteFrozen) return false;
    throw e;
  }
  const res = await env.DB.prepare(
    `INSERT INTO results_interim_cache (site_id, experiment_id, computed_at, rows_read, result_json)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE EXISTS (SELECT 1 FROM experiments WHERE site_id = ?1 AND id = ?2 AND status = ?6 AND run_id = ?7)
       AND EXISTS (SELECT 1 FROM sites WHERE id = ?1 AND active_version IS ?8)
       AND (SELECT version FROM evaluation_plans WHERE site_id = ?1 AND experiment_id = ?2) IS ?9
     ON CONFLICT (site_id, experiment_id) DO UPDATE SET
       computed_at = excluded.computed_at, rows_read = excluded.rows_read, result_json = excluded.result_json
     WHERE excluded.computed_at >= results_interim_cache.computed_at`,
  )
    .bind(site.id, exp.id, report.computedAt, rowsRead, JSON.stringify(report), exp.status, exp.run_id, site.active_version, plan.version)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 結果の API の応答(記録の応答は写した定義と名前を持つ。どの応答にも今の注記と配信していた定義の Change の有無を足す) */
export type ResultsResponse = (ResultReport | ResultSnapshot) & { deliveredChanges: Record<string, boolean> | null };

/**
 * 結果の API(K13・K15)。本体(resultsCore)に、記録に入れない今の注記(未公開の変更・評価時点の後の編集)を足す
 */
export async function resultsFor(env: Env, db: Db, site: SiteRow, exp: ExperimentRow, now: number): Promise<ResultsResponse> {
  let official: Official = null;
  const report = await resultsCore(env, db, site, exp, now, (o) => {
    official = o;
  });
  return withLiveFacts(report, await liveFacts(db, site.id, exp, official, now));
}

/**
 * 結果の API の本体(K13・K15)。順: 結果を記録していない → 結果の記録がある(読むだけ。計測用 D1 も予約も使わない)→
 * 計測用 D1 が無い → 個票を消した後 → 5 分以内の保存した速報 → 読み取りの予約(断られたら保存した速報 + interim_stale)→
 * 同じ予約の中で到達の確認 → cutoff を決める → 評価時点を過ぎていれば記録を作る(同じ予約)/ 前なら集計して速報を保存
 */
type Official = { kind: "evaluation" | "stop"; snapshot: ResultSnapshot } | null;

/** onOfficial = 返す記録(保存済み・この要求で作ったもの)を呼び出し元に知らせる(今の注記が記録の定義と比べるため。読み直さない) */
async function resultsCore(env: Env, db: Db, site: SiteRow, exp: ExperimentRow, now: number, onOfficial: (o: Official) => void): Promise<ResultReport | ResultSnapshot> {
  const variants = await loadVariants(db, site.id, exp.id);
  const plan = await loadPlan(db, site.id, exp, variants);
  if (exp.run_id === null) {
    return emptyReport({ collection: "not_recorded", plan: null, evaluation: null, facts: await controlFacts(db, site.id, exp), notes: [{ key: "not_recorded" }] });
  }
  // 結果の記録(評価時点の記録、無ければ評価時点前の終了の記録)があれば、それを返す。個票を消した後も同じ数字(records: purged)
  const official = await readOfficialSnapshot(db, site.id, exp.id);
  if (official) {
    onOfficial(official);
    return serveSnapshot(env, db, site, exp, official.snapshot);
  }

  const recorded = evaluationOf(plan, exp);
  const collection = site.results_enabled === 1 ? "enabled" : "site_disabled";
  if (!env.RESULTS_DB || !env.RESULTS_BUDGET) {
    // 計測用 D1(か予算の DO)が無い導入では読めない(予約を通さずに読まない)
    return emptyReport({ collection: "store_missing", plan: plan.plan, evaluation: recorded?.view ?? null, facts: await controlFacts(db, site.id, exp), notes: [{ key: "store_missing" }] });
  }
  if (exp.results_purged_at !== null) {
    // 記録を作る前に個票を消した(数字は無い)
    return emptyReport({
      collection,
      records: "purged",
      plan: plan.plan,
      evaluation: recorded?.view ?? null,
      stoppedEarly: recorded?.point.stoppedEarly ?? false,
      facts: await controlFacts(db, site.id, exp),
      notes: [{ key: "purged", params: { days: site.results_retention_days } }],
    });
  }

  const cache = await db.selectFrom("results_interim_cache").selectAll().where("site_id", "=", site.id).where("experiment_id", "=", exp.id).executeTakeFirst();
  const beforeEvaluation = recorded !== null && now < recorded.point.evaluationAt;
  if (cache && beforeEvaluation && now - cache.computed_at < INTERIM_REUSE_MS) {
    // 計算した時刻は列の値を正にする(result_json の computedAt と同じ値を書いている)
    return { ...(JSON.parse(cache.result_json) as ResultReport), persisted: true, computedAt: cache.computed_at };
  }

  const goals = await db.selectFrom("goals").select("id").where("site_id", "=", site.id).execute();
  const otherGoals = goals.filter((g) => g.id !== plan.plan.primaryGoalId).length;
  const session = await openRead(env, utcDay(now), readEstimate(cache, otherGoals), now);
  if ("refused" in session) {
    // 予約を断られた(今日の読み取りの予算が足りない / ほかの再計算が読んでいる): 保存した速報(古い値)を返す。無ければ数値なし。
    // 評価時点を過ぎて記録がまだ無いときも同じ(記録は次に読めたときか Cron が作る)
    if (cache) {
      const saved = JSON.parse(cache.result_json) as ResultReport;
      return { ...saved, persisted: true, computedAt: cache.computed_at, notes: [...saved.notes, { key: "interim_stale", params: { reason: session.refused, computedAt: cache.computed_at } }] };
    }
    return emptyReport({
      collection,
      plan: plan.plan,
      evaluation: recorded?.view ?? null,
      facts: await controlFacts(db, site.id, exp),
      notes: [
        ...(recorded ? [{ key: "interim" as const, params: { evaluationAt: recorded.point.evaluationAt } }] : []),
        { key: "interim_stale", params: { reason: session.refused } },
      ],
    });
  }

  const read = countingSession(session);
  const tracked = trackingGuard(apiGuard(env));
  try {
    // 到達の確認(1 回目の batch)。凍結中は記録せずに見つけた値だけを使う
    const reachedAt = await checkReach(env, db, site, exp, plan, now, read, tracked.guard);
    const current: LoadedPlan = { ...plan, reachedAt: reachedAt ?? plan.reachedAt };
    const ev = evaluationOf(current, exp);
    const target = snapshotTarget(ev, now);
    if (target !== null) {
      // 評価時点を過ぎた: 同じ予約の中で記録を作る(2 回目の batch)。種類と cutoff は snapshotTarget の規則(到達の確認の後)。
      // 凍結中は保存せずに計算した値を返す
      const snap = await ensureSnapshot(env, db, site, exp, target.kind, target.cutoff, now, read, tracked.guard, { plan: current });
      if (snap === null) throw new Error("ensureSnapshot returned null for a recorded run");
      if (!snap.persisted) return snap;
      // 返った記録は正の判定の記録(競合で先に書かれた別の種類の記録を含む)。種類は記録の phase で決まる
      onOfficial({ kind: snap.phase === "stopped" ? "stop" : "evaluation", snapshot: snap });
      return serveSnapshot(env, db, site, exp, snap);
    }
    // 評価時点の前: cutoff = 今の速報(2 回目の batch)を保存する
    const report = await buildReport({ env, db, site, exp, plan: current, cutoff: now, now, read });
    const saved = await saveInterim(env, site, exp, plan, report, read.rowsRead(), tracked.guard);
    return { ...report, persisted: saved && !tracked.frozen() };
  } finally {
    // 精算の失敗で、組み立てた応答を 500 にしない・本体の例外を上書きしない(予約は DO の側で 60 秒で解け、見込みを使ったまま = 安全側)
    try {
      await read.close();
    } catch (e) {
      console.error("closing the read reservation failed (the reservation expires by itself)", e);
    }
  }
}

resultsRoutes.get(
  "/sites/:sid/experiments/:eid/results",
  describeRoute({
    tags: ["experiments"],
    summary:
      "テストの結果(閲覧者以上)。評価時点の前は速報(人数・CV・確率を出し、判定の状態は出さない)。速報は 5 分間は同じ値を返し、読み取りが混み合っているか今日の読み取りの上限に達したときは前に計算した速報を注記付きで返す。評価時点を過ぎたら評価時点で固定した結果の記録(評価時点の前に終了したときは終了の時点の記録)を返し、参加者ごとの記録を削除した後も同じ数字を返す。下書きは 409、パーソナライズは 404",
    security: [{ bearer: [] }],
    responses: {
      200: { description: "結果", content: { "application/json": { schema: resolver(ResultReportSchema) } } },
      ...errorResponses(401, 403, 404, 409),
    },
  }),
  requireSession,
  async (c) => {
    const { site } = await loadSite(c, c.req.param("sid"), "viewer");
    const db = c.get("db");
    const exp = await loadExperiment(db, site.id, c.req.param("eid"));
    if (exp.kind === "single") throw resultsNotApplicable();
    if (exp.status === "draft") {
      throw new ApiError(409, "results_not_started", { hint: "テストを開始すると、参加者と CV の集計が表示されます" });
    }
    return c.json(await resultsFor(c.env, db, site, exp, Date.now()));
  },
);
