import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_MATCH, describePageMatch, hostRegexHasUppercase, normalizeRegexValue, previewPageUrl, withPart } from "../lib/page-match";
import type { UrlMatchValue } from "../lib/url-match";

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
  it("previewPageUrl はパスと URL の完全一致 / で始まるだけ(含めるの最初の組み立てられる行から作る)", () => {
    const one = (page: { part?: "url" | "path" | "host"; op: string; value: string }): UrlMatchValue => ({ include: [{ page }] });
    expect(previewPageUrl("www.example.com", one({ part: "path", op: "startsWith", value: "/lp/" }))).toBe("https://www.example.com/lp/");
    expect(previewPageUrl("www.example.com", one({ op: "equals", value: "https://www.example.com/x" }))).toBe("https://www.example.com/x");
    expect(previewPageUrl("www.example.com", one({ op: "startsWith", value: "/lp/" }))).toBeNull(); // URL の値がパスだけ = 今の判定では一致しない
    expect(previewPageUrl("www.example.com", one({ part: "path", op: "regex", value: "^/lp/" }))).toBeNull();
    expect(previewPageUrl("www.example.com", one({ part: "host", op: "equals", value: "www.example.com" }))).toBeNull();
  });
  it("previewPageUrl は組み立てられない行を飛ばし、パラメータの「次に一致」をクエリに足す(除くの行は使わない)", () => {
    const m: UrlMatchValue = {
      include: [
        { page: { part: "path", op: "regex", value: "^/a" } },
        { page: { part: "path", op: "equals", value: "/lp/" }, params: [{ name: "utm_source", op: "equals", value: "news letter" }, { name: "ref", op: "exists" }, { name: "c", op: "contains", value: "x" }] },
      ],
      exclude: [{ page: { part: "path", op: "equals", value: "/x/" } }],
    };
    expect(previewPageUrl("www.example.com", m)).toBe("https://www.example.com/lp/?utm_source=news+letter");
    expect(previewPageUrl("www.example.com", { include: [{ page: { op: "equals", value: "https://www.example.com/?a=1" }, params: [{ name: "b", op: "equals", value: "" }] }] })).toBe("https://www.example.com/?a=1&b=");
    expect(previewPageUrl("www.example.com", { include: [{ page: { part: "host", op: "equals", value: "x" } }] })).toBeNull();
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
  // B69 追補 §4: and を持つ行は、ページの条件(page と and)から URL を組み立て、その URL が条件に一致するときだけ使う
  describe("previewPageUrl(and を持つ行)", () => {
    const host = (value: string, op = "equals") => ({ part: "host" as const, op, value });
    const path = (value: string, op = "startsWith") => ({ part: "path" as const, op, value });
    it("preview_composes_host_and_path: ホストとパスを組み合わせる(パスは完全一致を優先)", () => {
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/")] }] })).toBe("https://shop.example.com/sale/");
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/"), path("/sale/1", "equals")] }] })).toBe("https://shop.example.com/sale/1");
      // ホストが無ければサイトのドメイン。パラメータの「次に一致」は今と同じくクエリに足す
      expect(previewPageUrl("www.example.com", { include: [{ page: path("/sale/"), and: [host("example.com", "endsWith")], params: [{ name: "a", op: "equals", value: "1" }] }] })).toBe("https://www.example.com/sale/?a=1");
      // パスが「を含む」だけでは組み立てられない
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/", "contains")] }] })).toBeNull();
      // URL の完全一致 / で始まるがあれば、それを使う
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [{ op: "startsWith", value: "https://shop.example.com/x/" }] }] })).toBe("https://shop.example.com/x/");
    });
    it("preview_skips_row_when_built_url_does_not_match: 組み立てた URL が行に一致しなければ次の行へ", () => {
      const bad = { page: path("/sale/"), and: [host("other.example", "endsWith")] };
      expect(previewPageUrl("www.example.com", { include: [bad] })).toBeNull();
      expect(previewPageUrl("www.example.com", { include: [bad, { page: path("/lp/") }] })).toBe("https://www.example.com/lp/");
    });
    it("preview_compiles_regex_before_check: 正規表現は命令列にしてから確かめる。コンパイルできない行は飛ばす", () => {
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/"), path("^/sale/[0-9]+", "regex")] }] })).toBeNull();
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/1", "equals"), path("^/sale/[0-9]+", "regex")] }] })).toBe("https://shop.example.com/sale/1");
      expect(previewPageUrl("www.example.com", { include: [{ page: host("shop.example.com"), and: [path("/sale/1", "equals"), path("a{2,}", "regex")] }, { page: path("/lp/") }] })).toBe("https://www.example.com/lp/");
    });
    it("preview_normalizes_before_check: 入力の途中の大文字のホストでも出る", () => {
      expect(previewPageUrl("www.example.com", { include: [{ page: host("Shop.Example.com"), and: [path("/sale/")] }] })).toBe("https://shop.example.com/sale/");
    });
    // 最終検査(FR-Medium-1): パラメータを足した後の URL で page と and を確かめる(パラメータの条件そのものは確かめない)
    it("preview_checks_final_url_after_params: クエリを足すと page / and に外れる行は飛ばす(例 1)", () => {
      const params = [{ name: "a", op: "equals" as const, value: "1" }];
      const row = { page: { part: "url" as const, op: "equals", value: "https://www.example.com/sale/" }, and: [host("www.example.com")], params };
      expect(previewPageUrl("www.example.com", { include: [row] })).toBeNull();
      // 次の行があればそちらへ進む
      expect(previewPageUrl("www.example.com", { include: [row, { page: path("/lp/") }] })).toBe("https://www.example.com/lp/");
      // params が無ければ今までどおり(URL の完全一致に一致する)
      expect(previewPageUrl("www.example.com", { include: [{ ...row, params: undefined }] })).toBe("https://www.example.com/sale/");
    });
    it("preview_checks_final_url_after_params: クエリを足した URL が and に一致するなら出す(例 2)", () => {
      const params = [{ name: "a", op: "equals" as const, value: "1" }];
      const row = { page: path("/sale/"), and: [{ part: "url" as const, op: "contains", value: "?a=1" }], params };
      expect(previewPageUrl("www.example.com", { include: [row] })).toBe("https://www.example.com/sale/?a=1");
    });
  });
});
