import { describe, expect, it } from "vitest";
import { oauthErrorMessage } from "@/lib/oauth-errors";

describe("oauthErrorMessage", () => {
  it("uses the same retry message for every nonempty code", () => {
    for (const code of ["oauth_failed", "not_invited", "unable_to_create_user", "account_not_linked", "email_not_verified", "access_denied", "whatever"]) {
      expect(oauthErrorMessage(code)).toBe("ログインを完了できませんでした。もう一度お試しください");
    }
  });
  it("has no message when there is no code", () => {
    for (const code of [null, undefined, ""]) expect(oauthErrorMessage(code)).toBeNull();
  });
});
