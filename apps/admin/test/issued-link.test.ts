import { describe, expect, it } from "vitest";
import { invitationResultCopy, resetLinkCopy } from "@/lib/issued-link";

describe("invitationResultCopy", () => {
  const base = { email: "ed@example.com", deadline: "10/15 14:30" };
  it("tells the operator to hand over a new link themselves, since no email is sent", () => {
    const c = invitationResultCopy({ ...base, extended: false });
    expect(c.title).toBe("招待リンクを発行しました");
    expect(c.lead).toBe("ed@example.com に次のリンクを送ってください(10/15 14:30 まで有効)");
    expect(c.notice).toContain("メールは自動送信されません");
    // 移動の確認は付けない(B47 (a))ので、後から控えられる場所を案内する
    expect(c.notice).toContain("招待中の一覧");
  });
  it("says the link is unchanged when an existing invitation was extended", () => {
    const c = invitationResultCopy({ ...base, extended: true });
    expect(c.title).toBe("招待の期限を延ばしました");
    expect(c.lead).toBe("ed@example.com は既に招待済みです。同じリンクの期限を 10/15 14:30 まで延ばしました");
    expect(c.notice).toContain("リンクは変わっていません");
  });
});

describe("resetLinkCopy", () => {
  it("warns that the link is one-time and cannot be shown again, and how to recover", () => {
    const c = resetLinkCopy("ed@example.com");
    expect(c.title).toBe("リセットリンクを発行しました");
    expect(c.lead).toBe("ed@example.com 用のパスワードリセットリンクです。本人に渡してください");
    expect(c.notice).toContain("1 回限り");
    expect(c.notice).toContain("二度と表示できません");
    expect(c.notice).toContain("発行し直して");
  });
});
