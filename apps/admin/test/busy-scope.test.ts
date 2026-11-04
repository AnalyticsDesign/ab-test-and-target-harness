import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MIN_MS, NAV_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/feedback-store";
import type { NavHandle } from "@/lib/navigate";
import { runBusy, type BusyDeps } from "@/lib/run-busy";
import { claimRun, releaseRun } from "@/components/ui/BusyScope";

/**
 * 書き込みの間の「覆う・待つ・結果を返す」の時間の決まり(runBusy)を、偽の deps(偽の時計・sleep)で確かめる。
 * 実行権(claimRun / releaseRun)は hook が持つので、別に確かめる
 */

type Harness = {
  deps: BusyDeps;
  calls: string[];
  /** navStartedAfter が返す値。テストの中で書き換えて「遷移が始まった」を作る */
  nav: { started: boolean };
  sleeps: number[];
  /** now() が返す時刻。sleep の長さの計算の確認用 */
  clock: { t: number };
  /** alive() が返す値。関数にすると呼ばれるたびに決められる(n = 何回目の呼び出しか。1 から) */
  alive: { value: boolean | ((n: number) => boolean); calls: number };
  /** waitNav が返す Promise を決める。既定は解決しない(ページが閉じる) */
  wait: { next: (h: NavHandle) => Promise<"timedOut" | "replaced" | "none"> };
};

function harness(over: { refresh?: () => Promise<"done" | "timeout"> } = {}): Harness {
  const calls: string[] = [];
  const nav = { started: false };
  const sleeps: number[] = [];
  const clock = { t: 1000 };
  const alive: Harness["alive"] = { value: true, calls: 0 };
  const wait: Harness["wait"] = { next: () => new Promise(() => {}) };
  const deps: BusyDeps = {
    sleep: async (ms) => {
      sleeps.push(ms);
      calls.push(`sleep:${ms}`);
      clock.t += ms;
    },
    refresh:
      over.refresh ??
      (async () => {
        calls.push("refresh");
        return "done";
      }),
    seq: () => 7,
    navStartedAfter: (seq) => {
      expect(seq).toBe(7);
      return nav.started;
    },
    noteWriteSucceeded: () => void calls.push("noteWriteSucceeded"),
    showOverlay: () => void calls.push("showOverlay"),
    now: () => clock.t,
    alive: () => {
      alive.calls += 1;
      return typeof alive.value === "function" ? alive.value(alive.calls) : alive.value;
    },
    releaseGuard: () => {
      calls.push("releaseGuard");
      return () => void calls.push("restoreGuard");
    },
    waitNav: (h) => {
      calls.push(`waitNav:${h.kind}`);
      return wait.next(h);
    },
  };
  return { deps, calls, nav, sleeps, clock, alive, wait };
}

describe("runBusy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a fast save still keeps the overlay for 300 ms", async () => {
    const h = harness();
    const out = await runBusy(h.deps, { write: async () => "v", after: "refresh" });
    expect(out).toEqual({ kind: "saved", value: "v", refresh: "done" });
    expect(h.sleeps).toEqual([BUSY_MIN_MS]);
  });

  it("only waits for the rest of the 300 ms when the write and refresh already took time", async () => {
    const h = harness();
    const out = await runBusy(h.deps, {
      write: async () => {
        h.clock.t += 120;
        return 1;
      },
      after: "refresh",
    });
    expect(out.kind).toBe("saved");
    expect(h.sleeps).toEqual([BUSY_MIN_MS - 120]);
  });

  it("does not sleep when 300 ms have already passed", async () => {
    const h = harness();
    await runBusy(h.deps, {
      write: async () => {
        h.clock.t += 500;
        return 1;
      },
      after: "refresh",
    });
    expect(h.sleeps).toEqual([]);
  });

  it("onWritten runs after a successful write and before the refresh", async () => {
    const h = harness();
    await runBusy(h.deps, {
      write: async () => {
        h.calls.push("write");
        return "v";
      },
      onWritten: (v) => h.calls.push(`onWritten:${v}`),
      after: "refresh",
    });
    expect(h.calls.filter((c) => !c.startsWith("sleep"))).toEqual(["showOverlay", "write", "onWritten:v", "noteWriteSucceeded", "refresh"]);
  });

  it("after: none skips the refresh and reports skipped", async () => {
    const h = harness();
    const out = await runBusy(h.deps, { write: async () => 1, after: "none" });
    expect(out).toEqual({ kind: "saved", value: 1, refresh: "skipped" });
    expect(h.calls).not.toContain("refresh");
    expect(h.calls).toContain("noteWriteSucceeded");
  });

  it("a failure returns immediately without the 300 ms minimum", async () => {
    const h = harness();
    const onWritten = vi.fn();
    const error = new Error("boom");
    const out = await runBusy(h.deps, {
      write: async () => {
        throw error;
      },
      onWritten,
      after: "refresh",
    });
    expect(out).toEqual({ kind: "failed", error });
    expect(h.sleeps).toEqual([]);
    expect(onWritten).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("noteWriteSucceeded");
    expect(h.calls).not.toContain("refresh");
  });

  it("a write that throws synchronously is a failure too", async () => {
    const h = harness();
    const error = new Error("sync");
    const out = await runBusy(h.deps, {
      write: () => {
        throw error;
      },
      after: "refresh",
    });
    expect(out).toEqual({ kind: "failed", error });
  });

  it("a write slower than 30 s returns unknown and aborts", async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    const p = runBusy(h.deps, {
      write: (s) => {
        signal = s;
        return new Promise<never>(() => {});
      },
      onWritten: () => h.calls.push("onWritten"),
      after: "refresh",
    });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: "unknown" });
    expect(signal?.aborted).toBe(true);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).not.toContain("onWritten");
  });

  it("a write that settles after the timeout is ignored (no unhandled rejection, no onWritten)", async () => {
    const h = harness();
    let reject!: (e: unknown) => void;
    const onWritten = vi.fn();
    const p = runBusy(h.deps, {
      write: () => new Promise<never>((_, r) => (reject = r)),
      onWritten,
      after: "refresh",
    });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(await p).toEqual({ kind: "unknown" });
    reject(new DOMException("aborted", "AbortError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("clears the 30 s timer once the write settles", async () => {
    const h = harness();
    await runBusy(h.deps, { write: async () => 1, after: "none" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a navigation started before the write returns discards the result and skips the refresh", async () => {
    const h = harness();
    const onWritten = vi.fn();
    const out = await runBusy(h.deps, {
      write: async () => {
        h.nav.started = true;
        return 1;
      },
      onWritten,
      after: "refresh",
    });
    expect(out).toEqual({ kind: "discarded" });
    expect(onWritten).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("refresh");
    expect(h.calls).not.toContain("noteWriteSucceeded");
    expect(h.sleeps).toEqual([]);
  });

  it("a navigation started during the refresh discards the result", async () => {
    const onWritten = vi.fn();
    const h: Harness = harness({
      refresh: async () => {
        h.nav.started = true;
        return "done";
      },
    });
    const out = await runBusy(h.deps, { write: async () => 1, onWritten, after: "refresh" });
    expect(out).toEqual({ kind: "discarded" });
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(h.calls).toContain("noteWriteSucceeded");
    expect(h.sleeps).toEqual([]);
  });

  it("a navigation started during the 300 ms wait discards the result", async () => {
    const h = harness();
    h.deps.sleep = async (ms) => {
      h.sleeps.push(ms);
      h.nav.started = true;
    };
    const out = await runBusy(h.deps, { write: async () => 1, after: "refresh" });
    expect(out).toEqual({ kind: "discarded" });
  });

  it("a navigation started before a failure returns discarded instead of failed", async () => {
    const h = harness();
    const out = await runBusy(h.deps, {
      write: async () => {
        h.nav.started = true;
        throw new Error("boom");
      },
      after: "refresh",
    });
    expect(out).toEqual({ kind: "discarded" });
    expect(h.sleeps).toEqual([]);
  });

  it("a cancelled confirm returns cancelled without overlay or write", async () => {
    const h = harness();
    const write = vi.fn(async () => 1);
    const out = await runBusy(h.deps, { confirm: async () => false, write, after: "refresh" });
    expect(out).toEqual({ kind: "cancelled" });
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("an accepted confirm comes before the overlay and the write", async () => {
    const h = harness();
    await runBusy(h.deps, {
      confirm: async () => {
        h.calls.push("confirm");
        return true;
      },
      write: async () => {
        h.calls.push("write");
        return 1;
      },
      after: "none",
    });
    expect(h.calls.slice(0, 3)).toEqual(["confirm", "showOverlay", "write"]);
  });

  it("two saves in a row on the same URL both end as saved", async () => {
    const h = harness();
    const task = { write: async () => 1, after: "refresh" as const };
    expect(await runBusy(h.deps, task)).toMatchObject({ kind: "saved", refresh: "done" });
    expect(await runBusy(h.deps, task)).toMatchObject({ kind: "saved", refresh: "done" });
  });

  it("refresh timeout is passed through", async () => {
    const h = harness({ refresh: async () => "timeout" });
    const out = await runBusy(h.deps, { write: async () => 1, after: "refresh" });
    expect(out).toMatchObject({ kind: "saved", refresh: "timeout" });
  });
});

/** sleep 以外の呼び出しの順 */
const steps = (h: Harness) => h.calls.filter((c) => !c.startsWith("sleep"));

describe("runBusy: after navigate / custom と持ち主の生存(第 2 段)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const navTask = (h: Harness, over: Record<string, unknown> = {}) => ({
    write: async () => {
      h.calls.push("write");
      return "v";
    },
    onWritten: () => void h.calls.push("onWritten"),
    after: "navigate" as const,
    navigate: (): NavHandle => {
      h.calls.push("navigate");
      return { kind: "app", seq: 9 };
    },
    ...over,
  });

  it("navigate: releases the guard before navigating and keeps the overlay until the page goes", async () => {
    const h = harness();
    let settled = false;
    const p = runBusy(h.deps, navTask(h)).then(() => void (settled = true));
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS * 3);
    expect(settled).toBe(false);
    expect(steps(h)).toEqual(["showOverlay", "write", "onWritten", "noteWriteSucceeded", "releaseGuard", "navigate", "waitNav:app"]);
    expect(h.sleeps).toEqual([]);
    void p;
  });

  it("navigate: own navigation is not treated as discarded", async () => {
    const h = harness();
    h.wait.next = async () => "timedOut";
    const out = await runBusy(
      h.deps,
      navTask(h, {
        navigate: (): NavHandle => {
          h.nav.started = true; // 自分で始めた遷移
          return { kind: "app", seq: 9 };
        },
      }),
    );
    expect(out).toEqual({ kind: "navigated", value: "v", nav: "timedOut" });
  });

  it("navigate: a none handle releases the hold at once", async () => {
    const h = harness();
    h.wait.next = async (handle) => {
      expect(handle).toEqual({ kind: "none" });
      return "none";
    };
    const out = await runBusy(h.deps, navTask(h, { navigate: (): NavHandle => ({ kind: "none" }) }));
    expect(out).toEqual({ kind: "navigated", value: "v", nav: "none" });
    expect(h.calls).toContain("restoreGuard");
  });

  it("navigate: a later nav releases the navigate hold", async () => {
    const h = harness();
    h.wait.next = async () => "replaced";
    expect(await runBusy(h.deps, navTask(h))).toEqual({ kind: "navigated", value: "v", nav: "replaced" });
  });

  it("navigate: nav timeout releases the hold", async () => {
    const h = harness();
    h.wait.next = async () => "timedOut";
    expect(await runBusy(h.deps, navTask(h))).toMatchObject({ kind: "navigated", nav: "timedOut" });
    expect(h.sleeps).toEqual([]);
  });

  it("navigate: a nav started before the write returns still discards and does not navigate", async () => {
    const h = harness();
    const out = await runBusy(
      h.deps,
      navTask(h, {
        write: async () => {
          h.nav.started = true;
          return "v";
        },
      }),
    );
    expect(out).toEqual({ kind: "discarded" });
    expect(h.calls).not.toContain("releaseGuard");
    expect(h.calls).not.toContain("navigate");
  });

  it("navigate: a failed write keeps the guard and does not navigate", async () => {
    const h = harness();
    const error = new Error("boom");
    const out = await runBusy(
      h.deps,
      navTask(h, {
        write: async () => {
          throw error;
        },
      }),
    );
    expect(out).toEqual({ kind: "failed", error });
    expect(h.calls).not.toContain("releaseGuard");
    expect(h.calls).not.toContain("navigate");
  });

  it("navigate: a timed out navigation restores the guard release", async () => {
    const h = harness();
    h.wait.next = async () => {
      expect(h.calls).not.toContain("restoreGuard"); // 待っている間は外したまま
      return "timedOut";
    };
    await runBusy(h.deps, navTask(h));
    expect(h.calls.filter((c) => c === "restoreGuard")).toHaveLength(1);
    expect(steps(h).at(-1)).toBe("restoreGuard");
  });

  it("custom: waits for the custom step and keeps 300 ms", async () => {
    const h = harness();
    const out = await runBusy(h.deps, {
      write: async () => {
        h.calls.push("write");
        return 1;
      },
      after: "custom",
      custom: async (v, signal) => {
        expect(v).toBe(1);
        expect(signal.aborted).toBe(false);
        h.calls.push("custom");
        h.clock.t += 100;
      },
    });
    expect(out).toEqual({ kind: "saved", value: 1, refresh: "done" });
    expect(steps(h)).toEqual(["showOverlay", "write", "noteWriteSucceeded", "custom"]);
    expect(h.sleeps).toEqual([BUSY_MIN_MS - 100]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("custom: a custom failure still returns saved", async () => {
    const h = harness();
    const out = await runBusy(h.deps, {
      write: async () => 1,
      after: "custom",
      custom: async () => {
        throw new Error("reload failed");
      },
    });
    expect(out).toEqual({ kind: "saved", value: 1, refresh: "timeout" });
    expect(h.calls).not.toContain("refresh");
  });

  it("custom: a reload that never settles is cut at 10 s", async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    let settled = false;
    const p = runBusy(h.deps, {
      write: async () => 1,
      after: "custom",
      custom: (_v, s) => {
        signal = s;
        return new Promise<void>(() => {}); // 中の GET が解決しない
      },
    }).then((o) => {
      settled = true;
      return o;
    });
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ kind: "saved", value: 1, refresh: "timeout" });
    expect(signal?.aborted).toBe(true);
    // 覆いと実行権が戻る(runBusy が返る = 呼び出し側が外す)。次の書き込みも走る
    expect(await runBusy(h.deps, { write: async () => 2, after: "none" })).toMatchObject({ kind: "saved", value: 2 });
  });

  it("alive: a scope gone during confirm starts nothing", async () => {
    const h = harness();
    const write = vi.fn(async () => 1);
    const out = await runBusy(h.deps, {
      confirm: async () => {
        h.calls.push("confirm");
        h.alive.value = false; // 事前の GET の間に範囲が消えた
        return true;
      },
      write,
      onWritten: () => void h.calls.push("onWritten"),
      after: "navigate",
      navigate: () => {
        h.calls.push("navigate");
        return { kind: "none" };
      },
    });
    expect(out).toEqual({ kind: "discarded" });
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["confirm"]);
  });

  it("alive: a scope gone during the write does not navigate or refresh", async () => {
    for (const after of ["navigate", "refresh", "custom"] as const) {
      const h = harness();
      const out = await runBusy(h.deps, {
        write: async () => {
          h.calls.push("write");
          h.alive.value = false; // 守りを素通りした戻る(navStartedAfter は false のまま)
          return 1;
        },
        onWritten: () => void h.calls.push("onWritten"),
        after,
        navigate: () => {
          h.calls.push("navigate");
          return { kind: "none" };
        },
        custom: async () => void h.calls.push("custom"),
      });
      expect(out).toEqual({ kind: "discarded" });
      expect(steps(h)).toEqual(["showOverlay", "write"]);
    }
  });

  it("alive: checked before onWritten and before the after step", async () => {
    // alive の呼び出しの順: 1 = confirm の後、2 = 書き込みの後、3 = onWritten の前、4 = 後の処理の前
    const cases: { dieAt: number; after: "navigate" | "refresh" | "custom"; expected: string[] }[] = [
      { dieAt: 3, after: "navigate", expected: ["showOverlay", "write"] },
      { dieAt: 4, after: "navigate", expected: ["showOverlay", "write", "onWritten", "noteWriteSucceeded"] },
      { dieAt: 4, after: "refresh", expected: ["showOverlay", "write", "onWritten", "noteWriteSucceeded"] },
      { dieAt: 4, after: "custom", expected: ["showOverlay", "write", "onWritten", "noteWriteSucceeded"] },
    ];
    for (const c of cases) {
      const h = harness();
      h.alive.value = (n) => n < c.dieAt;
      const out = await runBusy(h.deps, {
        write: async () => {
          h.calls.push("write");
          return 1;
        },
        onWritten: () => void h.calls.push("onWritten"),
        after: c.after,
        navigate: () => {
          h.calls.push("navigate");
          return { kind: "none" };
        },
        custom: async () => void h.calls.push("custom"),
      });
      expect(out).toEqual({ kind: "discarded" });
      expect(steps(h)).toEqual(c.expected);
    }
  });

  // 最終レビュー I1: 30 秒の時間切れでも、範囲が消えた・別の遷移が始まったなら unknown にしない(呼び出し側の取り直しを始めさせない)
  it("alive: a scope gone during a write that times out returns discarded, not unknown", async () => {
    const h = harness();
    const p = runBusy(h.deps, {
      write: () => {
        h.alive.value = false; // 守りを素通りした戻る(navStartedAfter は false のまま)
        return new Promise<never>(() => {});
      },
      after: "custom",
      custom: async () => void h.calls.push("custom"),
    });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(await p).toEqual({ kind: "discarded" });
    expect(h.calls).not.toContain("custom");
  });

  it("a navigation started during a write that times out returns discarded, not unknown", async () => {
    const h = harness();
    const p = runBusy(h.deps, {
      write: () => {
        h.nav.started = true;
        return new Promise<never>(() => {});
      },
      after: "refresh",
    });
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
    expect(await p).toEqual({ kind: "discarded" });
  });

  it("alive: a scope gone during the refresh, the custom step or the 300 ms wait returns discarded", async () => {
    // refresh の後
    {
      const h: Harness = harness({
        refresh: async () => {
          h.alive.value = false;
          return "done";
        },
      });
      expect(await runBusy(h.deps, { write: async () => 1, after: "refresh" })).toEqual({ kind: "discarded" });
      expect(h.sleeps).toEqual([]);
    }
    // custom の後
    {
      const h = harness();
      const out = await runBusy(h.deps, {
        write: async () => 1,
        after: "custom",
        custom: async () => {
          h.alive.value = false;
        },
      });
      expect(out).toEqual({ kind: "discarded" });
      expect(h.sleeps).toEqual([]);
    }
    // 300 ms の待ちの後(none・refresh・custom とも)
    for (const after of ["none", "refresh", "custom"] as const) {
      const h = harness();
      h.deps.sleep = async (ms) => {
        h.sleeps.push(ms);
        h.alive.value = false;
      };
      const out = await runBusy(h.deps, { write: async () => 1, after, custom: async () => {} });
      expect(out).toEqual({ kind: "discarded" });
      expect(h.sleeps).toEqual([BUSY_MIN_MS]);
    }
  });

  it("after as a function picks one step from the value", async () => {
    for (const go of [true, false]) {
      const h = harness();
      h.wait.next = async () => "timedOut";
      const after = vi.fn((v: { go: boolean }) => (v.go ? ("navigate" as const) : ("refresh" as const)));
      const out = await runBusy(h.deps, {
        write: async () => ({ go }),
        after,
        navigate: () => {
          h.calls.push("navigate");
          return { kind: "app", seq: 9 };
        },
      });
      expect(after).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledWith({ go });
      expect(h.calls.filter((c) => c === "navigate")).toHaveLength(go ? 1 : 0);
      expect(h.calls.filter((c) => c === "refresh")).toHaveLength(go ? 0 : 1);
      expect(out.kind).toBe(go ? "navigated" : "saved");
    }
    // 失敗のときは呼ばれない
    const h = harness();
    const after = vi.fn(() => "navigate" as const);
    await runBusy(h.deps, {
      write: async () => {
        throw new Error("boom");
      },
      after,
      navigate: () => ({ kind: "none" }),
    });
    expect(after).not.toHaveBeenCalled();
  });
});

describe("claimRun / releaseRun", () => {
  it("a second run while the first holds the run right (including during confirm) is ignored", () => {
    const ref = { current: false };
    expect(claimRun(ref)).toBe(true);
    expect(claimRun(ref)).toBe(false);
    releaseRun(ref);
    expect(claimRun(ref)).toBe(true);
  });
});
