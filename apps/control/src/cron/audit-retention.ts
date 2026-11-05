// apps/control/src/cron/audit-retention.ts
import { CONTROL_DB_SIZE_KEY } from "../instance-settings";
import { NOT_FROZEN_SQL } from "../write-freeze";
import { CronFrozen, type CronContext, type CronJob } from "./runner";

/**
 * B129(spec §8・§10.3、plan Task 9): 操作の記録(audit_events)の保持。日次で 366 日より前の行を消す
 * (トリガー audit_events_keep_365d は D1 の時計で 365 日以内の削除を断る。Worker と D1 の時計のずれで断られないよう 1 日の余裕を取る)。
 *
 * - 1 日に消すのは最大 5,000 行(DAILY_CAP)。1 行の削除は主キーと索引の項目を書くので、ジョブ全体の rows_written は
 *   最悪(消す行がすべて access × password = 1 行 7 項目)で 5,000 × 7 + 固定の数行(Q28)
 * - 1 日の枠は runner(cron_job_runs)ではなく、このジョブの中で audit_retention_state(1 行だけ。マイグレーションが初めの行を入れる)で守る
 *   (Q15。runner は本番で動いている B93・B94・B110 の Cron に及ぶので触らない)。1 回の実行は batch 1 つ(2 文。Q26):
 *   ① 状態の行を書く: day = T(D1 の時計の UTC 日。① の 1 文の中だけで評価する)、deleted = P + n、run_id = この実行の乱数、
 *      last_limit = L。P = 同じ日ならその日に消した数・日が進んでいれば 0、L = 5,000 − P、n = 消す候補の数(LIMIT L)。
 *      `day <= T` で状態の日付を前に戻す更新を通さない(古い日付で枠を開け直せない)
 *   ② 消す: ① が書いた last_limit で選ぶ(run_id がこの実行のものでなければ 0 行)。② は日付を評価しないので、① と ② の間で
 *      日付が変わっても選ぶ行は ① の n と同じ
 *   削除と枠の消費が同じ batch で確定するので、後の段(件数・大きさの保存・成功の記録)が失敗しても、同じ日の次の実行は残りの枠までしか消さない。
 *   D1 は batch を順に実行するので、2 つの実行が重なっても後の batch の ① は前の batch が書いた状態から P を計算する(先に読む往復・CAS は無い)
 * - 消し残しがあっても `{ more: true }` を返さない(その日の枠を使い切ったら翌日。daily のジョブは成功を記録した日の残りの実行では動かない)。
 *   前提は 1 日に増える量 ≤ 1 日に消せる量(大きな導入で 800 行 / 日)
 * - 終わりに件数の目安(max(rowid) − min(rowid)。欠番があるので目安)をログに出し、制御用の D1 の大きさ(削除の batch の meta.size_after)を
 *   instance_settings の control_db_size に書く(Q10・Q24。GET /usage の controlCapacity が読む)
 * - wtt-control に書くので writesControl: true。書く直前に assertNotFrozen を呼び、batch の 2 文と大きさの保存にも凍結の印が無いことを条件に入れる
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(登録は最後。前のジョブが使った残りの中で動く)。
 * 使う D1 のクエリは凍結の確かめ 1 + batch 1 + 件数 1 + 大きさの保存 1 = 4(① が 0 行のときだけ凍結の確かめ +1)で、
 * 全体の残りに収まるかを ctx.queries.use で確かめ、足りなければ何もせず `{ more: true }`(同じ日の次の実行で取り直す)
 */
const NAME = "audit-retention";
export const AUDIT_RETENTION_DAILY_CAP = 5000;
/** cutoff = Worker の今 − 366 日(トリガーの 365 日との 1 日の余裕) */
export const AUDIT_RETENTION_CUTOFF_DAYS = 366;
const DAY_MS = 86_400_000;
/** 凍結の確かめ 1 + batch 1 + 件数 1 + 大きさの保存 1 + ① が 0 行のときの凍結の確かめ 1 */
const QUERIES = 5;

/** 本番の T(D1 の時計の UTC 日)。1 文の中の 'now' は同じ値(SQLite は 1 回の sqlite3_step の中で 'now' を固定する) */
const D1_TODAY = "strftime('%Y-%m-%d','now')";

/**
 * 件数の目安(別の副問い合わせにして、それぞれ表の両端だけを読む)。空の表は NULL、1 行は 0。欠番があるので大きさの判断には使わない
 */
export const APPROX_COUNT_SQL = "SELECT (SELECT max(rowid) FROM audit_events) - (SELECT min(rowid) FROM audit_events) AS approx";

/**
 * 1 回の実行の batch(① 状態の行の更新 ② 削除)。`day` を渡すとそれを T として bind する(テストの口。D1 の now は差し替えられない)。
 * 本番は渡さない(T = D1 の時計)。P・L は UPDATE の行を相関させずに副問い合わせで書く(LIMIT の中は相関できない)。
 * L は max(0, …) にする(P が上限を超えた行があっても、負の LIMIT = 無制限にしない)
 */
export function retentionStatements(DB: D1Database, o: { runId: string; cutoff: number; day?: string }): [D1PreparedStatement, D1PreparedStatement] {
  const { consume, remove } = retentionSql(o.day !== undefined);
  const binds = o.day === undefined ? [o.runId, o.cutoff] : [o.runId, o.cutoff, o.day];
  return [DB.prepare(consume).bind(...binds), DB.prepare(remove).bind(o.runId, o.cutoff)];
}

/** retentionStatements の 2 文の SQL(?1 = run_id、?2 = cutoff、bindDay なら ?3 = T)。テストが ② に日付の評価が無いことを見るために export する */
export function retentionSql(bindDay: boolean): { consume: string; remove: string } {
  const T = bindDay ? "?3" : D1_TODAY;
  const P = `(SELECT CASE WHEN s.day = ${T} THEN s.deleted ELSE 0 END FROM audit_retention_state AS s WHERE s.id = 1)`;
  const L = `max(0, ${AUDIT_RETENTION_DAILY_CAP} - ${P})`;
  const n = `(SELECT count(*) FROM (SELECT id FROM audit_events WHERE at < ?2 ORDER BY at, id LIMIT ${L}))`;
  const consume = `UPDATE audit_retention_state
    SET day = ${T}, deleted = ${P} + ${n}, run_id = ?1, last_limit = ${L}
    WHERE id = 1 AND day <= ${T} AND ${NOT_FROZEN_SQL}
    RETURNING deleted, last_limit`;
  const remove = `DELETE FROM audit_events WHERE id IN (
      SELECT id FROM audit_events WHERE at < ?2 ORDER BY at, id
      LIMIT COALESCE((SELECT last_limit FROM audit_retention_state WHERE id = 1 AND run_id = ?1), 0)
    ) AND EXISTS (SELECT 1 FROM audit_retention_state WHERE id = 1 AND run_id = ?1) AND ${NOT_FROZEN_SQL}`;
  return { consume, remove };
}

/** 制御用の D1 の大きさの保存(凍結中は書かない。鍵は文の中の literal) */
const SIZE_UPSERT = `INSERT INTO instance_settings (key, value, updated_at, updated_by) SELECT '${CONTROL_DB_SIZE_KEY}', ?1, ?2, NULL WHERE ${NOT_FROZEN_SQL}
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = NULL`;

/**
 * ジョブを作る。`day` はテストの口(T を bind する)。本番の登録(auditRetentionJob)は渡さない
 */
export function auditRetentionJobWith(o: { day?: (ctx: CronContext) => string } = {}): CronJob {
  return {
    name: NAME,
    cadence: { daily: { afterUtcHour: 19 } },
    writesControl: true,
    async run(ctx) {
      if (!ctx.queries.use(QUERIES)) {
        console.log(`cron ${NAME}: no query budget left in this run; retrying on the next run`);
        return { more: true };
      }
      await ctx.assertNotFrozen();
      const runId = crypto.randomUUID();
      const cutoff = ctx.now - AUDIT_RETENTION_CUTOFF_DAYS * DAY_MS;
      const [consumed, removed] = await ctx.env.DB.batch(retentionStatements(ctx.env.DB, { runId, cutoff, day: o.day?.(ctx) }));
      const today = consumed?.results?.[0] as { deleted: number; last_limit: number } | undefined;
      // ① が 0 行 = 確かめと batch の間に凍結が入った(ここで止める)か、状態の日が D1 の今日より先(時計が戻った。何も消さずに進める)
      if (!today) await ctx.assertNotFrozen();
      const deleted = removed?.meta.changes ?? 0;
      const size = Number(removed?.meta.size_after ?? NaN);
      // 件数の目安はログだけ。読めなくても止めない
      let approx: number | null = null;
      try {
        approx = (await ctx.env.DB.prepare(APPROX_COUNT_SQL).first<{ approx: number | null }>())?.approx ?? null;
      } catch (e) {
        console.error(`cron ${NAME}: reading the approximate count failed`, e);
      }
      // 件数だけを出す(メールアドレス・利用者の ID は出さない)
      console.log(
        `cron ${NAME}: deleted ${deleted} row(s) older than ${AUDIT_RETENTION_CUTOFF_DAYS} days` +
          (today ? ` (today ${today.deleted} of ${AUDIT_RETENTION_DAILY_CAP})` : " (the stored day is ahead of the database clock; deleted nothing)") +
          `; approximately ${approx ?? 0} row(s) remain (max(rowid) - min(rowid); ids have gaps)` +
          // 削除の rows_written(索引の項目を含むかは D1 の数え方による。手元の D1 は削除 1 行 = 1。本番の値を deploy の後にこのログで見る)
          `; rows_written ${(consumed?.meta.rows_written ?? 0) + (removed?.meta.rows_written ?? 0)}`,
      );
      if (!Number.isFinite(size)) throw new Error(`cron ${NAME}: size_after is missing`);
      const w = await ctx.env.DB.prepare(SIZE_UPSERT).bind(JSON.stringify({ sizeBytes: size, measuredAt: ctx.now }), ctx.now).run();
      // 0 行 = 凍結の印がある(ON CONFLICT の更新はいつも 1 行を書く)
      if (!w.meta.changes) throw new CronFrozen();
    },
  };
}

export const auditRetentionJob: CronJob = auditRetentionJobWith();
