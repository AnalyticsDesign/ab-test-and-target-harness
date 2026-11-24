import type { AnalyticsSettings } from "@/lib/types";

export const ANALYTICS_FIELDS: Array<{ path: string; label: string; get: (a: AnalyticsSettings) => string }> = [
  { path: "extraKey", label: "extra の名前空間キー", get: (a) => a.extraKey },
  { path: "exposure.event", label: "露出のイベント名", get: (a) => a.exposure.event },
  { path: "exposure.keys.experimentId", label: "露出: experimentId キー", get: (a) => a.exposure.keys.experimentId! },
  { path: "exposure.keys.experimentName", label: "露出: experimentName キー", get: (a) => a.exposure.keys.experimentName! },
  { path: "exposure.keys.variantId", label: "露出: variantId キー", get: (a) => a.exposure.keys.variantId! },
  { path: "exposure.keys.variantName", label: "露出: variantName キー", get: (a) => a.exposure.keys.variantName! },
  { path: "conversion.event", label: "コンバージョンのイベント名", get: (a) => a.conversion.event },
  { path: "conversion.keys.goalId", label: "コンバージョン: goalId キー", get: (a) => a.conversion.keys.goalId! },
  { path: "conversion.keys.goalName", label: "コンバージョン: goalName キー", get: (a) => a.conversion.keys.goalName! },
];
function setPath(obj: Record<string, unknown>, path: string, value: string) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]!] = value;
}

export function readAnalytics(fd: FormData): AnalyticsSettings {
  const analytics = { dataLayerName: String(fd.get("analytics.dataLayerName")) };
  for (const f of ANALYTICS_FIELDS) setPath(analytics, f.path, String(fd.get(`analytics.${f.path}`)));
  return analytics as AnalyticsSettings;
}
