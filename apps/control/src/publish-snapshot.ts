import { sql, type RawBuilder, type SqlBool } from "kysely";
import { sqlStatement, type ExperimentRow } from "./db";
import type { Env } from "./env";
import type { CompileRows } from "./publish";

/** 同じ人が同じミリ秒に保存しても区別できるよう、対象の更新時刻にある配信内容の編集の記録を引く。
 *  親の更新と記録は同じ batch。メモ・遷移の記録は含めない。世代と時刻まで audit_events_exp_at で絞れる。 */
export function experimentEditId(): RawBuilder<number | null> {
  return sql<number | null>`(select max(a.id) from audit_events a
    where a.site_id = experiments.site_id and a.experiment_id = experiments.id
      and a.experiment_generation = experiments.generation and a.at = experiments.updated_at
      and a.action in ('experiment.update', 'experiment.variants', 'experiment.changes'))`;
}

export type CompileExperimentRow = ExperimentRow & { last_edit_id?: number | null };

/** compile 後に保存された内容があれば、activation の時刻より後に未公開の印を残す。 */
export function transitionUpdatedAt(compiled: CompileExperimentRow, at: number): RawBuilder<number> {
  return sql<number>`case when updated_at <> ${compiled.updated_at} or ${experimentEditId()} is not ${compiled.last_edit_id ?? null}
    then max(updated_at, ${at + 1}) else ${at} end`;
}

export type StatusSnapshot = Array<Pick<ExperimentRow, "id" | "status"> & { lastStartedAt: number | null }>;

export function snapshotOf(rows: CompileRows): StatusSnapshot {
  return rows.experiments.map(({ id, status, last_started_at }) => ({ id, status, lastStartedAt: last_started_at }));
}

export function snapshotMatches(siteId: string, snap: StatusSnapshot): RawBuilder<SqlBool> {
  // JSON を一度だけ渡し、読んだ行の変更と、後で加わった配信対象の行を調べる。
  return sql<SqlBool>`(with snapshot as materialized (
    select json_extract(value, '$.id') as id, json_extract(value, '$.status') as status,
      json_extract(value, '$.lastStartedAt') as last_started_at from json_each(${JSON.stringify(snap)})
  )
  select not exists (
    select 1 from snapshot s
    left join experiments e on e.site_id = ${siteId} and e.id = s.id
    where case when e.id is null then s.status not in ('draft', 'archived')
      else not (e.status is s.status and e.last_started_at is s.last_started_at) end
  ) and not exists (
    select 1 from experiments e where e.site_id = ${siteId} and e.status <> 'draft'
      and e.id not in (select id from snapshot)
  ))`;
}

export type StatusAfter = Array<Pick<ExperimentRow, "id" | "status">>;
type Guard = RawBuilder<SqlBool>;

// CAS の後続文は自分の予約が生きている間だけ書く。履歴を active にする文は batch の最後に置く。
export function activeGuard(siteId: string, version: number, rowId: string): Guard {
  return sql<SqlBool>`((select active_version from sites where id = ${siteId}) = ${version}
    and exists (select 1 from publishes where id = ${rowId} and status = 'reserved'))`;
}

export function publishedStatusStatement(env: Env, siteId: string, after: StatusAfter, guard: Guard): D1PreparedStatement {
  // JSON の写しを一度展開し、各要素から (site_id, id) の主キーで更新する行を引く。
  // MATERIALIZED を外すと SQLite が結合順を逆にして各行で json_each を再走査しうる。
  return sqlStatement(env.DB, sql`
    with snapshot as materialized (
      select json_extract(value, '$.id') as id, json_extract(value, '$.status') as status
      from json_each(${JSON.stringify(after)})
    )
    update experiments
    set published_status = snapshot.status
    from snapshot
    where experiments.site_id = ${siteId} and experiments.id = snapshot.id and ${guard}`);
}

export function collectionLogStatement(env: Env, siteId: string, version: number, collecting: 0 | 1, at: number, guard: Guard): D1PreparedStatement {
  return sqlStatement(env.DB, sql`
    insert into results_collection_log (site_id, at, enabled, publish_version)
    select ${siteId}, ${at}, ${collecting}, ${version}
    where ${guard}
      and coalesce((select enabled from results_collection_log where site_id = ${siteId} order by id desc limit 1), 0) <> ${collecting}`);
}

export function interimCacheDeleteStatement(env: Env, siteId: string, guard: Guard): D1PreparedStatement {
  return sqlStatement(env.DB, sql`delete from results_interim_cache where site_id = ${siteId} and ${guard}`);
}

export function publishActiveStatement(env: Env, rowId: string, activatedAt: number, guard: Guard): D1PreparedStatement {
  return sqlStatement(env.DB, sql`update publishes set status = 'active', activated_at = ${activatedAt} where id = ${rowId} and ${guard}`);
}
