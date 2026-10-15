import { describe, expect, it } from "vitest";
import { insertIndent } from "@/lib/code-textarea";

describe("insertIndent()(Code Change の textarea で Tab をインデントにする。決定 38 (4))", () => {
  it("inserts two spaces at the caret", () => {
    expect(insertIndent("ab", 1, 1)).toEqual({ value: "a  b", cursor: 3 });
  });
  it("replaces a selection", () => {
    expect(insertIndent("abcd", 1, 3)).toEqual({ value: "a  d", cursor: 3 });
  });
  it("works at the ends", () => {
    expect(insertIndent("", 0, 0)).toEqual({ value: "  ", cursor: 2 });
    expect(insertIndent("x", 1, 1)).toEqual({ value: "x  ", cursor: 3 });
  });
});
