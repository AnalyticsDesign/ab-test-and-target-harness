import { describe, expect, it } from "vitest";
import { orderForCompile, overlapWarnings } from "../src/experiment-order";

const row = (id: string, kind: "test" | "single", created_at: number, last_started_at: number | null) => ({ id, kind, created_at, last_started_at });

describe("orderForCompile (決定 51、設計書 §3.2: 後に並ぶものほど優先が高い)", () => {
  it("puts singles (oldest created first) before tests (newest started first)", () => {
    const rows = [
      row("t1", "test", 1, 1_000), // 10/1 開始
      row("s_new", "single", 50, 2_000),
      row("t2", "test", 2, 5_000), // 10/5 開始
      row("s_old", "single", 10, 3_000),
    ];
    // 例(設計書 §3.2): S → T2 → T1。T1(先に開始)が最も優先
    expect(orderForCompile(rows).map((r) => r.id)).toEqual(["s_old", "s_new", "t2", "t1"]);
  });

  it("compile_orders_with_stable_tiebreak_on_equal_timestamps", () => {
    const rows = [row("t_b", "test", 1, 100), row("s_b", "single", 7, null), row("t_a", "test", 2, 100), row("s_a", "single", 7, null)];
    // 同じミリ秒は ID の昇順(config のバイト列を決定的にするため)
    expect(orderForCompile(rows).map((r) => r.id)).toEqual(["s_a", "s_b", "t_a", "t_b"]);
    expect(orderForCompile([...rows].reverse()).map((r) => r.id)).toEqual(["s_a", "s_b", "t_a", "t_b"]);
  });

  it("treats a test without last_started_at as the newest test (lowest test priority, K5)", () => {
    const rows = [row("t_started", "test", 1, 100), row("t_draft", "test", 2, null), row("s", "single", 3, null)];
    expect(orderForCompile(rows).map((r) => r.id)).toEqual(["s", "t_draft", "t_started"]);
  });

  it("does not mutate the input", () => {
    const rows = [row("t1", "test", 1, 1), row("s", "single", 1, null)];
    orderForCompile(rows);
    expect(rows.map((r) => r.id)).toEqual(["t1", "s"]);
  });
});

const exp = (id: string, kind: "test" | "single", selectors: string[], urlMatch: unknown = { include: [{ page: { op: "startsWith", value: "/" } }] }) => ({
  id, name: id.toUpperCase(), kind, urlMatch,
  variants: [{ changes: [] as Array<{ selector?: string }> }, { changes: selectors.map((s) => ({ selector: s })) }],
});

describe("overlapWarnings (決定 51、設計書 §3.3)", () => {
  it("warns the lower-priority test and says the earlier-started one wins", () => {
    // 並び = 優先の順(後ろが高い)。T2(後に開始)→ T1(先に開始)
    const w = overlapWarnings([exp("t2", "test", ["#cta"]), exp("t1", "test", ["#cta", ".x"])]);
    expect(w).toEqual([
      { path: "experiments.t2", experimentIds: ["t2", "t1"], message: "「T2」は「T1」と同じ要素(#cta)を変えます。「T1」(先に開始・再開)が優先され、「T2」の効果は薄まって見えます" },
    ]);
  });

  it("explains a single losing to a test, and singles among themselves", () => {
    const w = overlapWarnings([exp("s1", "single", ["#cta"]), exp("s2", "single", ["#cta"]), exp("t", "test", ["#cta"])]);
    expect(w.map((x) => x.path)).toEqual(["experiments.s1", "experiments.s1", "experiments.s2"]);
    expect(w[0]!.message).toBe("「S1」と「S2」(どちらもパーソナライズ)は同じ要素(#cta)を変えます。後に作成した「S2」が優先されます");
    expect(w[1]!.message).toBe("「S1」(パーソナライズ)は「T」(テスト)と同じ要素(#cta)を変えます。テストが優先され、テストのパターンが変える部分では「S1」の変更は表示されません");
  });

  it("needs both the same urlMatch and the same selector string", () => {
    expect(overlapWarnings([exp("a", "test", ["#cta"], { include: [{ page: { op: "equals", value: "/lp" } }] }), exp("b", "test", ["#cta"])])).toEqual([]); // 範囲の重なりは見ない
    expect(overlapWarnings([exp("a", "test", ["#cta"]), exp("b", "test", ["#cta "])])).toEqual([]); // 文字列の完全一致
    // 除く行が増えれば別の対象 URL(範囲の違いは見ない)
    const excluded = { include: [{ page: { op: "startsWith", value: "/" } }], exclude: [{ page: { part: "path", op: "startsWith", value: "/old/" } }] };
    expect(overlapWarnings([exp("a", "test", ["#cta"], excluded), exp("b", "test", ["#cta"])])).toEqual([]);
  });

  // B69(spec §2.3): 行の順・パラメータの順だけが違う対象 URL は同じ。除く行・パラメータが無いのと空の配列も同じ
  it("overlap_uses_canonical_url_match", () => {
    const p1 = { page: { part: "path", op: "startsWith", value: "/lp/" }, params: [{ name: "a", op: "exists" }, { name: "b", op: "equals", value: "1" }] };
    const p2 = { page: { part: "host", op: "equals", value: "shop.example.com" } };
    const one = { include: [p1, p2] };
    const reordered = { include: [p2, { ...p1, params: [...p1.params].reverse() }], exclude: [] };
    expect(overlapWarnings([exp("a", "test", ["#cta"], one), exp("b", "test", ["#cta"], reordered)])).toEqual([
      expect.objectContaining({ path: "experiments.a", experimentIds: ["a", "b"] }),
    ]);
  });

  it("overlap_ignores_explicit_url_part (B69 final review FR-Medium-1)", () => {
    // part の省略と part: "url" は同じ対象 URL(保存のときの正規化と同じ)
    const omitted = { include: [{ page: { op: "contains", value: "/lp/" } }] };
    const explicit = { include: [{ page: { part: "url", op: "contains", value: "/lp/" } }] };
    expect(overlapWarnings([exp("a", "test", ["#cta"], omitted), exp("b", "test", ["#cta"], explicit)])).toEqual([
      expect.objectContaining({ path: "experiments.a", experimentIds: ["a", "b"] }),
    ]);
  });

  it("lists up to three selectors and counts the rest", () => {
    const sels = ["#a", "#b", "#c", "#d", "#e"];
    const [w] = overlapWarnings([exp("t2", "test", sels), exp("t1", "test", sels)]);
    expect(w!.message).toContain("同じ要素(#a、#b、#c ほか 2 件)");
  });

  it("ignores selectorless changes (CSS)", () => {
    const css = (id: string) => ({ id, name: id, kind: "test" as const, urlMatch: { include: [{ page: { op: "startsWith", value: "/" } }] }, variants: [{ changes: [{}] }] });
    expect(overlapWarnings([css("a"), css("b")])).toEqual([]);
  });
});
