import { expect, it, vi } from "vitest";
import { decideLocally, needsRemoteDecision, requestDecision } from "../src/decision";
import { baseConfig, baseSettings, remoteConfig } from "./fixtures";

const CTX = { url: "https://site.test/pricing", query: {}, device: "desktop" as const, referrer: "" };

it("mode A with needsProfile=false decides locally — no request (spec §7.1)", () => {
  expect(needsRemoteDecision(baseSettings, baseConfig, CTX.url)).toBe(false);
  const out = decideLocally(baseConfig, CTX, "A".repeat(22));
  // 固定した visitor id でハッシュ割り当てが決定的であることをピンニング。
  // @wtt/core の decide() に対する experimentId→id / variantId→variant フィールド割り当て検証も兼ねる
  expect(out).toEqual({ experiments: [{ id: "exp_hero", variant: "vA" }] });
});

it("d-lite always requests remotely — cookie renewal rides the decision (spec §7.1 / §9.6)", () => {
  expect(needsRemoteDecision({ ...baseSettings, mode: "B" }, baseConfig, CTX.url)).toBe(true);
});

it("mode A with needsProfile=true requests when url matches an experiment or a pattern (spec §7.1)", () => {
  expect(needsRemoteDecision(baseSettings, remoteConfig, CTX.url)).toBe(true);
  const noMatch = { ...remoteConfig, experiments: [{ ...remoteConfig.experiments[0]!, urlMatch: { op: "contains" as const, value: "/never" } }], patterns: { p_x: { op: "contains" as const, value: "/pricing" } } };
  expect(needsRemoteDecision(baseSettings, noMatch, CTX.url)).toBe(true);  // patterns 一致でも送る(履歴記録)
  const noneMatch = { ...noMatch, patterns: { p_x: { op: "contains" as const, value: "/never" } } };
  expect(needsRemoteDecision(baseSettings, noneMatch, CTX.url)).toBe(false); // どちらにも一致しなければ送らない
});

/** 実 Response に依存しない最小スタブ(requestDecision が使うのは ok と json() だけ。r1 CL-Medium-4) */
const okRes = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

it("returns parsed experiments for a well-formed response with a matching version (spec §7.5)", async () => {
  const fetchFn = vi.fn(async () => okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }] })) as unknown as typeof fetch;
  const out = await requestDecision(fetchFn, "https://edge.test/v1/sites/site_unit/decision", { v: 3 }, new AbortController().signal, 3);
  expect(out).toEqual({ experiments: [{ id: "exp_hero", variant: "vB" }] });
});

it("mismatched_decision_version_applies_nothing", async () => {
  // spec §7.5 / §9.1: 応答は runtime が要求した version で評価される。version が違う応答は config と混ざるため全体を破棄する(r1 CX-Medium-4)
  const fetchFn = vi.fn(async () => okRes({ v: 2, experiments: [{ id: "exp_hero", variant: "vB" }] })) as unknown as typeof fetch;
  const out = await requestDecision(fetchFn, "https://edge.test/", { v: 3 }, new AbortController().signal, 3);
  expect(out).toBeNull();
});

it("returns null on non-2xx, malformed json, malformed shape, a malformed entry, and abort (spec §10.7)", async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    async () => ({ ok: true, json: async () => { throw new SyntaxError("not json"); } }) as unknown as Response,
    async () => okRes({ v: 3, nope: true }),
    // 配列内に 1 つでも壊れた entry があれば全体を破棄する(部分適用しない)
    async () => okRes({ v: 3, experiments: [{ id: "exp_hero", variant: "vB" }, { id: 42 }] }),
    async () => Promise.reject(new DOMException("aborted", "AbortError")),
  ];
  for (const impl of cases) {
    const out = await requestDecision(vi.fn(impl) as unknown as typeof fetch, "https://x.test/", {}, new AbortController().signal, 3);
    expect(out).toBeNull();
  }
});
