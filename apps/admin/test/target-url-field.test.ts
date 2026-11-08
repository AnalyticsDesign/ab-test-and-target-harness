import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TargetUrlField } from "@/components/TargetUrlField";
import { DEFAULT_URL_MATCH, describeUrlMatch, urlMatchListText, urlMatchProblem, type UrlMatchValue, type UrlRowValue } from "@/lib/url-match";

/** B69(spec §7.2・§7.4): 対象 URL の入力(含める・除くの 2 つの枠)と、一覧・変更履歴の文 */
const row = (value: string, params?: UrlRowValue["params"]): UrlRowValue => ({ page: { part: "path", op: "startsWith", value }, ...(params ? { params } : {}) });
const render = (value: UrlMatchValue, disabled = false) => renderToStaticMarkup(createElement(TargetUrlField, { value, onChange: () => {}, disabled }));
const count = (html: string, s: string) => html.split(s).length - 1;

describe("TargetUrlField", () => {
  it("target_url_field_rows: 最後の 1 行は消せない・上限で追加のボタンが消える・閲覧者は押せない・要約", () => {
    // 含めるの最後の 1 行には消すボタンが無い(除くの行は 1 行でも消せる)
    const one = render({ include: [row("/lp/")], exclude: [row("/lp/old/")] });
    expect(count(one, 'aria-label="この行を消す"')).toBe(1);
    const two = render({ include: [row("/a/"), row("/b/")] });
    expect(count(two, 'aria-label="この行を消す"')).toBe(2);
    expect(two).toContain("または");
    // 10 行で「+ 含めるページ」が消える(除くは別に数える)
    const ten = render({ include: Array.from({ length: 10 }, (_, i) => row(`/p${i}/`)) });
    expect(ten).not.toContain("+ 含めるページ");
    expect(ten).toContain("+ 除くページ");
    expect(render({ include: Array.from({ length: 9 }, (_, i) => row(`/p${i}/`)) })).toContain("+ 含めるページ");
    const tenOut = render({ include: [row("/")], exclude: Array.from({ length: 10 }, (_, i) => row(`/x${i}/`)) });
    expect(tenOut).not.toContain("+ 除くページ");
    // パラメータ 5 個で「+ パラメータの条件(かつ)」が消える
    const params = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, op: "exists" as const }));
    const five = render({ include: [row("/", params)] });
    expect(five).not.toContain("+ パラメータの条件(かつ)");
    expect(count(five, ">かつ<")).toBe(5);
    expect(render({ include: [row("/", params.slice(0, 4))] })).toContain("+ パラメータの条件(かつ)");
    // disabled で全部押せない(追加・削除のボタンは出さず、入力欄・選択は disabled)
    const ro = render({ include: [row("/a/", [{ name: "utm_source", op: "equals", value: "news" }]), row("/b/")], exclude: [row("/c/")] }, true);
    expect(ro).not.toContain("+ 含めるページ");
    expect(ro).not.toContain("+ 除くページ");
    expect(ro).not.toContain("+ パラメータの条件(かつ)");
    expect(ro).not.toContain("この行を消す");
    expect(ro).not.toContain("このパラメータの条件を消す");
    const controls = ro.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c).toMatch(/disabled=""/);
    // 選択(照合する部分・一致の仕方・パラメータの一致の仕方)も押せない
    expect(count(ro, 'role="combobox"')).toBe(7); // ページの一致 3 行 × 2 + パラメータ 1
    expect(count(ro, 'aria-disabled="true"')).toBe(count(ro, 'role="combobox"'));
    // 要約: 動かすページ: … ただし次は除く: …
    const html = render({ include: [row("/lp/", [{ name: "utm_source", op: "equals", value: "news" }]), row("/sale/")], exclude: [row("/lp/old/")] });
    expect(html).toContain("動かすページ: ");
    expect(html).toContain("パス が「/lp/」で始まる かつ パラメータ utm_source が「news」に一致");
    expect(html).toContain("ただし次は除く: ");
    expect(html).toContain("パス が「/lp/old/」で始まる");
    expect(html).toContain("保存される JSON(エージェント・API と同じ形)");
    expect(render({ include: [row("/lp/")] })).not.toContain("ただし次は除く");
  });
  it("初期値は含める 1 行(パスで始まる・空)", () => {
    expect(DEFAULT_URL_MATCH).toEqual({ include: [{ page: { part: "path", op: "startsWith", value: "" } }] });
  });
  it("describeUrlMatch はパラメータの 3 つの演算子を文にする", () => {
    const m: UrlMatchValue = {
      include: [row("/", [{ name: "a", op: "equals", value: "" }, { name: "b", op: "contains", value: "x" }, { name: "c", op: "exists" }])],
    };
    expect(describeUrlMatch(m)).toEqual({ include: ["パス が「/」で始まる かつ パラメータ a が「」に一致 かつ パラメータ b が「x」を含む かつ パラメータ c がある"], exclude: [] });
  });
  it("保存の前の確認: ページの値の空・パラメータの名前の空・含むの値の空・正規表現(行の位置を添える)", () => {
    expect(urlMatchProblem({ include: [row("/lp/")] })).toBeNull();
    expect(urlMatchProblem({ include: [row("/lp/"), row("")] })).toBe("対象 URL(含める 2 行目): 値を入力してください");
    expect(urlMatchProblem({ include: [row("/")], exclude: [row("/x/", [{ name: " ", op: "exists" }])] })).toBe("対象 URL(除く 1 行目): パラメータの名前を入力してください");
    expect(urlMatchProblem({ include: [row("/", [{ name: "q", op: "contains", value: "" }])] })).toBe("対象 URL(含める 1 行目): パラメータ q の値を入力してください");
    expect(urlMatchProblem({ include: [row("/", [{ name: "q", op: "equals", value: "" }])] })).toBeNull(); // 次に一致は空の値を許す
    expect(urlMatchProblem({ include: [{ page: { part: "path", op: "regex", value: "a{2,}" } }] })).toBe("対象 URL(含める 1 行目): 正規表現を直してください");
  });
});

describe("一覧の対象 URL の列", () => {
  it("list_text: 含めるの 1 行目 + ほか N 件 + 除く M 件", () => {
    const m = { include: [row("/lp/"), row("/a/"), row("/b/")], exclude: [row("/lp/old/")] };
    expect(urlMatchListText(m)).toBe("パス が「/lp/」で始まる ほか 2 件・除く 1 件");
    expect(urlMatchListText({ include: [row("/lp/")] })).toBe("パス が「/lp/」で始まる");
    expect(urlMatchListText({ include: [row("/lp/"), row("/a/")] })).toBe("パス が「/lp/」で始まる ほか 1 件");
    expect(urlMatchListText({ include: [row("/lp/")], exclude: [row("/x/")] })).toBe("パス が「/lp/」で始まる・除く 1 件");
  });
  it("list_text_old_shape: 古い形は describePageMatch の文。どちらでもなければ JSON(例外を出さない)", () => {
    expect(urlMatchListText({ part: "path", op: "startsWith", value: "/lp/" })).toBe("パス が「/lp/」で始まる");
    expect(urlMatchListText({ op: "equals", value: "https://www.example.com/" })).toBe("URL が「https://www.example.com/」と完全一致");
    for (const v of [null, 42, "x", { include: [] }, { include: [{ page: { part: "zzz", op: "equals", value: "/" } }] }, { part: "zzz", op: "equals", value: "/" }])
      expect(urlMatchListText(v)).toBe(JSON.stringify(v));
  });
});
