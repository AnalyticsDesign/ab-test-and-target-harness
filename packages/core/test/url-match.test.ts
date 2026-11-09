import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalUrlMatch, isOldUrlMatch, normalizeUrlMatch, urlMatchIssue, type UrlMatchInput } from "../src/url-match";
import { CompiledUrlMatchSchema, LIMITS, UrlMatchInputSchema } from "../src/schema";
import { compileRegex } from "../src/regex-compile";
import { pageMatchIssue } from "../src/page-normalize";

// B69 追補(追 §5): 保存の検査が正規表現を 1 回だけコンパイルすることを数えるため、compileRegex を素通しの spy で包む
vi.mock("../src/regex-compile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/regex-compile")>();
  return { ...mod, compileRegex: vi.fn(mod.compileRegex) };
});

const row = { page: { part: "path", op: "startsWith", value: "/lp/" } } as const;
const rows = (n: number) => Array.from({ length: n }, () => row);
const ok = (m: unknown) => UrlMatchInputSchema.safeParse(m).success;
const withParams = (n: number) => ({ include: [{ ...row, params: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, op: "exists" })) }] });

describe("対象 URL の保存の形", () => {
  it("url_match_input_limits", () => {
    expect(ok({ include: rows(1) })).toBe(true);
    expect(ok({ include: rows(10), exclude: rows(10) })).toBe(true);
    expect(ok({ include: [] })).toBe(false); // 含めるは 1 行以上
    expect(ok({ include: rows(11) })).toBe(false);
    expect(ok({ include: rows(1), exclude: rows(11) })).toBe(false);
    expect(ok(withParams(5))).toBe(true);
    expect(ok(withParams(6))).toBe(false);
    const p = (x: object) => ({ include: [{ ...row, params: [x] }] });
    expect(ok(p({ name: "a".repeat(256), op: "exists" }))).toBe(true);
    expect(ok(p({ name: "a".repeat(257), op: "exists" }))).toBe(false);
    expect(ok(p({ name: "", op: "exists" }))).toBe(false);
    expect(ok(p({ name: "a", op: "contains", value: "" }))).toBe(false); // contains の値は 1 字以上
    expect(ok(p({ name: "a", op: "equals", value: "" }))).toBe(true); // equals は空文字可(?a= に一致)
    expect(ok(p({ name: "a", op: "exists", value: "x" }))).toBe(false); // strict
    expect(ok({ include: rows(1), extra: 1 })).toBe(false);
    expect(ok({ op: "contains", value: "/" })).toBe(false); // 古い形
  });

  it("配る形の行の page は CompiledPageMatchSchema(正規表現は prog を持つ)", () => {
    const c = compileRegex("^/a$");
    if (!c.ok) throw new Error("compile");
    const good = { include: [{ page: { part: "path", op: "regex", value: "^/a$", prog: c.prog }, params: [{ name: "a", op: "exists" }] }] };
    expect(CompiledUrlMatchSchema.safeParse(good).success).toBe(true);
    expect(CompiledUrlMatchSchema.safeParse({ include: [{ page: { part: "path", op: "regex", value: "^/a$" } }] }).success).toBe(false); // prog が無い
    expect(CompiledUrlMatchSchema.safeParse({ include: [] }).success).toBe(false);
  });

  it("normalizeUrlMatch: page を正規化し、空の exclude・params を省く。順は変えない", () => {
    const m: UrlMatchInput = {
      include: [{ page: { part: "host", op: "equals", value: " Shop.Example.COM. " }, params: [] }, row],
      exclude: [],
    };
    expect(normalizeUrlMatch(m)).toEqual({ include: [{ page: { part: "host", op: "equals", value: "shop.example.com" } }, row] });
    const withP: UrlMatchInput = { include: [{ ...row, params: [{ name: " A ", op: "equals", value: " x " }] }] };
    expect(normalizeUrlMatch(withP)).toEqual(withP); // パラメータの name・value は変えない
  });

  it("url_match_instruction_budget", () => {
    // `^/[a-z]{k}$` の命令数を実際にコンパイルして確かめ、20 行(含める 10 + 除く 10)の合計を 500 ちょうど / 501 にする
    const re = (k: number) => ({ page: { part: "path" as const, op: "regex" as const, value: `^/[a-z]{${k}}$` } });
    const size = (k: number) => {
      const r = compileRegex(re(k).page.value);
      if (!r.ok) throw new Error("compile");
      return r.instructions;
    };
    const k = 21;
    expect(size(k)).toBe(25);
    expect(size(k + 1)).toBe(26);
    const twenty = (r: ReturnType<typeof re>, last: ReturnType<typeof re>): UrlMatchInput => ({
      include: Array.from({ length: 10 }, () => r),
      exclude: [...Array.from({ length: 9 }, () => r), last],
    });
    expect(urlMatchIssue(twenty(re(k), re(k)))).toBeNull(); // 25 × 20 = 500
    expect(urlMatchIssue(twenty(re(k), re(k + 1)))?.code).toBe("url_match_too_large"); // 501
  });

  it("url_match_row_issue: url の正規表現・不正な式は行の位置を付けて返す", () => {
    const bad = urlMatchIssue({ include: [row, { page: { op: "regex", value: "^/a" } }] });
    expect(bad?.code).toBe("regex_not_allowed_on_url");
    expect(bad?.path).toEqual(["include", 1, "page", "value"]);
    const badEx = urlMatchIssue({ include: [row], exclude: [{ page: { part: "path", op: "regex", value: "(" } }] });
    expect(badEx?.path).toEqual(["exclude", 0, "page", "value"]);
    expect(badEx?.hint === undefined || typeof badEx.hint === "string").toBe(true);
    expect(urlMatchIssue({ include: [row] })).toBeNull();
  });
});

describe("canonicalUrlMatch", () => {
  const a = { page: { part: "path", op: "startsWith", value: "/a/" } } as const;
  const b = { page: { part: "host", op: "equals", value: "x.example" }, params: [{ name: "p", op: "exists" }, { name: "q", op: "equals", value: "1" }] } as const;
  it("canonical_url_match_order_free", () => {
    const base = canonicalUrlMatch({ include: [a, b], exclude: [a, b] });
    expect(canonicalUrlMatch({ include: [b, a], exclude: [b, a] })).toBe(base); // 行の順
    const swapped = { ...b, params: [b.params[1], b.params[0]] };
    expect(canonicalUrlMatch({ include: [a, swapped], exclude: [a, b] })).toBe(base); // パラメータの順
    expect(canonicalUrlMatch({ include: [{ page: { value: "/a/", op: "startsWith", part: "path" } }, b], exclude: [a, b] })).toBe(base); // キーの順
    expect(canonicalUrlMatch({ include: [a] })).not.toBe(canonicalUrlMatch({ include: [b] }));
    expect(canonicalUrlMatch({ include: [a] })).not.toBe(canonicalUrlMatch({ include: [a], exclude: [a] })); // 除くの有無は別
    // exclude・params が無い = 空
    expect(canonicalUrlMatch({ include: [a] })).toBe(canonicalUrlMatch({ include: [a], exclude: [] }));
    expect(canonicalUrlMatch({ include: [a] })).toBe(canonicalUrlMatch({ include: [{ ...a, params: [] }] }));
  });
  it("形が合わなければ JSON.stringify(m)", () => {
    for (const m of [null, "x", { op: "contains", value: "/" }, { include: "x" }, { include: [{}] }, { include: [a], extra: 1 }]) expect(canonicalUrlMatch(m)).toBe(JSON.stringify(m));
    expect(canonicalUrlMatch(undefined)).toBe("undefined"); // 文字列を返す(undefined を返さない)
  });
  it("canonical_url_match_normalizes_page (B69 final review FR-Medium-1)", () => {
    // part の省略と "url" は同じ(保存のときの normalizePageMatch と同じ扱い)
    expect(canonicalUrlMatch({ include: [{ page: { part: "url", op: "contains", value: "/lp/" } }] })).toBe(canonicalUrlMatch({ include: [{ page: { op: "contains", value: "/lp/" } }] }));
    expect(canonicalUrlMatch({ include: [a], exclude: [{ page: { part: "url", op: "equals", value: "https://x.example/" } }] })).toBe(
      canonicalUrlMatch({ include: [a], exclude: [{ page: { op: "equals", value: "https://x.example/" } }] }),
    );
    // ホストの値の正規化(大文字・末尾のドット)
    expect(canonicalUrlMatch({ include: [{ page: { part: "host", op: "equals", value: "X.Example." } }] })).toBe(canonicalUrlMatch({ include: [{ page: { part: "host", op: "equals", value: "x.example" } }] }));
    // 意味の違う page は別のまま
    expect(canonicalUrlMatch({ include: [{ page: { part: "path", op: "contains", value: "/lp/" } }] })).not.toBe(canonicalUrlMatch({ include: [{ page: { op: "contains", value: "/lp/" } }] }));
    // 形の合わない page は例外を投げずそのまま比べる
    expect(() => canonicalUrlMatch({ include: [{ page: { op: "contains", value: 1 } }, { page: { op: "x", value: "/" } }, { page: { part: "url", op: "contains", value: "/", extra: 1 } }] })).not.toThrow();
    expect(canonicalUrlMatch({ include: [{ page: { part: "url", op: "contains", value: "/", extra: 1 } }] })).not.toBe(canonicalUrlMatch({ include: [{ page: { op: "contains", value: "/", extra: 1 } }] }));
  });
});

describe("対象 URL の行の and(B69 追補)", () => {
  const host = { part: "host", op: "equals", value: "shop.example.com" } as const;
  const pathC = { part: "path", op: "contains", value: "/sale/" } as const;
  const rx = (v: string) => ({ part: "path" as const, op: "regex" as const, value: v });
  const compileSpy = vi.mocked(compileRegex);
  beforeEach(() => {
    compileSpy.mockClear(); // 戻り値(spy 自体)を返すと後始末の関数として呼ばれるので、ブロックで書く
  });

  it("issue_url_regex_in_and", () => {
    const bad = urlMatchIssue({ include: [{ page: host, and: [{ op: "regex", value: "^https://x/" }] }] });
    expect(bad?.code).toBe("regex_not_allowed_on_url");
    expect(bad?.path).toEqual(["include", 0, "and", 0, "value"]);
    expect(bad?.index).toBeTypeOf("number");
    expect(bad?.length).toBeTypeOf("number");
    expect(bad?.hint).toMatch(/^書き換えの例: /);
    // 不正な式は index / length が式の中の位置を指す
    const syn = urlMatchIssue({ include: [{ page: host }], exclude: [{ page: host, and: [pathC, rx("^/a(")] }] });
    expect(syn?.path).toEqual(["exclude", 0, "and", 1, "value"]);
    const direct = compileRegex("^/a(");
    if (direct.ok) throw new Error("should fail");
    expect(syn).toMatchObject({ code: direct.issue.code, message: direct.issue.message, index: direct.issue.index, length: direct.issue.length });
    // page の誤りも index / length を返す
    const onPage = urlMatchIssue({ include: [{ page: rx("^/a(") }] });
    expect(onPage).toMatchObject({ path: ["include", 0, "page", "value"], index: direct.issue.index, length: direct.issue.length });
  });

  it("normalize_and", () => {
    const m: UrlMatchInput = {
      include: [
        { page: pathC, and: [{ part: "host", op: "equals", value: " Shop.Example.COM. " }, { part: "url", op: "contains", value: "/x" }, pathC] },
        { page: pathC, and: [] },
      ],
      exclude: [{ page: host, and: [], params: [] }],
    };
    expect(normalizeUrlMatch(m)).toEqual({
      include: [{ page: pathC, and: [{ part: "host", op: "equals", value: "shop.example.com" }, { op: "contains", value: "/x" }, pathC] }, { page: pathC }],
      exclude: [{ page: host }],
    });
    // 行のキーの並びは page → and → params
    expect(Object.keys(normalizeUrlMatch({ include: [{ page: pathC, and: [host], params: [{ name: "a", op: "exists" }] }] }).include[0]!)).toEqual(["page", "and", "params"]);
  });

  it("canonical_and_order_insensitive", () => {
    const A = { part: "host", op: "equals", value: "a.example" } as const;
    const B = { part: "path", op: "startsWith", value: "/b/" } as const;
    const C = { part: "path", op: "contains", value: "/c/" } as const;
    expect(canonicalUrlMatch({ include: [{ page: C, and: [A, B] }] })).toBe(canonicalUrlMatch({ include: [{ page: C, and: [B, A] }] }));
    expect(canonicalUrlMatch({ include: [{ page: C, and: [] }] })).toBe(canonicalUrlMatch({ include: [{ page: C }] }));
    // and の要素も保存のときと同じに正規化して比べる
    expect(canonicalUrlMatch({ include: [{ page: C, and: [{ part: "host", op: "equals", value: "A.Example." }] }] })).toBe(canonicalUrlMatch({ include: [{ page: C, and: [A] }] }));
    // page と and の入れ替えは別の形(追補 §2.4)
    expect(canonicalUrlMatch({ include: [{ page: A, and: [B] }] })).not.toBe(canonicalUrlMatch({ include: [{ page: B, and: [A] }] }));
    // and の有無は別
    expect(canonicalUrlMatch({ include: [{ page: C, and: [A] }] })).not.toBe(canonicalUrlMatch({ include: [{ page: C }] }));
    // and が配列でない・要素がオブジェクトでないなら形が合わない
    for (const m of [{ include: [{ page: C, and: A }] }, { include: [{ page: C, and: ["x"] }] }]) expect(canonicalUrlMatch(m)).toBe(JSON.stringify(m));
  });

  it("canonical_without_and_is_unchanged", () => {
    // この変更の前(ac4dd944)の canonicalUrlMatch の出力を固定値で持つ(重なりの警告・届いた定義の比較・変更の判定で今のデータに差を出さない)
    const a = { page: { part: "path", op: "startsWith", value: "/a/" } };
    const b = { page: { part: "host", op: "equals", value: "X.Example." }, params: [{ name: "q", op: "equals", value: "1" }, { name: "p", op: "exists" }] };
    expect(canonicalUrlMatch({ include: [b, a], exclude: [{ page: { part: "url", op: "contains", value: "/x" } }] })).toBe(
      '{"exclude":[{"page":{"op":"contains","value":"/x"}}],"include":[{"page":{"op":"equals","part":"host","value":"x.example"},"params":[{"name":"p","op":"exists"},{"name":"q","op":"equals","value":"1"}]},{"page":{"op":"startsWith","part":"path","value":"/a/"}}]}',
    );
    expect(canonicalUrlMatch({ include: [a] })).toBe('{"include":[{"page":{"op":"startsWith","part":"path","value":"/a/"}}]}');
  });

  it("issue_counts_and_instructions", () => {
    // `^/[a-z]{21}$` = 25 命令。1 行に page + and 5 個 = 6 個 × 25 = 150
    const r = rx("^/[a-z]{21}$");
    const c = compileRegex(r.value);
    if (!c.ok) throw new Error("compile");
    expect(c.instructions).toBe(25);
    const full = { page: r, and: Array.from({ length: LIMITS.urlAndMax }, () => r) };
    expect(urlMatchIssue({ include: [full, full, full], exclude: [{ page: r, and: [r] }] })).toBeNull(); // 450 + 50 = 500 ちょうど
    const over = urlMatchIssue({ include: [full, full, full], exclude: [{ page: pathC, and: [r, r, r] }] }); // 450 + 75 = 525(and だけで超える)
    expect(over?.code).toBe("url_match_too_large");
    expect(over?.message).toContain(`上限 ${LIMITS.urlInstructionsMax}`);
  });

  it("issue_compiles_each_once_and_stops", () => {
    const r = rx("^/[a-z]{21}$"); // 25 命令
    const m: UrlMatchInput = { include: [{ page: r, and: [r, pathC, r] }, { page: host, and: [r] }], exclude: [{ page: r }] };
    compileSpy.mockClear();
    expect(urlMatchIssue(m)).toBeNull();
    expect(compileSpy).toHaveBeenCalledTimes(5); // 正規表現の要素ごとに 1 回(文字列の照合はコンパイルしない)
    // 合計が 500 を超えた後の要素はコンパイルしない: 21 個目(500 + 25)で止まり、残りの 4 個は呼ばれない
    const many: UrlMatchInput = { include: Array.from({ length: 5 }, () => ({ page: r, and: [r, r, r, r, r] })) }; // 30 個
    compileSpy.mockClear();
    const issue = urlMatchIssue(many);
    expect(issue?.code).toBe("url_match_too_large");
    expect(compileSpy).toHaveBeenCalledTimes(21);
  });

  it("url_regex_message_mentions_and: 対象 URL の保存の検査(urlMatchIssue)だけが and の案内を足す", () => {
    for (const path of [["include", 0, "page", "value"], ["include", 0, "and", 0, "value"]]) {
      const m: UrlMatchInput = path[2] === "page" ? { include: [{ page: { op: "regex", value: "^/a" } }] } : { include: [{ page: { part: "path", op: "equals", value: "/a" }, and: [{ op: "regex", value: "^/a" }] }] };
      const issue = urlMatchIssue(m);
      expect(issue?.code).toBe("regex_not_allowed_on_url");
      expect(issue?.path).toEqual(path);
      expect(issue?.message).not.toContain("一方しか見ません");
      expect(issue?.message).toContain("かつ");
      expect(issue?.message).toContain("and");
    }
  });

  it("共通の pageMatchIssue(目標・オーディエンス)の message は and を案内しない", () => {
    const msg = pageMatchIssue({ op: "regex", value: "^/a" })?.message ?? "";
    expect(msg).toContain("で始まる");
    expect(msg).toContain("と等しい");
    expect(msg).not.toContain("一方しか見ません");
    expect(msg).not.toContain("かつ");
    expect(msg).not.toContain("and");
  });

  it("url_match_too_large の hint は and の条件を減らす案内を含む", () => {
    const r = rx("^/[a-z]{21}$");
    const issue = urlMatchIssue({ include: Array.from({ length: 5 }, () => ({ page: r, and: [r, r, r, r, r] })) });
    expect(issue?.hint).toBe("行や、行の「かつ」の条件を減らすか、正規表現を「で始まる」「を含む」などに置き換えてください");
    expect(issue?.path).toEqual([]);
  });
});

describe("isOldUrlMatch", () => {
  it("is_old_url_match", () => {
    expect(isOldUrlMatch({ op: "contains", value: "/" })).toBe(true);
    expect(isOldUrlMatch({ part: "path", op: "equals", value: "/" })).toBe(true);
    expect(isOldUrlMatch({ include: [row] })).toBe(false);
    expect(isOldUrlMatch({ include: [row], op: "contains" })).toBe(false); // include があれば古い形ではない
    expect(isOldUrlMatch(null)).toBe(false);
    expect(isOldUrlMatch("x")).toBe(false);
    expect(isOldUrlMatch([])).toBe(false);
  });
});
