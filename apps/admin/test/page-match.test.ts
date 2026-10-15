import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_MATCH, describePageMatch, hostRegexHasUppercase, normalizeRegexValue, previewPageUrl, withPart } from "../lib/page-match";

describe("page-match(対象 URL・目標の PAGEVIEW の入力欄)", () => {
  it("既定はパスで始まる", () => {
    expect(DEFAULT_PAGE_MATCH).toEqual({ part: "path", op: "startsWith", value: "" });
  });
  it("part を変えると、使えない一致の仕方はその part の既定にする(URL に正規表現は無い)", () => {
    expect(withPart({ part: "path", op: "regex", value: "^/a" }, "url")).toEqual({ part: "url", op: "contains", value: "^/a" });
    expect(withPart({ part: "path", op: "startsWith", value: "/a" }, "host")).toEqual({ part: "host", op: "equals", value: "/a" });
    expect(withPart({ part: "host", op: "contains", value: "a" }, "path")).toEqual({ part: "path", op: "contains", value: "a" });
  });
  it("describePageMatch(part 省略 = URL)", () => {
    expect(describePageMatch({ part: "path", op: "startsWith", value: "/lp/" })).toBe("パス が「/lp/」で始まる");
    expect(describePageMatch({ op: "contains", value: "/lp/" })).toBe("URL が「/lp/」を含む");
    expect(describePageMatch({ part: "host", op: "endsWith", value: "example.com" })).toBe("ホスト が「example.com」で終わる(サブドメインを含む)");
    expect(describePageMatch({ op: "regex", value: "a" })).toBe("URL が「a」regex"); // v0.9 から残った URL 全体の正規表現(Publish で止まる)
  });
  it("previewPageUrl はパスと URL の完全一致 / で始まるだけ", () => {
    expect(previewPageUrl("www.example.com", { part: "path", op: "startsWith", value: "/lp/" })).toBe("https://www.example.com/lp/");
    expect(previewPageUrl("www.example.com", { op: "equals", value: "https://www.example.com/x" })).toBe("https://www.example.com/x");
    expect(previewPageUrl("www.example.com", { op: "startsWith", value: "/lp/" })).toBeNull(); // URL の値がパスだけ = 今の判定では一致しない
    expect(previewPageUrl("www.example.com", { part: "path", op: "regex", value: "^/lp/" })).toBeNull();
    expect(previewPageUrl("www.example.com", { part: "host", op: "equals", value: "www.example.com" })).toBeNull();
  });
  it("正規表現の値は ¥ と全角を core と同じ関数で置き換え、置き換えたことを返す(通知を出す。設計書 §10.4 の 4 / §15 の入力の正規化の admin の部分)", () => {
    expect(normalizeRegexValue({ part: "path", op: "regex", value: "^/p/¥d＋$" })).toEqual({ value: { part: "path", op: "regex", value: "^/p/\\d+$" }, replaced: true });
    expect(normalizeRegexValue({ part: "path", op: "regex", value: "^/p/\\d+$" }).replaced).toBe(false);
    expect(normalizeRegexValue({ part: "path", op: "startsWith", value: "/¥" })).toEqual({ value: { part: "path", op: "startsWith", value: "/¥" }, replaced: false }); // 正規表現でなければそのまま
  });
  it("host_regex_with_uppercase_shows_lowercase_notice(設計書 §4.1.2 (c): ホストの正規表現に大文字があれば案内する。値は変えず、保存も止めない)", () => {
    expect(hostRegexHasUppercase({ part: "host", op: "regex", value: "^SHOP\\." })).toBe(true);
    expect(hostRegexHasUppercase({ part: "host", op: "regex", value: "^shop\\." })).toBe(false);
    expect(hostRegexHasUppercase({ part: "path", op: "regex", value: "^/LP/" })).toBe(false); // パスは大文字と小文字を区別して照合する(案内しない)
    expect(hostRegexHasUppercase({ part: "host", op: "equals", value: "SHOP.example.com" })).toBe(false); // 正規表現でなければ保存時に小文字化される
    expect(normalizeRegexValue({ part: "host", op: "regex", value: "^SHOP\\." }).value.value).toBe("^SHOP\\."); // 値はそのまま
  });
});
