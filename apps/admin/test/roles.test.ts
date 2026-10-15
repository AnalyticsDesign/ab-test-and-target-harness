import { describe, expect, it } from "vitest";
import { canManage, highestRole, roleLabel } from "@/lib/roles";

describe("roles (B35)", () => {
  it("names each role in Japanese and keeps unknown strings", () => {
    expect(["owner", "admin", "editor", "viewer"].map(roleLabel)).toEqual(["オーナー", "管理者", "編集者", "閲覧者"]);
    expect(roleLabel("member")).toBe("member");
    // prototype のプロパティを拾わない(r1 CX-Low-2)
    for (const k of ["constructor", "toString", "__proto__"]) expect(roleLabel(k)).toBe(k);
  });
  it("lets owners and admins manage members", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("admin")).toBe(true);
    expect(canManage("editor")).toBe(false);
    expect(canManage("viewer")).toBe(false);
  });
  it("still picks the highest role", () => {
    expect(highestRole([{ id: "a", name: "A", role: "viewer" }, { id: "b", name: "B", role: "admin" }])).toBe("admin");
  });
});
