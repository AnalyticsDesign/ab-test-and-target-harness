import { describe, expect, it } from "vitest";
import { loginView } from "@/lib/login-view";

describe("loginView (the login screen with the emergency door closed is the production default)", () => {
  it("shows only Google when control says the password door is closed", () => {
    expect(loginView({ status: 200, data: { google: true, passwordLogin: false } })).toEqual({ google: true, passwordLogin: false });
  });
  it("shows the emergency form only on a valid response with an explicit true", () => {
    expect(loginView({ status: 200, data: { google: true, passwordLogin: true } })).toEqual({ google: true, passwordLogin: true });
    expect(loginView({ status: 200, data: { google: true, passwordLogin: "yes" } })).toBeNull();
  });
  it("reports Google as missing on an explicit false", () => {
    expect(loginView({ status: 200, data: { google: false, passwordLogin: false } })).toEqual({ google: false, passwordLogin: false });
  });
  it("reports the login methods as unavailable when control does not return the expected response", () => {
    for (const res of [{ status: 502, data: null }, { status: 404, data: { error: "not_found" } }, { status: 200, data: null }, { status: 200, data: "x" }]) {
      expect(loginView(res)).toBeNull();
    }
  });
});
