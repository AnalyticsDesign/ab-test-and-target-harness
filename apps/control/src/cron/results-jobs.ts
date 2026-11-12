// apps/control/src/cron/results-jobs.ts
import { sql } from "kysely";
import { nextUtcMidnight, utcDay } from "@wtt/core";
import { DEFAULT_PLAN } from "@wtt/stats";
import type { ExperimentRow } from "../db";
import type { Env } from "../env";
import { capacityLevel, loadPlan, mergeStoredPlan, type LoadedPlan } from "../evaluation-plan";
import { checkReach, collectUntilMap } from "../results/collect-until";
import { confirmDeliveries, sitesNeedingDeliveryConfirmation } from "../results/delivered";
import { purgeRun, PURGE_DELETE_MAX_ROWS } from "../results/purge";
import { openRead, readEstimate } from "../results/read-session";
import { evaluationOf } from "../results/report";
import { ensureSnapshot, snapshotTarget } from "../results/snapshot";
import { readCloudflarePlan, type CloudflarePlan } from "../instance-settings";
import { NOT_FROZEN_SQL as NOT_FROZEN } from "../write-freeze";
import { CronFrozen, type CronContext, type CronJob } from "./runner";
import { syncSettingsRecord } from "./sync-settings-record";

/**
 * D9 ③(plan ③ の K17・K18・K12・K11・K13・K14・K15・K24、設計書 §9.4・§6.8・§6.9): 結果の Cron のジョブ 5 本。
 * jobs.ts の登録表で results-account-guard の後に、この順で走る(どれも writesControl: true = 凍結中は丸ごと見送る)。
 *
 * - results-delivery(tick): 配信の確認がまだ要る届く定義の行を持つ Site に、デプロイ専用の Worker の状態を問い合わせて確かめる
 * - results-collect-until(tick): KV の Site の設定の記録を D1 から作った記録と比べ、違えば(印が立っていれば)書き直す。印の立った Site を先に回す(B94)
 * - results-daily(UTC 0 時以降): 到達の確認 → 評価時点の記録 → 終了の記録の補完
 * - results-capacity(tick): 計測用 D1 の大きさを測って保存し、95% 以上なら収集を止める
 * - results-purge(UTC 23 時台): 保持期限の削除 → queue → 孤児
 *
 * **続きの位置**(cron_cursors、鍵 = 「ジョブ名:段」。tick のジョブは段が 1 つでジョブ名だけ): 対象を決まった順に回し、最後に処理した対象の鍵を持つ。
 * 1 件の失敗はログに残して位置を先へ進める(CronFrozen だけは投げ直す = 凍結の後に書かない)。
 * - daily の段: 日付が変わったら先頭から。末尾まで来たらその日は終わり(END)。飛ばした対象はその日はもう試さない
 * - tick のジョブ: 位置より後に対象が無ければ、同じ実行の中で先頭から読み直す(末尾の後の空の 1 回で実行を使わない)。飛ばした対象も次の一巡で試し直す
 * 位置はジョブの終わりにまとめて書く(凍結の印が無いときだけ書く 1 文。0 行なら凍結 = CronFrozen)。
 *
 * **クエリの配分**(K17): 各ジョブは queryShare を持ち、1 件の前に見込みで ctx.queries.use を呼ぶ。足りなければ `{ more: true }`。
 * wtt-control への自前の書き込み(位置・容量・到達を確かめた日・印の 0 戻し)は、凍結の印が無いことを条件にした 1 文にして
 * 凍結の確かめの読み取りを省く(行の有無が凍結の正 = isWriteFrozen と同じ判定)。共通の関数(confirmDeliveries・checkReach・
 * ensureSnapshot・purgeRun)には ctx.assertNotFrozen を guard として渡す
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 凍結の印を条件にした書き込みが 0 行だったとき、凍結かを確かめて投げる(凍結でなければ何もしない = 対象の行が無かった) */
async function throwIfFrozen(ctx: CronContext, changes: number | undefined): Promise<void> {
  if ((changes ?? 0) > 0) return;
  await ctx.assertNotFrozen();
}

// ---------------------------------------------------------------------------------------------
// 続きの位置

/** daily の段の終わりの印(その日はもう回さない) */
const END = "#end";

type Cursors = {
  get(stage: string): string | null;
  /** 書いてある値(日付で消す前。日をまたいで続ける段が使う) */
  stored(stage: string): string | null;
  set(stage: string, cursor: string | null): void;
  /** 変わった位置をまとめて書く(1 段につき 1 文) */
  save(): Promise<void>;
};

async function loadCursors(ctx: CronContext, job: string, daily: boolean): Promise<Cursors> {
  const today = utcDay(ctx.now);
  const rows = (
    await ctx.env.DB.prepare("SELECT job, day, cursor FROM cron_cursors WHERE job = ?1 OR job LIKE ?2").bind(job, `${job}:%`).all<{ job: string; day: string; cursor: string | null }>()
  ).results;
  const stored = new Map<string, string | null>();
  // daily の段は日付が変わったら先頭から(K17)
  for (const r of rows) stored.set(r.job, daily && r.day !== today ? null : r.cursor);
  const raw = new Map(rows.map((r) => [r.job, r.cursor]));
  const current = new Map(stored);
  return {
    get: (stage) => current.get(stage) ?? null,
    stored: (stage) => raw.get(stage) ?? null,
    set: (stage, cursor) => void current.set(stage, cursor),
    async save() {
      const changed = [...current].filter(([k, v]) => (stored.get(k) ?? null) !== v);
      if (changed.length === 0) return;
      const results = await ctx.env.DB.batch(
        changed.map(([k, v]) =>
          ctx.env.DB.prepare(
            `INSERT INTO cron_cursors (job, day, cursor) SELECT ?1, ?2, ?3 WHERE ${NOT_FROZEN}
             ON CONFLICT (job) DO UPDATE SET day = excluded.day, cursor = excluded.cursor`,
          ).bind(k, today, v),
        ),
      );
      if (results.some((r) => (r.meta?.changes ?? 0) === 0)) throw new CronFrozen();
      for (const [k, v] of changed) stored.set(k, v);
    },
  };
}

/** tick のジョブが 1 回に読む対象の数 */
const TICK_PAGE = 20;
type StageOutcome = "end" | "more" | "halt";
/** 1 件の処理の結果。next = 位置を進める / retry = 位置を進めずにやめる(続きは次の実行)/ halt = 位置を進めて、この段をこの実行ではやめる */
type ItemOutcome = "next" | "retry" | "halt";

/**
 * 段を回す。list(after) は位置より後の対象を決まった順に返す。cost は 1 件の見込みのクエリの数(位置の書き込みの分を含めて use を呼ぶ)。
 * 戻り値: end = 末尾まで来た / more = 配分を使い切ったか retry / halt = 処理がやめると言った
 */
async function runStage<T>(
  ctx: CronContext,
  cursors: Cursors,
  stage: string,
  opts: {
    daily: boolean;
    list(after: string | null): Promise<T[]>;
    key(item: T): string;
    cost(item: T): number;
    process(item: T): Promise<ItemOutcome>;
  },
): Promise<StageOutcome> {
  const after = cursors.get(stage);
  if (opts.daily && after === END) return "end";
  // 位置の書き込みの分(1 文)を残す
  if (!ctx.queries.use(1 + 1)) return "more";
  let items = await opts.list(after);
  if (items.length === 0 && !opts.daily && after !== null) {
    // tick: 末尾まで来た。同じ実行の中で先頭から読み直す(この実行ではまだどの対象も処理していないので、二重には処理しない)
    cursors.set(stage, null);
    if (!ctx.queries.use(1 + 1)) return "more";
    items = await opts.list(null);
  }
  if (items.length === 0) {
    // daily: その日は終わり / tick: 対象が無い
    cursors.set(stage, opts.daily ? END : null);
    return "end";
  }
  for (const item of items) {
    if (!ctx.queries.use(opts.cost(item) + 1)) return "more";
    let out: ItemOutcome;
    try {
      out = await opts.process(item);
    } catch (e) {
      if (e instanceof CronFrozen) throw e;
      // 1 件の失敗はログに残して飛ばす(daily はその日はもう試さない / tick は次の一巡で試し直す)
      console.error(`cron ${stage}: item ${opts.key(item)} failed; skipped`, e);
      out = "next";
    }
    if (out === "retry") return "more";
    cursors.set(stage, opts.key(item));
    if (out === "halt") return "halt";
  }
  // list が返した分を処理し終えた。daily は末尾(list は対象をすべて返す)。tick は 1 回に読む数(TICK_PAGE)より少なければ末尾なので、
  // 次の実行は先頭から(末尾の後の空の読み取りを省く)。ちょうど TICK_PAGE なら続きから
  if (opts.daily) cursors.set(stage, END);
  else if (items.length < TICK_PAGE) cursors.set(stage, null);
  return "end";
}

/** 段の結果をまとめて、ジョブの戻り値にする(位置を書いてから返す) */
async function finish(cursors: Cursors, outcomes: StageOutcome[]): Promise<void | { more: true }> {
  await cursors.save();
  return outcomes.includes("more") ? { more: true } : undefined;
}

/** 位置の鍵(複数の値の組)。JSON の配列で持ち、前から順に比べる */
const tupleKey = (...parts: Array<string | number>): string => JSON.stringify(parts);
function tupleAfter(key: string, after: string | null): boolean {
  if (after === null) return true;
  const a = JSON.parse(key) as Array<string | number>;
  const b = JSON.parse(after) as Array<string | number>;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    return x > y;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// results-delivery

/**
 * 1 Site の配信の確認の見込み = 届く定義の行・依頼の記録・公開の記録の読み取り 3 + run ごとの読み直し 2 + 確かめた行 1 つの書き込み 2(凍結の確かめ・UPDATE)。
 * ローカルの実測は書く行が無ければ 5、行 1 つを確かめると 7。delivered_until の付け直し・テスト中の変更の作り直しがあればさらに増える(1 件の中では止めない)
 */
const DELIVERY_SITE_COST = 7;
/** デプロイ専用の Worker の状態の問い合わせを待つ上限(GET /sites/:sid の自己修復と同じ) */
const STATUS_TIMEOUT_MS = 2_000;

/** ms で打ち切る。勝った側が決まったらタイマーを止め、負けた側の失敗は飲み込んでログだけ(未処理の拒否を残さない) */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    const out = await Promise.race([p, timeout]);
    if (out === "timeout") p.catch((e) => console.error("cron: call after timeout failed", e));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export const resultsDeliveryJob: CronJob = {
  name: "results-delivery",
  cadence: { every: "tick" },
  writesControl: true,
  // K17 の配分は 8 だったが、Site 1 件の見込み(7)を 1 件の最低に入れると 10 になるので合わせた(fix round 2)
  queryShare: 10,
  // 1 件の最低 = 位置 1 + 対象 1 + Site 1 件の見込み 7 + 位置の書き込み 1
  queryFloor: 10,
  async run(ctx) {
    const deployer = ctx.env.DEPLOYER;
    if (!deployer) return; // デプロイ専用の Worker が無い(vitest の既定)。確かめようがない
    const cursors = await loadCursors(ctx, this.name, false);
    const out = await runStage(ctx, cursors, this.name, {
      daily: false,
      // 対象 = 配信の確認がまだ要る行を持つ Site(confirmDeliveries が読む run と同じ条件)。削除の途中の Site は除く
      list: (after) => sitesNeedingDeliveryConfirmation(ctx.db, { now: ctx.now, after, limit: TICK_PAGE }),
      key: (siteId) => siteId,
      cost: () => DELIVERY_SITE_COST,
      async process(siteId) {
        const st = await withTimeout(deployer.siteStatus(siteId), STATUS_TIMEOUT_MS);
        if (st === "timeout") throw new Error("siteStatus timed out");
        // 7o K24 (3)(4): history はそのまま渡す(digest を持つ点は同じ世代の依頼の記録の digest と組み合うときだけ数える)。
        await confirmDeliveries(ctx.db, siteId, { history: st.history, historyFrom: st.historyFrom }, ctx.now, ctx.assertNotFrozen);
        return "next";
      },
    });
    return finish(cursors, [out]);
  },
};

// ---------------------------------------------------------------------------------------------
// results-collect-until

/**
 * 1 Site の見込み(締め切りの表の計算 1 + 書き直す前の凍結の確かめ 1 + 印の 0 戻し 1)。
 * plan12 K10 でプランの読み取り 1 が足された(1 回の実行の最初の 1 Site だけ = 実際は 4)。見込みと配分表は変えない
 * (増えた分は runner が全体の残りから引くので、後ろのジョブの配分が実行の時点で少し減るだけ)
 */
const COLLECT_UNTIL_SITE_COST = 3;

export const resultsCollectUntilJob: CronJob = {
  name: "results-collect-until",
  cadence: { every: "tick" },
  writesControl: true,
  // B94: 印の段の読み取り 1 を足したので 8 → 10(印の無い実行で、全体の段が前と同じ 2 Site を回せる)
  queryShare: 10,
  // 1 件の最低 = 位置 1 + 印の段の対象 1 + 全体の段の対象 1 + Site 1 件の見込み 3 + 位置の書き込み 1(B94 で 6 → 7)
  queryFloor: 7,
  async run(ctx) {
    const cursors = await loadCursors(ctx, this.name, false);
    // plan12 K10: 比べる記録に予算が入るので、プランを使う(読むのは最初の Site を処理するときの 1 回。比べる対象が無い実行では読まない)。
    // プランを渡さずに書くと、予算の入った記録を予算なしに書き戻し、site-settings-refresh と 15 分ごとに書き合う
    let plan: CloudflarePlan | null = null;
    /** この実行で処理した Site(印の段で処理した Site を、全体の段で二度処理しない) */
    const done = new Set<string>();
    // 対象 = 書き直しの印のある Site と、run を持つエクスペリエンスがある Site(締め切りの表を持ちうる)。削除の途中の Site は除く
    // (KV を消している最中に書き戻さない)。エクスペリエンスの削除で表が空になる Site は、削除の queue を消し終えたときに印を立てる
    const list = (after: string | null, dirtyOnly: boolean) =>
      ctx.db
        .selectFrom("sites as s")
        .selectAll("s")
        .where("s.static_removing", "is", null)
        .$if(dirtyOnly, (q) => q.where("s.collect_until_dirty", "=", 1))
        .$if(!dirtyOnly, (q) =>
          q.where((w) =>
            w.or([w("s.collect_until_dirty", "=", 1), w.exists(w.selectFrom("experiments as e").select("e.id").whereRef("e.site_id", "=", "s.id").where("e.run_id", "is not", null))]),
          ),
        )
        .$if(after !== null, (q) => q.where("s.id", ">", after!))
        .orderBy("s.id")
        .limit(TICK_PAGE)
        .execute();
    const process = async (row: Awaited<ReturnType<typeof list>>[number]): Promise<ItemOutcome> => {
      if (done.has(row.id)) return "next";
      done.add(row.id);
      const table = await collectUntilMap(ctx.db, row.id);
      plan ??= await readCloudflarePlan(ctx.db);
      // 記録の全体を D1 と比べて違えば書き直す(締め切りの表だけでなく、Site の PATCH と締め切りの書き直しが重なって古い設定が残った場合も直す)。
      // 比べ方・書き方は site-settings-refresh と同じ関数(互いに上書きし合わない保証はこの共有に依る)
      await syncSettingsRecord(ctx, row, { plan, collectUntil: table });
      if (row.collect_until_dirty === 1) {
        const r = await ctx.env.DB.prepare(`UPDATE sites SET collect_until_dirty = 0 WHERE id = ?1 AND collect_until_dirty = 1 AND ${NOT_FROZEN}`).bind(row.id).run();
        await throwIfFrozen(ctx, r.meta.changes);
      }
      return "next";
    };
    // B94: 先に印の立った Site だけを回す(Site の多い導入でも、書き直しに失敗した Site を全体の一巡を待たずに直す)。
    // 位置は別に持つ(書き直しに失敗し続ける Site が先頭に居座って、後ろの印の Site を止めないため)
    const dirty = await runStage(ctx, cursors, `${this.name}:dirty`, { daily: false, list: (after) => list(after, true), key: (row) => row.id, cost: () => COLLECT_UNTIL_SITE_COST, process });
    if (dirty === "more") return finish(cursors, [dirty]);
    // 印の段で処理した Site は、全体の段では読まずに位置だけ進める(見込み 0)
    const out = await runStage(ctx, cursors, this.name, {
      daily: false,
      list: (after) => list(after, false),
      key: (row) => row.id,
      cost: (row) => (done.has(row.id) ? 0 : COLLECT_UNTIL_SITE_COST),
      process,
    });
    return finish(cursors, [out]);
  },
};

// ---------------------------------------------------------------------------------------------
// results-daily

/** 並べ替え・到達の確認に使う計画(loadPlan と同じ既定値の重ね方。基準は使わないので決めない) */
function planFromRow(row: { plan_json: string | null; fixed_at: number | null; reached_at: number | null; version: number | null }): LoadedPlan {
  if (row.plan_json === null) return { plan: { ...DEFAULT_PLAN, primaryGoalId: null, baselineVariantId: null }, fixedAt: null, reachedAt: null, version: null };
  return { plan: mergeStoredPlan({ plan_json: row.plan_json, fixed_at: row.fixed_at }), fixedAt: row.fixed_at, reachedAt: row.reached_at, version: row.version };
}

type DailyCandidate = {
  exp: ExperimentRow;
  plan: LoadedPlan;
  evaluationAt: number;
  /** 速報の保存(読み取りの見込みに使う) */
  cache: { rows_read: number; result_json: string } | undefined;
  otherGoals: number;
  /** 重みが 0 より大きいパターンの数(到達の確認の読み取りの見込み) */
  activeVariants: number;
};

/** 結果を記録するテスト(run を持ち、個票を消していない)と計画・保存した速報。statuses で状態を絞る */
async function dailyCandidates(ctx: CronContext, statuses: ExperimentRow["status"][], extra: "reach" | "snapshot"): Promise<DailyCandidate[]> {
  const today = utcDay(ctx.now);
  let q = ctx.db
    .selectFrom("experiments as e")
    .leftJoin("evaluation_plans as p", (j) => j.onRef("p.site_id", "=", "e.site_id").onRef("p.experiment_id", "=", "e.id"))
    .leftJoin("results_interim_cache as c", (j) => j.onRef("c.site_id", "=", "e.site_id").onRef("c.experiment_id", "=", "e.id"))
    .selectAll("e")
    .select(["p.plan_json", "p.fixed_at", "p.reached_at", "p.version", "c.rows_read as cache_rows_read", "c.result_json as cache_json"])
    // ほかの目標の数(読み取りの見込み = 結果の API と同じ readEstimate)と、配信中のパターンの数
    .select(
      sql<number>`(SELECT COUNT(*) FROM goals g WHERE g.site_id = e.site_id AND g.id IS NOT json_extract(p.plan_json, '$.primaryGoalId'))`.as("other_goals"),
    )
    .select(sql<number>`(SELECT COUNT(*) FROM variants v WHERE v.site_id = e.site_id AND v.experiment_id = e.id AND v.weight > 0)`.as("active_variants"))
    .where("e.kind", "<>", "single")
    .where("e.status", "in", statuses)
    .where("e.run_id", "is not", null)
    .where("e.results_purged_at", "is", null);
  if (extra === "reach") {
    // 目標参加者数があって到達を記録しておらず、今日まだ確かめていない run
    q = q
      .where("p.fixed_at", "is not", null)
      .where("p.reached_at", "is", null)
      .where((w) => w.or([w("p.reach_checked_day", "is", null), w("p.reach_checked_day", "<>", today)]));
  } else {
    // 記録がまだ無い run(評価時点の記録・終了の記録のどちらも無い)
    q = q.where((w) => w.not(w.exists(w.selectFrom("result_snapshots as r").select("r.kind").whereRef("r.site_id", "=", "e.site_id").whereRef("r.experiment_id", "=", "e.id"))));
  }
  const rows = await q.execute();
  const out: DailyCandidate[] = [];
  for (const r of rows) {
    const { plan_json, fixed_at, reached_at, version, cache_rows_read, cache_json, other_goals, active_variants, ...exp } = r;
    const plan = planFromRow({ plan_json, fixed_at, reached_at, version });
    if (extra === "reach" && plan.plan.targetPerVariant === null) continue;
    const ev = evaluationOf(plan, exp as ExperimentRow);
    if (ev === null) continue;
    out.push({
      exp: exp as ExperimentRow,
      plan,
      evaluationAt: ev.point.evaluationAt,
      cache: cache_rows_read !== null && cache_json !== null ? { rows_read: cache_rows_read, result_json: cache_json } : undefined,
      otherGoals: Number(other_goals ?? 0),
      activeVariants: Number(active_variants ?? 0),
    });
  }
  // 評価時点(終了の時刻)の早い順、同じなら (site_id, experiment_id)
  return out.sort((a, b) => a.evaluationAt - b.evaluationAt || (a.exp.site_id < b.exp.site_id ? -1 : a.exp.site_id > b.exp.site_id ? 1 : a.exp.id < b.exp.id ? -1 : a.exp.id > b.exp.id ? 1 : 0));
}
const dailyKey = (c: DailyCandidate) => tupleKey(c.evaluationAt, c.exp.site_id, c.exp.id);

/**
 * 到達の確認の見込み(D1 の呼び出し。パターンの読み取り 1 + 計測用 D1 の batch 1 + 到達の記録 2(凍結の確かめ・UPDATE)+ 締め切りの書き直し 3 + 確かめた日 1)。
 * 締め切りの書き直し(rewriteCollectUntil)は Site の行・プラン・締め切りの表の読み取り 3(plan12 K10 でプランの読み取りが増えて 2 → 3)。
 * 実際は 8 で、見込みの 7 を 1 超える。見込みと配分表は変えない(runner が吸収する)
 */
const REACH_COST = 7;
/**
 * 記録 1 件の見込み(D1 の呼び出し)。ローカルの実測(2026-10-19、countingD1 で数えた)は到達を記録しない場合 17:
 * Site・パターン・計画の読み取り 3 + 到達の確認 2(パターン・計測用 D1 の batch)+ 記録の作成 12(記録の有無・パターン・目標・
 * 届く定義・計画の変更・テスト中の変更・採用・記録の有無・Change・収集の切り替えの読み取り、計測用 D1 の集計の batch 1、凍結の確かめと INSERT)。
 * 同じ件で到達を記録すると + 5(凍結の確かめ・UPDATE・締め切りの書き直しの読み取り 3。plan12 K10 でプランの読み取りが増えて +4 → +5)。
 * 定数は 17 + 4 のままで、到達を記録する件は実際は 1 超える(配分表は変えない。runner が吸収する)
 */
const SNAPSHOT_COST = 17 + 4;

/** 1 回の実行で作る記録の数(K17。判定の計算の CPU が Free の 10 ms に収まるように) */
const SNAPSHOTS_PER_RUN = 1;

export const resultsDailyJob: CronJob = {
  name: "results-daily",
  cadence: { daily: { afterUtcHour: 0 } },
  writesControl: true,
  // K17 の配分は 10 だったが、記録 1 件の実測(SNAPSHOT_COST)が収まらないので直した: 位置 1 + 対象の読み取り 2 + 記録 21 + 位置の書き込み 1 + 段の入口の確かめの余裕
  queryShare: 26,
  // 1 件の最低 = 位置 1 + 対象 1 + 到達の確認 1 件 7 + 位置の書き込み 1。記録 1 件は 25 で、daily 優先の枠の配分に収まる
  queryFloor: 10,
  async run(ctx) {
    const { env, db, now } = ctx;
    if (!env.RESULTS_DB || !env.RESULTS_BUDGET) return; // 計測用 D1 か予算の DO が無い導入では読めない
    const today = utcDay(now);
    const cursors = await loadCursors(ctx, this.name, true);
    const siteOf = async (id: string) => db.selectFrom("sites").selectAll().where("id", "=", id).executeTakeFirst();

    // 0. 到達の確認(実行中・一時停止中で目標参加者数があり、到達を記録していないテスト)
    const reach = await runStage(ctx, cursors, `${this.name}:reach`, {
      daily: true,
      list: async (after) => (await dailyCandidates(ctx, ["running", "paused"], "reach")).filter((c) => tupleAfter(dailyKey(c), after)),
      key: dailyKey,
      cost: () => REACH_COST,
      async process(c) {
        const target = c.plan.plan.targetPerVariant!;
        // 読み取りの見込み = パターンごとに target 人目までを読む
        const session = await openRead(env, today, Math.max(1, target * c.activeVariants + c.activeVariants), now);
        if ("refused" in session) return session.refused === "busy" ? "retry" : "halt";
        try {
          await checkReach(env, db, { id: c.exp.site_id }, c.exp, c.plan, now, session, ctx.assertNotFrozen);
        } finally {
          await session.close();
        }
        const r = await env.DB.prepare(`UPDATE evaluation_plans SET reach_checked_day = ?1 WHERE site_id = ?2 AND experiment_id = ?3 AND ${NOT_FROZEN}`)
          .bind(today, c.exp.site_id, c.exp.id)
          .run();
        await throwIfFrozen(ctx, r.meta.changes);
        return "next";
      },
    });
    if (reach === "more") return finish(cursors, [reach]);

    // 1・2. 評価時点の記録 → 終了の記録の補完。種類と cutoff は API と同じ snapshotTarget で決める(到達の確認の後の計画で)
    let made = 0;
    // 対象は 2 つの段で 1 回だけ読む(評価時点の記録と終了の記録を種類で分ける)
    let snapshotList: DailyCandidate[] | null = null;
    const snapshotCandidates = async () => (snapshotList ??= await dailyCandidates(ctx, ["running", "paused", "archived"], "snapshot"));
    const snapshotStage = (stage: "snapshot" | "stop-snapshot") =>
      runStage(ctx, cursors, `${this.name}:${stage}`, {
        daily: true,
        list: async (after) =>
          (await snapshotCandidates()).filter((c) => {
            const t = snapshotTarget(evaluationOf(c.plan, c.exp), now);
            return t !== null && (t.kind === "evaluation") === (stage === "snapshot") && tupleAfter(dailyKey(c), after);
          }),
        key: dailyKey,
        cost: () => SNAPSHOT_COST,
        async process(c) {
          if (made >= SNAPSHOTS_PER_RUN) return "retry";
          const site = await siteOf(c.exp.site_id);
          if (!site) return "next";
          const session = await openRead(env, today, readEstimate(c.cache, c.otherGoals), now);
          if ("refused" in session) return session.refused === "busy" ? "retry" : "halt";
          made++;
          try {
            const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).where("experiment_id", "=", c.exp.id).orderBy("position").execute();
            const plan = await loadPlan(db, site.id, c.exp, variants);
            // API(結果の API・終了)と同じ順: 到達の確認 → 評価時点 → 記録の種類と cutoff → 記録(同じ予約の中)
            const reachedAt = await checkReach(env, db, site, c.exp, plan, now, session, ctx.assertNotFrozen);
            const current: LoadedPlan = { ...plan, reachedAt: reachedAt ?? plan.reachedAt };
            const target = snapshotTarget(evaluationOf(current, c.exp), now);
            if (target !== null) await ensureSnapshot(env, db, site, c.exp, target.kind, target.cutoff, now, session, ctx.assertNotFrozen, { plan: current });
          } finally {
            await session.close();
          }
          return "next";
        },
      });
    const evaluation = await snapshotStage("snapshot");
    if (evaluation !== "end") return finish(cursors, [evaluation === "halt" ? "end" : evaluation]);
    const stop = await snapshotStage("stop-snapshot");
    return finish(cursors, [stop]);
  },
};

// ---------------------------------------------------------------------------------------------
// results-capacity

/** 次の UTC 23:00(今が 23 時台なら翌日の 23:00) */
export function nextUtc2300(now: number): number {
  const today2300 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(), 23);
  return now < today2300 ? today2300 : today2300 + DAY_MS;
}

export const resultsCapacityJob: CronJob = {
  name: "results-capacity",
  cadence: { every: "tick" },
  writesControl: true,
  // 配分 3 = 読み取りの予約の中の SELECT 1(1)+ upsert(1)+ 23 時台に 95% 以上のときの results-purge の記録の読み取り(1)。
  // 登録の順では daily の後ろだが、配分は runner が残す(queryReserved)
  queryShare: 3,
  queryFloor: 2,
  queryReserved: true,
  async run(ctx) {
    const { env, now } = ctx;
    const rdb = env.RESULTS_DB;
    const ns = env.RESULTS_BUDGET;
    if (!rdb || !ns) return;
    if (!ctx.queries.use(2)) return { more: true };
    // 容量の取得も読み取りの予約を通す(K13。SELECT 1 は行を読まない)
    const session = await openRead(env, utcDay(now), 1, now);
    if ("refused" in session) {
      console.log(`results-capacity: read reservation refused (${session.refused}); measuring next time`);
      return;
    }
    let size: number;
    try {
      const [r] = await session.batch([rdb.prepare("SELECT 1")]);
      size = Number(r?.meta?.size_after ?? NaN);
    } finally {
      await session.close();
    }
    if (!Number.isFinite(size)) throw new Error("results-capacity: size_after is missing");
    const w = await env.DB.prepare(
      `INSERT INTO results_store_status (id, size_bytes, measured_at) SELECT 1, ?1, ?2 WHERE ${NOT_FROZEN}
       ON CONFLICT (id) DO UPDATE SET size_bytes = excluded.size_bytes, measured_at = excluded.measured_at`,
    )
      .bind(size, now)
      .run();
    await throwIfFrozen(ctx, w.meta.changes);
    if (capacityLevel(size) !== "stopped") return;
    // K18: UTC 23 時台は、その日の削除(results-purge)を終えるまで止めない(停止中は lease が枠を出さず、削除できないため)
    if (new Date(now).getUTCHours() === 23) {
      // 配分 3 の 3 件目(SELECT 1・upsert の後)。足りなければ立てずに次の実行で測り直す
      if (!ctx.queries.use(1)) return { more: true };
      const purge = await ctx.db.selectFrom("cron_job_runs").select("last_run_day").where("job", "=", resultsPurgeJob.name).executeTakeFirst();
      if (purge?.last_run_day !== utcDay(now)) {
        console.log("results-capacity: over 95%, waiting for today's purge before stopping");
        return;
      }
    }
    await ns.get(ns.idFromName("global")).stop("capacity", nextUtc2300(now), now);
    console.log(`results-capacity: stopped results collection (${size} bytes)`);
  },
};

// ---------------------------------------------------------------------------------------------
// results-purge

/** 削除の日に削除しない停止の理由(K18。容量の停止の日は削除を優先する) */
const BLOCKING_STOPS = new Set(["account_usage", "d1_limit", "write_budget"]);

/**
 * UTC 23 時台の削除の量(K12)= 予算 − 今日書いた行 − ceil(今日書いた行 / 経過した時間) × 0 時までの残りの時間(1 時間に切り上げ)
 */
export function purgeAllowance(st: { writeBudget: number; writeUsed: number }, now: number): number {
  const dayStart = nextUtcMidnight(now) - DAY_MS;
  const elapsedHours = Math.max(1, (now - dayStart) / HOUR_MS);
  const hoursLeft = Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / HOUR_MS));
  return Math.max(0, st.writeBudget - st.writeUsed - Math.ceil(st.writeUsed / elapsedHours) * hoursLeft);
}

/**
 * purgeRun の 1 回の呼び出しのクエリの見込み: queue の読み取り 1(Site・Workspace の削除なら run_id の確かめ 1)+ 繰り返しごとに
 * 残りの確かめ 1・参加の DELETE 1・CV の DELETE 1 + 最後の確かめ 1 + 消し終えた記録(凍結の確かめ 1 + batch 1)
 */
const PURGE_FIXED_COST = 1 + 1 + 1 + 1;
const PURGE_ROUND_COST = 3;
/** 消し終えた後の自前の書き込み(締め切りの書き直しの印 1) */
const PURGE_AFTER_COST = 1;
/** Site・Workspace の削除で積んだ行は、purgeRun が先に「その run がまだ Site のエクスペリエンスにあるか」を確かめる(1。B155 で Site の行の確かめから替えた。主キー (site_id, id) の先頭で引く 1 回) */
const PURGE_SITE_CHECK_COST = 1;
const siteCheckCost = (reason: string) => (reason === "site_deleted" || reason === "workspace_deleted" ? PURGE_SITE_CHECK_COST : 0);
/** 孤児を消す直前に wtt-control を読み直す(1) */
const ORPHAN_RECHECK_COST = 1;

export const resultsPurgeJob: CronJob = {
  name: "results-purge",
  cadence: { daily: { afterUtcHour: 23 } },
  writesControl: true,
  // K17 の配分は 10 だったが、位置 1 + 対象の読み取り 2 + 位置の書き込み 1 の上に purgeRun の 1 回(繰り返し 1 回で 7)と孤児の確かめ(run の一覧 1・次の run 1)が
  // 収まらず、孤児を消せる日が来ないので直した(繰り返しは 1 回の実行で 2〜3 回 = 4,000〜6,000 行)
  queryShare: 16,
  // 1 件の最低 = 位置 1 + 対象 1 + purgeRun の繰り返し 1 回(4 + 3)+ 位置の書き込み 1
  queryFloor: 10,
  // B93(2026-10-21 ユーザー決定): Paid では配分 116 = 繰り返し 約 36 回 = 1 回の実行で 約 7.2 万行、23 時台の 4 回で 最大 約 29 万行 / 日。
  // 設計の最大(1 群 7 万人 / 日の 2 群 + CV = 約 15 万行 / 日)を、4 回のうち 1 回が欠けても消せる量。D1 の 1 回の呼び出しの上限 1,000・
  // Workers のサブリクエスト(Paid 10,000。繰り返し 1 回で D1 3 + 予算の DO 4)には遠い。時間は繰り返し 1 回 0.3〜1 秒の仮定で 11〜36 秒(未実測。
  // deploy の後に tail の wall で確かめる)。実際に消す量は、書き込みの予算の残り(purgeAllowance)でも頭打ちになる
  paidExtraShare: 100,
  async run(ctx) {
    const { env, db, now } = ctx;
    const ns = env.RESULTS_BUDGET;
    const rdb = env.RESULTS_DB;
    if (!rdb || !ns) return;
    const budget = ns.get(ns.idFromName("global"));
    const st = await budget.status(now);
    const dayStart = nextUtcMidnight(now) - DAY_MS;
    // K18: 容量以外の理由で止めた日は削除しない(管理操作の枠を守る。期限の削除は翌日)
    const stops = await budget.stopPeriods(dayStart, now + 1);
    const blocking = stops.find((p) => BLOCKING_STOPS.has(p.reason));
    if (blocking) {
      console.log(`results-purge: collection was stopped today (${blocking.reason}); purging tomorrow`);
      return;
    }
    let allowance = purgeAllowance(st, now);
    const cursors = await loadCursors(ctx, this.name, true);
    const guard = ctx.assertNotFrozen;

    /**
     * 1 run を消す。戻り値は段の 1 件の結果。extraCost = purgeRun の前後の決まった読み書き(run_id の確かめ・孤児の確かめ直し)、
     * after = 消し終えた後の自前の書き込み(PURGE_AFTER_COST)、precheck = 消す直前の確かめ(false なら消さずに次へ)
     */
    const purge = async (
      siteId: string,
      runId: string,
      o: { extraCost?: number; after?: () => Promise<void>; precheck?: () => Promise<boolean> } = {},
    ): Promise<ItemOutcome> => {
      const { extraCost = 0, after, precheck } = o;
      const rounds = Math.floor((ctx.queries.left() - PURGE_FIXED_COST - extraCost - (after ? PURGE_AFTER_COST : 0) - 1) / PURGE_ROUND_COST);
      if (rounds < 1) return "retry";
      if (allowance < 1) return "halt";
      // 消す直前の確かめ(孤児: 一覧を読んだ後に同じ run が wtt-control に現れたら消さない)
      if (precheck && !(await precheck())) return "next";
      const maxRows = Math.min(allowance, rounds * PURGE_DELETE_MAX_ROWS);
      const r = await purgeRun(env, siteId, runId, maxRows, now, guard);
      allowance -= r.rowsWritten;
      if (r.done) {
        if (after) await after();
        return "next";
      }
      // 上限まで消した: 今日の量を使い切ったならその日はやめる / クエリの配分の分なら次の実行で同じ run から続ける
      if (r.rowsWritten >= maxRows) return allowance < 1 ? "halt" : "retry";
      // 枠を受け取れない(予算・停止)か、読み取りの予約を断られた: その日はやめる
      return "halt";
    };
    const outcomes: StageOutcome[] = [];
    const stage = async <T>(name: string, opts: Omit<Parameters<typeof runStage<T>>[3], "daily">): Promise<boolean> => {
      const out = await runStage<T>(ctx, cursors, `${this.name}:${name}`, { daily: true, ...opts });
      outcomes.push(out);
      // halt = 予算・停止・今日の量でその日はやめる(後の段も回さない)
      return out === "end";
    };

    // 4. 保持期限の削除: 記録(評価時点か終了)がある run のうち、収集を終えた時点(記録の cutoff)から保持期間を過ぎたもの。期限の古い順
    type RetentionItem = { site_id: string; run_id: string; expires_at: number };
    const ok1 = await stage<RetentionItem>("retention", {
      list: async (after) =>
        (
          await env.DB.prepare(
            `SELECT e.site_id, e.run_id, MIN(r.cutoff_at) + s.results_retention_days * ${DAY_MS} AS expires_at
             FROM experiments e
             JOIN result_snapshots r ON r.site_id = e.site_id AND r.experiment_id = e.id AND r.run_id = e.run_id
             JOIN sites s ON s.id = e.site_id
             WHERE e.run_id IS NOT NULL AND e.results_purged_at IS NULL
             GROUP BY e.site_id, e.id
             HAVING expires_at <= ?1
             ORDER BY expires_at, e.run_id`,
          )
            .bind(now)
            .all<RetentionItem>()
        ).results.filter((x) => tupleAfter(tupleKey(x.expires_at, x.run_id), after)),
      key: (x) => tupleKey(x.expires_at, x.run_id),
      cost: () => PURGE_FIXED_COST + PURGE_ROUND_COST,
      process: (x) => purge(x.site_id, x.run_id),
    });
    if (!ok1) return finish(cursors, outcomes);

    // 5. queue(エクスペリエンス・Site・Workspace の削除で残った run)。エクスペリエンスの削除なら、消し終えた後に Site の締め切りの
    //    表を書き直す印を立てる(表から消えた run を results-collect-until が KV から外す)
    type QueueItem = { site_id: string; run_id: string; reason: string };
    const ok2 = await stage<QueueItem>("queue", {
      list: async (after) =>
        (
          await db.selectFrom("results_purge_queue").select(["site_id", "run_id", "reason"]).orderBy("site_id").orderBy("run_id").execute()
        ).filter((x) => tupleAfter(tupleKey(x.site_id, x.run_id), after)),
      key: (x) => tupleKey(x.site_id, x.run_id),
      cost: (x) => PURGE_FIXED_COST + siteCheckCost(x.reason) + PURGE_ROUND_COST + (x.reason === "experiment_deleted" ? PURGE_AFTER_COST : 0),
      process: (x) =>
        purge(x.site_id, x.run_id, {
          extraCost: siteCheckCost(x.reason),
          ...(x.reason === "experiment_deleted"
            ? {
                after: async () => {
                  const r = await env.DB.prepare(`UPDATE sites SET collect_until_dirty = 1 WHERE id = ?1 AND ${NOT_FROZEN}`).bind(x.site_id).run();
                  await throwIfFrozen(ctx, r.meta.changes);
                },
              }
            : {}),
        }),
    });
    if (!ok2) return finish(cursors, outcomes);

    // 6. 孤児: wtt-control に対応する run(エクスペリエンスか queue)が無い wtt-results の行。参加 → CV の順に、run_id の昇順で
    //    1 回 1 行ずつ次の run を引く(主キーの先頭が run_id なので 1 回 1 行程度)。配分の残りでできるだけ進め、続きは翌日(下の orphanStage)
    await orphanStage(ctx, cursors, `${this.name}:orphan`, purge);
    return finish(cursors, outcomes);
  },
};

/**
 * 孤児の掃除(K13)。位置は ["p" | "c", run_id]。ほかの段と次の 2 点が違う:
 * - 日付が変わっても位置を消さず、末尾まで来たら(END)次の日に先頭から。1 日に引ける run の数が配分で限られ、毎日先頭からでは
 *   後ろの run に届かないため
 * - 配分を使い切っても `{ more: true }` にしない(孤児は急がない。期限の削除と queue が済めばその日の削除を終えたことにし、
 *   容量の停止の立て直し(results-capacity)を待たせない)。続きは翌日
 * 対応する run の有無は、wtt-control の run の一覧を 1 回だけ読んで確かめる
 */
async function orphanStage(ctx: CronContext, cursors: Cursors, stage: string, purge: (siteId: string, runId: string, o: { extraCost: number; precheck: () => Promise<boolean> }) => Promise<ItemOutcome>,
): Promise<void> {
  const { env, now } = ctx;
  const rdb = env.RESULTS_DB!;
  // 今日すでに末尾まで来た(END)なら回さない。それ以外は日をまたいだ位置から続ける
  if (cursors.get(stage) === END) return;
  let at = cursors.get(stage) ?? cursors.stored(stage);
  if (at === END) at = null;
  // run の一覧の読み取り 1 + 位置の書き込み 1
  if (!ctx.queries.use(2)) return;
  const known = new Set(
    (
      await env.DB.prepare("SELECT run_id FROM experiments WHERE run_id IS NOT NULL UNION SELECT run_id FROM results_purge_queue").all<{ run_id: string }>()
    ).results.map((r) => r.run_id),
  );
  for (;;) {
    // 1 件 = 次の run の読み取り 1 + 位置 1(孤児なら purgeRun の分は purge が自分で見る)
    if (!ctx.queries.use(2)) return;
    const [table, after] = at === null ? ["p", ""] : (JSON.parse(at) as ["p" | "c", string]);
    const session = await openRead(env, utcDay(now), 2, now);
    if ("refused" in session) return;
    let next: { run_id: string; site_id?: string } | undefined;
    try {
      const sqlText =
        table === "p" ? "SELECT run_id, site_id FROM participants WHERE run_id > ?1 ORDER BY run_id LIMIT 1" : "SELECT run_id FROM conversions WHERE run_id > ?1 ORDER BY run_id LIMIT 1";
      const [r] = await session.batch([rdb.prepare(sqlText).bind(after)]);
      next = r?.results?.[0] as typeof next;
    } finally {
      await session.close();
    }
    if (!next) {
      if (table === "p") {
        at = JSON.stringify(["c", ""]);
        cursors.set(stage, at);
        continue;
      }
      // 末尾まで来た: 今日は終わり、次の日は先頭から
      cursors.set(stage, END);
      return;
    }
    let out: ItemOutcome = "next";
    if (!known.has(next.run_id)) {
      try {
        // CV だけの孤児は Site が分からない(queue の確かめと results_purged_at の記録は空振りする)。
        // 消す直前に wtt-control を読み直し、一覧を読んだ後に同じ run_id のエクスペリエンスか queue の行ができていれば消さない
        const runId = next.run_id;
        out = await purge(next.site_id ?? "", runId, {
          extraCost: ORPHAN_RECHECK_COST,
          precheck: async () =>
            (await env.DB.prepare("SELECT 1 AS k FROM experiments WHERE run_id = ?1 UNION ALL SELECT 1 FROM results_purge_queue WHERE run_id = ?1 LIMIT 1").bind(runId).first()) === null,
        });
      } catch (e) {
        if (e instanceof CronFrozen) throw e;
        console.error(`cron ${stage}: run ${next.run_id} failed; skipped`, e);
      }
    }
    // retry = 配分が足りず消しきれない / halt = 予算・停止。どちらも位置を進めずに翌日へ
    if (out !== "next") return;
    at = JSON.stringify([table, next.run_id]);
    cursors.set(stage, at);
  }
}
