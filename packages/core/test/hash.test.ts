import { describe, it, expect } from "vitest";
import { murmur3_32, bucketOf, inTraffic } from "../src/hash";

describe("murmur3_32 (x86, seed 0)", () => {
  // 公知の参照ベクタ。実装がこれに合わない場合はベクタでなく実装を疑うこと
  it.each([
    ["", 0],
    ["a", 0x3c2569b2],
    ["abc", 0xb3dd93fa],
    ["hello", 0x248bfa47],
  ])("hash(%j) === %i", (key, expected) => {
    expect(murmur3_32(key as string)).toBe(expected);
  });
  it("is deterministic and uint32", () => {
    const h = murmur3_32("v_123:exp_001");
    expect(h).toBe(murmur3_32("v_123:exp_001"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("bucketOf / inTraffic", () => {
  it("bucket is in [0, 9999]", () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucketOf(`v${i}`, "exp_001");
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(9999);
    }
  });
  it("distributes roughly uniformly (10k visitors, 4 quartiles within ±15%)", () => {
    const q = [0, 0, 0, 0];
    for (let i = 0; i < 10000; i++) q[Math.floor(bucketOf(`visitor-${i}`, "exp_x") / 2500)]!++;
    for (const c of q) { expect(c).toBeGreaterThan(2500 * 0.85); expect(c).toBeLessThan(2500 * 1.15); }
  });
  it("traffic 100 includes everyone, 0 includes no one", () => {
    expect(inTraffic("v1", "e1", 100)).toBe(true);
    expect(inTraffic("v1", "e1", 0)).toBe(false);
  });
  it("traffic 50 includes roughly half of 10k visitors", () => {
    let inCount = 0;
    for (let i = 0; i < 10000; i++) if (inTraffic(`visitor-${i}`, "exp_x", 50)) inCount++;
    expect(inCount).toBeGreaterThan(4600);
    expect(inCount).toBeLessThan(5400);
  });
});
