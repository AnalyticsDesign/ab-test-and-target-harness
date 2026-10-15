import { describe, expect, it } from "vitest";
import { toChangeWire } from "@/lib/change-wire";
import type { Change } from "@/lib/types";

/**
 * Task 12 review: `ExperimentEditor.save()` was sending the GET-loaded `Change`(`updatedBy` /
 * `updatedAt` 付き)straight to `PUT …/changes`, whose core schema is a `strictObject` per type and
 * rejects unknown keys — every resave of an experiment with pre-existing changes 422'd. Pin the fix's
 * four behaviours directly (no React harness needed).
 */
describe("toChangeWire()", () => {
  it("drops server-set updatedBy / updatedAt", () => {
    const c: Change = { id: "c1", type: "TEXT", selector: ".x", payload: { text: "hi" }, updatedBy: "u1", updatedAt: 123 };
    const wire = toChangeWire(c);
    expect(wire).not.toHaveProperty("updatedBy");
    expect(wire).not.toHaveProperty("updatedAt");
  });

  it("omits selector entirely for CSS (core's ChangeSchema has no selector field on that branch)", () => {
    const c: Change = { id: "c1", type: "CSS", payload: { css: "body{}" } };
    const wire = toChangeWire(c);
    expect(wire).not.toHaveProperty("selector");
    expect(wire).toEqual({ id: "c1", type: "CSS", payload: { css: "body{}" } });
  });

  it("defaults selector to '' for non-CSS types when absent", () => {
    const c: Change = { id: "c1", type: "TEXT", payload: { text: "hi" } };
    const wire = toChangeWire(c);
    expect(wire.selector).toBe("");
  });

  it("passes payload through untouched", () => {
    const payload = { html: "<b>x</b>", position: "replace", runScripts: false };
    const c: Change = { id: "c1", type: "HTML", selector: ".x", payload };
    const wire = toChangeWire(c);
    expect(wire.payload).toBe(payload); // 同一参照(コピーもせず素通し)
  });
});
