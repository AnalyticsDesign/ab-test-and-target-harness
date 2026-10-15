// apps/control/src/usage/index.ts
import type { Env } from "../env";
import { ApiError } from "../errors";
import type { UsageSettings } from "../instance-settings";
import { fetchRawUsage, usageConfig } from "./fetch";
import { judge, startOfUtcDay, type RawUsage, type UsageReport } from "./judge";

export type { ResourceReport, UsageReport, UsageStatus } from "./judge";

/**
 * backlog D10(brief K8・plan K24): 使用量の取得と判定。HTTP のルート(GET /usage)と、D9 の Cron(結果の収集を止める判定)が呼ぶ。
 * GraphQL の結果(判定の前)をアカウントごとに 60 秒、同じ UTC の日の間だけ isolate のメモリに持つ。失敗は持たない
 */
export const USAGE_CACHE_MS = 60_000;
const cache = new Map<string, { at: number; raw: RawUsage }>();

export function resetUsageCache(): void {
  cache.clear();
}

export async function getUsage(env: Env, settings: UsageSettings, now = Date.now(), fetchFn?: typeof fetch): Promise<UsageReport> {
  const cfg = usageConfig(env);
  if (!cfg) {
    throw new ApiError(503, "usage_not_configured", {
      hint: "導入ガイドの手順で、Account Analytics: Read だけの API トークン(secret の CF_USAGE_TOKEN)と、Cloudflare のアカウント ID(var の CF_ACCOUNT_ID)を設定してください",
    });
  }
  const hit = cache.get(cfg.accountId);
  let raw: RawUsage;
  let at: number;
  if (hit && now - hit.at < USAGE_CACHE_MS && startOfUtcDay(hit.at) === startOfUtcDay(now)) {
    raw = hit.raw;
    at = hit.at;
  } else {
    raw = await fetchRawUsage(cfg, now, fetchFn);
    at = now;
    cache.set(cfg.accountId, { at, raw });
  }
  // asOf は実際に取得した時刻。予測と resetAt もその時刻を基準にする(キャッシュは同じ UTC の日の間だけなので resetAt はずれない)
  return judge(raw, settings, at);
}
