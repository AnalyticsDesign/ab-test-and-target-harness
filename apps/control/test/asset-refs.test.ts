import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { ASSET_EXTENSIONS, extractAssetIds, extractManagedAssetUrls, extractUploaderSiteUrls, findEncodedAssetUrls } from "../src/asset-refs";
import { uploaderPublicBase } from "../src/capabilities";
import type { Env } from "../src/env";
import { IMAGE_TYPES } from "../src/routes/assets";

const withEnv = (o: Partial<Env>): Env => ({ ...(env as unknown as Env), ...o }) as Env;
const B = "https://assets.example.com";
const UP = "https://up.example";
const ID = "asset_abc123xyz0";

// B68 plan Task 3 Step 2b / spec §22.3・§22.4
describe("asset-refs", () => {
  it("asset_extensions_follow_the_upload_format_table", () => {
    expect([...ASSET_EXTENSIONS].sort()).toEqual(Object.values(IMAGE_TYPES).map((t) => t.ext).sort());
  });

  it("extract_asset_ids", () => {
    expect(extractAssetIds(`x ${ID} y ${ID} asset_0000000000`)).toEqual([ID, "asset_0000000000"]);
    expect(extractAssetIds(`${B}/sites/s1/images/${ID}.png`)).toEqual([ID]);
    // 境は見ない(Cron の instr と同じ規則): 前後に英数字が続いても、ID の形の 16 字が現れれば返す。9 字以下は当たらない
    expect(extractAssetIds("asset_abc123xyz asset_bg")).toEqual([]);
    expect(extractAssetIds("asset_abc123xyz01")).toEqual(["asset_abc123xyz0"]);
    expect(extractAssetIds("xasset_abc123xyz0")).toEqual([ID]);
    expect(extractAssetIds("asset_backgrounds")).toEqual(["asset_background"]); // 拾いすぎは安全な側の誤り
  });

  it("extract_asset_ids_matches_plain_occurrence_like_instr", () => {
    // 境を付けた規則では [] になっていた出現(レビューの第 1 回の指摘)
    expect(extractAssetIds(`images/${ID}.png`)).toEqual([ID]);
    expect(extractAssetIds(`images%2f${ID}.png`)).toEqual([ID]);
    expect(extractAssetIds(`hero_${ID}.png`)).toEqual([ID]);
  });

  it("extract_managed_urls_three_shapes", () => {
    const text = `<img src="${B}/sites/s1/images/${ID}.png"> url(${B}/sites/s1/experiments/e-1/asset_legacy0001.jpg) ${B}/sites/s1/thumbs/${ID}.webp`;
    expect(extractManagedAssetUrls(text, B)).toEqual([
      { url: `${B}/sites/s1/images/${ID}.png`, siteId: "s1", assetId: ID },
      { url: `${B}/sites/s1/experiments/e-1/asset_legacy0001.jpg`, siteId: "s1", assetId: "asset_legacy0001" },
      { url: `${B}/sites/s1/thumbs/${ID}.webp`, siteId: "s1", assetId: ID },
    ]);
    // 重なりを除く
    expect(extractManagedAssetUrls(`${B}/sites/s1/images/${ID}.png ${B}/sites/s1/images/${ID}.png`, B)).toHaveLength(1);
  });

  it("extract_managed_urls_boundaries", () => {
    const one = (u: string) => extractManagedAssetUrls(u, B).map((x) => x.url);
    for (const ext of ASSET_EXTENSIONS) expect(one(`${B}/sites/s1/images/${ID}.${ext}`)).toEqual([`${B}/sites/s1/images/${ID}.${ext}`]);
    expect(one(`${B}/sites/s1/images/${ID}.pngx`)).toEqual([]); // 拡張子の後ろが英数字
    expect(one(`${B}/sites/s1/images/${ID}.png?v=1`)).toEqual([`${B}/sites/s1/images/${ID}.png`]);
    expect(one(`${B}/sites/s1/images/asset_abc123xyz.png`)).toEqual([]); // 9 字
    expect(one(`${B}/sites/s1/images/asset_abc123xyz01.png`)).toEqual([]); // 11 字
    expect(one(`${B}/sites/s1/thumbs/${ID}.png`)).toEqual([]); // 縮小版は .webp だけ
    expect(one(`${B}/sites/s1/images/${ID}.svg`)).toEqual([]);
    expect(one(`${B}/sites/s1/other/${ID}.png`)).toEqual([]);
  });

  it("extract_managed_urls_ignores_plain_words", () => {
    expect(extractManagedAssetUrls(`.asset_background { } user asset_abc123xyz0 ${ID}`, B)).toEqual([]);
  });

  it("extract_managed_urls_requires_public_base", () => {
    const url = `${B}/sites/s1/images/${ID}.png`;
    expect(extractManagedAssetUrls(url, "https://other.example.com")).toEqual([]);
    expect(extractManagedAssetUrls(`https://ASSETS.example.com/sites/s1/images/${ID}.png`, B)).toEqual([]); // ホスト名の大文字
    expect(extractManagedAssetUrls(url, `${B}/`)).toHaveLength(1); // 末尾の / の有無
    expect(extractManagedAssetUrls(url, "")).toEqual([]);
    // 特殊文字を含む公開ベース(`.` を任意の 1 字として扱わない)
    const dev = "http://localhost:8788/dev-assets";
    expect(extractManagedAssetUrls(`${dev}/sites/s1/images/${ID}.png`, dev)).toHaveLength(1);
    expect(extractManagedAssetUrls(`https://assetsXexample.com/sites/s1/images/${ID}.png`, B)).toEqual([]);
    expect(extractManagedAssetUrls(`https://a.example/x+y/sites/s1/images/${ID}.png`, "https://a.example/x+y")).toHaveLength(1);
  });

  it("extract_managed_urls_other_site_returned_with_site_id", () => {
    expect(extractManagedAssetUrls(`${B}/sites/other_site/images/${ID}.png`, B)).toEqual([
      { url: `${B}/sites/other_site/images/${ID}.png`, siteId: "other_site", assetId: ID },
    ]);
  });

  it("extract_uploader_site_urls_returns_site_id", () => {
    expect(extractUploaderSiteUrls(`${UP}/u/s1/upl_a.png ${UP}/u/s2/upl_b.png ${UP}/u/s1/upl_a.png`, UP)).toEqual([
      { url: `${UP}/u/s1/upl_a.png`, siteId: "s1" },
      { url: `${UP}/u/s2/upl_b.png`, siteId: "s2" },
    ]);
  });

  it("extract_uploader_site_urls_requires_base", () => {
    expect(extractUploaderSiteUrls(`${UP}/u/s1/a.png`, "https://other.example")).toEqual([]);
    expect(extractUploaderSiteUrls(`${UP}/u/s1/a.png`, "")).toEqual([]);
    expect(extractUploaderSiteUrls(`${UP}/u/s1/a.png`, null)).toEqual([]);
    expect(extractUploaderSiteUrls(`${UP}/u/s1/a.png`, `${UP}/`)).toEqual([{ url: `${UP}/u/s1/a.png`, siteId: "s1" }]);
    expect(extractUploaderSiteUrls("https://upXexample/u/s1/a.png", UP)).toEqual([]); // `.` を逃がす
  });

  it("extract_uploader_site_urls_inside_html_css_attribute", () => {
    const html = `<img src="${UP}/u/s1/a.png"><div style='background:url(${UP}/u/s2/b.png)'></div>`;
    expect(extractUploaderSiteUrls(html, UP).map((x) => x.siteId)).toEqual(["s1", "s2"]);
    expect(extractUploaderSiteUrls(`url("${UP}/u/s3/c.png")`, UP)).toEqual([{ url: `${UP}/u/s3/c.png`, siteId: "s3" }]);
    expect(extractUploaderSiteUrls(`${UP}/u/s4/d.png`, UP)).toEqual([{ url: `${UP}/u/s4/d.png`, siteId: "s4" }]); // ATTRIBUTE の値
    // config_json の中の HTML(`"` が `\"` になっている)
    const cfg = JSON.stringify({ html: `<img src="${UP}/u/s5/e.png">` });
    expect(extractUploaderSiteUrls(cfg, UP)).toEqual([{ url: `${UP}/u/s5/e.png`, siteId: "s5" }]);
  });

  it("extract_uploader_site_urls_resolves_dot_segments", () => {
    expect(extractUploaderSiteUrls(`${UP}/u/s1/../other/x.png`, UP)).toEqual([{ url: `${UP}/u/s1/../other/x.png`, siteId: "other" }]);
    expect(extractUploaderSiteUrls(`${UP}/u/s1/%2e%2e/other/x.png`, UP)).toEqual([{ url: `${UP}/u/s1/%2e%2e/other/x.png`, siteId: "other" }]);
    expect(extractUploaderSiteUrls(`${UP}/u/other/../s1/x.png`, UP)).toEqual([{ url: `${UP}/u/other/../s1/x.png`, siteId: "s1" }]);
    expect(extractUploaderSiteUrls(`${UP}/u/../x.png`, UP)).toEqual([]); // /u/ の外へ出る
  });

  it("extract_uploader_site_urls_host_case_insensitive", () => {
    expect(extractUploaderSiteUrls("HTTPS://UP.Example/u/s1/a.png", UP)).toEqual([{ url: "HTTPS://UP.Example/u/s1/a.png", siteId: "s1" }]);
  });

  it("extract_uploader_site_urls_ignores_encoded_forms", () => {
    for (const t of [`https:&#47;&#47;up.example&#47;u&#47;s1&#47;a.png`, `https:\\2f \\2f up.example\\2f u\\2f s1\\2f a.png`, `https:%2F%2Fup.example%2Fu%2Fs1%2Fa.png`, `${UP}%2Fu%2Fs1%2Fa.png`])
      expect(extractUploaderSiteUrls(t, UP)).toEqual([]);
  });

  it("uploader_public_base_rules", () => {
    const up = (v: string | undefined) => uploaderPublicBase(withEnv({ AB_UPLOADER_PUBLIC_BASE: v }));
    expect(up("https://up.example")).toBe("https://up.example");
    expect(up("https://up.example/")).toBe("https://up.example");
    expect(up("  https://up.example/  ")).toBe("https://up.example");
    for (const bad of ["http://up.example", "https://u:p@up.example", "https://up.example/?x=1", "https://up.example/#f", "https://up.example/x", "up.example", "none", "", "   ", undefined])
      expect(up(bad), String(bad)).toBeNull();
  });

  it("uploader_public_base_accepts_loopback_http", () => {
    const up = (v: string) => uploaderPublicBase(withEnv({ AB_UPLOADER_PUBLIC_BASE: v }));
    expect(up("http://127.0.0.1:8792")).toBe("http://127.0.0.1:8792");
    expect(up("http://localhost:8792")).toBe("http://localhost:8792");
    expect(up("http://127.0.0.1:8792/")).toBe("http://127.0.0.1:8792");
  });

  it("uploader_public_base_rejects_http_outside_loopback", () => {
    for (const bad of ["http://up.example", "http://127.0.0.2:8792", "http://localhost.example"])
      expect(uploaderPublicBase(withEnv({ AB_UPLOADER_PUBLIC_BASE: bad })), bad).toBeNull();
  });

  it("find_encoded_returns_empty_without_markers", () => {
    expect(findEncodedAssetUrls(`${B}/sites/s1/images/${ID}.png`, B)).toEqual([]);
    expect(findEncodedAssetUrls("plain text", B)).toEqual([]);
  });

  it("find_encoded_detects_html_css_percent", () => {
    const url = `${B}/sites/s1/images/${ID}.png`;
    const cases = [
      url.replaceAll("/", "&#47;"),
      url.replaceAll("/", "&#x2F;"),
      url.replaceAll("/", "&sol;"),
      url.replace("asset_", "&#97;sset_"),
      url.replaceAll("/", "\\2f "),
      url.replace("asset_", "\\61 sset_"),
      url.replace("asset_", "\\61sset_"), // `\61` の後ろに空白が無い形
      url.replaceAll("/", "\\/"),
      url.replaceAll("/", "%2F"),
      url.replace("asset_", "%61sset_"),
    ];
    for (const t of cases) expect(findEncodedAssetUrls(`<img src="${t}">`, B), t).toEqual([url]);
    // 今あるキー・縮小版も
    expect(findEncodedAssetUrls(`${B}/sites/s1/experiments/e1/${ID}.jpg`.replaceAll("/", "&#47;"), B)).toEqual([`${B}/sites/s1/experiments/e1/${ID}.jpg`]);
    expect(findEncodedAssetUrls(`${B}/sites/s1/thumbs/${ID}.webp`.replaceAll("/", "%2f"), B)).toEqual([`${B}/sites/s1/thumbs/${ID}.webp`]);
  });

  it("find_encoded_ignores_urls_present_raw", () => {
    const url = `${B}/sites/s1/images/${ID}.png`;
    expect(findEncodedAssetUrls(`${url} ${url.replaceAll("/", "&#47;")}`, B)).toEqual([]);
    // URL の形でない ID の形の語・% を含む CSS の値
    expect(findEncodedAssetUrls(`&#97;sset_abc123xyz0 .asset_x { width: 50% }`, B)).toEqual([]);
  });
});
