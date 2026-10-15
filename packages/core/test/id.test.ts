import { describe, it, expect } from "vitest";
import { generateVisitorId, isValidVisitorId, visitorIdToUuid, uuidToVisitorId, isCanonicalModeAId, isAcceptableVisitorId, hashByoidValue, MODE_C_ID_RE, visitorIdIssuedAt, deriveExternalUuid } from "../src/id";

describe("visitor id", () => {
  it("generates 22-char base64url (16 random bytes)", () => {
    const id = generateVisitorId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateVisitorId()).not.toBe(id);
  });
  it("accepts 22-char (Mode A) and 43-char (Mode C SHA-256) ids", () => {
    expect(isValidVisitorId("A".repeat(22))).toBe(true);
    expect(isValidVisitorId("B".repeat(43))).toBe(true);
  });
  it.each(["", "A".repeat(21), "A".repeat(23), "A".repeat(44), "A".repeat(21) + "+", "A".repeat(42) + "="])(
    "rejects %j",
    (bad) => expect(isValidVisitorId(bad)).toBe(false),
  );
});

describe("UUIDv7(決定 49、設計書 §7.1)と正本の表記変換", () => {
  const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("generated ids are UUIDv7 (version/variant bits fixed)", () => {
    for (let i = 0; i < 100; i++) {
      expect(visitorIdToUuid(generateVisitorId())).toMatch(UUID_V7_RE);
    }
  });
  it("先頭 48 bit は発行時刻の Unix ミリ秒(注入した乱数・時刻でも version / variant は固定)", () => {
    const id = generateVisitorId((b) => b.fill(0), 0x0123456789ab);
    expect(visitorIdToUuid(id)).toBe("01234567-89ab-7000-8000-000000000000");
    expect(visitorIdIssuedAt(id)).toBe(0x0123456789ab);
  });
  it("visitorIdIssuedAt: v7 は発行時刻、v4(v1.0 より前に発行)と Mode A 以外は null", () => {
    const now = Date.UTC(2026, 9, 2);
    expect(visitorIdIssuedAt(generateVisitorId(undefined, now))).toBe(now);
    expect(visitorIdIssuedAt(uuidToVisitorId("12345678-1234-4123-8123-123456789abc")!)).toBeNull();
    expect(visitorIdIssuedAt("B".repeat(43))).toBeNull();
    expect(visitorIdIssuedAt("A".repeat(22))).toBeNull();
  });
  it("round-trips id -> uuid -> id losslessly", () => {
    const id = generateVisitorId();
    const uuid = visitorIdToUuid(id)!;
    expect(uuidToVisitorId(uuid)).toBe(id);
  });
  it("uuidToVisitorId accepts uppercase input (canonical output stays lowercase)", () => {
    const id = generateVisitorId();
    const uuid = visitorIdToUuid(id)!;
    expect(uuidToVisitorId(uuid.toUpperCase())).toBe(id);
  });
  it.each(["B".repeat(43), "not-an-id", "", "A".repeat(21)])(
    "visitorIdToUuid returns null for non-Mode-A id %j",
    (bad) => expect(visitorIdToUuid(bad)).toBeNull(),
  );
  it.each([
    "",
    "zz",
    "00000000-0000-0000-8000-000000000000", // version != 4 / 7
    "00000000-0000-6000-8000-000000000000", // version 6
    "00000000-0000-4000-0000-000000000000", // variant not RFC 4122
    "00000000-0000-4000-8000-00000000000g", // non-hex
    "00000000000040008000000000000000", // no hyphens
  ])("uuidToVisitorId returns null for invalid v4 / v7 uuid %j", (bad) =>
    expect(uuidToVisitorId(bad)).toBeNull(),
  );
});

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("strict Mode A validator (spec §5.4 / §9.5)", () => {
  it("accepted_mode_a_id_always_round_trips", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateVisitorId();
      expect(isCanonicalModeAId(id)).toBe(true);
      expect(isAcceptableVisitorId(id)).toBe(true);
      const uuid = visitorIdToUuid(id);
      expect(uuid).not.toBeNull();
      expect(uuidToVisitorId(uuid!)).toBe(id);
    }
  });
  it("non_v4_or_v7_22_char_id_is_rejected", () => {
    // "A"×22 は全ゼロ 16 バイト = version 0。r3 実測でこの ID が受理されていた
    expect(isCanonicalModeAId("A".repeat(22))).toBe(false);
    expect(isAcceptableVisitorId("A".repeat(22))).toBe(false);
    expect(visitorIdToUuid("A".repeat(22))).toBeNull();
    // v6 も受けない。v4(v1.0 より前に発行)と v7(v1.0 から発行)は受ける(決定 49)
    expect(isCanonicalModeAId(uuidToVisitorId("12345678-1234-4123-8123-123456789abc")!)).toBe(true);
    expect(isCanonicalModeAId(uuidToVisitorId("12345678-1234-7123-8123-123456789abc")!)).toBe(true);
    const v6 = Buffer.from("12345678123461238123123456789abc", "hex").toString("base64url"); // version 6 の 22 文字
    expect(v6).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isCanonicalModeAId(v6)).toBe(false);
  });
  it("noncanonical_base64url_tail_is_rejected", () => {
    // 22 文字目は上位 2 bit のみデータ、下位 4 bit は padding(canonical では 0)。
    // canonical な最終文字の index は 16 の倍数なので +1 は「同じ 16 バイトに復号される非 canonical 表現」
    const id = uuidToVisitorId("12345678-1234-4123-8123-123456789abc")!;
    const idx = B64URL.indexOf(id[21]!);
    expect(idx % 16).toBe(0);
    const tampered = id.slice(0, 21) + B64URL[idx + 1];
    expect(isCanonicalModeAId(tampered)).toBe(false);
    expect(isAcceptableVisitorId(tampered)).toBe(false);
    expect(visitorIdToUuid(tampered)).toBeNull();
  });
  it("mode C 43-char は文字種と長さのみで受理(spec §9.5)", () => {
    expect(isAcceptableVisitorId("B".repeat(43))).toBe(true);
    expect(isAcceptableVisitorId("B".repeat(42) + "+")).toBe(false);
    expect(isAcceptableVisitorId("B".repeat(42))).toBe(false);
    expect(isCanonicalModeAId("B".repeat(43))).toBe(false);
  });
});

describe("hashByoidValue", () => {
  it("hashByoidValue produces 43-char base64url of SHA-256(salt + value) (spec §4.3 / §9.5)", async () => {
    const id = await hashByoidValue("salt-1", "session-abc");
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(MODE_C_ID_RE.test(id)).toBe(true);
    // 決定論: 同一入力は同一出力、salt が違えば別出力
    expect(await hashByoidValue("salt-1", "session-abc")).toBe(id);
    expect(await hashByoidValue("salt-2", "session-abc")).not.toBe(id);
  });
});

describe("deriveExternalUuid(決定 49、設計書 §7.2)", () => {
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  it("決定的・常に v4・正本とは別の値・BYOID の 43 文字からも導出できる", async () => {
    const id = generateVisitorId();
    const a = await deriveExternalUuid("salt-1", id);
    expect(a).toMatch(UUID_V4_RE);
    expect(await deriveExternalUuid("salt-1", id)).toBe(a);
    expect(a).not.toBe(visitorIdToUuid(id)); // 写しではない(発行時刻が外部に渡らない)
    expect(await deriveExternalUuid("salt-2", id)).not.toBe(a);
    expect(await deriveExternalUuid("salt-1", "B".repeat(43))).toMatch(UUID_V4_RE);
  });
  it("入力は 'ab-uuid/v1' + salt + 正本の ID(接頭辞の版を変えると値が変わる)", async () => {
    const id = generateVisitorId();
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ab-uuid/v1salt-1${id}`)));
    d[6] = (d[6]! & 0x0f) | 0x40;
    d[8] = (d[8]! & 0x3f) | 0x80;
    const hex = Array.from(d.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await deriveExternalUuid("salt-1", id)).toBe(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  });
});
