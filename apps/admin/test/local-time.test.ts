import { describe, expect, it } from "vitest";
import { formatLocalTime } from "@/lib/local-time";

describe("formatLocalTime (B44)", () => {
  const at = Date.UTC(2026, 9, 6, 3, 4, 5); // 2026-10-06 03:04:05 UTC = 12:04:05 JST
  it("datetime = the same text as toLocaleString('ja-JP') in the viewer's time zone", () => {
    expect(formatLocalTime(at, "datetime", "Asia/Tokyo")).toBe("2026/10/6 12:04:05");
    expect(formatLocalTime(at, "datetime", "UTC")).toBe("2026/10/6 3:04:05");
  });
  it("date = the same text as toLocaleDateString('ja-JP')", () => {
    expect(formatLocalTime(at, "date", "Asia/Tokyo")).toBe("2026/10/6");
  });
  it("deadline = month/day hour:minute (the API key expiry and invitation formats)", () => {
    expect(formatLocalTime(at, "deadline", "Asia/Tokyo")).toBe("10/6 12:04");
  });
  it("time = hour:minute only (the usage reset and projection)", () => {
    expect(formatLocalTime(Date.UTC(2026, 9, 6, 0, 0), "time", "Asia/Tokyo")).toBe("09:00");
  });
});
