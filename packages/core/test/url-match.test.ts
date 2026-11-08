import { describe, expect, it } from "vitest";
import { canonicalUrlMatch, isOldUrlMatch, normalizeUrlMatch, urlMatchIssue, type UrlMatchInput } from "../src/url-match";
import { CompiledUrlMatchSchema, UrlMatchInputSchema } from "../src/schema";
import { compileRegex } from "../src/regex-compile";

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
