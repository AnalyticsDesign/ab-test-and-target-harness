import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SiteChromeGuard } from "@/components/ui/SiteChromeGuard";

// 管理画面の速さ(最終レビュー CX-R1 の案 C): 上部バーは、描いたときの wid・sid が今の URL(useParams)と合うときだけ中身を出す。
// 遷移の枠の中の振る舞いは E2E(e2e/shell-reuse.spec.ts)で見る。ここは照らし合いの分かれ道だけ
const current = vi.hoisted(() => ({ params: null as Record<string, string | string[]> | null }));
vi.mock("next/navigation", () => ({ useParams: () => current.params }));

const render = (wid: string, sid: string) => renderToStaticMarkup(createElement(SiteChromeGuard, { wid, sid, children: createElement("header", { "data-testid": "chrome" }, "Site A") }));

describe("SiteChromeGuard", () => {
  it("同じサイト(wid・sid が合う)なら中身をそのまま出す", () => {
    current.params = { wid: "w1", sid: "s1" };
    const html = render("w1", "s1");
    expect(html).toBe('<header data-testid="chrome">Site A</header>');
  });

  it("別のサイトへ移った後(sid が違う)は中身を出さず、同じ高さの帯と描いた値・今の値を出す", () => {
    current.params = { wid: "w1", sid: "s2" };
    const html = render("w1", "s1");
    expect(html).not.toContain("Site A");
    expect(html).toContain('data-testid="topbar-skeleton"');
    expect(html).toContain('data-rendered-site="w1/s1"');
    expect(html).toContain('data-current-site="w1/s2"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("別のワークスペースへ移った後(wid が違う)も帯にする", () => {
    current.params = { wid: "w2", sid: "s1" };
    expect(render("w1", "s1")).toContain('data-current-site="w2/s1"');
  });

  it("サイトの外へ移った後(sid が無い)も帯にする", () => {
    current.params = { wid: "w1" };
    expect(render("w1", "s1")).toContain('data-current-site="w1/"');
  });

  it("useParams が null(ルーターの外)なら照らせないので中身を出す", () => {
    current.params = null;
    expect(render("w1", "s1")).toContain("Site A");
  });
});
