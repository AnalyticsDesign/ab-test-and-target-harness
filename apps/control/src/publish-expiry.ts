import { utcDay } from "@wtt/core";
import { CURSOR_END } from "./cron/cursor";
import type { Env } from "./env";
import { NOT_FROZEN_SQL } from "./write-freeze";

export const RESERVED_TTL_MS = 10 * 60_000;
export const HEAD_EXPIRY_VERSIONS = 20;
export const DAILY_EXPIRY_ROWS = 100;
export const EXPIRY_CURSOR_JOB = "config-cleanup:reserved-expiry";

// 旧版の activation と履歴の書き込みは別々だった。対象を先に限定し、公開の記録は予約時刻、
// 戻した記録はその後の 10 分だけを audit_events_at から引く。配信中の版は記録の保持期間を過ぎても active。
function expirySql(candidates: string): string {
  const audit = `from audit_events a where a.site_id = p.site_id and a.action = 'publish.publish'
    and json_extract(a.detail_json, '$.version') = p.version`;
  return `with evidence as materialized (
    select p.id, p.site_id, p.version, p.created_at, p.version is (select active_version from sites where id = p.site_id) as current_version,
      (select at ${audit} and a.at = p.created_at and json_extract(a.detail_json, '$.superseded') is not 1
        and json_extract(a.detail_json, '$.reason') is not 'reverted' limit 1) as published_at
    from publishes p where ${candidates} and p.status = 'reserved' and p.created_at < ?2 and ${NOT_FROZEN_SQL}
  ), outcome as materialized (
    select p.id, p.published_at, case
      when p.current_version then 1
      when p.published_at is null then 0
      else not exists (select 1 ${audit} and a.at between p.created_at and p.created_at + ${RESERVED_TTL_MS}
        and json_extract(a.detail_json, '$.reason') = 'reverted')
    end as active from evidence p
  )
  update publishes set status = case when o.active then 'active' else 'failed' end,
    activated_at = case when o.active then o.published_at end,
    error = case when o.active then null else 'interrupted: reserved row expired' end
  from outcome o where publishes.id = o.id`;
}

export function headExpiryStatement(env: Env, siteId: string, nowMs: number): D1PreparedStatement {
  return env.DB.prepare(expirySql(`p.site_id = ?1
    and p.version > (select max(version) from publishes where site_id = ?1) - ${HEAD_EXPIRY_VERSIONS}`))
    .bind(siteId, nowMs - RESERVED_TTL_MS);
}

export function dailyExpiryBatch(env: Env, ids: string[], nowMs: number): D1PreparedStatement[] {
  const page = ids.slice(0, DAILY_EXPIRY_ROWS);
  const cursor = page.length === DAILY_EXPIRY_ROWS ? page[page.length - 1]! : CURSOR_END;
  // この batch が日付を取れた場合だけ行と位置を更新する。並行する Cron が同じ日の別の候補を
  // 読み終えていても、その batch の印は一致しない。印は確定前に実際の位置に置き換わる。
  const claim = `#claim:${crypto.randomUUID()}`;
  return [
    env.DB.prepare(`insert into cron_cursors (job,day,cursor) select ?1,?2,?3 where ${NOT_FROZEN_SQL}
      on conflict(job) do update set day=excluded.day, cursor=excluded.cursor where cron_cursors.day < excluded.day`)
      .bind(EXPIRY_CURSOR_JOB, utcDay(nowMs), claim),
    env.DB.prepare(expirySql(`p.id in (select value from json_each(?1))
      and exists (select 1 from cron_cursors where job=?3 and cursor=?4)`))
      .bind(JSON.stringify(page), nowMs - RESERVED_TTL_MS, EXPIRY_CURSOR_JOB, claim),
    env.DB.prepare(`update cron_cursors set cursor=?1 where job=?2 and cursor=?3 and ${NOT_FROZEN_SQL}`)
      .bind(cursor, EXPIRY_CURSOR_JOB, claim),
    env.DB.prepare(`select 1 where not (${NOT_FROZEN_SQL})`),
  ];
}
