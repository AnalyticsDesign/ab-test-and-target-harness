import { describe, expect, it } from "vitest";
import { oauthErrorMessage } from "@/lib/oauth-errors";

describe("oauthErrorMessage", () => {
  it("explains a Google account that was not invited (both codes the control may send)", () => {
    expect(oauthErrorMessage("not_invited")).toContain("招待");
    expect(oauthErrorMessage("unable_to_create_user")).toBe(oauthErrorMessage("not_invited"));
  });
  it("has a message for cancel and for anything unknown, and none when there is no error", () => {
    expect(oauthErrorMessage("access_denied")).toContain("キャンセル");
    expect(oauthErrorMessage("whatever")).toContain("もう一度");
    expect(oauthErrorMessage(null)).toBeNull();
    expect(oauthErrorMessage("")).toBeNull();
  });
});
