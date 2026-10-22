import { describe, expect, it } from "vitest";
import { FLOW_RE } from "@/lib/oauth-flow";

describe("FLOW_RE", () => {
  it("stays the same literal as control's copy (B21)", () => {
    // 別デプロイなので共有せず、両側の literal をテストで固定する。片方の式だけを変えると、その側のこのテストが落ちて相手に気づける。
    // 相手: control の src/routes/oauth.ts の FLOW_RE(テストは control の test/oauth.test.ts)。式を変えるときは両側の定義とテストを同時に変える
    expect([FLOW_RE.source, FLOW_RE.flags]).toEqual(["^[A-Za-z0-9_-]{16,64}$", ""]);
  });
});
