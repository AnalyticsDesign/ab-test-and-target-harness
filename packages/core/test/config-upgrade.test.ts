import { describe, expect, it } from "vitest";
import { CompiledConfigSchema, CompiledConfigV2Schema, decide, matchesTargetUrl, parseCompiledConfig, upgradeV2, type CompiledConfigV2 } from "../src/index";
import { COMPILED_V2, NAMED_V2, PAGE_CTX_V2 } from "./fixtures/compiled-v2";
import { PARITY_CONFIG } from "./fixtures/parity-v2";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("版 2 の凍結したスキーマ(B69)", () => {
  it("版 2 の compile が出した値を受ける(凍結の写しが正しい)", () => {
    expect(CompiledConfigV2Schema.safeParse(COMPILED_V2).success).toBe(true);
    expect(CompiledConfigV2Schema.safeParse(NAMED_V2).success).toBe(true);
    // 版 3 は版 2 のスキーマで読まない(版で振り分ける)
    expect(CompiledConfigV2Schema.safeParse(PARITY_CONFIG).success).toBe(false);
    expect(CompiledConfigSchema.safeParse(COMPILED_V2).success).toBe(false);
  });
});

describe("upgradeV2(B69、spec §5)", () => {
  it("upgrade_v2_wraps_url_match_and_excludes_page_ctx", () => {
    const before = clone(COMPILED_V2);
    const out = upgradeV2(COMPILED_V2);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(COMPILED_V2).toEqual(before); // 入力を書き換えない
    expect(out.schemaVersion).toBe(3);
    // query を持つテスト(e_query)が無く、ほかは順を保つ
    expect(out.experiments.map((e) => e.id)).toEqual(["e_path_re", "e_host_re", "e_plain"]);
    // 持たないテストの urlMatch は { include: [{ page: <元> }] }(命令列もそのまま)
    for (const e of out.experiments) {
      const orig = COMPILED_V2.experiments.find((x) => x.id === e.id)!;
      expect(e.urlMatch).toEqual({ include: [{ page: orig.urlMatch }] });
    }
    // 外したものの鍵が prehide・exposureSelectors・exposurePayloads・results に無い
    for (const r of [out.prehide, out.exposureSelectors, out.exposurePayloads!, out.results!.runs]) expect(Object.keys(r)).not.toContain("e_query");
    expect(Object.keys(out.prehide)).toEqual(["e_path_re", "e_host_re", "e_plain"]);
    expect(out.results).toEqual({ forget: true, runs: { e_path_re: "runAAAAAAAAAAAAAAAAAAA", e_plain: "runCCCCCCCCCCCCCCCCCCC" } });
    // needsProfile は残ったもの(履歴の条件も persistAssignment も無い)から計算し直す: true → false
    expect(COMPILED_V2.needsProfile).toBe(true);
    expect(out.needsProfile).toBe(false);
    // 目標・パターン・payload の中身・timezone は変えない
    expect(out.goals).toEqual(COMPILED_V2.goals);
    expect(out.patterns).toEqual(COMPILED_V2.patterns);
    expect(out.conversionPayloads).toEqual(COMPILED_V2.conversionPayloads);
    expect(out.exposurePayloads!.e_plain).toEqual(COMPILED_V2.exposurePayloads!.e_plain);
    expect(out.timezone).toBe("Asia/Tokyo");
    expect(CompiledConfigSchema.safeParse(out).success).toBe(true);
    // 意味は変わらない: 包んだ対象 URL の照合は元の 1 つのページの一致と同じ
    const urls = ["https://www.example.com/products/12", "https://shop.example.com/products/x", "https://www.example.com/lp/a", "https://other.test/lp/"];
    for (const e of out.experiments) {
      const orig = COMPILED_V2.experiments.find((x) => x.id === e.id)!;
      for (const u of urls) expect(matchesTargetUrl(u, e.urlMatch)).toBe(matchesTargetUrl(u, { include: [{ page: orig.urlMatch }] }));
    }
    // 外したテストは配信されない(クエリが合っていても)
    const ctx = { url: "https://www.example.com/products/12?utm=mail", device: "mobile" as const, referrer: "" };
    expect(decide(out, ctx, "A".repeat(22), { goals: {}, pages: {} }).map((d) => d.experimentId)).toEqual(["e_path_re", "e_host_re"]);
  });

  it("needsProfile は残ったものの履歴の条件・persistAssignment で true のまま", () => {
    const c = clone(COMPILED_V2);
    c.experiments[3]!.targeting = { not: { hist: "converted", goal: "g_buy" } };
    expect(upgradeV2(c)!.needsProfile).toBe(true);
    const d = clone(COMPILED_V2);
    d.experiments[0]!.persistAssignment = true;
    expect(upgradeV2(d)!.needsProfile).toBe(true);
    // 外す条件が not の下・オーディエンスを展開した or の奥にあっても外す
    const e = clone(COMPILED_V2);
    e.experiments[0]!.targeting = { or: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { ctx: "path", op: "startsWith", value: "/a" } }] };
    e.experiments[1]!.targeting = { ctx: "url", op: "contains", value: "/" };
    e.experiments[3]!.targeting = { ctx: "host", op: "equals", value: "www.example.com" };
    expect(upgradeV2(e)!.experiments).toEqual([]);
    expect(upgradeV2(e)!.needsProfile).toBe(false);
  });

  it("版 2 の配信条件のページの条件(url・host・path・query のすべての形、命令列つき・not の下)を版 2 のスキーマが読み、upgradeV2 がそれだけを外す", () => {
    // 版 2 のスキーマが読めないと parseCompiledConfig が null = サイト全体が配られない。外すのはそのエクスペリエンスだけのはず
    expect(CompiledConfigV2Schema.safeParse(PAGE_CTX_V2).success).toBe(true);
    const out = parseCompiledConfig(clone(PAGE_CTX_V2));
    expect(out).not.toBeNull();
    expect(out!.experiments.map((e) => e.id)).toEqual(["e_keep"]);
    expect(Object.keys(out!.prehide)).toEqual(["e_keep"]);
    expect(Object.keys(out!.exposureSelectors)).toEqual(["e_keep"]);
    expect(out!.results).toEqual({ forget: true, runs: { e_keep: "runEEEEEEEEEEEEEEEEEEE" } });
    expect(out!.experiments[0]!.targeting).toEqual({ ctx: "referrer", op: "isEmpty" });
  });

  it("版 2 の命令数の合計は配信条件の命令列も数える(対象 URL + 配信条件で 500 を超える版 2 は読まない)", () => {
    const prog = (n: number) => ({ v: 1, sets: [[0, 0, 0, 0]], code: Array.from({ length: n * 3 }, (_, i) => (i === (n - 1) * 3 ? 5 : 0)) });
    const at = (urlN: number, dslN: number): CompiledConfigV2 => ({
      ...clone(PAGE_CTX_V2),
      experiments: [{ ...clone(PAGE_CTX_V2.experiments[0]!), urlMatch: { part: "path", op: "regex", value: "^/x", prog: prog(urlN) }, targeting: { ctx: "path", op: "regex", value: "^/y", prog: prog(dslN) } }],
      prehide: {}, exposureSelectors: {}, results: { forget: true, runs: {} },
    });
    expect(CompiledConfigV2Schema.safeParse(at(250, 250)).success).toBe(true); // 500
    expect(CompiledConfigV2Schema.safeParse(at(250, 251)).success).toBe(false); // 501
  });

  it("upgrade_v2_keeps_legacy_names_in_payloads(名前を payload に移してから落とし、版 3 の schema を通る)", () => {
    const out = upgradeV2(NAMED_V2);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(JSON.stringify({ e: out.experiments, g: out.goals })).not.toMatch(/"name"/);
    expect(out.exposurePayloads!.exp1!.a).toEqual({ experimentId: "exp1", experimentName: "社内のヒーロー検証", variantId: "a", variantName: "A案", extra: {} });
    expect(out.exposurePayloads!.exp1!.b!.variantName).toBe("社内の部長案");
    expect(out.conversionPayloads).toEqual({ g_buy: { goalId: "g_buy", goalName: "購入完了" } });
    expect(CompiledConfigSchema.safeParse(out).success).toBe(true);
  });

  it("ID が prototype の名前でも外す・残すを自分のキーだけで決める", () => {
    const c = clone(COMPILED_V2);
    for (const [from, to] of [["e_query", "constructor"], ["e_plain", "toString"]] as const) {
      const e = c.experiments.find((x) => x.id === from)!;
      e.id = to;
      const rename = <T>(r: Record<string, T>) => {
        const v = r[from]!;
        delete r[from];
        Object.defineProperty(r, to, { value: v, enumerable: true, writable: true, configurable: true });
      };
      rename(c.prehide);
      rename(c.exposureSelectors);
      rename(c.exposurePayloads!);
      for (const p of Object.values(c.exposurePayloads![to]!)) p.experimentId = to;
      rename(c.results!.runs);
    }
    const out = upgradeV2(c)!;
    expect(out.experiments.map((e) => e.id)).toEqual(["e_path_re", "e_host_re", "toString"]);
    expect(Object.keys(out.prehide)).toEqual(["e_path_re", "e_host_re", "toString"]);
    expect(Object.prototype.hasOwnProperty.call(out.exposurePayloads, "constructor")).toBe(false);
    expect(Object.keys(out.results!.runs)).toEqual(["e_path_re", "toString"]);
  });

  it("変換の後に版 3 の schema を通らなければ null(壊れた設定を配らない)", () => {
    // upgradeV2 を(版 2 の parse を通さずに)直接呼んだときも、最後の版 3 の検査が断る
    const weights = clone(COMPILED_V2);
    weights.experiments[0]!.variants[0]!.weight = 40; // 合計 90
    expect(upgradeV2(weights)).toBeNull();
    const big = clone(COMPILED_V2);
    big.experiments[0]!.urlMatch = { part: "path", op: "regex", value: "x", prog: { v: 1, sets: [], code: Array.from({ length: 501 * 3 }, () => 0) } };
    expect(upgradeV2(big)).toBeNull(); // 全行の命令数の合計が 500 を超える
  });
});

describe("parseCompiledConfig(版 3 はそのまま、版 2 は upgradeV2、ほかは null)", () => {
  it("版 3 はそのまま読む", () => {
    expect(parseCompiledConfig(clone(PARITY_CONFIG))).toEqual(PARITY_CONFIG);
  });
  it("版 2 は upgradeV2 を通した値", () => {
    expect(parseCompiledConfig(clone(COMPILED_V2))).toEqual(upgradeV2(COMPILED_V2));
    expect(parseCompiledConfig(clone(NAMED_V2))!.schemaVersion).toBe(3);
  });
  it("unknown_schema_version_4_is_null", () => {
    expect(parseCompiledConfig({ ...clone(PARITY_CONFIG), schemaVersion: 4 })).toBeNull();
    expect(parseCompiledConfig({ ...clone(PARITY_CONFIG), schemaVersion: 1 })).toBeNull();
    expect(parseCompiledConfig({ ...clone(PARITY_CONFIG), schemaVersion: "3" })).toBeNull();
    for (const v of [null, undefined, "x", 3, []]) expect(parseCompiledConfig(v)).toBeNull();
  });
  it("壊れた版 2・版 3 は null", () => {
    const v2 = clone(COMPILED_V2) as CompiledConfigV2 & Record<string, unknown>;
    v2.unknownKey = 1;
    expect(parseCompiledConfig(v2)).toBeNull();
    // 版 3 と書いてあるのに版 2 の形(対象 URL が 1 つのページの一致)
    expect(parseCompiledConfig({ ...clone(COMPILED_V2), schemaVersion: 3 })).toBeNull();
  });
});
