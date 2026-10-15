import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject, reset } from "cloudflare:test";
import { generateVisitorId, inTraffic, type Experiment, type PageContext } from "@wtt/core";
import { PROFILE_KEY, profileStub, type ProfileDecideInput, type ProfileRecord } from "../src/profile";

const DAY = 86400;
const ctx: PageContext = { url: "https://site.example/pricing", query: {}, device: "desktop", referrer: "" };
const exp = (over: Partial<Experiment> = {}): Experiment => ({
  id: "exp_001", name: "hero", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false,
  variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [] }],
  ...over,
});
const input = (over: Partial<ProfileDecideInput> = {}): ProfileDecideInput => ({
  retentionDays: 90, patternKeys: ["p_pricing"], matchedPatterns: ["p_pricing"], experiments: [exp()], ctx, visitorId: "B".repeat(43), ...over,
});
const nowSec = () => Math.floor(Date.now() / 1000);
const readProfile = (stub: ReturnType<typeof profileStub>) => runInDurableObject(stub, (_i, state) => state.storage.get<ProfileRecord>(PROFILE_KEY));
const seed = (stub: ReturnType<typeof profileStub>, p: ProfileRecord, alarmAtMs: number) =>
  runInDurableObject(stub, async (_i, state) => {
    await state.storage.put(PROFILE_KEY, p);
    await state.storage.setAlarm(alarmAtMs);
  });
// 実測: このワークスペースの workerd は既に過ぎた alarm を setAlarm 直後(次の await の前)に自ら実行してしまうことがある
// (real production と同じ「期限が来たら即実行」の挙動)。そのため seed → runDurableObjectAlarm の間に自動実行が先着し、
// 明示トリガーは false を返す。戻り値ではなく「alarm レコードが seed 時の値から変化した」ことで完了を判定する
const triggerOverdueAlarm = async (stub: ReturnType<typeof profileStub>, seededAlarmMs: number): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    if (await runDurableObjectAlarm(stub)) return;
    const current = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    if (current !== seededAlarmMs) return; // 削除(null)または再設定(新しい期限)で自動実行済み
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeEach(() => reset());

describe("VisitorProfile.decide (spec §7.4 ④ / §8.2)", () => {
  it("現在ページの pages を評価の前に加算し、eligible を返し、firstSeen / lastSeen を刻む", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    const out = await stub.decide(input({ experiments: [exp({ targeting: { hist: "visited", pattern: "p_pricing" } })] }));
    expect(out).toEqual([{ experimentId: "exp_001", variantId: expect.stringMatching(/^v[AB]$/) }]); // 同じページで visited が真(current_page_history_semantics の DO 半分)
    const p = (await readProfile(stub))!;
    expect(p.pages.p_pricing!.count).toBe(1);
    expect(p.firstSeenAt).toBeGreaterThan(nowSec() - 5);
    expect(p.lastSeenAt).toBe(p.firstSeenAt);
    expect(p.retentionDays).toBe(90);
  });
  it("patternKeys に無いキーは掃除する(§8.3: Publish で消えたパターン)", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.decide(input({ patternKeys: ["p_pricing", "p_old"], matchedPatterns: ["p_pricing", "p_old"] }));
    await stub.decide(input({ patternKeys: ["p_pricing"], matchedPatterns: [] }));
    const p = (await readProfile(stub))!;
    expect(Object.keys(p.pages)).toEqual(["p_pricing"]);
    expect(p.pages.p_pricing!.count).toBe(1); // matchedPatterns が空なら加算しない
  });
  it("persistAssignment: 初回の割当を保存し、以後はそれを返す。保存済みの Variant が消えていれば再割当して上書き(§7.3)", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    const e = exp({ persistAssignment: true });
    const first = await stub.decide(input({ experiments: [e] }));
    const p1 = (await readProfile(stub))!;
    expect(p1.assignments.exp_001!.variant).toBe(first[0]!.variantId);
    // 保存済みを差し替えて優先されることを見る(ハッシュとは逆の Variant を置く)
    const other = first[0]!.variantId === "vA" ? "vB" : "vA";
    await runInDurableObject(stub, (_i, state) => state.storage.put(PROFILE_KEY, { ...p1, assignments: { exp_001: { variant: other, at: 1 } } }));
    expect((await stub.decide(input({ experiments: [e] })))[0]!.variantId).toBe(other);
    // 消えた Variant は再割当して上書き
    await runInDurableObject(stub, (_i, state) => state.storage.put(PROFILE_KEY, { ...p1, assignments: { exp_001: { variant: "vGone", at: 1 } } }));
    const re = await stub.decide(input({ experiments: [e] }));
    expect(re[0]!.variantId).toMatch(/^v[AB]$/);
    expect((await readProfile(stub))!.assignments.exp_001!.variant).toBe(re[0]!.variantId);
  });
  it("persistAssignment: false の Experiment は assignments に保存しない", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.decide(input());
    expect((await readProfile(stub))!.assignments).toEqual({});
  });
});

describe("VisitorProfile.recordGoal / forget (spec §9.2)", () => {
  it("goals[goalId].count を加算し lastSeenAt を進める。page_view は数えない", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.recordGoal("g_lead", 90);
    await stub.recordGoal("g_lead", 90);
    const p = (await readProfile(stub))!;
    expect(p.goals.g_lead!.count).toBe(2);
    expect(p.pages).toEqual({});
  });
  it("forget は storage と alarm を消し、冪等", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.decide(input());
    await stub.forget();
    expect(await readProfile(stub)).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    await stub.forget(); // 2 回目も例外にならない
  });
  it("ids named constructor / __proto__ are ordinary keys and never touch the prototype (r1 CX-High-3)", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.recordGoal("constructor", 90);
    await stub.recordGoal("__proto__", 90);
    await stub.recordGoal("constructor", 90);
    const p = (await readProfile(stub))!;
    expect(Object.hasOwn(p.goals, "constructor")).toBe(true);
    expect(p.goals["constructor"]!.count).toBe(2);
    expect(Object.hasOwn(p.goals, "__proto__")).toBe(true);
    expect(p.goals["__proto__"]!.count).toBe(1);
    expect((Object.prototype as unknown as { count?: unknown }).count).toBeUndefined(); // 組み込みを汚していない
    await stub.decide(input({ patternKeys: ["constructor"], matchedPatterns: ["constructor"], experiments: [exp({ id: "__proto__", persistAssignment: true })] }));
    const q = (await readProfile(stub))!;
    expect(q.pages["constructor"]!.count).toBe(1);
    expect(Object.hasOwn(q.assignments, "__proto__")).toBe(true);
    // 再読込後の割当優先(決定 28): traffic を 1% に縮めても保存済み Variant が返る = persisted が自身のキーで core に届いている(r2 CX-High-3)
    let v = generateVisitorId();
    while (inTraffic(v, "__proto__", 1)) v = generateVisitorId();
    const stub2 = profileStub(env, "site_p", v);
    await stub2.decide(input({ visitorId: v, patternKeys: [], matchedPatterns: [], experiments: [exp({ id: "__proto__", persistAssignment: true })] }));
    const first = (await readProfile(stub2))!.assignments["__proto__"]!.variant;
    const again = await stub2.decide(input({ visitorId: v, patternKeys: [], matchedPatterns: [], experiments: [exp({ id: "__proto__", persistAssignment: true, trafficPercentage: 1 })] }));
    expect(again).toEqual([{ experimentId: "__proto__", variantId: first }]);
  });
});

describe("VisitorProfile alarm (spec §8.3、決定 11)", () => {
  it("active_profile_does_not_run_daily_alarm", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    await stub.decide(input({ retentionDays: 30 }));
    const alarm = (await runInDurableObject(stub, (_i, state) => state.storage.getAlarm()))!;
    const expected = (nowSec() + 30 * DAY) * 1000;
    expect(Math.abs(alarm - expected)).toBeLessThan(5000); // 24 時間後ではなく retention 期限
    // 再アクセスで後ろ倒し(lastSeenAt を過去に書き換えてから叩く)
    const p = (await readProfile(stub))!;
    await seed(stub, { ...p, lastSeenAt: p.lastSeenAt - 10 * DAY }, (p.lastSeenAt + 20 * DAY) * 1000);
    await stub.decide(input({ retentionDays: 30 }));
    const alarm2 = (await runInDurableObject(stub, (_i, state) => state.storage.getAlarm()))!;
    expect(Math.abs(alarm2 - expected)).toBeLessThan(5000);
  });
  it("alarm_is_rescheduled_to_retention_deadline", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    const last = nowSec() - 10 * DAY;
    const seededAlarm = Date.now() - 1000;
    await seed(stub, { firstSeenAt: last, lastSeenAt: last, retentionDays: 90, goals: {}, pages: {}, assignments: {} }, seededAlarm);
    await triggerOverdueAlarm(stub, seededAlarm);
    expect(await readProfile(stub)).toBeDefined(); // 削除しない
    const alarm = (await runInDurableObject(stub, (_i, state) => state.storage.getAlarm()))!;
    expect(alarm).toBe((last + 90 * DAY) * 1000);
  });
  it("expired_profile_deletes_storage_once", async () => {
    const stub = profileStub(env, "site_p", "B".repeat(43));
    const last = nowSec() - 100 * DAY;
    const seededAlarm = Date.now() - 1000;
    await seed(stub, { firstSeenAt: last, lastSeenAt: last, retentionDays: 90, goals: {}, pages: {}, assignments: {} }, seededAlarm);
    await triggerOverdueAlarm(stub, seededAlarm);
    expect(await readProfile(stub)).toBeUndefined();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false); // 2 回目は走らない
  });
});
