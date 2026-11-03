import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRefresh, deferUntilRefreshed, isRefreshPending } from "@/lib/refresh-wait";
import { isPlainLeftClick } from "@/lib/prefetch-intent";

// 管理画面の速さ CE-R9: 読み直し(router.refresh)の反映を待つ間、利用者の遷移・節の切り替えを反映の後に回す store。
// 反映の終わりを useTransition で知る部分(useRefreshAndWait)は E2E(audience-flow・settings-save-race)で見る
afterEach(() => {
  vi.useRealTimers();
});

describe("refresh-and-wait の store", () => {
  it("待っている読み直しが無ければ、すぐ走らせる", () => {
    const fn = vi.fn();
    expect(deferUntilRefreshed("nav", fn)).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRefreshPending()).toBe(false);
  });

  it("読み直しの反映を待つ間は後に回し、反映で走らせる。同じ鍵は最後の 1 つだけ、入れた順に走る", () => {
    const end = beginRefresh();
    const calls: string[] = [];
    expect(isRefreshPending()).toBe(true);
    expect(deferUntilRefreshed("nav", () => calls.push("nav:a"))).toBe(true);
    expect(deferUntilRefreshed("section", () => calls.push("section:tag"))).toBe(true);
    expect(deferUntilRefreshed("nav", () => calls.push("nav:b"))).toBe(true);
    expect(calls).toEqual([]);
    end();
    expect(isRefreshPending()).toBe(false);
    expect(calls).toEqual(["section:tag", "nav:b"]);
    end(); // 2 回目は何もしない
    expect(calls).toEqual(["section:tag", "nav:b"]);
  });

  it("読み直しが重なったら、すべての反映を待つ", () => {
    const end1 = beginRefresh();
    const end2 = beginRefresh();
    const fn = vi.fn();
    deferUntilRefreshed("nav", fn);
    end1();
    expect(fn).not.toHaveBeenCalled();
    end2();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("反映が来なければ打ち切って走らせる(操作が止まったままにならない)", () => {
    vi.useFakeTimers();
    beginRefresh({ timeoutMs: 10_000 });
    const fn = vi.fn();
    deferUntilRefreshed("nav", fn);
    vi.advanceTimersByTime(9_999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRefreshPending()).toBe(false);
  });

  it("a later refresh ending also ends earlier refreshes as superseded", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    const onB = vi.fn();
    beginRefresh({ onEnd: onA });
    const endB = beginRefresh({ onEnd: onB });
    endB();
    expect(onB).toHaveBeenCalledWith("ended");
    expect(onA).toHaveBeenCalledWith("superseded");
    expect(isRefreshPending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onA).toHaveBeenCalledOnce();
  });

  it("onEnd(timeout) fires when nothing ends the refresh in time", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    beginRefresh({ onEnd });
    vi.advanceTimersByTime(10_000);
    expect(onEnd).toHaveBeenCalledWith("timeout");
    expect(isRefreshPending()).toBe(false);
  });

  it("an earlier refresh ending does not end a later one", () => {
    vi.useFakeTimers();
    const endA = beginRefresh();
    const endB = beginRefresh();
    endA();
    expect(isRefreshPending()).toBe(true);
    endB(); // store はモジュールの変数なので、次のテストに残さない
    expect(isRefreshPending()).toBe(false);
  });

  it("an earlier refresh timing out does not end a later one", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    beginRefresh({ timeoutMs: 1_000, onEnd: onA });
    const endB = beginRefresh({ timeoutMs: 10_000 });
    vi.advanceTimersByTime(1_000);
    expect(onA).toHaveBeenCalledWith("timeout");
    expect(isRefreshPending()).toBe(true);
    endB();
  });

  it("cancel removes only its own wait and does not supersede earlier refreshes", () => {
    vi.useFakeTimers();
    const onA = vi.fn();
    const onB = vi.fn();
    const endA = beginRefresh({ onEnd: onA });
    const endB = beginRefresh({ onEnd: onB });
    endB.cancel();
    expect(isRefreshPending()).toBe(true);
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled(); // 外した読み直しの onEnd は呼ばない(呼び出し元が自分で片付ける)
    vi.advanceTimersByTime(10_000 - 1);
    expect(onB).not.toHaveBeenCalled();
    endB(); // cancel の後の end は何もしない
    expect(isRefreshPending()).toBe(true);
    endA();
    expect(onA).toHaveBeenCalledWith("ended");
    expect(isRefreshPending()).toBe(false);
  });

  it("cancel of the last wait runs the deferred operations", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const end = beginRefresh({ onEnd });
    const fn = vi.fn();
    deferUntilRefreshed("navigation", fn);
    end.cancel();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRefreshPending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onEnd).not.toHaveBeenCalled(); // 打ち切りの時計も止まっている
  });

  it("onEnd runs before the deferred operations", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const end = beginRefresh({ onEnd: () => order.push("onEnd") });
    deferUntilRefreshed("navigation", () => order.push("deferred"));
    end();
    expect(order).toEqual(["onEnd", "deferred"]);
  });

  it("all onEnd of the ended refreshes run before the deferred operations", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    beginRefresh({ onEnd: (r) => order.push(`A:${r}`) });
    const endB = beginRefresh({ onEnd: (r) => order.push(`B:${r}`) });
    deferUntilRefreshed("navigation", () => order.push("deferred"));
    endB();
    expect(order).toEqual(["A:superseded", "B:ended", "deferred"]);
  });

  it("onEnd が例外を投げても、回した操作は走る", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const end = beginRefresh({
      onEnd: () => {
        throw new Error("boom");
      },
    });
    deferUntilRefreshed("navigation", fn);
    expect(end).toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRefreshPending()).toBe(false);
  });
});

describe("isPlainLeftClick(遷移を後に回してよいクリック)", () => {
  const ev = (over: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: string | null; download: boolean }> = {}) => {
    const o = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, download: false, ...over };
    return { button: o.button, metaKey: o.metaKey, ctrlKey: o.ctrlKey, shiftKey: o.shiftKey, altKey: o.altKey, currentTarget: { getAttribute: (n: string) => (n === "target" ? o.target : null), hasAttribute: (n: string) => n === "download" && o.download } };
  };
  it("修飾キーなしの左クリックだけ", () => {
    expect(isPlainLeftClick(ev())).toBe(true);
    expect(isPlainLeftClick(ev({ button: 1 }))).toBe(false);
    expect(isPlainLeftClick(ev({ metaKey: true }))).toBe(false);
    expect(isPlainLeftClick(ev({ ctrlKey: true }))).toBe(false);
    expect(isPlainLeftClick(ev({ shiftKey: true }))).toBe(false);
    expect(isPlainLeftClick(ev({ altKey: true }))).toBe(false);
    expect(isPlainLeftClick(ev({ target: "_blank" }))).toBe(false);
    expect(isPlainLeftClick(ev({ target: "_self" }))).toBe(true);
    expect(isPlainLeftClick(ev({ download: true }))).toBe(false);
  });
});
