// apps/control/src/cron/account-guard.ts
import { nextUtcMidnight } from "@wtt/core";
import { ApiError } from "../errors";
import { readInstanceSettings, usageSettingsOf } from "../instance-settings";
import { getUsage, type UsageReport } from "../usage";
import type { CronJob } from "./runner";

/**
 * D9 ②(plan ② の K12、設計書 §6.9 の補助): アカウント全体の使用量で結果の収集を止める。
 * 結果の予算(edge の ResultsBudget)は結果の書き込みしか見ないので、アカウント全体の Workers のリクエストか D1 の書き込み行数が
 * Free の日次上限の 8 割に届いたら、同じ停止の印を次の UTC 0 時まで立てる(残りは配信と管理操作に残す)。
 * Paid は日次の上限が無いので判定しない。使用量が取れない(未設定・GraphQL の失敗)ときはログだけで何もしない。
 * 予算の DO にだけ書き、wtt-control には書かないので凍結中も動かす(K6。メンテナンス中も訪問者の書き込みは続く)
 */
export const ACCOUNT_USAGE_STOP_RATIO = 0.8;
const WATCHED = ["workers_requests", "d1_rows_written"] as const;

const NAME = "results-account-guard";

/** 止める理由になった資源(無ければ null)。Free の日次の ratio だけを見る(Paid の ratio は null) */
export function accountUsageOverLimit(report: UsageReport): { id: string; ratio: number } | null {
  if (report.plan !== "free") return null;
  for (const id of WATCHED) {
    const r = report.resources.find((x) => x.id === id);
    if (r?.ratio != null && r.ratio >= ACCOUNT_USAGE_STOP_RATIO) return { id, ratio: r.ratio };
  }
  return null;
}

export const resultsAccountGuard: CronJob = {
  name: NAME,
  cadence: { every: "tick" },
  writesControl: false,
  async run({ env, db, now }) {
    const ns = env.RESULTS_BUDGET;
    if (!ns) {
      console.log(`${NAME}: no RESULTS_BUDGET binding; nothing to do`);
      return;
    }
    let report: UsageReport;
    try {
      report = await getUsage(env, usageSettingsOf(await readInstanceSettings(db)), now);
    } catch (e) {
      if (e instanceof ApiError && e.code === "usage_not_configured") {
        console.log(`${NAME}: usage is not configured; nothing to do`);
      } else {
        console.warn(`${NAME}: usage query failed; nothing to do`, e);
      }
      return;
    }
    const over = accountUsageOverLimit(report);
    if (!over) {
      console.log(`${NAME}: below the limit (plan ${report.plan}); nothing to do`);
      return;
    }
    const until = nextUtcMidnight(now);
    // DO に届かない・拒まれたときは例外のまま返す(runCron が failed として残し、次の回で取り直す)
    await ns.get(ns.idFromName("global")).stop("account_usage", until, now);
    console.log(`${NAME}: stopped results collection until ${new Date(until).toISOString()} (${over.id} at ${Math.round(over.ratio * 1000) / 10}%)`);
  },
};
