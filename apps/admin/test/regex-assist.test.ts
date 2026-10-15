import { describe, expect, it } from "vitest";
import { applyExample, checkRegex, sampleValue, testRegex } from "../lib/regex-assist";

describe("正規表現の案内(設計書 §10.4)", () => {
  it("問題の箇所・説明・書き換えの例を返す。当てはめて意味が通る例だけ「この形にする」の値を作る", () => {
    const unbounded = checkRegex("^/a{2,}$");
    expect(unbounded).toMatchObject({ issue: { code: "regex_unbounded_repeat", index: 3, length: 4 }, fix: "^/a{2,10}$" });
    expect(checkRegex("^/a{0,500}")?.fix).toBe("^/a*"); // 下限 0 は *
    expect(checkRegex("^/a{1,500}")?.fix).toBe("^/a+"); // 下限 1 は +
    expect(checkRegex("^/a{5,500}")).toMatchObject({ issue: { code: "regex_repeat_too_large" }, fix: null }); // 下限 5 を保つ例は無い(+ にすると意味が変わる)
    expect(checkRegex("^/a}")?.fix).toBe("^/a\\}"); // 1 文字のエスケープ
    expect(checkRegex("(a|)")?.fix).toBeNull(); // 例(a?)は箇所の置き換えにならない
    expect(checkRegex(".{0,100}")).toMatchObject({ issue: { code: "regex_too_large" }, fix: null }); // 式全体の例は文字で見せるだけ
    expect(checkRegex("^/products/\\d+$")).toBeNull();
  });
  it("applyExample は例の無い問題には null", () => {
    expect(applyExample("(", { code: "regex_syntax", message: "", index: 0, length: 1 })).toBeNull();
  });
  it("試す欄は本番と同じ照合器(部分一致・ホストは小文字・パスは 256 字を超えたら判定しない)", () => {
    expect(testRegex("^/products/\\d+$", "path", "/products/123")).toBe("match");
    expect(testRegex("products", "path", "/a/products/b")).toBe("match"); // 部分一致
    expect(testRegex("^/products/\\d+$", "path", "/products/abc")).toBe("nomatch");
    expect(testRegex("^shop\\.", "host", "SHOP.example.com")).toBe("match");
    expect(testRegex("^SHOP", "host", "shop.example.com")).toBe("nomatch"); // 大文字の式は小文字のホストに一致しない
    expect(testRegex("x$", "path", `/${"x".repeat(256)}`)).toBe("skipped");
    expect(testRegex("a{2,}", "path", "/aa")).toBe("invalid");
  });
  it("試す値は本番と同じ pageOf で正規化してから、長さの上限を見て照合する(ホストの末尾のドット・IDN の punycode・パスの percent-encoding)", () => {
    expect(testRegex("^example\\.com$", "host", "EXAMPLE.COM.")).toBe("match");
    expect(testRegex("^xn--r8jz45g\\.jp$", "host", "例え.jp")).toBe("match");
    expect(testRegex("^/%E6%96%99%E9%87%91/$", "path", "/料金/")).toBe("match");
    expect(testRegex("^/", "path", `/${"料".repeat(30)}`)).toBe("skipped"); // 31 字だが、エンコードすると 271 字で 256 字を超える
    expect(sampleValue("host", "EXAMPLE.COM.")).toBe("example.com");
    expect(sampleValue("path", "/料金/")).toBe("/%E6%96%99%E9%87%91/");
  });
});
