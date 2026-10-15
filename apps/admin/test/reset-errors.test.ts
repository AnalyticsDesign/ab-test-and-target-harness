import { describe, expect, it } from "vitest";
import { resetErrorMessage } from "@/lib/reset-errors";

describe("reset error messages", () => {
  it("tells a cut-off link apart from the other failures", () => {
    expect(resetErrorMessage(400, { code: "INVALID_TOKEN", message: "Invalid token" })).toContain("途中で切れていないか");
    expect(resetErrorMessage(400, { code: "INVALID_TOKEN" })).toContain("期限");
    // 「途中で切れていないか」を言うのは INVALID_TOKEN のときだけ(ほかの失敗で言うと原因の切り分けを誤らせる)
    for (const body of [{ code: "PASSWORD_TOO_SHORT" }, { code: "PASSWORD_TOO_LONG" }, { code: "SOMETHING_NEW" }, { error: "rate_limited", message: "しばらく待ってからやり直してください" }, null]) {
      expect(resetErrorMessage(400, body)).not.toContain("途中で切れていないか");
    }
  });
  it("explains the password length limits", () => {
    expect(resetErrorMessage(400, { code: "PASSWORD_TOO_SHORT" })).toContain("8 文字以上");
    expect(resetErrorMessage(400, { code: "PASSWORD_TOO_LONG" })).toContain("長すぎ");
  });
  it("uses the envelope of the admin proxy / control when there is one", () => {
    expect(resetErrorMessage(429, { error: "rate_limited", message: "しばらく待ってからやり直してください" })).toBe("しばらく待ってからやり直してください");
    expect(resetErrorMessage(404, { error: "not_found", message: "見つかりません", hint: "非常用のログインが閉じています" })).toBe("見つかりません 非常用のログインが閉じています");
  });
  it("falls back to a generic line with the status", () => {
    expect(resetErrorMessage(500, null)).toBe("パスワードを変更できませんでした(HTTP 500)。しばらく待ってからやり直してください");
    expect(resetErrorMessage(400, { code: "SOMETHING_NEW" })).toBe("パスワードを変更できませんでした(SOMETHING_NEW)。リンクを発行し直してください");
    expect(resetErrorMessage(400, "not json")).toBe("パスワードを変更できませんでした(HTTP 400)。しばらく待ってからやり直してください");
  });
});
