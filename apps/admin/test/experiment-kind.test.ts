import { describe, expect, it } from "vitest";
import { createButtonLabel, KIND_HINT, KIND_JA } from "@/lib/experiment-kind";

describe("experiment kind wording (決定 51・決定 54)", () => {
  it("labels the kinds with the glossary words", () => {
    expect(KIND_JA).toEqual({ test: "テスト", single: "パーソナライズ" });
  });
  it("tells what the create button prepares", () => {
    expect(createButtonLabel("test")).toBe("作成(パターン A / B を 50:50 で用意します)");
    expect(createButtonLabel("single")).toBe("作成(パターン A を 1 つ用意します)");
  });
  it("explains each kind in one sentence", () => {
    expect(KIND_HINT.test).toBe("2 つ以上のパターンに訪問者を振り分けて比べます");
    expect(KIND_HINT.single).toBe("1 つのパターンを、条件に合う訪問者全員に表示します。振り分けや比較はしません");
  });
});
