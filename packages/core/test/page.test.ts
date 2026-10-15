import { describe, expect, it } from "vitest";
import { matchPage, matchesUrl, pageOf } from "../src/page";
import { normalizeHostValue, normalizePageMatch, normalizePathValue, pageMatchIssue } from "../src/page-normalize";
import { compileRegex } from "../src/regex-compile";

const prog = (src: string) => {
  const r = compileRegex(src);
  if (!r.ok) throw new Error(r.issue.code);
  return r.prog;
};

describe("pageOf: 照合する値(設計書 §4.1.2 (a))", () => {
  it.each([
    ["https://example.com/a?b=1", "example.com", "/a"],
    ["https://shop.example.com/", "shop.example.com", "/"],
    ["https://EXAMPLE.com:8443/A/", "example.com", "/A/"], // ホストは小文字・ポートを含まない。パスはそのまま
    ["https://example.com./x", "example.com", "/x"], // 末尾ドット
    ["https://例え.jp/料金", "xn--r8jz45g.jp", "/%E6%96%99%E9%87%91"], // IDN は punycode、パスは percent-encoding のまま
  ])("%s → host %s / path %s", (url, host, path) => {
    expect(pageOf(url)).toEqual({ url, host, path });
  });
  it("URL を解析できなければ host / path は null", () => {
    expect(pageOf("/relative")).toEqual({ url: "/relative", host: null, path: null });
  });
});

describe("matchPage", () => {
  const page = pageOf("https://shop.example.com/products/12?x=1");
  it("で終わる(サブドメインを含む)はラベル境界: apex・サブドメインは一致、badexample.com は一致しない", () => {
    expect(matchPage({ part: "host", op: "endsWith", value: "example.com" }, pageOf("https://example.com/"))).toBe(true);
    expect(matchPage({ part: "host", op: "endsWith", value: "example.com" }, page)).toBe(true);
    expect(matchPage({ part: "host", op: "endsWith", value: "example.com" }, pageOf("https://badexample.com/"))).toBe(false);
  });
  it("正規表現は命令列で照合(部分一致)", () => {
    expect(matchPage({ part: "path", op: "regex", value: "^/products/\\d+$", prog: prog("^/products/\\d+$") }, page)).toBe(true);
    expect(matchPage({ part: "path", op: "regex", value: "\\d", prog: prog("\\d") }, page)).toBe(true);
  });
  it("op regex without prog is null (never falls back to RegExp)", () => {
    // 版 1 の legacy(RegExp へのフォールバック)は backlog B52 で削除した。命令列が無ければ、値が正しい式でも・不正な式でも判定できない(null)
    expect(matchPage({ part: "path", op: "regex", value: "x" }, page)).toBeNull();
    expect(matchPage({ part: "path", op: "regex", value: "/products/\\d+" }, page)).toBeNull();
    expect(matchPage({ op: "regex", value: "x=1$" }, page)).toBeNull(); // url の regex は版 2 に無い(命令列も無い)
    expect(matchPage({ op: "regex", value: "(" }, page)).toBeNull();
    expect(matchPage({ op: "regex", value: "x=1$", legacy: true } as unknown as Parameters<typeof matchPage>[0], page)).toBeNull(); // 残った印を付けても RegExp に落ちない
  });
  it("ホストの正規表現は 253 字、パスは 256 字を超えたら判定しない", () => {
    const long = pageOf(`https://a.example/${"a".repeat(300)}`);
    expect(matchPage({ part: "path", op: "regex", value: "a", prog: prog("a") }, long)).toBeNull();
    expect(matchPage({ part: "path", op: "contains", value: "a" }, long)).toBe(true);
  });
  it("matchesUrl は true のときだけ一致", () => {
    expect(matchesUrl("not a url", { part: "path", op: "contains", value: "/" })).toBe(false);
    expect(matchesUrl("https://a.example/lp/", { op: "contains", value: "/lp/" })).toBe(true);
  });
});

describe("保存する値の正規化(設計書 §4.1.2 (b)(c))", () => {
  it("ホスト: 小文字化・前後の空白・末尾ドット・IDN を punycode", () => {
    expect(normalizeHostValue(" Shop.Example.COM. ")).toBe("shop.example.com");
    expect(normalizeHostValue("例え.jp")).toBe("xn--r8jz45g.jp");
  });
  it("パス: 日本語と、pathname がエンコードする記号を %XX(大文字)に。% はそのまま", () => {
    expect(normalizePathValue("/料金/")).toBe("/%E6%96%99%E9%87%91/");
    expect(normalizePathValue("/a b/\"x\"/{y}")).toBe("/a%20b/%22x%22/%7By%7D");
    expect(normalizePathValue("/%E6%96%99/")).toBe("/%E6%96%99/");
    expect(pageOf("https://a.example/a b/\"x\"/{y}").path).toBe(normalizePathValue("/a b/\"x\"/{y}")); // URL の解析と同じ形
  });
  it("正規表現は円記号と全角の置き換えだけ(小文字化・エンコードしない)。part: url は省く", () => {
    expect(normalizePageMatch({ part: "host", op: "regex", value: "^Shop¥." })).toEqual({ part: "host", op: "regex", value: "^Shop\\." });
    expect(normalizePageMatch({ part: "url", op: "contains", value: "/A/" })).toEqual({ op: "contains", value: "/A/" });
    expect(normalizePageMatch({ part: "host", op: "equals", value: "A.example." })).toEqual({ part: "host", op: "equals", value: "a.example" });
  });
});

describe("pageMatchIssue", () => {
  it("url の正規表現は regex_not_allowed_on_url(書き換えの例つき)", () => {
    const issue = pageMatchIssue({ op: "regex", value: "a" });
    expect(issue?.code).toBe("regex_not_allowed_on_url");
    expect(issue?.example).toContain('"part": "path"');
  });
  it("path / host の正規表現は許可リストで検査する。文字列の一致は検査しない", () => {
    expect(pageMatchIssue({ part: "path", op: "regex", value: "a{2,}" })?.code).toBe("regex_unbounded_repeat");
    expect(pageMatchIssue({ part: "host", op: "regex", value: "^shop\\." })).toBeNull();
    expect(pageMatchIssue({ op: "contains", value: "(" })).toBeNull();
  });
});
