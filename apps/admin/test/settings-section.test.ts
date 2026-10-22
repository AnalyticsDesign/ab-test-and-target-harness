import { describe, expect, it } from "vitest";
import { readSection, sectionOfHref } from "@/lib/settings-section";

// B60 Task 3: サイト設定の節の状態(store)のうち、URL を読む純粋な関数
describe("settings section store helpers (B60)", () => {
  it("read_section_falls_back_to_general", () => {
    expect(readSection("")).toBe("general");
    expect(readSection("?section=tag")).toBe("tag");
    expect(readSection("?section=bogus")).toBe("general");
    expect(readSection("?section=tag&section=naming")).toBe("tag"); // 重なったら先頭
  });
  it("section_of_href_same_settings_page_only", () => {
    const here = "/w/a/sites/s/settings";
    expect(sectionOfHref("/w/a/sites/s/settings?section=tag", here)).toBe("tag");
    expect(sectionOfHref("/w/a/sites/s/settings", here)).toBe("general");
    expect(sectionOfHref("/w/a/sites/s2/settings?section=tag", here)).toBeNull();
    expect(sectionOfHref("/w/a/members", here)).toBeNull();
  });
});
