import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAV_TIMEOUT_MS,
  getSnapshot,
  listenerCountForTest,
  reportMark,
  resetFeedbackStoreForTest,
  selectScopeSkeleton,
  startNavigation,
} from "@/lib/feedback-store";
import { isAppNavigation, navigateApp, navigateDocument, reloadDocument, shouldStartNavigation, targetScope } from "@/lib/navigate";
import { beginRefresh } from "@/lib/refresh-wait";
import { createNavWaiter } from "@/lib/run-busy";

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

// ---- 移動の後を待つ(第 2 段): 実際の入口と、BusyScope が組み立てる waitNav(createNavWaiter)。window.location と時計だけ偽物 ----
describe("NavHandle と waitNav", () => {
  const ORIGIN = "http://localhost";
  let location: { href: string; pathname: string; search: string; origin: string; assign: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    // ページは閉じない(偽の assign・reload は何もしない)
    location = { href: `${ORIGIN}/w/a`, pathname: "/w/a", search: "", origin: ORIGIN, assign: vi.fn(), reload: vi.fn() };
    (globalThis as { window?: unknown }).window = { location };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** 範囲の waitNav と、範囲が自分で出した打ち切りの文の数 */
  const scope = () => {
    const notices = { count: 0 };
    const waiter = createNavWaiter(() => void (notices.count += 1));
    return { waiter, notices };
  };
  /** Promise が解決したら値を入れる(解決しないことも確かめるため) */
  const track = <T,>(p: Promise<T>) => {
    const box: { value?: T } = {};
    void p.then((v) => (box.value = v));
    return box;
  };

  it("navigate entries return a NavHandle", () => {
    const router = makeRouter();
    const h = navigateApp(router, "/w/b");
    expect(h).toEqual({ kind: "app", seq: getSnapshot().nav?.seq });
    expect(navigateApp(router, "/w/a")).toEqual({ kind: "none" }); // 同じ URL
    reportMark({ url: "/w/c", kind: "page" });
    expect(navigateApp(router, "/w/c")).toEqual({ kind: "none" }); // 最後の印と同じ URL
    expect(navigateApp(router, "https://example.com/")).toEqual({ kind: "none" }); // アプリの外
    const d = navigateDocument("/w/d");
    expect(d).toEqual({ kind: "document", seq: getSnapshot().nav?.seq });
    expect(location.assign).toHaveBeenCalledWith("/w/d");
    expect(navigateDocument("https://example.com/x")).toEqual({ kind: "document", seq: null });
    expect(reloadDocument()).toEqual({ kind: "document", seq: null });
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("waitNav: an unfinished reloadDocument times out on the scope's own clock", async () => {
    const { waiter, notices } = scope();
    const out = track(waiter.waitNav(reloadDocument()));
    expect(getSnapshot().nav).toBeNull(); // store の遷移は始まらない
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 1);
    expect(out.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(out.value).toBe("timedOut");
    expect(notices.count).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCountForTest()).toBe(0);
  });

  it("waitNav: a document navigation replaced by another navigation", async () => {
    const router = makeRouter();
    const starts: (() => ReturnType<typeof reloadDocument>)[] = [() => navigateDocument("/w/d"), () => navigateDocument("https://example.com/x"), () => reloadDocument()];
    for (const [i, start] of starts.entries()) {
      const { waiter, notices } = scope();
      const out = track(waiter.waitNav(start()));
      navigateApp(router, `/w/other${i}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(out.value).toBe("replaced");
      // 打ち切りの文言は出さない(範囲も NavGate も)
      await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 1);
      expect(notices.count).toBe(0);
      expect(listenerCountForTest()).toBe(0);
      reportMark({ url: `/w/other${i}`, kind: "page" });
      vi.clearAllTimers();
    }
  });

  it("waitNav: one timeout notice per document path", async () => {
    // アプリの中の navigateDocument: NavGate の文(store の timedOut)だけ。範囲は出さない
    {
      const { waiter, notices } = scope();
      const out = track(waiter.waitNav(navigateDocument("/w/d")));
      await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS);
      expect(out.value).toBe("timedOut");
      expect(getSnapshot().nav?.timedOut).toBe(true);
      expect(notices.count).toBe(0);
      expect(listenerCountForTest()).toBe(0);
      resetFeedbackStoreForTest();
    }
    // 外の URL・reloadDocument: 範囲の ErrorBox だけ。NavGate は出さない(store の遷移が無い)
    for (const start of [() => navigateDocument("https://example.com/x"), () => reloadDocument()]) {
      const { waiter, notices } = scope();
      const out = track(waiter.waitNav(start()));
      await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS);
      expect(out.value).toBe("timedOut");
      expect(getSnapshot().nav).toBeNull();
      expect(notices.count).toBe(1);
    }
  });

  it("waitNav: unsubscribes after an app navigation ends and on unmount", async () => {
    const router = makeRouter();
    // 印で終わる(部品が消える)→ 解決しないが、購読は外れる
    {
      const { waiter } = scope();
      const out = track(waiter.waitNav(navigateApp(router, "/w/b")));
      expect(listenerCountForTest()).toBe(1);
      reportMark({ url: "/w/b", kind: "page" });
      await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS * 2);
      expect(out.value).toBeUndefined();
      expect(listenerCountForTest()).toBe(0);
    }
    // 待っている途中で範囲が消える(unmount)→ 購読もタイマーも残らない
    {
      const { waiter, notices } = scope();
      const a = track(waiter.waitNav(navigateApp(router, "/w/c")));
      const b = track(waiter.waitNav(reloadDocument()));
      expect(listenerCountForTest()).toBe(2);
      waiter.dispose();
      expect(listenerCountForTest()).toBe(0);
      reportMark({ url: "/w/c", kind: "page" }); // store の時計も止める
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS * 2);
      expect(a.value).toBeUndefined();
      expect(b.value).toBeUndefined();
      expect(notices.count).toBe(0);
    }
    // none はすぐ none
    const { waiter } = scope();
    await expect(waiter.waitNav({ kind: "none" })).resolves.toBe("none");
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
