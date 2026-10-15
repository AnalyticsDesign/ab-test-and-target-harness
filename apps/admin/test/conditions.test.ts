import { describe, expect, it } from "vitest";
import { condProblem, condText, dslHasHistory, groupText, periodProblem, summarizeDsl, treeProblem, type Names } from "../lib/conditions";
import { audienceTreeFromDsl, type Cond } from "../lib/targeting-tree";

const names: Names = { goal: (id) => (id === "g_lead" ? "資料請求" : id), audience: (id) => (id === "aud_p" ? "料金ページ閲覧" : id) };
const c = (x: Record<string, unknown>) => ({ id: "1", kind: "cond", ...x }) as Cond;

describe("条件の要約(設計書 §12)", () => {
  it("条件ごとの日本語の要約", () => {
    expect(condText(c({ type: "visited", neg: false, page: { part: "path", op: "startsWith", value: "/pricing/" }, min: 2, within: 30 }), names)).toBe("パスが「/pricing/」で始まるページを 2 回以上閲覧(最後の閲覧が 30 日以内)");
    expect(condText(c({ type: "visited", neg: true, page: { part: "path", op: "regex", value: "^/a" }, min: 1, within: 7 }), names)).toBe("パスが「^/a」に一致するページを過去 7 日に閲覧していない");
    expect(condText(c({ type: "goal", neg: true, goal: "g_lead", within: null }), names)).toBe("目標「資料請求」が未達成");
    expect(condText(c({ type: "time", days: ["fri", "mon", "tue", "wed", "thu"], allDay: false, from: 9, to: 18 }), names)).toBe("月〜金 の 09:00〜18:00");
    expect(condText(c({ type: "time", days: ["fri"], allDay: false, from: 22, to: 2 }), names)).toBe("金 の 22:00〜翌 02:00");
    expect(condText(c({ type: "browser", neg: false, values: ["safari", "chrome"] }), names)).toBe("ブラウザが Safari・Chrome のいずれか");
    expect(condText(c({ type: "host", op: "endsWith", value: "example.com" }), names)).toBe("ホストが「example.com」で終わる");
    expect(condText(c({ type: "audience", neg: true, audience: "aud_p" }), names)).toBe("オーディエンス「料金ページ閲覧」に含まれない");
  });
  it("グループの要約(除外・入れ子)と、DSL の要約", () => {
    const tree = audienceTreeFromDsl({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { or: [{ ctx: "referrer", op: "isEmpty" }, { hist: "converted", goal: "g_lead" }] } }] })!;
    expect(groupText(tree, names, true)).toBe("端末が モバイル かつ (次を除く[リファラーが空(直接の流入) または 目標「資料請求」を達成済み])");
    expect(summarizeDsl(null, names)).toBe("全員");
    expect(summarizeDsl({ hist: "visited", pattern: "p" }, names)).toBe("(この画面で表せない条件)");
    for (const d of [false, 42, { and: [null] }, { ctx: "time", days: ["mon"], extra: 1 }, { hist: "visited", page: {} }]) expect(summarizeDsl(d, names)).toBe("(この画面で表せない条件)"); // 例外を出さない
    expect(dslHasHistory({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { hist: "converted", goal: "g" } }] })).toBe(true);
    expect(dslHasHistory({ ctx: "sinceFirstVisit", op: "gte", days: 1 })).toBe(false); // 初回の訪問からの経過は履歴を使わない
  });
  it("保存の前の確認(値の入力漏れ・範囲・期間の上限・正規表現)", () => {
    expect(condProblem(c({ type: "path", op: "startsWith", value: "" }), 90)).toBe("値を入力してください");
    expect(condProblem(c({ type: "path", op: "regex", value: "a{2,}" }), 90)).toBe("正規表現を直してください");
    expect(condProblem(c({ type: "viewport", op: "between", min: 800, max: 600 }), 90)).toBe("範囲は小さい幅から大きい幅の順にしてください");
    expect(condProblem(c({ type: "time", days: ["mon"], allDay: false, from: 9, to: 9 }), 90)).toMatch(/同じ時刻/);
    expect(condProblem(c({ type: "goal", neg: false, goal: "g_lead", within: 120 }), 90)).toBe("期間は訪問者データの保存期間(90 日)以下にしてください");
    expect(condProblem(c({ type: "elapsed", op: "gte", n: 0, unit: "hours" }), 90)).toBe("1〜8760 の整数で入力してください");
    expect(treeProblem([c({ type: "device", neg: false, values: ["mobile"] }), c({ type: "browser", neg: false, values: [] })], 90)).toBe("「ブラウザ」の条件: 1 つ以上選んでください");
    expect(treeProblem([c({ type: "device", neg: false, values: ["mobile"] })], 90)).toBeNull();
  });
  it("期間は、指定なし(null)のときだけ検査しない。日数の欄の空欄(NaN)・0・負数・小数は保存の前に止める(期間を黙って消さない)", () => {
    expect(periodProblem(null, 90)).toBeNull();
    expect(periodProblem(30, 90)).toBeNull();
    for (const n of [NaN, 0, -1, 1.5]) expect(periodProblem(n, 90)).toBe("期間は 1〜3650 の整数で入力してください");
    expect(periodProblem(91, 90)).toBe("期間は訪問者データの保存期間(90 日)以下にしてください");
    expect(condProblem(c({ type: "visited", neg: false, page: { part: "path", op: "startsWith", value: "/a" }, min: 1, within: NaN }), 90)).toBe("期間は 1〜3650 の整数で入力してください");
  });
});
