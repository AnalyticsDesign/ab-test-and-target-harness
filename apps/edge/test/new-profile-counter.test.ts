import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { NewProfileBudget } from "@wtt/core";
import {
  NEW_PROFILE_RECHECK_MS,
  NEW_PROFILE_REPORT_EVERY,
  NEW_PROFILE_REPORT_MS,
  NEW_PROFILE_REPORT_TIMEOUT_MS,
  createNewProfileCounter,
  type NewProfileCounter,
  type NewProfileReportResult,
} from "../src/new-profile-counter";

// isolate の数え役(plan12 K9・決定 63 (13)(i) と SDD の着手時の改め (一))。タイマーは使わず、時刻はすべて手で進める。
// 報告(予算の DO への RPC)は手で返す stub か、実物の NewProfileBudget を手で通す stub に差し替える

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0); // 2026-10-19 12:00 UTC
const H1 = Date.UTC(2026, 9, 19, 13); // 次の正時
const MIDNIGHT = Date.UTC(2026, 9, 20); // 次の UTC 0 時
const PAID: NewProfileBudget = { perDay: 100 }; // 1 時間の上限 10。導入全体の予算なし
const FREE: NewProfileBudget = { perDay: 100, instancePerDay: 1000 };
const NULL: NewProfileReportResult = { exhaustedUntil: null };
const until = (t: number): NewProfileReportResult => ({ exhaustedUntil: t });

type Call = {
  dest: "site" | "instance";
  siteId: string;
  hour: string;
  day: string;
  count: number;
  limits: { perHour: number; perDay: number };
  now: number;
  resolve(r: NewProfileReportResult): void;
  reject(e: unknown): void;
  /** 実物の DO を手で通す stub のときだけ: DO に届けて、その応答を返す */
  release?: () => Promise<void>;
};
type Impl = (c: Call) => Promise<NewProfileReportResult> | undefined;

/** macrotask を 1 つ待つ(応答の処理と、続けて出す報告の開始までのマイクロタスクを流す) */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

class Harness {
  t = T0;
  calls: Call[] = [];
  created = 0;
  impl: Impl | undefined;
  readonly counter: NewProfileCounter;
  private readonly waits: Promise<unknown>[] = [];
  constructor(impl?: Impl) {
    this.impl = impl;
    this.counter = createNewProfileCounter({
      now: () => this.t,
      report: (dest, siteId, hour, day, count, limits, now) => {
        let resolve!: (r: NewProfileReportResult) => void;
        let reject!: (e: unknown) => void;
        const p = new Promise<NewProfileReportResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const call: Call = { dest, siteId, hour, day, count, limits, now, resolve, reject };
        this.calls.push(call);
        return this.impl?.(call) ?? p;
      },
    });
  }
  readonly waitUntil = (p: Promise<unknown>): void => {
    this.waits.push(p);
  };
  can(siteId: string, budget: NewProfileBudget): boolean {
    return this.counter.canCreate(siteId, budget, this.t, this.waitUntil);
  }
  record(siteId: string, budget: NewProfileBudget, outcome: "created" | "not_created" | "failed"): void {
    if (outcome === "created") this.created++;
    this.counter.record(siteId, budget, outcome, this.t, this.waitUntil);
  }
  /** edge の流れ: canCreate が true のときだけ作って記録する。作ったら true */
  create(siteId: string, budget: NewProfileBudget): boolean {
    if (!this.can(siteId, budget)) return false;
    this.record(siteId, budget, "created");
    return true;
  }
  of(dest: "site" | "instance"): Call[] {
    return this.calls.filter((c) => c.dest === dest);
  }
  last(dest: "site" | "instance" = "site"): Call {
    const list = this.of(dest);
    return list[list.length - 1]!;
  }
  /** waitUntil に渡った報告(と、その中で続けて出た報告)が終わるまで待つ(手で返す stub では使わない) */
  async drain(): Promise<void> {
    while (this.waits.length > 0) await Promise.allSettled(this.waits.splice(0));
  }
}

/** 実物の予算の DO。テストごとに prefix を変えて状態を分ける(名前の形は本体の site:<id> / instance に prefix を足したもの) */
const realDo = (prefix: string, dest: "site" | "instance", siteId: string) =>
  env.NEW_PROFILE_BUDGET!.get(env.NEW_PROFILE_BUDGET!.idFromName(`${prefix}|${dest === "site" ? `site:${siteId}` : "instance"}`));
/** 実物の DO にすぐ届ける stub */
const autoReal = (prefix: string): Impl => (c) => realDo(prefix, c.dest, c.siteId).report(c.hour, c.day, c.count, c.limits, c.now);
/** 実物の DO に、テストが release を呼んだときに届けて応答を返す stub(往復の間を手で作る) */
const gatedReal = (prefix: string): Impl => (c) =>
  new Promise<NewProfileReportResult>((res, rej) => {
    c.release = async () => {
      try {
        res(await realDo(prefix, c.dest, c.siteId).report(c.hour, c.day, c.count, c.limits, c.now));
      } catch (e) {
        rej(e);
      }
      await settle();
    };
  });
const windows = (prefix: string, dest: "site" | "instance", siteId: string) =>
  runInDurableObject(realDo(prefix, dest, siteId), (_i, state) =>
    Object.fromEntries(state.storage.sql.exec<{ key: string; used: number }>(`SELECT key, used FROM windows`).toArray().map((r) => [r.key, r.used])),
  );

// 報告の失敗は数え役が console.error に 1 行出す(fail-open を無音にしない)。失敗させるテストが多いので、出力を黙らせる
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("定数(plan12 K9)", () => {
  it("報告の間隔・件数・タイムアウトと聞き直しの間隔", () => {
    expect(NEW_PROFILE_REPORT_EVERY).toBe(5);
    expect(NEW_PROFILE_REPORT_MS).toBe(10_000);
    expect(NEW_PROFILE_REPORT_TIMEOUT_MS).toBe(10_000);
    expect(NEW_PROFILE_RECHECK_MS).toBe(60_000);
  });
});

describe("報告を出す条件(plan12 K9)", () => {
  it("first_new_profile_in_an_isolate_is_reported_immediately", () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ dest: "site", siteId: "s1", count: 1, hour: "2026-10-19T12", day: "2026-10-19", limits: { perHour: 10, perDay: 100 }, now: T0 });
    for (let i = 0; i < 4; i++) {
      h.t += 100;
      h.record("s1", PAID, "created"); // 2〜5 件目は報告中なので出さない
    }
    expect(h.calls).toHaveLength(1);
  });

  it("only_one_report_in_flight_per_destination", async () => {
    for (const late of ["success", "failure"] as const) {
      const h = new Harness(); // 報告を返さない stub
      for (let i = 0; i < 100; i++) h.record("s1", FREE, "created");
      expect(h.of("site")).toHaveLength(1);
      expect(h.of("instance")).toHaveLength(1);
      expect(h.of("instance")[0]).toMatchObject({ count: 1, limits: { perHour: 100, perDay: 1000 } });
      // 10 秒を過ぎた後の record で 2 本目(手元にたまった 99 件)
      h.t = T0 + NEW_PROFILE_REPORT_TIMEOUT_MS;
      h.record("s1", FREE, "not_created");
      expect(h.of("site").map((c) => c.count)).toEqual([1, 99]);
      expect(h.of("instance").map((c) => c.count)).toEqual([1, 99]);
      // 1 本目が遅れて成功 / 失敗しても、2 本目の報告中の状態は変わらない(3 本目は出ない)
      for (const c of [h.of("site")[0]!, h.of("instance")[0]!]) late === "success" ? c.resolve(NULL) : c.reject(new Error("late"));
      await settle();
      for (let i = 0; i < 10; i++) h.record("s1", FREE, "created");
      expect(h.of("site")).toHaveLength(2);
      expect(h.of("instance")).toHaveLength(2);
      // 2 本目もタイムアウトした後の 3 本目: 遅れて失敗した 1 本目の 1 件は手元に戻っている。成功した分は戻らない
      h.t = T0 + 2 * NEW_PROFILE_REPORT_TIMEOUT_MS;
      h.record("s1", FREE, "not_created");
      const expected = late === "success" ? 10 : 11;
      expect(h.last("site").count).toBe(expected);
      expect(h.last("instance").count).toBe(expected);
    }
  });

  it("成功の報告の応答の直後に、手元が 5 件以上なら次の record を待たずに続けて出る(5 件未満なら出ない)", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    for (let i = 0; i < 6; i++) h.record("s1", PAID, "created");
    h.calls[0]!.resolve(NULL);
    await settle();
    expect(h.calls.map((c) => c.count)).toEqual([1, 6]);
    for (let i = 0; i < 4; i++) h.record("s1", PAID, "created");
    h.calls[1]!.resolve(NULL);
    await settle();
    expect(h.calls).toHaveLength(2); // 4 件では続けて出さない
  });

  it("rejected_report_does_not_retry_without_another_trigger", async () => {
    for (const failing of ["site", "instance"] as const) {
      const other = failing === "site" ? "instance" : "site";
      const h = new Harness();
      h.record("s1", FREE, "created");
      for (let i = 0; i < 6; i++) h.record("s1", FREE, "created"); // 手元に 6 件
      // ここから、片方の送り先の報告はすぐ throw する。もう片方は返さない
      h.impl = (c) => (c.dest === failing ? Promise.reject(new Error("budget down")) : undefined);
      h.of("site")[0]!.resolve(NULL);
      h.of("instance")[0]!.resolve(NULL);
      await settle();
      expect(h.of(failing).map((c) => c.count)).toEqual([1, 6]); // 続けて出した 2 本目がすぐ失敗
      expect(h.of(other).map((c) => c.count)).toEqual([1, 6]); // 一方の失敗が他方の報告を止めない
      await settle();
      await settle();
      expect(h.of(failing)).toHaveLength(2); // 次の record まで送り直さない
      expect(h.can("s1", FREE)).toBe(true); // 失敗で止めない
      expect(h.of(failing)).toHaveLength(2); // canCreate も報告を出さない(印が無い)
      h.record("s1", FREE, "not_created");
      expect(h.of(failing).map((c) => c.count)).toEqual([1, 6, 6]); // 足し戻した 6 件がそのまま乗る
      expect(h.of(other)).toHaveLength(2); // 他方は報告中のまま
      await settle();
    }
  });

  it("not_created_still_triggers_time_based_report", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    h.calls[0]!.resolve(NULL);
    await settle();
    for (let i = 0; i < 3; i++) h.record("s1", PAID, "created");
    expect(h.calls).toHaveLength(1);
    h.t = T0 + NEW_PROFILE_REPORT_MS - 1;
    h.record("s1", PAID, "not_created");
    expect(h.calls).toHaveLength(1);
    h.t = T0 + NEW_PROFILE_REPORT_MS;
    h.record("s1", PAID, "not_created"); // 既存の訪問者でも、10 秒たった残りが出る
    expect(h.calls.map((c) => c.count)).toEqual([1, 3]);
  });

  it("failed_report_counts_are_kept_for_the_next_report", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    h.calls[0]!.reject(new Error("down"));
    await settle();
    h.t = T0 + 1_000;
    h.record("s1", PAID, "created");
    expect(h.calls).toHaveLength(1); // 失敗の後は続けて出さず、条件(5 件か 10 秒)を待つ
    h.t = T0 + 10_000;
    h.record("s1", PAID, "not_created");
    expect(h.calls.map((c) => c.count)).toEqual([1, 2]); // 失敗した 1 件 + 新しい 1 件
    // タイムアウトの後に遅れて失敗した報告の count も戻る
    h.t = T0 + 20_000;
    h.record("s1", PAID, "created");
    expect(h.calls.map((c) => c.count)).toEqual([1, 2, 1]);
    h.calls[1]!.reject(new Error("late"));
    h.calls[2]!.resolve(NULL);
    await settle();
    h.t = T0 + 30_000;
    h.record("s1", PAID, "not_created");
    expect(h.calls.map((c) => c.count)).toEqual([1, 2, 1, 2]);
    // 遅れて成功した報告の分は戻らない
    h.t = T0 + 40_000;
    h.record("s1", PAID, "created");
    expect(h.calls.map((c) => c.count)).toEqual([1, 2, 1, 2, 1]);
    h.calls[3]!.resolve(NULL);
    h.calls[4]!.resolve(NULL);
    await settle();
    h.t = T0 + 50_000;
    h.record("s1", PAID, "not_created");
    expect(h.calls).toHaveLength(5); // 手元は 0 件

    // DO が足した後に応答だけが失敗した場合は、次の報告で同じ数がもう一度足される(多く数える側)
    const prefix = crypto.randomUUID();
    const h2 = new Harness(async (c) => {
      await realDo(prefix, c.dest, c.siteId).report(c.hour, c.day, c.count, c.limits, c.now);
      throw new Error("response lost");
    });
    h2.record("s1", PAID, "created");
    await h2.drain();
    h2.impl = autoReal(prefix);
    h2.t = T0 + 10_000;
    h2.record("s1", PAID, "not_created");
    await h2.drain();
    expect(h2.calls.map((c) => c.count)).toEqual([1, 1]);
    expect(await windows(prefix, "site", "s1")).toEqual({ "2026-10-19": 2, "2026-10-19T12": 2 });
  });

  it("数え役を作り直すと、前の数え役が報告していない手元の数は戻らない(少なく数える側。spec が許している)", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    h.calls[0]!.resolve(NULL);
    await settle();
    for (let i = 0; i < 3; i++) h.record("s1", PAID, "created"); // 報告していない 3 件
    const next = new Harness(); // isolate の入れ替えの代わり
    next.record("s1", PAID, "created");
    expect(next.calls.map((c) => c.count)).toEqual([1]);
  });

  it("budget_do_unreachable_fails_open", async () => {
    const h = new Harness(() => Promise.reject(new Error("unreachable")));
    for (let i = 0; i < 50; i++) {
      expect(h.create("s1", FREE)).toBe(true);
      h.t += 2_500;
      await settle();
    }
    expect(h.can("s1", FREE)).toBe(true); // 止まりの印は立たない
    expect(h.calls.length).toBeGreaterThan(2);
    expect(errorSpy).toHaveBeenCalled(); // 無音にしない
  });
});

describe("止まりの印と聞き直し(plan12 K9・SDD の着手時の改め (一))", () => {
  it("stop_mark_holds_until_the_window_ends_and_then_clears", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    h.calls[0]!.resolve(until(H1));
    await settle();
    expect(h.can("s1", PAID)).toBe(false);
    // 聞き直しに DO が尽きたと返し続ける間は false
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", PAID)).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ count: 0 });
    h.calls[1]!.resolve(until(H1));
    await settle();
    expect(h.can("s1", PAID)).toBe(false);
    // 後から届いた早い exhaustedUntil で止まりは縮まない
    h.t = T0 + 2 * NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", PAID)).toBe(false);
    h.calls[2]!.resolve(until(T0 + 150_000));
    await settle();
    h.t = T0 + 160_000;
    expect(h.can("s1", PAID)).toBe(false);
    // 聞き直しが throw し続けても、窓の終わりを過ぎれば true に戻る
    h.impl = () => Promise.reject(new Error("down"));
    for (h.t = T0 + 180_000; h.t < H1; h.t += NEW_PROFILE_RECHECK_MS) {
      expect(h.can("s1", PAID)).toBe(false);
      await settle();
    }
    h.t = H1 - 1;
    expect(h.can("s1", PAID)).toBe(false);
    h.t = H1;
    expect(h.can("s1", PAID)).toBe(true);
  });

  it("stopped_isolate_rechecks_once_a_minute_without_creating", async () => {
    const h = new Harness();
    h.record("s1", FREE, "created");
    h.of("site")[0]!.resolve(until(H1));
    h.of("instance")[0]!.resolve(until(H1));
    await settle();
    // 印が効いている間、1 分の間に 1,000 回呼ぶ。聞き直しには DO が尽きたと返す
    let created = 0;
    const start = T0 + NEW_PROFILE_RECHECK_MS;
    for (let i = 0; i < 1000; i++) {
      h.t = start + i * 59;
      if (h.create("s1", FREE)) created++;
      if (i === 0) {
        expect(h.of("site")).toHaveLength(2);
        expect(h.of("instance")).toHaveLength(2);
        h.last("site").resolve(until(H1));
        h.last("instance").resolve(until(H1));
        await settle();
      }
    }
    expect(created).toBe(0); // Profile は作られない
    expect(h.of("site").slice(1).map((c) => c.count)).toEqual([0]); // 送り先ごとに聞き直しは 1 本(件数 0)
    expect(h.of("instance").slice(1).map((c) => c.count)).toEqual([0]);
    // 聞き直しが throw したら、その 1 分後の canCreate でもう 1 本(すぐには出ない)
    h.impl = () => Promise.reject(new Error("down"));
    h.t = start + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", FREE)).toBe(false);
    await settle();
    expect(h.of("site")).toHaveLength(3);
    expect(h.of("instance")).toHaveLength(3);
    const failedAt = h.t;
    for (h.t = failedAt + 1; h.t < failedAt + NEW_PROFILE_RECHECK_MS; h.t += 1_000) expect(h.can("s1", FREE)).toBe(false);
    expect(h.of("site")).toHaveLength(3);
    h.t = failedAt + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", FREE)).toBe(false);
    expect(h.of("site")).toHaveLength(4);
    expect(h.of("instance")).toHaveLength(4);
  });

  it("聞き直しが返らない間も、送り先ごとに 1 分に 1 本を超えない(送るときにも次の聞き直しの時刻を進める)", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    h.calls[0]!.resolve(until(H1));
    await settle();
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", PAID)).toBe(false);
    expect(h.calls).toHaveLength(2); // 聞き直しは返らない
    // 報告のタイムアウト(10 秒)を過ぎても、1 分たつまでは送り直さない
    for (let t = h.t + 1_000; t < T0 + 2 * NEW_PROFILE_RECHECK_MS; t += 1_000) {
      h.t = t;
      expect(h.can("s1", PAID)).toBe(false);
    }
    expect(h.calls).toHaveLength(2);
    h.t = T0 + 2 * NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", PAID)).toBe(false);
    expect(h.calls).toHaveLength(3);
  });

  it("raised_limit_releases_the_stop_mark_on_the_next_recheck", async () => {
    const h = new Harness();
    const low: NewProfileBudget = { perDay: 20_000 };
    const high: NewProfileBudget = { perDay: 100_000 };
    h.record("s1", low, "created");
    h.calls[0]!.resolve(until(MIDNIGHT));
    await settle();
    h.t = T0 + NEW_PROFILE_RECHECK_MS - 1;
    expect(h.can("s1", high)).toBe(false); // recheckAt までは false のまま、報告も出ない
    expect(h.calls).toHaveLength(1);
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", high)).toBe(false); // 聞き直しを出した呼び出しも false
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ count: 0, limits: { perHour: 10_000, perDay: 100_000 } }); // 新しい上限で聞き直す
    h.calls[1]!.resolve(NULL);
    await settle();
    expect(h.can("s1", high)).toBe(true);
  });

  it("raised_limit_can_stop_again_on_the_hourly_budget", async () => {
    const prefix = crypto.randomUUID();
    const h = new Harness(autoReal(prefix));
    const one: NewProfileBudget = { perDay: 1 };
    const hundred: NewProfileBudget = { perDay: 100 }; // 1 時間の上限 10
    expect(h.create("s1", one)).toBe(true);
    await h.drain();
    expect(h.can("s1", one)).toBe(false); // 日の予算が尽きて印が立つ
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", hundred)).toBe(false); // 上げた後の聞き直し
    await h.drain();
    expect(h.can("s1", hundred)).toBe(true); // 聞き直しで外れる
    let more = 0;
    while (h.create("s1", hundred)) {
      more++;
      await h.drain();
      if (more > 50) throw new Error("did not stop");
    }
    expect(h.calls.map((c) => c.count)).toEqual([1, 0, 5, 5]); // 1 時間の上限 10 を超えた報告で止まる
    expect(more).toBe(10);
    expect(h.can("s1", hundred)).toBe(false);
    h.t = H1;
    expect(h.can("s1", hundred)).toBe(true); // 次の正時まで
  });

  it("stale_null_response_does_not_clear_a_newer_mark", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created"); // 報告 A
    h.t = T0 + NEW_PROFILE_REPORT_TIMEOUT_MS;
    h.record("s1", PAID, "created"); // A はタイムアウト → 報告 B
    const [a, b] = h.calls;
    b!.resolve(until(H1));
    await settle();
    expect(h.can("s1", PAID)).toBe(false);
    a!.resolve(NULL); // A を始めた時刻は印を立てた時刻より前
    await settle();
    expect(h.can("s1", PAID)).toBe(false);
    // 印を立てた後に始めた聞き直しの null は外す
    h.t = T0 + NEW_PROFILE_REPORT_TIMEOUT_MS + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", PAID)).toBe(false);
    h.last().resolve(NULL);
    await settle();
    expect(h.can("s1", PAID)).toBe(true);
    // 上げる前の上限で出た報告の遅い応答で印が立っても、次の聞き直しで DO が null を返せば外れる
    const raised: NewProfileBudget = { perDay: 1000 };
    h.t += NEW_PROFILE_REPORT_MS;
    h.record("s1", PAID, "created"); // 報告 C(上げる前の上限)
    const c = h.last();
    expect(c.limits).toEqual({ perHour: 10, perDay: 100 });
    h.t += 5_000;
    c.resolve(until(H1));
    await settle();
    expect(h.can("s1", raised)).toBe(false);
    h.t += NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", raised)).toBe(false);
    expect(h.last()).toMatchObject({ count: 0, limits: { perHour: 100, perDay: 1000 } });
    h.last().resolve(NULL);
    await settle();
    expect(h.can("s1", raised)).toBe(true);
  });

  it("印を伸ばした応答より前に始めた報告の遅い null では、伸ばした印を外さない", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created"); // 報告 A
    h.calls[0]!.resolve(until(H1)); // 印を立てる(立てた時刻 = T0)
    await settle();
    expect(h.can("s1", PAID)).toBe(false);
    // 上限を上げた後の聞き直し B(印を立てた後に始めた)。B は返らずタイムアウトする
    const raised: NewProfileBudget = { perDay: 1000 };
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", raised)).toBe(false);
    const b = h.last();
    // 次の聞き直し C は尽きたを返し、効いている印を伸ばす
    h.t += NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", raised)).toBe(false);
    const c = h.last();
    expect(c).not.toBe(b);
    c.resolve(until(MIDNIGHT));
    await settle();
    // B の遅い null は C より前に始めた報告の応答なので、DO がいま尽きたと言っている印を外さない
    b.resolve(NULL);
    await settle();
    expect(h.can("s1", raised)).toBe(false);
    // C の後に始めた聞き直しの null は外す
    h.t += NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", raised)).toBe(false);
    h.last().resolve(NULL);
    await settle();
    expect(h.can("s1", raised)).toBe(true);
  });

  it("lowered_limit_is_judged_by_the_budget_do", async () => {
    const prefix = crypto.randomUUID();
    // その日の前の時間帯に 55 件(日の数はすでに 50 以上)
    await realDo(prefix, "site", "s1").report("2026-10-19T11", "2026-10-19", 55, { perHour: 1000, perDay: 1000 }, T0 - 3_600_000);
    const h = new Harness(autoReal(prefix));
    const hundred: NewProfileBudget = { perDay: 100 };
    const fifty: NewProfileBudget = { perDay: 50 };
    while (h.create("s1", hundred)) await h.drain();
    expect(h.calls.map((c) => c.count)).toEqual([1, 5, 5]); // 1 時間の上限 10 で止まる(日は 66 < 100)
    expect(h.can("s1", hundred)).toBe(false);
    // 印が効いている間に 50 に下げる → 聞き直しで DO が翌日 0 時を返し、印が翌日 0 時まで伸びる
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s1", fifty)).toBe(false);
    await h.drain();
    expect(h.last()).toMatchObject({ count: 0, limits: { perHour: 5, perDay: 50 } });
    h.impl = () => Promise.reject(new Error("down")); // 以後の聞き直しは届かない = 印の終わりだけで決まる
    h.t = H1 + 1;
    expect(h.can("s1", fifty)).toBe(false); // 次の正時を過ぎても止まったまま
    h.t = MIDNIGHT;
    expect(h.can("s1", fifty)).toBe(true);

    // 止まっていないときに下げると、次の報告で止まる
    await realDo(prefix, "site", "s2").report("2026-10-19T11", "2026-10-19", 30, { perHour: 1000, perDay: 1000 }, T0 - 3_600_000);
    const h2 = new Harness(autoReal(prefix));
    expect(h2.create("s2", hundred)).toBe(true);
    await h2.drain();
    expect(h2.can("s2", hundred)).toBe(true); // 日は 31 < 100
    const twenty: NewProfileBudget = { perDay: 20 };
    h2.t = T0 + NEW_PROFILE_REPORT_MS;
    expect(h2.create("s2", twenty)).toBe(true);
    await h2.drain();
    expect(h2.last()).toMatchObject({ count: 1, limits: { perHour: 2, perDay: 20 } });
    expect(h2.can("s2", twenty)).toBe(false);
  });

  it("leftover_after_stop_is_reported_in_the_same_window", async () => {
    const h = new Harness();
    h.record("s1", PAID, "created");
    for (let i = 0; i < 7; i++) h.record("s1", PAID, "created");
    h.t = T0 + 500;
    h.calls[0]!.resolve(until(H1));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ count: 7, hour: "2026-10-19T12", day: "2026-10-19" });
    expect(h.can("s1", PAID)).toBe(false);
  });

  it("report_response_crossing_hour_boundary_uses_the_documented_window", async () => {
    const cases = [
      { boundary: H1, before: ["2026-10-19T12", "2026-10-19"], after: ["2026-10-19T13", "2026-10-19"] },
      { boundary: MIDNIGHT, before: ["2026-10-19T23", "2026-10-19"], after: ["2026-10-20T00", "2026-10-20"] }, // UTC の日の境目
    ];
    for (const { boundary, before, after } of cases) {
      const h = new Harness();
      h.t = boundary - 50;
      h.record("s1", PAID, "created");
      for (let i = 0; i < 20; i++) {
        h.t = boundary - 40 + i;
        h.record("s1", PAID, "created");
      }
      h.t = boundary + 1;
      h.calls[0]!.resolve(NULL);
      await settle();
      expect(h.calls.map((c) => [c.count, c.hour, c.day])).toEqual([
        [1, ...before],
        [20, ...after], // 時と日の鍵は報告を出した時刻で決める
      ]);
    }
  });

  it("free_instance_budget_caps_all_sites", async () => {
    const h = new Harness();
    const free2: NewProfileBudget = { perDay: 100, instancePerDay: 1000 };
    h.record("s1", FREE, "created");
    h.of("site")[0]!.resolve(NULL);
    h.of("instance")[0]!.resolve(until(MIDNIGHT)); // 導入全体の DO が尽きた
    await settle();
    expect(h.can("s1", FREE)).toBe(false);
    expect(h.can("s2", free2)).toBe(false); // まだ尽きていないサイトでも止まる
    // 同じ数え役のまま、s2 を Paid(instancePerDay なし)に変えると、自分の予算が残っていれば作れる
    const paid2: NewProfileBudget = { perDay: 100 };
    expect(h.can("s2", paid2)).toBe(true);
    const before = h.of("instance").length;
    h.record("s2", paid2, "created");
    expect(h.last("site")).toMatchObject({ siteId: "s2", count: 1 });
    // Paid のサイトは導入全体の DO に報告しない(聞き直しも出さない)
    h.t = T0 + NEW_PROFILE_RECHECK_MS;
    expect(h.can("s2", paid2)).toBe(true);
    for (let i = 0; i < 10; i++) h.record("s2", paid2, "created");
    expect(h.of("instance")).toHaveLength(before);
  });
});

describe("超えうる量(plan12 K9 の式。実物の NewProfileBudget に手で通す)", () => {
  it("creations_during_a_report_round_trip_are_bounded_by_the_next_report", async () => {
    const prefix = crypto.randomUUID();
    const h = new Harness(gatedReal(prefix));
    const budget: NewProfileBudget = { perDay: 100 }; // 1 時間の上限 10
    expect(h.create("s1", budget)).toBe(true);
    for (let i = 0; i < 20; i++) expect(h.create("s1", budget)).toBe(true); // 1 本目の往復の間
    expect(h.calls.map((c) => c.count)).toEqual([1]);
    await h.calls[0]!.release!(); // 尽きずに返る → 直後に 2 本目
    expect(h.calls.map((c) => c.count)).toEqual([1, 20]);
    for (let i = 0; i < 20; i++) expect(h.create("s1", budget)).toBe(true); // 2 本目の往復の間
    const held = [0, 1, 2].map(() => h.can("s1", budget)); // 止まる前に allowCreate: true で呼んだ 3 件(Profile の呼び出し中)
    expect(held).toEqual([true, true, true]);
    expect(h.calls).toHaveLength(2); // 2 本目が返るまで 3 本目は出ない
    await h.calls[1]!.release!(); // 尽きたと返る → 直後に残りの 20 件を同じ窓で
    expect(h.calls.map((c) => [c.count, c.hour])).toEqual([[1, "2026-10-19T12"], [20, "2026-10-19T12"], [20, "2026-10-19T12"]]);
    expect(h.can("s1", budget)).toBe(false);
    expect(h.created).toBe(41); // 1 + 20 + 20(K9 の式では 10 + 5 + 20 + 20 = 55 の範囲)
    expect(h.created).toBeLessThanOrEqual(10 + 5 + 20 + 20);
    // 止まった後に終わった 3 件も、同じ窓のうちに報告される
    for (let i = 0; i < 3; i++) h.record("s1", budget, "created");
    expect(h.calls).toHaveLength(3);
    await h.calls[2]!.release!();
    expect(h.calls.map((c) => c.count)).toEqual([1, 20, 20, 3]);
    expect(h.calls[3]!.hour).toBe("2026-10-19T12");
    await h.calls[3]!.release!();
    expect(h.created).toBe(44);
    expect(await windows(prefix, "site", "s1")).toEqual({ "2026-10-19": 44, "2026-10-19T12": 44 });
  });

  it("batch_threshold_overshoot_without_round_trip_creations", async () => {
    const prefix = crypto.randomUUID();
    const h = new Harness(gatedReal(prefix));
    const budget: NewProfileBudget = { perDay: 115 }; // 1 時間の上限 12
    while (h.create("s1", budget)) {
      const before = h.calls.length;
      // 各報告の応答を次の記録の前に返す(往復の間に作られる分は 0)
      for (let i = 0; i < h.calls.length; i++) if (h.calls[i]!.release && !("done" in h.calls[i]!)) {
        Object.assign(h.calls[i]!, { done: true });
        await h.calls[i]!.release!();
      }
      expect(h.calls.length).toBe(before);
      if (h.created > 100) throw new Error("did not stop");
    }
    expect(h.calls.map((c) => c.count)).toEqual([1, 5, 5, 5]); // 4 本目が尽きたと返る
    expect(h.created).toBe(16);
    expect(h.created).toBeLessThanOrEqual(12 + 5); // K9 の式
    expect(h.can("s1", budget)).toBe(false);
  });

  it("two_isolates_overshoot_is_bounded_per_isolate", async () => {
    const prefix = crypto.randomUUID();
    const a = new Harness(gatedReal(prefix));
    const b = new Harness(gatedReal(prefix)); // 同じ予算の DO に報告する別の isolate
    const budget: NewProfileBudget = { perDay: 125 }; // 1 時間の上限 13
    const createAndFlush = async (h: Harness, n: number) => {
      for (let i = 0; i < n; i++) expect(h.create("s1", budget)).toBe(true);
      for (const c of h.calls) if (!("done" in c)) {
        Object.assign(c, { done: true });
        await c.release!();
      }
    };
    await createAndFlush(a, 1); // DO 1
    await createAndFlush(b, 1); // DO 2
    await createAndFlush(a, 5); // DO 7
    await createAndFlush(b, 5); // DO 12 = 上限 − 1
    expect(await windows(prefix, "site", "s1")).toEqual({ "2026-10-19": 12, "2026-10-19T12": 12 });
    await createAndFlush(a, 4); // 両方の手元に 4 件ずつ(報告しない)
    await createAndFlush(b, 4);
    expect([a.calls.length, b.calls.length]).toEqual([2, 2]);
    await createAndFlush(a, 1); // 5 件目で報告 → 尽きた
    await createAndFlush(b, 1); // b は a の結果を知らずに 5 件目で報告 → 尽きた
    expect(a.calls.map((c) => c.count)).toEqual([1, 5, 5]);
    expect(b.calls.map((c) => c.count)).toEqual([1, 5, 5]);
    expect(a.can("s1", budget)).toBe(false);
    expect(b.can("s1", budget)).toBe(false);
    const total = a.created + b.created;
    expect(total).toBe(13 + 4 + 5); // 上限 + 4 + 5
    expect(total).toBeLessThanOrEqual(13 + 5 * 2); // K9 の式(上限 + isolate ごとに最大 5 件)
  });
});
