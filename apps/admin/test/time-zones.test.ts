import { describe, expect, it } from "vitest";
import { timeZoneOptions } from "../lib/time-zones";

describe("timeZoneOptions", () => {
  it("今の値を必ず含み、IANA 名の一覧を返す", () => {
    const list = timeZoneOptions("Asia/Tokyo");
    expect(list).toContain("Asia/Tokyo");
    expect(list).toContain("America/New_York");
    expect(timeZoneOptions("Etc/Unknown_For_Test")[0]).toBe("Etc/Unknown_For_Test"); // 一覧に無い値も落とさない(先頭に置く)
  });
});
