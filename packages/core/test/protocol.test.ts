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

describe("results events (決定 51、設計書 §6.3)", () => {
  const runId = "AAAAAAAAAAAAAAAAAAAAAA";
  it("accepts participant with device for ok / failed and without device for failed_later / recovered", () => {
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", device: "mobile", applied: "ok" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", device: "tablet", applied: "failed" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", applied: "failed_later" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", applied: "recovered", visitorId: "x" }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", applied: "ok" }).success).toBe(false); // device 必須
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", device: "mobile", applied: "recovered" }).success).toBe(false); // device を持たない
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", device: "mobile", applied: "failed_later" }).success).toBe(false);
  });
  it("rejects a malformed runId and an empty variantId", () => {
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId: "short", variantId: "b", device: "mobile", applied: "ok" }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "", device: "mobile", applied: "ok" }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: ["short"] }).success).toBe(false);
  });
  it("conversion takes 1 to 20 runIds", () => {
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: [runId] }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: Array(20).fill(runId) }).success).toBe(true);
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: [] }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: Array(21).fill(runId) }).success).toBe(false);
  });
  it("rejects unknown version and extra keys", () => {
    expect(EventBodySchema.safeParse({ type: "participant", v: 2, runId, variantId: "b", device: "mobile", applied: "ok" }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "conversion", v: 1, goalId: "g", runIds: [runId], x: 1 }).success).toBe(false);
    expect(EventBodySchema.safeParse({ type: "participant", v: 1, runId, variantId: "b", device: "mobile", applied: "ok", x: 1 }).success).toBe(false);
  });
});
