import type { CompiledConfig } from "@wtt/core";

/** 配列の順は配信に影響するので保ち、オブジェクトの挿入順だけをそろえる。 */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)]));
    return v;
  };
  return JSON.stringify(sort(value));
}

function entries(config: CompiledConfig): Map<string, { index: number; value: string }> {
  return new Map(config.experiments.map((entry, index) => {
    const patterns: CompiledConfig["patterns"] = {};
    const visit = (v: unknown): void => {
      if (typeof v === "string" && Object.hasOwn(config.patterns, v)) patterns[v] = config.patterns[v]!;
      else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") Object.values(v).forEach(visit);
    };
    visit(entry);
    return [entry.id, { index, value: canonical({ entry, prehide: config.prehide[entry.id], exposureSelectors: config.exposureSelectors[entry.id], exposurePayloads: config.exposurePayloads?.[entry.id], patterns }) }];
  }));
}

/** 訪問者に届く設定の差を一覧に補う。版と結果の記録は比較に入れない。 */
export function diffCompiledConfigs(next: CompiledConfig, active: CompiledConfig): { experimentIds: string[]; siteLevel: boolean } {
  const a = entries(next), b = entries(active);
  const experimentIds = [...new Set([...a.keys(), ...b.keys()])].filter((id) => {
    const n = a.get(id), p = b.get(id);
    return !n || !p || n.index !== p.index || n.value !== p.value;
  }).sort();
  const site = (c: CompiledConfig) => canonical({ goals: c.goals, conversionPayloads: c.conversionPayloads, timezone: c.timezone });
  return { experimentIds, siteLevel: site(next) !== site(active) };
}
