import { decide, matchesUrl } from "@wtt/core";
import type { CompiledConfig, PageContext, RuntimeSettings } from "@wtt/core";

export type DecisionOutcome = { experiments: Array<{ id: string; variant: string }> } | null;

/**
 * spec §7.1: Mode A + needsProfile=false はブラウザ内評価(リクエストなし)。
 * needsProfile=true は URL が Experiment か patterns に一致する場合のみ送る(履歴記録のため patterns 単独一致でも送る)。
 * D-lite(mode B)は毎ページビュー送る — Cookie の Max-Age 再延長が decision 応答に乗るため(§9.6)
 */
export function needsRemoteDecision(settings: RuntimeSettings, config: CompiledConfig, url: string): boolean {
  if (settings.mode === "B") return true;
  if (!config.needsProfile) return false;
  if (config.experiments.some((e) => matchesUrl(url, e.urlMatch))) return true;
  return Object.values(config.patterns).some((p) => matchesUrl(url, p));
}

export function decideLocally(config: CompiledConfig, ctx: PageContext, visitorId: string): DecisionOutcome {
  return { experiments: decide(config, ctx, visitorId, null).map((r) => ({ id: r.experimentId, variant: r.variantId })) };
}

/**
 * spec §9.1 / §10.7: 失敗(非 2xx・不正 JSON・abort)はすべて null = 元表示。
 * spec §7.5: 応答の `v` が要求 version と一致しない場合、および entry が 1 つでも壊れている場合は
 * 部分適用せず全体を null にする(config と別 version の Change が混ざるのを防ぐ。r1 CX-Medium-4)
 */
export async function requestDecision(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  signal: AbortSignal,
  expectedVersion: number,
): Promise<DecisionOutcome> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { v?: unknown; experiments?: unknown };
    if (typeof json !== "object" || json === null || !Array.isArray(json.experiments)) return null;
    if (json.v !== expectedVersion) return null;
    const experiments: Array<{ id: string; variant: string }> = [];
    for (const e of json.experiments as Array<{ id?: unknown; variant?: unknown }>) {
      if (typeof e?.id !== "string" || typeof e?.variant !== "string") return null;
      experiments.push({ id: e.id, variant: e.variant });
    }
    return { experiments };
  } catch {
    return null;
  }
}
