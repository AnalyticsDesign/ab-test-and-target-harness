import { describe, expect, it } from "vitest";
import { audienceDefinitionIssue, normalizeTargeting, type Targeting } from "@wtt/core";
import { COMPLETION_1_TARGETING } from "../../../packages/core/test/fixtures/completion-1";
import {
  audienceTreeFromDsl, condToDsl, definitionBody, edit, experimentFormFromDsl, experimentFormToDsl, insertNode, moveNode, moveTargets, nestLevels, reorder, toDsl,
  type Cond, type Dsl, type Group,
} from "../lib/targeting-tree";

const P = (part: "path" | "host" | undefined, op: string, value: string) => (part ? { part, op, value } : { op, value });
const V = (extra: Record<string, unknown> = {}): Dsl => ({ hist: "visited", page: P("path", "startsWith", "/pricing/"), ...extra });
const norm = (d: Dsl) => normalizeTargeting(d as unknown as Targeting);

describe("DSL と画面の木(決定 49、設計書 §4.1.1)", () => {
  it("api_targeting_round_trips_through_admin(DSL → 画面 → DSL で変わらない。比べる相手は control の保存時の正規化)", () => {
    const cases: Dsl[] = [
      { hist: "visited", page: P("path", "startsWith", "/pricing/"), min: 2, withinDays: 13 }, // 期間 13 日(7 / 30 / 90 以外)
      { not: V() },
      { not: { hist: "visited", page: P("host", "endsWith", "example.com"), withinDays: 30 } },
      // API で作った任意の入れ子(グループの除外・条件の否定を含む)
      { and: [V(), { or: [{ ctx: "device", op: "in", value: ["mobile"] }, { and: [{ not: { ctx: "time", days: ["mon"], from: "22:00", to: "02:00" } }, { not: { or: [{ ctx: "browser", op: "in", value: ["safari"] }, { ctx: "os", op: "in", value: ["ios"] }] } }] }] }] },
      { not: { ctx: "time", days: ["fri", "sat"] } },
      { not: { ctx: "viewport", minWidth: 768 } },
      { not: { ctx: "path", op: "startsWith", value: "/a" } },
      { not: { ctx: "host", op: "endsWith", value: "example.com" } },
      { and: [{ not: { hist: "converted", goal: "g_lead", withinDays: 7 } }, { ctx: "sinceFirstVisit", op: "gte", hours: 24 }, { ctx: "query", name: "u", op: "contains", value: "m" }, { not: { ctx: "query", name: "u", op: "exists" } }, { not: { ctx: "referrer", op: "isEmpty" } }, { ctx: "viewport", minWidth: 320, maxWidth: 768 }, { ctx: "path", op: "regex", value: "^/p/\\d+$" }, { not: { ctx: "url", op: "contains", value: "x" } }] },
    ];
    for (const d of cases) expect(toDsl(audienceTreeFromDsl(d)!)).toEqual(norm(d));
    // 子が 1 つのグループは、control と同じく畳み込まれる
    const one = { and: [{ or: [V()] }, { ctx: "device", op: "in", value: ["mobile"] }] };
    expect(toDsl(audienceTreeFromDsl(one)!)).toEqual(norm(one));
    // エクスペリエンスのフォーム(1 段の and / or)
    for (const d of [{ and: [{ audience: "a" }, { not: { audience: "b" } }, { not: V() }, { ctx: "time", days: ["mon"], from: "09:00", to: "18:00" }] }, { not: { ctx: "url", op: "equals", value: "x" } }, V({ withinDays: 13 })] as Dsl[])
      expect(experimentFormToDsl(experimentFormFromDsl(d)!)).toEqual(norm(d));
  });
  it("エクスペリエンスのフォームで表せない形は null(否定の形を持たない条件の not・入れ子・グループの除外・古い書式)", () => {
    for (const d of [{ not: { ctx: "time", days: ["mon"] } }, { and: [V(), { or: [V(), V()] }] }, { not: { and: [V(), V()] } }, { hist: "visited", pattern: "p_x" }] as Dsl[])
      expect(experimentFormFromDsl(d)).toBeNull();
    expect(audienceTreeFromDsl({ hist: "visited", pattern: "p" })).toBeNull();
    expect(experimentFormFromDsl(null)).toEqual({ logic: "and", rows: [] });
  });
  it("空のグループは消え、条件が 1 つも無ければ null(= 全員)", () => {
    const root: Group = { id: "r", kind: "group", logic: "and", exclude: false, collapsed: false, children: [{ id: "g", kind: "group", logic: "or", exclude: true, collapsed: false, children: [] }] };
    expect(toDsl(root)).toBeNull();
  });
  it("期間の指定なしは within: null で表し、withinDays を出さない。数値なら(0・NaN でも)withinDays を出す(黙って期間を落とさない)", () => {
    const visited = (within: number | null): Cond => ({ id: "1", kind: "cond", type: "visited", neg: false, page: { part: "path", op: "startsWith", value: "/pricing/" }, min: 1, within });
    const goal = (within: number | null): Cond => ({ id: "2", kind: "cond", type: "goal", neg: true, goal: "g_lead", within });
    expect(condToDsl(visited(null))).toEqual({ hist: "visited", page: { part: "path", op: "startsWith", value: "/pricing/" } });
    expect(condToDsl(visited(30))).toEqual({ hist: "visited", page: { part: "path", op: "startsWith", value: "/pricing/" }, withinDays: 30 });
    expect(condToDsl(goal(null))).toEqual({ not: { hist: "converted", goal: "g_lead" } });
    expect(condToDsl(goal(7))).toEqual({ not: { hist: "converted", goal: "g_lead", withinDays: 7 } });
    expect(condToDsl(visited(0))).toHaveProperty("withinDays", 0); // 保存の前の確認(periodProblem)が止める値も、変換では落とさない
  });
  it("想定外の保存値は変換せず null(= 読み取り専用)にし、例外を出さない(core の形と意味の検査を先に通す。plan ② P16)", () => {
    const odd: unknown[] = [false, 42, { and: [null] }, { ctx: "time", days: ["mon"], extra: 1 }, { hist: "visited", page: {} }];
    for (const d of odd) {
      expect(() => experimentFormFromDsl(d)).not.toThrow();
      expect(experimentFormFromDsl(d)).toBeNull();
      expect(() => audienceTreeFromDsl(d)).not.toThrow();
      expect(audienceTreeFromDsl(d)).toBeNull();
      expect(definitionBody(audienceTreeFromDsl(d))).toEqual({}); // raw のまま名前だけを保存しても definition を送らない
    }
    expect(definitionBody(audienceTreeFromDsl(V()))).toEqual({ definition: V() });
  });
  it("完成の基準 1 の条件を画面で作ると、保存される JSON が edge・ブラウザの判定のテストと同じ値になる", () => {
    const rows: Cond[] = [
      { id: "1", kind: "cond", type: "visited", neg: false, page: { part: "path", op: "startsWith", value: "/pricing/" }, min: 2, within: 30 },
      { id: "2", kind: "cond", type: "goal", neg: true, goal: "g_lead", within: null },
      { id: "3", kind: "cond", type: "time", days: ["mon", "tue", "wed", "thu", "fri"], allDay: false, from: 9, to: 18 },
      { id: "4", kind: "cond", type: "os", neg: false, values: ["ios"] },
      { id: "5", kind: "cond", type: "browser", neg: false, values: ["safari"] },
    ];
    expect(experimentFormToDsl({ logic: "and", rows })).toEqual(COMPLETION_1_TARGETING);
  });
});

describe("木の操作(入れ子の上限・移動・並べ替え)", () => {
  const deep = (n: number): Dsl => (n === 0 ? V() : { and: [V(), deep(n - 1)] });
  const innermost = (g: Group): Group => {
    const child = g.children.find((c) => c.kind === "group") as Group | undefined;
    return child ? innermost(child) : g;
  };
  const emptyGroup = (): Group => ({ id: "x", kind: "group", logic: "and", exclude: false, collapsed: false, children: [] });
  it("一番外側の中に 4 段まで。超える操作は取り消す(null)", () => {
    const four = audienceTreeFromDsl(deep(5))!; // 一番外側 + 入れ子 4 段
    expect(nestLevels(four) - 1).toBe(4);
    expect(edit(four, (c) => insertNode(c, innermost(c).id, emptyGroup()))).toBeNull();
    const three = audienceTreeFromDsl(deep(4))!;
    expect(edit(three, (c) => insertNode(c, innermost(c).id, emptyGroup()))).not.toBeNull();
  });
  it("否定の形を持たない条件の not は除外したグループとして開くので、core の入れ子の数え方(audienceDefinitionIssue)と画面の段数が一致する(plan ② P5)", () => {
    // 一番外側 + and を重ね、一番内側に not(x) を置く(各 and は子 2 つなので畳まれない)。not(and) は今までどおりグループ 1 つ
    const wrap = (n: number, inner: Dsl): Dsl => (n === 0 ? inner : { and: [V(), wrap(n - 1, inner)] });
    const negated: Dsl[] = [
      { ctx: "time", days: ["mon"] },
      { ctx: "viewport", minWidth: 768 },
      { ctx: "path", op: "startsWith", value: "/a" },
      { ctx: "host", op: "endsWith", value: "example.com" },
      { and: [V(), { ctx: "device", op: "in", value: ["mobile"] }] },
    ];
    for (const x of negated) {
      const atLimit = wrap(4, { not: x }); // 一番外側 + and 3 段 + 除外したグループ = 入れ子 4 段
      expect(audienceDefinitionIssue(atLimit as unknown as Targeting)).toBeNull();
      expect(nestLevels(audienceTreeFromDsl(atLimit)!) - 1).toBe(4);
      const over = wrap(5, { not: x }); // 1 段深い
      expect(audienceDefinitionIssue(over as unknown as Targeting)?.code).toBe("invalid_audience_definition");
      expect(audienceTreeFromDsl(over)).toBeNull(); // core の検査を通らない値は画面では読み取り専用
    }
  });
  it("移動先の候補は今の親・自分の中・上限を超える行き先を除く", () => {
    const root = audienceTreeFromDsl({ and: [{ or: [V(), { and: [V(), V()] }] }, V()] })!;
    const orGroup = root.children[0] as Group;
    const andGroup = orGroup.children[1] as Group;
    const targets = moveTargets(root, orGroup.id, (g, level) => `${level}:${g.logic}`).map((t) => t.label);
    expect(targets).toEqual([]); // 親(一番外側)と自分の中(or と and)しか無い
    expect(moveTargets(root, root.children[1]!.id, (g, level) => `${level}:${g.logic}`).map((t) => t.label)).toEqual(["1:or", "2:and"]);
    const moved = edit(root, (c) => moveNode(c, root.children[1]!.id, andGroup.id))!;
    expect(toDsl(moved)).toEqual({ or: [V(), { and: [V(), V(), V()] }] }); // 一番外側の子が 1 つになったので畳まれる
  });
  it("moveNode の末尾への移動(index 省略)は、移動元を削除する前の長さで位置を求める(二重に補正しない)", () => {
    const A: Dsl = { ctx: "device", op: "in", value: ["mobile"] };
    const B: Dsl = { ctx: "os", op: "in", value: ["ios"] };
    const C: Dsl = { ctx: "browser", op: "in", value: ["safari"] };
    const toEnd = (d: Dsl, pick: number) => {
      const root = audienceTreeFromDsl(d)!;
      return toDsl(edit(root, (c) => moveNode(c, root.children[pick]!.id, root.id))!);
    };
    expect(toEnd({ and: [A, B, C] }, 0)).toEqual({ and: [B, C, A] });
    expect(toEnd({ and: [A, B, C] }, 1)).toEqual({ and: [A, C, B] });
    expect(toEnd({ and: [A, B] }, 0)).toEqual({ and: [B, A] });
    // 別のグループの末尾へ
    const root = audienceTreeFromDsl({ and: [A, { or: [B, C] }] })!;
    const orGroup = root.children[1] as Group;
    expect(toDsl(edit(root, (c) => moveNode(c, root.children[0]!.id, orGroup.id))!)).toEqual({ or: [B, C, A] }); // 一番外側の子が 1 つになったので畳まれる
  });
  it("reorder は前に置く位置で並べ替える(1 段のリスト)", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(["a", "b", "c"], 1, 3)).toEqual(["a", "c", "b"]); // 末尾へ
  });
});
