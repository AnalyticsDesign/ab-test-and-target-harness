import { describe, expect, it } from "vitest";
import {
  audienceDefinitionIssue, expandAudiences, experimentTargetingIssue, findLegacyTargeting, findRemovedPageCondition, maxWithinDays, normalizeTargeting,
  PAGE_CONDITION_MOVED_AUDIENCE_HINT, PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE, PAGE_CONDITION_MOVED_HINT, PAGE_CONDITION_MOVED_MESSAGE,
  regexIssueIn, REMOVED_PAGE_CTX, targetingReferences, TargetingInputSchema, TargetingReadSchema, usesCondition, type Targeting,
} from "../src/targeting";
import { dslDepth, REMOVED_CONDITION_DESCRIPTION, StoredCtxReadSchema } from "../src/schema";

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
  it("期間の N は 1〜3650 の整数", () => {
    expect(TargetingInputSchema.safeParse(V({ withinDays: 0 })).success).toBe(false);
    expect(TargetingInputSchema.safeParse(V({ withinDays: 3651 })).success).toBe(false);
  });
});

/** B69 で配信条件・オーディエンスから外したページの条件(保存する形) */
const REMOVED: Array<Record<string, unknown>> = [
  { ctx: "query", name: "a", op: "exists" },
  { ctx: "query", name: "utm", op: "equals", value: "" },
  { ctx: "query", name: "utm", op: "contains", value: "mail" },
  { ctx: "url", op: "contains", value: "/lp/" },
  { ctx: "url", op: "regex", value: "a" },
  { ctx: "host", op: "endsWith", value: "example.com" },
  { ctx: "path", op: "regex", value: "^/a/" },
];

describe("ページの条件を外した(B69)", () => {
  it("stored_targeting_rejects_page_ctx(保存する形は 4 種類を受けない。and の中・not の下でも)", () => {
    for (const leaf of REMOVED) {
      expect(TargetingInputSchema.safeParse(leaf).success).toBe(false);
      expect(TargetingInputSchema.safeParse({ and: [V(), { not: leaf }] }).success).toBe(false);
    }
    expect(TargetingInputSchema.safeParse({ ctx: "device", op: "in", value: ["mobile"] }).success).toBe(true);
  });
  it("read_schema_accepts_removed(読み取りの応答の形は 4 種類も受け、説明を付ける)", () => {
    for (const leaf of REMOVED) {
      expect(TargetingReadSchema.safeParse(leaf).success).toBe(true);
      expect(TargetingReadSchema.safeParse({ and: [V(), { not: leaf }, { audience: "aud_x" }] }).success).toBe(true);
    }
    // 形の合わない古い条件(命令列付き・名前の無い query)は読み取りでも受けない
    expect(TargetingReadSchema.safeParse({ ctx: "path", op: "regex", value: "^/a", prog: { v: 1, sets: [], code: [5, 0, 0] } }).success).toBe(false);
    expect(TargetingReadSchema.safeParse({ ctx: "query", op: "exists" }).success).toBe(false);
    // 今の条件も受ける(保存の入力と同じ)
    expect(TargetingReadSchema.safeParse({ and: [V({ min: 2 }), C(), { ctx: "device", op: "in", value: ["mobile"] }] }).success).toBe(true);
    // 古い 4 種類の葉には説明が付く(OpenAPI の describe)
    const leaves = (StoredCtxReadSchema as unknown as { options: Array<{ description?: string }> }).options;
    expect(leaves.filter((o) => o.description === REMOVED_CONDITION_DESCRIPTION)).toHaveLength(6); // url・host・path・query 3 つ
    expect(REMOVED_CONDITION_DESCRIPTION).toBe("使えなくなった条件。対象 URL に移すまで保存できない");
  });
  it("find_removed_page_condition_paths(最初の位置。壊れた値でも例外を投げない)", () => {
    expect(REMOVED_PAGE_CTX).toEqual(["url", "host", "path", "query"]);
    expect(findRemovedPageCondition({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { ctx: "path", op: "equals", value: "/a" } }] })).toEqual(["and", 1, "not"]);
    expect(findRemovedPageCondition({ or: [V(), { ctx: "query", name: "a", op: "exists" }] })).toEqual(["or", 1]);
    expect(findRemovedPageCondition({ ctx: "url", op: "contains", value: "/" })).toEqual([]);
    expect(findRemovedPageCondition({ ctx: "host" }, ["targeting"])).toEqual(["targeting"]);
    expect(findRemovedPageCondition({ and: [V(), { ctx: "referrer", op: "isEmpty" }] })).toBeNull();
    for (const broken of [null, undefined, "x", 1, [], { and: "x" }, { and: [null, 1, "s"] }, { not: null }, { ctx: 1 }, { or: [{ not: { not: {} } }] }]) {
      expect(findRemovedPageCondition(broken)).toBeNull();
    }
  });
  it("案内の文言(エクスペリエンス・オーディエンス)", () => {
    expect(PAGE_CONDITION_MOVED_MESSAGE).toBe("ページの URL・ホスト・パス・パラメータの条件は、配信条件では使えなくなりました");
    expect(PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE).toBe("ページの URL・ホスト・パス・パラメータの条件は、オーディエンスでは使えなくなりました");
    expect(PAGE_CONDITION_MOVED_HINT).toContain("対象 URL(urlMatch)で指定してください");
    expect(PAGE_CONDITION_MOVED_HINT).toContain('{ "include": [{ "page": { "part": "path", "op": "startsWith", "value": "/lp/" } }] }');
    expect(PAGE_CONDITION_MOVED_AUDIENCE_HINT).toBe("エクスペリエンスの対象 URL で指定してください。このオーディエンスを使うエクスペリエンスごとに書きます");
  });
});

describe("normalizeTargeting(保存時の正規化)", () => {
  it("子が 1 つのグループを畳み、min: 1 と part: url を省く", () => {
    expect(normalizeTargeting({ and: [{ or: [{ ctx: "device", op: "in", value: ["mobile"] }] }, V({ min: 1 })] } as Targeting)).toEqual({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, V()] });
    expect(normalizeTargeting({ hist: "visited", page: { part: "url", op: "contains", value: "/a" } } as Targeting)).toEqual({ hist: "visited", page: { op: "contains", value: "/a" } });
  });
  it("not(not(x)) は x。閲覧の条件のホスト・パスの値は正規化(正規表現は ¥ を \\ に)", () => {
    expect(normalizeTargeting({ not: { not: V({ min: 2 }) } })).toEqual(V({ min: 2 }));
    expect(normalizeTargeting(V({ page: { part: "path", op: "regex", value: "^/p/¥d" } }))).toEqual(V({ page: { part: "path", op: "regex", value: "^/p/\\d" } }));
    expect(normalizeTargeting(V({ page: { part: "host", op: "equals", value: "A.Example." } }))).toEqual(V({ page: { part: "host", op: "equals", value: "a.example" } }));
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
    expect(experimentTargetingIssue({ and: [V(), { not: C() }, { not: { audience: "a" } }, { not: { ctx: "device", op: "in", value: ["mobile"] } }] } as Targeting)).toBeNull();
    expect(experimentTargetingIssue({ not: { ctx: "referrer", op: "contains", value: "x" } } as Targeting)).toBeNull();
  });
  it("入れ子・グループの除外・否定の形を持たない条件の not・否定した閲覧の回数を止める(位置付き)", () => {
    expect(experimentTargetingIssue({ and: [V(), { or: [V(), C()] }] })).toMatchObject({ code: "invalid_experiment_targeting", path: ["and", 1] });
    expect(experimentTargetingIssue({ not: { and: [V(), C()] } })).toMatchObject({ path: [] });
    expect(experimentTargetingIssue({ not: { ctx: "time", days: ["mon"] } } as Targeting)?.message).toBe("この条件は否定の形では使えません");
    expect(experimentTargetingIssue({ not: { ctx: "viewport", minWidth: 768 } } as Targeting)?.code).toBe("invalid_experiment_targeting");
    expect(experimentTargetingIssue({ not: { ctx: "referrer", op: "equals", value: "x" } } as Targeting)?.code).toBe("invalid_experiment_targeting");
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
    expect(regexIssueIn({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { or: [{ hist: "visited", page: { part: "path", op: "regex", value: "a{2,}" } }] }] } as Targeting)).toMatchObject({
      issue: { code: "regex_unbounded_repeat" }, path: ["and", 1, "or", 0, "page", "value"],
    });
    expect(regexIssueIn(V({ page: { part: "host", op: "regex", value: "^shop\\." } }))).toBeNull();
  });
});
