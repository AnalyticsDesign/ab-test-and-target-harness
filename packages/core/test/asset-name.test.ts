import { describe, it, expect } from "vitest";
import { cleanAssetName, normalizeAssetName, assetNameKey, assetNameCandidates, pickFreeAssetName, ASSET_NAME_MAX, ASSET_NAME_CANDIDATES_PER_QUERY } from "../src/asset-name";

// 孤立したサロゲート(ペアの途中で切れた形)を探す
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("asset name (B68)", () => {
  it("normalizes_nfc_and_trims", () => expect(normalizeAssetName("  が.png\u0007 ")).toBe("が.png"));
  it("does_not_convert_romaji", () => expect(normalizeAssetName(" ka.png ")).toBe("ka.png")); // NFC はローマ字を仮名にしない
  it("truncates_keeping_extension", () => { const n = normalizeAssetName("a".repeat(120) + ".webp"); expect(n.length).toBe(100); expect(n.endsWith(".webp")).toBe(true); });
  it("keeps_path_separators_and_returns_empty_for_blank", () => {
    expect(normalizeAssetName("a/b\\c.png")).toBe("a/b\\c.png");
    expect(normalizeAssetName(" \u0000\u007f ")).toBe("");
  });
  it("name_key_folds_ascii_only", () => expect(assetNameKey("Banner_Ａ.PNG")).toBe("banner_Ａ.png"));
  it("candidates_without_extension", () => expect(assetNameCandidates("logo", 2, 2)).toEqual(["logo (2)", "logo (3)"]));
  it("candidates_cut_body_per_digit_count", () => {
    const c = assetNameCandidates("a".repeat(96) + ".png", 9, 2); // 9 → 10 で桁が増える境
    expect(c.every((n) => n.length <= 100)).toBe(true);
    expect(c[0]!.endsWith(" (9).png")).toBe(true); expect(c[1]!.endsWith(" (10).png")).toBe(true);
    expect(c[1]!.length).toBe(100); expect(new Set(c).size).toBe(2); // 同じ名前を繰り返さない
  });
  it("candidates_100_char_ascii_and_japanese", () => {
    for (const base of ["x".repeat(96), "画".repeat(96)]) for (const n of assetNameCandidates(base + ".png", 2, 50)) expect(n.length).toBeLessThanOrEqual(100);
  });
  it("candidates_keep_wildcard_chars_literally", () => expect(assetNameCandidates("a%_\\b.png", 2, 1)).toEqual(["a%_\\b (2).png"]));
  it("pick_returns_same_when_free", () => expect(pickFreeAssetName("a.png", new Set())).toBe("a.png"));
  it("pick_adds_smallest_free_number", () => expect(pickFreeAssetName("A.png", new Set(["a.png", "a (2).png"]))).toBe("A (3).png"));
  it("pick_is_not_fooled_by_like_wildcards", () => expect(pickFreeAssetName("a_b.png", new Set(["a_b.png", "axb (2).png"]))).toBe("a_b (2).png"));
  it("pick_returns_null_when_all_candidates_taken", () => {
    const taken = new Set(["a.png", ...assetNameCandidates("a.png", 2, 50).map(assetNameKey)]);
    expect(pickFreeAssetName("a.png", taken)).toBeNull();
  });

  // 追加: 定数・境界・サロゲートペア・続きの 50 個
  it("constants_match_spec", () => { expect(ASSET_NAME_MAX).toBe(100); expect(ASSET_NAME_CANDIDATES_PER_QUERY).toBe(50); });
  it("keeps_name_of_exactly_100_chars", () => { const n = "a".repeat(96) + ".png"; expect(normalizeAssetName(n)).toBe(n); });
  it("truncates_whole_name_when_extension_is_too_long", () => {
    const n = normalizeAssetName("a".repeat(110) + ".verylongext"); // 拡張子が 6 字を超える → 全体を 100 字に切る
    expect(n.length).toBe(100);
  });
  it("truncate_does_not_split_surrogate_pair", () => {
    // 本体 = a×95 + 😀×3(101 字)、拡張子 .png → 本体は 96 字まで。96 字目はペアの前半なので落とす
    const n = normalizeAssetName("a".repeat(95) + "😀😀😀" + ".png");
    expect(n.length).toBeLessThanOrEqual(100);
    expect(n.endsWith(".png")).toBe(true);
    expect(n).not.toMatch(LONE_SURROGATE);
  });
  it("truncate_whole_name_does_not_split_surrogate_pair", () => {
    const n = normalizeAssetName("a".repeat(99) + "😀" + "b".repeat(10)); // 拡張子なし。100 字目がペアの前半
    expect(n).toBe("a".repeat(99));
  });
  it("candidates_do_not_split_surrogate_pair", () => {
    for (const n of assetNameCandidates("😀".repeat(48) + ".png", 2, 50)) {
      expect(n.length).toBeLessThanOrEqual(100);
      expect(n).not.toMatch(LONE_SURROGATE);
    }
  });
  it("pick_continues_from_52", () => {
    const taken = new Set(assetNameCandidates("a.png", 52, 1).map(assetNameKey));
    expect(pickFreeAssetName("a.png", taken, 52)).toBe("a (53).png");
    expect(pickFreeAssetName("a.png", new Set(["a.png"]), 52)).toBe("a (52).png"); // fromN が 2 でなければ元の名前は見ない
  });
  // Task 2(controller の Ruling): PATCH は切らずに整える。空・101 字以上は呼び出し側が 422 にする
  it("clean_normalizes_without_truncating", () => {
    expect(cleanAssetName("  が.png\u0007 ")).toBe("が.png");
    const long = "a".repeat(120) + ".png";
    expect(cleanAssetName(long)).toBe(long);
    expect(cleanAssetName(" \u0001 ")).toBe("");
  });
  // Task 1 のレビューの Minor: 切った本体の末尾の空白を落とす(拡張子が無いときは結果全体)
  it("truncate_drops_trailing_spaces_of_cut_body", () => {
    expect(normalizeAssetName("x".repeat(95) + "   " + "y".repeat(10) + ".png")).toBe("x".repeat(95) + ".png");
    expect(normalizeAssetName("x".repeat(99) + " " + "y".repeat(10))).toBe("x".repeat(99));
  });
  it("normalize_is_idempotent", () => {
    for (const raw of ["x".repeat(99) + " " + "y".repeat(10), "x".repeat(95) + "   " + "y".repeat(10) + ".png", " a.png ", "😀".repeat(60), "a".repeat(120) + ".webp"]) {
      const once = normalizeAssetName(raw);
      expect(normalizeAssetName(once)).toBe(once);
    }
  });
});
