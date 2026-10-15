import { describe, it, expect } from "vitest";
import { matchesUrl, evaluateDsl, pickVariant, decide, dslNeedsProfile, experimentsForUrl, experimentUsesInvalidPattern, patternsForUrl } from "../src/evaluate";
import { bucketOf, inTraffic } from "../src/hash";
import type { CompiledConfig, Experiment, DslNode } from "../src/schema";
import { compileRegex } from "../src/regex-compile";
import { pageOf } from "../src/page";
import { evaluateWhatIf } from "../src/what-if";

const ctx = { url: "https://example.com/pricing/?utm_source=google", query: { utm_source: "google" }, device: "mobile" as const, referrer: "" };

describe("matchesUrl", () => {
  it.each([
    [{ op: "contains", value: "/pricing/" }, true],
    [{ op: "equals", value: "https://example.com/pricing/?utm_source=google" }, true],
    [{ op: "startsWith", value: "https://example.com/" }, true],
    [{ op: "regex", value: "/pricing/" }, false], // url は正規表現を持てない(命令列も無い)= 一致しない側。版 1 の legacy(RegExp)は B52 で削除
    [{ op: "contains", value: "/checkout/" }, false],
  ] as const)("%j -> %s", (m, expected) => expect(matchesUrl(ctx.url, m)).toBe(expected));
});

describe("evaluateDsl", () => {
  const profile = { goals: { g_lead: { count: 1 } }, pages: { p_pricing: { count: 3 } } };
  it("evaluates ctx conditions", () => {
    expect(evaluateDsl({ ctx: "device", op: "in", value: ["mobile"] }, ctx, null)).toBe(true);
    expect(evaluateDsl({ ctx: "query", name: "utm_source", op: "equals", value: "google" }, ctx, null)).toBe(true);
    expect(evaluateDsl({ ctx: "referrer", op: "isEmpty" }, ctx, null)).toBe(true);
  });
  it("evaluates hist conditions against profile", () => {
    expect(evaluateDsl({ hist: "converted", goal: "g_lead" }, ctx, profile)).toBe(true);
    expect(evaluateDsl({ hist: "visited", pattern: "p_pricing" }, ctx, profile)).toBe(true);
    expect(evaluateDsl({ hist: "visited", pattern: "p_pricing", min: 4 }, ctx, profile)).toBe(false);
    expect(evaluateDsl({ hist: "visited", pattern: "p_pricing", min: 3 }, ctx, profile)).toBe(true);
  });
  it("hist is null(判定できない)when profile is null (fail-closed)", () => {
    expect(evaluateDsl({ hist: "converted", goal: "g_lead" }, ctx, null)).toBeNull();
    expect(evaluateDsl({ not: { hist: "converted", goal: "g_lead" } }, ctx, null)).toBeNull(); // not の下でも広がらない
  });
  it("and/or combine", () => {
    const empty = { goals: {}, pages: {} };
    expect(evaluateDsl({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { or: [{ hist: "visited", pattern: "p_x" }, { ctx: "url", op: "contains", value: "/pricing/" }] }] }, ctx, empty)).toBe(true);
  });
});

describe("dslNeedsProfile", () => {
  it("detects hist anywhere in the tree", () => {
    expect(dslNeedsProfile({ ctx: "url", op: "contains", value: "/a" })).toBe(false);
    expect(dslNeedsProfile({ and: [{ ctx: "url", op: "contains", value: "/a" }, { not: { hist: "visited", pattern: "p" } }] })).toBe(true);
  });
});

function twoVariantExp(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp_001", name: "hero",
    urlMatch: { op: "contains", value: "/pricing/" },
    trafficPercentage: 100, persistAssignment: false,
    variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [] },
    ],
    ...overrides,
  } as Experiment;
}

describe("pickVariant / decide", () => {
  it("bucket < 5000 -> vA, else vB (weights 50/50)", () => {
    const exp = twoVariantExp();
    // 実測でバケットが前半/後半になる visitorId を見つけて固定する
    let idA = "", idB = "";
    for (let i = 0; i < 200 && (!idA || !idB); i++) {
      const v = `visitor-${i}`.padEnd(22, "0");
      const b = bucketOf(v, exp.id);
      if (b < 5000 && !idA) idA = v;
      if (b >= 5000 && !idB) idB = v;
    }
    expect(pickVariant(exp, idA)).toBe("vA");
    expect(pickVariant(exp, idB)).toBe("vB");
  });
  it("weight 0 variant is never picked", () => {
    const exp = twoVariantExp({ variants: [
      { id: "vA", name: "A", weight: 100, changes: [] },
      { id: "vB", name: "B", weight: 0, changes: [] },
    ]});
    for (let i = 0; i < 500; i++) expect(pickVariant(exp, `v-${i}`.padEnd(22, "0"))).toBe("vA");
  });
  it("decide returns [] when url does not match", () => {
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [twoVariantExp({ urlMatch: { op: "contains", value: "/checkout/" } })] };
    expect(decide(config, ctx, "A".repeat(22), null)).toEqual([]);
  });
  it("persist_true_reuses_valid_assignment", () => {
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [twoVariantExp({ persistAssignment: true })] };
    const out = decide(config, ctx, "A".repeat(22), { goals: {}, pages: {} }, { exp_001: "vB" });
    expect(out).toEqual([{ experimentId: "exp_001", variantId: "vB" }]);
  });
  it("persist_true_deleted_variant_reassigns", () => {
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [twoVariantExp({ persistAssignment: true })] };
    const out = decide(config, ctx, "A".repeat(22), { goals: {}, pages: {} }, { exp_001: "vGone" });
    expect(["vA", "vB"]).toContain(out[0]!.variantId);
  });
  it("persist_false_ignores_stored_assignment", () => {
    const exp = twoVariantExp();
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
    const vid = "A".repeat(22);
    const hashPick = pickVariant(exp, vid);
    const out = decide(config, ctx, vid, null, { exp_001: hashPick === "vA" ? "vB" : "vA" });
    expect(out).toEqual([{ experimentId: "exp_001", variantId: hashPick }]);
  });
  it("persistent_assignment_with_unavailable_profile_returns_empty", () => {
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [twoVariantExp({ persistAssignment: true })] };
    expect(decide(config, ctx, "A".repeat(22), null)).toEqual([]);
  });
  it("decide_malformed_targeting_never_qualifies: schema を迂回した不正 node では対象にならない", () => {
    const exp = twoVariantExp({ targeting: { ctx: "query", name: "x", op: "equals" } as never });
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
    expect(decide(config, ctx, "A".repeat(22), null)).toEqual([]);
  });
  it("not_history_with_unavailable_profile_is_ineligible", () => {
    const exp = twoVariantExp({ targeting: { not: { hist: "converted", goal: "g_lead" } } });
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
    expect(decide(config, ctx, "A".repeat(22), null)).toEqual([]);
    const fresh = { goals: {}, pages: {} };
    expect(decide(config, ctx, "A".repeat(22), fresh)).toHaveLength(1);
  });
  it("persisted_assignment_overrides_traffic_reduction(決定 28)", () => {
    const exp = twoVariantExp({ persistAssignment: true, trafficPercentage: 1 });
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
    let excluded = "";
    for (let i = 0; i < 500 && !excluded; i++) {
      const v = `visitor-${i}`.padEnd(22, "0");
      if (!inTraffic(v, exp.id, 1)) excluded = v;
    }
    expect(excluded).not.toBe("");
    const fresh = { goals: {}, pages: {} };
    // 未割当なら traffic 縮小で除外される
    expect(decide(config, ctx, excluded, fresh)).toEqual([]);
    // 有効な保存済み割当があれば traffic 判定より優先して同じ Variant を返す
    expect(decide(config, ctx, excluded, fresh, { exp_001: "vB" })).toEqual([{ experimentId: "exp_001", variantId: "vB" }]);
  });
  it("stale_persisted_variant_does_not_bypass_traffic(決定 28: 削除済み Variant への割当は未割当扱い)", () => {
    const exp = twoVariantExp({ persistAssignment: true, trafficPercentage: 1 });
    const config: CompiledConfig = { schemaVersion: 2, version: 1, siteId: "s1", siteSalt: "salt_test", needsProfile: true, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [exp] };
    let excluded = "";
    for (let i = 0; i < 500 && !excluded; i++) {
      const v = `visitor-${i}`.padEnd(22, "0");
      if (!inTraffic(v, exp.id, 1)) excluded = v;
    }
    expect(decide(config, ctx, excluded, { goals: {}, pages: {} }, { exp_001: "vGone" })).toEqual([]);
  });
  it("device node with non-array value is fail-closed (Plan 1 review carryover)", () => {
    // schema を迂回した不正 node(value が文字列)でも throw せず null(判定できない = 対象外)
    const node = { ctx: "device", op: "in", value: "mobile" } as unknown as DslNode;
    const ctx = { url: "https://x.test/", query: {}, device: "mobile" as const, referrer: "" };
    expect(evaluateDsl(node, ctx, null)).toBeNull();
    expect(evaluateDsl({ not: node }, ctx, null)).toBeNull();
  });
});

describe("experimentsForUrl / patternsForUrl (spec §7.4 ③: edge が DO に渡す部分集合)", () => {
  const exp = (id: string, value: string) => ({
    id, name: id, urlMatch: { op: "contains" as const, value }, trafficPercentage: 100, persistAssignment: false,
    variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [] }],
  });
  const config = {
    schemaVersion: 2 as const, version: 1, siteId: "s", siteSalt: "x", needsProfile: true,
    patterns: { p_pricing: { op: "contains" as const, value: "/pricing" }, p_docs: { op: "startsWith" as const, value: "https://a/docs" } },
    prehide: {}, exposureSelectors: {}, goals: [],
    experiments: [exp("e_lp", "/lp"), exp("e_all", "/")],
  };
  it("URL に一致する Experiment だけを順序を保って返す", () => {
    expect(experimentsForUrl(config, "https://a/lp/x").map((e) => e.id)).toEqual(["e_lp", "e_all"]);
    expect(experimentsForUrl(config, "https://a/pricing").map((e) => e.id)).toEqual(["e_all"]);
  });
  it("URL に一致するパターン ID を返す(不一致は空)", () => {
    expect(patternsForUrl(config, "https://a/pricing?x=1")).toEqual(["p_pricing"]);
    expect(patternsForUrl(config, "https://a/docs/intro")).toEqual(["p_docs"]);
    expect(patternsForUrl(config, "https://b/other")).toEqual([]);
  });
  it("decide は needsProfile / experiments だけの部分集合でも動く(DO が config 全体を持たないため)", () => {
    const out = decide({ needsProfile: true, experiments: [exp("e_lp", "/lp")] }, { url: "https://a/lp", query: {}, device: "desktop", referrer: "" }, "B".repeat(43), { goals: {}, pages: {} });
    expect(out).toHaveLength(1);
    expect(out[0]!.experimentId).toBe("e_lp");
  });
  it("invalid_history_pattern_under_not_never_qualifies(参照するパターンの命令列が不正なら DO に渡す部分集合に入れない = 対象外。設計書 §10.3・§11.1)", () => {
    const broken = {
      ...config,
      // 未知の op の命令列(isValidProgram を通らない)。Profile はこのパターンを数えない
      patterns: { p: { part: "path" as const, op: "regex" as const, value: "x", prog: { v: 1, sets: [], code: [9, 0, 0] } } },
      experiments: [{ ...exp("X", "/"), targeting: { not: { hist: "visited" as const, pattern: "p" } } }, exp("Y", "/")],
    };
    expect(experimentUsesInvalidPattern(broken.experiments[0]!, broken.patterns)).toBe(true);
    const subset = experimentsForUrl(broken, "https://a/lp");
    expect(subset.map((e) => e.id)).toEqual(["Y"]);
    // 空の Profile(p を一度も数えていない)でも X は配信されない
    const out = decide({ needsProfile: true, experiments: subset }, { url: "https://a/lp", query: {}, device: "desktop", referrer: "" }, "B".repeat(43), { goals: {}, pages: {} });
    expect(out.map((r) => r.experimentId)).toEqual(["Y"]);
  });
  it("このページで判定できないパターン(256 字を超えるパスでのパスの正規表現)を参照する Experiment は対象外(plan ② P12)", () => {
    const r = compileRegex("^/pricing");
    if (!r.ok) throw new Error(r.issue.code);
    const cfg = {
      ...config,
      patterns: { p: { part: "path" as const, op: "regex" as const, value: "^/pricing", prog: r.prog } },
      experiments: [{ ...exp("X", "/"), targeting: { not: { hist: "visited" as const, pattern: "p" } } }, exp("Y", "/")],
    };
    const short = "https://a.example/lp";
    const long = `https://a.example/${"x".repeat(300)}`;
    expect(experimentUsesInvalidPattern(cfg.experiments[0]!, cfg.patterns, pageOf(short))).toBe(false);
    expect(experimentUsesInvalidPattern(cfg.experiments[0]!, cfg.patterns, pageOf(long))).toBe(true);
    expect(experimentsForUrl(cfg, short).map((e) => e.id)).toEqual(["X", "Y"]);
    expect(experimentsForUrl(cfg, long).map((e) => e.id)).toEqual(["Y"]); // 数えられないページで not(visited) を真にしない
    expect(patternsForUrl(cfg, long)).toEqual([]); // 数えもしない
  });
  it("evaluate の what-if も同じページで判定できないパターンを input_missing にする", () => {
    const r = compileRegex("^/pricing");
    if (!r.ok) throw new Error(r.issue.code);
    const patterns = { p: { part: "path" as const, op: "regex" as const, value: "^/pricing", prog: r.prog } };
    const x = { ...exp("X", "/"), targeting: { not: { hist: "visited" as const, pattern: "p" } } };
    const long = { url: `https://a.example/${"x".repeat(300)}`, query: {}, device: "desktop" as const, referrer: "" };
    const [res] = evaluateWhatIf([{ experiment: x, status: "running", published: true }], long, { patterns, history: { goals: {}, pages: {} } });
    expect(res!.reason).toBe("input_missing");
  });
});

describe("決定 49: 新しい条件(設計書 §3 / §8 / §11)", () => {
  const base = { url: "https://shop.example.com/pricing/plan?utm=mail", query: { utm: "mail" }, device: "mobile" as const, referrer: "" };
  const TUE_10_JST = Date.UTC(2026, 9, 6, 1, 0); // 2026-10-06(火)10:00 JST
  const p = (src: string) => {
    const r = compileRegex(src);
    if (!r.ok) throw new Error(r.issue.code);
    return r.prog;
  };

  it("ホスト・パス(文字列の一致・で終わるはラベル境界・正規表現)", () => {
    expect(evaluateDsl({ ctx: "host", op: "endsWith", value: "example.com" }, base, null)).toBe(true);
    expect(evaluateDsl({ ctx: "host", op: "endsWith", value: "ample.com" }, base, null)).toBe(false); // ラベル境界
    expect(evaluateDsl({ ctx: "path", op: "startsWith", value: "/pricing/" }, base, null)).toBe(true);
    expect(evaluateDsl({ ctx: "path", op: "regex", value: "^/pricing/[a-z]+$", prog: p("^/pricing/[a-z]+$") }, base, null)).toBe(true);
    expect(evaluateDsl({ ctx: "host", op: "regex", value: "^shop\\.", prog: p("^shop\\.") }, base, null)).toBe(true);
  });
  it("URL を解析できなければホスト・パスは判定できない(null)", () => {
    expect(evaluateDsl({ ctx: "path", op: "contains", value: "/" }, { ...base, url: "not a url" }, null)).toBeNull();
    expect(evaluateDsl({ ctx: "url", op: "contains", value: "not" }, { ...base, url: "not a url" }, null)).toBe(true); // URL は文字列のまま
  });
  it("long_path_skips_regex_condition: パスが 256 字を超えたらパスの正規表現は判定しない(not の下でも広がらない)", () => {
    const at = (len: number) => ({ ...base, url: `https://a.example/${"x".repeat(len - 1)}` }); // pathname の長さ = len
    const node = { ctx: "path", op: "regex", value: "x$", prog: p("x$") } as const;
    expect(evaluateDsl(node, at(256), null)).toBe(true);
    expect(evaluateDsl(node, at(257), null)).toBeNull();
    expect(evaluateDsl({ not: node }, at(257), null)).toBeNull();
    // 文字列の一致は長さの上限を持たない
    expect(evaluateDsl({ ctx: "path", op: "contains", value: "x" }, at(1000), null)).toBe(true);
  });
  it("命令列が不正なら判定しない(regex_program_invalid_is_failclosed)", () => {
    const bad: DslNode = { ctx: "path", op: "regex", value: "x", prog: { v: 1, sets: [], code: [0, 3, 0, 5, 0, 0] } };
    expect(evaluateDsl(bad, base, null)).toBeNull();
    expect(evaluateDsl({ not: bad }, base, null)).toBeNull();
  });
  it("クエリの含む", () => {
    expect(evaluateDsl({ ctx: "query", name: "utm", op: "contains", value: "ai" }, base, null)).toBe(true);
    expect(evaluateDsl({ ctx: "query", name: "none", op: "contains", value: "ai" }, base, null)).toBe(false);
    expect(evaluateDsl({ not: { ctx: "query", name: "none", op: "equals", value: "x" } }, base, null)).toBe(true); // 否定は値が無いと真
  });
  it("ブラウザ・OS(欠けていれば null)", () => {
    expect(evaluateDsl({ ctx: "browser", op: "in", value: ["safari"] }, { ...base, browser: "safari" }, null)).toBe(true);
    expect(evaluateDsl({ ctx: "os", op: "in", value: ["ios"] }, { ...base, os: "android" }, null)).toBe(false);
    expect(evaluateDsl({ ctx: "browser", op: "in", value: ["safari"] }, base, null)).toBeNull();
    expect(evaluateDsl({ not: { ctx: "os", op: "in", value: ["ios"] } }, base, null)).toBeNull();
  });
  it("画面の幅(以上 / 未満 / 範囲。欠けていれば null)", () => {
    const w = (viewportWidth: number) => ({ ...base, viewportWidth });
    expect(evaluateDsl({ ctx: "viewport", minWidth: 768 }, w(768), null)).toBe(true);
    expect(evaluateDsl({ ctx: "viewport", minWidth: 768 }, w(767), null)).toBe(false);
    expect(evaluateDsl({ ctx: "viewport", maxWidth: 768 }, w(767), null)).toBe(true);
    expect(evaluateDsl({ ctx: "viewport", maxWidth: 768 }, w(768), null)).toBe(false);
    expect(evaluateDsl({ ctx: "viewport", minWidth: 768, maxWidth: 1024 }, w(1023), null)).toBe(true);
    expect(evaluateDsl({ ctx: "viewport", minWidth: 768 }, base, null)).toBeNull();
    expect(evaluateDsl({ not: { ctx: "viewport", minWidth: 768 } }, base, null)).toBeNull();
  });
  it("曜日・時間帯(サイトのタイムゾーン。時刻・タイムゾーンが欠けていれば null)", () => {
    const node: DslNode = { ctx: "time", days: ["tue"], from: "09:00", to: "18:00" };
    expect(evaluateDsl(node, { ...base, now: TUE_10_JST }, null, "Asia/Tokyo")).toBe(true);
    expect(evaluateDsl(node, { ...base, now: TUE_10_JST }, null, "America/Los_Angeles")).toBe(false); // 月曜 18:00 PDT
    expect(evaluateDsl(node, base, null, "Asia/Tokyo")).toBeNull();
    expect(evaluateDsl(node, { ...base, now: TUE_10_JST }, null)).toBeNull();
    expect(evaluateDsl(node, { ...base, now: TUE_10_JST }, null, "Not/AZone")).toBeNull();
  });
  it("初回の訪問からの経過(v7 の時刻・不明 = 古い訪問者・未来の時刻は経過 0・欠けていれば null)", () => {
    const now = TUE_10_JST;
    const gte7d = { ctx: "sinceFirstVisit", op: "gte", days: 7 } as const;
    const lt24h = { ctx: "sinceFirstVisit", op: "lt", hours: 24 } as const;
    expect(evaluateDsl(gte7d, { ...base, now, firstVisitAt: now - 7 * 86_400_000 }, null)).toBe(true);
    expect(evaluateDsl(gte7d, { ...base, now, firstVisitAt: now - 7 * 86_400_000 + 1 }, null)).toBe(false);
    expect(evaluateDsl(lt24h, { ...base, now, firstVisitAt: now - 3_600_000 }, null)).toBe(true);
    expect(evaluateDsl(lt24h, { ...base, now, firstVisitAt: now + 3_600_000 }, null)).toBe(true); // 未来 = 経過 0 = 新規
    expect(evaluateDsl(gte7d, { ...base, now, firstVisitAt: null }, null)).toBe(true); // v4 の ID = 古い訪問者
    expect(evaluateDsl(lt24h, { ...base, now, firstVisitAt: null }, null)).toBe(false);
    expect(evaluateDsl(gte7d, { ...base, now }, null)).toBeNull(); // firstVisitAt が欠けている
    expect(evaluateDsl(gte7d, { ...base, firstVisitAt: now }, null)).toBeNull(); // 判定時刻が欠けている
  });
  it("期間(最後の閲覧 / 達成が N 日以内。lastAt は epoch 秒)", () => {
    const now = TUE_10_JST;
    const sec = (ms: number) => Math.floor(ms / 1000);
    const profile = { goals: { g: { count: 1, lastAt: sec(now - 3 * 86_400_000) } }, pages: { p: { count: 2, lastAt: sec(now - 31 * 86_400_000) } } };
    expect(evaluateDsl({ hist: "converted", goal: "g", withinDays: 7 }, { ...base, now }, profile)).toBe(true);
    expect(evaluateDsl({ hist: "converted", goal: "g", withinDays: 2 }, { ...base, now }, profile)).toBe(false);
    expect(evaluateDsl({ hist: "visited", pattern: "p", min: 2, withinDays: 30 }, { ...base, now }, profile)).toBe(false);
    expect(evaluateDsl({ not: { hist: "visited", pattern: "p", withinDays: 30 } }, { ...base, now }, profile)).toBe(true); // 過去 30 日に閲覧していない
    expect(evaluateDsl({ hist: "visited", pattern: "none", withinDays: 30 }, { ...base, now }, profile)).toBe(false); // 一度も無い
    // lastAt が無いのに期間の条件がある / 判定時刻が無い = 判定できない
    expect(evaluateDsl({ hist: "visited", pattern: "p", withinDays: 30 }, { ...base, now }, { goals: {}, pages: { p: { count: 1 } } })).toBeNull();
    expect(evaluateDsl({ hist: "visited", pattern: "p", withinDays: 30 }, base, profile)).toBeNull();
  });
  it("and / or は短絡しない: どこかの入力が欠けていれば結果が決まっていても null(edge とブラウザで同じ判定にする)", () => {
    const missing = { ctx: "viewport", minWidth: 1 } as const; // viewportWidth が無い
    expect(evaluateDsl({ or: [{ ctx: "device", op: "in", value: ["mobile"] }, missing] }, base, null)).toBeNull();
    expect(evaluateDsl({ and: [{ ctx: "device", op: "in", value: ["desktop"] }, missing] }, base, null)).toBeNull();
  });
  it("decide は判定できない Experiment を対象外にする(ほかの Experiment は判定する)", () => {
    const config = {
      needsProfile: false, timezone: "Asia/Tokyo",
      experiments: [twoVariantExp({ id: "e_vp", targeting: { ctx: "viewport", minWidth: 1 } }), twoVariantExp({ id: "e_dev", targeting: { ctx: "device", op: "in", value: ["mobile"] } })],
    };
    const c = { ...ctx, url: "https://example.com/pricing/" };
    expect(decide(config, c, "A".repeat(22), null).map((r) => r.experimentId)).toEqual(["e_dev"]);
    expect(decide(config, { ...c, viewportWidth: 390 }, "A".repeat(22), null).map((r) => r.experimentId)).toEqual(["e_vp", "e_dev"]);
  });
  it("対象 URL・パターンのパス / ホストの一致", () => {
    const config = {
      patterns: { p_path: { part: "path" as const, op: "regex" as const, value: "^/p/\\d+$", prog: p("^/p/\\d+$") }, p_host: { part: "host" as const, op: "equals" as const, value: "a.example" } },
      experiments: [twoVariantExp({ id: "e_host", urlMatch: { part: "host", op: "endsWith", value: "example" } })],
    };
    expect(patternsForUrl(config, "https://a.example/p/12")).toEqual(["p_path", "p_host"]);
    expect(patternsForUrl(config, "https://a.example/p/12x")).toEqual(["p_host"]);
    expect(experimentsForUrl(config, "https://b.example/").map((e) => e.id)).toEqual(["e_host"]);
  });
});
