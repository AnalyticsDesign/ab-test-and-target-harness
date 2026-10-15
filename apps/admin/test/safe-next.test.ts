import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("passes only /invite/<id>", () => {
    expect(safeNext("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
    for (const v of ["/w", "//evil.example/invite/a", "https://evil.example/invite/a", "/invite/a/b", "/invite/", "/invite/a?x=1", "", null, undefined, 1]) {
      expect(safeNext(v)).toBeNull();
    }
  });
});
