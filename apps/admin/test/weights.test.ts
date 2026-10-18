import { describe, expect, it } from "vitest";
import { evenWeights, isEven, weightsAfterAdd, weightsAfterRemove } from "@/lib/weights";

describe("重みの配分(B77、設計書 Q9・Q10)", () => {
  it("evenWeights: 端数は先頭から 1 ずつ", () => {
    expect(evenWeights(1)).toEqual([100]);
    expect(evenWeights(2)).toEqual([50, 50]);
    expect(evenWeights(3)).toEqual([34, 33, 33]);
    expect(evenWeights(6)).toEqual([17, 17, 17, 17, 16, 16]);
    expect(evenWeights(0)).toEqual([]);
  });
  it("isEven: 「均等に配分」の結果と同じか(並びも含めて)", () => {
    expect(isEven([34, 33, 33])).toBe(true);
    expect(isEven([33, 34, 33])).toBe(false);
    expect(isEven([70, 30])).toBe(false);
  });
  it("evenWeights / 自動の配り直し", () => {
    expect(evenWeights(3)).toEqual([34, 33, 33]);
    expect(weightsAfterAdd([50, 50])).toEqual({ weights: [34, 33, 33], redistributed: true });
    expect(weightsAfterAdd([70, 30])).toEqual({ weights: [70, 30, 0], redistributed: false });
    expect(weightsAfterRemove([34, 33, 33], 2)).toEqual({ weights: [50, 50], redistributed: true });
    expect(weightsAfterRemove([60, 20, 20], 0)).toEqual({ weights: [20, 20], redistributed: false });
  });
  it("最後の 1 つを消しても配り直しとは言わない", () => {
    expect(weightsAfterRemove([100], 0)).toEqual({ weights: [], redistributed: false });
  });
});
