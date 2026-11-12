import { utcDay } from "@wtt/core";
import { sql, type RawBuilder } from "kysely";
import { toStatement, type Db } from "./db";
import type { Env } from "./env";
import { CronFrozen } from "./cron/runner";
import { needsDeliveryConfirmation } from "./results/delivered";
import { NOT_FROZEN_SQL } from "./write-freeze";

/** 公開の本体を残す版数。runtime の bundle に含めないため control で読む。 */
export const PUBLISH_BODY_KEEP_DEFAULT = 100;
export const PUBLISH_BODY_KEEP_MIN = 20;
export const PUBLISH_BODY_KEEP_MAX = 10_000;

export function publishBodyKeep(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return PUBLISH_BODY_KEEP_DEFAULT;
  const n = Number(value);
  return n >= PUBLISH_BODY_KEEP_MIN && n <= PUBLISH_BODY_KEEP_MAX ? n : PUBLISH_BODY_KEEP_DEFAULT;
}

export const PUBLISH_BODY_SITE_CAP = 500;
export const PUBLISH_BODY_DAILY_CAP = 5000;
export const PUBLISH_BODY_COUNTER_JOB = "config-cleanup:body-prune";
export type PruneArgs = { siteId: string; keep: readonly number[]; keepCount: number; siteCap: number; dailyCap: number; runId: string; now: number };
export type PruneResult = { pruned: number; prunedToday: number; rowsWritten: number; rowsRead: number; stmtMs: [number | null, number | null]; sizeAfter: number | null };

export function readPrunedToday(row: { day: string; cursor: string | null } | undefined, now: number): number {
  if (!row || row.day !== utcDay(now) || row.cursor === null) return 0;
  try {
    const n: unknown = JSON.parse(row.cursor).pruned;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** ① と ② が同じ候補を数え、消す。守りの一覧はサイトにつき各文で 1 回作り、部分索引に載る行だけ読む。 */
function pruneCandidates(db: Db, a: PruneArgs, limit: RawBuilder<number>) {
  return db.selectFrom("publishes as p").select("p.id")
    .where("p.site_id", "=", a.siteId)
    .where("p.kv_deleted", "=", 1)
    .where("p.config_json", "is not", null)
    .where("p.version", "<", db.selectFrom("publishes as x").select("x.version").where("x.site_id", "=", a.siteId).where("x.config_json", "is not", null).orderBy("x.version", "desc").limit(1).offset(a.keepCount - 1))
    .where("p.version", "<", db.selectFrom("sites").select("static_served_version").where("id", "=", a.siteId))
    .where("p.version", "<>", db.selectFrom("sites").select("active_version").where("id", "=", a.siteId))
    .where("p.version", "not in", sql<number>`(select value from json_each(${JSON.stringify(a.keep)}))`)
    .where("p.version", "not in", db.selectFrom("experiment_delivered_definitions as u").select("u.publish_version").where("u.site_id", "=", a.siteId).where(needsDeliveryConfirmation("u")))
    .where("p.version", "not in", db.selectFrom("static_deploy_requests as r").select("r.version").where("r.site_id", "=", a.siteId).where("r.input_digest", "is", null))
    .where(sql<boolean>`${sql.raw(NOT_FROZEN_SQL)}`)
    .orderBy("p.version")
    .limit(limit);
}

/**
 * 1 回の batch(2 文)で日次の数と本体を同時に確定する。呼ぶ側の数が古くても SQL の数で上限を守る。
 * runId は同じ batch の ① が書いた枠だけを ② が使うための印。公開の経路からは呼ばない。
 */
export async function prunePublishBodies(env: Env, db: Db, a: PruneArgs): Promise<PruneResult> {
  const day = utcDay(a.now);
  const job = PUBLISH_BODY_COUNTER_JOB;
  const p = sql<number>`coalesce((select case when day = ${day} then json_extract(cursor, '$.pruned') else 0 end from cron_cursors where job = ${job}), 0)`;
  const l = sql<number>`max(0, min(${a.siteCap}, ${a.dailyCap} - ${p}))`;
  const n = sql<number>`(select count(*) from (${pruneCandidates(db, a, l)}))`;
  const consume = sql`insert into cron_cursors (job, day, cursor)
    select ${job}, ${day}, json_object('pruned', ${p} + ${n}, 'limit', ${l}, 'run', ${a.runId})
    where ${sql.raw(NOT_FROZEN_SQL)}
    on conflict (job) do update set day = excluded.day, cursor = excluded.cursor
    returning json_extract(cursor, '$.pruned') as pruned_today`;
  const limit = sql<number>`coalesce((select json_extract(cursor, '$.limit') from cron_cursors where job = ${job} and json_extract(cursor, '$.run') = ${a.runId}), 0)`;
  const remove = db.updateTable("publishes").set({ config_json: null, body_pruned_at: a.now })
    .where("id", "in", pruneCandidates(db, a, limit))
    .where(sql<boolean>`exists (select 1 from cron_cursors where job = ${job} and json_extract(cursor, '$.run') = ${a.runId})`)
    .where(sql<boolean>`${sql.raw(NOT_FROZEN_SQL)}`);
  const [consumed, removed] = await env.DB.batch<{ pruned_today: number }>([toStatement(env, { compile: () => consume.compile(db) }), toStatement(env, remove)]);
  const today = consumed?.results[0];
  if (!today) throw new CronFrozen();
  return {
    pruned: removed?.meta.changes ?? 0,
    prunedToday: today.pruned_today,
    rowsWritten: (consumed?.meta.rows_written ?? 0) + (removed?.meta.rows_written ?? 0),
    rowsRead: (consumed?.meta.rows_read ?? 0) + (removed?.meta.rows_read ?? 0),
    stmtMs: [consumed?.meta.duration ?? null, removed?.meta.duration ?? null],
    sizeAfter: removed?.meta.size_after ?? null,
  };
}
