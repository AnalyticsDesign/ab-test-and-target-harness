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
    beginRefresh(10_000);
    const fn = vi.fn();
    deferUntilRefreshed("nav", fn);
    vi.advanceTimersByTime(9_999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
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
