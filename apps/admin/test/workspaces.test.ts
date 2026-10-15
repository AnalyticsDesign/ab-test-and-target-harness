import { describe, expect, it } from "vitest";
import { deleteBlocked, runningIn } from "@/lib/workspaces";

const ws = (...running: number[]) => ({ sites: running.map((runningCount) => ({ runningCount })) });

describe("deleteBlocked (B35)", () => {
  it("sums running experiments over the sites", () => {
    expect(runningIn(ws(2, 0, 1))).toBe(3);
    expect(runningIn(ws())).toBe(0);
  });
  it("blocks while experiments are running, checked before the last workspace (same order as the server)", () => {
    expect(deleteBlocked(ws(1), 1)).toBe("配信中のエクスペリエンスが 1 件あります。終了してから削除してください");
    expect(deleteBlocked(ws(0, 2), 3)).toBe("配信中のエクスペリエンスが 2 件あります。終了してから削除してください");
  });
  it("blocks the last workspace", () => {
    expect(deleteBlocked(ws(), 1)).toBe("最後のワークスペースは削除できません。先に別のワークスペースを作ってください");
  });
  it("allows deleting otherwise", () => {
    expect(deleteBlocked(ws(0), 2)).toBeNull();
  });
});
