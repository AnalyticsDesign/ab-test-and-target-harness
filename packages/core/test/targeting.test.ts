import { describe, expect, it } from "vitest";
import {
  audienceDefinitionIssue, expandAudiences, experimentTargetingIssue, findLegacyTargeting, maxWithinDays, normalizeTargeting,
  regexIssueIn, targetingReferences, TargetingInputSchema, usesCondition, type Targeting,
} from "../src/targeting";
import { dslDepth } from "../src/schema";

const PRICING = { part: "path" as const, op: "startsWith" as const, value: "/pricing/" };
const V = (extra: Record<string, unknown> = {}): Targeting => ({ hist: "visited", page: PRICING, ...extra }) as Targeting;
const C = (extra: Record<string, unknown> = {}): Targeting => ({ hist: "converted", goal: "g_lead", ...extra }) as Targeting;

describe("保存する形のスキーマ(形だけ)", () => {
  it("閲覧の条件は page を直接持ち、期間と回数を持てる。オーディエンスの参照を受ける", () => {
    expect(TargetingInputSchema.parse({ and: [V({ min: 2, withinDays: 30 }), C({ withinDays: 7 }), { audience: "aud_x" }, { not: { ctx: "time", days: ["mon"] } }] })).toBeTruthy();
  });
  it("古い書式(パターン ID・page_view_count)は形として受けない", () => {
    expect(TargetingInputSchema.safeParse({ hist: "visited", pattern: "p_x" }).success).toBe(false);
    expect(TargetingInputSchema.safeParse({ hist: "page_view_count", pattern: "p_x", gte: 2 }).success).toBe(false);
  });
  it("期間の N は 1〜3650 の整数。命令列は持たない", () => {
    expect(TargetingInputSchema.safeParse(V({ withinDays: 0 })).success).toBe(false);
    expect(TargetingInputSchema.safeParse(V({ withinDays: 3651 })).success).toBe(false);
    expect(TargetingInputSchema.safeParse({ ctx: "path", op: "regex", value: "^/a", prog: { v: 1, sets: [], code: [5, 0, 0] } }).success).toBe(false);
  });
});

describe("normalizeTargeting(保存時の正規化)", () => {
  it("子が 1 つのグループを畳み、min: 1 と part: url を省く", () => {
    expect(normalizeTargeting({ and: [{ or: [{ ctx: "device", op: "in", value: ["mobile"] }] }, V({ min: 1 })] } as Targeting)).toEqual({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, V()] });
    expect(normalizeTargeting({ hist: "visited", page: { part: "url", op: "contains", value: "/a" } } as Targeting)).toEqual({ hist: "visited", page: { op: "contains", value: "/a" } });
  });
  it("not(not(x)) は x。ホスト・パスの値は正規化(正規表現は ¥ を \\ に)", () => {
    expect(normalizeTargeting({ not: { not: V({ min: 2 }) } })).toEqual(V({ min: 2 }));
    expect(normalizeTargeting({ and: [{ ctx: "host", op: "equals", value: "A.Example." }, { not: { ctx: "path", op: "regex", value: "^/p/¥d" } }, { ctx: "url", op: "contains", value: "/A/" }] } as Targeting)).toEqual({
      and: [{ ctx: "host", op: "equals", value: "a.example" }, { not: { ctx: "path", op: "regex", value: "^/p/\\d" } }, { ctx: "url", op: "contains", value: "/A/" }],
    });
    expect(normalizeTargeting(V({ page: { part: "path", op: "startsWith", value: "/料金/" }, withinDays: 30 }))).toEqual(V({ page: { part: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" }, withinDays: 30 }));
  });
});

describe("古い書式の検出(zod より先に見る)", () => {
  it("パターン ID を参照する閲覧の条件の位置を返す", () => {
    expect(findLegacyTargeting({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { hist: "page_view_count", pattern: "p", gte: 2 } }] })).toEqual(["and", 1, "not"]);
    expect(findLegacyTargeting({ hist: "visited", pattern: "p" })).toEqual([]);
    expect(findLegacyTargeting(V())).toBeNull();
    expect(findLegacyTargeting(null)).toBeNull();
    expect(findLegacyTargeting("x")).toBeNull();
  });
});

describe("エクスペリエンスの配信条件の形の制限(設計書 §4.2・§4.1.1)", () => {
  it("条件・否定の形を持つ条件の not・1 段の and / or を受ける", () => {
    expect(experimentTargetingIssue({ and: [V(), { not: C() }, { not: { audience: "a" } }, { not: { ctx: "path", op: "regex", value: "^/a" } }] } as Targeting)).toBeNull();
    expect(experimentTargetingIssue({ not: { ctx: "url", op: "equals", value: "x" } } as Targeting)).toBeNull();
  });
  it("入れ子・グループの除外・否定の形を持たない条件の not・否定した閲覧の回数を止める(位置付き)", () => {
    expect(experimentTargetingIssue({ and: [V(), { or: [V(), C()] }] })).toMatchObject({ code: "invalid_experiment_targeting", path: ["and", 1] });
    expect(experimentTargetingIssue({ not: { and: [V(), C()] } })).toMatchObject({ path: [] });
    expect(experimentTargetingIssue({ not: { ctx: "time", days: ["mon"] } } as Targeting)?.message).toBe("この条件は否定の形では使えません");
    expect(experimentTargetingIssue({ not: { ctx: "path", op: "startsWith", value: "/a" } } as Targeting)?.code).toBe("invalid_experiment_targeting");
    expect(experimentTargetingIssue({ not: { ctx: "host", op: "endsWith", value: "a.example" } } as Targeting)?.code).toBe("invalid_experiment_targeting");
    expect(experimentTargetingIssue({ or: [{ not: V({ min: 2 }) }] })).toMatchObject({ path: ["or", 0, "not", "min"] });
  });
});

describe("オーディエンスの定義の検査(設計書 §4.5・§5.5)", () => {
  const deep = (n: number): Targeting => (n === 0 ? V() : { and: [V(), deep(n - 1)] });
  it("グループは一番外側の中に 4 段まで(一番外側がグループでなければ、画面が補う一番外側を数えて 4 段まで)", () => {
    expect(audienceDefinitionIssue(deep(5))).toBeNull();
    expect(audienceDefinitionIssue(deep(6))?.code).toBe("invalid_audience_definition");
    expect(audienceDefinitionIssue({ not: deep(4) })).toBeNull();
    expect(audienceDefinitionIssue({ not: deep(5) })?.code).toBe("invalid_audience_definition");
  });
  it("上限ちょうどの形(一番外側 + 入れ子 4 段 × (グループ + 除外) + 条件の否定 + 条件)は深さ 11 で通る", () => {
    const deepEx = (n: number): Targeting => (n === 0 ? { not: C() } : { not: { and: [V(), deepEx(n - 1)] } });
    const worst = { and: [V(), deepEx(4)] };
    expect(dslDepth(worst)).toBe(11);
    expect(audienceDefinitionIssue(worst)).toBeNull();
  });
  it("オーディエンスの中では別のオーディエンスを使えない。否定した閲覧は回数を持てない", () => {
    expect(audienceDefinitionIssue({ and: [{ audience: "x" }] })).toMatchObject({ path: ["and", 0] });
    expect(audienceDefinitionIssue({ not: V({ min: 2 }) })).toMatchObject({ path: ["not", "min"] });
    expect(audienceDefinitionIssue({ not: { ctx: "time", days: ["mon"] } } as Targeting)).toBeNull(); // オーディエンスでは否定の形を持たない条件も除外できる
  });
});

describe("参照・期間・展開・正規表現", () => {
  it("maxWithinDays / targetingReferences / usesCondition は型を問わず JSON をたどる(古い書式でも落ちない)", () => {
    expect(maxWithinDays({ and: [V({ withinDays: 30 }), { not: C({ withinDays: 90 }) }] })).toBe(90);
    expect(maxWithinDays({ hist: "page_view_count", pattern: "p", gte: 2 })).toBe(0);
    expect(targetingReferences({ and: [{ audience: "a" }, { not: C() }, { audience: "a" }, { hist: "visited", pattern: "p" }] })).toEqual({ goals: ["g_lead"], audiences: ["a"] });
    expect(usesCondition({ or: [{ not: { ctx: "viewport", minWidth: 768 } }] }, "viewport")).toBe(true);
    expect(usesCondition(V(), "viewport")).toBe(false);
  });
  it("expandAudiences は参照をその時点の定義で置き換える(not の下も)", () => {
    expect(expandAudiences({ and: [{ not: { audience: "a" } }, V()] }, () => ({ or: [V(), C()] }))).toEqual({ and: [{ not: { or: [V(), C()] } }, V()] });
  });
  it("regexIssueIn は閲覧の条件の page も見る(URL 全体の正規表現は使えない)", () => {
    expect(regexIssueIn({ and: [{ hist: "visited", page: { op: "regex", value: "a" } }] } as Targeting)).toMatchObject({ issue: { code: "regex_not_allowed_on_url" }, path: ["and", 0, "page", "value"] });
    expect(regexIssueIn({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { or: [{ ctx: "path", op: "regex", value: "a{2,}" }] }] } as Targeting)).toMatchObject({
      issue: { code: "regex_unbounded_repeat" }, path: ["and", 1, "or", 0, "value"],
    });
    expect(regexIssueIn({ ctx: "host", op: "regex", value: "^shop\\." } as Targeting)).toBeNull();
  });
});
