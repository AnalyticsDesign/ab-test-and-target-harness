/**
 * 新しい訪問者の Profile の予算(決定 63 (8)・(13)(i)。plan12 K9)。zod-free。
 * edge は Profile を作った後に isolate の数え役で数え、予算の Durable Object(NewProfileBudget)に報告する。
 * 値を設定の record(`newProfileBudget`)に書くのは control(Free / Paid で既定値が違う)。runtime には入れない
 */

/** 1 時間の上限 = 1 日の上限 × この比率(切り上げ)。サイトの予算と導入全体の予算で同じ比率を使う */
export const NEW_PROFILE_HOURLY_RATIO = 0.1;

/** サイトの 1 日の上限の既定値(Cloudflare のプランで変える。control が record に書く) */
export const NEW_PROFILE_BUDGET_DEFAULTS = { free: 20_000, paid: 200_000 } as const;

/** Free のときだけ control が書く、導入全体の 1 日の上限(Free の DO の上限をサイトで分け合うため) */
export const NEW_PROFILE_INSTANCE_PER_DAY_FREE = 20_000;

/** 設定の record の `newProfileBudget`(settings.ts のスキーマと同じ形)。`instancePerDay` が無い = 導入全体の上限なし(Paid) */
export type NewProfileBudget = { perDay: number; instancePerDay?: number };

/** 1 日の上限から、1 時間と 1 日の上限を作る(予算の DO に送る形) */
export function newProfileLimits(perDay: number): { perHour: number; perDay: number } {
  return { perHour: Math.ceil(perDay * NEW_PROFILE_HOURLY_RATIO), perDay };
}

/** UTC の時の鍵(`YYYY-MM-DDTHH`)。日の鍵は results.ts の utcDay(`YYYY-MM-DD`) */
export function utcHourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}
