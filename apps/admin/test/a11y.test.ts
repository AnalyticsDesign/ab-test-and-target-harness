import { describe, expect, it } from "vitest";
import { parseDragAlternatives } from "../lib/a11y";

describe("アクセシビリティ設定(ドラッグの代わりにボタンで操作する)", () => {
  it("保存値は '1' のときだけオン。読めない・未設定はオフ(既定)", () => {
    expect(parseDragAlternatives("1")).toBe(true);
    expect(parseDragAlternatives("0")).toBe(false);
    expect(parseDragAlternatives(null)).toBe(false);
    expect(parseDragAlternatives("true")).toBe(false);
  });
});
