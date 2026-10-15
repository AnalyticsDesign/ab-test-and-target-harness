import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index";

describe("smoke", () => {
  it("core is importable", () => {
    expect(CORE_VERSION).toBe("0.0.0");
  });
});
