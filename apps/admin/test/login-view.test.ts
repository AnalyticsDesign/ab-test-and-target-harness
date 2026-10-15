import { describe, expect, it } from "vitest";
import { loginView } from "@/lib/login-view";

describe("loginView (the login screen with the emergency door closed is the production default)", () => {
  it("shows only Google when control says the password door is closed", () => {
    expect(loginView({ status: 200, data: { google: true, passwordLogin: false } })).toEqual({ google: true, passwordLogin: false });
  });
  it("shows the emergency form only on an explicit true", () => {
    expect(loginView({ status: 200, data: { google: true, passwordLogin: true } })).toEqual({ google: true, passwordLogin: true });
    expect(loginView({ status: 200, data: { google: true, passwordLogin: "yes" } }).passwordLogin).toBe(false);
  });
  it("reports Google as missing only on an explicit false", () => {
    expect(loginView({ status: 200, data: { google: false, passwordLogin: false } }).google).toBe(false);
  });
  it("falls back to Google-only when control is unreachable or answers something else", () => {
    for (const res of [{ status: 502, data: null }, { status: 404, data: { error: "not_found" } }, { status: 200, data: null }, { status: 200, data: "x" }]) {
      expect(loginView(res)).toEqual({ google: true, passwordLogin: false });
    }
  });
});
