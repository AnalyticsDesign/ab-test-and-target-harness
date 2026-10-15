import { describe, expect, it } from "vitest";
import { INSTANCE_SETTING_DEFAULTS, type UsageSettings } from "../src/instance-settings";
import { judge, startOfUtcDay, type RawUsage } from "../src/usage/judge";
import { RESOURCE_IDS } from "../src/usage/limits";

// backlog D10 / brief K11〜K15: 判定は純関数。Free = 日次の上限、Paid = $5 の枠 ÷ 30 の目安
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 6); // 2026-10-06 00:00 UTC
const zero = (): RawUsage => Object.fromEntries(RESOURCE_IDS.map((id) => [id, { used: 0, breakdown: [] }])) as unknown as RawUsage;
const raw = (over: Partial<Record<keyof RawUsage, number>>): RawUsage => {
  const r = zero();
  for (const [k, v] of Object.entries(over)) r[k as keyof RawUsage] = { used: v!, breakdown: [] };
  return r;
};
const free: UsageSettings = INSTANCE_SETTING_DEFAULTS;
const paid: UsageSettings = { ...INSTANCE_SETTING_DEFAULTS, cloudflarePlan: "paid" };
const res = (r: ReturnType<typeof judge>, id: string) => r.resources.find((x) => x.id === id)!;

describe("usage judge (D10)", () => {
  it("lists every resource once, in table order, and the day boundaries are UTC midnight", () => {
    const r = judge(zero(), free, T0 + 5 * 3_600_000);
    expect(r.resources.map((x) => x.id)).toEqual([...RESOURCE_IDS]);
    expect(startOfUtcDay(T0 + DAY - 1)).toBe(T0);
    expect(r.resetAt).toBe(T0 + DAY);
    expect(r.asOf).toBe(T0 + 5 * 3_600_000);
    expect(r.plan).toBe("free");
    expect(r.settings).toEqual(free);
  });

  it("free: thresholds 70 / 90 / 100 percent (K12)", () => {
    const at = T0 + 12 * 3_600_000;
    const s = (n: number) => res(judge(raw({ workers_requests: n }), free, at), "workers_requests");
    expect(s(69_999)).toMatchObject({ status: "ok", limit: 100_000, ratio: 0.69999 });
    expect(s(70_000).status).toBe("warning");
    expect(s(90_000).status).toBe("critical");
    expect(s(100_000).status).toBe("exhausted");
    expect(s(100_000).projectedExhaustAt).toBeNull(); // 尽きた後は予測しない
  });

  it("free: linear projection within the day, null in the first hour and after the reset (K12)", () => {
    // 6 時間で 30,000 → 1 時間 5,000 → 100,000 に届くのは 20 時
    expect(res(judge(raw({ workers_requests: 30_000 }), free, T0 + 6 * 3_600_000), "workers_requests").projectedExhaustAt).toBe(T0 + 20 * 3_600_000);
    // 経過 1 時間未満は出さない
    expect(res(judge(raw({ workers_requests: 50_000 }), free, T0 + 59 * 60_000), "workers_requests").projectedExhaustAt).toBeNull();
    // 12 時間で 30,000 → 届くのは 40 時 = 次のリセットより後
    expect(res(judge(raw({ workers_requests: 30_000 }), free, T0 + 12 * 3_600_000), "workers_requests").projectedExhaustAt).toBeNull();
    // 消費 0 は予測しない
    expect(res(judge(zero(), free, T0 + 12 * 3_600_000), "workers_requests").projectedExhaustAt).toBeNull();
  });

  it("free: worst is the highest ratio among judged resources", () => {
    const r = judge(raw({ workers_requests: 40_000, kv_writes: 800, do_rows_written: 10_000 }), free, T0 + 3_600_000);
    expect(r.worst).toEqual({ id: "kv_writes", status: "warning", ratio: 0.8 });
  });

  it("free: capacity uses the free limits and has no projection (K14)", () => {
    const r = judge(raw({ d1_largest_db: 450_000_000, kv_storage: 100_000_000 }), free, T0 + 3_600_000);
    expect(res(r, "d1_largest_db")).toMatchObject({ kind: "capacity", unit: "bytes", limit: 500_000_000, ratio: 0.9, status: "critical", projectedExhaustAt: null, reference: null });
    expect(res(r, "kv_storage")).toMatchObject({ limit: 1_000_000_000, status: "ok" });
  });

  it("paid: daily resources show the $5 reference (monthly / 30) and are not judged (K13)", () => {
    const r = judge(raw({ workers_requests: 400_000, do_requests: 10_000 }), paid, T0 + 6 * 3_600_000);
    const w = res(r, "workers_requests");
    expect(w).toMatchObject({ limit: null, ratio: null, projectedExhaustAt: null, status: "over_reference" });
    expect(w.reference?.value).toBeCloseTo(10_000_000 / 30);
    expect(w.reference?.ratio).toBeCloseTo(400_000 / (10_000_000 / 30));
    expect(res(r, "do_requests").status).toBe("within_reference");
  });

  it("paid: only the D1 per-database cap is judged; other storage gets its included amount as reference (K14)", () => {
    const r = judge(raw({ d1_largest_db: 9_500_000_000, do_storage: 6_000_000_000 }), paid, T0 + 3_600_000);
    expect(res(r, "d1_largest_db")).toMatchObject({ limit: 10_000_000_000, ratio: 0.95, status: "critical" });
    expect(res(r, "do_storage")).toMatchObject({ limit: null, status: "over_reference", reference: { value: 5_000_000_000, ratio: 1.2 } });
    expect(r.worst).toEqual({ id: "d1_largest_db", status: "critical", ratio: 0.95 });
  });

  it("paid: the screen setting does not remove the reference from the API (K13)", () => {
    const r = judge(raw({ workers_requests: 1 }), { ...paid, showPaidReference: false }, T0 + 3_600_000);
    expect(res(r, "workers_requests").reference).not.toBeNull();
  });

  it("keeps the breakdown as given", () => {
    const r0 = zero();
    r0.workers_requests = { used: 30, breakdown: [{ name: "wtt-control", used: 20 }, { name: "wtt-edge", used: 10 }] };
    expect(res(judge(r0, free, T0 + 3_600_000), "workers_requests").breakdown).toEqual([{ name: "wtt-control", used: 20 }, { name: "wtt-edge", used: 10 }]);
  });

  it("a resource that is not judged has no limit and is left out of worst", () => {
    // K22: 本製品の DB が設定に無いと d1_largest_db は判定しない
    const r0 = raw({ workers_requests: 10_000 });
    r0.d1_largest_db = { used: 0, breakdown: [], judged: false };
    const r = judge(r0, free, T0 + 3_600_000);
    expect(res(r, "d1_largest_db")).toMatchObject({ kind: "capacity", limit: null, ratio: null, status: "not_judged", reference: null, projectedExhaustAt: null });
    expect(r.worst).toEqual({ id: "workers_requests", status: "ok", ratio: 0.1 });
  });
});
