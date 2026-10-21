import { describe, expect, it } from "vitest";
import { audienceMatches } from "@/lib/audience-filter";

// B59: オーディエンスの一覧と、作成画面の「既存のオーディエンスから取り込む」の絞り込みは同じ規則(名前・ID・条件の要約の部分一致)
describe("audienceMatches", () => {
  const a = { id: "aud_pricing", name: "Pricing visitors" };
  const summary = "パスが「/pricing/」で始まるページを 2 回以上閲覧";

  it("空の検索語ならすべて一致", () => {
    expect(audienceMatches(a, summary, "")).toBe(true);
    expect(audienceMatches(a, summary, "   ")).toBe(true);
  });

  it("名前は大文字・小文字を区別せず、前後の空白を無視する", () => {
    expect(audienceMatches(a, summary, "pricing VIS")).toBe(true);
    expect(audienceMatches(a, summary, "  visitors ")).toBe(true);
  });

  it("ID と条件の要約でも一致する", () => {
    expect(audienceMatches(a, summary, "aud_pri")).toBe(true);
    expect(audienceMatches(a, summary, "2 回以上")).toBe(true);
  });

  it("どれにも含まれなければ一致しない", () => {
    expect(audienceMatches(a, summary, "checkout")).toBe(false);
  });
});
