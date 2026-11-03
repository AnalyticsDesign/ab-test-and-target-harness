import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSY_MIN_MS, WRITE_TIMEOUT_MS } from "@/lib/feedback-store";
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
};

function harness(over: { refresh?: () => Promise<"done" | "timeout"> } = {}): Harness {
  const calls: string[] = [];
  const nav = { started: false };
  const sleeps: number[] = [];
  const clock = { t: 1000 };
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
  };
  return { deps, calls, nav, sleeps, clock };
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

describe("claimRun / releaseRun", () => {
  it("a second run while the first holds the run right (including during confirm) is ignored", () => {
    const ref = { current: false };
    expect(claimRun(ref)).toBe(true);
    expect(claimRun(ref)).toBe(false);
    releaseRun(ref);
    expect(claimRun(ref)).toBe(true);
  });
});
