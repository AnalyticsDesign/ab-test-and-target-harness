import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { newProfileBudgetStub, type NewProfileBudget } from "../src/new-profile-budget";

// 新しい Profile の予算の DO(plan12 K9・決定 63 (8))。DO はテストごとに別の名前で作り、状態を共有しない
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 19, 12, 30); // 2026-10-19 12:30 UTC
const hour = "2026-10-19T12";
const day = "2026-10-19";
const fresh = () => env.NEW_PROFILE_BUDGET!.get(env.NEW_PROFILE_BUDGET!.idFromName(crypto.randomUUID()));
const readWindows = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ key: string; used: number }>(`SELECT key, used FROM windows ORDER BY key`).toArray());

describe("NewProfileBudget.report (plan12 K9)", () => {
  it("report は時と日の両方に足し、上限に届かなければ null を返す", async () => {
    const stub = fresh();
    expect(await stub.report(hour, day, 3, { perHour: 10, perDay: 100 }, T0)).toEqual({ exhaustedUntil: null });
    expect(await stub.report(hour, day, 2, { perHour: 10, perDay: 100 }, T0 + 1)).toEqual({ exhaustedUntil: null });
    expect(await readWindows(stub)).toEqual([{ key: day, used: 5 }, { key: hour, used: 5 }]);
  });
  it("時の数が perHour 以上で次の 0 分を返す", async () => {
    const stub = fresh();
    expect(await stub.report(hour, day, 9, { perHour: 10, perDay: 100 }, T0)).toEqual({ exhaustedUntil: null });
    expect(await stub.report(hour, day, 1, { perHour: 10, perDay: 100 }, T0)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 19, 13) });
  });
  it("日の数が perDay 以上で次の UTC 0 時を返す(時が変わっても日が尽きていれば尽きたまま)", async () => {
    const stub = fresh();
    expect(await stub.report(hour, day, 5, { perHour: 10, perDay: 5 }, T0)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 20) });
    // 次の時: 時の数は 0 からだが、日は尽きたまま(件数 0 の聞き直しでも同じ)
    expect(await stub.report("2026-10-19T13", day, 0, { perHour: 10, perDay: 5 }, T0 + HOUR)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 20) });
    // 日の上限を上げれば尽きていない(上限は報告ごとに受け取り、DO は覚えない)
    expect(await stub.report("2026-10-19T13", day, 0, { perHour: 10, perDay: 50 }, T0 + HOUR)).toEqual({ exhaustedUntil: null });
  });
  it("時が変わると時の数は 0 から", async () => {
    const stub = fresh();
    expect(await stub.report(hour, day, 10, { perHour: 10, perDay: 100 }, T0)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 19, 13) });
    expect(await stub.report("2026-10-19T13", day, 9, { perHour: 10, perDay: 100 }, T0 + HOUR)).toEqual({ exhaustedUntil: null });
    expect(await readWindows(stub)).toEqual([{ key: day, used: 19 }, { key: hour, used: 10 }, { key: "2026-10-19T13", used: 9 }]);
  });
  it("件数 0 の聞き直しは足さずに比べるだけ(行も作らない)", async () => {
    const stub = fresh();
    expect(await stub.report(hour, day, 0, { perHour: 1, perDay: 1 }, T0)).toEqual({ exhaustedUntil: null });
    expect(await readWindows(stub)).toEqual([]);
    await stub.report(hour, day, 1, { perHour: 1, perDay: 100 }, T0);
    expect(await stub.report(hour, day, 0, { perHour: 1, perDay: 100 }, T0)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 19, 13) });
    expect(await stub.report(hour, day, 0, { perHour: 2, perDay: 100 }, T0)).toEqual({ exhaustedUntil: null }); // 上げれば外れる
  });
  it("report のたびに 2 日より前の窓の行を消す", async () => {
    const stub = fresh();
    await stub.report("2026-10-16T23", "2026-10-16", 1, { perHour: 10, perDay: 100 }, Date.UTC(2026, 9, 16, 23));
    await stub.report("2026-10-17T00", "2026-10-17", 1, { perHour: 10, perDay: 100 }, Date.UTC(2026, 9, 17, 0));
    await stub.report(hour, day, 1, { perHour: 10, perDay: 100 }, T0); // 2026-10-19 12:30 → 2026-10-17 より前を消す
    expect((await readWindows(stub)).map((r) => r.key)).toEqual(["2026-10-17", "2026-10-17T00", day, hour]);
  });
  it("newProfileBudgetStub はサイトごとの DO と導入全体の DO を名前で分ける", async () => {
    const siteA = newProfileBudgetStub(env, "site", "site_npb_a");
    const siteA2 = env.NEW_PROFILE_BUDGET!.get(env.NEW_PROFILE_BUDGET!.idFromName("site:site_npb_a"));
    await siteA.report(hour, day, 2, { perHour: 10, perDay: 100 }, T0);
    expect(await siteA2.report(hour, day, 0, { perHour: 2, perDay: 100 }, T0)).toEqual({ exhaustedUntil: Date.UTC(2026, 9, 19, 13) });
    const inst = newProfileBudgetStub(env, "instance", "site_npb_a");
    const inst2 = env.NEW_PROFILE_BUDGET!.get(env.NEW_PROFILE_BUDGET!.idFromName("instance"));
    expect(inst.id.toString()).toBe(inst2.id.toString());
    expect(newProfileBudgetStub(env, "instance", "site_other").id.toString()).toBe(inst2.id.toString()); // 導入全体は 1 つ
    expect(() => newProfileBudgetStub({ ...env, NEW_PROFILE_BUDGET: undefined }, "site", "s")).toThrow();
  });
  it("rejects malformed arguments", async () => {
    // RPC 越しの throw は DO 側の未処理の拒否として報告されるので、インスタンスを直接呼んで確かめる(results-budget.test.ts と同じ)
    await runInDurableObject(fresh(), async (instance) => {
      const b = instance as NewProfileBudget;
      const limits = { perHour: 10, perDay: 100 };
      await expect(b.report("2026-10-19 12", day, 1, limits, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, "2026/10/19", 1, limits, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, day, -1, limits, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, day, 1.5, limits, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, day, 1, { perHour: 0, perDay: 100 }, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, day, 1, { perHour: 10, perDay: 0 }, T0)).rejects.toThrow(TypeError);
      await expect(b.report(hour, day, 1, limits, Number.NaN)).rejects.toThrow(TypeError);
    });
  });
});
