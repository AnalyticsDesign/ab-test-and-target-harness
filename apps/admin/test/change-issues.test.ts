import { describe, expect, it } from "vitest";
import { emptyHtmlIndex, firstEmptyHtml } from "@/lib/change-issues";
import type { Change, Variant } from "@/lib/types";

const html = (id: string, value: string): Change => ({ id, type: "HTML", selector: "#x", payload: { html: value, position: "replace", runScripts: false } });
const text: Change = { id: "t", type: "TEXT", selector: "#t", payload: { text: "" } };
const variant = (id: string, original: boolean, changes: Change[]): Variant => ({ id, name: id.toUpperCase(), weight: 50, original, description: "", analytics: null, changes });

describe("firstEmptyHtml(B8、B77 K18)", () => {
  it("firstEmptyHtml はオリジナルを見ない", () => {
    expect(firstEmptyHtml([variant("a", true, [html("h0", "")]), variant("b", false, [text, html("h1", "<p>ok</p>"), html("h2", "")])])).toEqual({ variantId: "b", changeIndex: 2 });
  });
  it("空の HTML が無ければ null(TEXT の空は対象外)", () => {
    expect(firstEmptyHtml([variant("a", true, []), variant("b", false, [text, html("h1", "<p>ok</p>")])])).toBeNull();
    expect(firstEmptyHtml([])).toBeNull();
  });
  it("並びの最初のパターン・最初の変更を返す", () => {
    expect(firstEmptyHtml([variant("b", false, [html("h1", "")]), variant("c", false, [html("h2", "")])])).toEqual({ variantId: "b", changeIndex: 0 });
  });
});

describe("emptyHtmlIndex(B8 の印を、利用者がその欄を直したら消す)", () => {
  const vs = [variant("b", false, [text, html("h1", "")])];
  it("まだ空ならその変更の位置を返す(前の変更を消して位置がずれても追う)", () => {
    expect(emptyHtmlIndex(vs, { variantId: "b", changeId: "h1" })).toBe(1);
    expect(emptyHtmlIndex([variant("b", false, [html("h1", "")])], { variantId: "b", changeId: "h1" })).toBe(0);
  });
  it("HTML を入れた・種類を変えた・消した・オリジナルにしたら null", () => {
    expect(emptyHtmlIndex([variant("b", false, [text, html("h1", "<p>x</p>")])], { variantId: "b", changeId: "h1" })).toBeNull();
    expect(emptyHtmlIndex([variant("b", false, [text, { ...text, id: "h1" }])], { variantId: "b", changeId: "h1" })).toBeNull();
    expect(emptyHtmlIndex([variant("b", false, [text])], { variantId: "b", changeId: "h1" })).toBeNull();
    expect(emptyHtmlIndex([variant("b", true, [text, html("h1", "")])], { variantId: "b", changeId: "h1" })).toBeNull();
    expect(emptyHtmlIndex([], { variantId: "b", changeId: "h1" })).toBeNull();
  });
});
