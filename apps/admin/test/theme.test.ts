import { describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, THEME_KEY, applyTheme, normalizeTheme, resyncStoredTheme, type ThemeDocument } from "@/lib/theme";

describe("theme", () => {
  it("keeps the three known values and falls back to system for anything else", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBe("system");
    expect(normalizeTheme(null)).toBe("system");
    expect(normalizeTheme("DARK")).toBe("system");
    expect(normalizeTheme(1)).toBe("system");
  });

  it("the init script only sets data-theme for light / dark and never throws", () => {
    const run = (stored: string | null, broken = false) => {
      const attrs: Record<string, string> = {};
      const document = { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v) } };
      const localStorage = { getItem: (k: string) => { if (broken) throw new Error("blocked"); return k === THEME_KEY ? stored : null; } };
      new Function("document", "localStorage", THEME_INIT_SCRIPT)(document, localStorage);
      return attrs;
    };
    expect(run("dark")).toEqual({ "data-theme": "dark" });
    expect(run("light")).toEqual({ "data-theme": "light" });
    expect(run("system")).toEqual({});
    expect(run(null)).toEqual({});
    expect(run("<script>")).toEqual({});
    expect(run("dark", true)).toEqual({}); // localStorage が読めなければシステムに従う
  });

  /** data-theme の付け外しを記録する最小の document。startViewTransition の有無を切り替えられる */
  function fakeDocument(withTransition: boolean) {
    const attrs: Record<string, string> = {};
    let transitions = 0;
    const doc: ThemeDocument = {
      documentElement: {
        setAttribute: (k, v) => void (attrs[k] = v),
        removeAttribute: (k) => void delete attrs[k],
      },
      ...(withTransition
        ? {
            startViewTransition: (cb: () => void) => {
              transitions += 1;
              cb();
            },
          }
        : {}),
    };
    return { doc, attrs, count: () => transitions };
  }

  it("applyTheme sets data-theme for light / dark and removes it for system", () => {
    const { doc, attrs } = fakeDocument(false);
    applyTheme("dark", doc);
    expect(attrs).toEqual({ "data-theme": "dark" });
    applyTheme("light", doc);
    expect(attrs).toEqual({ "data-theme": "light" });
    applyTheme("system", doc);
    expect(attrs).toEqual({});
  });

  it("applyTheme runs the change inside startViewTransition when the browser has it, and directly otherwise", () => {
    const withIt = fakeDocument(true);
    applyTheme("dark", withIt.doc);
    expect(withIt.count()).toBe(1);
    expect(withIt.attrs).toEqual({ "data-theme": "dark" }); // クロスフェードの中で属性が変わる(コールバックが呼ばれる)
    const without = fakeDocument(false);
    applyTheme("dark", without.doc);
    expect(without.attrs).toEqual({ "data-theme": "dark" }); // 非対応ブラウザでは即時に切り替わる
  });

  it("resyncStoredTheme puts back the saved light / dark without a transition (B44: a hydration re-render can drop data-theme)", () => {
    const run = (stored: string | null, current: string | null, broken: false | "getItem" | "access" = false) => {
      const { doc, attrs, count } = fakeDocument(true);
      if (current !== null) attrs["data-theme"] = current;
      const storage = {
        getItem: (k: string) => {
          if (broken === "getItem") throw new Error("blocked");
          return k === THEME_KEY ? stored : null;
        },
      };
      resyncStoredTheme(() => {
        if (broken === "access") throw new Error("SecurityError"); // サイトデータを拒否したブラウザは localStorage の参照で投げる
        return storage;
      }, doc);
      return { attrs, transitions: count() };
    };
    expect(run("light", null)).toEqual({ attrs: { "data-theme": "light" }, transitions: 0 }); // 外れていたら付け直す(クロスフェードしない)
    expect(run("dark", "dark")).toEqual({ attrs: { "data-theme": "dark" }, transitions: 0 });
    expect(run("system", null)).toEqual({ attrs: {}, transitions: 0 }); // システムに従う = 付けない
    expect(run(null, null)).toEqual({ attrs: {}, transitions: 0 });
    expect(run("light", null, "getItem")).toEqual({ attrs: {}, transitions: 0 }); // 読めなければ何もしない(投げない)
    expect(run("light", null, "access")).toEqual({ attrs: {}, transitions: 0 }); // localStorage の参照そのものが投げても同じ
  });
});
