import { DEFAULT_ANALYTICS, type AnalyticsSettings, type ExposurePayload, type RuntimeSettings } from "@wtt/core";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const allStrings = (v: unknown, keys: readonly string[]): boolean => isRecord(v) && keys.every((k) => typeof v[k] === "string");

/**
 * boot payload 内の settings.analytics の形チェック(§10.9)。edge は zod で検証済みなので、ここで弾くのは
 * 配信路上の改竄・別物だけ。欠落(undefined)は呼び出し側が既定値にフォールバックする — 型不正は fail-closed
 */
export function isAnalyticsSettings(v: unknown): v is AnalyticsSettings {
  if (!isRecord(v) || typeof v.extraKey !== "string") return false;
  if (v.dataLayerName !== undefined && typeof v.dataLayerName !== "string") return false; // 決定 62: 欠落は既定(analyticsNames が埋める)
  const ex = v.exposure;
  const cv = v.conversion;
  return (
    isRecord(ex) && typeof ex.event === "string" && allStrings(ex.keys, ["experimentId", "experimentName", "variantId", "variantName"]) &&
    isRecord(cv) && typeof cv.event === "string" && allStrings(cv.keys, ["goalId", "goalName"])
  );
}

/**
 * boot payload 内の config.exposurePayloads の形チェック(§10.9)。runtime が読む全階層・全フィールドを起動前に見る。
 * 型不正は boot 全体の拒否(DOM 適用も push も起きない fail-closed)。欠落(undefined)だけが導出フォールバックの対象。
 * apply engine の onApplied は DOM 変更の後に呼ばれ、MutationObserver 経路は try/catch の外なので、expose() で例外を出す形をここで断つ
 */
export function isExposurePayloads(v: unknown): v is Record<string, Record<string, ExposurePayload>> {
  if (!isRecord(v)) return false;
  for (const byVariant of Object.values(v)) {
    if (!isRecord(byVariant)) return false;
    for (const p of Object.values(byVariant)) {
      if (!allStrings(p, ["experimentId", "experimentName", "variantId", "variantName"])) return false;
      const extra = (p as Record<string, unknown>).extra;
      if (!isRecord(extra) || Object.values(extra).some((x) => typeof x !== "string")) return false;
    }
  }
  return true;
}

/**
 * §10.9「バージョンと異常時」: settings.analytics が無い(旧 record)なら既定の名前(extraKey を含む)を使う。
 * 決定 62 より前に焼いた bootstrap は analytics があっても dataLayerName を持たないので、そこだけ既定で埋める
 */
export function analyticsNames(settings: RuntimeSettings): AnalyticsSettings {
  const a = settings.analytics;
  if (!a) return DEFAULT_ANALYTICS;
  return (a as Partial<AnalyticsSettings>).dataLayerName === undefined ? { ...a, dataLayerName: DEFAULT_ANALYTICS.dataLayerName } : a;
}
