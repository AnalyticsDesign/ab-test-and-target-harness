import { describe, expect, it } from "vitest";
import { POPSTATE_GUARD_SCRIPT, installPopstateGuard, type PopstateGuardApi } from "@/lib/popstate-guard";

/**
 * 戻る・進むの守り(B173 第 1 段 Task 8。Q17 = 自前の位置の番号 __wttPos、Q21 = vinext が先に読み込まれた場合)。
 * 小さな偽の window で確かめる: 履歴は項目の配列と位置を持ち、popstate の listener は capture のものを先に呼び、
 * stopImmediatePropagation で残りを止める(window が的のイベントの、今の主要ブラウザの挙動)。
 * history.go は呼ばれた数を記録し、移動は flush() で起こす(本物のブラウザでも go は非同期に popstate を出す)
 */

type Entry = { state: unknown; url: string };
type Listener = { fn: (e: FakePopState) => void; capture: boolean };
type FakePopState = { type: "popstate"; state: unknown; stopImmediatePropagation(): void };
const VINEXT_KEY = Symbol.for("vinext.clientNavigationState");

function fakeWindow(startUrl = "http://admin.test/w/a") {
  const entries: Entry[] = [{ state: null, url: startUrl }];
  let index = 0;
  const listeners: Listener[] = [];
  const goCalls: number[] = [];
  const queue: Array<() => void> = [];
  const resolve = (url?: string | URL | null) => (url == null ? entries[index]!.url : new URL(String(url), entries[index]!.url).href);
  const clone = (s: unknown) => (s === undefined ? null : structuredClone(s));
  const dispatch = (state: unknown) => {
    let stopped = false;
    const e: FakePopState = { type: "popstate", state, stopImmediatePropagation: () => void (stopped = true) };
    for (const l of [...listeners.filter((x) => x.capture), ...listeners.filter((x) => !x.capture)]) {
      if (stopped) break;
      l.fn(e);
    }
  };
  /** 利用者の戻る・進む(go の記録に入れない) */
  const traverse = (n: number) => {
    const t = index + n;
    if (t < 0 || t >= entries.length) return;
    index = t;
    dispatch(entries[index]!.state);
  };
  const history = {
    get state() {
      return entries[index]!.state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      const next = { state: clone(state), url: resolve(url) };
      entries.splice(index + 1);
      entries.push(next);
      index += 1;
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      entries[index] = { state: clone(state), url: resolve(url) };
    },
    go(n: number) {
      goCalls.push(n);
      queue.push(() => traverse(n));
    },
  };
  const location = {
    get href() {
      return entries[index]!.url;
    },
    get pathname() {
      return new URL(entries[index]!.url).pathname;
    },
  };
  const win: Record<string | symbol, unknown> = {
    history,
    location,
    addEventListener(type: string, fn: (e: FakePopState) => void, opts?: boolean | { capture?: boolean }) {
      if (type !== "popstate") return;
      listeners.push({ fn, capture: typeof opts === "boolean" ? opts : !!opts?.capture });
    },
  };
  return {
    win,
    history,
    entries,
    goCalls,
    traverse,
    index: () => index,
    flush() {
      while (queue.length > 0) queue.shift()!();
    },
    /** vinext の listener の代わり(非 capture)。呼ばれた回数を数える */
    others() {
      const calls: unknown[] = [];
      (win.addEventListener as (t: string, f: (e: FakePopState) => void, o?: boolean) => void)("popstate", (e) => calls.push(e.state), false);
      return calls;
    },
  };
}

const install = (w: ReturnType<typeof fakeWindow>) => installPopstateGuard(w.win as unknown as Window);
const guardOf = (w: ReturnType<typeof fakeWindow>) => w.win.__wttPopstateGuard as PopstateGuardApi;
const posAt = (w: ReturnType<typeof fakeWindow>, i: number) => (w.entries[i]!.state as { __wttPos?: number } | null)?.__wttPos;
/** vinext の遷移の書き込み(state は object) */
const go = (w: ReturnType<typeof fakeWindow>, p: string) => w.history.pushState({ vIdx: w.index() + 1 }, "", p);

describe("installPopstateGuard: 位置の番号", () => {
  it("writes position 0 into the first entry on load", () => {
    const w = fakeWindow();
    install(w);
    expect(posAt(w, 0)).toBe(0);
  });

  it("keeps the position already stored in history.state on reload", () => {
    const w = fakeWindow();
    w.entries[0] = { state: { __wttPos: 2, keep: 1 }, url: "http://admin.test/w/a" };
    install(w);
    go(w, "/w/b");
    expect(posAt(w, 1)).toBe(3);
    expect(w.entries[0]!.state).toEqual({ __wttPos: 2, keep: 1 });
  });

  it("pushState and replaceState write contiguous positions even after branching history", () => {
    const w = fakeWindow();
    install(w);
    go(w, "/w/b");
    go(w, "/w/c");
    expect([posAt(w, 1), posAt(w, 2)]).toEqual([1, 2]);
    w.traverse(-1); // B に戻る
    go(w, "/w/d"); // C の項目が D に置き換わる(vinext の番号なら 3 になる場面)
    expect(w.entries.length).toBe(3);
    expect(posAt(w, 2)).toBe(2);
    // replace は今の位置を書き足す(ほかの値は残す)
    w.history.replaceState({ vIdx: 9, keep: "x" }, "", "/w/d?tab=variants");
    expect(w.entries[2]!.state).toEqual({ vIdx: 9, keep: "x", __wttPos: 2 });
  });

  it("does not add the position to a non-object state, but still counts the pushed entry", () => {
    const w = fakeWindow();
    install(w);
    w.history.pushState("text", "", "/w/b");
    expect(w.entries[1]!.state).toBe("text");
    go(w, "/w/c");
    expect(posAt(w, 2)).toBe(2);
  });

  it("the listener is registered in the capture phase", () => {
    const w = fakeWindow();
    const calls = w.others(); // vinext の listener が先に登録されていても
    install(w);
    go(w, "/w/b");
    guardOf(w).arm(() => {});
    w.traverse(-1);
    expect(calls).toEqual([]);
  });
});

describe("installPopstateGuard: 守り", () => {
  /** A=0, B=1, C=2 まで積んで、C で守りを付ける */
  function armedAtC() {
    const w = fakeWindow();
    install(w);
    const calls = w.others();
    go(w, "/w/b");
    go(w, "/w/c");
    const blocks: Array<{ delta: number; href: string }> = [];
    guardOf(w).arm((b) => blocks.push(b));
    return { w, calls, blocks };
  }

  it("blocks a back navigation, reverts with history.go(delta) and reports delta and href", () => {
    const { w, calls, blocks } = armedAtC();
    w.traverse(-1);
    expect(w.goCalls).toEqual([1]);
    expect(blocks).toEqual([{ delta: 1, href: "http://admin.test/w/b" }]);
    expect(calls).toEqual([]);
  });

  it("blocks a forward navigation with a negative delta", () => {
    const { w, calls } = armedAtC();
    guardOf(w).disarm();
    w.traverse(-1); // B へ(守りなし)
    calls.length = 0;
    const blocks: Array<{ delta: number; href: string }> = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(1);
    expect(blocks).toEqual([{ delta: -1, href: "http://admin.test/w/c" }]);
    expect(calls).toEqual([]);
  });

  it("blocks a two-step back after branching", () => {
    const w = fakeWindow();
    install(w);
    const calls = w.others();
    go(w, "/w/b");
    go(w, "/w/c");
    w.traverse(-1);
    go(w, "/w/d");
    calls.length = 0;
    const blocks: Array<{ delta: number; href: string }> = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(-2); // A(位置 0)へ
    expect(w.goCalls).toEqual([2]);
    expect(blocks).toEqual([{ delta: 2, href: "http://admin.test/w/a" }]);
    expect(calls).toEqual([]);
  });

  it("swallows the popstate caused by its own revert", () => {
    const { w, calls } = armedAtC();
    w.traverse(-1);
    w.flush(); // go(1) の移動 → 位置 2 の popstate
    expect(w.index()).toBe(2);
    expect(calls).toEqual([]);
    expect(w.goCalls).toEqual([1]);
  });

  it("entries without a position pass through", () => {
    const w = fakeWindow();
    install(w);
    const calls = w.others();
    w.history.pushState(null, "", "/w/b"); // 番号の付かない項目
    go(w, "/w/c");
    guardOf(w).arm(() => {});
    w.traverse(-1);
    expect(calls).toEqual([null]);
    expect(w.goCalls).toEqual([]);
  });

  it("zero delta passes through", () => {
    const { w, calls } = armedAtC();
    // 付けた位置と同じ番号の項目への popstate(別の pathname でも、差が 0 なら止めない)
    w.entries[1] = { state: { __wttPos: 2 }, url: "http://admin.test/w/x" };
    w.traverse(-1);
    expect(calls.length).toBe(1);
    expect(w.goCalls).toEqual([]);
  });

  it("same-pathname entries pass through and move the armed position", () => {
    const w = fakeWindow();
    install(w);
    const calls = w.others();
    go(w, "/w/b");
    go(w, "/w/c");
    go(w, "/w/c?tab=variants"); // 同じ pathname の項目(位置 3)
    const blocks: Array<{ delta: number; href: string }> = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(-1); // 位置 2(同じ pathname)→ 素通り
    expect(calls.length).toBe(1);
    expect(w.goCalls).toEqual([]);
    w.traverse(-1); // 位置 1(別の pathname)→ 新しい付けた位置 2 からの差 1 で止まる
    expect(w.goCalls).toEqual([1]);
    expect(blocks).toEqual([{ delta: 1, href: "http://admin.test/w/b" }]);
    expect(calls.length).toBe(1);
  });

  it("proceed disarms and goes by -delta", () => {
    const { w, calls, blocks } = armedAtC();
    w.traverse(-1);
    w.flush();
    guardOf(w).proceed(blocks[0]!.delta);
    expect(w.goCalls).toEqual([1, -1]);
    w.flush();
    expect(w.index()).toBe(1);
    expect(calls).toEqual([{ vIdx: 1, __wttPos: 1 }]);
  });

  it("disarm lets navigation pass", () => {
    const { w, calls } = armedAtC();
    guardOf(w).disarm();
    w.traverse(-1);
    expect(calls.length).toBe(1);
    expect(w.goCalls).toEqual([]);
  });
});

describe("installPopstateGuard: vinext が先に読み込まれた場合(Q21)", () => {
  /** vinext のモジュールの最上位がすることの代わり: 元の関数を握り、history.* を自分の関数に替え、popstate の listener を付ける */
  function vinextFirst(w: ReturnType<typeof fakeWindow>, key: symbol) {
    const h = w.history;
    const state = { originalPushState: h.pushState.bind(h), originalReplaceState: h.replaceState.bind(h) };
    w.win[key] = state;
    const calls = w.others();
    h.pushState = function patchedPushState(data: unknown, unused: string, url?: string | URL | null) {
      state.originalPushState.call(h, data, unused, url);
    };
    return { state, calls };
  }

  it("when vinext was loaded first, its captured originals are replaced and arm() does nothing", () => {
    const w = fakeWindow();
    const { state, calls } = vinextFirst(w, VINEXT_KEY);
    const patched = w.history.pushState;
    install(w);
    expect(w.history.pushState).toBe(patched); // history.* は包まない(包むと番号が 2 つ進む)
    state.originalPushState({ vIdx: 1 }, "", "/w/b"); // vinext の遷移の書き込み(WithoutNotify)
    w.history.pushState({ vIdx: 2 }, "", "/w/c"); // patchedPushState → originalPushState
    expect([posAt(w, 1), posAt(w, 2)]).toEqual([1, 2]);
    expect(guardOf(w).lateInstall).toBe(true);
    guardOf(w).arm(() => {});
    w.traverse(-1);
    expect(calls.length).toBe(1);
    expect(w.goCalls).toEqual([]);
  });

  it("if the vinext internal key is renamed, the guard passes through instead of breaking", () => {
    const w = fakeWindow();
    const { state, calls } = vinextFirst(w, Symbol.for("vinext.renamedState"));
    install(w);
    expect(guardOf(w).lateInstall).toBe(false);
    state.originalPushState({ vIdx: 1 }, "", "/w/b"); // 握られた素の関数: 番号が付かない
    state.originalPushState({ vIdx: 2 }, "", "/w/c");
    guardOf(w).arm(() => {});
    expect(() => w.traverse(-1)).not.toThrow();
    expect(calls.length).toBe(1);
    expect(w.goCalls).toEqual([]);
  });
});

describe("installPopstateGuard: 位置の番号の連続を信頼できないとき(最終レビュー FR-Medium-2・台帳 118)", () => {
  /** 守りのスクリプトを通らない書き込み(vinext の内部名が変わり、握られた素の関数で積まれた項目の代わり)。install の前に握る */
  function withRawPush() {
    const w = fakeWindow();
    const raw = w.history.pushState.bind(w.history);
    install(w);
    const calls = w.others();
    return { w, calls, rawPush: (p: string) => raw({ vIdx: w.index() + 1 }, "", p) };
  }

  it("A(0) → B(1) → C(2) → D(no position): going back from D to A passes through without history.go", () => {
    const { w, calls, rawPush } = withRawPush();
    go(w, "/w/b");
    go(w, "/w/c");
    rawPush("/w/d");
    const blocks: unknown[] = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(-3);
    expect(w.goCalls).toEqual([]);
    expect(blocks).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("after numbered and unnumbered entries are mixed, the guard does not revert by a position difference", () => {
    const { w, calls, rawPush } = withRawPush();
    go(w, "/w/b");
    go(w, "/w/c");
    rawPush("/w/d"); // 番号なし(実際の位置 3)
    go(w, "/w/e"); // 守りを通る書き込み。古い位置から数えると 3 になる(実際の位置は 4)
    const blocks: unknown[] = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(-4); // A(位置 0)へ。差 3 で戻すと D に着いてしまう
    expect(w.goCalls).toEqual([]);
    expect(blocks).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("a guard armed before the untracked entry is dropped when a later history write finds the gap", () => {
    const { w, calls, rawPush } = withRawPush();
    go(w, "/w/b");
    go(w, "/w/c");
    guardOf(w).arm(() => {}); // C(位置 2)で付けたまま
    rawPush("/w/d"); // 番号なし(実際の位置 3)
    go(w, "/w/e"); // 守りを通る書き込みが、今の項目に番号が無いことに気づく
    w.traverse(-4); // A(位置 0)へ。付けた位置 2 からの差 2 で戻すと C に着いてしまう
    expect(w.goCalls).toEqual([]);
    expect(calls.length).toBe(1);
  });

  // 2 回目の直しの差分のレビュー: 番号の無い項目の state が object でない(null・文字列)場合も、位置の番号を信頼できないとして見つける
  for (const [label, state] of [["null", null], ["a string", "text"]] as const) {
    it(`an untracked entry whose state is ${label} also makes the guard pass through (A0 → B1 → C2 → D → E)`, () => {
      const w = fakeWindow();
      const raw = w.history.pushState.bind(w.history);
      install(w);
      const calls = w.others();
      go(w, "/w/b");
      go(w, "/w/c");
      raw(state, "", "/w/d"); // 守りを通らない追加(実際の位置 3、番号なし)
      go(w, "/w/e"); // 守りを通る追加。古い位置から数えると 3(実際は 4)
      const blocks: unknown[] = [];
      guardOf(w).arm((b) => blocks.push(b));
      w.traverse(-4); // A へ。差 3 で戻すと D に着いてしまう
      expect(w.goCalls).toEqual([]);
      expect(blocks).toEqual([]);
      expect(calls.length).toBe(1);
    });
  }

  it("once an unnumbered entry was visited, arm() stays a no-op for the rest of the document", () => {
    const { w, calls, rawPush } = withRawPush();
    go(w, "/w/b");
    rawPush("/w/c");
    w.traverse(-1); // B(位置 1)
    w.traverse(1); // C(番号なし)を通る
    w.traverse(-1); // B へ戻る
    calls.length = 0;
    guardOf(w).arm(() => {});
    w.traverse(-1);
    expect(w.goCalls).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe("POPSTATE_GUARD_SCRIPT", () => {
  it("works when run as an inline script (no outside references)", () => {
    const w = fakeWindow();
    new Function("window", POPSTATE_GUARD_SCRIPT)(w.win);
    const calls = w.others();
    go(w, "/w/b");
    const blocks: unknown[] = [];
    guardOf(w).arm((b) => blocks.push(b));
    w.traverse(-1);
    expect(blocks).toEqual([{ delta: 1, href: "http://admin.test/w/a" }]);
    expect(calls).toEqual([]);
  });

  it("installing twice keeps the first install (no double counting)", () => {
    const w = fakeWindow();
    install(w);
    install(w);
    go(w, "/w/b");
    expect(posAt(w, 1)).toBe(1);
  });
});
