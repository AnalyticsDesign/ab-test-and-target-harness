import { describe, expect, it } from "vitest";
import { budgetFromInput, NEW_PROFILE_BUDGET_HINT, NEW_PROFILE_BUDGET_LABEL } from "../lib/new-profile-budget";

describe("new profile budget input", () => {
  it("empty_input_means_null_the_plan_default", () => {
    expect(budgetFromInput("")).toBeNull();
    expect(budgetFromInput("   ")).toBeNull();
    expect(budgetFromInput(null)).toBeNull();
  });
  it("a_number_is_sent_as_a_number_and_range_checks_are_left_to_control", () => {
    expect(budgetFromInput("5000")).toBe(5000);
    expect(budgetFromInput(" 20000 ")).toBe(20000);
    expect(budgetFromInput("0")).toBe(0);
    expect(budgetFromInput("1.5")).toBe(1.5);
  });
  it("shows_the_label_and_help_text", () => {
    expect(NEW_PROFILE_BUDGET_LABEL).toBe("新しい訪問者の記録の上限(1 日あたり)");
    expect(NEW_PROFILE_BUDGET_HINT).toBe(
      "履歴の条件を使うサイトで、1 日に新しく記録する訪問者の数の上限です。超えた訪問者にもテストは表示されますが、その訪問の記録は残りません。1 時間あたりはこの値の 10% までです。空欄にすると、使用状況の設定の Cloudflare のプランに合わせた既定値(Free 20,000 / Paid 200,000)を使います。Free では、全サイトの合計にも 1 日 20,000 件の上限があります",
    );
  });
});
