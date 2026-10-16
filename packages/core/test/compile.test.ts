import { describe, it, expect } from "vitest";
import { compile, CompileError } from "../src/compile";
import { patternIdOf } from "../src/pattern-id";
import { compileRegex, REGEX_LIMITS } from "../src/regex-compile";
import { CompiledConfigSchema, type CompiledConfig, type Experiment } from "../src/schema";
import { parseCompiledConfig } from "../src/config-read";

const exp = (targeting?: unknown, persist = false): Experiment => ({
  id: "exp_001", name: "hero",
  urlMatch: { op: "contains", value: "/lp/" },
  ...(targeting ? { targeting: targeting as never } : {}),
  trafficPercentage: 100, persistAssignment: persist,
  variants: [
    { id: "vA", name: "A", weight: 50, changes: [] },
    { id: "vB", name: "B", weight: 50, changes: [
      { id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "B案" } },
      { id: "c2", type: "CSS", payload: { css: ".x{}" } },
    ] },
  ],
});

const base = { siteId: "site_1", siteSalt: "salt_test", version: 1, retentionDays: 90, goals: [{ id: "g_lead", name: "lead", type: "CUSTOM" as const, config: {} }] };

const PRICING = { part: "path" as const, op: "startsWith" as const, value: "/pricing/" };

describe("compile", () => {
  it("produces schemaVersion 2 config with prehide/exposureSelectors from change selectors", () => {
    const cfg = compile({ ...base, experiments: [exp()] });
    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.needsProfile).toBe(false);
    expect(cfg.exposureSelectors["exp_001"]).toEqual([".hero-title", ":root"]); // CSS(selector なし)は :root で表す(決定 38)
    expect(cfg.prehide["exp_001"]).toEqual([".hero-title"]);
    expect(cfg.patterns).toEqual({}); // 参照されないパターンは含めない
    expect(cfg.goals).toHaveLength(1);
  });
  it("selectorless_change_adds_root_to_exposure_selectors_only", () => {
    // spec §10.5 / 決定 38 (1): CSS(selector なし)を含む Experiment は対照も起動直後に Exposure させるため
    // exposureSelectors にだけ :root を足す。prehide に足すとページ全体が opacity:0 になる
    const cfg = compile({ ...base, experiments: [exp()] }); // exp() の vB は TEXT + CSS
    expect(cfg.exposureSelectors["exp_001"]).toEqual([".hero-title", ":root"]);
    expect(cfg.prehide["exp_001"]).toEqual([".hero-title"]);

    // CSS だけの Variant でも同じ(selector の和集合が空でも :root は入る)
    const cssOnly: Experiment = { ...exp(), variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [{ id: "c2", type: "CSS", payload: { css: ".x{}" } }] },
    ] };
    const cfg2 = compile({ ...base, experiments: [cssOnly] });
    expect(cfg2.exposureSelectors["exp_001"]).toEqual([":root"]);
    expect(cfg2.prehide["exp_001"]).toEqual([]);

    // selector 付きの Change だけなら従来どおり :root は入らない
    const noCss: Experiment = { ...exp(), variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "B" } }] },
    ] };
    expect(compile({ ...base, experiments: [noCss] }).exposureSelectors["exp_001"]).toEqual([".hero-title"]);

    // selector として :root を既に使っていれば二重に足さない(r1 CX-Low-1)
    const rootSel: Experiment = { ...exp(), variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [
        { id: "c1", type: "ATTRIBUTE", selector: ":root", payload: { name: "data-theme", value: "b" } },
        { id: "c2", type: "CSS", payload: { css: ".x{}" } },
      ] },
    ] };
    const cfg3 = compile({ ...base, experiments: [rootSel] });
    expect(cfg3.exposureSelectors["exp_001"]).toEqual([":root"]);
    expect(cfg3.prehide["exp_001"]).toEqual([":root"]); // prehide は selector の和集合のまま(:root は運用者の選択)
  });
  it("needsProfile=true when persistAssignment=true (spec 6.3)", () => {
    const cfg = compile({ ...base, experiments: [exp(undefined, true)] });
    expect(cfg.needsProfile).toBe(true);
  });
  it("needsProfile=true when a hist condition is used, and the visited page becomes a pattern keyed by its hash", () => {
    const cfg = compile({ ...base, experiments: [exp({ hist: "visited", page: PRICING })] });
    expect(cfg.needsProfile).toBe(true);
    const id = patternIdOf(PRICING);
    expect(cfg.patterns).toEqual({ [id]: PRICING });
    expect(cfg.experiments[0]!.targeting).toEqual({ hist: "visited", pattern: id });
  });
  // spec 18.1(決定 49 で旧名のテストを置き換え): URL パターンの ID を参照する古い書式は Publish で止める
  it("legacy_targeting_publish_fails", () => {
    for (const t of [{ hist: "visited", pattern: "p_pricing" }, { and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { hist: "page_view_count", pattern: "p", gte: 2 } }] }]) {
      expect(() => compile({ ...base, experiments: [exp(t)] })).toThrowError(expect.objectContaining({ code: "legacy_targeting", message: expect.stringContaining("エクスペリエンス exp_001 の配信条件") }));
    }
  });
  it("pattern_id_is_stable_across_count_and_period(回数・期間だけが違う閲覧の条件は 1 つのパターンを共有する)", () => {
    const e1 = { ...exp({ hist: "visited", page: PRICING, min: 2 }), id: "exp_a" };
    const e2 = { ...exp({ and: [{ hist: "visited", page: { ...PRICING, value: "/pricing/" }, withinDays: 30 }, { not: { hist: "visited", page: PRICING, withinDays: 7 } }] }), id: "exp_b" };
    const cfg = compile({ ...base, experiments: [e1, e2] });
    const id = patternIdOf(PRICING);
    expect(Object.keys(cfg.patterns)).toEqual([id]);
    expect(cfg.experiments[0]!.targeting).toEqual({ hist: "visited", pattern: id, min: 2 });
    expect(cfg.experiments[1]!.targeting).toEqual({ and: [{ hist: "visited", pattern: id, withinDays: 30 }, { not: { hist: "visited", pattern: id, withinDays: 7 } }] });
    // 期間の条件を足しても ID は変わらない(期間なしの設定と同じ ID)
    expect(compile({ ...base, experiments: [exp({ hist: "visited", page: PRICING })] }).patterns).toHaveProperty(id);
  });
  it("unknown goal reference fails", () => {
    expect(() => compile({ ...base, experiments: [exp({ hist: "converted", goal: "g_nope" })] }))
      .toThrowError(expect.objectContaining({ code: "unknown_goal" }));
  });
  it("rejects config over 512KB with config_too_large", () => {
    const big = exp();
    big.variants[1]!.changes = Array.from({ length: 9 }, (_, i) => ({
      id: `c${i}`, type: "TEXT" as const, selector: ".hero-title", payload: { text: "x".repeat(60000) },
    }));
    expect(() => compile({ ...base, experiments: [big] }))
      .toThrowError(expect.objectContaining({ code: "config_too_large" }));
  });
  it("validates input experiments with zod (invalid_input)", () => {
    const bad = exp();
    (bad.variants[0] as { weight: number }).weight = 60; // 合計 110
    expect(() => compile({ ...base, experiments: [bad] }))
      .toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });
  it.each([
    [{ ...base, siteId: "", experiments: [exp()] }],
    [{ ...base, version: 0, experiments: [exp()] }],
    [null],
  ])("invalid input reports invalid_input: %#", (input) => {
    expect(() => compile(input as never)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });
  it("compiled config carries siteSalt (spec §4.3)", () => {
    const base = { siteId: "s1", siteSalt: "salt_test", version: 1, experiments: [], goals: [] };
    expect(compile(base).siteSalt).toBe("salt_test");
    const { siteSalt: _omit, ...noSalt } = base;
    expect(() => compile(noSalt)).toThrow(CompileError); // 欠落は invalid_input
  });
  it("site id boundary: 64 chars accepted, 65 rejected(r2 CX-Medium-8)", () => {
    const base = { siteId: "s".repeat(64), siteSalt: "salt_test", version: 1, experiments: [], goals: [] };
    expect(compile(base).siteId).toBe("s".repeat(64));
    expect(() => compile({ ...base, siteId: "s".repeat(65) })).toThrow(CompileError);
  });

  it("experiment_overrides_experiment_name_and_variant_overrides_variant_name", () => {
    // spec §10.9 合成規則(2026-09-02 決定): Experiment 名は Experiment が、Variant 名は Variant が決める
    const e = exp();
    (e as unknown as Record<string, unknown>).analytics = {
      overrides: { experimentName: "Hero Q3" },
      extra: { test_group: "pricing_q3", external_exp_id: "E-101" },
    };
    (e.variants[1] as unknown as Record<string, unknown>).analytics = {
      overrides: { variantName: "New hero" },
      extra: { test_group: "pricing_q3_b", campaign: "autumn" },
    };
    const cfg = compile({ ...base, experiments: [e] });
    // vA: experimentName は Experiment の override、variantName は導出値(Variant の name)。extra は Experiment のもの
    expect(cfg.exposurePayloads!["exp_001"]!["vA"]).toEqual({
      experimentId: "exp_001", experimentName: "Hero Q3", variantId: "vA", variantName: "A",
      extra: { test_group: "pricing_q3", external_exp_id: "E-101" },
    });
    // vB: variantName は Variant の override。extra はキー単位の浅いマージで Variant が同名キーを上書き
    expect(cfg.exposurePayloads!["exp_001"]!["vB"]).toEqual({
      experimentId: "exp_001", experimentName: "Hero Q3", variantId: "vB", variantName: "New hero",
      extra: { test_group: "pricing_q3_b", external_exp_id: "E-101", campaign: "autumn" },
    });
    // レベルをまたぐ上書きは入口(schema)で拒否される。compile は invalid_input で落ちる
    const crossed = exp();
    (crossed as unknown as Record<string, unknown>).analytics = { overrides: { variantName: "For all" } };
    expect(() => compile({ ...base, experiments: [crossed] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    const crossed2 = exp();
    (crossed2.variants[1] as unknown as Record<string, unknown>).analytics = { overrides: { experimentName: "Mine" } };
    expect(() => compile({ ...base, experiments: [crossed2] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    // 導出値のみ(analytics 無し)でも必ずエントリを焼く。extra は {}
    const plain = compile({ ...base, experiments: [exp()] });
    expect(plain.exposurePayloads).toEqual({
      exp_001: {
        vA: { experimentId: "exp_001", experimentName: "hero", variantId: "vA", variantName: "A", extra: {} },
        vB: { experimentId: "exp_001", experimentName: "hero", variantId: "vB", variantName: "B", extra: {} },
      },
    });
  });

  it("analytics_extra_over_20_keys_rejected", () => {
    const keys = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, "v"]));
    const e = exp();
    (e as unknown as Record<string, unknown>).analytics = { extra: keys(15, "e") };
    (e.variants[1] as unknown as Record<string, unknown>).analytics = { extra: keys(6, "v") }; // 合成後 21
    expect(() => compile({ ...base, experiments: [e] })).toThrowError(expect.objectContaining({ code: "invalid_analytics" }));
    // 検証は解決後の姿に対して行う: 同名キーは 1 つに数える(15 + 同じ 15 = 15 で通る)
    (e.variants[1] as unknown as Record<string, unknown>).analytics = { extra: keys(15, "e") };
    expect(compile({ ...base, experiments: [e] }).exposurePayloads!["exp_001"]!["vB"]!.extra).toEqual(keys(15, "e"));
    // ちょうど 20 は通る
    (e as unknown as Record<string, unknown>).analytics = { extra: keys(20, "e") };
    (e.variants[1] as unknown as Record<string, unknown>).analytics = undefined;
    expect(Object.keys(compile({ ...base, experiments: [e] }).exposurePayloads!["exp_001"]!["vA"]!.extra)).toHaveLength(20);
    // 著者側スキーマの規則違反(値 101 字)は invalid_input(zod)で落ちる
    (e as unknown as Record<string, unknown>).analytics = { extra: { k: "x".repeat(101) } };
    expect(() => compile({ ...base, experiments: [e] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("compile_strips_authored_analytics_from_experiments", () => {
    const e = exp();
    (e as unknown as Record<string, unknown>).analytics = { overrides: { experimentName: "Hero Q3" } };
    (e.variants[1] as unknown as Record<string, unknown>).analytics = { extra: { k: "v" } };
    const cfg = compile({ ...base, experiments: [e] });
    expect("analytics" in cfg.experiments[0]!).toBe(false);
    for (const v of cfg.experiments[0]!.variants) expect("analytics" in v).toBe(false);
    // 「生」と「解決済み」を同居させない契約はスキーマでも守られる: 著者の analytics が experiments[] に残った config は strict で拒否
    const leaked = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
    (leaked.experiments as Array<Record<string, unknown>>)[0]!.analytics = { extra: { k: "v" } };
    expect(CompiledConfigSchema.safeParse(leaked).success).toBe(false);
    // exposurePayloads を持たない旧 config は parse できる(optional。§10.9「バージョンと異常時」)
    const { exposurePayloads: _omit, ...legacy } = cfg;
    expect(CompiledConfigSchema.safeParse(legacy).success).toBe(true);
    expect(cfg.schemaVersion).toBe(2);
  });

  it("exposure payload entries must match their record keys and refer to existing experiments / variants (spec §10.9 contract)", () => {
    const cfg = compile({ ...base, experiments: [exp()] });
    const clone = (): CompiledConfig => JSON.parse(JSON.stringify(cfg)) as CompiledConfig;
    let c = clone();
    c.exposurePayloads!["exp_001"]!["vB"]!.experimentId = "exp_other";
    expect(CompiledConfigSchema.safeParse(c).success).toBe(false); // 外側キーと payload.experimentId の不一致
    c = clone();
    c.exposurePayloads!["exp_001"]!["vB"]!.variantId = "vA";
    expect(CompiledConfigSchema.safeParse(c).success).toBe(false); // 内側キーと payload.variantId の不一致
    c = clone();
    c.exposurePayloads!["exp_ghost"] = { vA: { experimentId: "exp_ghost", experimentName: "G", variantId: "vA", variantName: "A", extra: {} } };
    expect(CompiledConfigSchema.safeParse(c).success).toBe(false); // 存在しない Experiment
    c = clone();
    c.exposurePayloads!["exp_001"]!["vZ"] = { experimentId: "exp_001", experimentName: "hero", variantId: "vZ", variantName: "Z", extra: {} };
    expect(CompiledConfigSchema.safeParse(c).success).toBe(false); // 存在しない Variant
    c = clone();
    c.exposurePayloads!["exp_001"]!["vB"]!.variantName = "";
    expect(CompiledConfigSchema.safeParse(c).success).toBe(false); // 空名(min(1))
    c = clone();
    delete c.exposurePayloads!["exp_001"]!["vB"];
    expect(CompiledConfigSchema.safeParse(c).success).toBe(true); // 欠落エントリは runtime のフォールバック対象なので許可
  });

  it("a compiled config containing an empty html payload is rejected by parseCompiledConfig (edge fail-closed, Plan 10 B2 / r1 CL-High-2)", () => {
    const cfg = JSON.parse(JSON.stringify(compile({ ...base, experiments: [exp()] }))) as CompiledConfig;
    const vB = cfg.experiments[0]!.variants[1]!; // noUncheckedIndexedAccess(tsconfig.base.json)のため要素を確定させる(r2 CX-Medium-5)
    vB.changes = [{ id: "c_e", type: "HTML", selector: ".hero", payload: { html: "", position: "replace", runScripts: false } }];
    expect(parseCompiledConfig(cfg)).toBeNull(); // edge はこの config を読めず、その Site は配信停止(fail-closed)
    vB.changes = [{ id: "c_e", type: "HTML", selector: ".hero", payload: { html: "<b>x</b>", position: "replace", runScripts: false } }];
    expect(parseCompiledConfig(cfg)).not.toBeNull();
  });
});

describe("compile: 版 2(決定 49)", () => {
  const withTargeting = (targeting: unknown, urlMatch: unknown = { op: "contains", value: "/lp/" }) => ({ ...exp(), urlMatch, targeting }) as never;

  it("保存する形を正規化してから配る形にする(min: 1 と part: url を省く・子 1 つのグループを畳む・期間を写す)", () => {
    const cfg = compile({ ...base, experiments: [withTargeting({ and: [{ or: [{ hist: "visited", page: { part: "url", op: "contains", value: "/pricing/" }, min: 1 }] }, { hist: "converted", goal: "g_lead", withinDays: 7 }] })] });
    const id = patternIdOf({ op: "contains", value: "/pricing/" });
    expect(cfg.experiments[0]!.targeting).toEqual({ and: [{ hist: "visited", pattern: id }, { hist: "converted", goal: "g_lead", withinDays: 7 }] });
    expect(cfg.patterns).toEqual({ [id]: { op: "contains", value: "/pricing/" } });
    expect(cfg.needsProfile).toBe(true);
  });

  it("パス・ホストの正規表現に命令列を付ける(対象 URL・目標・配信条件)。値は ¥ を \\ に置き換えてから", () => {
    const cfg = compile({
      ...base,
      goals: [{ id: "g_thanks", name: "thanks", type: "PAGEVIEW", config: { page: { part: "path", op: "regex", value: "^/thanks/¥d+$" } } }],
      experiments: [withTargeting({ ctx: "host", op: "regex", value: "^shop\\." }, { part: "path", op: "regex", value: "^/lp/" })],
    });
    const goal = cfg.goals[0]!;
    expect(goal.type === "PAGEVIEW" && goal.config.page).toMatchObject({ part: "path", op: "regex", value: "^/thanks/\\d+$", prog: { v: 1 } });
    expect(cfg.experiments[0]!.urlMatch).toMatchObject({ part: "path", op: "regex", prog: { v: 1 } });
    expect(cfg.experiments[0]!.targeting).toMatchObject({ ctx: "host", op: "regex", prog: { v: 1 } });
  });

  it("文字列の一致のホスト・パスは正規化する(小文字化・末尾ドット・punycode・日本語のエンコード)。part: url は省く", () => {
    const cfg = compile({
      ...base,
      experiments: [withTargeting({ and: [{ ctx: "host", op: "endsWith", value: "Example.COM." }, { ctx: "path", op: "startsWith", value: "/料金/" }] }, { part: "url", op: "contains", value: "/lp/" })],
    });
    expect(cfg.experiments[0]!.urlMatch).toEqual({ op: "contains", value: "/lp/" });
    expect(cfg.experiments[0]!.targeting).toEqual({ and: [{ ctx: "host", op: "endsWith", value: "example.com" }, { ctx: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" }] });
  });

  it("url の正規表現は invalid_regex(配信条件・対象 URL・目標・パターンのどこでも)", () => {
    const cases: Array<() => unknown> = [
      () => compile({ ...base, experiments: [withTargeting({ ctx: "url", op: "regex", value: "a" })] }),
      () => compile({ ...base, experiments: [withTargeting(undefined, { op: "regex", value: "a" })] }),
      () => compile({ ...base, goals: [{ id: "g", name: "g", type: "PAGEVIEW", config: { page: { op: "regex", value: "a" } } }], experiments: [] }),
      () => compile({ ...base, experiments: [withTargeting({ hist: "visited", page: { op: "regex", value: "a" } })] }),
    ];
    for (const run of cases) expect(run).toThrowError(expect.objectContaining({ code: "invalid_regex" }));
  });

  it("許可リストに無い書き方は invalid_regex、1 つ 200 命令超は regex_too_large", () => {
    expect(() => compile({ ...base, experiments: [withTargeting({ ctx: "path", op: "regex", value: "(?=a)" })] })).toThrowError(expect.objectContaining({ code: "invalid_regex" }));
    expect(() => compile({ ...base, experiments: [withTargeting({ ctx: "path", op: "regex", value: ".{0,100}" })] })).toThrowError(expect.objectContaining({ code: "regex_too_large" }));
  });

  it("regex_instruction_budget_is_enforced_per_regex_and_site(サイト全体 500 命令超は regex_budget_exceeded。大きいものから並べる)", () => {
    const big = (k: number) => ({ part: "path", op: "regex", value: `^/${k}.{0,97}` }); // 1 つ 199 命令前後
    const three = [1, 2, 3].map((k) => ({ ...exp(), id: `exp_${k}`, urlMatch: big(k) })) as never[];
    const err = (() => {
      try {
        compile({ ...base, experiments: three });
      } catch (e) {
        return e as CompileError;
      }
      return null;
    })();
    expect(err?.code).toBe("regex_budget_exceeded");
    expect(err?.message).toMatch(/エクスペリエンス exp_\d の対象 URL\(\d+\)/);
    expect(compile({ ...base, experiments: three.slice(0, 2) }).experiments).toHaveLength(2);
  });

  it("タイムゾーンを config に入れる。IANA 名でなければ invalid_input", () => {
    expect(compile({ ...base, timezone: "Asia/Tokyo", experiments: [] }).timezone).toBe("Asia/Tokyo");
    expect(compile({ ...base, experiments: [] }).timezone).toBeUndefined();
    expect(() => compile({ ...base, timezone: "Mars/Olympus", experiments: [] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("目標の PAGEVIEW は保存形 { page } を受ける(版 1 の { urlOp, urlValue } は invalid_input)", () => {
    expect(compile({ ...base, goals: [{ id: "g", name: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks" } } }], experiments: [] }).goals[0]).toEqual({ id: "g", name: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks" } } });
    expect(() => compile({ ...base, goals: [{ id: "g", name: "g", type: "PAGEVIEW", config: { urlOp: "contains", urlValue: "/thanks" } }], experiments: [] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("新しい条件はそのまま配る形に入る(sinceFirstVisit は履歴に数えない)", () => {
    const t = { and: [{ ctx: "viewport", minWidth: 768 }, { ctx: "time", days: ["mon"], from: "09:00", to: "18:00" }, { ctx: "sinceFirstVisit", op: "gte", days: 7 }, { ctx: "browser", op: "in", value: ["safari"] }] };
    const cfg = compile({ ...base, experiments: [withTargeting(t)] });
    expect(cfg.experiments[0]!.targeting).toEqual(t);
    expect(cfg.needsProfile).toBe(false);
  });

  describe("オーディエンスの展開と保存する形の検査(決定 49、設計書 §4.3・§5)", () => {
    const AUD = { and: [{ hist: "visited", page: PRICING, min: 2 }, { not: { hist: "converted", goal: "g_lead" } }] };
    it("参照をその時点の定義で置き換え、パターン ID を決める(not の下も)", () => {
      const cfg = compile({ ...base, audiences: { aud_p: AUD }, experiments: [withTargeting({ and: [{ audience: "aud_p" }, { not: { audience: "aud_p" } }] })] });
      const id = patternIdOf(PRICING);
      const expanded = { and: [{ hist: "visited", pattern: id, min: 2 }, { not: { hist: "converted", goal: "g_lead" } }] };
      expect(cfg.experiments[0]!.targeting).toEqual({ and: [expanded, { not: expanded }] });
      expect(cfg.needsProfile).toBe(true);
    });
    it("参照されないオーディエンスは検査も展開もしない(壊れていても Publish を止めない)", () => {
      expect(() => compile({ ...base, audiences: { aud_broken: { hist: "visited", pattern: "p" } }, experiments: [exp()] })).not.toThrow();
    });
    it("存在しない参照・古い書式・形の制限違反・オーディエンスの中の参照・保存期間を超える期間は止める", () => {
      const fail = (input: Record<string, unknown>, code: string) => expect(() => compile({ ...base, ...input })).toThrowError(expect.objectContaining({ code }));
      fail({ experiments: [withTargeting({ audience: "aud_none" })] }, "unknown_audience");
      fail({ audiences: { aud_old: { hist: "visited", pattern: "p" } }, experiments: [withTargeting({ audience: "aud_old" })] }, "legacy_targeting");
      fail({ experiments: [withTargeting({ and: [{ hist: "visited", page: PRICING }, { or: [{ ctx: "device", op: "in", value: ["mobile"] }, { ctx: "device", op: "in", value: ["tablet"] }] }] })] }, "invalid_experiment_targeting");
      fail({ audiences: { aud_nest: { and: [{ audience: "aud_p" }] }, aud_p: AUD }, experiments: [withTargeting({ audience: "aud_nest" })] }, "invalid_audience_definition");
      fail({ experiments: [withTargeting({ hist: "visited", page: PRICING, withinDays: 91 })] }, "within_days_exceeds_retention");
      fail({ audiences: { aud_long: { hist: "converted", goal: "g_lead", withinDays: 120 } }, experiments: [withTargeting({ audience: "aud_long" })] }, "within_days_exceeds_retention");
      fail({ audiences: { aud_g: { hist: "converted", goal: "g_none" } }, experiments: [withTargeting({ audience: "aud_g" })] }, "unknown_goal");
    });
    it("形の制限違反の message には保存 422 と同じ直し方(hint)が続く(Publish の hint にそのまま出る。v0.9 の入れ子の配信条件)", () => {
      const nested = { and: [{ hist: "visited", page: PRICING }, { or: [{ ctx: "device", op: "in", value: ["mobile"] }, { ctx: "device", op: "in", value: ["tablet"] }] }] };
      expect(() => compile({ ...base, experiments: [withTargeting(nested)] })).toThrowError(
        expect.objectContaining({ code: "invalid_experiment_targeting", message: expect.stringContaining("配信条件ではグループを入れ子にできません。入れ子のグループやグループの除外が要るときは、オーディエンスで作って配信条件で選んでください") }),
      );
      expect(() => compile({ ...base, audiences: { aud_nest: { and: [{ audience: "aud_p" }] }, aud_p: AUD }, experiments: [withTargeting({ audience: "aud_nest" })] })).toThrowError(
        expect.objectContaining({ code: "invalid_audience_definition", message: expect.stringContaining("「既存のオーディエンスから取り込む」でコピーできます") }),
      );
    });
    it("retentionDays を省いた入力(fixture)では期間の上限を見ない", () => {
      const { retentionDays: _r, ...noRetention } = base;
      expect(() => compile({ ...noRetention, experiments: [withTargeting({ hist: "visited", page: PRICING, withinDays: 3650 })] })).not.toThrow();
    });
    it("同じオーディエンスの正規表現は参照の数だけ数え、合計が上限を超えたら hint の場所に原因のオーディエンスを出す(plan ② P20)", () => {
      // 命令数は compileRegex で測り、上限に収まる最大の参照数 n を求める(数え方を確かめる。式の命令数そのものには依存しない)
      const src = "^/(ja|en)/products/[0-9]+$";
      const r = compileRegex(src);
      if (!r.ok) throw new Error(r.issue.code);
      const audiences = { aud_rx: { ctx: "path", op: "regex", value: src } };
      const exps = (k: number) => Array.from({ length: k }, (_, i) => ({ ...exp({ audience: "aud_rx" }), id: `exp_${i}` }));
      const n = Math.floor(REGEX_LIMITS.instructionsPerSite / r.instructions);
      expect(() => compile({ ...base, audiences, experiments: exps(n) })).not.toThrow();
      expect(() => compile({ ...base, audiences, experiments: exps(n + 1) })).toThrowError(
        expect.objectContaining({ code: "regex_budget_exceeded", message: expect.stringContaining("エクスペリエンス exp_0 の配信条件(オーディエンス aud_rx)") }),
      );
    });
    it("閲覧したページの条件の正規表現は、何件のエクスペリエンスから使ってもパターン ID ごとに 1 回だけ数える(plan ② P20)", () => {
      const src = "^/(ja|en)/products/[0-9]+$";
      const r = compileRegex(src);
      if (!r.ok) throw new Error(r.issue.code);
      const n = Math.floor(REGEX_LIMITS.instructionsPerSite / r.instructions) + 1; // ctx の正規表現なら上限を超える件数
      const visited = { hist: "visited", page: { part: "path", op: "regex", value: src } };
      const cfg = compile({ ...base, experiments: Array.from({ length: n }, (_, i) => ({ ...exp(visited), id: `exp_${i}` })) });
      expect(Object.keys(cfg.patterns)).toHaveLength(1);
    });
  });
});

describe("experiment kind (決定 51、設計書 §3.1・§3.2)", () => {
  const single = (id = "exp_s") => ({
    id, name: "personalize", kind: "single" as const,
    urlMatch: { op: "contains" as const, value: "/lp/" },
    trafficPercentage: 100, persistAssignment: false,
    variants: [{ id: "a", name: "A", weight: 100, changes: [{ id: "c1", type: "TEXT" as const, selector: ".hero-title", payload: { text: "S" } }] }],
  });

  it("compiled_config_schema_accepts_single_variant_experiment", () => {
    const cfg = compile({ ...base, experiments: [single()] });
    expect(cfg.experiments[0]!.variants).toHaveLength(1);
    expect(CompiledConfigSchema.safeParse(cfg).success).toBe(true);
    const read = parseCompiledConfig(JSON.parse(JSON.stringify(cfg))); // 戻り値は CompiledConfig | null(レビュー r2 CX-Medium-4)
    expect(read).not.toBeNull();
    if (read === null) throw new Error("parseCompiledConfig rejected a single-variant config");
    expect(read.experiments[0]!.variants).toHaveLength(1);
  });

  it("does not put kind into the compiled config", () => {
    const cfg = compile({ ...base, experiments: [single(), { ...exp(), kind: "test" }] });
    for (const e of cfg.experiments) expect(e).not.toHaveProperty("kind");
  });

  it("treats a missing kind as a test", () => {
    const oneVariant = { ...exp(), variants: [{ id: "vA", name: "A", weight: 100, changes: [] }] };
    expect(() => compile({ ...base, experiments: [oneVariant] })).toThrow(CompileError);
  });

  it("rejects a single with two variants and a test with one variant", () => {
    const codeOf = (input: unknown): string | null => {
      try {
        compile(input);
        return null;
      } catch (e) {
        return e instanceof CompileError ? e.code : "other";
      }
    };
    const twoVariants = { ...single(), variants: [{ id: "a", name: "A", weight: 50, changes: [] }, { id: "b", name: "B", weight: 50, changes: [] }] };
    expect(codeOf({ ...base, experiments: [twoVariants] })).toBe("invalid_input");
    const testWithOne = { ...exp(), kind: "test" as const, variants: [{ id: "vA", name: "A", weight: 100, changes: [] }] };
    expect(codeOf({ ...base, experiments: [testWithOne] })).toBe("invalid_input");
  });

  it("keeps the input order of experiments (the order is the priority, 設計書 §3.2)", () => {
    const cfg = compile({ ...base, experiments: [single("exp_z"), { ...exp(), id: "exp_b" }, { ...exp(), id: "exp_a" }] });
    expect(cfg.experiments.map((e) => e.id)).toEqual(["exp_z", "exp_b", "exp_a"]);
  });
});
