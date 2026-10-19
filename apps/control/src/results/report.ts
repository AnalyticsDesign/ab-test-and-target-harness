import {
  betaInterval,
  type DiffSummary,
  diffNormal,
  evaluationPoint,
  type EvaluationPlan,
  type Note,
  probBest,
  STATS_VERSION,
  STOP_LIMIT_MAX,
  verdict,
  type VerdictOutput,
  type VerdictState,
  defaultBaseline,
} from "@wtt/stats";
import type { Db, ExperimentRow, SiteRow, VariantRow } from "../db";
import type { Env, StopReason } from "../env";
import type { LoadedPlan } from "../evaluation-plan";
import { aggregate, type GoalCounts } from "./aggregate";
import type { DeliveredDefinition } from "./delivered";
import type { ReadSession } from "./read-session";
import { hourOf } from "./time";

/**
 * D9 ③(plan ③ の K13・K15、設計書 §7・§9.2): 結果の API の応答の組み立て。速報(Task 9)と結果の記録(Task 10)が同じ buildReport を使う。
 * 計測用 D1 の読み取りは ctx.read だけ(予約は呼び出し元が持つ)。wtt-control は読むだけ(書かない)
 */

export type ReportPhase = "interim" | "fixed" | "stopped";
export type ReportCollection = "enabled" | "site_disabled" | "store_missing" | "not_recorded";
/** 収集の停止の理由(予算の DO の停止 + サイトで結果の記録を無効にした期間) */
export type ReportStopReason = StopReason | "site_disabled";
export type ReportStopPeriod = { reason: ReportStopReason; from: number; to: number };
export type NormalDiff = { mean: number; ci95: [number, number] };

export type ResultVariant = {
  id: string;
  name: string;
  original: boolean;
  weight: number;
  n: number;
  y: number;
  /** CVR(0〜1)= y / n。参加者 0 人なら 0 */
  cvr: number;
  /** CVR の 95% 信用区間(0〜1)= 事後分布 Beta(1 + y, 1 + n − y) の 2.5% 点と 97.5% 点(stats の betaInterval) */
  cvrCi95: [number, number];
  /** 基準との差(判定に使う目標)。基準は null */
  diff: DiffSummary | null;
  /** 判定の状態。速報・基準・重み 0 のパターン(配信していない)は null */
  state: VerdictState | null;
  probBest: number | null;
  applyFailed: number;
  applyRecovered: number;
  /** 判定に要る最低の件数を満たすか。基準は null */
  minCountMet: boolean | null;
};

export type ResultReport = {
  phase: ReportPhase;
  stoppedEarly: boolean;
  quality: "ok" | "warning" | "blocked";
  records: "available" | "purged";
  collection: ReportCollection;
  persisted: boolean;
  computedAt: number | null;
  cutoff: number | null;
  plan: EvaluationPlan | null;
  evaluation: { minEnd: number; maxEnd: number; evaluationAt: number; reachedAt: number | null } | null;
  variants: ResultVariant[];
  qualityDetail: {
    srmP: number | null;
    mixedRate: number;
    stopRatio: number;
    /** 収集の停止の割合の上限(これを超えると判定不可。CV の件数で 5% 以下に決まる) */
    stopLimit: number;
    stopPeriods: ReportStopPeriod[];
    failedSends: number;
    failureRatio: number;
  };
  byDevice: Array<{ variantId: string; device: "desktop" | "mobile" | "tablet"; n: number; y: number; cvr: number; diff: NormalDiff | null }>;
  otherGoals: Array<{ goalId: string; name: string; variants: Array<{ variantId: string; n: number; y: number; cvr: number; diff: NormalDiff | null }> }>;
  planChanges: number;
  deliveryChanges: Array<{ at: number; parts: string[]; version: number }>;
  adoption: { variantId: string | null; note: string; decidedAt: number; decidedBy: string | null } | null;
  snapshots: { evaluation: boolean; stop: boolean };
  notes: Note[];
  statsVersion: string;
  helpKeys: string[];
};

/** 結果の記録(Task 10 が result_snapshots.result_json に保存する形)。名前と定義は記録を作る時点の写し */
export type ResultSnapshot = ResultReport & {
  definition: DeliveredDefinition | null;
  names: { experiment: string; variants: Record<string, { name: string; original: boolean }>; goals: Record<string, string> };
};

const DEVICE_ORDER = ["desktop", "mobile", "tablet"] as const;

const cvrOf = (n: number, y: number) => (n === 0 ? 0 : y / n);

/**
 * 判定に使う基準。保存した計画の基準が重み 0 か今のパターンに無ければ(開始の検査を通らずに記録を始めた run)、
 * 重みが 0 より大きいパターンの既定の基準にする(verdict は重み 0 の基準で例外を投げるため)。どれも重み 0 なら null
 */
export function reportBaseline(planBaseline: string | null, variants: Pick<VariantRow, "id" | "weight" | "position" | "original">[]): string | null {
  const chosen = variants.find((v) => v.id === planBaseline);
  if (chosen && chosen.weight > 0) return chosen.id;
  return defaultBaseline(variants.filter((v) => v.weight > 0).map((v) => ({ id: v.id, position: v.position, original: v.original === 1 })));
}

/** 評価時点(開始の時刻が無ければ null)。終了したテストは終了の時刻で早期終了を見る */
export function evaluationOf(plan: LoadedPlan, exp: Pick<ExperimentRow, "started_at" | "stopped_at" | "status">, reachedAt: number | null = plan.reachedAt) {
  const startedAt = exp.started_at ?? plan.fixedAt;
  if (startedAt === null) return null;
  const stoppedAt = exp.status === "archived" ? exp.stopped_at : null;
  const p = evaluationPoint(plan.plan, startedAt, reachedAt, stoppedAt);
  return { startedAt, point: p, view: { minEnd: p.minEnd, maxEnd: p.maxEnd, evaluationAt: p.evaluationAt, reachedAt } };
}

/** wtt-control だけから決まる項目(計画の変更・テスト中の変更・採用・結果の記録の有無) */
export type ControlFacts = Pick<ResultReport, "planChanges" | "deliveryChanges" | "adoption" | "snapshots">;
export async function controlFacts(db: Db, siteId: string, exp: Pick<ExperimentRow, "id" | "run_id">): Promise<ControlFacts> {
  const [planChanges, deliveries, adoption, snapshots] = await Promise.all([
    db.selectFrom("evaluation_plan_changes").select((eb) => eb.fn.countAll<number>().as("c")).where("site_id", "=", siteId).where("experiment_id", "=", exp.id).executeTakeFirst(),
    exp.run_id === null
      ? Promise.resolve([])
      : db
          .selectFrom("experiment_delivery_changes")
          .select(["at", "parts_json", "publish_version"])
          .where("site_id", "=", siteId)
          .where("experiment_id", "=", exp.id)
          .where("run_id", "=", exp.run_id)
          .orderBy("at")
          .orderBy("id")
          .execute(),
    db.selectFrom("adoptions").selectAll().where("site_id", "=", siteId).where("experiment_id", "=", exp.id).executeTakeFirst(),
    db.selectFrom("result_snapshots").select("kind").where("site_id", "=", siteId).where("experiment_id", "=", exp.id).execute(),
  ]);
  return {
    planChanges: Number(planChanges?.c ?? 0),
    deliveryChanges: deliveries.map((d) => ({ at: d.at, parts: JSON.parse(d.parts_json) as string[], version: d.publish_version })),
    adoption: adoption ? { variantId: adoption.variant_id, note: adoption.note, decidedAt: adoption.decided_at, decidedBy: adoption.decided_by } : null,
    snapshots: { evaluation: snapshots.some((s) => s.kind === "evaluation"), stop: snapshots.some((s) => s.kind === "stop") },
  };
}

/**
 * 数値の無い応答(結果を記録していない・計測用 D1 が無い・読み取りの予約を断られて保存した速報も無い・個票を消した後)。
 * 品質は ok・数は 0 で埋める(variants は空。画面は注記で理由を出す)
 */
export function emptyReport(a: {
  phase?: ReportPhase;
  collection: ReportCollection;
  records?: "available" | "purged";
  plan: EvaluationPlan | null;
  evaluation: ResultReport["evaluation"];
  stoppedEarly?: boolean;
  facts: ControlFacts;
  notes: Note[];
}): ResultReport {
  return {
    phase: a.phase ?? "interim",
    stoppedEarly: a.stoppedEarly ?? false,
    quality: "ok",
    records: a.records ?? "available",
    collection: a.collection,
    persisted: false,
    computedAt: null,
    cutoff: null,
    plan: a.plan,
    evaluation: a.evaluation,
    variants: [],
    qualityDetail: { srmP: null, mixedRate: 0, stopRatio: 0, stopLimit: STOP_LIMIT_MAX, stopPeriods: [], failedSends: 0, failureRatio: 0 },
    byDevice: [],
    otherGoals: [],
    ...a.facts,
    notes: a.notes,
    statsVersion: STATS_VERSION,
    helpKeys: helpKeysFor({ arms: 0, facts: a.facts, purged: a.records === "purged" }),
  };
}

/** 説明の鍵(画面の「?」が引く原稿の項目)。応答に出る項目に合わせる */
function helpKeysFor(a: { arms: number; facts: ControlFacts; purged: boolean }): string[] {
  const keys = ["verdicts", "probability", "difference", "cvr", "expected-loss", "quality", "srm", "mixed", "apply-failures", "collection-failures", "collection-stops", "segments", "data-integrity"];
  if (a.arms >= 3) keys.push("best");
  if (a.facts.deliveryChanges.length > 0) keys.push("test-changes");
  if (a.facts.planChanges > 0) keys.push("plan-changes");
  if (a.facts.adoption !== null) keys.push("adopt");
  if (a.purged) keys.push("retention");
  return keys;
}

/**
 * 収集の停止の期間(開始から cutoff まで)= 予算の DO の停止 + サイトで結果の記録を無効にして公開していた期間(results_collection_log)。
 * 期間は [from, cutoff] に切り詰め、stopMs は重なりを 1 回だけ数えた合計
 */
export async function collectionStops(env: Env, db: Db, siteId: string, from: number, cutoff: number): Promise<{ periods: ReportStopPeriod[]; stopMs: number }> {
  const clip = (p: ReportStopPeriod): ReportStopPeriod | null => {
    const f = Math.max(p.from, from);
    const t = Math.min(p.to, cutoff);
    return t > f ? { reason: p.reason, from: f, to: t } : null;
  };
  const periods: ReportStopPeriod[] = [];
  if (env.RESULTS_BUDGET && cutoff > from) {
    const ns = env.RESULTS_BUDGET;
    for (const p of await ns.get(ns.idFromName("global")).stopPeriods(from, cutoff)) {
      const c = clip(p);
      if (c) periods.push(c);
    }
  }
  // 公開した収集の状態の変化(enabled 0 → 1 の間が無効)。開始の前の最後の記録で開始の時点の状態を決める。
  // 記録が無いときは有効とみなす(run_id は結果を記録するサイトで開始したときだけ振るため)
  const log = await db.selectFrom("results_collection_log").select(["at", "enabled"]).where("site_id", "=", siteId).where("at", "<=", cutoff).orderBy("at").orderBy("id").execute();
  let disabledFrom: number | null = null;
  for (const row of log) {
    if (row.enabled === 0 && disabledFrom === null) disabledFrom = row.at;
    else if (row.enabled === 1 && disabledFrom !== null) {
      const c = clip({ reason: "site_disabled", from: disabledFrom, to: row.at });
      if (c) periods.push(c);
      disabledFrom = null;
    }
  }
  if (disabledFrom !== null) {
    const c = clip({ reason: "site_disabled", from: disabledFrom, to: cutoff });
    if (c) periods.push(c);
  }
  periods.sort((a, b) => a.from - b.from || a.to - b.to);
  // 重なりを除いた合計
  let stopMs = 0;
  let curFrom = -Infinity;
  let curTo = -Infinity;
  for (const p of periods) {
    if (p.from > curTo) {
      if (curTo > curFrom) stopMs += curTo - curFrom;
      curFrom = p.from;
      curTo = p.to;
    } else curTo = Math.max(curTo, p.to);
  }
  if (curTo > curFrom) stopMs += curTo - curFrom;
  return { periods, stopMs };
}

/**
 * 収集できなかった送信の数(設計書 §6.7)。cutoff の前に終わった時の分だけ(cutoff を含む時は数えない = ResultsHealth.read の
 * 半開区間 [hourOf(開始), hourOf(cutoff)))。収集の失敗の記録の DO が無い導入では 0
 */
export async function failedSendsOf(env: Env, siteId: string, runId: string, startedAt: number, cutoff: number): Promise<number> {
  const ns = env.RESULTS_HEALTH;
  if (!ns) return 0;
  const fromHour = hourOf(startedAt);
  const toHour = hourOf(cutoff);
  if (toHour <= fromHour) return 0;
  const rows = await ns.get(ns.idFromName(siteId)).read(runId, fromHour, toHour);
  return rows.reduce((s, r) => s + r.failed, 0);
}

/** 今の Change の有無(速報の注記 aa_test・baseline_not_original は今の定義から出す。設計書 §7.3) */
async function currentHasChanges(db: Db, siteId: string, experimentId: string): Promise<Record<string, boolean>> {
  const rows = await db.selectFrom("changes").select("variant_id").distinct().where("site_id", "=", siteId).where("experiment_id", "=", experimentId).execute();
  return Object.fromEntries(rows.map((r) => [r.variant_id, true]));
}

export type BuildReportCtx = {
  env: Env;
  db: Db;
  site: SiteRow;
  exp: ExperimentRow;
  /** 評価計画。reachedAt はこの要求で見つけた到達(凍結中で記録できなかった値を含む) */
  plan: LoadedPlan;
  cutoff: number;
  now: number;
  read: ReadSession;
  /** 既定 interim。interim は判定のラベル(state)を出さず、注記 interim を先頭に足す */
  phase?: ReportPhase;
  /** パターンごとに Change があるか(注記 aa_test・baseline_not_original)。既定は今の changes の行(記録は写した定義から渡す) */
  hasChanges?: Record<string, boolean>;
};

/**
 * 結果を組み立てる(速報と記録の共通)。cutoff までの個票を 1 回の batch で集計し、判定(verdict)・品質・端末別・ほかの目標を出す。
 * 計測用 D1 の読み取りは ctx.read だけ。persisted は true で返す(保存しなかった呼び出し元が false にする)
 */
export async function buildReport(ctx: BuildReportCtx): Promise<ResultReport> {
  const { env, db, site, exp, plan, cutoff, now } = ctx;
  const phase = ctx.phase ?? "interim";
  const runId = exp.run_id;
  const rdb = env.RESULTS_DB;
  if (runId === null || !rdb) throw new Error("buildReport: the experiment has no run_id or RESULTS_DB is missing");

  const [variants, goals, facts, hasChanges] = await Promise.all([
    db.selectFrom("variants").selectAll().where("site_id", "=", site.id).where("experiment_id", "=", exp.id).orderBy("position").execute(),
    db.selectFrom("goals").select(["id", "name"]).where("site_id", "=", site.id).orderBy("created_at").orderBy("id").execute(),
    controlFacts(db, site.id, exp),
    ctx.hasChanges ? Promise.resolve(ctx.hasChanges) : currentHasChanges(db, site.id, exp.id),
  ]);
  const primaryGoalId = plan.plan.primaryGoalId;
  const others = goals.filter((g) => g.id !== primaryGoalId);
  const ev = evaluationOf(plan, exp);
  const startedAt = ev?.startedAt ?? cutoff;

  const agg = await aggregate(ctx.read, runId, { primary: primaryGoalId, others: others.map((g) => g.id) }, cutoff, rdb);
  const [stops, failedSends] = await Promise.all([
    collectionStops(env, db, site.id, startedAt, cutoff),
    failedSendsOf(env, site.id, runId, startedAt, cutoff),
  ]);

  // パターンは今の行の順(集計に出ないパターンは 0 人)
  const counts = new Map(agg.primary.map((c) => [c.variantId, c]));
  const countOf = (id: string) => counts.get(id) ?? { variantId: id, n: 0, y: 0, mixed: 0, applyFailed: 0, applyRecovered: 0 };
  const baselineId = reportBaseline(plan.plan.baselineVariantId, variants);
  const reportPlan: EvaluationPlan = { ...plan.plan, baselineVariantId: baselineId };

  let v: VerdictOutput | null = null;
  if (baselineId !== null) {
    v = verdict({
      plan: reportPlan,
      arms: variants.map((x) => {
        const c = countOf(x.id);
        return { id: x.id, weight: x.weight, n: c.n, y: c.y, mixed: c.mixed, applyFailed: c.applyFailed, hasChanges: hasChanges[x.id] === true };
      }),
      stopMs: stops.stopMs,
      elapsedMs: Math.max(0, cutoff - startedAt),
      failedSends,
      recordedRows: agg.recordedRows,
    });
  }
  const comparisons = new Map((v?.comparisons ?? []).map((c) => [c.variantId, c]));
  // 最良である確率は配信中(重み > 0)のパターンが 3 つ以上のときだけ。基準の分も出す(verdict は基準以外の分だけを返す)
  const active = variants.filter((x) => x.weight > 0);
  const best = new Map<string, number>();
  if (active.length >= 3) probBest(active.map((x) => ({ n: countOf(x.id).n, y: countOf(x.id).y }))).forEach((p, i) => best.set(active[i]!.id, p));

  const baseCounts = baselineId === null ? null : countOf(baselineId);
  const resultVariants: ResultVariant[] = variants.map((x) => {
    const c = countOf(x.id);
    const cmp = comparisons.get(x.id);
    const isBaseline = x.id === baselineId;
    return {
      id: x.id,
      name: x.name,
      original: x.original === 1,
      weight: x.weight,
      n: c.n,
      y: c.y,
      cvr: cvrOf(c.n, c.y),
      cvrCi95: betaInterval(c.n, c.y),
      diff: isBaseline ? null : (cmp?.summary ?? null),
      // 速報は判定のラベルを出さない。重み 0 のパターンは配信していない(注記 zero_weight で示す)のでラベルを持たない
      state: phase === "interim" || isBaseline || x.weight <= 0 ? null : (cmp?.state ?? null),
      probBest: best.get(x.id) ?? null,
      applyFailed: c.applyFailed,
      applyRecovered: c.applyRecovered,
      minCountMet: isBaseline ? null : (cmp?.minCountMet ?? null),
    };
  });

  // 端末別(判定に使う目標)。基準の同じ端末の行と正規近似で比べる
  const deviceKey = (variantId: string, device: string) => `${variantId}\u0000${device}`;
  const deviceCounts = new Map(agg.byDevice.map((d) => [deviceKey(d.variantId, d.device), d]));
  const variantOrder = new Map(variants.map((x, i) => [x.id, i]));
  const byDevice = [...agg.byDevice]
    .sort((a, b) => (variantOrder.get(a.variantId) ?? 1e9) - (variantOrder.get(b.variantId) ?? 1e9) || DEVICE_ORDER.indexOf(a.device) - DEVICE_ORDER.indexOf(b.device))
    .map((d) => {
      const base = baselineId === null ? null : (deviceCounts.get(deviceKey(baselineId, d.device)) ?? { n: 0, y: 0 });
      return { variantId: d.variantId, device: d.device, n: d.n, y: d.y, cvr: cvrOf(d.n, d.y), diff: base === null || d.variantId === baselineId ? null : diffNormal(base, d) };
    });

  // ほかの目標(判定しない。正規近似)
  const otherGoals = others.map((g) => {
    const rows = new Map((agg.others[g.id] ?? []).map((r: GoalCounts) => [r.variantId, r]));
    const of = (id: string) => rows.get(id) ?? { variantId: id, n: 0, y: 0 };
    const base = baselineId === null ? null : of(baselineId);
    return {
      goalId: g.id,
      name: g.name,
      variants: variants.map((x) => {
        const r = of(x.id);
        return { variantId: x.id, n: r.n, y: r.y, cvr: cvrOf(r.n, r.y), diff: base === null || x.id === baselineId ? null : diffNormal(base, r) };
      }),
    };
  });

  const notes: Note[] = [];
  if (phase === "interim" && ev) notes.push({ key: "interim", params: { evaluationAt: ev.point.evaluationAt } });
  if (ev?.point.stoppedEarly && exp.stopped_at !== null) {
    // 評価時点前の終了: 予定していた評価時点(終了が無かった場合)と終了の時刻
    const planned = evaluationPoint(plan.plan, ev.startedAt, plan.reachedAt, null).evaluationAt;
    notes.push({ key: "stopped_early", params: { evaluationAt: planned, stoppedAt: exp.stopped_at } });
  }
  notes.push(...(v?.notes ?? []));
  if (facts.deliveryChanges.length > 0) notes.push({ key: "test_changes", params: { count: facts.deliveryChanges.length } });
  if (facts.planChanges > 0) notes.push({ key: "plan_changes", params: { count: facts.planChanges } });

  const sends = failedSends + agg.recordedRows;
  return {
    phase,
    stoppedEarly: ev?.point.stoppedEarly ?? false,
    quality: v?.quality.level ?? "ok",
    records: exp.results_purged_at !== null ? "purged" : "available",
    collection: site.results_enabled === 1 ? "enabled" : "site_disabled",
    persisted: true,
    computedAt: now,
    cutoff,
    plan: reportPlan,
    evaluation: ev?.view ?? null,
    variants: resultVariants,
    qualityDetail: {
      srmP: v?.quality.srmP ?? null,
      mixedRate: v?.quality.mixedRate ?? 0,
      stopRatio: v?.quality.stopRatio ?? (cutoff > startedAt ? stops.stopMs / (cutoff - startedAt) : 0),
      stopLimit: v?.quality.stopLimit ?? STOP_LIMIT_MAX,
      stopPeriods: stops.periods,
      failedSends,
      failureRatio: v?.quality.failureRatio ?? (sends === 0 ? 0 : failedSends / sends),
    },
    byDevice,
    otherGoals,
    ...facts,
    notes,
    statsVersion: STATS_VERSION,
    helpKeys: helpKeysFor({ arms: active.length, facts, purged: exp.results_purged_at !== null }),
  };
}
