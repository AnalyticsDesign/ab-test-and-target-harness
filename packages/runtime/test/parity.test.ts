import { describe, expect, it } from "vitest";
import { decide, generateVisitorId, type RuntimeSettings } from "@wtt/core";
import { COMPLETION_1_CASES, COMPLETION_1_CONFIG, COMPLETION_1_URL, PRICING_URL, profileFor } from "../../core/test/fixtures/completion-1";
import { PARITY_CASES, PARITY_CONFIG } from "../../core/test/fixtures/parity-v2";
import { collectContext } from "../src/context";
import { decideLocally, needsRemoteDecision } from "../src/decision";

describe("parity の runtime 半分(edge 半分は apps/edge/test/parity.test.ts)", () => {
  it.each(PARITY_CASES)("ブラウザでの判定: $name", (c) => {
    const { ctx } = collectContext({ url: c.url, referrer: "", userAgent: c.userAgent, width: c.width, height: 800, hasViewportMeta: c.hasViewportMeta, now: c.now, firstVisitAt: c.firstVisitAt });
    expect(decideLocally(PARITY_CONFIG, ctx, generateVisitorId())!.experiments.map((e) => e.id)).toEqual(c.expected);
  });
});

describe("完成の基準 1 の runtime 半分(edge 半分は apps/edge/test/completion.test.ts)", () => {
  const modeA = { mode: "A" } as unknown as RuntimeSettings;
  it.each(COMPLETION_1_CASES)("ブラウザで集めた入力と DO と同じ履歴での判定: $name", (c) => {
    // 履歴の条件なので判定は edge に送る。料金ページの閲覧も送って数えてもらう
    expect(needsRemoteDecision(modeA, COMPLETION_1_CONFIG, COMPLETION_1_URL)).toBe(true);
    expect(needsRemoteDecision(modeA, COMPLETION_1_CONFIG, PRICING_URL)).toBe(true);
    const { ctx } = collectContext({ url: COMPLETION_1_URL, referrer: "", userAgent: c.userAgent, width: 390, height: 800, hasViewportMeta: true, now: c.now, firstVisitAt: null });
    expect(decide(COMPLETION_1_CONFIG, ctx, generateVisitorId(), profileFor(c)).map((r) => r.experimentId)).toEqual(c.expected ? ["exp_c1"] : []);
  });
});
