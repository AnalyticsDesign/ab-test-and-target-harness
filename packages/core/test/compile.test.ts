import { describe, it, expect } from "vitest";
import { compile, CompileError, ExperimentInputSchema } from "../src/compile";
import type { z } from "zod";
import { patternIdOf } from "../src/pattern-id";
import { compileRegex, REGEX_LIMITS } from "../src/regex-compile";
import { CompiledConfigSchema, DslNodeSchema, LIMITS, regexInstructionTotal, type CompiledConfig } from "../src/schema";
import { parseCompiledConfig } from "../src/config-read";
import { decide, dslNeedsProfile, evaluateDsl, type PageContext } from "../src/evaluate";
import { evaluateWhatIf } from "../src/what-if";
import { bakeBootstrap, bootPayload } from "../src/bake";
import { staticInputDigest } from "../src/static-deploy";
import { parseSiteSettings } from "../src/settings";
import { maxWithinDays, PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE, PAGE_CONDITION_MOVED_MESSAGE } from "../src/targeting";

/** compile の入力のエクスペリエンス(kind は省略できる) */
type ExpIn = z.input<typeof ExperimentInputSchema>;
/** 対象 URL を含める 1 行で書く(B69) */
const url = (page: unknown) => ({ include: [{ page }] }) as never;

const exp = (targeting?: unknown, persist = false): ExpIn => ({
  id: "exp_001", name: "hero",
  urlMatch: url({ op: "contains", value: "/lp/" }),
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
  it("produces schemaVersion 3 config with prehide/exposureSelectors from change selectors", () => {
    const cfg = compile({ ...base, experiments: [exp()] });
    expect(cfg.schemaVersion).toBe(3);
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
    const cssOnly: ExpIn = { ...exp(), variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [{ id: "c2", type: "CSS", payload: { css: ".x{}" } }] },
    ] };
    const cfg2 = compile({ ...base, experiments: [cssOnly] });
    expect(cfg2.exposureSelectors["exp_001"]).toEqual([":root"]);
    expect(cfg2.prehide["exp_001"]).toEqual([]);

    // selector 付きの Change だけなら従来どおり :root は入らない
    const noCss: ExpIn = { ...exp(), variants: [
      { id: "vA", name: "A", weight: 50, changes: [] },
      { id: "vB", name: "B", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "B" } }] },
    ] };
    expect(compile({ ...base, experiments: [noCss] }).exposureSelectors["exp_001"]).toEqual([".hero-title"]);

    // selector として :root を既に使っていれば二重に足さない(r1 CX-Low-1)
    const rootSel: ExpIn = { ...exp(), variants: [
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
    // vA: experimentName は Experiment の override、variantName は指定が無いので Variant の ID(B77)。extra は Experiment のもの
    expect(cfg.exposurePayloads!["exp_001"]!["vA"]).toEqual({
      experimentId: "exp_001", experimentName: "Hero Q3", variantId: "vA", variantName: "vA",
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
    // 導出値のみ(analytics 無し)でも必ずエントリを焼く。名前は ID(B77: 管理用の名前は訪問者に届けない)。extra は {}
    const plain = compile({ ...base, experiments: [exp()] });
    expect(plain.exposurePayloads).toEqual({
      exp_001: {
        vA: { experimentId: "exp_001", experimentName: "exp_001", variantId: "vA", variantName: "vA", extra: {} },
        vB: { experimentId: "exp_001", experimentName: "exp_001", variantId: "vB", variantName: "vB", extra: {} },
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
    expect(cfg.schemaVersion).toBe(3);
  });

  it("compile_output_has_no_names", () => {
    // B77: エクスペリエンス・パターン・目標の名前は管理画面の中だけで使う。compiled config(訪問者のブラウザに届く)には出さない
    const e = exp();
    e.name = "社内の部長案";
    e.variants[1]!.name = "部長の推しパターン";
    const cfg = compile({ ...base, goals: [{ id: "g_lead", name: "社内の目標名", type: "CUSTOM", config: {} }], experiments: [e] });
    for (const x of cfg.experiments) {
      expect("name" in x).toBe(false);
      for (const v of x.variants) expect("name" in v).toBe(false);
    }
    for (const g of cfg.goals) expect("name" in g).toBe(false);
    const text = JSON.stringify(cfg);
    for (const name of ["社内の部長案", "部長の推しパターン", "社内の目標名"]) expect(text).not.toContain(name);
    // B69: 版 3 の CompiledConfigSchema は名前を受けない(エクスペリエンス・パターン・目標のどれでも。名前付きの版 2 は upgradeV2 が落とす)
    const named = (f: (c: Record<string, any>) => void) => {
      const c = JSON.parse(JSON.stringify(cfg));
      f(c);
      return CompiledConfigSchema.safeParse(c).success;
    };
    expect(named(() => {})).toBe(true);
    expect(named((c) => (c.experiments[0].name = "x"))).toBe(false);
    expect(named((c) => (c.experiments[0].variants[0].name = "x"))).toBe(false);
    expect(named((c) => (c.goals[0].name = "x"))).toBe(false);
    // 入力では名前は必須のまま(管理画面の中で使う)
    const { name: _n, ...nameless } = exp();
    expect(() => compile({ ...base, experiments: [nameless] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => compile({ ...base, goals: [{ id: "g_lead", type: "CUSTOM", config: {} }], experiments: [] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("compile_emits_conversion_payloads_for_every_goal", () => {
    // B77(K5): ab_goal_name = 目標の外部計測の名前 ?? 目標 ID。compile はすべての目標について出し、著者の analytics は goals[] から取り除く
    const cfg = compile({
      ...base,
      goals: [
        { id: "g_buy", name: "購入(社内)", type: "CUSTOM", config: {}, analytics: { overrides: { goalName: "購入" } } },
        { id: "g_cta", name: "CTA(社内)", type: "CLICK", config: { selector: ".cta" } },
      ],
      experiments: [],
    });
    expect(cfg.conversionPayloads).toEqual({ g_buy: { goalId: "g_buy", goalName: "購入" }, g_cta: { goalId: "g_cta", goalName: "g_cta" } });
    for (const g of cfg.goals) expect("analytics" in g).toBe(false);
    expect(cfg.goals[1]).toEqual({ id: "g_cta", type: "CLICK", config: { selector: ".cta" } });
    // 目標の外部計測の値は 1〜100 字(compile の入力のスキーマ)
    expect(() => compile({ ...base, goals: [{ id: "g", name: "g", type: "CUSTOM", config: {}, analytics: { overrides: { goalName: "" } } }], experiments: [] })).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
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

describe("compile: 版 3(決定 49・B69)", () => {
  const withTargeting = (targeting: unknown, urlMatch: unknown = url({ op: "contains", value: "/lp/" })) => ({ ...exp(), urlMatch, targeting }) as never;

  it("compile_v3_url_match(対象 URL の各行の page に命令列を付け、params はそのまま。全行の命令数を数える)", () => {
    const re1 = "^/lp/\\d+$";
    const re2 = "^/lp/old/";
    const urlMatch = {
      include: [{ page: { part: "path", op: "regex", value: re1 }, params: [{ name: "utm_source", op: "equals", value: "news" }] }, { page: { op: "contains", value: "/campaign/" }, params: [] }],
      exclude: [{ page: { part: "path", op: "regex", value: re2 } }],
    };
    const cfg = compile({ ...base, experiments: [withTargeting(undefined, urlMatch)] });
    expect(cfg.schemaVersion).toBe(3);
    const m = cfg.experiments[0]!.urlMatch;
    expect(m.include[0]!.page.prog).toMatchObject({ v: 1 });
    expect(m.include[0]!.params).toEqual([{ name: "utm_source", op: "equals", value: "news" }]);
    expect(m.include[1]).toEqual({ page: { op: "contains", value: "/campaign/" } }); // 空の params は省く
    expect(m.exclude![0]!.page.prog).toMatchObject({ v: 1 });
    // regexInstructionTotal は 2 行分(含めるの 1 行目と除くの 1 行目)を数える
    const n1 = compileRegex(re1);
    const n2 = compileRegex(re2);
    if (!n1.ok || !n2.ok) throw new Error("regex");
    expect(regexInstructionTotal(cfg)).toBe(n1.instructions + n2.instructions);
    expect(CompiledConfigSchema.safeParse(cfg).success).toBe(true);
    // 空の exclude は省く
    expect(compile({ ...base, experiments: [withTargeting(undefined, { include: urlMatch.include, exclude: [] })] }).experiments[0]!.urlMatch).not.toHaveProperty("exclude");
  });

  it("compile_v3_url_match: regexInstructionTotal は全行の prog を足す(行を足すと版 3 の schema の上限に掛かる)", () => {
    const big = (k: number) => ({ part: "path", op: "regex", value: `^/${k}.{0,97}` }); // 1 つ 199 命令前後
    const r = compileRegex(big(1).value);
    if (!r.ok) throw new Error(r.issue.code);
    const two = compile({ ...base, experiments: [withTargeting(undefined, { include: [{ page: big(1) }], exclude: [{ page: big(2) }] })] });
    expect(two.experiments[0]!.urlMatch.exclude).toHaveLength(1);
    // 配った後に 3 行目を手で足すと(compile の検査を迂回した改竄)、全行の合計が 500 を超えて版 3 の schema が断る
    const tampered = JSON.parse(JSON.stringify(two)) as CompiledConfig;
    tampered.experiments[0]!.urlMatch.include.push(JSON.parse(JSON.stringify(two.experiments[0]!.urlMatch.exclude![0]!)));
    expect(r.instructions * 3).toBeGreaterThan(REGEX_LIMITS.instructionsPerSite);
    expect(CompiledConfigSchema.safeParse(tampered).success).toBe(false);
    expect(CompiledConfigSchema.safeParse(two).success).toBe(true);
  });

  it("compile_rejects_moved_page_condition(配信条件・参照するオーディエンスのページの条件は page_condition_moved)", () => {
    const err = (input: Record<string, unknown>): CompileError => {
      try {
        compile({ ...base, ...input });
      } catch (e) {
        return e as CompileError;
      }
      throw new Error("expected CompileError");
    };
    const leaves = [
      { ctx: "url", op: "contains", value: "/lp/" },
      { ctx: "host", op: "equals", value: "shop.example.com" },
      { ctx: "path", op: "regex", value: "^/a/" },
      { ctx: "query", name: "utm", op: "exists" },
    ];
    for (const leaf of leaves) {
      const e1 = err({ experiments: [withTargeting({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: leaf }] })] });
      expect(e1.code).toBe("page_condition_moved");
      expect(e1.message).toContain("エクスペリエンス exp_001 の配信条件");
      expect(e1.message).toContain(PAGE_CONDITION_MOVED_MESSAGE);
      const e2 = err({ audiences: { aud_page: { or: [{ ctx: "device", op: "in", value: ["mobile"] }, leaf] } }, experiments: [withTargeting({ audience: "aud_page" })] });
      expect(e2.code).toBe("page_condition_moved");
      expect(e2.message).toContain("オーディエンス aud_page");
      expect(e2.message).toContain(PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE);
    }
    // 参照されないオーディエンスにページの条件があっても止めない(今までどおり、参照されたものだけを検査する)
    expect(() => compile({ ...base, audiences: { aud_unused: { ctx: "query", name: "a", op: "exists" } }, experiments: [exp()] })).not.toThrow();
  });

  it("古い形の対象 URL(一番外側の op / value)は invalid_input", () => {
    expect(() => compile({ ...base, experiments: [withTargeting(undefined, { op: "contains", value: "/lp/" })] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("保存する形を正規化してから配る形にする(min: 1 と part: url を省く・子 1 つのグループを畳む・期間を写す)", () => {
    const cfg = compile({ ...base, experiments: [withTargeting({ and: [{ or: [{ hist: "visited", page: { part: "url", op: "contains", value: "/pricing/" }, min: 1 }] }, { hist: "converted", goal: "g_lead", withinDays: 7 }] })] });
    const id = patternIdOf({ op: "contains", value: "/pricing/" });
    expect(cfg.experiments[0]!.targeting).toEqual({ and: [{ hist: "visited", pattern: id }, { hist: "converted", goal: "g_lead", withinDays: 7 }] });
    expect(cfg.patterns).toEqual({ [id]: { op: "contains", value: "/pricing/" } });
    expect(cfg.needsProfile).toBe(true);
  });

  it("パス・ホストの正規表現に命令列を付ける(対象 URL・目標)。値は ¥ を \\ に置き換えてから", () => {
    const cfg = compile({
      ...base,
      goals: [{ id: "g_thanks", name: "thanks", type: "PAGEVIEW", config: { page: { part: "path", op: "regex", value: "^/thanks/¥d+$" } } }],
      experiments: [withTargeting(undefined, { include: [{ page: { part: "path", op: "regex", value: "^/lp/" } }, { page: { part: "host", op: "regex", value: "^shop\\." } }] })],
    });
    const goal = cfg.goals[0]!;
    expect(goal.type === "PAGEVIEW" && goal.config.page).toMatchObject({ part: "path", op: "regex", value: "^/thanks/\\d+$", prog: { v: 1 } });
    expect(cfg.experiments[0]!.urlMatch.include[0]!.page).toMatchObject({ part: "path", op: "regex", prog: { v: 1 } });
    expect(cfg.experiments[0]!.urlMatch.include[1]!.page).toMatchObject({ part: "host", op: "regex", prog: { v: 1 } });
  });

  it("文字列の一致のホスト・パスは正規化する(小文字化・末尾ドット・punycode・日本語のエンコード)。part: url は省く", () => {
    const cfg = compile({
      ...base,
      experiments: [withTargeting(undefined, { include: [{ page: { part: "url", op: "contains", value: "/lp/" } }, { page: { part: "host", op: "endsWith", value: "Example.COM." } }], exclude: [{ page: { part: "path", op: "startsWith", value: "/料金/" } }] })],
    });
    expect(cfg.experiments[0]!.urlMatch).toEqual({
      include: [{ page: { op: "contains", value: "/lp/" } }, { page: { part: "host", op: "endsWith", value: "example.com" } }],
      exclude: [{ page: { part: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" } }],
    });
  });

  it("url の正規表現は invalid_regex(対象 URL・目標・パターンのどこでも)", () => {
    const cases: Array<() => unknown> = [
      () => compile({ ...base, experiments: [withTargeting(undefined, url({ op: "regex", value: "a" }))] }),
      () => compile({ ...base, experiments: [withTargeting(undefined, { include: [{ page: { op: "contains", value: "/" } }], exclude: [{ page: { op: "regex", value: "a" } }] })] }),
      () => compile({ ...base, goals: [{ id: "g", name: "g", type: "PAGEVIEW", config: { page: { op: "regex", value: "a" } } }], experiments: [] }),
      () => compile({ ...base, experiments: [withTargeting({ hist: "visited", page: { op: "regex", value: "a" } })] }),
    ];
    for (const run of cases) expect(run).toThrowError(expect.objectContaining({ code: "invalid_regex" }));
  });

  it("許可リストに無い書き方は invalid_regex、1 つ 200 命令超は regex_too_large(場所は行で示す)", () => {
    expect(() => compile({ ...base, experiments: [withTargeting(undefined, url({ part: "path", op: "regex", value: "(?=a)" }))] })).toThrowError(
      expect.objectContaining({ code: "invalid_regex", message: expect.stringContaining("エクスペリエンス exp_001 の対象 URL(含める 1 行目)") }),
    );
    expect(() => compile({ ...base, experiments: [withTargeting(undefined, { include: [{ page: { op: "contains", value: "/" } }], exclude: [{ page: { part: "path", op: "regex", value: ".{0,100}" } }] })] })).toThrowError(
      expect.objectContaining({ code: "regex_too_large", message: expect.stringContaining("エクスペリエンス exp_001 の対象 URL(除く 1 行目)") }),
    );
  });

  it("regex_instruction_budget_is_enforced_per_regex_and_site(サイト全体 500 命令超は regex_budget_exceeded。大きいものから並べる)", () => {
    const big = (k: number) => ({ part: "path", op: "regex", value: `^/${k}.{0,97}` }); // 1 つ 199 命令前後
    const three = [1, 2, 3].map((k) => ({ ...exp(), id: `exp_${k}`, urlMatch: url(big(k)) })) as never[];
    const err = (() => {
      try {
        compile({ ...base, experiments: three });
      } catch (e) {
        return e as CompileError;
      }
      return null;
    })();
    expect(err?.code).toBe("regex_budget_exceeded");
    expect(err?.message).toMatch(/エクスペリエンス exp_\d の対象 URL\(含める 1 行目\)\(\d+\)/);
    expect(compile({ ...base, experiments: three.slice(0, 2) }).experiments).toHaveLength(2);
  });

  it("タイムゾーンを config に入れる。IANA 名でなければ invalid_input", () => {
    expect(compile({ ...base, timezone: "Asia/Tokyo", experiments: [] }).timezone).toBe("Asia/Tokyo");
    expect(compile({ ...base, experiments: [] }).timezone).toBeUndefined();
    expect(() => compile({ ...base, timezone: "Mars/Olympus", experiments: [] })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("目標の PAGEVIEW は保存形 { page } を受ける(版 1 の { urlOp, urlValue } は invalid_input)", () => {
    expect(compile({ ...base, goals: [{ id: "g", name: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks" } } }], experiments: [] }).goals[0]).toEqual({ id: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks" } } });
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
    it("閲覧したページの条件の正規表現は、何件のエクスペリエンスから使ってもパターン ID ごとに 1 回だけ数える(plan ② P20)", () => {
      const src = "^/(ja|en)/products/[0-9]+$";
      const r = compileRegex(src);
      if (!r.ok) throw new Error(r.issue.code);
      const n = Math.floor(REGEX_LIMITS.instructionsPerSite / r.instructions) + 1; // 参照ごとに数えたら上限を超える件数
      const visited = { hist: "visited", page: { part: "path", op: "regex", value: src } };
      const cfg = compile({ ...base, experiments: Array.from({ length: n }, (_, i) => ({ ...exp(visited), id: `exp_${i}` })) });
      expect(Object.keys(cfg.patterns)).toHaveLength(1);
    });
  });
});

describe("compile: オーディエンスの展開の上限(B159、G32)", () => {
  const LEAF = { ctx: "referrer", op: "isEmpty" };
  /** 50 ノード(or 1 + not × 24 + その中の条件 24 + 条件 1)。not で包んで 1 ノードあたりの JSON を小さくし、2 万ノードでも 512 KB に収める */
  const AUD50 = { or: [...Array.from({ length: 24 }, () => ({ not: LEAF })), LEAF] };
  const refs = (id: string, k: number) => Array.from({ length: k }, () => ({ audience: id }));
  const expWith = (targeting: unknown, id = "exp_001") => ({ ...exp(), id, targeting }) as never;
  const codeOf = (run: () => unknown): string | null => {
    try {
      run();
    } catch (e) {
      return (e as CompileError).code;
    }
    return null;
  };

  it("上限はサイト全体で 20,000", () => {
    expect(LIMITS.audienceExpansionMax).toBe(20_000);
  });

  it("50 ノードのオーディエンスを 500 回参照(合計 25,000)は audience_expansion_too_large。展開の前に止まる(config_too_large まで進まない)", () => {
    const aud = { or: Array.from({ length: 49 }, () => LEAF) }; // 50 ノード。展開すると 512 KB を超える
    const t0 = performance.now();
    let err: CompileError | null = null;
    try {
      compile({ ...base, audiences: { aud_big: aud }, experiments: [expWith({ or: refs("aud_big", 500) })] });
    } catch (e) {
      err = e as CompileError;
    }
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(err?.code).toBe("audience_expansion_too_large");
    // どのオーディエンスが何回参照されて合計がいくつか・直し方
    expect(err?.message).toContain("(20050 / 20000)"); // 401 回目の参照で上限を超える
    expect(err?.message).toContain("オーディエンス aud_big(条件 50 個 × 参照 401 回)");
    expect(err?.message).toContain("参照を減らす");
  });

  it("境目: 合計がちょうど 20,000 は通り、20,001 は止まる(複数のエクスペリエンスの参照を合計する)", () => {
    const audiences = { aud_50: AUD50, aud_1: LEAF };
    const half = (id: string) => expWith({ or: refs("aud_50", 200) }, id);
    const cfg = compile({ ...base, audiences, experiments: [half("exp_a"), half("exp_b")] }); // 50 × 400 = 20,000
    expect(cfg.experiments).toHaveLength(2);
    const over = codeOf(() => compile({ ...base, audiences, experiments: [half("exp_a"), half("exp_b"), expWith({ audience: "aud_1" }, "exp_c")] }));
    expect(over).toBe("audience_expansion_too_large");
  });

  it("展開の結果を使い回しても、参照ごとの出力は今と同じ(それぞれ定義を展開した形)", () => {
    const aud = { and: [{ ctx: "referrer", op: "contains", value: "news" }, { not: { ctx: "device", op: "in", value: ["mobile"] } }, { hist: "visited", page: PRICING }] };
    const cfg = compile({ ...base, audiences: { aud_x: aud }, experiments: [expWith({ audience: "aud_x" }, "exp_a"), expWith({ or: [{ audience: "aud_x" }, { audience: "aud_x" }] }, "exp_b")] });
    const one = cfg.experiments[0]!.targeting;
    expect(one).toEqual({
      and: [
        { ctx: "referrer", op: "contains", value: "news" },
        { not: { ctx: "device", op: "in", value: ["mobile"] } },
        { hist: "visited", pattern: patternIdOf(PRICING) },
      ],
    });
    expect(cfg.experiments[1]!.targeting).toEqual({ or: [one, one] });
    // JSON にしても同じ(共有したオブジェクトでも配る形は変わらない)
    expect(JSON.parse(JSON.stringify(cfg.experiments[1]!.targeting))).toEqual({ or: [JSON.parse(JSON.stringify(one)), JSON.parse(JSON.stringify(one))] });
  });

  it("使い回した展開の結果(共有の DslNode)は、出力を受ける下流の関数が書き換えない(deep-freeze しても結果が同じ)", async () => {
    const aud = { and: [{ ctx: "referrer", op: "isEmpty" }, { not: { ctx: "device", op: "in", value: ["mobile"] } }, { hist: "visited", page: PRICING }] };
    const input = { ...base, audiences: { aud_x: aud }, experiments: [expWith({ audience: "aud_x" }, "exp_a"), expWith({ or: [{ audience: "aud_x" }, { ctx: "referrer", op: "isEmpty" }] }, "exp_b")] };
    const deepFreeze = <T>(v: T): T => {
      if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
        Object.freeze(v);
        for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
      }
      return v;
    };
    const frozen = deepFreeze(compile(input));
    const fresh = compile(input); // 比べる用(凍らせない)
    // 使い回す DslNode を共有するのは compile の中(覚えてから CompiledConfigSchema.parse まで)だけ。parse が新しい木を返すので、
    // 出力には同じ参照は残らない。中で共有したノードを読むのは maxWithinDays・dslNeedsProfile・CompiledConfigSchema.parse・JSON 化の 4 つ
    const shared = frozen.experiments[0]!.targeting!;
    expect(maxWithinDays(shared)).toBe(0);
    expect(dslNeedsProfile(shared)).toBe(true);
    expect(DslNodeSchema.parse(shared)).toEqual(shared);
    expect(CompiledConfigSchema.parse(frozen)).toEqual(fresh);

    // 書き換えようとすれば TypeError(ESM は strict)。下流の関数が通り、凍らせない出力と同じ結果になる
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: base.siteId })!;
    expect(bootPayload(frozen, settings, "https://edge.example")).toEqual(bootPayload(fresh, settings, "https://edge.example"));
    expect(bakeBootstrap(frozen, settings, "/*R*/", { apiBase: "https://edge.example" })).toBe(bakeBootstrap(fresh, settings, "/*R*/", { apiBase: "https://edge.example" }));
    expect(await staticInputDigest({ config: frozen, settings, apiBase: null })).toBe(await staticInputDigest({ config: fresh, settings, apiBase: null }));
    expect(parseCompiledConfig(frozen)).toEqual(parseCompiledConfig(fresh));
    const ctx: PageContext = { url: "https://example.com/lp/12", referrer: "", device: "desktop", now: 0 };
    const profile = { goals: {}, pages: { [patternIdOf(PRICING)]: { count: 1, lastAt: 1 } } };
    expect(evaluateDsl(shared, ctx, profile)).toBe(true);
    expect(decide(frozen, ctx, "visitor_1", profile)).toEqual(decide(fresh, ctx, "visitor_1", profile));
    const items = (c: CompiledConfig) => c.experiments.map((experiment) => ({ experiment, status: "running" as const, published: true }));
    expect(evaluateWhatIf(items(frozen), ctx, { visitorId: "visitor_1", history: profile, patterns: frozen.patterns })).toEqual(
      evaluateWhatIf(items(fresh), ctx, { visitorId: "visitor_1", history: profile, patterns: fresh.patterns }),
    );
    expect(JSON.stringify(frozen)).toBe(JSON.stringify(fresh));
  });
});

describe("experiment kind (決定 51、設計書 §3.1・§3.2)", () => {
  const single = (id = "exp_s") => ({
    id, name: "personalize", kind: "single" as const,
    urlMatch: url({ op: "contains", value: "/lp/" }),
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

  describe("results (D9 ②、K15)", () => {
    const runId = "AAAAAAAAAAAAAAAAAAAAAA";
    const codeOf = (input: unknown): string | null => {
      try {
        compile(input);
        return null;
      } catch (e) {
        return e instanceof CompileError ? e.code : "other";
      }
    };
    it("copies results from the input to the output and omits it when absent", () => {
      const results = { forget: true as const, runs: { exp_001: runId } };
      const cfg = compile({ ...base, experiments: [exp()], results });
      expect(cfg.results).toEqual(results);
      expect(CompiledConfigSchema.safeParse(cfg).success).toBe(true);
      expect("results" in compile({ ...base, experiments: [exp()] })).toBe(false);
    });
    it("accepts results with an empty runs (forget only)", () => {
      expect(compile({ ...base, experiments: [exp()], results: { forget: true, runs: {} } }).results).toEqual({ forget: true, runs: {} });
    });
    it("rejects a runId that does not match RUN_ID_RE and a results with forget false", () => {
      expect(codeOf({ ...base, experiments: [exp()], results: { forget: true, runs: { exp_001: "short" } } })).toBe("invalid_input");
      expect(codeOf({ ...base, experiments: [exp()], results: { forget: false, runs: {} } })).toBe("invalid_input");
    });
    it("does not put kind in the output (unchanged from D9 ①)", () => {
      const cfg = compile({ ...base, experiments: [{ ...exp(), kind: "test" as const }] });
      expect(cfg.experiments[0]).not.toHaveProperty("kind");
    });
    it("all_variants_without_changes_adds_root_to_exposure_selectors", () => {
      // A/A のテスト(全パターンの Change が 0 件)も ab_exposure が出るよう :root を足す(K20)。prehide は空のまま
      const aa: ExpIn = { ...exp(), variants: [
        { id: "vA", name: "A", weight: 50, changes: [] },
        { id: "vB", name: "B", weight: 50, changes: [] },
      ] };
      const cfg = compile({ ...base, experiments: [aa] });
      expect(cfg.exposureSelectors["exp_001"]).toEqual([":root"]);
      expect(cfg.prehide["exp_001"]).toEqual([]);
    });
  });
});
