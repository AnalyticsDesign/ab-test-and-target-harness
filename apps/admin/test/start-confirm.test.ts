import { describe, expect, it } from "vitest";
import { loadStartOverlaps, startConfirmFor } from "@/lib/start-confirm";

const OV = { path: "experiments.t2", message: "「T2」は「T1」と同じ要素(#cta)を変えます。「T1」(先に開始・再開)が優先され、「T2」の効果は薄まって見えます", experimentIds: ["t2", "t1"] };

describe("start confirmation for overlaps (決定 51、設計書 §3.3)", () => {
  it("asks nothing when there is no overlap", () => {
    expect(startConfirmFor([])).toBeNull();
    expect(startConfirmFor(undefined)).toBeNull();
  });
  it("lists the priority sentences when there is an overlap", () => {
    expect(startConfirmFor([OV])).toEqual({ title: "開始しますか?", lead: "同じ要素を変える配信中のエクスペリエンスがあります。", items: [{ key: "t2|t1", message: OV.message }], confirmLabel: "開始する" });
    expect(startConfirmFor([OV], "再開")).toMatchObject({ title: "再開しますか?", confirmLabel: "再開する" });
  });
  it("starts without asking when the preview cannot be read", async () => {
    expect(await loadStartOverlaps(() => Promise.reject(new Error("network")))).toEqual([]);
    expect(await loadStartOverlaps(() => Promise.resolve({ overlaps: [OV] } as never))).toEqual([OV]);
  });
});
