import { analyticsValueIssue, type AnalyticsValueIssue } from "@wtt/core";

/** 外部計測(エクスペリエンス・パターン・目標の analytics)の、値の検査に使う部分 */
export type AnalyticsValues = { overrides?: Record<string, string | undefined>; extra?: Record<string, string> };
export type AnalyticsValueError = { path: string[]; code: AnalyticsValueIssue["code"]; message: string };

/**
 * B77(K12): dataLayer に出す値の保存の前の検査。control の assertAnalyticsValues と同じ規則で、
 * `prev`(保存済みの analytics。新規は null)の同じ場所と同じ値は見ない — 変えていない古い値(マイグレーションで写した名前など)は
 * 欄にも何も出さず、他の欄の保存も止めない。名前の指定の空欄は「指定なし」(保存では送らない)なので見ない。
 * 最初の 1 件で止めず、問題のある欄をすべて返す(各欄にその `message` を出す)
 */
export function analyticsValueErrors(next: AnalyticsValues | null | undefined, prev: AnalyticsValues | null, path: string[]): AnalyticsValueError[] {
  if (!next) return [];
  const out: AnalyticsValueError[] = [];
  for (const group of ["overrides", "extra"] as const) {
    for (const [key, value] of Object.entries(next[group] ?? {})) {
      if (value === undefined || prev?.[group]?.[key] === value) continue;
      if (group === "overrides" && value === "") continue;
      const issue = analyticsValueIssue(value);
      if (issue) out.push({ path: [...path, group, key], code: issue.code, message: issue.message });
    }
  }
  return out;
}

/**
 * 欄に出すエラー(ruling R12)。「追加」を押したばかりでキーがまだ空の行に、入力の前から「値を入力してください」を出さない。
 * 保存を試した後(saveTried)はすべて出す。保存の前の検査(analyticsValueErrors そのもの)はこの行でも保存を止める
 */
export function shownValueErrors(errors: AnalyticsValueError[], saveTried: boolean): AnalyticsValueError[] {
  if (saveTried) return errors;
  return errors.filter((e) => !(e.code === "empty" && e.path.at(-2) === "extra" && e.path.at(-1) === ""));
}
