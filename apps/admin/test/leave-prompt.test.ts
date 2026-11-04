import { beforeEach, describe, expect, it } from "vitest";
import { getSnapshot, leavePromptKind, resetFeedbackStoreForTest, setGuard } from "@/lib/feedback-store";

// 離れる前の確認の種類(B173 第 2 段 Task 3)。範囲の登録の組み合わせで、どの文言の確認を出すか(保存の途中 > キーを控えていない > 未保存)
beforeEach(() => {
  resetFeedbackStoreForTest();
});

const kind = () => leavePromptKind(getSnapshot());

describe("leavePromptKind", () => {
  it("saving wins over issuedKey, issuedKey wins over unsaved", () => {
    expect(kind()).toBeNull();
    setGuard("form", { dirty: true, busy: false });
    expect(kind()).toBe("unsaved");
    setGuard("key", { dirty: false, busy: false, prompt: "issuedKey" });
    expect(kind()).toBe("issuedKey");
    setGuard("save", { dirty: false, busy: true });
    expect(kind()).toBe("saving");
    // 同じ範囲の中でも、保存の途中が先
    setGuard("save", null);
    setGuard("key", { dirty: true, busy: true, prompt: "issuedKey" });
    expect(kind()).toBe("saving");
    setGuard("key", null);
    expect(kind()).toBe("unsaved");
    setGuard("form", null);
    expect(kind()).toBeNull();
  });

  it("a scope with only prompt issuedKey arms the guard", () => {
    setGuard("key", { dirty: false, busy: false, prompt: "issuedKey" });
    expect(getSnapshot()).toMatchObject({ dirty: false, busy: false, prompt: "issuedKey" });
    expect(kind()).toBe("issuedKey");
    // prompt を外して登録し直すと、守りも外れる
    setGuard("key", { dirty: false, busy: false });
    expect(getSnapshot().prompt).toBeNull();
    expect(kind()).toBeNull();
  });
});
