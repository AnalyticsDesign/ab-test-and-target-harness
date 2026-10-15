import { compile } from "../../src/compile";
import type { CompiledConfig } from "../../src/schema";

/**
 * 同じ入力(UA・判定時刻・画面の幅・訪問者 ID・初回の訪問)なら edge とブラウザで同じ判定になることを確かめる共通の入力(決定 49、設計書 §0 の 3)。
 * edge(apps/edge/test/parity.test.ts)と runtime(packages/runtime/test/parity.test.ts)が同じ期待値と照らす。
 * すべて needsProfile: false(履歴を使わない条件)、weight は B が 100(Variant に揺れが無い)
 */
const exp = (id: string, targeting: unknown) => ({
  id, name: id, urlMatch: { op: "contains", value: "/" }, targeting, trafficPercentage: 100, persistAssignment: false,
  variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
});

export const PARITY_CONFIG: CompiledConfig = compile({
  siteId: "site_parity", siteSalt: "salt_parity", version: 1, timezone: "Asia/Tokyo", goals: [],
  experiments: [
    exp("e_path_re", { ctx: "path", op: "regex", value: "^/products/\\d+$" }),
    exp("e_host", { ctx: "host", op: "endsWith", value: "example.com" }),
    exp("e_safari", { ctx: "browser", op: "in", value: ["safari"] }),
    exp("e_not_windows", { not: { ctx: "os", op: "in", value: ["windows"] } }),
    exp("e_wide", { ctx: "viewport", minWidth: 768 }),
    exp("e_weekday_day", { ctx: "time", days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }),
    exp("e_new", { ctx: "sinceFirstVisit", op: "lt", days: 1 }),
    exp("e_mail", { ctx: "query", name: "utm", op: "contains", value: "mail" }),
  ],
});

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TUE_10_JST = Date.UTC(2026, 9, 6, 1, 0); // 2026-10-06(火)10:00 JST
const SAT_10_JST = Date.UTC(2026, 9, 10, 1, 0); // 2026-10-10(土)10:00 JST
const HOUR = 3_600_000;

export type ParityCase = { name: string; url: string; userAgent: string; width: number; hasViewportMeta: boolean; now: number; firstVisitAt: number | null; expected: string[] };

export const PARITY_CASES: ParityCase[] = [
  {
    name: "iPhone の Safari・平日の日中・新規・商品ページ・メールからの流入",
    url: "https://shop.example.com/products/12?utm=mail", userAgent: IPHONE_SAFARI, width: 390, hasViewportMeta: true, now: TUE_10_JST, firstVisitAt: TUE_10_JST - HOUR,
    expected: ["e_path_re", "e_host", "e_safari", "e_not_windows", "e_weekday_day", "e_new", "e_mail"],
  },
  {
    name: "Windows の Chrome・土曜・古い訪問者(v4 = 発行時刻が不明)・別のホスト",
    url: "https://other.test/products/12x", userAgent: WINDOWS_CHROME, width: 1280, hasViewportMeta: true, now: SAT_10_JST, firstVisitAt: null,
    expected: ["e_wide"],
  },
  {
    name: "viewport の meta が無いページ = 画面の幅は不明(e_wide だけ対象外。ほかは判定する)",
    url: "https://www.example.com/", userAgent: IPHONE_SAFARI, width: 980, hasViewportMeta: false, now: TUE_10_JST, firstVisitAt: TUE_10_JST,
    expected: ["e_host", "e_safari", "e_not_windows", "e_weekday_day", "e_new"],
  },
  {
    name: "パスが 256 字を超える = パスの正規表現は判定しない(e_path_re だけ対象外)",
    url: `https://www.example.com/products/${"1".repeat(260)}`, userAgent: WINDOWS_CHROME, width: 1280, hasViewportMeta: true, now: TUE_10_JST, firstVisitAt: TUE_10_JST - 48 * HOUR,
    expected: ["e_host", "e_wide", "e_weekday_day"],
  },
];
