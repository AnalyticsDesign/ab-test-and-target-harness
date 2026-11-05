import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import ErrorPage from "@/app/error";
import { markUrl } from "@/components/ui/PageMark";
import { noteWriteSucceeded, resetFeedbackStoreForTest } from "@/lib/feedback-store";

/**
 * 操作のフィードバック(B173 第 1 段): 遷移の終わりは、移った先の画面が描く印(components/ui/PageMark.tsx)で store に知らせる。
 * 印の無いページがあると、そのページへの遷移は 10 秒の打ち切りまで終わらない。ページを足したときに置き忘れないよう、全ページを照らす。
 * 検査は test/app-link.test.ts と同じく、ファイルの文字列を見る静的なもの
 */
const ROOT = path.join(import.meta.dirname, "..");
const APP = path.join(ROOT, "app");
/** 何も描かない(redirect だけ)ページ。行き先のページの印で遷移が終わるので、印を置かない */
const REDIRECT_ONLY = ["app/page.tsx"];
/** クライアントのページ。path を省き、mount 時の window.location から印を作る */
const CLIENT_PAGES = ["app/(auth)/reset/page.tsx", "app/(auth)/setup/page.tsx"];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name === "page.tsx" ? [p] : [];
  });
const pages = walk(APP).map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** ファイルの場所から印の path を機械的に作る: app/ と (group) を外し、[x] を ${x} に、末尾の /page.tsx を外す。空なら "/" */
function expectedPath(rel: string): string {
  const segs = rel
    .replace(/^app\//, "")
    .replace(/\/?page\.tsx$/, "")
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s))
    .map((s) => s.replace(/^\[(.+)\]$/, "${$1}"));
  return "/" + segs.join("/");
}

describe("every page renders a PageMark", () => {
  it("expectedPath builds the path from the file location", () => {
    expect(expectedPath("app/w/[wid]/sites/[sid]/goals/page.tsx")).toBe("/w/${wid}/sites/${sid}/goals");
    expect(expectedPath("app/(auth)/login/page.tsx")).toBe("/login");
    expect(expectedPath("app/w/page.tsx")).toBe("/w");
    expect(expectedPath("app/page.tsx")).toBe("/");
  });

  it("every server page renders PageMark with the path derived from its file location and its searchParams", () => {
    const serverPages = pages.filter((p) => !REDIRECT_ONLY.includes(p) && !CLIENT_PAGES.includes(p));
    const offenders = serverPages.filter((p) => {
      const src = read(p);
      return !src.includes(`path={\`${expectedPath(p)}\`}`) || !src.includes("search={") || !/<PageMark\b/.test(src);
    });
    expect(offenders).toEqual([]);
    // 一覧の取りこぼしで空振りしない(サーバーのページは 24 個。B129 で操作の記録の 2 つを足した)
    expect(serverPages).toHaveLength(24);
  });

  it("client pages render PageMark without a path", () => {
    for (const p of CLIENT_PAGES) {
      expect(pages).toContain(p);
      const src = read(p);
      expect(src, p).toMatch(/<PageMark\b/);
      expect(src, p).not.toMatch(/\bpath=/);
    }
  });

  it("the redirect-only exclusion list stays accurate", () => {
    for (const p of REDIRECT_ONLY) {
      expect(pages).toContain(p);
      const src = read(p);
      // JSX を返し始めたら、印が要る。除外の一覧から外せという意味で落とす
      expect(src, `${p} は JSX を返している。REDIRECT_ONLY から外して PageMark を置く`).not.toMatch(/return\s*\(|return\s*<|=>\s*\(?\s*</);
      expect(src).toMatch(/redirect\(/);
    }
  });

  it("error.tsx and not-found.tsx render PageMark with their kind", () => {
    expect(read("app/error.tsx")).toMatch(/<PageMark\s+kind="error"\s*\/>/);
    expect(read("app/not-found.tsx")).toMatch(/<PageMark\s+kind="notFound"\s*\/>/);
  });
});

describe("markUrl", () => {
  it("normalizes the server URL", () => {
    expect(markUrl("/w/a", { b: "2", a: ["1", "3"], c: undefined })).toBe("/w/a?a=1&a=3&b=2");
    expect(markUrl("/w/a")).toBe("/w/a");
    expect(markUrl("/w/a", {})).toBe("/w/a");
  });
});

describe("error.tsx の「保存は済んでいます。」", () => {
  beforeEach(() => resetFeedbackStoreForTest());
  const render = () => renderToStaticMarkup(createElement(ErrorPage,{ error: new globalThis.Error("x"), reset: () => {} }));

  it("adds the saved line only when a write succeeded", () => {
    expect(render()).not.toContain("保存は済んでいます。");
    noteWriteSucceeded();
    expect(render()).toContain("保存は済んでいます。");
  });
});
