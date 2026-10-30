import { decide, matchesUrl } from "@wtt/core";
import type { CompiledConfig, PageContext, RuntimeSettings } from "@wtt/core";

/** vh = D-lite の decision の応答の訪問者 ID の短いハッシュ(結果の送信済みの印の i。設計書 §6.2) */
export type DecisionOutcome = { experiments: Array<{ id: string; variant: string }>; vh?: string } | null;

/**
 * B139 §4.1: 今の D-lite の経路(/__ab/*、Cookie は edge が持つ)を使うか。Mode B で、https かつ host(ポート込み)が
 * Cloudflare 経由のドメインの一覧にあるときだけ真。偽なら Mode A の経路(/v1/、本文に visitorId、Cookie は runtime が書く)
 */
export const onEdgePath = (settings: RuntimeSettings, loc: { protocol: string; host: string }): boolean =>
  settings.mode === "B" && loc.protocol === "https:" && (settings.edgeHosts ?? []).includes(loc.host);

/**
 * spec §7.1: Mode A + needsProfile=false はブラウザ内評価(リクエストなし)。
 * needsProfile=true は URL が Experiment か patterns に一致する場合のみ送る(履歴記録のため patterns 単独一致でも送る)。
 * D-lite(Cloudflare 経由のドメイン = edgePath)は毎ページビュー送る — Cookie の Max-Age 再延長が decision 応答に乗るため(§9.6)。
 * Mode B の Cloudflare 外のドメインは Mode A と同じ(B139 §4.1)
 */
export function needsRemoteDecision(edgePath: boolean, config: CompiledConfig, url: string): boolean {
  if (edgePath) return true;
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
    const json = (await res.json()) as { v?: unknown; experiments?: unknown; vh?: unknown };
    if (typeof json !== "object" || json === null || !Array.isArray(json.experiments)) return null;
    if (json.v !== expectedVersion) return null;
    const experiments: Array<{ id: string; variant: string }> = [];
    for (const e of json.experiments as Array<{ id?: unknown; variant?: unknown }>) {
      if (typeof e?.id !== "string" || typeof e?.variant !== "string") return null;
      experiments.push({ id: e.id, variant: e.variant });
    }
    return { experiments, vh: json.vh as string | undefined }; // 形は見ない(印の i と等しいかを比べるだけ)
  } catch {
    return null;
  }
}
