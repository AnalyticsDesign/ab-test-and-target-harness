import type { CloudflarePlan, UsageSettings } from "../instance-settings";
import { CAPACITY, CRITICAL_RATIO, DAILY, PAID_REFERENCE_DAYS, PROJECTION_MIN_ELAPSED_MS, RESOURCE_IDS, WARNING_RATIO, type ResourceId } from "./limits";

export type { ResourceId } from "./limits";
/** judged: false = 判定の対象が決まらないので判定しない(本製品の DB が設定に無い、または設定した ID が一致しないときの d1_largest_db。plan K22) */
export type Measured = { used: number; breakdown: Array<{ name: string; used: number }>; judged?: false };
export type RawUsage = Record<ResourceId, Measured>;
export type UsageStatus = "ok" | "warning" | "critical" | "exhausted" | "within_reference" | "over_reference" | "not_judged";
export type ResourceReport = {
  id: ResourceId;
  kind: "daily" | "capacity";
  unit: "count" | "bytes";
  used: number;
  limit: number | null;
  ratio: number | null;
  status: UsageStatus;
  projectedExhaustAt: number | null;
  reference: { value: number; ratio: number } | null;
  breakdown: Array<{ name: string; used: number }>;
};
export type UsageReport = {
  plan: CloudflarePlan;
  asOf: number;
  resetAt: number;
  worst: { id: ResourceId; status: UsageStatus; ratio: number } | null;
  settings: UsageSettings;
  resources: ResourceReport[];
};

const DAY_MS = 86_400_000;
export const startOfUtcDay = (now: number): number => now - (((now % DAY_MS) + DAY_MS) % DAY_MS);

const stopStatus = (ratio: number): UsageStatus =>
  ratio >= 1 ? "exhausted" : ratio >= CRITICAL_RATIO ? "critical" : ratio >= WARNING_RATIO ? "warning" : "ok";

/** K12: 当日の消費の線形の予測。経過 1 時間未満・消費 0・尽きた後・次のリセットより後は null */
function project(used: number, limit: number, dayStart: number, now: number): number | null {
  const elapsed = now - dayStart;
  if (elapsed < PROJECTION_MIN_ELAPSED_MS || used <= 0 || used >= limit) return null;
  const at = dayStart + Math.round((limit / used) * elapsed); // 浮動小数の誤差で 1 ms ずれないよう丸める
  return at < dayStart + DAY_MS ? at : null;
}

/**
 * backlog D10(brief K11〜K14): 取得した使用量を、プランに応じて判定する。純関数(D9 の Cron からも呼ぶ)。
 * Free = 日次の上限と容量の上限で判定。Paid = 日次は $5 の枠 ÷ 30 の目安(判定しない)、容量は D1 の 1 DB だけ判定。
 * showPaidReference は画面の設定なので、ここでは reference を消さない。judged: false の資源は判定しない(not_judged、worst に入れない)
 */
export function judge(raw: RawUsage, settings: UsageSettings, now: number): UsageReport {
  const plan = settings.cloudflarePlan;
  const dayStart = startOfUtcDay(now);
  const resources = RESOURCE_IDS.map((id): ResourceReport => {
    const { used, breakdown, judged } = raw[id];
    const daily = DAILY[id];
    // K22: 判定の対象が決まらない資源は上限も目安も出さない(ratio が null なので worst にも入らない)
    if (judged === false) {
      return { id, kind: daily ? "daily" : "capacity", unit: daily ? "count" : "bytes", used, limit: null, ratio: null, status: "not_judged", projectedExhaustAt: null, reference: null, breakdown };
    }
    if (daily) {
      if (plan === "free") {
        const ratio = used / daily.freeDaily;
        return { id, kind: "daily", unit: "count", used, limit: daily.freeDaily, ratio, status: stopStatus(ratio), projectedExhaustAt: project(used, daily.freeDaily, dayStart, now), reference: null, breakdown };
      }
      const value = daily.paidMonthly / PAID_REFERENCE_DAYS;
      const refRatio = used / value;
      return { id, kind: "daily", unit: "count", used, limit: null, ratio: null, status: refRatio > 1 ? "over_reference" : "within_reference", projectedExhaustAt: null, reference: { value, ratio: refRatio }, breakdown };
    }
    const cap = CAPACITY[id]![plan];
    if (cap.kind === "limit") {
      const ratio = used / cap.value;
      return { id, kind: "capacity", unit: "bytes", used, limit: cap.value, ratio, status: stopStatus(ratio), projectedExhaustAt: null, reference: null, breakdown };
    }
    const refRatio = used / cap.value;
    return { id, kind: "capacity", unit: "bytes", used, limit: null, ratio: null, status: refRatio > 1 ? "over_reference" : "within_reference", projectedExhaustAt: null, reference: { value: cap.value, ratio: refRatio }, breakdown };
  });
  let worst: UsageReport["worst"] = null;
  for (const r of resources) {
    if (r.ratio === null) continue; // 目安(止まらない資源)は数えない
    if (!worst || r.ratio > worst.ratio) worst = { id: r.id, status: r.status, ratio: r.ratio };
  }
  return { plan, asOf: now, resetAt: dayStart + DAY_MS, worst, settings, resources };
}
