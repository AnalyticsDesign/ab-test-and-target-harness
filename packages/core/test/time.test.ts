import { describe, expect, it } from "vitest";
import { canonicalTimeZone, inTimeWindow, isValidTimeZone, weekdayHour } from "../src/time";

// 2026-10-09 は金曜日
const jst = (day: number, hour: number) => Date.UTC(2026, 9, day, hour - 9, 0); // JST の day 日 hour 時

describe("曜日・時間帯(設計書 §8)", () => {
  it("weekdayHour はサイトのタイムゾーンでの曜日と時", () => {
    expect(weekdayHour(jst(9, 22), "Asia/Tokyo")).toEqual([5, 22]); // 金 22 時
    expect(weekdayHour(jst(9, 22), "UTC")).toEqual([5, 13]);
    expect(weekdayHour(jst(10, 0), "Asia/Tokyo")).toEqual([6, 0]); // 土 0 時(24 にならない)
    expect(weekdayHour(jst(9, 22), "No/Such_Zone")).toBeNull();
  });
  it("isValidTimeZone", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
  it("終日(from / to なし)と、ふつうの範囲(開始を含み終了を含まない)", () => {
    const tz = "Asia/Tokyo";
    expect(inTimeWindow({ days: ["fri"] }, jst(9, 23), tz)).toBe(true);
    expect(inTimeWindow({ days: ["fri"] }, jst(10, 0), tz)).toBe(false);
    const biz = { days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" };
    expect(inTimeWindow(biz, jst(9, 9), tz)).toBe(true);
    expect(inTimeWindow(biz, jst(9, 8), tz)).toBe(false);
    expect(inTimeWindow(biz, jst(9, 17), tz)).toBe(true);
    expect(inTimeWindow(biz, jst(9, 18), tz)).toBe(false);
    expect(inTimeWindow(biz, jst(10, 10), tz)).toBe(false); // 土曜
    expect(inTimeWindow({ days: ["sat"], from: "00:00", to: "24:00" }, jst(10, 23), tz)).toBe(true);
  });
  it("日をまたぐ範囲は開始時刻の曜日で数える(金 22:00〜翌 02:00 = 金曜 22:00 から土曜 02:00 まで)", () => {
    const tz = "Asia/Tokyo";
    const night = { days: ["fri"], from: "22:00", to: "02:00" };
    expect(inTimeWindow(night, jst(9, 21), tz)).toBe(false);
    expect(inTimeWindow(night, jst(9, 22), tz)).toBe(true); // 金 22 時
    expect(inTimeWindow(night, jst(10, 1), tz)).toBe(true); // 土 1 時(前日 = 金曜)
    expect(inTimeWindow(night, jst(10, 2), tz)).toBe(false); // 土 2 時
    expect(inTimeWindow(night, jst(8, 23), tz)).toBe(false); // 木 23 時
    expect(inTimeWindow(night, jst(9, 1), tz)).toBe(false); // 金 1 時(前日 = 木曜)
    expect(inTimeWindow({ days: ["sun"], from: "23:00", to: "01:00" }, jst(12, 0), tz)).toBe(true); // 月 0 時(前日 = 日曜。週の繰り越し)
  });
  it("タイムゾーンが使えなければ null", () => {
    expect(inTimeWindow({ days: ["fri"] }, jst(9, 10), "Bad/Zone")).toBeNull();
  });
});

describe("タイムゾーンの綴り(保存時にそろえる。plan ② P14)", () => {
  it("大文字小文字だけを一覧の綴りにそろえ、別名は置き換えない。オフセット形式と使えない名前は null", () => {
    // 期待値は Node 24 での実測と、どの環境でも同じ結果になる値(別名の正規名は ICU の版で変わるので置き換えない)
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata"); // Node 24 の resolvedOptions は Asia/Calcutta を返す
    expect(canonicalTimeZone("Europe/Kyiv")).toBe("Europe/Kyiv");
    expect(canonicalTimeZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Etc/UTC")).toBe("Etc/UTC");
    expect(canonicalTimeZone("+09:00")).toBeNull();
    expect(canonicalTimeZone("Nope/Zone")).toBeNull();
  });
});
