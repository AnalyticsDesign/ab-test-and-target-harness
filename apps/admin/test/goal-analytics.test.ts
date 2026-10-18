import { describe, expect, it } from "vitest";
import { goalAnalyticsBody, goalNameOf } from "@/lib/goal-analytics";

describe("目標の外部計測の送り方(B77 Task 10)", () => {
  it("goalNameOf: 指定が無ければ空文字(指定なし)", () => {
    expect(goalNameOf(null)).toBe("");
    expect(goalNameOf({})).toBe("");
    expect(goalNameOf({ overrides: { goalName: "購入" } })).toBe("購入");
  });
  it("goalAnalyticsBody: 名前を入れたら overrides.goalName で送る", () => {
    expect(goalAnalyticsBody("購入", null)).toEqual({ analytics: { overrides: { goalName: "購入" } } });
    expect(goalAnalyticsBody("購入", { overrides: { goalName: "旧" } })).toEqual({ analytics: { overrides: { goalName: "購入" } } });
  });
  it("goalAnalyticsBody: 空にして、前に指定があったら null で消す", () => {
    expect(goalAnalyticsBody("", { overrides: { goalName: "旧" } })).toEqual({ analytics: null });
  });
  it("goalAnalyticsBody: 空で、前も指定が無いなら analytics を送らない(未設定のまま)", () => {
    expect(goalAnalyticsBody("", null)).toEqual({});
    expect(goalAnalyticsBody("", {})).toEqual({});
  });
});
