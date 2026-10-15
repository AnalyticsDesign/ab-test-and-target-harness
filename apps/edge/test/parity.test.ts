import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { detectBrowser, detectDevice, detectOs, generateVisitorId, parseSiteSettings } from "@wtt/core";
import { PARITY_CASES, PARITY_CONFIG } from "../../../packages/core/test/fixtures/parity-v2";
import { evaluateDecision } from "../src/decision";
import type { Env } from "../src/env";

describe("同じ入力なら edge とブラウザで同じ判定(決定 49、設計書 §0 の 3)", () => {
  it.each(PARITY_CASES)("new_conditions_match_on_edge_and_browser: $name", async (c) => {
    // runtime が送るのと同じ body(UA の判定は runtime、viewport は meta があるときだけ、firstVisitAt は正本の発行時刻)
    const body = {
      v: 1, url: c.url, referrer: "", device: detectDevice(c.userAgent), browser: detectBrowser(c.userAgent), os: detectOs(c.userAgent),
      ...(c.hasViewportMeta ? { viewport: { w: c.width, h: 800 } } : {}), firstVisitAt: c.firstVisitAt,
    };
    const settings = parseSiteSettings({ settingsVersion: 1, siteId: "site_parity" })!;
    const out = await evaluateDecision(env as unknown as Env, "site_parity", settings, PARITY_CONFIG, body, generateVisitorId(), c.firstVisitAt, c.now);
    expect(out!.experiments.map((e) => e.id)).toEqual(c.expected);
  });
});
