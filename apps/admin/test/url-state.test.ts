import { afterEach, describe, expect, it, vi } from "vitest";
import { URL_PARAM_EVENT, pickParam, replaceParam, withParam } from "@/lib/url-state";

const TABS = ["overview", "variants", "analytics"] as const;

describe("url-state", () => {
  it("sets, replaces and removes a param while keeping the others and the hash", () => {
    expect(withParam("/w/a/sites/s/experiments/e", "tab", "variants")).toBe("/w/a/sites/s/experiments/e?tab=variants");
    expect(withParam("/x?tab=overview&variant=b#top", "tab", "analytics")).toBe("/x?tab=analytics&variant=b#top");
    expect(withParam("/x?tab=overview&variant=b", "tab", null)).toBe("/x?variant=b");
    expect(withParam("/x?tab=overview", "tab", null)).toBe("/x");
  });

  // B31 ⑦: ページの searchParams の値をそのまま受ける(クエリ文字列を手で組み立てない)
  it("picks an allowed searchParams value: string, first of an array, or the fallback", () => {
    expect(pickParam("variants", TABS, "overview")).toBe("variants");
    expect(pickParam(["analytics", "variants"], TABS, "overview")).toBe("analytics");
    expect(pickParam(undefined, TABS, "overview")).toBe("overview");
    expect(pickParam("nope", TABS, "overview")).toBe("overview");
    expect(pickParam("variants&tab=analytics", TABS, "overview")).toBe("overview"); // 組み立てた文字列のように別のキーへ化けない
    expect(pickParam([], TABS, "overview")).toBe("overview");
  });

  // B60 Task 2: vinext は replaceState を usePathname / useSearchParams に知らせないことがあるので、書いた直後に自分で知らせる(SettingsOrigin が受ける)
  describe("replaceParam", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("rewrites the URL with replaceState and then dispatches URL_PARAM_EVENT on window", () => {
      const calls: string[] = [];
      const target = new EventTarget();
      const win = {
        location: { pathname: "/w/a/sites/s/experiments/e", search: "?tab=overview", hash: "" },
        history: {
          state: { app: true },
          replaceState: (state: unknown, _unused: string, url: string) => {
            calls.push(`replace:${url}:${JSON.stringify(state)}`);
            win.location.search = url.slice(url.indexOf("?"));
          },
        },
        dispatchEvent: (e: Event) => target.dispatchEvent(e),
      };
      target.addEventListener(URL_PARAM_EVENT, () => calls.push(`event:${win.location.search}`));
      vi.stubGlobal("window", win);
      replaceParam("tab", "plan");
      // 順序 = URL を書いてから知らせる(受け手は window.location を読み直すので、先に書かれていないと古い search を読む)。history.state はそのまま渡す
      expect(calls).toEqual(['replace:/w/a/sites/s/experiments/e?tab=plan:{"app":true}', "event:?tab=plan"]);
    });

    it("does nothing on the server", () => {
      expect(() => replaceParam("tab", "plan")).not.toThrow();
    });
  });
});
