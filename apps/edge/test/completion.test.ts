import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { detectBrowser, detectDevice, detectOs, generateVisitorId, parseSiteSettings } from "@wtt/core";
import { COMPLETION_1_CASES, COMPLETION_1_CONFIG, COMPLETION_1_URL, PRICING_URL } from "../../../packages/core/test/fixtures/completion-1";
import { evaluateDecision } from "../src/decision";
import { profileStub } from "../src/profile";
import type { Env } from "../src/env";

describe("完成の基準 1 の edge 半分(runtime 半分は packages/runtime/test/parity.test.ts)", () => {
  it.each(COMPLETION_1_CASES)("completion_criteria_1_targeting_matches_on_edge_and_browser: $name", async (c) => {
    const e = env as unknown as Env;
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_c1", retentionDays: 90 })!;
    const vid = generateVisitorId();
    // runtime が送るのと同じ body(UA の判定は runtime)
    const bodyAt = (url: string) => ({ v: 1, url, referrer: "", device: detectDevice(c.userAgent), browser: detectBrowser(c.userAgent), os: detectOs(c.userAgent), viewport: { w: 390, h: 800 }, firstVisitAt: null });
    // 料金ページの閲覧を、実際の decision で(その時刻の判定として)積む
    for (const t of c.pricingViews) await evaluateDecision(e, "site_c1", settings, COMPLETION_1_CONFIG, bodyAt(PRICING_URL), vid, null, t);
    if (c.leadAt !== null) await profileStub(e, "site_c1", vid).recordGoal("g_lead", 90, Math.floor(c.leadAt / 1000));
    const out = await evaluateDecision(e, "site_c1", settings, COMPLETION_1_CONFIG, bodyAt(COMPLETION_1_URL), vid, null, c.now);
    expect(out!.experiments.map((x) => x.id)).toEqual(c.expected ? ["exp_c1"] : []);
  });
});
