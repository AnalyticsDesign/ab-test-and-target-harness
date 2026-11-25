import type { ReconcileRow } from "../publish";
import { NOT_FROZEN_SQL } from "../write-freeze";
import { CronFrozen } from "./runner";

export function activeNeedsMark(kv: string | null, activeVersion: number): boolean {
  // edge の loadActiveVersion が配信できるのは先頭ゼロのない正の十進整数だけ。
  if (kv === null || !/^[1-9][0-9]*$/.test(kv)) return true;
  const version = Number(kv);
  return !Number.isInteger(version) || version < activeVersion;
}

/** 凍結の確認後に呼ぶ。版が動いた行は更新せず、確認後に始まった凍結も同じ往復で検出する。 */
export async function markActiveMismatches(
  db: D1Database,
  mismatches: ReadonlyMap<string, { version: number; kv: string | null }>,
  job: "publish-repair" | "config-cleanup",
) {
  const versions = Array.from(mismatches, ([id, { version }]) => [id, version]);
  // 取得後の公開・削除と競合した行は触らない。確かめた直後に凍結された回も同じ batch で区別する。
  const [updated, frozen] = await db.batch<ReconcileRow & { id: string }>([
    db.prepare(`update sites set active_kv_stale = 1
      where (id, active_version) in (select value ->> 0, value ->> 1 from json_each(?))
      and static_removing is null and ${NOT_FROZEN_SQL} returning id, active_kv_stale, active_version, last_activated_at`).bind(JSON.stringify(versions)),
    db.prepare(`select 1 where not (${NOT_FROZEN_SQL})`),
  ]);
  if (frozen!.results.length) throw new CronFrozen();
  for (const row of updated!.results) {
    console.log(`cron ${job}: marked site=${row.id} version=${row.active_version} kv=${mismatches.get(row.id)!.kv}`);
  }
  return updated!.results;
}
