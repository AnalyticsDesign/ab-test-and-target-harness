import { describe, expect, it } from "vitest";
import { inviteView, invitationStatusLabel } from "@/lib/invite-view";

describe("inviteView", () => {
  const invitedEmail = "Ed@Example.com";
  it("asks a signed-out visitor to sign in with Google; the password form is for emergencies only", () => {
    expect(inviteView({ invitedEmail, signedInEmail: null, passwordLogin: false })).toBe("sign-in");
    expect(inviteView({ invitedEmail, signedInEmail: null, passwordLogin: true })).toBe("sign-in-or-password");
  });
  it("lets the invited account accept (case-insensitive) and stops any other account", () => {
    expect(inviteView({ invitedEmail, signedInEmail: "ed@example.com", passwordLogin: false })).toBe("accept");
    expect(inviteView({ invitedEmail, signedInEmail: "someone@example.com", passwordLogin: true })).toBe("mismatch");
  });
});

describe("invitationStatusLabel", () => {
  it("shows Japanese for the known statuses and passes an unknown one through", () => {
    expect(invitationStatusLabel("accepted")).toBe("承諾済み");
    expect(invitationStatusLabel("canceled")).toBe("取り消し済み");
    expect(invitationStatusLabel("something_new")).toBe("something_new");
  });
});
