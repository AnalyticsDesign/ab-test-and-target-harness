import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_MIN_MS,
  NAV_DELAY_MS,
  NAV_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  cancelNavigation,
  clearWriteSucceeded,
  getSnapshot,
  lastMarkUrl,
  markNavigationDispatched,
  navOutcome,
  navStartedAfter,
  nextSeq,
  normalizeUrl,
  noteWriteSucceeded,
  reportMark,
  resetFeedbackStoreForTest,
  selectLinkPending,
  selectScopeSkeleton,
  setGuard,
  startNavigation,
  subscribe,
  writeSucceededRecently,
} from "@/lib/feedback-store";
import { markUrl } from "@/components/ui/PageMark";

// 管理画面の操作のフィードバック(B173 第 1 段)の store: 遷移の状態・保存の状態・「見えた」の判定。React に依らないので node で見る
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  resetFeedbackStoreForTest();
  vi.useRealTimers();
});

describe("定数", () => {
  it("spec の値", () => {
    expect([NAV_DELAY_MS, NAV_TIMEOUT_MS, BUSY_MIN_MS, WRITE_TIMEOUT_MS]).toEqual([150, 10_000, 300, 30_000]);
  });
});

describe("遷移", () => {
  it("nav becomes visible only after 150 ms", () => {
    const s = startNavigation({ href: "/w/a", fromUrl: "/w", key: "k" });
    vi.advanceTimersByTime(149);
    expect(getSnapshot().nav?.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getSnapshot().nav).toMatchObject({ seq: s, visible: true });
  });

  it("a nav that ends before 150 ms never becomes visible", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    reportMark({ url: "/w/a", kind: "page" });
    vi.advanceTimersByTime(500);
    expect(getSnapshot().nav).toBeNull();
  });

  it("a mark equal to fromUrl does not end the nav", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    reportMark({ url: "/w", kind: "page" });
    expect(getSnapshot().nav).not.toBeNull();
  });

  it("a mark different from fromUrl, href and replaced targets ends the nav (redirect)", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    reportMark({ url: "/login", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
  });

  it("a query-only nav (same pathname) ends with the mark that carries the query, not with the mark of the old URL (Task 4)", () => {
    // 管理画面に、同じ pathname で検索の文字列だけが違う本物の AppLink が無い(節のリンク・状態の絞り込みは replaceState だけ)ので、E2E の代わりにここで見る。
    // 印の URL は PageMark の markUrl(サーバーのページが受け取った searchParams)から作る。鍵の順はリンクの href と違ってよい
    const base = "/w/w1/sites/s1/settings";
    startNavigation({ href: normalizeUrl(`${base}?section=tag&sharing=off`), fromUrl: normalizeUrl(base), key: "k" });
    vi.advanceTimersByTime(NAV_DELAY_MS);
    // 元の画面(検索なし)の印は終えない
    reportMark({ url: markUrl(base, {}), kind: "page" });
    expect(getSnapshot().nav?.visible).toBe(true);
    reportMark({ url: markUrl(base, { sharing: "off", section: "tag" }), kind: "page" });
    expect(getSnapshot().nav).toBeNull();
  });

  it("an error or notFound mark ends the nav", () => {
    for (const kind of ["error", "notFound"] as const) {
      startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
      // fromUrl と同じ URL でも、error・notFound の印は遷移の結果なので終える
      reportMark({ url: "/w", kind });
      expect(getSnapshot().nav).toBeNull();
    }
  });

  it("a late mark of a replaced nav does not end the current nav", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: "1" });
    const s2 = startNavigation({ href: "/w/b", fromUrl: "/w", key: "2" });
    reportMark({ url: "/w/a", kind: "page" });
    expect(getSnapshot().nav?.seq).toBe(s2);
    // 替えた先の印は今までどおり終える
    reportMark({ url: "/w/b", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
  });

  it("late marks of any replaced nav do not end the current nav", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: "1" });
    startNavigation({ href: "/w/b", fromUrl: "/w", key: "2" });
    const s3 = startNavigation({ href: "/w/c", fromUrl: "/w", key: "3" });
    reportMark({ url: "/w/a", kind: "page" });
    reportMark({ url: "/w/b", kind: "page" });
    expect(getSnapshot().nav?.seq).toBe(s3);
    reportMark({ url: "/w/c", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
    // 遷移が終わったら替えた行き先は忘れる: 次の遷移では、その URL も普通の印として扱う
    startNavigation({ href: "/w/d", fromUrl: "/w", key: null });
    reportMark({ url: "/w/a", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
  });

  it("replacing a nav stops the old timers (the old 150 ms / 10 s clocks do not touch the new nav)", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    vi.advanceTimersByTime(100);
    startNavigation({ href: "/w/b", fromUrl: "/w", key: null });
    vi.advanceTimersByTime(60); // 経過 160 ms: 古い遷移の 150 ms は過ぎたが、新しい遷移はまだ 60 ms
    expect(getSnapshot().nav?.visible).toBe(false);
    vi.advanceTimersByTime(NAV_TIMEOUT_MS - 160 + 1); // 経過 10_001 ms: 古い遷移の打ち切り(経過 10_000)は過ぎたが、新しい遷移(経過 10_100)はまだ
    expect(getSnapshot().nav?.timedOut).toBe(false);
    vi.advanceTimersByTime(NAV_TIMEOUT_MS);
    expect(getSnapshot().nav?.timedOut).toBe(true);
  });

  it("cancelNavigation clears timers and replaced targets", () => {
    const listener = vi.fn();
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    startNavigation({ href: "/w/b", fromUrl: "/w", key: null }); // /w/a は「替えた行き先」になる
    subscribe(listener);
    cancelNavigation();
    expect(getSnapshot().nav).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    // 時計も止まっている(消えた遷移を visible / timedOut にしない)
    vi.advanceTimersByTime(NAV_TIMEOUT_MS + 1);
    expect(getSnapshot().nav).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    // 替えた行き先も忘れている: 次の遷移では /w/a の印も普通の印(押した画面と違う URL なので遷移を終える)
    startNavigation({ href: "/w/c", fromUrl: "/w", key: null });
    reportMark({ url: "/w/a", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
    // 遷移が無いときは何もしない(購読者に知らせない)
    const before = listener.mock.calls.length;
    cancelNavigation();
    expect(listener).toHaveBeenCalledTimes(before);
  });

  it("nav that lands back on fromUrl ends by timeout", () => {
    startNavigation({ href: "/x", fromUrl: "/y", key: null });
    reportMark({ url: "/y", kind: "page" });
    vi.advanceTimersByTime(10_000);
    expect(getSnapshot().nav?.timedOut).toBe(true);
  });

  it("nav times out after 10 s and stays until the next mark or nav", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    vi.advanceTimersByTime(10_000);
    expect(getSnapshot().nav?.timedOut).toBe(true);
    reportMark({ url: "/w/a", kind: "page" });
    expect(getSnapshot().nav).toBeNull();
  });

  it("a deferred nav starts its timeout clock at dispatch", () => {
    const s = startNavigation({ href: "/w/a", fromUrl: "/w", key: null, deferred: true });
    expect(getSnapshot().nav?.dispatched).toBe(false);
    vi.advanceTimersByTime(9_000);
    expect(getSnapshot().nav?.visible).toBe(true);
    markNavigationDispatched(s);
    expect(getSnapshot().nav?.dispatched).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(getSnapshot().nav?.timedOut).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getSnapshot().nav?.timedOut).toBe(true);
  });

  it("markNavigationDispatched ignores a number that is not the current nav", () => {
    const s1 = startNavigation({ href: "/w/a", fromUrl: "/w", key: null, deferred: true });
    startNavigation({ href: "/w/b", fromUrl: "/w", key: null, deferred: true });
    markNavigationDispatched(s1);
    expect(getSnapshot().nav?.dispatched).toBe(false);
    vi.advanceTimersByTime(NAV_TIMEOUT_MS * 2);
    expect(getSnapshot().nav?.timedOut).toBe(false);
  });

  it("a non-deferred nav is dispatched from the start", () => {
    startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    expect(getSnapshot().nav?.dispatched).toBe(true);
  });

  it("navStartedAfter compares against the latest nav seq", () => {
    const w = nextSeq();
    expect(navStartedAfter(w)).toBe(false);
    startNavigation({ href: "/a", fromUrl: "/", key: null });
    expect(navStartedAfter(w)).toBe(true);
    // 遷移が終わった後も、始まったという事実は残る
    reportMark({ url: "/a", kind: "page" });
    expect(navStartedAfter(w)).toBe(true);
  });

  it("navOutcome tells pending, ended, timedOut and replaced", () => {
    // 進行中 → 印で終わる
    const a = startNavigation({ href: "/w/a", fromUrl: "/w", key: null });
    expect(navOutcome(a)).toBe("pending");
    reportMark({ url: "/w/a", kind: "page" });
    expect(navOutcome(a)).toBe("ended");
    // 別の遷移で替える → 前の番号は replaced
    const b = startNavigation({ href: "/w/b", fromUrl: "/w", key: null });
    const c = startNavigation({ href: "/w/c", fromUrl: "/w", key: null });
    expect(navOutcome(b)).toBe("replaced");
    expect(navOutcome(c)).toBe("pending");
    // cancelNavigation で終える → 印が来ていないので replaced
    cancelNavigation();
    expect(navOutcome(c)).toBe("replaced");
    // 10 秒 → timedOut。後に回した遷移は移り始めるまで pending
    const d = startNavigation({ href: "/w/d", fromUrl: "/w", key: null, deferred: true });
    vi.advanceTimersByTime(NAV_TIMEOUT_MS);
    expect(navOutcome(d)).toBe("pending");
    markNavigationDispatched(d);
    vi.advanceTimersByTime(NAV_TIMEOUT_MS);
    expect(navOutcome(d)).toBe("timedOut");
    // 打ち切られた遷移が後の遷移に替わったら replaced
    startNavigation({ href: "/w/e", fromUrl: "/w", key: null });
    expect(navOutcome(d)).toBe("replaced");
    // 覚えていない番号(遷移でない番号・古すぎる番号)は ended
    expect(navOutcome(nextSeq())).toBe("ended");
    for (let i = 0; i < 9; i++) startNavigation({ href: `/w/x${i}`, fromUrl: "/w", key: null });
    expect(navOutcome(b)).toBe("ended");
  });

  it("lastMarkUrl tracks the latest mark", () => {
    expect(lastMarkUrl()).toBeNull();
    reportMark({ url: "/s", kind: "page" });
    expect(lastMarkUrl()).toBe("/s");
    // 遷移を終えない印(fromUrl と同じ)でも更新する
    startNavigation({ href: "/b", fromUrl: "/s", key: null });
    reportMark({ url: "/s", kind: "page" });
    reportMark({ url: "/t", kind: "page" });
    expect(lastMarkUrl()).toBe("/t");
  });
});

describe("normalizeUrl", () => {
  it("normalizeUrl sorts the query and drops the hash", () => {
    expect(normalizeUrl("/x?b=2&a=1#h", "http://h")).toBe("/x?a=1&b=2");
    expect(normalizeUrl("/x?", "http://h")).toBe("/x");
  });

  it("同じ鍵の値の順は変えず、絶対 URL も pathname + 検索に直す", () => {
    expect(normalizeUrl("http://h/x?b=2&a=2&a=1", "http://other")).toBe("/x?a=2&a=1&b=2");
  });
});

describe("書き込みの成功の印", () => {
  it("writeSucceededRecently is cleared by clearWriteSucceeded and by the end of a nav", () => {
    noteWriteSucceeded();
    expect(writeSucceededRecently()).toBe(true);
    clearWriteSucceeded();
    expect(writeSucceededRecently()).toBe(false);
    noteWriteSucceeded();
    startNavigation({ href: "/b", fromUrl: "/a", key: null });
    reportMark({ url: "/b", kind: "page" });
    expect(writeSucceededRecently()).toBe(false);
  });

  it("遷移を終えない印では消えない", () => {
    noteWriteSucceeded();
    startNavigation({ href: "/b", fromUrl: "/a", key: null });
    reportMark({ url: "/a", kind: "page" });
    expect(writeSucceededRecently()).toBe(true);
  });
});

describe("guard と snapshot", () => {
  it("guards aggregate dirty and busy across scopes", () => {
    setGuard("a", { dirty: true, busy: false });
    setGuard("b", { dirty: false, busy: true });
    expect(getSnapshot()).toMatchObject({ dirty: true, busy: true });
    setGuard("a", null);
    setGuard("b", null);
    expect(getSnapshot()).toMatchObject({ dirty: false, busy: false });
  });

  it("selectLinkPending returns the same primitive across unrelated updates", () => {
    const sel = selectLinkPending("mine");
    const before = sel(getSnapshot());
    startNavigation({ href: "/b", fromUrl: "/a", key: "other" });
    vi.advanceTimersByTime(200);
    setGuard("x", { dirty: true, busy: false });
    expect(sel(getSnapshot())).toBe(before);
  });

  it("selectLinkPending is true only for the visible nav with the same key", () => {
    const sel = selectLinkPending("mine");
    startNavigation({ href: "/b", fromUrl: "/a", key: "mine" });
    expect(sel(getSnapshot())).toBe(false);
    vi.advanceTimersByTime(NAV_DELAY_MS);
    expect(sel(getSnapshot())).toBe(true);
    reportMark({ url: "/b", kind: "page" });
    expect(sel(getSnapshot())).toBe(false);
  });

  // 最終レビュー FR-Medium-4(台帳の Ruling 7): 打ち切りの後は、押したリンクの回る印を止め、上部バーの骨組みも戻す(操作を返す)。
  // 前のサイトの名前を出さないための「URL と描いた値が違えば帯」は SiteChromeGuard の側に残る(ここは遷移の状態だけの判定)
  it("selectLinkPending and selectScopeSkeleton turn false once the navigation timed out", () => {
    const link = selectLinkPending("mine");
    const skeleton = selectScopeSkeleton({ wid: "a", sid: "s" });
    startNavigation({ href: "/w/b/sites/t", fromUrl: "/w/a/sites/s", key: "mine" });
    vi.advanceTimersByTime(NAV_DELAY_MS);
    expect([link(getSnapshot()), skeleton(getSnapshot())]).toEqual([true, true]);
    vi.advanceTimersByTime(NAV_TIMEOUT_MS);
    expect(getSnapshot().nav?.timedOut).toBe(true);
    expect([link(getSnapshot()), skeleton(getSnapshot())]).toEqual([false, false]);
  });

  it("同じ中身なら同じ参照を返し、購読者にも知らせない", () => {
    const fn = vi.fn();
    const unsubscribe = subscribe(fn);
    const s0 = getSnapshot();
    setGuard("a", null);
    setGuard("a", { dirty: false, busy: false });
    reportMark({ url: "/s", kind: "page" }); // 遷移が無いので画面には関わらない
    expect(getSnapshot()).toBe(s0);
    expect(fn).not.toHaveBeenCalled();
    setGuard("a", { dirty: true, busy: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).not.toBe(s0);
    setGuard("a", { dirty: true, busy: false });
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    setGuard("a", null);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
