// apps/control/src/cron/run-state.ts
import { INSTALL_MARKER_KEY } from "../domain-probe";
import { parseInstanceSetting, type CloudflarePlan } from "../instance-settings";
import { WRITE_FREEZE_KEY } from "../write-freeze";

export const RECONCILE_DEFER_MS = 30_000;
const RECENT_RECONCILE_SITES = 10;
export const repairCandidateWhere = "active_kv_stale = 1 AND active_version IS NOT NULL AND static_removing IS NULL AND coalesce(last_activated_at, 0) < ?";

type RecentActive = { id: string; activeVersion: number };

/**
 * B182(推す 1): Cron の 1 回の実行の最初に読む値。D1 の batch 1 回で読む(前は凍結・日次の記録・プランを 1 つずつ読んでいた)。
 * - frozen: 凍結の印の行があるか(値は解かない。readWriteFreeze の「行があれば凍結中」と同じ)
 * - lastRunDay: 日次のジョブの名前 → 最後に成功した UTC の日(記録の無いジョブは入らない)
 * - plan: インスタンス設定の Cloudflare のプラン(行が無い・読めない値は既定 = readInstanceSettings と同じ規則)
 * - sharingPending: 共有の自動の移行を待つサイトがあるか(Task 2 で移行を動かすかの判定に使う)
 * - installMarkerInD1: 導入の印が D1 にあるか(値が空でない)
 */
export type CronRunState = {
  frozen: boolean;
  lastRunDay: ReadonlyMap<string, string>;
  plan: CloudflarePlan;
  sharingPending: boolean;
  installMarkerInD1: boolean;
  repairCandidate: boolean;
  recentActive: ReadonlyArray<RecentActive>;
};

/**
 * 実行の最初の値を batch 1 回で読む。batch が失敗したら null(runner がその回だけ前と同じ 1 つずつの読み取りに戻り、
 * 読み取りの失敗の扱い(凍結の印が読めなければ凍結中・日次の記録が読めなければそのジョブだけ失敗・プランが読めなければ Free)も前と同じになる)
 */
export async function readCronRunState(db: D1Database, dailyJobNames: readonly string[], now: number): Promise<CronRunState | null> {
  let settings: D1Result<{ key: string; value: string }>;
  let runs: D1Result<{ job: string; last_run_day: string | null }>;
  let pending: D1Result<{ pending: number }>;
  let candidate: D1Result<{ found: number }>;
  let recent: D1Result<RecentActive>;
  try {
    [settings, runs, pending, candidate, recent] = (await db.batch([
      db.prepare("SELECT key, value FROM instance_settings WHERE key IN (?1, ?2, ?3)").bind(WRITE_FREEZE_KEY, "cloudflarePlan", INSTALL_MARKER_KEY),
      db.prepare("SELECT job, last_run_day FROM cron_job_runs WHERE job IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(dailyJobNames)),
      db.prepare("SELECT EXISTS (SELECT 1 FROM sites WHERE share_migration_pending = 1) AS pending"),
      db.prepare(`SELECT EXISTS (SELECT 1 FROM sites WHERE ${repairCandidateWhere}) AS found`).bind(now - RECONCILE_DEFER_MS),
      db.prepare(`SELECT id, active_version AS activeVersion FROM sites
        WHERE active_version IS NOT NULL AND static_removing IS NULL AND last_activated_at > ? AND last_activated_at < ?
        ORDER BY last_activated_at LIMIT ?`).bind(now - 32 * 60_000, now - 2 * 60_000, RECENT_RECONCILE_SITES),
    ])) as [typeof settings, typeof runs, typeof pending, typeof candidate, typeof recent];
  } catch (e) {
    console.error("cron: reading the run state in one batch failed; falling back to separate reads", e);
    return null;
  }
  const value = new Map(settings.results.map((r) => [r.key, r.value]));
  const lastRunDay = new Map<string, string>();
  for (const r of runs.results) if (r.last_run_day !== null) lastRunDay.set(r.job, r.last_run_day);
  return {
    repairCandidate: candidate.results[0]?.found === 1,
    recentActive: recent.results,
    frozen: value.has(WRITE_FREEZE_KEY),
    lastRunDay,
    plan: parseInstanceSetting("cloudflarePlan", value.get("cloudflarePlan")),
    sharingPending: pending.results[0]?.pending === 1,
    installMarkerInD1: (value.get(INSTALL_MARKER_KEY) ?? "") !== "",
  };
}
