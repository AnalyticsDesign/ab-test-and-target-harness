import { describe, expect, it } from "vitest";
import { sha256 } from "../src/sha256";
import { patternIdOf, patternKey } from "../src/pattern-id";

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

describe("sha256(同期。パターン ID 用)", () => {
  it("既知の値", () => {
    expect(hex(sha256(enc("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(enc("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("crypto.subtle と同じ値(0〜200 バイトの乱数と、ブロック境界の 55 / 56 / 63 / 64 / 65 バイト)", async () => {
    const lengths = [...Array.from({ length: 201 }, (_, i) => i), 55, 56, 63, 64, 65, 1000];
    for (const n of lengths) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
      expect(hex(sha256(b))).toBe(hex(expected));
    }
  });
});

describe("パターン ID(設計書 §4.4)", () => {
  it("版の番号付き・既定値(part = url)を省いた入力", () => {
    expect(patternKey({ op: "contains", value: "/pricing/" })).toBe("v1\u0000contains\u0000/pricing/");
    expect(patternKey({ part: "url", op: "contains", value: "/pricing/" })).toBe("v1\u0000contains\u0000/pricing/");
    expect(patternKey({ part: "path", op: "startsWith", value: "/pricing/" })).toBe("v1\u0000part=path\u0000startsWith\u0000/pricing/");
  });
  it("既知の値(plan 作成時に Node の crypto で計算した値。形式を変えたら既存の閲覧回数が数え直しになるので変えない)", () => {
    expect(patternIdOf({ op: "contains", value: "/pricing/" })).toBe("p_KyqD6j9bqVyHr029");
    expect(patternIdOf({ part: "path", op: "startsWith", value: "/pricing/" })).toBe("p_tefN44N7C4lRx4g5");
    expect(patternIdOf({ part: "host", op: "endsWith", value: "example.com" })).toBe("p_iJlsNs9t4aoA852l");
    expect(patternIdOf({ part: "path", op: "regex", value: "^/products/\\d+$" })).toBe("p_WJn881B8eJr47kfG");
  });
  it("値の正規化の後にハッシュする(大文字のホスト・日本語のパス・¥ の正規表現は正規化した値と同じ ID)", () => {
    expect(patternIdOf({ part: "host", op: "endsWith", value: "Example.COM." })).toBe(patternIdOf({ part: "host", op: "endsWith", value: "example.com" }));
    expect(patternIdOf({ part: "path", op: "startsWith", value: "/料金/" })).toBe(patternIdOf({ part: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" }));
    expect(patternIdOf({ part: "path", op: "regex", value: "^/p/¥\d+$" })).toBe(patternIdOf({ part: "path", op: "regex", value: "^/p/\\d+$" }));
  });
  it("一致の仕方が変われば別の ID(= 数え直し)", () => {
    const ids = new Set([
      patternIdOf({ op: "contains", value: "/pricing/" }),
      patternIdOf({ part: "path", op: "contains", value: "/pricing/" }),
      patternIdOf({ op: "startsWith", value: "/pricing/" }),
      patternIdOf({ op: "contains", value: "/pricing" }),
    ]);
    expect(ids.size).toBe(4);
  });
});
