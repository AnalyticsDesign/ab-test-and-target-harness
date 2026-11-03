import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteChromeGuard } from "@/components/ui/SiteChromeGuard";
import { ChromeScopeGuard } from "@/components/ui/ChromeScopeGuard";
import { SERVER_SNAPSHOT, type FeedbackSnapshot, type NavState } from "@/lib/feedback-store";

// 管理画面の速さ(最終レビュー CX-R1 の案 C): 上部バーは、描いたときの wid・sid が今の URL(useParams)と合うときだけ中身を出す。
// B173 第 1 段 Task 4: 加えて、利用者に見せる状態の遷移(store)が別のサイト・ワークスペースへ向かう間も帯にする。
// 遷移の枠の中の振る舞いは E2E(e2e/shell-reuse.spec.ts・e2e/nav-feedback.spec.ts)で見る。ここは照らし合いの分かれ道だけ
const current = vi.hoisted(() => ({ params: null as Record<string, string | string[]> | null, snapshot: null as unknown }));
vi.mock("next/navigation", () => ({ useParams: () => current.params }));
// renderToStaticMarkup では useSyncExternalStore がサーバーの値(遷移なし)しか読まないので、選ぶ関数をテストの snapshot に当てる
vi.mock("@/lib/use-feedback", () => ({ useFeedbackSelector: (select: (s: unknown) => unknown) => select(current.snapshot) }));

const nav = (href: string, visible: boolean): FeedbackSnapshot => {
  const n: NavState = { seq: 1, href, fromUrl: "/w/w1/sites/s1", key: null, visible, timedOut: false, dispatched: true };
  return { ...SERVER_SNAPSHOT, nav: n };
};

const render = (wid: string, sid: string) => renderToStaticMarkup(createElement(SiteChromeGuard, { wid, sid, children: createElement("header", { "data-testid": "chrome" }, "Site A") }));

beforeEach(() => {
  current.snapshot = SERVER_SNAPSHOT;
});

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

  it("nav が別のサイトへ visible なら、URL がまだ移っていなくても帯にする", () => {
    current.params = { wid: "w1", sid: "s1" };
    current.snapshot = nav("/w/w1/sites/s2", true);
    const html = render("w1", "s1");
    expect(html).not.toContain("Site A");
    expect(html).toContain('data-testid="topbar-skeleton"');
  });

  it("nav が同じサイトの中・まだ visible でないときは中身のまま", () => {
    current.params = { wid: "w1", sid: "s1" };
    current.snapshot = nav("/w/w1/sites/s1/goals", true);
    expect(render("w1", "s1")).toContain("Site A");
    current.snapshot = nav("/w/w1/sites/s2", false);
    expect(render("w1", "s1")).toContain("Site A");
  });
});

describe("ChromeScopeGuard", () => {
  const renderScope = (scope: { wid: string | null; sid: string | null }) =>
    renderToStaticMarkup(createElement(ChromeScopeGuard, { scope, children: createElement("header", { "data-testid": "chrome" }, "Bar") }));

  it("遷移が無ければ中身を出す", () => {
    expect(renderScope({ wid: "w1", sid: null })).toBe('<header data-testid="chrome">Bar</header>');
  });

  it("visible な遷移の行き先の範囲が違えば帯にする(ワークスペースの画面 → サイト、ホーム → ワークスペース)", () => {
    current.snapshot = nav("/w/w1/sites/s1", true);
    const html = renderScope({ wid: "w1", sid: null });
    expect(html).not.toContain("Bar");
    expect(html).toContain('data-testid="topbar-skeleton"');
    current.snapshot = nav("/w/w1", true);
    expect(renderScope({ wid: null, sid: null })).toContain('data-testid="topbar-skeleton"');
  });

  it("行き先の範囲が同じなら中身のまま(個人の画面どうし・同じワークスペースの画面どうし)", () => {
    current.snapshot = nav("/w/me/display", true);
    expect(renderScope({ wid: null, sid: null })).toContain("Bar");
    current.snapshot = nav("/w/w1/members", true);
    expect(renderScope({ wid: "w1", sid: null })).toContain("Bar");
  });
});
