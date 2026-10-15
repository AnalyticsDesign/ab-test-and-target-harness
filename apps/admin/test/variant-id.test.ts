import { describe, expect, it } from "vitest";
import { variantIdIssue, VARIANT_ID_RE } from "@/lib/variant-id";

describe("variantIdIssue()(Variant ID の受理 / 拒否。control の SLUG_RE と同じ規則。Plan 10 B1)", () => {
  it.each(["a", "v3", "hero-b", "x_1", "0", "a".repeat(64)])("accepts %s", (id) => expect(variantIdIssue(id, ["existing1", "existing2"])).toBeNull());
  it.each(["A", "vB", "-a", "_a", "a/b", "a b", "a".repeat(65), "日本"])("rejects %s with a format reason", (id) => expect(variantIdIssue(id, [])).toMatch(/英小文字/));
  it("rejects a duplicate with the id in the reason", () => expect(variantIdIssue("b", ["a", "b"])).toContain('"b"'));
  it("returns null for empty input (button disabled, no reason shown)", () => expect(variantIdIssue("", ["a"])).toBeNull());
  it("VARIANT_ID_RE is the same source as control's SLUG_RE (apps/control/src/ids.ts) — change both together", () => expect(VARIANT_ID_RE.source).toBe("^[a-z0-9][a-z0-9_-]{0,63}$"));
});
