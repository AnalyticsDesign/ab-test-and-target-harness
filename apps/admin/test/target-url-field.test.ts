import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TargetUrlField } from "@/components/TargetUrlField";
import {
  addCondition,
  canAddCondition,
  conditionKindOptions,
  DEFAULT_URL_MATCH,
  describeUrlMatch,
  removeCondition,
  removeFirstCondition,
  switchConditionKind,
  urlMatchAuditText,
  urlMatchListText,
  urlMatchProblem,
  type UrlMatchValue,
  type UrlRowValue,
} from "@/lib/url-match";
import type { PageMatchValue } from "@/lib/page-match";

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
    // パラメータ 5 個でも、ページの条件(and)に空きがあれば「+ 条件(かつ)」は出る(B69 追補 §7)
    const params = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, op: "exists" as const }));
    const five = render({ include: [row("/", params)] });
    expect(five).toContain("+ 条件(かつ)");
    expect(count(five, ">かつ<")).toBe(5);
    expect(render({ include: [row("/", params.slice(0, 4))] })).toContain("+ 条件(かつ)");
    // disabled で全部押せない(追加・削除のボタンは出さず、入力欄・選択は disabled)
    const ro = render({ include: [row("/a/", [{ name: "utm_source", op: "equals", value: "news" }]), row("/b/")], exclude: [row("/c/")] }, true);
    expect(ro).not.toContain("+ 含めるページ");
    expect(ro).not.toContain("+ 除くページ");
    expect(ro).not.toContain("+ 条件(かつ)");
    expect(ro).not.toContain("この行を消す");
    expect(ro).not.toContain("この条件を消す");
    const controls = ro.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c).toMatch(/disabled=""/);
    // 選択(照合する部分・一致の仕方・パラメータの一致の仕方)も押せない
    expect(count(ro, 'role="combobox"')).toBe(8); // ページの一致 3 行 × 2 + パラメータ 1 行 × 2(条件の種類・一致の仕方)
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
    expect(urlMatchProblem({ include: [row("/lp/"), row("")] })).toBe("対象 URL(含める 2 行目): ページの条件を入れてください(すべてのページなら『パスが / で始まる』)");
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
    for (const v of [null, 42, "x", { include: [] }, { include: [{ page: { part: "zzz", op: "equals", value: "/" } }] }, { include: [{ page: { part: "path", op: "equals", value: "/" }, and: [{ part: "zzz", op: "equals", value: "/" }] }] }, { include: [{ page: { part: "path", op: "equals", value: "/" }, and: "x" }] }, { part: "zzz", op: "equals", value: "/" }])
      expect(urlMatchListText(v)).toBe(JSON.stringify(v));
  });
});

/** B69 追補(and): 行の中の「かつ」のページの条件(and)。並びは page → and → params に固定(追補 §7) */
describe("対象 URL の行の and の条件", () => {
  const host = (value: string, op = "equals"): PageMatchValue => ({ part: "host", op, value });
  const path = (value: string, op = "startsWith"): PageMatchValue => ({ part: "path", op, value });
  const url = (value: string, op = "equals"): PageMatchValue => ({ op, value });
  const p = (name: string, value = "x") => ({ name, op: "equals" as const, value });
  const paths = (n: number) => Array.from({ length: n }, (_, i) => path(`/a${i}/`));
  const ps = (n: number) => Array.from({ length: n }, (_, i) => p(`p${i}`));

  it("row_text_with_and: 行の文・一覧・変更履歴は page → and → params の順に「かつ」でつなぐ。and の要素が壊れていれば行の形と見ない", () => {
    const r: UrlRowValue = { page: host("shop.example.com"), and: [path("/sale/", "contains")], params: [p("utm_source", "news")] };
    const text = "ホスト が「shop.example.com」と完全一致 かつ パス が「/sale/」を含む かつ パラメータ utm_source が「news」に一致";
    expect(describeUrlMatch({ include: [r] }).include).toEqual([text]);
    expect(urlMatchListText({ include: [r] })).toBe(text);
    expect(urlMatchAuditText({ include: [r] })).toBe(text);
    const broken = { include: [{ page: host("a"), and: [{ part: "path", op: 1, value: "/" }] }] };
    expect(urlMatchListText(broken)).toBe(JSON.stringify(broken));
    expect(urlMatchAuditText(broken)).toBe(JSON.stringify(broken));
  });

  it("row_problem_and: and の値の空・正規表現の誤りは行の問題(行の位置を添える)", () => {
    expect(urlMatchProblem({ include: [{ page: host("shop.example.com"), and: [path("/sale/")] }] })).toBeNull();
    expect(urlMatchProblem({ include: [row("/"), { page: host("shop.example.com"), and: [path(" ")] }] })).toBe("対象 URL(含める 2 行目): パスの条件の値を入力してください");
    expect(urlMatchProblem({ include: [row("/")], exclude: [{ page: host("shop.example.com"), and: [path("a{2,}", "regex")] }] })).toBe("対象 URL(除く 1 行目): 正規表現を直してください");
  });

  it("add_condition_default_kind: 先頭がホストならパス、それ以外ならホストの条件を and に足す(既定の一致の仕方・空の値)", () => {
    expect(addCondition({ page: host("shop.example.com") })).toEqual({ page: host("shop.example.com"), and: [{ part: "path", op: "startsWith", value: "" }] });
    expect(addCondition({ page: path("/sale/") })).toEqual({ page: path("/sale/"), and: [{ part: "host", op: "equals", value: "" }] });
    expect(addCondition({ page: url("https://a/") })).toEqual({ page: url("https://a/"), and: [{ part: "host", op: "equals", value: "" }] });
    // 足した条件は and の最後(params はそのまま)
    expect(addCondition({ page: host("a"), and: [path("/x/")], params: [p("q")] })).toEqual({ page: host("a"), and: [path("/x/"), path("")], params: [p("q")] });
  });

  it("add_goes_to_side_with_space: and が 5 個ならパラメータに、両方 5 個ならボタンを出さない", () => {
    expect(addCondition({ page: host("a"), and: paths(5) })).toEqual({ page: host("a"), and: paths(5), params: [{ name: "", op: "equals", value: "" }] });
    expect(addCondition({ page: host("a"), params: ps(5) })).toEqual({ page: host("a"), and: [path("")], params: ps(5) });
    const full: UrlRowValue = { page: host("a"), and: paths(5), params: ps(5) };
    expect(canAddCondition(full)).toBe(false);
    expect(addCondition(full)).toBe(full);
    expect(render({ include: [full] })).not.toContain("+ 条件(かつ)");
    expect(render({ include: [{ page: host("a"), and: paths(5), params: ps(4) }] })).toContain("+ 条件(かつ)");
  });

  it("kind_switch_respects_limits_and_clears_value: 並びをまたぐ切り替えは移る先の最後に足し、値を空にする。移る先が 5 個なら選べない", () => {
    const r: UrlRowValue = { page: host("a"), and: [path("/x/"), path("/y/")], params: [p("q")] };
    expect(switchConditionKind(r, "and", 0, "param")).toEqual({ page: host("a"), and: [path("/y/")], params: [p("q"), { name: "", op: "equals", value: "" }] });
    expect(switchConditionKind(r, "params", 0, "host")).toEqual({ page: host("a"), and: [path("/x/"), path("/y/"), host("")] });
    // 同じ並びの中(パス → ホスト)は場所を変えずに、その種類の既定の一致の仕方・空の値にする
    expect(switchConditionKind(r, "and", 1, "host")).toEqual({ page: host("a"), and: [path("/x/"), host("")], params: [p("q")] });
    // 同じ種類の選び直しは値を消さない
    expect(switchConditionKind(r, "and", 0, "path")).toBe(r);
    expect(switchConditionKind(r, "params", 0, "param")).toBe(r);
    // パラメータが 5 個: ページの条件の行のプルダウンの「パラメータ」は選べない
    const fullParams: UrlRowValue = { page: host("a"), and: [path("/x/")], params: ps(5) };
    expect(conditionKindOptions(fullParams, "and")).toEqual([
      { value: "path", label: "パス", disabled: false },
      { value: "host", label: "ホスト", disabled: false },
      { value: "url", label: "URL", disabled: false },
      { value: "param", label: "パラメータ", disabled: true },
    ]);
    expect(switchConditionKind(fullParams, "and", 0, "param")).toBe(fullParams);
    // and が 5 個: パラメータの行のプルダウンの「パス / ホスト / URL」は選べない。and の中のパス → ホストはできる
    const fullAnd: UrlRowValue = { page: host("a"), and: paths(5), params: [p("q")] };
    expect(conditionKindOptions(fullAnd, "params").map((o) => o.disabled)).toEqual([true, true, true, false]);
    expect(conditionKindOptions(fullAnd, "and").map((o) => o.disabled)).toEqual([false, false, false, false]);
    expect(switchConditionKind(fullAnd, "params", 0, "path")).toBe(fullAnd);
    expect(switchConditionKind(fullAnd, "and", 4, "host").and![4]).toEqual(host(""));
  });

  it("render_order_page_and_params: page → and(入力の順)→ params(入力の順)で描く。条件の行の先頭は「条件の種類」", () => {
    const html = render({ include: [{ page: host("shop.example.com"), and: [path("/sale/"), url("https://z/", "startsWith")], params: [p("p1"), p("p2")] }] });
    const at = (s: string) => html.indexOf(s);
    expect(at('value="shop.example.com"')).toBeGreaterThan(-1);
    expect(at('value="shop.example.com"')).toBeLessThan(at('value="/sale/"'));
    expect(at('value="/sale/"')).toBeLessThan(at('value="https://z/"'));
    expect(at('value="https://z/"')).toBeLessThan(at('value="p1"'));
    expect(at('value="p1"')).toBeLessThan(at('value="p2"'));
    expect(count(html, 'aria-label="条件の種類"')).toBe(4);
    expect(count(html, ">かつ<")).toBe(4);
    expect(html).toContain("+ 条件(かつ)");
  });

  it("remove_last_param_keeps_and: パラメータを全部消しても and は残る(空の and・params は省く)", () => {
    const r: UrlRowValue = { page: host("a"), and: [path("/x/")], params: [p("q")] };
    expect(removeCondition(r, "params", 0)).toEqual({ page: host("a"), and: [path("/x/")] });
    expect(removeCondition(r, "and", 0)).toEqual({ page: host("a"), params: [p("q")] });
  });

  it("remove_first_condition_promotes_and: and の先頭が page に繰り上がる(params は残す)", () => {
    expect(removeFirstCondition({ page: host("a"), and: [path("/x/"), url("https://z/")], params: [p("q")] })).toEqual({ page: path("/x/"), and: [url("https://z/")], params: [p("q")] });
    expect(removeFirstCondition({ page: host("a"), and: [path("/x/")] })).toEqual({ page: path("/x/") });
  });

  it("remove_first_condition_without_and_clears_value: and の無い行は最初の条件の値を空にする(種類・一致の仕方・params・行は残す)", () => {
    expect(removeFirstCondition({ page: { part: "path", op: "startsWith", value: "/lp/" }, params: [p("q")] })).toEqual({ page: { part: "path", op: "startsWith", value: "" }, params: [p("q")] });
  });

  it("empty_first_condition_blocks_save: 最初の条件の値が空なら保存の前の確認で止め、欄の下にも同じ案内を出す", () => {
    const guide = "ページの条件を入れてください(すべてのページなら『パスが / で始まる』)";
    expect(urlMatchProblem({ include: [{ page: path(""), params: [p("q")] }] })).toBe(`対象 URL(含める 1 行目): ${guide}`);
    expect(render({ include: [{ page: path(""), params: [p("q")] }] })).toContain(guide);
    expect(render({ include: [row("/lp/")] })).not.toContain(guide);
  });

  it("row_delete_button: 行を消すボタンは別に置き(含めるの最後の 1 行には無い)、どの条件の × も「この条件を消す」", () => {
    const r: UrlRowValue = { page: host("a"), and: [path("/x/")], params: [p("q")] };
    const one = render({ include: [r] });
    expect(count(one, 'aria-label="この行を消す"')).toBe(0);
    expect(count(one, 'aria-label="この条件を消す"')).toBe(3); // 最初の条件・and・パラメータ
    expect(count(one, 'title="この条件を消す"')).toBe(3);
    const two = render({ include: [r, row("/b/")] });
    expect(count(two, 'aria-label="この行を消す"')).toBe(2);
    expect(count(two, 'aria-label="この条件を消す"')).toBe(4);
  });

  it("viewer_disables_conditions: 閲覧者では条件の欄・プルダウン・ボタンを押せない", () => {
    const ro = render({ include: [{ page: host("a"), and: [path("/x/")], params: [p("q")] }, row("/b/")] }, true);
    expect(ro).not.toContain("この条件を消す");
    expect(ro).not.toContain("この行を消す");
    expect(ro).not.toContain("+ 条件(かつ)");
    const controls = ro.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c).toMatch(/disabled=""/);
    expect(count(ro, 'role="combobox"')).toBe(8); // ページの一致 2 行 × 2 + and(種類・一致の仕方)+ パラメータ(種類・一致の仕方)
    expect(count(ro, 'aria-disabled="true"')).toBe(count(ro, 'role="combobox"'));
  });
});
