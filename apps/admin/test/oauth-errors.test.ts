import { describe, expect, it } from "vitest";
import { oauthErrorMessage } from "@/lib/oauth-errors";

describe("oauthErrorMessage", () => {
  it("explains a Google account that was not invited (both codes the control may send)", () => {
    expect(oauthErrorMessage("not_invited")).toContain("招待");
    expect(oauthErrorMessage("unable_to_create_user")).toBe(oauthErrorMessage("not_invited"));
  });
  it("tells a person whose Google account cannot be linked to ask the admin to invite them again", () => {
    const message = oauthErrorMessage("account_not_linked");
    // 招待し直しの依頼・Google 側のメール確認の 2 つが案内に入っている(確認済みでも未確認でも同じ code で来る)
    expect(message).toContain("招待し直す");
    expect(message).toContain("確認済み");
    expect(message).not.toBe(oauthErrorMessage("email_not_verified"));
    // 利用者に見える文字列に、開発記録の参照を書かない
    expect(message).not.toMatch(/B\d+|Task|Plan|決定|docs\/superpowers/);
  });
  it("has a message for cancel and for anything unknown, and none when there is no error", () => {
    expect(oauthErrorMessage("access_denied")).toContain("キャンセル");
    expect(oauthErrorMessage("whatever")).toContain("もう一度");
    expect(oauthErrorMessage(null)).toBeNull();
    expect(oauthErrorMessage("")).toBeNull();
  });
});
