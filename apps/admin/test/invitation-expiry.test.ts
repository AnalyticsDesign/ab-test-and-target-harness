import { describe, expect, it } from "vitest";
import { expiryLabel } from "@/lib/invitation-expiry";

describe("expiryLabel", () => {
  const HOUR = 3_600_000;
  it("counts days and the leftover hours once a day or more is left", () => {
    expect(expiryLabel(7 * 24 * HOUR, 0)).toBe("あと 7 日"); // 時間の端数が無ければ日だけ
    expect(expiryLabel(24 * HOUR, 0)).toBe("あと 1 日"); // ちょうど 24 時間
    expect(expiryLabel(7 * 24 * HOUR - 1, 0)).toBe("あと 6 日 23 時間"); // 発行直後の招待
    expect(expiryLabel(48 * HOUR - 1, 0)).toBe("あと 1 日 23 時間"); // 端数は切り捨て
    expect(expiryLabel(25 * HOUR, 0)).toBe("あと 1 日 1 時間");
  });
  it("counts whole hours below a day and warns when less than an hour is left", () => {
    expect(expiryLabel(24 * HOUR - 1, 0)).toBe("あと 23 時間");
    expect(expiryLabel(HOUR, 0)).toBe("あと 1 時間"); // ちょうど 1 時間
    expect(expiryLabel(HOUR - 1, 0)).toBe("あと 1 時間未満");
    expect(expiryLabel(1, 0)).toBe("あと 1 時間未満");
  });
  it("says expired at and past the deadline", () => {
    expect(expiryLabel(0, 0)).toBe("期限切れ");
    expect(expiryLabel(-1, 0)).toBe("期限切れ");
    expect(expiryLabel(1_000, 2_000)).toBe("期限切れ");
  });
});
