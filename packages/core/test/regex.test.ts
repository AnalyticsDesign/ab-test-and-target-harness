import { describe, expect, it } from "vitest";
import { compileRegex, normalizeRegexInput, REGEX_LIMITS } from "../src/regex-compile";
import { isValidProgram, runProgram, type RegexProgram } from "../src/regex-run";

/** 再現できる乱数(線形合同法)。差分テストの失敗を同じ入力で再現するため */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const prog = (src: string): RegexProgram => {
  const r = compileRegex(src);
  if (!r.ok) throw new Error(`${src}: ${r.issue.code}`);
  return r.prog;
};

describe("regex: 照合器と RegExp の差分(設計書 §10.5 R9)", () => {
  it("regex_matcher_agrees_with_regexp_on_small_alphabet", () => {
    const rnd = rng(12345);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    const atom = (d: number): string => {
      const r = rnd();
      if (r < 0.35) return pick(["a", "b", "/", "1", "\\.", "\\-", "\\/"]);
      if (r < 0.45) return ".";
      if (r < 0.55) return pick(["\\d", "\\w", "\\s"]);
      if (r < 0.7) return pick(["[ab]", "[^a]", "[a-c]", "[\\d.]", "[-a]", "[a-]", "[^/]", "[.\\-]", "[0-9a]"]);
      if (r < 0.75) return pick(["^", "$"]);
      if (d > 0) return (rnd() < 0.5 ? "(" : "(?:") + alt(d - 1) + ")";
      return "a";
    };
    const rep = (d: number): string => {
      const a = atom(d);
      if (a === "^" || a === "$" || rnd() < 0.55) return a;
      return a + pick(["*", "+", "?", "{2}", "{0,2}", "{1,3}", "{0}", "{2,2}"]);
    };
    const cat = (d: number): string => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => rep(d)).join("");
    const alt = (d: number): string => Array.from({ length: rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 2) }, () => cat(d)).join("|");
    const input = (): string => Array.from({ length: Math.floor(rnd() * 8) }, () => pick(["a", "b", "/", "1", ".", "-", " ", "c", "\n"])).join("");
    let compared = 0;
    for (let t = 0; t < 20000; t++) {
      const src = alt(2);
      const r = compileRegex(src);
      if (!r.ok) continue;
      const re = new RegExp(src);
      for (let k = 0; k < 20; k++) {
        const s = input();
        expect(runProgram(r.prog, s), `${src} / ${JSON.stringify(s)}`).toBe(re.test(s));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300000);
  });

  it("受理した式は RegExp も受理し、同じ真偽になる(記号を混ぜた乱択)", () => {
    const rnd = rng(777);
    const pool = ["a", "b", "/", "(", ")", "[", "]", "{", "}", "|", "*", "+", "?", "^", "$", ".", "\\", "-", "d", "1", ",", "2", ":"];
    let accepted = 0;
    for (let t = 0; t < 100000; t++) {
      const src = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pool[Math.floor(rnd() * pool.length)]).join("");
      const r = compileRegex(src);
      if (!r.ok) continue;
      accepted++;
      const re = new RegExp(src); // 受理した式が RegExp で構文エラーなら、ここで throw してテストが落ちる
      for (const s of ["", "a", "ab/1", "/a-b.1", "ba{2}", "a,b"]) expect(runProgram(r.prog, s), `${src} / ${s}`).toBe(re.test(s));
    }
    expect(accepted).toBeGreaterThan(10000);
  });

  it.each([
    ["^/products/\\d+/?$", "/products/12", true],
    ["^/products/\\d+/?$", "/products/12/x", false],
    ["pricing", "/jp/pricing/", true], // 部分一致
    ["^pricing", "/jp/pricing/", false],
    ["^$", "", true],
    ["(a|)", "", null], // 拒否(下の表)— ここでは使わない
  ] as const)("固定ケース %s / %s", (src, s, expected) => {
    const r = compileRegex(src);
    if (expected === null) return expect(r.ok).toBe(false);
    expect(r.ok && runProgram(r.prog, s)).toBe(expected);
  });
});

describe("regex: 許可リスト(設計書 §10.2)", () => {
  it.each([
    ["(?=a)", "regex_unsupported_group", 0],
    ["(?<n>a)", "regex_unsupported_group", 0],
    ["(?i:a)", "regex_unsupported_group", 0],
    ["(a)\\1", "regex_unsupported_escape", 3],
    ["\\bpricing", "regex_unsupported_escape", 0],
    ["\\p{L}", "regex_unsupported_escape", 0],
    ["\\D", "regex_unsupported_escape", 0],
    ["a{2,}", "regex_unbounded_repeat", 1],
    ["a*?", "regex_lazy_quantifier", 2],
    ["a+?", "regex_lazy_quantifier", 2],
    ["a{,5}", "regex_ambiguous", 1],
    ["a{", "regex_ambiguous", 1],
    ["a}", "regex_ambiguous", 1],
    ["a]", "regex_ambiguous", 1],
    ["[a-\\d]", "regex_ambiguous", 2],
    ["[\\d-a]", "regex_ambiguous", 3],
    ["[a-c-e]", "regex_ambiguous", 4],
    ["(a|)", "regex_ambiguous", 3],
    ["()", "regex_ambiguous", 0],
    ["[]", "regex_ambiguous", 0],
    ["[^]", "regex_ambiguous", 0],
    ["a{101}", "regex_repeat_too_large", 1],
    ["a{3,2}", "regex_syntax", 1],
    ["a**", "regex_syntax", 2],
    ["^*", "regex_syntax", 1],
    ["*a", "regex_syntax", 0],
    ["(a", "regex_syntax", 0],
    ["a)", "regex_syntax", 1],
    ["[z-a]", "regex_syntax", 1],
    ["a\\", "regex_syntax", 1],
    ["/価格/", "regex_non_ascii", 1],
    ["a\tb", "regex_non_ascii", 1],
  ] as const)("regex_allowlist_rejects_annex_b_ambiguous_syntax: %s -> %s @%d", (src, code, index) => {
    const r = compileRegex(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe(code);
    expect(r.issue.index).toBe(index);
    expect(r.issue.message).toMatch(/[ぁ-んァ-ン一-龠]/); // 日本語の説明
  });

  it.each([
    ["a{0,500}", "*"],
    ["a{1,500}", "+"],
    ["a{5,500}", undefined], // 下限 2 以上は `+` にすると下限が落ちるので例を出さない
    ["a{200}", undefined],
  ] as const)("regex_repeat_too_large_example_keeps_lower_bound: %s -> %s", (src, example) => {
    const r = compileRegex(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("regex_repeat_too_large");
    expect(r.issue.example).toBe(example);
  });

  it("書き換えの例を返す(上限の無い繰り返し・{ のエスケープ)", () => {
    const a = compileRegex("a{2,}");
    expect(!a.ok && a.issue.example).toBe("{2,10}");
    const b = compileRegex("a{");
    expect(!b.ok && b.issue.example).toBe("\\{");
  });

  it.each(["^/products/\\d+/?$", "^/category/(shoes|bags|hats|watches)/page/\\d+$", "[-a]", "[a-]", "[\\.-\\/]", "a{0}", "(?:ab)+", "^/a/[^/]+/b$", "\\$\\^\\|\\(\\)\\[\\]\\{\\}"])("通す形: %s", (src) => {
    const r = compileRegex(src);
    expect(r.ok).toBe(true);
    expect(() => new RegExp(src)).not.toThrow();
  });

  it("式の長さの上限(200 字)", () => {
    expect(compileRegex("[ab]".repeat(50)).ok).toBe(true); // 200 字・50 命令
    const r = compileRegex("[ab]".repeat(50) + "a");
    expect(!r.ok && r.issue.code).toBe("regex_too_long");
  });
});

describe("regex: 命令数", () => {
  it("regex_instruction_budget_is_enforced_per_regex_and_site(1 つ 200 命令。変換の前に見積もって止める)", () => {
    expect(compileRegex("^/products/\\d+/?$")).toMatchObject({ ok: true, instructions: 17 });
    expect(compileRegex(".{0,99}")).toMatchObject({ ok: true, instructions: 199 });
    const over = compileRegex(".{0,100}"); // 200 + MATCH = 201
    expect(!over.ok && over.issue.code).toBe("regex_too_large");
    expect(!over.ok && over.issue.message).toContain("201 / 200");
    // (a{100}){100} は展開すると 10,000 命令。見積もりで止まり、表を作らない(すぐ返る)
    const t0 = performance.now();
    const huge = compileRegex("(a{100}){100}");
    expect(!huge.ok && huge.issue.code).toBe("regex_too_large");
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("同じ文字の集合は 1 つにまとめる", () => {
    expect(prog("\\d\\d\\d").sets).toHaveLength(1);
  });

  it("REGEX_LIMITS の値(設計書 §10.2)", () => {
    expect(REGEX_LIMITS).toEqual({ sourceMax: 200, repeatMax: 100, instructionsPerRegex: 200, instructionsPerSite: 500 });
  });
});

describe("regex: 照合器の守り", () => {
  it("regex_program_invalid_is_failclosed(命令列の整合が取れなければ null)", () => {
    const ok = prog("^/a$");
    expect(runProgram(ok, "/a")).toBe(true);
    const bad: Array<[string, unknown]> = [
      ["版が違う", { ...ok, v: 2 }],
      ["code が 3 の倍数でない", { ...ok, code: [...ok.code, 0] }],
      ["空の code", { ...ok, code: [] }],
      ["未知の命令", { ...ok, code: [9, 0, 0, 5, 0, 0] }],
      ["集合の添字が範囲外", { ...ok, code: [0, 99, 0, 5, 0, 0] }],
      ["飛び先が範囲外", { ...ok, code: [2, 9, 0, 5, 0, 0] }],
      ["SPLIT の 2 つ目の飛び先が範囲外", { ...ok, code: [1, 0, 9, 5, 0, 0] }],
      ["負の数", { ...ok, code: [2, -1, 0, 5, 0, 0] }],
      ["小数", { ...ok, code: [2, 0.5, 0, 5, 0, 0] }],
      ["集合の語が 4 つでない", { ...ok, sets: [[0, 0, 0]] }],
      ["集合の語が 32 bit を超える", { ...ok, sets: [[2 ** 32, 0, 0, 0]] }],
      ["命令数の上限を超える", { ...ok, code: Array.from({ length: 201 * 3 }, (_, k) => (k % 3 === 0 ? 5 : 0)) }],
      ["BOL だけ(次の命令が無い)", { v: 1, sets: [], code: [3, 0, 0] }],
      ["末尾が CHAR(次の命令が無い)", { v: 1, sets: [[0, 0, 0, 0]], code: [0, 0, 0] }],
      ["末尾が EOL(次の命令が無い)", { v: 1, sets: [], code: [4, 0, 0] }],
      ["null", null],
    ];
    for (const [why, p] of bad) {
      expect(isValidProgram(p as RegexProgram), why).toBe(false);
      // 止まらずに null を返す(次へ進む命令で終わる命令列も、命令列の外へ出ない)
      for (const s of ["/a", "", "a"]) expect(runProgram(p as RegexProgram, s), `${why} / ${JSON.stringify(s)}`).toBeNull();
    }
  });

  it("ジャンプだけの輪でも止まる(世代番号で同じ状態を 2 度たどらない)", () => {
    // 0: JMP 1 / 1: JMP 0 / 2: MATCH — MATCH に届かない輪
    expect(runProgram({ v: 1, sets: [], code: [2, 1, 0, 2, 0, 0, 5, 0, 0] }, "abc")).toBe(false);
  });

  it("ASCII 以外の文字を含む入力は判定しない(null)", () => {
    expect(runProgram(prog("a"), "aあ")).toBe(null);
  });

  it("時間は入力の長さ × 命令数に比例する(以前の重い形も 256 字で 50 ms 未満)", () => {
    // 実時間は CI で揺れるので、桁が変わる退行だけを止める粗い防波堤。正確な測定は Task 10
    const input = "/" + "a".repeat(255);
    for (const src of [".*a*b", ".*(a|aa|aaa)*b", "(a?){60}a{60}", "[a-z]{1,49}[a-z]{1,49}9", "(a|aa|aaa|aaaa|aaaaa|aaaaaa|aaaaaaa|aaaaaaaa|aaaaaaaaa)*b"]) {
      const p = prog(src);
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) runProgram(p, input);
      expect((performance.now() - t0) / 20, src).toBeLessThan(50);
    }
  });
});

describe("regex: 入力の正規化(設計書 §10.4 の 4)", () => {
  it("¥ ・ ￥ を \\ に、全角の英数字・記号・スペースを半角に置き換える", () => {
    expect(normalizeRegexInput("^/products/¥d+$")).toBe("^/products/\\d+$");
    expect(normalizeRegexInput("^/products/￥d＋＄")).toBe("^/products/\\d+$");
    expect(normalizeRegexInput("ａ　ｂ")).toBe("a b");
    expect(normalizeRegexInput("/価格/")).toBe("/価格/"); // 漢字はそのまま(検査で regex_non_ascii)
  });
  it("置き換えた後は \\ で書いたときと同じ検査と照合になる", () => {
    const a = compileRegex(normalizeRegexInput("^/p/¥d+$"));
    const b = compileRegex("^/p/\\d+$");
    expect(a).toEqual(b);
  });
});
