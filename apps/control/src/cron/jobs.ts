// apps/control/src/cron/jobs.ts
import { resultsAccountGuard } from "./account-guard";
import { breakGlassSweep } from "./break-glass-sweep";
import { configCleanupJob } from "./config-cleanup";
import { resultsCapacityJob, resultsCollectUntilJob, resultsDailyJob, resultsDeliveryJob, resultsPurgeJob } from "./results-jobs";
import { siteSettingsRefreshJob } from "./site-settings-refresh";
import { staticReconcileJob } from "./static-reconcile";
import type { CronJob } from "./runner";

/**
 * D9 ②(plan ② の K5): Cron のジョブの登録表。1 回の実行でこの順に 1 本ずつ走る。
 * ジョブを足すときは Cron Trigger を増やさずここに足す(Trigger はアカウント単位の数の上限がある)。
 * wtt-control に書くジョブは writesControl: true にし、書く区切りの直前に ctx.assertNotFrozen() を呼ぶ(K6)。
 * D9 ③(plan ③ の K17): 結果のジョブ 5 本を results-account-guard の後に、この順で足す(クエリの配分は各ジョブの queryShare)
 * plan12 K10: site-settings-refresh(日次。KV の Site の設定の記録を D1 と比べて直す)を最後に足す。配分(queryShare)を持たないので
 * 結果のジョブの配分表は変わらない。最後に置くのは、前のジョブが使った残りの中で動くため
 * plan12 K13: break-glass-sweep(15 分ごと。非常口が閉じている間、パスワードの記録とその持ち主のセッションを消す)をさらに後ろに足す。
 * これも配分を持たず(配分表は変わらない)、使う 2 件が全体の残りに収まるかを自分で確かめる
 * plan12 K14: config-cleanup(日次。古い版の config を公開の無い日にも消す)を最後に足す。配分を持たず、使う D1 のクエリを自分で数える
 * 7o K13: static-reconcile(15 分ごと)を最後に足す。配分を持たず、使う D1 のクエリを自分で確かめる
 */
export const CRON_JOBS: readonly CronJob[] = [resultsAccountGuard, resultsDeliveryJob, resultsCollectUntilJob, resultsDailyJob, resultsCapacityJob, resultsPurgeJob, siteSettingsRefreshJob, breakGlassSweep, configCleanupJob, staticReconcileJob];
