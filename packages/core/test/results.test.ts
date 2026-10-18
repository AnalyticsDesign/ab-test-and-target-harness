import { describe, it, expect, vi, afterEach } from "vitest";
import { RUN_ID_RE, newRunId, shortVisitorHash, utcDay, nextUtcMidnight } from "../src/results";

describe("newRunId", () => {
  it("returns a 22-character base64url string that matches RUN_ID_RE and does not repeat", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = newRunId();
      expect(id).toMatch(RUN_ID_RE);
      expect(id).not.toContain("=");
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });
});

describe("RUN_ID_RE", () => {
  it("accepts exactly 22 base64url characters", () => {
    expect(RUN_ID_RE.test("A".repeat(22))).toBe(true);
    expect(RUN_ID_RE.test("A".repeat(21))).toBe(false);
    expect(RUN_ID_RE.test("A".repeat(23))).toBe(false);
    expect(RUN_ID_RE.test("A".repeat(21) + "=")).toBe(false);
  });
});

describe("shortVisitorHash", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is the base64url of the first 8 bytes of SHA-256 (abc -> ba7816bf8f01cfea)", async () => {
    expect(await shortVisitorHash("abc")).toBe("ungWv48Bz-o");
  });
  it("returns null when crypto.subtle is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    expect(await shortVisitorHash("abc")).toBeNull();
    vi.stubGlobal("crypto", undefined);
    expect(await shortVisitorHash("abc")).toBeNull();
  });
});

describe("utcDay / nextUtcMidnight", () => {
  it("formats the UTC day and finds the next UTC midnight", () => {
    const t = Date.UTC(2026, 9, 16, 23, 59);
    expect(utcDay(t)).toBe("2026-10-16");
    expect(nextUtcMidnight(t)).toBe(Date.UTC(2026, 9, 17));
    expect(nextUtcMidnight(Date.UTC(2026, 9, 17))).toBe(Date.UTC(2026, 9, 18)); // ちょうど 0 時なら次の日
  });
});
