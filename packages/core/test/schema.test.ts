import { describe, it, expect } from "vitest";
import {
  DslNodeSchema, ChangeSchema, ExperimentSchema, GoalSchema, GoalInputSchema, CompiledConfigSchema, ResultsConfigSchema, dslDepth, LIMITS,
  VariantSchema, attributeChangeIssue, PageMatchInputSchema, CompiledPageMatchSchema, RegexProgramSchema, StoredCtxSchema, StoredCtxReadSchema,
  CompiledHistSchema, CompiledUrlMatchSchema, UrlMatchInputSchema,
} from "../src/schema";
import { TargetingInputSchema, TargetingReadSchema } from "../src/targeting";
import { CompiledConfigV2Schema } from "../src/schema-v2";
import { COMPILED_V2 } from "./fixtures/compiled-v2";
import { parseCompiledConfig } from "../src/config-read";
import { compileRegex } from "../src/regex-compile";
import {
  AnalyticsSettingsSchema, ExperimentAnalyticsSchema, VariantAnalyticsSchema, ExposurePayloadSchema, GoalAnalyticsSchema, ConversionPayloadSchema,
  ExperimentAnalyticsRequestSchema, VariantAnalyticsRequestSchema, GoalAnalyticsRequestSchema,
} from "../src/analytics";
import { SiteSettingsSchema } from "../src/settings";
import { CompileInputSchema, ExperimentInputSchema, VariantInputSchema } from "../src/compile";
import { ConsentBodySchema, DecisionBodySchema, DliteRequestSchema, EventBodySchema } from "../src/protocol";
import { StaticBatchDeployRequestSchema, StaticDeployRequestSchema, StaticRemoveRequestSchema } from "../src/static-deploy";
import * as core from "../src/index"; //メタ assertion(表に無い zod スキーマがあれば落とす)

const ctxDevice = { ctx: "device", op: "in", value: ["mobile"] } as const;
const progOf = (src: string) => {
  const r = compileRegex(src);
  if (!r.ok) throw new Error(r.issue.code);
  return r.prog;
};

describe("DslNode(配る形 = 版 3)", () => {
  it("accepts and/or/not/ctx/hist nesting", () => {
    const node = { and: [ctxDevice, { not: { hist: "converted", goal: "g_lead", withinDays: 7 } }, { or: [{ hist: "visited", pattern: "p_1" }, { hist: "visited", pattern: "p_1", min: 3, withinDays: 30 }] }] };
    expect(DslNodeSchema.parse(node)).toBeTruthy();
    expect(dslDepth(node)).toBe(3);
  });
  it("rejects unknown fields (fail-closed)", () => {
    expect(() => DslNodeSchema.parse({ ctx: "device", op: "in", value: ["mobile"], evil: 1 })).toThrow();
  });
  it("accepts depth 16 and rejects depth 17(決定 49 で 5 → 16)", () => {
    let node: unknown = ctxDevice;
    for (let i = 0; i < 15; i++) node = { not: node };
    expect(() => DslNodeSchema.parse(node)).not.toThrow();
    expect(() => DslNodeSchema.parse({ not: node })).toThrow(/depth/i);
  });
  it("保存する形の zod の深さの上限は配る形と同じ 16(意味の上限 3 / 11 は targeting.ts の関数)", () => {
    let node: unknown = ctxDevice;
    for (let i = 0; i < 15; i++) node = { not: node };
    expect(() => TargetingInputSchema.parse(node)).not.toThrow();
    expect(() => TargetingInputSchema.parse({ not: node })).toThrow(/depth/i);
  });
  it.each([
    { ctx: "url", op: "contains", value: "/a" },
    { ctx: "host", op: "endsWith", value: "example.com" },
    { ctx: "path", op: "startsWith", value: "/pricing/" },
    { ctx: "path", op: "regex", value: "^/a", prog: progOf("^/a") },
    { ctx: "query", name: "utm", op: "contains", value: "mail" },
    { ctx: "query", name: "x", op: "exists" },
  ])("版 3 の配る形はページの条件を受けない(B69。対象 URL に移した): %j", (removed) => {
    expect(DslNodeSchema.safeParse(removed).success).toBe(false);
    expect(DslNodeSchema.safeParse({ and: [ctxDevice, { not: removed }] }).success).toBe(false);
  });
  it("page_view_count は版 2 に無い(visited の min)", () => {
    expect(() => DslNodeSchema.parse({ hist: "page_view_count", pattern: "p", gte: 2 })).toThrow();
  });
  it.each([
    { ctx: "referrer", op: "contains" },
    { ctx: "referrer", op: "isEmpty", value: "" },
    { ctx: "viewport" },
    { ctx: "viewport", minWidth: 0 },
    { ctx: "viewport", maxWidth: 10001 },
    { ctx: "viewport", minWidth: 768, maxWidth: 768 },
    { ctx: "viewport", minWidth: 1.5 },
    { ctx: "time", days: [] },
    { ctx: "time", days: ["mon", "mon"] },
    { ctx: "time", days: ["mon"], from: "09:00" },
    { ctx: "time", days: ["mon"], from: "09:00", to: "09:00" },
    { ctx: "time", days: ["mon"], from: "24:00", to: "01:00" },
    { ctx: "time", days: ["mon"], from: "09:30", to: "18:00" },
    { ctx: "time", days: ["mon"], from: "00:00", to: "00:00" },
    { ctx: "sinceFirstVisit", op: "gte" },
    { ctx: "sinceFirstVisit", op: "gte", hours: 1, days: 1 },
    { ctx: "sinceFirstVisit", op: "lt", hours: 8761 },
    { ctx: "sinceFirstVisit", op: "lt", days: 3651 },
    { ctx: "browser", op: "in", value: [] },
    { ctx: "browser", op: "in", value: ["opera"] },
    { ctx: "os", op: "in", value: ["ios", "ios"] },
    { ctx: "device", op: "in", value: ["mobile", "mobile"] },
    { hist: "visited", pattern: "p", min: 0 },
    { hist: "visited", pattern: "p", withinDays: 0 },
    { hist: "converted", goal: "g", withinDays: 3651 },
  ])("rejects %j(新しい条件の値の規則。設計書 §4.1)", (bad) => expect(() => DslNodeSchema.parse(bad)).toThrow());
  it.each([
    { ctx: "viewport", minWidth: 1 },
    { ctx: "viewport", maxWidth: 10000 },
    { ctx: "viewport", minWidth: 768, maxWidth: 1024 },
    { ctx: "time", days: ["mon", "fri"] },
    { ctx: "time", days: ["fri"], from: "22:00", to: "02:00" },
    { ctx: "time", days: ["sat", "sun"], from: "00:00", to: "24:00" },
    { ctx: "sinceFirstVisit", op: "gte", hours: 8760 },
    { ctx: "sinceFirstVisit", op: "lt", days: 3650 },
    { ctx: "browser", op: "in", value: ["safari", "chrome"] },
    { ctx: "os", op: "in", value: ["ios"] },
  ])("accepts %j", (good) => expect(DslNodeSchema.parse(good)).toBeTruthy());
});

describe("TargetingInput(保存する形)", () => {
  it("新しい条件と page を直接持つ閲覧の条件を受ける。命令列は持たない", () => {
    expect(TargetingInputSchema.parse({ and: [{ hist: "visited", page: { part: "path", op: "regex", value: "^/a" }, min: 2 }, ctxDevice] })).toBeTruthy();
    expect(() => TargetingInputSchema.parse({ hist: "visited", page: { part: "path", op: "regex", value: "^/a", prog: progOf("^/a") } })).toThrow();
  });
  it("ページの条件は保存の形では受けず(B69)、読み取りの形では受ける", () => {
    expect(TargetingInputSchema.safeParse({ ctx: "url", op: "regex", value: "a" }).success).toBe(false);
    expect(TargetingReadSchema.safeParse({ ctx: "url", op: "regex", value: "a" }).success).toBe(true);
    expect(StoredCtxSchema.safeParse({ ctx: "host", op: "equals", value: "a.example" }).success).toBe(false);
    expect(StoredCtxReadSchema.safeParse({ ctx: "host", op: "equals", value: "a.example" }).success).toBe(true);
  });
});

describe("PageMatch", () => {
  it("保存する形: part ごとの一致の仕方", () => {
    expect(PageMatchInputSchema.parse({ op: "contains", value: "/a" })).toBeTruthy();
    expect(PageMatchInputSchema.parse({ part: "host", op: "endsWith", value: "example.com" })).toBeTruthy();
    expect(() => PageMatchInputSchema.parse({ part: "url", op: "endsWith", value: "a" })).toThrow();
    expect(() => PageMatchInputSchema.parse({ part: "host", op: "startsWith", value: "a" })).toThrow();
    expect(() => PageMatchInputSchema.parse({ op: "contains", value: "" })).toThrow();
  });
  it("配る形: 正規表現は path / host で命令列つき", () => {
    expect(CompiledPageMatchSchema.parse({ part: "path", op: "regex", value: "^/a", prog: progOf("^/a") })).toBeTruthy();
    expect(() => CompiledPageMatchSchema.parse({ op: "regex", value: "^/a", prog: progOf("^/a") })).toThrow();
    expect(() => CompiledPageMatchSchema.parse({ part: "host", op: "regex", value: "a" })).toThrow();
  });
  it("legacy は未知のキーとして拒否する(版 1 の読み替えの印は backlog B52 で削除した)", () => {
    expect(CompiledPageMatchSchema.safeParse({ op: "contains", value: "/a" }).success).toBe(true);
    const r = CompiledPageMatchSchema.safeParse({ op: "contains", value: "/a", legacy: true });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.code)).toEqual(["unrecognized_keys"]);
    expect(CompiledPageMatchSchema.safeParse({ part: "path", op: "regex", value: "a", prog: progOf("a"), legacy: true }).success).toBe(false);
    expect(DslNodeSchema.safeParse({ ctx: "device", op: "in", value: ["mobile"], legacy: true }).success).toBe(false);
  });
});

describe("Change payloads (spec §6.4)", () => {
  it.each([
    [{ id: "c1", type: "TEXT", selector: ".h1", payload: { text: "B案" } }],
    [{ id: "c2", type: "IMAGE", selector: "img.hero", payload: { src: "https://assets.example/x.webp" } }],
    [{ id: "c3", type: "HIDE", selector: ".banner", payload: {} }],
    [{ id: "c4", type: "ATTRIBUTE", selector: "a.cta", payload: { name: "href", value: "/lp2/" } }],
    [{ id: "c5", type: "HTML", selector: ".hero", payload: { html: "<div>x</div>", position: "replace", runScripts: false } }],
    [{ id: "c6", type: "CSS", payload: { css: ".hero{color:red}" } }],
    [{ id: "c7", type: "CUSTOM_JS", selector: ".hero", payload: { code: "element.dataset.x='1'" } }],
  ])("accepts %j", (c) => expect(ChangeSchema.parse(c)).toBeTruthy());

  it("rejects wrong payload shape for type", () => {
    expect(() => ChangeSchema.parse({ id: "c", type: "TEXT", selector: ".a", payload: { html: "x" } })).toThrow();
  });
  it("rejects selector over 500 chars", () => {
    expect(() => ChangeSchema.parse({ id: "c", type: "TEXT", selector: "x".repeat(501), payload: { text: "t" } })).toThrow();
  });
  it("rejects an empty HTML payload (Plan 10 B2: empty html + replace would silently delete the element)", () => {
    for (const position of ["replace", "before", "after", "append"]) {
      expect(() => ChangeSchema.parse({ id: "c", type: "HTML", selector: ".a", payload: { html: "", position, runScripts: false } })).toThrow();
    }
  });
  it("rejects payload over 64KB", () => {
    expect(() => ChangeSchema.parse({ id: "c", type: "TEXT", selector: ".a", payload: { text: "x".repeat(LIMITS.changeValueMaxBytes + 1) } })).toThrow();
  });
  it("CSS does not require selector; TEXT does", () => {
    expect(() => ChangeSchema.parse({ id: "c", type: "TEXT", payload: { text: "t" } })).toThrow();
    expect(ChangeSchema.parse({ id: "c", type: "CSS", payload: { css: "a{}" } })).toBeTruthy();
  });
  it.each(["javascript:alert(1)", "data:image/png;base64,AAAA", "vbscript:x", "ftp://x.example/a.png"])(
    "IMAGE rejects non-http(s) URL %j(spec §6.4 絶対 URL + 決定 26 / Plan 1 繰越)",
    (src) => expect(() => ChangeSchema.parse({ id: "c", type: "IMAGE", selector: "img", payload: { src } })).toThrow(),
  );
  it("IMAGE accepts http and https absolute URLs", () => {
    expect(ChangeSchema.parse({ id: "c", type: "IMAGE", selector: "img", payload: { src: "https://assets.example/x.webp" } })).toBeTruthy();
    expect(ChangeSchema.parse({ id: "c", type: "IMAGE", selector: "img", payload: { src: "http://assets.example/x.webp" } })).toBeTruthy();
  });

  // spec §11(決定 16)の ATTRIBUTE allowlist。control(422 + attribute_not_allowed)より手前の schema 検証。
  // R14: control が存在しない間も fixture CLI / edge に効かせるため core に置く
  const attr = (name: string, value = "x") => ({ id: "c", type: "ATTRIBUTE", selector: "a.cta", payload: { name, value } });
  it.each([
    ["href", "/lp2/"], ["src", "https://assets.example/x.webp"], ["alt", "写真"], ["title", "t"],
    ["class", "cta cta--b"], ["id", "cta"], ["target", "_blank"], ["rel", "noopener"],
    ["aria-label", "申し込む"], ["data-wtt-mark", "1"], ["placeholder", "メール"], ["value", "v"],
    ["disabled", ""], ["hidden", ""], ["width", "320"], ["height", "48"], ["loading", "lazy"],
  ])("ATTRIBUTE accepts the allowlisted name %s", (name, value) => {
    expect(ChangeSchema.parse(attr(name, value))).toBeTruthy();
  });
  it("ATTRIBUTE accepts an allowlisted name in any letter case", () => {
    expect(ChangeSchema.parse(attr("HREF", "/lp2/"))).toBeTruthy(); // HTML の属性名は大小無視
  });
  it.each(["onclick", "onerror", "ONCLICK", "srcdoc", "style", "action", "formaction", "srcset", "aria-", "data-", "ariainvalid", "datax"])(
    "ATTRIBUTE rejects the non-allowlisted name %s",
    (name) => expect(() => ChangeSchema.parse(attr(name))).toThrow(/not allowed/),
  );
  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["  javascript:alert(1)"], // ブラウザは先頭空白を落としてから scheme を見る
    ["java\tscript:alert(1)"], // タブは URL 解析で除去される
    ["java\nscript:alert(1)"],
    ["\u0001javascript:alert(1)"], // C0 制御文字
    ["data:text/html,<script>x</script>"],
    ["vbscript:msgbox(1)"],
    ["ftp://x.example/a.png"],
  ])("ATTRIBUTE href rejects the dangerous URL %j", (value) => {
    expect(() => ChangeSchema.parse(attr("href", value))).toThrow(/http\(s\) or relative/);
  });
  it.each(["data:image/png;base64,AAAA", "javascript:void(0)"])("ATTRIBUTE src rejects %j", (value) => {
    expect(() => ChangeSchema.parse(attr("src", value))).toThrow(/http\(s\) or relative/);
  });
  it.each(["/lp2/", "lp2/index.html", "../a.png", "?v=2", "#top", "//cdn.example/a.png", "https://x.example/a", "HTTP://x.example/a"])(
    "ATTRIBUTE href accepts the relative or http(s) URL %j",
    (value) => expect(ChangeSchema.parse(attr("href", value))).toBeTruthy(),
  );
  it("ATTRIBUTE URL check applies only to href / src", () => {
    // `javascript:` を含む値でも、URL として解釈されない属性なら allowlist だけで判断する
    expect(ChangeSchema.parse(attr("title", "javascript:alert(1)"))).toBeTruthy();
  });
});

describe("Experiment", () => {
  const variants = (w1: number, w2: number) => [
    { id: "vA", weight: w1, changes: [] },
    { id: "vB", weight: w2, changes: [{ id: "c1", type: "TEXT", selector: ".h1", payload: { text: "B" } }] },
  ];
  const base = { id: "exp_001", urlMatch: { include: [{ page: { op: "contains", value: "/lp/" } }] }, trafficPercentage: 100, persistAssignment: false };
  it("版 3 の対象 URL は含める・除くの行。版 2 の 1 つのページの一致は受けない", () => {
    expect(ExperimentSchema.safeParse({ ...base, variants: variants(50, 50) }).success).toBe(true);
    expect(ExperimentSchema.safeParse({ ...base, urlMatch: { op: "contains", value: "/lp/" }, variants: variants(50, 50) }).success).toBe(false);
    expect(ExperimentSchema.safeParse({ ...base, name: "hero", variants: variants(50, 50) }).success).toBe(false); // 名前は受けない
  });
  it("accepts weights summing to 100", () => {
    expect(ExperimentSchema.parse({ ...base, variants: variants(50, 50) })).toBeTruthy();
  });
  it("rejects weights not summing to 100", () => {
    expect(() => ExperimentSchema.parse({ ...base, variants: variants(50, 40) })).toThrow(/100/);
  });
  it("rejects non-integer weight", () => {
    expect(() => ExperimentSchema.parse({ ...base, variants: variants(50.5 as never, 49.5 as never) })).toThrow();
  });
});

describe("Goal / CompiledConfig", () => {
  const cfg = { schemaVersion: 3, version: 1, siteId: "site_1", siteSalt: "salt_test", needsProfile: false, patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [] };
  const cfgV1 = { ...cfg, schemaVersion: 1 };
  it("accepts goal configs per type", () => {
    expect(GoalSchema.parse({ id: "g1", type: "PAGEVIEW", config: { page: { op: "contains", value: "/thanks/" } } })).toBeTruthy();
    expect(GoalSchema.parse({ id: "g2", type: "CLICK", config: { selector: ".cta" } })).toBeTruthy();
    expect(GoalSchema.parse({ id: "g3", type: "CUSTOM", config: {} })).toBeTruthy();
    expect(() => GoalSchema.parse({ id: "g1", type: "PAGEVIEW", config: { urlOp: "contains", urlValue: "/thanks/" } })).toThrow(); // 版 1 の形
  });
  it("compiled config requires schemaVersion 3 and rejects other versions", () => {
    expect(CompiledConfigSchema.parse(cfg)).toBeTruthy();
    expect(CompiledConfigSchema.parse({ ...cfg, timezone: "Asia/Tokyo" })).toBeTruthy();
    expect(() => CompiledConfigSchema.parse(cfgV1)).toThrow();
    expect(() => CompiledConfigSchema.parse({ ...cfg, schemaVersion: 2 })).toThrow();
    expect(() => CompiledConfigSchema.parse({ ...cfg, schemaVersion: 4 })).toThrow();
  });
  it("parseCompiledConfig reads version 3 and 2 (upgraded); version 1 and 4 are unknown (null) like garbage", () => {
    expect(parseCompiledConfig(cfg)?.schemaVersion).toBe(3);
    expect(parseCompiledConfig({ ...cfg, schemaVersion: 2 })?.schemaVersion).toBe(3); // 版 2 は upgradeV2 で版 3 にする(B69)
    expect(parseCompiledConfig(cfgV1)).toBeNull(); // 版 1 の読み取りは backlog B52 で削除(版 2 が公開の最初の版)
    expect(parseCompiledConfig({ ...cfg, schemaVersion: 4 })).toBeNull();
    expect(parseCompiledConfig("junk")).toBeNull();
  });
  it("compiled_schema_rejects_names(版 3 は name を受けない。名前付きの版 2 は版 2 のスキーマが受ける)", () => {
    const named = {
      ...cfg,
      goals: [{ id: "g1", name: "lead", type: "CUSTOM", config: {} }],
      experiments: [{
        id: "exp_001", name: "hero", urlMatch: { include: [{ page: { op: "contains", value: "/lp/" } }] }, trafficPercentage: 100, persistAssignment: false,
        variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [] }],
      }],
    };
    expect(CompiledConfigSchema.safeParse(named).success).toBe(false);
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals: [{ id: "g1", type: "CUSTOM", config: {} }] }).success).toBe(true);
    expect(CompiledConfigV2Schema.safeParse({ ...named, schemaVersion: 2, experiments: [{ ...named.experiments[0]!, urlMatch: { op: "contains", value: "/lp/" } }] }).success).toBe(true);
  });
  it("conversion_payloads_must_match_goals", () => {
    const goals = [{ id: "g1", type: "CUSTOM", config: {} }];
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: { g1: { goalId: "g1", goalName: "購入" } } }).success).toBe(true);
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: {} }).success).toBe(true); // 欠落は runtime の予備の導出(ID)
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: { g_ghost: { goalId: "g_ghost", goalName: "x" } } }).success).toBe(false); // 存在しない目標
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: { g1: { goalId: "g2", goalName: "x" } } }).success).toBe(false); // キーと goalId の不一致
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: { g1: { goalId: "g1", goalName: "" } } }).success).toBe(false); // 空名
    expect(CompiledConfigSchema.safeParse({ ...cfg, goals, conversionPayloads: { g1: { goalId: "g1", goalName: "x", extra: {} } } }).success).toBe(false); // strict
  });
  it("サイト全体の命令数が 500 を超える config は読まない(手書き・改竄。fail-closed)", () => {
    const big = (k: number) => ({ part: "path", op: "regex", value: `^/${k}`, prog: { v: 1, sets: [[0, 0, 0, 0]], code: Array.from({ length: 199 * 3 }, (_, i) => (i === 198 * 3 ? 5 : 0)) } });
    const patterns = { a: big(1), b: big(2) };
    expect(CompiledConfigSchema.safeParse({ ...cfg, patterns }).success).toBe(true); // 398
    expect(CompiledConfigSchema.safeParse({ ...cfg, patterns: { ...patterns, c: big(3) } }).success).toBe(false); // 597
  });
});

describe("schema strictness", () => {
  /**
   * 表 = [名前, スキーマ, 未知フィールドを足す前の**妥当な値**]。妥当な値がそのまま通ることも同じ表で確かめる
   * (通らない値に `__unknown` を足しても「拒否」の証明にならない)。
   * 対象は core が export する **すべての z.strictObject**(schema.ts / settings.ts / analytics.ts / compile.ts / protocol.ts)。
   * スキーマを足したらここに 1 行足す(それ以外にこのテストを通す方法は無い)
   */
  const experiment = {
    id: "exp_001", urlMatch: { include: [{ page: { op: "contains", value: "/lp/" } }] }, trafficPercentage: 100, persistAssignment: false,
    variants: [
      { id: "vA", weight: 50, changes: [] },
      { id: "vB", weight: 50, changes: [] },
    ],
  };
  /** compile の入力(名前は必須) */
  const experimentInput = { ...experiment, name: "hero", variants: experiment.variants.map((v) => ({ ...v, name: v.id })) };
  const compiled = {
    schemaVersion: 3, version: 1, siteId: "site_1", siteSalt: "salt_test", needsProfile: false,
    patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [experiment],
  };
  const rows: Array<[string, { parse(v: unknown): unknown }, Record<string, unknown>]> = [
    ["PageMatchInput", PageMatchInputSchema, { part: "path", op: "contains", value: "/a" }],
    ["CompiledPageMatch", CompiledPageMatchSchema, { part: "path", op: "contains", value: "/a" }],
    ["UrlMatchInput", UrlMatchInputSchema, { include: [{ page: { part: "path", op: "contains", value: "/a" }, params: [{ name: "x", op: "exists" }] }] }],
    ["CompiledUrlMatch", CompiledUrlMatchSchema, { include: [{ page: { part: "path", op: "contains", value: "/a" } }] }],
    ["RegexProgram", RegexProgramSchema, { v: 1, sets: [], code: [5, 0, 0] }],
    ["Dsl ctx browser", DslNodeSchema, { ctx: "browser", op: "in", value: ["safari"] }],
    ["Dsl ctx os", DslNodeSchema, { ctx: "os", op: "in", value: ["ios"] }],
    ["Dsl ctx viewport", DslNodeSchema, { ctx: "viewport", minWidth: 768 }],
    ["Dsl ctx time", DslNodeSchema, { ctx: "time", days: ["mon"], from: "09:00", to: "18:00" }],
    ["Dsl ctx sinceFirstVisit", DslNodeSchema, { ctx: "sinceFirstVisit", op: "gte", days: 7 }],
    ["TargetingInput", TargetingInputSchema, { hist: "visited", page: { op: "contains", value: "/a" }, withinDays: 7 }],
    ["StoredCtx", StoredCtxSchema, { ctx: "device", op: "in", value: ["mobile"] }],
    ["StoredCtxRead url", StoredCtxReadSchema, { ctx: "url", op: "contains", value: "/a" }],
    ["StoredCtxRead query", StoredCtxReadSchema, { ctx: "query", name: "x", op: "exists" }],
    ["TargetingRead", TargetingReadSchema, { ctx: "path", op: "startsWith", value: "/a" }],
    ["CompiledHist visited", CompiledHistSchema, { hist: "visited", pattern: "p" }],
    ["CompiledConfigV2", CompiledConfigV2Schema, COMPILED_V2],
    ["CompiledConfigV2 experiment", CompiledConfigV2Schema, { ...COMPILED_V2, experiments: [{ ...COMPILED_V2.experiments[3]!, __unknown: 1 }] }],
    ["Dsl ctx device", DslNodeSchema, { ctx: "device", op: "in", value: ["mobile"] }],
    ["Dsl ctx referrer equals", DslNodeSchema, { ctx: "referrer", op: "equals", value: "r" }],
    ["Dsl ctx referrer contains", DslNodeSchema, { ctx: "referrer", op: "contains", value: "r" }],
    ["Dsl ctx referrer isEmpty", DslNodeSchema, { ctx: "referrer", op: "isEmpty" }],
    ["Dsl hist visited", DslNodeSchema, { hist: "visited", pattern: "p" }],
    ["Dsl hist converted", DslNodeSchema, { hist: "converted", goal: "g" }],
    ["Dsl hist visited min withinDays", DslNodeSchema, { hist: "visited", pattern: "p", min: 2, withinDays: 30 }],
    ["Dsl and", DslNodeSchema, { and: [{ ctx: "device", op: "in", value: ["mobile"] }] }],
    ["Dsl or", DslNodeSchema, { or: [{ ctx: "device", op: "in", value: ["mobile"] }] }],
    ["Dsl not", DslNodeSchema, { not: { ctx: "device", op: "in", value: ["mobile"] } }],
    ["Change TEXT", ChangeSchema, { id: "c", type: "TEXT", selector: ".a", payload: { text: "t" } }],
    ["Change TEXT payload", ChangeSchema, { id: "c", type: "TEXT", selector: ".a", payload: { text: "t", __unknown: 1 } }],
    ["Change IMAGE", ChangeSchema, { id: "c", type: "IMAGE", selector: ".a", payload: { src: "https://x.example/a.png" } }],
    ["Change IMAGE payload", ChangeSchema, { id: "c", type: "IMAGE", selector: ".a", payload: { src: "https://x.example/a.png", __unknown: 1 } }],
    ["Change HIDE", ChangeSchema, { id: "c", type: "HIDE", selector: ".a", payload: {} }],
    ["Change HIDE payload", ChangeSchema, { id: "c", type: "HIDE", selector: ".a", payload: { __unknown: 1 } }],
    ["Change ATTRIBUTE", ChangeSchema, { id: "c", type: "ATTRIBUTE", selector: ".a", payload: { name: "href", value: "/x" } }],
    ["Change ATTRIBUTE payload", ChangeSchema, { id: "c", type: "ATTRIBUTE", selector: ".a", payload: { name: "href", value: "/x", __unknown: 1 } }],
    ["Change HTML", ChangeSchema, { id: "c", type: "HTML", selector: ".a", payload: { html: "x", position: "replace", runScripts: false } }],
    ["Change HTML payload", ChangeSchema, { id: "c", type: "HTML", selector: ".a", payload: { html: "x", position: "replace", runScripts: false, __unknown: 1 } }],
    ["Change CSS", ChangeSchema, { id: "c", type: "CSS", payload: { css: "a{}" } }],
    ["Change CSS payload", ChangeSchema, { id: "c", type: "CSS", payload: { css: "a{}", __unknown: 1 } }],
    ["Change CUSTOM_JS", ChangeSchema, { id: "c", type: "CUSTOM_JS", selector: ".a", payload: { code: "1" } }],
    ["Change CUSTOM_JS payload", ChangeSchema, { id: "c", type: "CUSTOM_JS", selector: ".a", payload: { code: "1", __unknown: 1 } }],
    ["Variant", VariantSchema, { id: "v", weight: 100, changes: [] }],
    ["Goal PAGEVIEW", GoalSchema, { id: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/t" } } }],
    ["Goal PAGEVIEW config", GoalSchema, { id: "g", type: "PAGEVIEW", config: { page: { op: "contains", value: "/t" }, __unknown: 1 } }],
    ["GoalInput PAGEVIEW", GoalInputSchema, { id: "g", name: "n", type: "PAGEVIEW", config: { page: { part: "path", op: "regex", value: "^/t" } } }],
    ["Goal CLICK", GoalSchema, { id: "g", type: "CLICK", config: { selector: ".a" } }],
    ["Goal CLICK config", GoalSchema, { id: "g", type: "CLICK", config: { selector: ".a", __unknown: 1 } }],
    ["Goal CUSTOM", GoalSchema, { id: "g", type: "CUSTOM", config: {} }],
    ["Goal CUSTOM config", GoalSchema, { id: "g", type: "CUSTOM", config: { __unknown: 1 } }],
    ["Experiment", ExperimentSchema, experiment],
    ["CompiledConfig", CompiledConfigSchema, compiled],
    ["ResultsConfig", ResultsConfigSchema, { forget: true, runs: { exp_001: "AAAAAAAAAAAAAAAAAAAAAA" } }],
    ["AnalyticsSettings", AnalyticsSettingsSchema, {}],
    ["AnalyticsSettings exposure", AnalyticsSettingsSchema, { exposure: { __unknown: 1 } }],
    ["AnalyticsSettings exposure.keys", AnalyticsSettingsSchema, { exposure: { keys: { __unknown: "x" } } }],
    ["AnalyticsSettings conversion", AnalyticsSettingsSchema, { conversion: { __unknown: 1 } }],
    ["AnalyticsSettings conversion.keys", AnalyticsSettingsSchema, { conversion: { keys: { __unknown: "x" } } }],
    ["ExperimentAnalytics", ExperimentAnalyticsSchema, {}],
    ["ExperimentAnalytics overrides", ExperimentAnalyticsSchema, { overrides: { __unknown: "x" } }],
    ["VariantAnalytics", VariantAnalyticsSchema, {}],
    ["VariantAnalytics overrides", VariantAnalyticsSchema, { overrides: { __unknown: "x" } }],
    ["ExposurePayload", ExposurePayloadSchema, { experimentId: "e", experimentName: "E", variantId: "v", variantName: "V", extra: {} }],
    ["GoalAnalytics", GoalAnalyticsSchema, {}],
    ["GoalAnalytics overrides", GoalAnalyticsSchema, { overrides: { __unknown: "x" } }],
    ["ConversionPayload", ConversionPayloadSchema, { goalId: "g", goalName: "G" }],
    ["ExperimentAnalyticsRequest", ExperimentAnalyticsRequestSchema, {}],
    ["ExperimentAnalyticsRequest overrides", ExperimentAnalyticsRequestSchema, { overrides: { __unknown: "x" } }],
    ["VariantAnalyticsRequest", VariantAnalyticsRequestSchema, {}],
    ["VariantAnalyticsRequest overrides", VariantAnalyticsRequestSchema, { overrides: { __unknown: "x" } }],
    ["GoalAnalyticsRequest", GoalAnalyticsRequestSchema, {}],
    ["GoalAnalyticsRequest overrides", GoalAnalyticsRequestSchema, { overrides: { __unknown: "x" } }],
    ["GoalInput CUSTOM analytics", GoalInputSchema, { id: "g", name: "n", type: "CUSTOM", config: {}, analytics: { overrides: { goalName: "G", __unknown: "x" } } }],
    ["SiteSettings", SiteSettingsSchema, { settingsVersion: 1, siteId: "site_1" }],
    ["SiteSettings resultsCollectUntil", SiteSettingsSchema, { settingsVersion: 1, siteId: "site_1", resultsCollectUntil: { AAAAAAAAAAAAAAAAAAAAAA: 1 } }],
    ["SiteSettings previousCookieNames", SiteSettingsSchema, { settingsVersion: 1, siteId: "site_1", previousCookieNames: [{ name: "_old", until: 1, __unknown: 1 }] }],
    ["VariantInput", VariantInputSchema, { id: "v", name: "A", weight: 100, changes: [] }],
    ["ExperimentInput", ExperimentInputSchema, experimentInput],
    ["CompileInput", CompileInputSchema, { siteId: "site_1", siteSalt: "s", version: 1, timezone: "Asia/Tokyo", experiments: [], goals: [] }],
    ["DecisionBody", DecisionBodySchema, { v: 1, url: "https://a.test/", device: "desktop", browser: "chrome", os: "macos", firstVisitAt: null }],
    ["DecisionBody viewport", DecisionBodySchema, { v: 1, url: "https://a.test/", device: "desktop", viewport: { w: 1, h: 1, __unknown: 1 } }],
    ["ConsentBody", ConsentBodySchema, { kind: "consent", value: "denied" }],
    ["EventBody goal", EventBodySchema, { type: "goal", goalId: "g" }],
    ["EventBody forget", EventBodySchema, { type: "forget" }],
    ["EventBody participant", EventBodySchema, { type: "participant", v: 1, runId: "AAAAAAAAAAAAAAAAAAAAAA", variantId: "b", device: "mobile", applied: "ok" }],
    ["EventBody participant failed_later", EventBodySchema, { type: "participant", v: 1, runId: "AAAAAAAAAAAAAAAAAAAAAA", variantId: "b", applied: "failed_later" }],
    ["EventBody conversion", EventBodySchema, { type: "conversion", v: 1, goalId: "g", runIds: ["AAAAAAAAAAAAAAAAAAAAAA"] }],
    ["DliteRequest decision", DliteRequestSchema, { v: 1, url: "https://a.test/", device: "desktop" }],
    ["DliteRequest consent", DliteRequestSchema, { kind: "consent", value: "denied" }],
    ["StaticDeployRequest", StaticDeployRequestSchema, { protocol: 1, siteId: "site_1", generation: { epoch: 1, seq: 1 }, config: {}, settings: {}, apiBase: null }],
    ["StaticDeployRequest generation", StaticDeployRequestSchema, { protocol: 1, siteId: "site_1", generation: { epoch: 1, seq: 1, __unknown: 1 }, config: {}, settings: {}, apiBase: null }],
    ["StaticRemoveRequest", StaticRemoveRequestSchema, { protocol: 1, siteId: "site_1", generation: { epoch: 1, seq: 1 } }],
    ["StaticBatchDeployRequest", StaticBatchDeployRequestSchema, { protocol: 1, sites: [{ siteId: "site_1", generation: { epoch: 1, seq: 1 }, config: {}, settings: {}, apiBase: null }], flush: "soon" }],
    ["StaticBatchDeployRequest site", StaticBatchDeployRequestSchema, { protocol: 1, sites: [{ siteId: "site_1", generation: { epoch: 1, seq: 1 }, config: {}, settings: {}, apiBase: null, __unknown: 1 }], flush: "soon" }],
    ["StaticBatchDeployRequest remove", StaticBatchDeployRequestSchema, { protocol: 1, sites: [{ siteId: "site_1", generation: { epoch: 1, seq: 1 }, remove: true }], flush: "later" }],
    ["StaticBatchDeployRequest remove generation", StaticBatchDeployRequestSchema, { protocol: 1, sites: [{ siteId: "site_1", generation: { epoch: 1, seq: 1, __unknown: 1 }, remove: true }], flush: "later" }],
  ];

  /**
   * 未知フィールドという概念を持たない(オブジェクトでない)スキーマ。メタ assertion の対象外にする。
   * ここに足してよいのは object 以外のスキーマだけ(object を足すと未知フィールドの検査が抜ける)
   */
  const NON_OBJECT_SCHEMAS = new Set(["AnalyticsNameSchema", "AnalyticsEventNameSchema", "AnalyticsValueSchema"]);

  it("unknown_field_rejected_for_each_schema", () => {
    // 入れ子に __unknown を仕込んだ行(値そのものが既に不正)は「妥当な値」の検査から外す
    const hasNested = (v: unknown): boolean =>
      typeof v === "object" && v !== null && Object.entries(v as Record<string, unknown>).some(([k, x]) => k === "__unknown" || hasNested(x));
    for (const [name, schema, valid] of rows) {
      if (!hasNested(valid)) {
        expect(() => schema.parse(valid), `${name}: 妥当な値が通らない(表の値が壊れている)`).not.toThrow();
        expect(() => schema.parse({ ...valid, __unknown: 1 }), `${name}: 未知フィールドを拒否していない`).toThrow();
      } else {
        expect(() => schema.parse(valid), `${name}: 入れ子の未知フィールドを拒否していない`).toThrow();
      }
    }
    // メタ: core が export する zod スキーマ(safeParse を持つ値)は必ず表に載っている。
    // 同一性で照合するので、スキーマを足して表に足し忘れると必ずここで落ちる
    const covered = new Set<unknown>(rows.map(([, schema]) => schema));
    const missing = Object.entries(core as Record<string, unknown>)
      .filter(([, v]) => typeof v === "object" && v !== null && typeof (v as { safeParse?: unknown }).safeParse === "function")
      .filter(([name, v]) => !NON_OBJECT_SCHEMAS.has(name) && !covered.has(v))
      .map(([name]) => name);
    expect(missing, "core の export に表へ未登録の zod スキーマがある(表に 1 行足す)").toEqual([]);
  });
});

describe("attributeChangeIssue", () => {
  it("returns machine readable codes for control 422", () => {
    expect(attributeChangeIssue({ name: "onclick", value: "x" })?.code).toBe("attribute_not_allowed");
    expect(attributeChangeIssue({ name: "href", value: "javascript:alert(1)" })?.code).toBe("attribute_url_not_allowed");
    expect(attributeChangeIssue({ name: "href", value: "/lp2/" })).toBeNull();
    expect(attributeChangeIssue({ name: "data-x", value: "1" })).toBeNull();
  });
});
