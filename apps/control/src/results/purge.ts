import { sql } from "kysely";
import { utcDay } from "@wtt/core";
import { getDb, toStatement, type Db, type PurgeReason } from "../db";
import type { Env } from "../env";
import { apiGuard, type WriteGuard } from "./guard";
import { openRead } from "./read-session";

/**
 * D9 ③(plan ③ の K6・K12、設計書 §6.8・§6.9): 計測用 D1(wtt-results)の個票の削除。削除はこの purgeRun だけで行う
 * (エクスペリエンス・Site・Workspace の削除の直後の waitUntil、UTC 23 時台の Cron の期限の削除と queue の処理)。
 *
 * 1 回の繰り返し: 予算の状態を読む → 読み取りを予約(openRead)→ 残りの有無を確かめる → 書き込みの枠を受け取る(lease)
 * → 参加・CV の順に、受け取った行数までだけ DELETE → 精算。
 * - 1 回の DELETE は 2,000 行まで。LIMIT は「受け取った lease.rows と maxRows の残り」の小さい方(lease は残りが少なければ一部だけ返す)
 * - lease に求める行数は「その日の残り − 1」以下(残りをすべて受け取ると DO が write_budget の停止を立て、訪問者の書き込みが UTC 0 時まで止まる)
 * - 停止中(容量・アカウントの使用量・D1 の上限・予算)は消さない(lease も停止中は枠を出さない。K18)。使い残した枠は戻さない(edge と同じ)
 * - 予約を先に取る: lease の後に読み取りを断られると、受け取った枠が無駄になるため(予約は断られても精算で戻る)
 * - 消し終えたら(参加も CV も残っていない)、wtt-control の queue の行を消し、エクスペリエンスが残っていれば results_purged_at を入れる
 */

/** 1 回の DELETE の行数の上限 */
export const PURGE_DELETE_MAX_ROWS = 2_000;
/**
 * DELETE の読み取り行数の見込み = 消す行数 × この倍率。PoC(2026-10-17、`DELETE … LIMIT`)は 4 倍。
 * 新しい SQL(`… IN (SELECT … LIMIT ?2)`)も、ローカル(miniflare の D1)で参加・CV とも 4 倍だった
 * (2,000 行 → 8,000、1,000 行 → 4,000、CV 1,500 行 → 6,001。2026-10-19、plan ③ Task 4)
 */
export const PURGE_READ_ROWS_PER_ROW = 4;
/** 残りの有無の確かめ(EXISTS 2 つ)の読み取り行数の見込み(ローカルの実測は 0〜2) */
const PROBE_READ_ROWS = 2;

const SQL = {
  probe: `SELECT EXISTS (SELECT 1 FROM participants WHERE run_id = ?1) AS p, EXISTS (SELECT 1 FROM conversions WHERE run_id = ?1) AS c`,
  participants: `DELETE FROM participants WHERE run_id = ?1 AND visitor_key IN (SELECT visitor_key FROM participants WHERE run_id = ?1 LIMIT ?2)`,
  conversions: `DELETE FROM conversions WHERE run_id = ?1 AND (goal_id, visitor_key) IN (SELECT goal_id, visitor_key FROM conversions WHERE run_id = ?1 LIMIT ?2)`,
} as const;

/** DELETE が使った書き込みの行数(予算の数え方。PoC で DELETE は消した行 1 つにつき 1。rows_written が無ければ changes) */
const writtenBy = (r: D1Result): number => Math.max(r.meta?.rows_written ?? 0, r.meta?.changes ?? 0);

export async function purgeRun(env: Env, siteId: string, runId: string, maxRows: number, now: number, guard: WriteGuard): Promise<{ done: boolean; rowsWritten: number }> {
  const db = getDb(env);
  // K6・B155(G26 (d)): Site・Workspace の削除で積んだ行は、その run がまだ Site のエクスペリエンスにあるとき(= 削除が取りやめになった)だけ
  // queue の行だけを消す(個票は Site のエクスペリエンスの run として、期限の削除が扱う)。「Site の行がある」では判定しない:
  // 同じ ID で作り直したサイトは同じ run_id を持たない(run_id は開始ごとの乱数)ので、作り直しで個票が残らないようにする
  const queued = await db.selectFrom("results_purge_queue").select("reason").where("site_id", "=", siteId).where("run_id", "=", runId).executeTakeFirst();
  if (queued && (queued.reason === "site_deleted" || queued.reason === "workspace_deleted")) {
    const live = await db.selectFrom("experiments").select("id").where("site_id", "=", siteId).where("run_id", "=", runId).executeTakeFirst();
    if (live) {
      await guard();
      await db.deleteFrom("results_purge_queue").where("site_id", "=", siteId).where("run_id", "=", runId).execute();
      return { done: true, rowsWritten: 0 };
    }
  }
  const rdb = env.RESULTS_DB;
  const ns = env.RESULTS_BUDGET;
  if (!rdb || !ns) return { done: false, rowsWritten: 0 };
  const budget = ns.get(ns.idFromName("global"));
  const day = utcDay(now);
  let written = 0;
  for (;;) {
    const left = Math.floor(maxRows) - written;
    if (left < 1) return { done: false, rowsWritten: written };
    const st = await budget.status(now);
    if (st.stoppedUntil !== null) return { done: false, rowsWritten: written };
    // 「残り − 1」は lease の前に読んだ status の値で決めるので厳密ではない(間に edge が枠を使えば、lease が残りすべてを配って停止が立ちうる)
    const want = Math.min(PURGE_DELETE_MAX_ROWS, left, st.writeBudget - st.writeUsed - 1);
    if (want < 1) return { done: false, rowsWritten: written };
    const session = await openRead(env, day, PROBE_READ_ROWS + want * PURGE_READ_ROWS_PER_ROW, now);
    if ("refused" in session) return { done: false, rowsWritten: written };
    let finished = false;
    try {
      const [probe] = await session.batch([rdb.prepare(SQL.probe).bind(runId)]);
      const has = probe?.results?.[0] as { p: number; c: number } | undefined;
      if (!has?.p && !has?.c) {
        finished = true;
      } else {
        const lease = await budget.lease(day, want, now);
        if (!lease.ok) return { done: false, rowsWritten: written };
        let grant = Math.min(lease.rows, want);
        if (has.p && grant > 0) {
          const [r] = await session.batch([rdb.prepare(SQL.participants).bind(runId, grant)]);
          const w = writtenBy(r!);
          written += w;
          grant -= w;
        }
        if (has.c && grant > 0) {
          const [r] = await session.batch([rdb.prepare(SQL.conversions).bind(runId, grant)]);
          written += writtenBy(r!);
        }
      }
    } finally {
      await session.close();
    }
    if (finished) break;
  }
  // 消し終えた: queue の行を消し、エクスペリエンスが残っていれば(期限の削除)個票を消した時刻を入れる。1 つの batch = 1 回の書き込み
  await guard();
  await env.DB.batch([
    toStatement(env, db.deleteFrom("results_purge_queue").where("site_id", "=", siteId).where("run_id", "=", runId)),
    toStatement(
      env,
      db.updateTable("experiments").set({ results_purged_at: now }).where("site_id", "=", siteId).where("run_id", "=", runId).where("results_purged_at", "is", null),
    ),
  ]);
  return { done: true, rowsWritten: written };
}

/** 削除の範囲(K6)。条件は削除の DELETE と同じにする(削除が 0 行なら queue にも何も入らない) */
export type PurgeScope =
  | { kind: "experiment"; siteId: string; experimentId: string }
  | { kind: "site"; siteId: string; token: string }
  | { kind: "workspace"; workspaceId: string; token: string };

const REASON: Record<PurgeScope["kind"], PurgeReason> = { experiment: "experiment_deleted", site: "site_deleted", workspace: "workspace_deleted" };

/**
 * K6 (1): 削除の batch の DELETE の前に置く `INSERT INTO results_purge_queue … SELECT … FROM experiments WHERE <削除と同じ条件> AND run_id IS NOT NULL
 * ON CONFLICT DO NOTHING`。読んだ行ではなく D1 の中の行から積む(読んだ後に開始されたテストも、削除されなければ積まない)。
 * 戻り値は toStatement に渡す(`toStatement(env, enqueuePurgeQuery(db, scope, now))`)
 */
export function enqueuePurgeQuery(db: Db, scope: PurgeScope, now: number) {
  const reason = REASON[scope.kind];
  return db
    .insertInto("results_purge_queue")
    .columns(["site_id", "run_id", "reason", "enqueued_at"])
    .expression((eb) => {
      const base = eb
        .selectFrom("experiments")
        .select((s) => ["experiments.site_id", "experiments.run_id", s.val(reason).as("reason"), s.val(now).as("enqueued_at")])
        .where("experiments.run_id", "is not", null);
      switch (scope.kind) {
        case "experiment":
          // エクスペリエンスの削除の DELETE と同じ: その ID で、下書きか終了で、配信中の状態の写しが running / paused でないときだけ(7n。NULL = 未公開も含む)
          return base
            .where("experiments.site_id", "=", scope.siteId)
            .where("experiments.id", "=", scope.experimentId)
            .where("experiments.status", "in", ["draft", "archived"])
            .where((w) => w.or([w("experiments.published_status", "is", null), w("experiments.published_status", "not in", ["running", "paused"])]));
        case "site":
          // Site の削除の DELETE と同じ: Site の削除の印(static_removing)がまだ自分の token のときだけ
          return base
            .where("experiments.site_id", "=", scope.siteId)
            .where((w) => w.exists(w.selectFrom("sites").select("sites.id").where("sites.id", "=", scope.siteId).where("sites.static_removing", "=", scope.token)));
        case "workspace":
          // Workspace の削除の DELETE と同じ: ワークスペースがあり、最後の 1 つでなく、配下の全 Site の印が自分の token のとき
          return base
            .innerJoin("sites", "sites.id", "experiments.site_id")
            .where("sites.workspace_id", "=", scope.workspaceId)
            .where((w) => w.exists(w.selectFrom("organization").select("organization.id").where("organization.id", "=", scope.workspaceId)))
            .where(sql<boolean>`(select count(*) from organization) > 1`)
            .where((w) =>
              w.not(
                w.exists(
                  w
                    .selectFrom("sites as other")
                    .select("other.id")
                    .where("other.workspace_id", "=", scope.workspaceId)
                    .where((o) => o.or([o("other.static_removing", "is", null), o("other.static_removing", "<>", scope.token)])),
                ),
              ),
            );
      }
    })
    .onConflict((oc) => oc.doNothing());
}

/**
 * K6: 削除の応答の後に 1 回だけ消し始める(ctx.waitUntil に渡す)。消す量は 1 回の DELETE の分(2,000 行)まで、run は 1 つだけ。
 * 残り(大きい run・Site の削除のほかの run・枠の無い日・停止中)は UTC 23 時台の Cron が queue から消す。
 * 計測用 D1 か予算の DO が無ければ何もしない(null)。例外は投げない(削除の成功を覆さない)
 */
export function kickOffPurge(env: Env, siteId: string, runId: string, now: number): Promise<void> | null {
  if (!env.RESULTS_DB || !env.RESULTS_BUDGET) return null;
  return purgeRun(env, siteId, runId, PURGE_DELETE_MAX_ROWS, now, apiGuard(env)).then(
    () => undefined,
    (e) => console.error("results purge after delete failed (the cron retries)", e),
  );
}

/** Site・Workspace の削除の後、消した Site の queue の最初の run(積んだ順)を 1 つ消し始める */
export async function kickOffPurgeForSites(env: Env, db: Db, siteIds: readonly string[], now: number): Promise<void> {
  if (!env.RESULTS_DB || !env.RESULTS_BUDGET || siteIds.length === 0) return;
  try {
    const first = await db
      .selectFrom("results_purge_queue")
      .select(["site_id", "run_id"])
      .where("site_id", "in", [...siteIds])
      .orderBy("enqueued_at")
      .orderBy("run_id")
      .limit(1)
      .executeTakeFirst();
    if (first) await kickOffPurge(env, first.site_id, first.run_id, now);
  } catch (e) {
    console.error("results purge after delete failed (the cron retries)", e);
  }
}
