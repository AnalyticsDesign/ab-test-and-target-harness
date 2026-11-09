import { describe, expect, it } from "vitest";
import { DEFAULT_STATUS_FILTER, STATUS_FILTERS, countByFilter, filterExperiments } from "@/lib/experiment-filter";
import { pickParam } from "@/lib/url-state";
import type { Experiment } from "@/lib/types";

const exp = (id: string, status: Experiment["status"]) => ({ id, status }) as Experiment;
const LIST = [exp("a", "running"), exp("b", "draft"), exp("c", "running"), exp("d", "archived")];

describe("experiment filter", () => {
  it("offers the designed filters in order", () => {
    expect(STATUS_FILTERS).toEqual(["not_archived", "all", "running", "draft", "paused", "archived"]);
  });
  it("counts every filter, including the empty ones", () => {
    expect(countByFilter(LIST)).toEqual({ not_archived: 3, all: 4, running: 2, draft: 1, paused: 0, archived: 1 });
  });
  it("filters without reordering", () => {
    expect(filterExperiments(LIST, "all").map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterExperiments(LIST, "running").map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterExperiments(LIST, "paused")).toEqual([]);
  });
  it("終了以外は下書き・配信中・一時停止を含み、元の順序と配列を保つ", () => {
    const list = [...LIST, exp("e", "paused")];
    const before = [...list];
    expect(filterExperiments(list, "not_archived").map((e) => e.id)).toEqual(["a", "b", "c", "e"]);
    expect(list).toEqual(before);
    const counts = countByFilter(list);
    expect(counts.not_archived).toBe(4);
    expect(counts.not_archived).toBe(counts.all - counts.archived);
    for (const status of ["draft", "running", "paused", "archived"] as const) {
      expect(filterExperiments(list, status)).toEqual(list.filter((e) => e.status === status));
    }
  });
  it.each([{ list: [] }, { list: [exp("ended", "archived")] }, { list: [exp("paused", "paused")] }])("空・終了だけ・一時停止だけの一覧も数える: $list", ({ list }) => {
    const expected = list.filter((e) => e.status !== "archived");
    expect(filterExperiments(list, "not_archived")).toEqual(expected);
    expect(countByFilter(list).not_archived).toBe(expected.length);
  });
  it("URL の既定は終了以外で、明示した all と既存の状態は保つ", () => {
    expect(DEFAULT_STATUS_FILTER).toBe("not_archived");
    for (const value of [undefined, "", "unknown", [], ["unknown", "all"]]) {
      expect(pickParam(value, STATUS_FILTERS, DEFAULT_STATUS_FILTER)).toBe("not_archived");
    }
    for (const value of STATUS_FILTERS) {
      expect(pickParam(value, STATUS_FILTERS, DEFAULT_STATUS_FILTER)).toBe(value);
      expect(pickParam([value, "unknown"], STATUS_FILTERS, DEFAULT_STATUS_FILTER)).toBe(value);
    }
  });
});
