import { describe, it, expect } from "vitest";
import { assetSiteMaxBytes, assetSiteMaxCount, DEFAULT_ASSET_SITE_MAX_MB, DEFAULT_ASSET_SITE_MAX_COUNT } from "../src/body-limits";

describe("site asset limits (B68)", () => {
  it("site_limits_default_on_bad_env", () => { expect(assetSiteMaxBytes("x")).toBe(1024 * 1024 * 1024); expect(assetSiteMaxCount("0")).toBe(1000); });
  it("defaults_are_1024mb_and_1000", () => { expect(DEFAULT_ASSET_SITE_MAX_MB).toBe(1024); expect(DEFAULT_ASSET_SITE_MAX_COUNT).toBe(1000); });
  it("undefined_negative_and_non_finite_fall_back", () => {
    for (const raw of [undefined, "", "-1", "Infinity", "NaN"]) { expect(assetSiteMaxBytes(raw)).toBe(1024 * 1024 * 1024); expect(assetSiteMaxCount(raw)).toBe(1000); }
  });
  it("reads_valid_values", () => { expect(assetSiteMaxBytes("2")).toBe(2 * 1024 * 1024); expect(assetSiteMaxCount("50")).toBe(50); });
  it("count_is_a_whole_number", () => { expect(assetSiteMaxCount("10.7")).toBe(10); expect(assetSiteMaxCount("0.5")).toBe(1000); });
  // Task 1 のレビューの Minor: 切り捨てて 0 以下になる値は既定(assetSiteMaxCount とそろえる)
  it("bytes_fall_back_when_floored_to_zero", () => { expect(assetSiteMaxBytes("0.0000001")).toBe(1024 * 1024 * 1024); });
});
