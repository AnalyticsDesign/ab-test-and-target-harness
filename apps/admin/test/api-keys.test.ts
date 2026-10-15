import { describe, expect, it } from "vitest";
import {
  candidateItems,
  capAfterScopeChange,
  capCeiling,
  capFromChoice,
  capLabel,
  capOptions,
  EXPIRY_OPTIONS,
  expiresInDaysOf,
  expiryAt,
  expiryLabel,
  formatDeadline,
  FULL_SCOPE,
  initialScope,
  issueMissing,
  ownScopeLabel,
  revokeBlockedReason,
  scopeLabel,
  scopeOptions,
  validChoice,
} from "@/lib/api-keys";
import type { WorkspaceApiKey } from "@/lib/types";

const key = (owner: Partial<WorkspaceApiKey["owner"]>): WorkspaceApiKey => ({
  id: "k1",
  name: "k",
  prefix: "wtt_",
  roleCap: null,
  createdAt: 0,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  scope: "workspace",
  workspace: { id: "w1", name: "Main" },
  owner: { userId: "u1", email: "a@example.com", name: "A", role: "editor", instanceAdmin: false, ...owner },
});

describe("candidateItems (B41)", () => {
  it("labels each member with name and email and lists their workspaces and roles", () => {
    const items = candidateItems([
      { userId: "u1", email: "a@example.com", name: "A", workspaces: [{ id: "w1", name: "Main", role: "editor" }, { id: "w2", name: "Sub", role: "viewer" }] },
    ]);
    expect(items).toEqual([{ value: "u1", label: "A · a@example.com", detail: "Main: 編集者 / Sub: 閲覧者" }]);
  });
});

describe("revokeBlockedReason (B41)", () => {
  it("blocks an instance admin's key for anyone who is not an instance admin", () => {
    expect(revokeBlockedReason(key({ role: "owner", instanceAdmin: true }), "owner", false)).toBe("システム管理者のキーは、システム管理者だけが失効できます");
    expect(revokeBlockedReason(key({ role: "owner", instanceAdmin: true }), "owner", true)).toBeNull();
  });
  it("blocks an owner's key for an admin", () => {
    expect(revokeBlockedReason(key({ role: "owner" }), "admin", false)).toBe("オーナーのキーはオーナーだけが失効できます");
    expect(revokeBlockedReason(key({ role: "owner" }), "owner", false)).toBeNull();
  });
  it("lets an admin revoke an editor's key", () => {
    expect(revokeBlockedReason(key({ role: "editor" }), "admin", false)).toBeNull();
  });
});

describe("scopeOptions / initialScope / capCeiling (B42)", () => {
  const ws = [
    { id: "w1", name: "Main", role: "admin" as const },
    { id: "w2", name: "Sub", role: "viewer" as const },
  ];
  it("offers all workspaces first only to an instance admin, then each workspace with the role as a hint", () => {
    expect(scopeOptions(ws, false)).toEqual([
      { value: "w1", label: "Main", hint: "あなたのロール: 管理者" },
      { value: "w2", label: "Sub", hint: "あなたのロール: 閲覧者" },
    ]);
    expect(scopeOptions(ws, true)[0]).toEqual({ value: FULL_SCOPE, label: "すべてのワークスペース", hint: "システム管理者だけが選べます" });
  });
  it("preselects the only option and otherwise makes the user choose", () => {
    expect(initialScope([{ value: "w1", label: "Main", hint: "あなたのロール: 管理者" }])).toBe("w1");
    expect(initialScope(scopeOptions(ws, false))).toBeNull();
    expect(initialScope([])).toBeNull();
  });
  it("caps by the role in the chosen workspace, or the highest role for the full scope", () => {
    expect(capCeiling("w2", ws)).toBe("viewer");
    expect(capCeiling(FULL_SCOPE, ws)).toBe("admin");
    expect(capCeiling(null, ws)).toBeNull();
    expect(capCeiling("gone", ws)).toBeNull();
  });
});

describe("scopeLabel (B42)", () => {
  it("names the full scope, the workspace, a deleted workspace and a key without a scope", () => {
    expect(scopeLabel({ scope: "full", workspace: null })).toBe("すべてのワークスペース");
    expect(scopeLabel({ scope: "workspace", workspace: { id: "w1", name: "Main" } })).toBe("Main");
    expect(scopeLabel({ scope: "workspace", workspace: { id: "w1", name: null } })).toBe("削除済みのワークスペース(使えません)");
    expect(scopeLabel({ scope: null, workspace: null })).toBe("範囲なし(使えません)");
  });
});

describe("ownScopeLabel (B42 review r1 CL-L9)", () => {
  const ws = [{ id: "w1", name: "Main", role: "editor" as const }];
  const k = (scope: "full" | "workspace" | null, workspace: { id: string; name: string | null } | null) => ({ scope, workspace });
  it("marks a key the owner can no longer use", () => {
    expect(ownScopeLabel(k("workspace", { id: "w1", name: "Main" }), ws, false)).toBe("Main");
    expect(ownScopeLabel(k("workspace", { id: "w2", name: "Sub" }), ws, false)).toBe("Sub(使えません: このワークスペースのメンバーではありません)");
    expect(ownScopeLabel(k("workspace", { id: "w3", name: null }), ws, false)).toBe("削除済みのワークスペース(使えません)");
    expect(ownScopeLabel(k("full", null), ws, true)).toBe("すべてのワークスペース");
    expect(ownScopeLabel(k("full", null), ws, false)).toBe("すべてのワークスペース(使えません: システム管理者ではありません)");
    expect(ownScopeLabel(k(null, null), ws, false)).toBe("範囲なし(使えません)");
  });
});

describe("validChoice (B42 review r1 CL-L8 / CL-L10)", () => {
  it("drops a choice that is no longer among the options", () => {
    expect(validChoice("a", ["a", "b"])).toBe("a");
    expect(validChoice("c", ["a", "b"])).toBeNull();
    expect(validChoice(null, ["a"])).toBeNull();
  });
});

describe("capOptions / capFromChoice / capLabel (B35 / 決定 54 (11))", () => {
  it("lists roles up to the ceiling in ascending order, then the same as the owner", () => {
    expect(capOptions("admin").map((o) => o.label)).toEqual(["閲覧者", "編集者", "管理者", "本人と同じ(管理者)"]);
    expect(capOptions("owner").map((o) => o.value)).toEqual(["viewer", "editor", "admin", "same"]);
    expect(capOptions("viewer").map((o) => o.label)).toEqual(["閲覧者", "本人と同じ(閲覧者)"]);
    expect(capOptions(null)).toEqual([]);
  });
  it("explains each choice", () => {
    expect(capOptions("owner").map((o) => o.hint)).toEqual([
      "読み取りだけ(閲覧・評価・分析レシピ)",
      "下書きの作成・編集まで(公開は人が行う)",
      "公開・開始・終了まで(訪問者に届く操作)",
      "あなたのロールが変わると、キーの権限も変わります",
    ]);
  });
  it("maps the choice to roleCap", () => {
    expect(capFromChoice("same")).toBeNull();
    expect(capFromChoice("editor")).toBe("editor");
  });
  it("labels a cap", () => {
    expect(capLabel("viewer")).toBe("閲覧者");
    expect(capLabel(null)).toBe("本人と同じ");
    expect(capLabel(null, "editor")).toBe("本人と同じ(編集者)");
  });
});

describe("capAfterScopeChange (Review Focus 2 / r1 CX-Medium-2)", () => {
  const ws = [
    { id: "w1", name: "Main", role: "owner" as const },
    { id: "w2", name: "Sub", role: "viewer" as const },
  ];
  it("clears a cap that the new scope does not allow, and it stays cleared when the scope goes back", () => {
    let cap: string | null = "admin";
    cap = capAfterScopeChange(cap, FULL_SCOPE, ws); // すべてのワークスペース = 最高位はオーナー → 管理者は選べる
    expect(cap).toBe("admin");
    cap = capAfterScopeChange(cap, "w2", ws); // 閲覧者のワークスペース → 管理者は選べない
    expect(cap).toBeNull();
    cap = capAfterScopeChange(cap, FULL_SCOPE, ws); // 戻しても、前の選択はよみがえらない
    expect(cap).toBeNull();
    expect(issueMissing("k", FULL_SCOPE, cap, "1")).toBe("権限を選んでください");
  });
  it("keeps a cap that the new scope still allows", () => {
    expect(capAfterScopeChange("viewer", "w2", ws)).toBe("viewer");
    expect(capAfterScopeChange("same", "w2", ws)).toBe("same");
  });
});

describe("expiry (B43 / K23)", () => {
  const now = Date.UTC(2026, 9, 5, 13, 5); // 2026-10-05 22:05 Asia/Tokyo
  it("offers no expiry and 1 / 7 / 30 / 90 days in this order", () => {
    expect(EXPIRY_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["none", "期限なし"],
      ["1", "1 日"],
      ["7", "7 日"],
      ["30", "30 日"],
      ["90", "90 日"],
    ]);
  });
  it("sends expiresInDays only for a limited key", () => {
    expect(expiresInDaysOf("none")).toBeUndefined();
    expect(expiresInDaysOf("7")).toBe(7);
  });
  it("counts the deadline from now (the server counts from the issue time)", () => {
    expect(expiryAt("none", now)).toBeNull();
    expect(expiryAt("7", now)).toBe(now + 7 * 86_400_000);
    expect(formatDeadline(expiryAt("7", now)!, "Asia/Tokyo")).toBe("10/12 22:05");
  });
  it("labels the expiry column", () => {
    expect(expiryLabel(null, now, "Asia/Tokyo")).toBe("期限なし");
    expect(expiryLabel(now + 86_400_000, now, "Asia/Tokyo")).toBe("10/6 22:05");
    expect(expiryLabel(now - 60_000, now, "Asia/Tokyo")).toBe("期限切れ(10/5 22:04)");
  });
});

describe("issueMissing (B35 / B43)", () => {
  it("names the first missing field", () => {
    expect(issueMissing("  ", null, null, null)).toBe("名前を入れてください");
    expect(issueMissing("k", null, null, null)).toBe("範囲を選んでください");
    expect(issueMissing("k", "w1", null, null)).toBe("権限を選んでください");
    expect(issueMissing("k", "w1", "same", null)).toBe("有効期限を選んでください");
    expect(issueMissing("k", "w1", "same", "none")).toBeNull();
  });
});
