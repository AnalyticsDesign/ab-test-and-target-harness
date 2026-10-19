// apps/control/src/cron/jobs.ts
import { resultsAccountGuard } from "./account-guard";
import { resultsCapacityJob, resultsCollectUntilJob, resultsDailyJob, resultsDeliveryJob, resultsPurgeJob } from "./results-jobs";
import type { CronJob } from "./runner";

/**
 * D9 ②(plan ② の K5): Cron のジョブの登録表。1 回の実行でこの順に 1 本ずつ走る。
 * ジョブを足すときは Cron Trigger を増やさずここに足す(Trigger はアカウント単位の数の上限がある)。
 * wtt-control に書くジョブは writesControl: true にし、書く区切りの直前に ctx.assertNotFrozen() を呼ぶ(K6)。
 * D9 ③(plan ③ の K17): 結果のジョブ 5 本を results-account-guard の後に、この順で足す(クエリの配分は各ジョブの queryShare)
 */
export const CRON_JOBS: readonly CronJob[] = [resultsAccountGuard, resultsDeliveryJob, resultsCollectUntilJob, resultsDailyJob, resultsCapacityJob, resultsPurgeJob];
