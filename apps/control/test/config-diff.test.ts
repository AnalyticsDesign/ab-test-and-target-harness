import { describe, it, expect } from "vitest";
import { compile, type CompiledConfig } from "@wtt/core";
import { diffCompiledConfigs } from "../src/config-diff";

const config = (): CompiledConfig => compile({
  siteId: "site_diff", siteSalt: "salt", version: 1, timezone: "Asia/Tokyo", goals: [],
  experiments: ["a", "b"].map((id) => ({ id, name: id, trafficPercentage: 100, persistAssignment: false,
    targeting: { hist: "visited", page: { part: "path", op: "startsWith", value: "/seen" } },
    urlMatch: { include: [{ page: { op: "contains", value: "/" } }] },
    variants: [{ id: "a", name: "A", weight: 50, changes: [] }, { id: "b", name: "B", weight: 50, changes: [{ id: "text", type: "TEXT", selector: "h1", payload: { text: "Before" } }] }],
  })),
});

describe("compiled config diff", () => {
  it("same config", () => expect(diffCompiledConfigs(config(), config())).toEqual({ experimentIds: [], siteLevel: false }));
  it("variant changes", () => {
    const next = config(); next.experiments[0]!.variants[1]!.changes[0] = { id: "text", type: "TEXT", selector: "h1", payload: { text: "After" } };
    expect(diffCompiledConfigs(next, config()).experimentIds).toEqual(["a"]);
  });
  it("prehide changes", () => {
    const next = config(); next.prehide.a = ["h2"];
    expect(diffCompiledConfigs(next, config()).experimentIds).toEqual(["a"]);
  });
  it("referenced pattern changes", () => {
    const next = config(); const id = Object.keys(next.patterns)[0]!; next.patterns[id] = { op: "contains", value: "/after" };
    expect(diffCompiledConfigs(next, config()).experimentIds).toEqual(["a", "b"]);
  });
  it("experiments on one side only", () => {
    const next = config(); next.experiments.pop();
    expect(diffCompiledConfigs(next, config()).experimentIds).toEqual(["b"]);
  });
  it("experiment order changes", () => {
    const next = config(); next.experiments.reverse();
    expect(diffCompiledConfigs(next, config()).experimentIds).toEqual(["a", "b"]);
  });
  it("ignores version and results", () => {
    const next = config(); next.version = 9; next.results = { forget: true, runs: { a: "run" } };
    expect(diffCompiledConfigs(next, config())).toEqual({ experimentIds: [], siteLevel: false });
  });
  it("goals change site level", () => {
    const next = config(); next.goals = [{ id: "goal", type: "CUSTOM", config: {} }];
    expect(diffCompiledConfigs(next, config())).toEqual({ experimentIds: [], siteLevel: true });
  });
});
