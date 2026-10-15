import { describe, expect, it } from "vitest";
import { STATUS_FILTERS, countByFilter, filterExperiments } from "@/lib/experiment-filter";
import type { Experiment } from "@/lib/types";

const exp = (id: string, status: Experiment["status"]) => ({ id, status }) as Experiment;
const LIST = [exp("a", "running"), exp("b", "draft"), exp("c", "running"), exp("d", "archived")];

describe("experiment filter", () => {
  it("offers the designed filters in order", () => {
    expect(STATUS_FILTERS).toEqual(["all", "running", "draft", "paused", "archived"]);
  });
  it("counts every filter, including the empty ones", () => {
    expect(countByFilter(LIST)).toEqual({ all: 4, running: 2, draft: 1, paused: 0, archived: 1 });
  });
  it("filters without reordering", () => {
    expect(filterExperiments(LIST, "all").map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterExperiments(LIST, "running").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterExperiments(LIST, "paused")).toEqual([]);
  });
});
