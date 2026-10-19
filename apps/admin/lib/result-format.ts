import type { VerdictState } from "@wtt/stats";

/**
 * D9 ③: 結果の数値と判定の書式(結果のタブ・終了のモーダル・複製の画面・一覧の採用の要約で同じ書き方にする)
 */

/** 3 桁ごとのカンマ */
export const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** 符号付き(負は全角のマイナス。モックと同じ) */
export const sgn = (x: number, d: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
/** 割合(0〜1)を % に */
export const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;
/** 確率(0〜1)。端は「99.9% 超」「0.1% 未満」(四捨五入で 100% / 0% と出さない) */
export function probPct(p: number): string {
  if (p >= 0.9995) return "99.9% 超";
  if (p < 0.0005) return "0.1% 未満";
  return pct(p);
}

/** 月/日(サイトのタイムゾーン)。不正なタイムゾーン名(古いデータ)は UTC に落とす */
export function monthDay(at: number, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("ja-JP", { ...opts, timeZone }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("ja-JP", { ...opts, timeZone: "UTC" }).formatToParts(at);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}

/** 判定の 5 状態の表示 */
export const STATE_LABEL: Record<VerdictState, string> = {
  blocked_quality: "データ品質の問題で判定不可",
  adopt: "採用候補",
  worse: "悪化の可能性が高い",
  equivalent: "実務上ほぼ同等",
  insufficient: "判断材料が不足",
};
