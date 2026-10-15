/**
 * 曜日・時間帯の判定(決定 49、設計書 §8)。サイトのタイムゾーン(IANA 名)での曜日と時刻で判定する。訪問者の端末のタイムゾーンは使わない。
 * zod を使わない(runtime が import する)
 */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** IANA 名として使えるか(保存時の検査。使えなければ 422) */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * タイムゾーン名の綴りをそろえる(保存時。例: asia/tokyo → Asia/Tokyo)。大文字小文字だけを一覧(Intl.supportedValuesOf)の綴りにそろえ、
 * 別名(Asia/Kolkata と Asia/Calcutta など)は置き換えない(正規名は実行環境の ICU の版で変わる。Node 24 は Asia/Kolkata を Asia/Calcutta に変える。plan ② P14)。
 * 使えない名前と、オフセット形式(+09:00。IANA 名ではない)は null
 */
export function canonicalTimeZone(tz: string): string | null {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (/^[+-]\d/.test(tz) || /^[+-]\d/.test(resolved)) return null;
  const lower = tz.toLowerCase();
  // 一覧に大文字小文字を無視して一致する名前があれば、その綴り
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone").find((z) => z.toLowerCase() === lower) : undefined;
  if (listed !== undefined) return listed;
  // 一覧に無くても、実行環境が返した名前が大文字小文字だけの違いならその綴り(例: utc → UTC)
  if (resolved.toLowerCase() === lower) return resolved;
  return tz; // 別名は入力のまま
}

/** そのタイムゾーンでの [曜日の添字(0 = 日曜), 時(0〜23)]。タイムゾーンが使えなければ null */
export function weekdayHour(now: number, timeZone: string): [number, number] | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const day = WEEKDAYS.indexOf(get("weekday").slice(0, 3).toLowerCase() as Weekday);
    const hour = Number(get("hour")) % 24;
    return day < 0 || !(hour >= 0) ? null : [day, hour];
  } catch {
    return null;
  }
}

/**
 * 曜日と時間帯の条件。`from` / `to` は "HH:00"(`to` は 24:00 まで)。省略したら終日。
 * `to < from` は日またぎで、**曜日は開始時刻の曜日で数える**: 「時 >= from なら当日の曜日が days に入っているか」または
 * 「時 < to なら前日の曜日が days に入っているか」(例: 金 22:00〜翌 02:00 = 金曜 22:00 から土曜 02:00 まで)。
 * タイムゾーンが使えなければ null(判定できない = 対象外)
 */
export function inTimeWindow(node: { days: readonly string[]; from?: string; to?: string }, now: number, timeZone: string): boolean | null {
  const wh = weekdayHour(now, timeZone);
  if (wh === null) return null;
  const [day, hour] = wh;
  const today = node.days.includes(WEEKDAYS[day]!);
  if (node.from === undefined || node.to === undefined) return today;
  const from = parseInt(node.from, 10);
  const to = parseInt(node.to, 10);
  if (from < to) return today && hour >= from && hour < to;
  return (hour >= from && today) || (hour < to && node.days.includes(WEEKDAYS[(day + 6) % 7]!));
}
