import { describe, expect, it } from "vitest";
import { memberScopeText } from "@/lib/member-scope";

describe("memberScopeText (B60)", () => {
  it("member_scope_text_lists_sites", () => {
    // 0 件: これから作るサイトにも効くことを言う
    expect(memberScopeText([])).toBe("このワークスペースにはまだサイトがありません。ロールは、これから作るサイトにも効きます。");
    // 1 件: 「すべて」とは言わない
    expect(memberScopeText(["A"])).toBe("ロールはこのワークスペースのサイト(A)に効きます。");
    // 2〜5 件: 数と名前を「・」でつなぐ
    expect(memberScopeText(["A", "B"])).toBe("ロールはこのワークスペースの 2 サイト(A・B)すべてに効きます。");
    expect(memberScopeText(["A", "B", "C", "D", "E"])).toBe("ロールはこのワークスペースの 5 サイト(A・B・C・D・E)すべてに効きます。");
    // 6 件以上: 数は全体、名前は先頭 5 件 + 「ほか (全体 - 5) サイト」
    expect(memberScopeText(["A", "B", "C", "D", "E", "F", "G"])).toBe("ロールはこのワークスペースの 7 サイト(A・B・C・D・E ほか 2 サイト)すべてに効きます。");
  });
});
