import { describe, it, expect } from "vitest";
import { assetItemUrls, assetThumbPath, assetUrlPrefix, compactAssetUrls } from "../src/asset-url";

const PREFIX = assetUrlPrefix("https://assets.example.com", "site_abc");

describe("asset url (B68 一覧の URL の組み立て)", () => {
  it("prefix_has_trailing_slash", () => expect(PREFIX).toBe("https://assets.example.com/sites/site_abc/"));
  it("thumb_path_matches_control_thumb_key_shape", () => expect(`sites/site_abc/${assetThumbPath("asset_1")}`).toBe("sites/site_abc/thumbs/asset_1.webp"));

  const cases = [
    { name: "新しい形", publicUrl: `${PREFIX}images/asset_1.png`, thumbnail: "ready", thumbnailUrl: `${PREFIX}thumbs/asset_1.webp` },
    { name: "今ある形(experiments の下)", publicUrl: `${PREFIX}experiments/e1/asset_1.jpg`, thumbnail: "pending", thumbnailUrl: null },
    { name: "公開ベースを変える前の画像", publicUrl: "http://localhost:8788/dev-assets/sites/site_abc/images/asset_1.png", thumbnail: "ready", thumbnailUrl: `${PREFIX}thumbs/asset_1.webp` },
    { name: "ready なのに縮小版のキーが無い", publicUrl: `${PREFIX}images/asset_1.png`, thumbnail: "ready", thumbnailUrl: null },
    { name: "失敗", publicUrl: `${PREFIX}images/asset_1.webp`, thumbnail: "failed", thumbnailUrl: null },
  ] as const;
  for (const c of cases) {
    it(`round_trips_exactly: ${c.name}`, () => {
      const item = { id: "asset_1", thumbnail: c.thumbnail, publicUrl: c.publicUrl, thumbnailUrl: c.thumbnailUrl };
      const compact = compactAssetUrls(PREFIX, item);
      expect(assetItemUrls(PREFIX, { id: "asset_1", thumbnail: c.thumbnail, ...compact })).toEqual({ publicUrl: c.publicUrl, thumbnailUrl: c.thumbnailUrl });
    });
  }

  it("ordinary_item_carries_only_path", () =>
    expect(compactAssetUrls(PREFIX, { id: "asset_1", thumbnail: "ready", publicUrl: `${PREFIX}images/asset_1.png`, thumbnailUrl: `${PREFIX}thumbs/asset_1.webp` })).toEqual({ path: "images/asset_1.png" }));
  it("item_after_base_change_carries_public_url", () =>
    expect(compactAssetUrls(PREFIX, { id: "asset_1", thumbnail: "skipped", publicUrl: "https://old.example.com/sites/site_abc/images/asset_1.png", thumbnailUrl: null })).toEqual({
      publicUrl: "https://old.example.com/sites/site_abc/images/asset_1.png",
    }));
});
