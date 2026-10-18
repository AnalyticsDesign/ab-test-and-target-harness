import { describe, expect, it } from "vitest";
import { nextVariantId } from "@/lib/variant-id";

describe("nextVariantId()(パターン ID の自動の採番。B77 設計書 Q23)", () => {
  it("nextVariantId", () => {
    expect(nextVariantId(["a", "b"])).toBe("c");
    expect(nextVariantId(["b"])).toBe("a"); // 消した ID は使い直す(下書きのみ)
    expect(nextVariantId("abcdefghijklmnopqrstuvwxyz".split(""))).toBe("aa");
    expect(nextVariantId([..."abcdefghijklmnopqrstuvwxyz".split(""), "aa"])).toBe("ab");
  });
  it("空なら a。API で付けた ID(v1 など)は数に入れずに a から探す", () => {
    expect(nextVariantId([])).toBe("a");
    expect(nextVariantId(["v1", "hero-b", "a"])).toBe("b");
  });
});
