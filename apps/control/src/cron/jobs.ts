// apps/control/src/cron/jobs.ts
import { resultsAccountGuard } from "./account-guard";
import type { CronJob } from "./runner";

/**
 * D9 ②(plan ② の K5): Cron のジョブの登録表。1 回の実行でこの順に 1 本ずつ走る。
 * ジョブを足すときは Cron Trigger を増やさずここに足す(Trigger はアカウント単位の数の上限がある)。
 * wtt-control に書くジョブは writesControl: true にし、書く区切りの直前に ctx.assertNotFrozen() を呼ぶ(K6)
 */
export const CRON_JOBS: readonly CronJob[] = [resultsAccountGuard];
