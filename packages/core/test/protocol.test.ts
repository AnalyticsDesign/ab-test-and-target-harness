import { describe, it, expect } from "vitest";
import { EventBodySchema } from "../src/protocol";
import { GoalSchema } from "../src/schema";

describe("EventBodySchema (spec §9.2)", () => {
  it("goal と forget の 2 種を受け、visitorId は optional(Mode A の必須検証は edge が行う)", () => {
    expect(EventBodySchema.safeParse({ type: "goal", goalId: "g_lead", visitorId: "x" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "goal", goalId: "g_lead" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "forget", visitorId: "x" }).success).toBe(true);
  });
  it("未知の type・余分なキー・空の goalId は拒否(strict)", () => {
    expect(EventBodySchema.safeParse({ type: "pageview", goalId: "g" }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "goal", goalId: "g_lead", extra: 1 }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "goal", goalId: "" }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "forget", goalId: "g_lead" }).success).toBe(false);
  });
  it("GoalSchema を通る ID は /event でも受理される(producer / consumer の契約。r1 CX-Medium-1)", () => {
    for (const id of ["g_lead", "purchase.completed", "a".repeat(65), "a".repeat(201), "constructor", "日本語"]) {
      expect(GoalSchema.safeParse({ id, name: "n", type: "CUSTOM", config: {} }).success).toBe(true);
      expect(EventBodySchema.safeParse({ type: "goal", goalId: id, visitorId: "x" }).success).toBe(true);
    }
  });
});
