import { describe, expect, it } from "vitest";
import { demotionConfirmBody, fullRemovalConfirmBody, offersFullRemoval } from "@/lib/instance-admins";
import type { InstanceAdmin } from "@/lib/types";

const admin = (priorRoles: InstanceAdmin["priorRoles"]): InstanceAdmin => ({ userId: "u", email: "ed@example.com", name: "Ed", createdAt: 0, priorRoles });
const workspaces = [
  { id: "w1", name: "本番" },
  { id: "w2", name: "検証" },
];

describe("demotionConfirmBody (B46)", () => {
  it("lists the workspaces whose role comes back, in order, with the role label", () => {
    expect(
      demotionConfirmBody(
        admin([
          { workspaceId: "w1", workspaceName: "本番", role: "editor" },
          { workspaceId: "w2", workspaceName: "検証", role: "viewer" },
        ]),
        false,
        workspaces,
      ),
    ).toBe("次のワークスペースでは、システム管理者になる前のロールに戻ります: 本番(編集者)、検証(閲覧者)"); // 外れる側が 0 件なら外れる文を出さない
  });
  it("lists the workspaces that will be left", () => {
    // w1 は戻る側だけ、w2 は外れる側だけに出る
    expect(demotionConfirmBody(admin([{ workspaceId: "w1", workspaceName: "本番", role: "editor" }]), false, workspaces)).toBe(
      "次のワークスペースでは、システム管理者になる前のロールに戻ります: 本番(編集者)。次のワークスペースからは外れます: 検証",
    );
  });
  it("says everything goes when there is no record", () => {
    expect(demotionConfirmBody(admin([]), false, workspaces)).toBe(
      "次のすべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません): 本番、検証",
    );
  });
  it("omits the names of the workspaces to leave when the workspace list could not be fetched", () => {
    expect(demotionConfirmBody(admin([{ workspaceId: "w1", workspaceName: "本番", role: "editor" }]), false, null)).toBe(
      "次のワークスペースでは、システム管理者になる前のロールに戻ります: 本番(編集者)。それ以外のワークスペースからは外れます",
    );
    expect(demotionConfirmBody(admin([]), false, null)).toBe("すべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません)");
  });
  it("treats a missing priorRoles (older control) as no record", () => {
    expect(demotionConfirmBody({ userId: "u", email: "ed@example.com", name: "Ed", createdAt: 0 }, false, workspaces)).toBe(
      "次のすべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません): 本番、検証",
    );
  });
  it("warns about logging out only when demoting yourself without a record", () => {
    expect(demotionConfirmBody(admin([]), true, workspaces)).toBe(
      "次のすべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません): 本番、検証。ほかに有効な招待が無ければ、ログアウトされます",
    );
    expect(demotionConfirmBody(admin([{ workspaceId: "w1", workspaceName: "本番", role: "editor" }]), true, workspaces)).not.toContain("ログアウト");
  });
});

describe("offersFullRemoval (B46 K12)", () => {
  it("offers the full removal only when there is a record", () => {
    expect(offersFullRemoval(admin([{ workspaceId: "w1", workspaceName: "本番", role: "editor" }]))).toBe(true);
    expect(offersFullRemoval(admin([]))).toBe(false); // 記録の無い人はどちらでもすべて外れる
    expect(offersFullRemoval({ userId: "u", email: "ed@example.com", name: "Ed", createdAt: 0 })).toBe(false); // 古い control(priorRoles が欠ける)
  });
});

describe("fullRemovalConfirmBody (B46 K12 の改め)", () => {
  it("replaces the restore text with the workspaces to leave when the full removal is checked", () => {
    expect(fullRemovalConfirmBody(false, workspaces)).toBe("元のロールには戻さず、次のすべてのワークスペースから外れます: 本番、検証");
  });
  it("omits the names when the workspace list could not be fetched", () => {
    expect(fullRemovalConfirmBody(false, null)).toBe("元のロールには戻さず、すべてのワークスペースから外れます");
  });
  it("says you will be logged out when removing yourself completely", () => {
    expect(fullRemovalConfirmBody(true, workspaces)).toBe(
      "元のロールには戻さず、次のすべてのワークスペースから外れます: 本番、検証。外すとすぐにログアウトされ、ほかのシステム管理者に招待し直してもらうまで管理画面に入れなくなります",
    );
  });
});
