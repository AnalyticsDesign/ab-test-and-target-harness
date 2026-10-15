import { describe, expect, it } from "vitest";
import { guardedHref, isLogoutSubmit } from "@/lib/leave-guard";

const click = (over: Partial<Parameters<typeof guardedHref>[0]> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over });
const a = (href: string, over: { target?: string; hasDownload?: boolean } = {}) => ({ href, target: "", hasDownload: false, ...over });
const ORIGIN = "https://admin.example.com";

describe("guardedHref (B35 / 決定 54 (11))", () => {
  it("guards a plain click on a same-origin link and returns the path", () => {
    expect(guardedHref(click(), a(`${ORIGIN}/w/me/display?x=1#y`), ORIGIN)).toBe("/w/me/display?x=1#y");
  });
  it("does not guard clicks that open a new tab or window (the key stays on screen)", () => {
    for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) expect(guardedHref(click({ [k]: true }), a(`${ORIGIN}/w`), ORIGIN)).toBeNull();
    expect(guardedHref(click({ button: 1 }), a(`${ORIGIN}/w`), ORIGIN)).toBeNull();
    expect(guardedHref(click(), a(`${ORIGIN}/w`, { target: "_blank" }), ORIGIN)).toBeNull();
  });
  it("does not guard other origins, downloads, non-links or handled clicks", () => {
    expect(guardedHref(click(), a("https://example.org/"), ORIGIN)).toBeNull();
    expect(guardedHref(click(), a(`${ORIGIN}/file`, { hasDownload: true }), ORIGIN)).toBeNull();
    expect(guardedHref(click(), null, ORIGIN)).toBeNull();
    expect(guardedHref(click({ defaultPrevented: true }), a(`${ORIGIN}/w`), ORIGIN)).toBeNull();
  });
});

describe("isLogoutSubmit (Review Focus 1 / r1 CX-Medium-3)", () => {
  it("guards only the logout form", () => {
    expect(isLogoutSubmit("/api/session/logout")).toBe(true);
    expect(isLogoutSubmit("/api/session/login")).toBe(false);
    expect(isLogoutSubmit(null)).toBe(false);
  });
});
