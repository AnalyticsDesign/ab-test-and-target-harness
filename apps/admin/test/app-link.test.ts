import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isFocusVisible, prefetchQuietly } from "@/lib/prefetch-intent";

/**
 * 管理画面の速さ D: Link は components/ui/AppLink.tsx の AppLink を使う(next/link を直接 import しない)。
 * next/link の Link を直接置くと、画面に見えた時点で先読みし、1 本ごとに control への問い合わせが 3〜6 回増える(理由は AppLink.tsx)。
 * 先読みを止めたいリンクは AppLink に prefetch={false} を付ける
 */
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];
/** next/link を import してよい唯一のファイル(包みそのもの) */
const WRAPPER = "components/ui/AppLink.tsx";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(?:ts|tsx)$/.test(e.name) ? [p] : [];
  });

describe("links go through AppLink", () => {
  it("no file other than AppLink imports next/link", () => {
    const offenders = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
      .map((f) => path.relative(ROOT, f))
      .filter((f) => f !== WRAPPER && /from\s+["']next\/link["']|import\(\s*["']next\/link["']\s*\)/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the wrapper itself still imports next/link (the check above would pass vacuously if the wrapper moved)", () => {
    expect(readFileSync(path.join(ROOT, WRAPPER), "utf8")).toMatch(/from "next\/link"/);
  });
});

describe("AppLink の先読みの呼び出しは、イベントの処理の外へ例外を出さない(lib/prefetch-intent.ts)", () => {
  it("router.prefetch が throw しても外に出さない(URL にできない href)", () => {
    const router = { prefetch: vi.fn(() => { throw new Error("Cannot prefetch 'x' because it cannot be converted to a URL."); }) };
    expect(() => prefetchQuietly(router, "http://[bad")).not.toThrow();
    expect(router.prefetch).toHaveBeenCalledWith("http://[bad");
  });

  it("router.prefetch が拒否する Promise を返しても、拒否を外に漏らさない", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      prefetchQuietly({ prefetch: () => Promise.reject(new Error("x")) }, "/w/a");
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("成功するときはそのまま先読みする", () => {
    const router = { prefetch: vi.fn() };
    prefetchQuietly(router, "/w/a");
    expect(router.prefetch).toHaveBeenCalledWith("/w/a");
  });

  it(":focus-visible を知らないブラウザ(matches が SyntaxError)では false(先読みしない)で、throw しない", () => {
    const el = { matches: () => { throw new SyntaxError("':focus-visible' is not a valid selector"); } };
    expect(isFocusVisible(el)).toBe(false);
  });

  it("matches の結果はそのまま返す", () => {
    expect(isFocusVisible({ matches: (s) => s === ":focus-visible" })).toBe(true);
    expect(isFocusVisible({ matches: () => false })).toBe(false);
  });

  it("AppLink は先読みと :focus-visible の確かめを、この包みを通して呼ぶ", () => {
    const src = readFileSync(path.join(ROOT, WRAPPER), "utf8");
    expect(src).toMatch(/prefetchQuietly\(router, href\)/);
    expect(src).toMatch(/isFocusVisible\(e\.currentTarget\)/);
    // コメント(説明の中の router.prefetch() など)を除いて、直接の呼び出しが残っていないこと
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/router\.prefetch\(|\.matches\(/);
  });
});
