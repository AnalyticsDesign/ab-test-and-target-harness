import type { Env } from "./env";

/** spec §9.5 / 決定 12・29: IP あたりの上限 / 10 秒(値は wrangler.jsonc の binding。既定の考え方は docs/deploy.md 2.3)。binding 不在・limit() 例外は fail-open(決定 29。設定漏れの検出は Task 11 の実 binding スモーク) */
export async function rateLimitOk(env: Env, ip: string | null | undefined): Promise<boolean> {
  if (!env.DECISION_RATE_LIMITER) return true;
  try {
    const { success } = await env.DECISION_RATE_LIMITER.limit({ key: ip ?? "unknown" });
    return success;
  } catch (e) {
    console.error("wtt-edge: rate limiter unavailable, failing open (decision 29)", e);
    return true;
  }
}
