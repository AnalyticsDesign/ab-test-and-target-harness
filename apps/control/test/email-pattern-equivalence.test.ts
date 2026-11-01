import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * zod 4.6 で z.email() の正規表現の書き方が変わり(先読みを使わない形)、契約の基準 test/contract/v2.json の
 * email の pattern 4 か所を手で置き換えた(docs/dev/compatibility_rules.md「手で直したら diff のレビューで見る」)。
 * 基準の比較は pattern の文字列の変更を互換を外す変更と数えるので、受け付ける値が前の版と同じことをここで固める。
 * 次に zod を上げて z.regexes.email がまた変わったら、このテストが先に落ちる。
 */

// zod 4.5 まで(基準 v2.json の元の pattern)
const OLD = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const NEW = z.regexes.email;

/** 決まった種の擬似乱数(mulberry32)。落ちたときに同じ入力で再現できるように */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("email の pattern(zod 4.5 → 4.6)", () => {
  it("今の zod の email の正規表現は、基準 v2.json に書いた文字列と同じ", () => {
    expect(NEW.source).toBe("^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$");
  });

  it.each([
    ["ふつうのアドレス", "user@example.com", true],
    ["点を含むローカル部", "first.last@example.co.jp", true],
    ["' と + を含む", "o'neil+tag@example.com", true],
    ["先頭の点", ".user@example.com", false],
    ["連続の点", "us..er@example.com", false],
    ["ローカル部の末尾の点", "user.@example.com", false],
    ["ローカル部の末尾の '", "user'@example.com", false],
    ["' だけのローカル部", "'@example.com", false],
    ["ドメインの連続の点", "user@example..com", false],
    ["トップレベルが 1 文字", "user@example.c", false],
    ["@ が無い", "user.example.com", false],
  ])("%s: 前と後で判定が同じ(%s)", (_label, input, expected) => {
    expect(OLD.test(input)).toBe(expected);
    expect(NEW.test(input)).toBe(expected);
  });

  it("決まった種の無作為な入力で、前と後の判定が食い違わない", () => {
    const next = rng(20261101);
    const alphabet = "ab1._'+-@.";
    const diffs: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      let s = "";
      const len = 1 + Math.floor(next() * 12);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(next() * alphabet.length)];
      if (next() < 0.5) s += "@ex.com";
      if (OLD.test(s) !== NEW.test(s)) diffs.push(s);
    }
    expect(diffs.slice(0, 5)).toEqual([]);
  });
});
