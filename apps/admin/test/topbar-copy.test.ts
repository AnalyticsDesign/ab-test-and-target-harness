import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar, type PublishState } from "@/components/ui/TopBar";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { COPIED_MS, copyIconName, copyText, type CopiedTimer } from "@/components/ui/CopyButton";

// Crumb(画面名)と版の札は pathname を読み、リンク(AppLink)は先読みのために useRouter を読む。ルーターの外で描くので差し替える
vi.mock("next/navigation", () => ({ usePathname: () => "/w/w1/sites/s1/experiments", useRouter: () => ({ prefetch: () => {} }) }));

/** サイト ID は最長 64 文字。省略表示(CSS の ellipsis)で縮んでも、DOM には全文が残っていることを見る */
const LONG_ID = "s".repeat(32) + "-" + "x".repeat(31);

const publish = (siteId: string): PublishState => ({ href: "/w/w1/sites/s1/publish", activeVersion: 3, hasUnpublished: false, canPublish: true, siteId, historyHref: "/w/w1/sites/s1/history" });

// B140: パンくずの「サイト ID」の印の中にコピーのボタン(アイコンだけ)。押したときの clipboard への書き込みは E2E(invite-flow)で見る(この試験は node 環境で DOM が無いため)
describe("TopBar のサイト ID のコピー", () => {
  it("サイトの中では、サイト ID の印の中にコピーのボタンを出す(CodeBlock と同じ名前の形)", () => {
    expect(LONG_ID).toHaveLength(64);
    const html = renderToStaticMarkup(createElement(TopBar, { crumbs: [{ label: "WS", href: "/w/w1" }, { label: "Site", href: "/w/w1/sites/s1" }], publish: publish(LONG_ID), scope: { wid: "w1", sid: "s1" } }));
    expect(html).toContain(`サイト ID: ${LONG_ID}`);
    // ボタンは印の中(印の文字の後ろ)。アイコンだけなので、名前は title にも出す
    expect(html).toMatch(new RegExp(`<span class="badge mono [^"]*"><span[^>]*>サイト ID: ${LONG_ID}</span><button[^>]*data-testid="topbar-site-id-copy"[^>]*>`));
    expect(html).toContain('aria-label="サイト ID をコピー" title="サイト ID をコピー"');
    // 省略表示で切られうる印の文字は、全文を title でも見せる
    expect(html).toContain(`title="${LONG_ID}">サイト ID: ${LONG_ID}</span>`);
    expect(html).not.toContain("コピー</button>");
    // コピーしたことを読み上げで知らせる status も CodeBlock と同じく付く
    expect(html).toContain('role="status"');
  });

  it("サイトの外(publish が無い画面)では出さない", () => {
    const html = renderToStaticMarkup(createElement(TopBar, { crumbs: [{ label: "WS", href: "/w/w1" }], scope: { wid: "w1", sid: null } }));
    expect(html).not.toContain("topbar-site-id-copy");
    expect(html).not.toContain("サイト ID");
  });
});

// CodeBlock はコピーのボタンを部品(CopyButton)に切り出した後も、描く中身を変えない
describe("CodeBlock", () => {
  it("コードとコピーのボタン・status を描く", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: "<script></script>", label: "導入タグをコピー" }));
    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&lt;script&gt;&lt;/script&gt;");
    expect(html).toMatch(/<button type="button" class="btn" aria-label="導入タグをコピー">/);
    expect(html).toContain("コピー</button>");
    expect(html).toContain('<span role="status" class="visually-hidden"></span>');
  });
});

// 押した後の知らせ: アイコンだけのボタンは、コピーできた 2 秒の間アイコンをチェックの印に替える(押した場所で結果が分かるように)。
// node 環境ではボタンを押せないので、押したときの処理(copyText)と、状態からアイコンを選ぶ関数(copyIconName)を分けて見る。実際のクリックは E2E
describe("CopyButton の押した後の知らせ", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("アイコンだけのときは、コピーした間だけチェックの印。文字付き(CodeBlock)はコピーのアイコンのまま", () => {
    expect(copyIconName(true, false)).toBe("copy");
    expect(copyIconName(true, true)).toBe("check");
    expect(copyIconName(false, true)).toBe("copy");
    expect(copyIconName(false, false)).toBe("copy");
  });

  it("書き込めたらコピーした状態にし、2 秒で戻す", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const setCopied = vi.fn();
    const onUnavailable = vi.fn();
    await copyText("site_long_id", setCopied, { current: null }, onUnavailable);
    expect(writeText).toHaveBeenCalledWith("site_long_id");
    expect(setCopied.mock.calls).toEqual([[true]]);
    expect(COPIED_MS).toBe(2000);
    vi.advanceTimersByTime(1999);
    expect(setCopied.mock.calls).toEqual([[true]]);
    vi.advanceTimersByTime(1);
    expect(setCopied.mock.calls).toEqual([[true], [false]]);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("2 回目に押したら、1 回目のタイマーで戻らず、2 回目から 2 秒で戻る", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const setCopied = vi.fn();
    const timer: CopiedTimer = { current: null };
    await copyText("a", setCopied, timer);
    vi.advanceTimersByTime(1000);
    await copyText("a", setCopied, timer);
    // 1 回目から 2 秒(2 回目から 1 秒)。ここで戻すと、2 回目のチェックの印が 1 秒で消える
    vi.advanceTimersByTime(1000);
    expect(setCopied.mock.calls).toEqual([[true], [true]]);
    vi.advanceTimersByTime(999);
    expect(setCopied.mock.calls).toEqual([[true], [true]]);
    vi.advanceTimersByTime(1);
    expect(setCopied.mock.calls).toEqual([[true], [true], [false]]);
    expect(timer.current).toBeNull();
  });

  it("書き込めなければコピーした状態にせず、呼ぶ側の扱い(onUnavailable)に任せる", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const setCopied = vi.fn();
    const onUnavailable = vi.fn();
    await copyText("x", setCopied, { current: null }, onUnavailable);
    vi.advanceTimersByTime(5000);
    expect(setCopied).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
