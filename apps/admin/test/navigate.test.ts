import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSnapshot, reportMark, resetFeedbackStoreForTest, selectScopeSkeleton, startNavigation } from "@/lib/feedback-store";
import { isAppNavigation, navigateApp, shouldStartNavigation, targetScope } from "@/lib/navigate";
import { beginRefresh } from "@/lib/refresh-wait";

// 移動の入口(B173 第 1 段): アプリの中の遷移・全画面の移動を 1 か所に集め、store に遷移の始まりを知らせる。node 環境(window が無い)で見る
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // 読み直しの待ち(refresh-wait はモジュールの状態を持つ)が残っても、次のテストに持ち越さない
  vi.advanceTimersByTime(11_000);
  resetFeedbackStoreForTest();
  vi.useRealTimers();
});

const makeRouter = () => ({ push: vi.fn(), replace: vi.fn() });

describe("遷移を始めるかの判定", () => {
  it("hash-only, same URL, last mark URL, other origin and unparsable hrefs do not start a nav", () => {
    expect(shouldStartNavigation("#x", "/w/a")).toBe(false);
    expect(shouldStartNavigation("/w/a?b=1&a=2", "/w/a?a=2&b=1")).toBe(false);
    reportMark({ url: "/s/settings", kind: "page" });
    expect(shouldStartNavigation("/s/settings", "/s/settings?section=tag")).toBe(false);
    expect(shouldStartNavigation("https://example.com/", "/w")).toBe(false);
    expect(shouldStartNavigation("http://[bad", "/w")).toBe(false);
    expect(shouldStartNavigation("/w/a?x=1", "/w/a")).toBe(true);
  });

  it("isAppNavigation rejects hash-only, other-origin and unparsable hrefs and navigateApp then does nothing", () => {
    expect(isAppNavigation("#x")).toBe(false);
    expect(isAppNavigation("https://example.com/")).toBe(false);
    expect(isAppNavigation("http://[bad")).toBe(false);
    expect(isAppNavigation("/w/a")).toBe(true);
    const router = makeRouter();
    navigateApp(router, "#x");
    expect(router.push).not.toHaveBeenCalled();
    expect(getSnapshot().nav).toBeNull();
  });
});

describe("navigateApp", () => {
  it("navigateApp starts a nav in the store and pushes", () => {
    const router = makeRouter();
    navigateApp(router, "/w/b", { key: "k" });
    expect(getSnapshot().nav).toMatchObject({ href: "/w/b", key: "k", dispatched: true });
    expect(router.push).toHaveBeenCalledWith("/w/b", { scroll: true });
  });

  it("replace と scroll=false を router に渡す。key の既定は null", () => {
    const router = makeRouter();
    navigateApp(router, "/w/b?z=1&a=2", { replace: true, scroll: false });
    expect(router.replace).toHaveBeenCalledWith("/w/b?z=1&a=2", { scroll: false });
    expect(router.push).not.toHaveBeenCalled();
    // store の行き先は normalizeUrl の形(鍵で並べ替え)。印の URL と比べられるように
    expect(getSnapshot().nav).toMatchObject({ href: "/w/b?a=2&z=1", key: null });
  });

  it("a link to the last mark URL still waits for refresh", () => {
    reportMark({ url: "/s/settings", kind: "page" });
    const end = beginRefresh();
    const router = makeRouter();
    navigateApp(router, "/s/settings");
    expect(router.push).not.toHaveBeenCalled();
    expect(getSnapshot().nav).toBeNull();
    end();
    expect(router.push).toHaveBeenCalledOnce();
    expect(getSnapshot().nav).toBeNull();
    vi.advanceTimersByTime(11_000);
    expect(getSnapshot().nav).toBeNull();
  });

  it("navigateApp defers the push while a refresh is pending and starts the timeout at dispatch", () => {
    const end = beginRefresh();
    const router = makeRouter();
    navigateApp(router, "/w/b");
    expect(router.push).not.toHaveBeenCalled();
    expect(getSnapshot().nav).toMatchObject({ dispatched: false });
    end();
    expect(router.push).toHaveBeenCalledOnce();
    expect(getSnapshot().nav).toMatchObject({ dispatched: true });
  });

  it("読み直しを待つ間に押した遷移は、後のものが前のものに替わる(push は最後の 1 回だけ)", () => {
    const end = beginRefresh();
    const router = makeRouter();
    navigateApp(router, "/w/b");
    navigateApp(router, "/w/c");
    expect(getSnapshot().nav).toMatchObject({ href: "/w/c", dispatched: false });
    end();
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith("/w/c", { scroll: true });
    expect(getSnapshot().nav).toMatchObject({ href: "/w/c", dispatched: true });
  });
});

describe("表示を始めない遷移が、前の遷移を引き継ぐ", () => {
  it("a non-display navigation dispatched after a deferred one ends the pending nav", () => {
    // 現在の画面の URL は印で覚えている(node では今の URL が "/" なので、最後の印と同じ URL へのリンクで見る)
    reportMark({ url: "/s/settings", kind: "page" });
    const end = beginRefresh();
    const router = makeRouter();
    navigateApp(router, "/w/a"); // 別の画面。表示を始め、後に回る
    expect(getSnapshot().nav).toMatchObject({ href: "/w/a", dispatched: false });
    navigateApp(router, "/s/settings"); // 最後の印と同じ URL。表示は始めず、A の後回しを置き換える
    end();
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith("/s/settings", { scroll: true });
    // A の遷移は終わっている(印が来ない行き先なので、残すと 10 秒の打ち切りも働かない)
    expect(getSnapshot().nav).toBeNull();
    vi.advanceTimersByTime(11_000);
    expect(getSnapshot().nav).toBeNull();
  });

  it("AppLink が、読み直しの外で表示を始めない遷移のときに cancelNavigation を呼ぶ", () => {
    const src = sources().find((s) => s.file === "components/ui/AppLink.tsx")?.code ?? "";
    expect(src).toMatch(/else cancelNavigation\(\)/);
  });
});

describe("targetScope / selectScopeSkeleton", () => {
  it("targetScope reads wid and sid", () => {
    expect(targetScope("/w/a/sites/s/goals")).toEqual({ wid: "a", sid: "s" });
    expect(targetScope("/w/a/members")).toEqual({ wid: "a", sid: null });
    expect(targetScope("/w/me/usage")).toEqual({ wid: null, sid: null });
    expect(targetScope("/w")).toEqual({ wid: null, sid: null });
  });

  it("targetScope は検索・hash を無視する", () => {
    expect(targetScope("/w/a/sites/s?x=1#y")).toEqual({ wid: "a", sid: "s" });
    expect(targetScope("/w/a/sites")).toEqual({ wid: "a", sid: null });
  });

  it("selectScopeSkeleton: 見せる状態の遷移で、行き先の範囲が今の範囲と違うときだけ true", () => {
    const select = selectScopeSkeleton({ wid: "a", sid: "s" });
    expect(select(getSnapshot())).toBe(false);
    startNavigation({ href: "/w/a/sites/s/goals", fromUrl: "/w/a", key: null });
    vi.advanceTimersByTime(150);
    expect(select(getSnapshot())).toBe(false); // 同じ範囲
    startNavigation({ href: "/w/a/sites/t", fromUrl: "/w/a", key: null });
    expect(select(getSnapshot())).toBe(false); // 始めたばかりで、まだ見せない
    vi.advanceTimersByTime(150);
    expect(select(getSnapshot())).toBe(true); // 別のサイト
    expect(selectScopeSkeleton({ wid: "a", sid: null })(getSnapshot())).toBe(true);
    expect(selectScopeSkeleton({ wid: "a", sid: "t" })(getSnapshot())).toBe(false);
  });
});

// ---- 静的な検査: 移動の入口をすり抜ける呼び出しが無いこと ----
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];
const ENTRY = "lib/navigate.ts";
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(?:ts|tsx)$/.test(e.name) ? [p] : [];
  });
/** コメントの中の説明を除いたコード(相対パスと対で返す) */
const sources = (): { file: string; code: string }[] =>
  DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((f) => ({
    file: path.relative(ROOT, f).split(path.sep).join("/"),
    code: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  }));

describe("入口をすり抜けない", () => {
  it("window.location navigation is only used inside lib/navigate.ts", () => {
    const offenders = sources()
      .filter(({ code }) => /location\.(?:assign|reload|replace)\(|location\.href\s*=/.test(code))
      .map((s) => s.file);
    expect(offenders).toEqual([ENTRY]);
  });

  it("router.push / router.replace are only called through navigateApp", () => {
    // (auth) の画面(ログイン・招待・再設定)は範囲の外
    const offenders = sources()
      .filter(({ file, code }) => !file.startsWith("app/(auth)/") && /router\.(?:push|replace)\(/.test(code))
      .map((s) => s.file);
    expect(offenders).toEqual([ENTRY]);
  });

  it("AppLink は router.push を直接呼ばず、読み直しの待ちは navigateApp を通す", () => {
    const src = sources().find((s) => s.file === "components/ui/AppLink.tsx")?.code ?? "";
    expect(src).toMatch(/navigateApp\(router, href/);
    expect(src).toMatch(/isAppNavigation\(href\)/);
    expect(src).not.toMatch(/deferUntilRefreshed/);
  });
});
