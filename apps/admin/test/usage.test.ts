// apps/admin/test/usage.test.ts
import { describe, expect, it } from "vitest";
import { amountHeader, formatAmount, usageSections, paidNote, formatPercent, settingsLine, showsReference, statusLabel, statusTone, summaryView, topResources, usageFailure, usageRows } from "@/lib/usage";
import type { UsageReport, UsageResource } from "@/lib/types";

// backlog D10 / brief K5・K13、plan K25: 使用状況の表示の判断(純関数)
const r = (id: string, over: Partial<UsageResource> = {}): UsageResource => ({
  id, kind: "daily", unit: "count", used: 0, limit: 100, ratio: 0, status: "ok", projectedExhaustAt: null, reference: null, breakdown: [], ...over,
});
const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  plan: "free", asOf: 0, resetAt: 0, worst: null,
  settings: { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true },
  resources: [], ...over,
});

describe("usage view (D10)", () => {
  it("settings line names who can see, the plan and the reference only for paid (K5)", () => {
    expect(settingsLine({ usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true })).toBe("見られる人: すべてのメンバー · プラン: Free");
    expect(settingsLine({ usageVisibility: "instance_admins", cloudflarePlan: "paid", showPaidReference: true })).toBe("見られる人: システム管理者のみ · プラン: Paid(月額 $5 に含まれる量: 表示)");
    expect(settingsLine({ usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false })).toBe("見られる人: すべてのメンバー · プラン: Paid(月額 $5 に含まれる量: 非表示)");
  });

  it("status labels and tones keep stop risks and paid references apart (K13)", () => {
    expect([statusLabel("ok"), statusLabel("warning"), statusLabel("critical"), statusLabel("exhausted")]).toEqual(["余裕あり", "注意", "危険", "上限に到達"]);
    expect([statusLabel("within_reference"), statusLabel("over_reference")]).toEqual(["範囲内", "超過"]);
    expect([statusTone("ok"), statusTone("warning"), statusTone("critical"), statusTone("exhausted")]).toEqual(["ok", "warn", "danger", "danger"]);
    expect(statusTone("over_reference")).toBe("note"); // 止まらないので危険の色にしない
    expect([statusLabel("not_judged"), statusTone("not_judged")]).toEqual(["判定していません", "ok"]); // K22
  });

  it("formats counts and bytes", () => {
    expect(formatAmount(1234567, "count")).toBe("1,234,567");
    expect(formatAmount(311_296, "bytes")).toBe("311 KB");
    expect(formatAmount(2_500_000_000, "bytes")).toBe("2.5 GB");
    expect(formatPercent(0.69999)).toBe("69%"); // 1% 以上は切り捨て
    expect(formatPercent(0.7)).toBe("70%");
    expect(formatPercent(0.29)).toBe("29%"); // 0.29 * 100 = 28.999… でも 28% にしない
    expect(formatPercent(0.004)).toBe("0.4%");
  });

  it("top resources are the highest ratio first; paid uses the reference ratio (K25)", () => {
    const free = report({ resources: [r("a", { ratio: 0.1 }), r("b", { ratio: 0.8 }), r("c", { ratio: 0.5 }), r("d", { ratio: 0.2 })] });
    expect(topResources(free, 3).map((x) => x.id)).toEqual(["b", "c", "d"]);
    const paid = report({
      plan: "paid",
      settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: true },
      resources: [r("a", { ratio: null, limit: null, reference: { value: 1, ratio: 0.3 } }), r("b", { ratio: null, limit: null, reference: { value: 1, ratio: 2 } })],
    });
    expect(topResources(paid, 3).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("the reference is shown only for paid with the setting on (K13)", () => {
    expect(showsReference(report())).toBe(false);
    expect(showsReference(report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: true } }))).toBe(true);
    expect(showsReference(report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false } }))).toBe(false);
  });

  it("a failed or non-JSON usage response becomes a notice, not an exception", () => {
    expect(usageFailure(503, { error: "usage_not_configured", message: "m", hint: "h" })).toEqual({ title: "使用状況の取得が設定されていません", hint: "h" });
    expect(usageFailure(503, { error: "usage_upstream_failed", message: "m" })).toEqual({ title: "使用状況を取得できませんでした", hint: "m" });
    // HTML の 503(controlFetch の data が null)
    expect(usageFailure(503, null)).toEqual({ title: "使用状況を取得できませんでした", hint: "時間をおいて開き直してください(HTTP 503)" });
  });

  it("summary view: who sees what (K25)", () => {
    const s = { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true } as const;
    const on = { ...s, configured: true };
    const off = { ...s, configured: false };
    const fail = (status: number) => ({ ok: false as const, status, data: { error: "usage_upstream_failed", message: "m" } });
    const ok = { ok: true as const, report: report() };
    expect(summaryView({ instanceAdmin: false, settings: null, usage: null })).toEqual({ kind: "hidden" });
    expect(summaryView({ instanceAdmin: false, settings: off, usage: null })).toEqual({ kind: "hidden" });
    expect(summaryView({ instanceAdmin: true, settings: off, usage: null })).toEqual({
      kind: "unavailable",
      title: "使用状況の取得が設定されていません",
      hint: "設定 > システム > Cloudflare 使用状況の案内を見てください",
      adminLine: true,
    });
    expect(summaryView({ instanceAdmin: false, settings: on, usage: fail(403) })).toEqual({ kind: "hidden" });
    expect(summaryView({ instanceAdmin: false, settings: on, usage: fail(503) })).toEqual({ kind: "hidden" });
    expect(summaryView({ instanceAdmin: true, settings: on, usage: fail(503) })).toEqual({ kind: "unavailable", title: "使用状況を取得できませんでした", hint: "m", adminLine: true });
    expect(summaryView({ instanceAdmin: false, settings: on, usage: ok })).toEqual({ kind: "ok", report: report(), adminLine: false });
  });

  it("summary view: the settings line is for instance admins only", () => {
    const on = { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true, configured: true } as const;
    const ok = { ok: true as const, report: report() };
    expect(summaryView({ instanceAdmin: false, settings: on, usage: ok })).toMatchObject({ kind: "ok", adminLine: false });
    expect(summaryView({ instanceAdmin: true, settings: on, usage: ok })).toMatchObject({ kind: "ok", adminLine: true });
  });

  it("rows: free shows the limit ratio, status and projection", () => {
    const [row] = usageRows(
      report({ resources: [r("workers_requests", { used: 80_000, limit: 100_000, ratio: 0.8, status: "warning", projectedExhaustAt: 1_000, breakdown: [{ name: "wtt-control", used: 80_000 }] })] }),
    );
    expect(row).toEqual({
      id: "workers_requests",
      label: "Workers のリクエスト",
      used: "80,000",
      cap: "100,000",
      ratioText: "80%",
      meter: { ratio: 0.8, tone: "warn", ticks: true },
      status: { text: "注意", tone: "warn" },
      projectedAt: 1_000,
      breakdown: "wtt-control 80,000",
    });
  });

  it("rows: paid with the reference hidden keeps the D1 per-database risk and hides the daily references", () => {
    const paidHidden = report({
      plan: "paid",
      settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false },
      resources: [
        r("workers_requests", { limit: null, ratio: null, status: "over_reference", reference: { value: 333_333, ratio: 1.2 } }),
        r("d1_largest_db", { kind: "capacity", unit: "bytes", used: 9_500_000_000, limit: 10_000_000_000, ratio: 0.95, status: "critical" }),
      ],
    });
    const [daily, d1] = usageRows(paidHidden);
    expect(daily).toMatchObject({ cap: "", ratioText: "", meter: null, status: null });
    expect(d1).toMatchObject({ cap: "10 GB", ratioText: "95%", meter: { ratio: 0.95, tone: "danger", ticks: true }, status: { text: "危険", tone: "danger" } });
  });

  it("rows: paid with the reference shown draws the reference bar without the warning ticks", () => {
    const paidShown = report({
      plan: "paid",
      settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: true },
      resources: [r("workers_requests", { limit: null, ratio: null, status: "over_reference", reference: { value: 333_333, ratio: 1.2 } })],
    });
    const [daily] = usageRows(paidShown);
    expect(daily).toMatchObject({ cap: "333,333", ratioText: "120%", meter: { ratio: 1.2, tone: "note", ticks: false } });
  });

  it("amountHeader: the reference header only when paid shows it, and the limit row is marked under it", () => {
    const d1 = r("d1_largest_db", { kind: "capacity", unit: "bytes", used: 1_000_000_000, limit: 10_000_000_000, ratio: 0.1, status: "ok" });
    const paid = (showPaidReference: boolean) => report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference }, resources: [d1] });
    expect(amountHeader(report({ resources: [d1] }), "capacity")).toBe("使用量 / 上限");
    expect(amountHeader(paid(false), "capacity")).toBe("使用量 / 上限");
    expect(amountHeader(paid(true), "capacity")).toBe("使用量 / 月額 $5 に含まれる量");
    expect(usageRows(paid(true))[0]).toMatchObject({ cap: "10 GB(上限)" });
    expect(usageRows(paid(false))[0]).toMatchObject({ cap: "10 GB" });
  });

  it("amountHeader: the daily table says the denominator is per day (free = limit, paid = the 1-day reference, paid hidden = none)", () => {
    const req = r("workers_requests", {});
    const paid = (showPaidReference: boolean) => report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference }, resources: [req] });
    expect(amountHeader(report({ resources: [req] }), "daily")).toBe("使用量 / 1 日の上限");
    expect(amountHeader(paid(true), "daily")).toBe("使用量 / 1 日の目安");
    expect(amountHeader(paid(false), "daily")).toBe("使用量");
  });

  it("usageSections: splits the rows into the daily table and the storage table in that order, and drops an empty table", () => {
    const req = r("workers_requests", {});
    const kv = r("kv_reads", {});
    const d1 = r("d1_largest_db", { kind: "capacity", unit: "bytes", used: 1_000_000_000, limit: 10_000_000_000, ratio: 0.1, status: "ok" });
    const both = usageSections(report({ resources: [d1, req, kv] }));
    expect(both.map((x) => [x.kind, x.title, x.header, x.rows.map((row) => row.id)])).toEqual([
      ["daily", "1 日の量", "使用量 / 1 日の上限", ["workers_requests", "kv_reads"]],
      ["capacity", "保存量", "使用量 / 上限", ["d1_largest_db"]],
    ]);
    expect(both[0]?.projection).toBe(true);
    expect(both[1]?.projection).toBe(false);
    const limited = usageSections(report({ resources: [d1, req, kv] }), [req]);
    expect(limited.map((x) => x.kind)).toEqual(["daily"]);
  });

  it("usageSections: paid has no daily limit, so the daily table drops the projection column and, with the reference hidden, the empty ratio and status columns", () => {
    const req = r("workers_requests", { used: 1_000, limit: null, ratio: null, status: "within_reference", projectedExhaustAt: null, reference: { value: 333_333, ratio: 0.1 } });
    const d1 = r("d1_largest_db", { kind: "capacity", unit: "bytes", used: 9_500_000_000, limit: 10_000_000_000, ratio: 0.95, status: "critical" });
    const paid = (showPaidReference: boolean) =>
      usageSections(report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference }, resources: [req, d1] }));
    const [shownDaily, shownCap] = paid(true);
    expect(shownDaily).toMatchObject({ header: "使用量 / 1 日の目安", projection: false, ratio: true, status: true });
    expect(shownDaily?.rows[0]).toMatchObject({ cap: "333,333", ratioText: "10%" });
    expect(shownCap).toMatchObject({ header: "使用量 / 月額 $5 に含まれる量", projection: false, ratio: true, status: true });
    expect(shownCap?.rows[0]).toMatchObject({ cap: "10 GB(上限)", status: { text: "危険", tone: "danger" } });
    const [hiddenDaily, hiddenCap] = paid(false);
    expect(hiddenDaily).toMatchObject({ header: "使用量", projection: false, ratio: false, status: false });
    expect(hiddenDaily?.rows[0]).toMatchObject({ used: "1,000", cap: "" });
    expect(hiddenCap).toMatchObject({ header: "使用量 / 上限", ratio: true, status: true });
  });

  it("paidNote: free has none; paid gives the concrete example only when the comparison is shown", () => {
    const req = r("workers_requests", { limit: null, ratio: null, status: "within_reference", reference: { value: 10_000_000 / 30, ratio: 0.1 } });
    const paid = (showPaidReference: boolean) => report({ plan: "paid", settings: { usageVisibility: "members", cloudflarePlan: "paid", showPaidReference }, resources: [req] });
    expect(paidNote(report({ resources: [req] }))).toBeNull();
    expect(paidNote(paid(true))).toContain("(例: Workers のリクエストは月 10,000,000 件、1 日分は 333,333 件)");
    expect(paidNote(paid(false))).not.toContain("例:");
    expect(paidNote(paid(false))).toContain("月額 $5 に含まれる量を超えた分が、製品ごとに課金されます");
  });

  it("rows: not_judged shows its status in free", () => {
    const [row] = usageRows(report({ resources: [r("d1_largest_db", { kind: "capacity", unit: "bytes", limit: null, ratio: null, status: "not_judged" })] }));
    expect(row).toMatchObject({ ratioText: "", meter: null, status: { text: "判定していません", tone: "ok" } });
  });
});
