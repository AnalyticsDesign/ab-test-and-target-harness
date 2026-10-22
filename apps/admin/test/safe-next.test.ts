import { describe, expect, it } from "vitest";
import { NEXT_RE, safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("passes only /invite/<id>", () => {
    expect(safeNext("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
    for (const v of ["/w", "//evil.example/invite/a", "https://evil.example/invite/a", "/invite/a/b", "/invite/", "/invite/a?x=1", "", null, undefined, 1]) {
      expect(safeNext(v)).toBeNull();
    }
  });

  it("NEXT_RE stays the same literal as control's copy (B21)", () => {
    // 別デプロイなので共有せず、両側の literal をテストで固定する。片方の式だけを変えると、その側のこのテストが落ちて相手に気づける。
    // 相手: control の src/routes/oauth.ts の NEXT_RE(テストは control の test/oauth.test.ts)。式を変えるときは両側の定義とテストを同時に変える
    expect([NEXT_RE.source, NEXT_RE.flags]).toEqual(["^\\/invite\\/[A-Za-z0-9_-]{1,64}$", ""]);
  });
});
