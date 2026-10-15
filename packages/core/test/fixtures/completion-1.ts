import { compile } from "../../src/compile";
import type { ProfileSnapshot } from "../../src/evaluate";
import { patternIdOf } from "../../src/pattern-id";
import type { CompiledConfig } from "../../src/schema";

/**
 * 完成の基準 1(決定 49、設計書 §0): 「パスが /pricing/ で始まるページを 2 回以上見て(最後の閲覧が 30 日以内)、資料請求が未達成で、
 * 平日 9〜18 時に来た、iOS の Safari の訪問者」。COMPLETION_1_TARGETING は管理画面のフォームが作る保存する形
 * (apps/admin/test/targeting-tree.test.ts が同じ値と照らす)。edge(apps/edge/test/completion.test.ts)は実際の decision で履歴を積んでから判定し、
 * runtime(packages/runtime/test/parity.test.ts)はブラウザで集めた入力と、DO が積むのと同じ履歴で判定する。両方が CASES の expected と一致する
 */
export const PRICING_PAGE = { part: "path", op: "startsWith", value: "/pricing/" } as const;
export const PRICING_ID = patternIdOf(PRICING_PAGE);
export const COMPLETION_1_TARGETING = {
  and: [
    { hist: "visited", page: PRICING_PAGE, min: 2, withinDays: 30 },
    { not: { hist: "converted", goal: "g_lead" } },
    { ctx: "time", days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" },
    { ctx: "os", op: "in", value: ["ios"] },
    { ctx: "browser", op: "in", value: ["safari"] },
  ],
};
export const COMPLETION_1_CONFIG: CompiledConfig = compile({
  siteId: "site_c1", siteSalt: "salt_c1", version: 1, timezone: "Asia/Tokyo", retentionDays: 90,
  goals: [{ id: "g_lead", name: "資料請求", type: "CUSTOM", config: {} }],
  experiments: [{
    id: "exp_c1", name: "完成の基準 1", urlMatch: { part: "path", op: "startsWith", value: "/products/" }, targeting: COMPLETION_1_TARGETING,
    trafficPercentage: 100, persistAssignment: false,
    variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
  }],
});
export const COMPLETION_1_URL = "https://www.example.com/products/1";
export const PRICING_URL = "https://www.example.com/pricing/plan";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DAY = 86_400_000;
const TUE_10 = Date.UTC(2026, 9, 6, 1, 0); // 2026-10-06(火)10:00 JST
const TUE_18 = Date.UTC(2026, 9, 6, 9, 0); // 同じ日の 18:00 JST(終了時刻は含まない)
const SAT_10 = Date.UTC(2026, 9, 10, 1, 0); // 2026-10-10(土)10:00 JST

/** pricingViews = 料金ページを閲覧した時刻(epoch ミリ秒)。leadAt = 資料請求を達成した時刻 */
export type Completion1Case = { name: string; userAgent: string; now: number; pricingViews: number[]; leadAt: number | null; expected: boolean };
const ok = (now: number) => [now - 3 * DAY, now - DAY];
export const COMPLETION_1_CASES: Completion1Case[] = [
  { name: "条件をすべて満たす", userAgent: IPHONE_SAFARI, now: TUE_10, pricingViews: ok(TUE_10), leadAt: null, expected: true },
  { name: "料金ページの閲覧が 1 回だけ", userAgent: IPHONE_SAFARI, now: TUE_10, pricingViews: [TUE_10 - DAY], leadAt: null, expected: false },
  { name: "最後の閲覧が 31 日前", userAgent: IPHONE_SAFARI, now: TUE_10, pricingViews: [TUE_10 - 40 * DAY, TUE_10 - 31 * DAY], leadAt: null, expected: false },
  { name: "資料請求を達成済み", userAgent: IPHONE_SAFARI, now: TUE_10, pricingViews: ok(TUE_10), leadAt: TUE_10 - 2 * DAY, expected: false },
  { name: "土曜", userAgent: IPHONE_SAFARI, now: SAT_10, pricingViews: ok(SAT_10), leadAt: null, expected: false },
  { name: "平日の 18:00 ちょうど", userAgent: IPHONE_SAFARI, now: TUE_18, pricingViews: ok(TUE_18), leadAt: null, expected: false },
  { name: "Windows の Chrome", userAgent: WINDOWS_CHROME, now: TUE_10, pricingViews: ok(TUE_10), leadAt: null, expected: false },
];

/** DO が積むのと同じ履歴(runtime 側の判定に使う)。lastAt は epoch 秒 */
export function profileFor(c: Completion1Case): ProfileSnapshot {
  return {
    pages: c.pricingViews.length > 0 ? { [PRICING_ID]: { count: c.pricingViews.length, lastAt: Math.floor(Math.max(...c.pricingViews) / 1000) } } : {},
    goals: c.leadAt !== null ? { g_lead: { count: 1, lastAt: Math.floor(c.leadAt / 1000) } } : {},
  };
}
