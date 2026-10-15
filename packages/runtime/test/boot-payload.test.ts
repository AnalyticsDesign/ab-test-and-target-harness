import { describe, it, expect } from "vitest";
import type { CompiledConfig, RuntimeSettings } from "@wtt/core";
import { parseBootPayload } from "../src/runtime";

// 実 shape(@wtt/core)から組み立てる。ここが core の schema とズレたら検知できるようにする(review finding)
const validConfig: CompiledConfig = {
  schemaVersion: 2,
  version: 3,
  siteId: "site_b",
  siteSalt: "salt_test",
  needsProfile: false,
  patterns: {},
  prehide: {},
  exposureSelectors: {},
  goals: [],
  experiments: [],
};

const validSettings: RuntimeSettings = {
  mode: "A",
  idSource: "ab",
  visitorCookieName: "_ab_vid",
  uuidCookieEnabled: false,
  uuidCookieName: "_ab_uuid",
  previousCookieNames: [],
  decisionTimeoutMs: 1000,
  consentMode: "implicit",
};

describe("parseBootPayload (plan 3 task 2 — final implementation, no zod)", () => {
  it("accepts a well-formed { config, settings } payload", () => {
    const result = parseBootPayload({ config: validConfig, settings: validSettings });
    expect(result).toEqual({ config: validConfig, settings: validSettings });
  });

  it("apiBase は任意の文字列。無ければ省き、文字列でなければ boot 全体を拒否する(決定 52 (7))", () => {
    expect(parseBootPayload({ config: validConfig, settings: validSettings, apiBase: "https://edge.example" })).toEqual({ config: validConfig, settings: validSettings, apiBase: "https://edge.example" });
    expect(parseBootPayload({ config: validConfig, settings: validSettings })).toEqual({ config: validConfig, settings: validSettings });
    expect(parseBootPayload({ config: validConfig, settings: validSettings, apiBase: 1 })).toBeNull();
  });

  it("rejects non-object / null payloads", () => {
    expect(parseBootPayload(null)).toBeNull();
    expect(parseBootPayload(undefined)).toBeNull();
    expect(parseBootPayload("nope")).toBeNull();
    expect(parseBootPayload(42)).toBeNull();
    expect(parseBootPayload([])).toBeNull(); // 配列は typeof "object" だが config/settings が欠落し reject される
  });

  it("rejects unknown schemaVersion (spec §6.4: 未知 schemaVersion は何も適用しない)", () => {
    expect(parseBootPayload({ config: { ...validConfig, schemaVersion: 3 }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, schemaVersion: undefined }, settings: validSettings })).toBeNull();
  });

  it("rejects malformed config field types", () => {
    expect(parseBootPayload({ config: { ...validConfig, experiments: "not-an-array" }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, siteId: 123 }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, version: "3" }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, siteSalt: 123 }, settings: validSettings })).toBeNull();
  });

  it("rejects malformed prehide / exposureSelectors / patterns (r1 CL-High-1: for-of / Object.values 前提のコレクション形)", () => {
    expect(parseBootPayload({ config: { ...validConfig, prehide: [] }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, prehide: "x" }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposureSelectors: [] }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposureSelectors: "x" }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, patterns: [] }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, patterns: "x" }, settings: validSettings })).toBeNull();
  });

  it("rejects non-array goals", () => {
    expect(parseBootPayload({ config: { ...validConfig, goals: "not-an-array" }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, goals: {} }, settings: validSettings })).toBeNull();
  });

  it("rejects malformed settings field types", () => {
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, visitorCookieName: 1 } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, visitorCookieName: undefined } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, uuidCookieName: 1 } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, uuidCookieEnabled: "false" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, idSource: 1 } })).toBeNull();
  });

  it("rejects a malformed previousCookieNames (must be an array of strings)", () => {
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, previousCookieNames: "not-an-array" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, previousCookieNames: [1, 2] } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, previousCookieNames: ["ok", 1] } })).toBeNull();
  });

  it("rejects a non-finite / non-number decisionTimeoutMs", () => {
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, decisionTimeoutMs: "1000" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, decisionTimeoutMs: Infinity } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, decisionTimeoutMs: NaN } })).toBeNull();
  });

  it("rejects a consentMode outside implicit | required", () => {
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, consentMode: "optional" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, consentMode: undefined } })).toBeNull();
  });

  it("rejects a mode outside A | B", () => {
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, mode: "C" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, mode: undefined } })).toBeNull();
  });

  it("accepts analytics settings and exposurePayloads, rejects malformed shapes (spec §10.9: 欠落は既定へ、型不正は拒否)", () => {
    const analytics = {
      extraKey: "wtt_x",
      exposure: { event: "wtt_exposure", keys: { experimentId: "a", experimentName: "b", variantId: "c", variantName: "d" } },
      conversion: { event: "wtt_conversion", keys: { goalId: "e", goalName: "f" } },
    };
    const payloads = { exp: { vA: { experimentId: "exp", experimentName: "E", variantId: "vA", variantName: "A", extra: {} } } };
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: payloads }, settings: { ...validSettings, analytics } })).not.toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: validSettings })).not.toBeNull(); // 両方欠落 = 旧 record
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, analytics: "x" } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, analytics: { extraKey: 1 } } })).toBeNull();
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, analytics: { ...analytics, exposure: { event: "x" } } } })).toBeNull(); // keys 欠落
    expect(parseBootPayload({ config: validConfig, settings: { ...validSettings, analytics: { ...analytics, conversion: { event: "x", keys: { goalId: "g" } } } } })).toBeNull(); // goalName 欠落
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: [] }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: "x" }, settings: validSettings })).toBeNull();
    // 内側の階層も見る(§10.9「型不正は拒否」。CX-Medium-3 / CL-Medium-1)
    const p = payloads.exp.vA;
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: [] } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: null } } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: {} } } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: { ...p, experimentName: 1 } } } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: { ...p, extra: null } } } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: { ...p, extra: [] } } } }, settings: validSettings })).toBeNull();
    expect(parseBootPayload({ config: { ...validConfig, exposurePayloads: { exp: { vA: { ...p, extra: { k: 1 } } } } }, settings: validSettings })).toBeNull();
  });
});
