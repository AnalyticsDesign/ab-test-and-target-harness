import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// B141: 管理画面のファビコン(app/icon.svg)。vinext の metadata の決まり(app/icon.svg → /icon.svg と head の <link rel="icon">)で配る。
// 図柄を差し替えるときも、ここの条件(検討の記録 docs/dev/favicon_study_v1.md の「条件」)を守る
const file = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");
// 中身の検査はコメントを除いて行う(コメントには説明として <text> などの語が出る)
const svg = file.replace(/<!--[\s\S]*?-->/g, "");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const appDir = new URL("../app/", import.meta.url);
// metadata を書ける所(どの階層の layout・page も。generateMetadata・metadata を書いたほかのファイルも念のため含める)
const metadataSources = (readdirSync(appDir, { recursive: true, encoding: "utf8" }) as string[])
  .filter((rel) => /\.(?:ts|tsx|js|jsx)$/.test(rel))
  .map((rel) => ({ rel, text: readFileSync(new URL(rel, appDir), "utf8") }))
  .filter(({ rel, text }) => /(?:^|[\\/])(?:layout|page)\.(?:ts|tsx|js|jsx)$/.test(rel) || /\bgenerateMetadata\b|\bexport const metadata\b/.test(text));

describe("app/icon.svg (favicon)", () => {
  it("is a square 32 viewBox SVG", () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 32 32"/);
  });

  it("draws no <text> (a favicon renders text in the OS font, not IBM Plex) and loads nothing external", () => {
    expect(svg).not.toMatch(/<text\b/);
    expect(svg).not.toMatch(/(?:href|src)="(?:https?:)?\/\//);
  });

  it("uses fixed colors, not a prefers-color-scheme switch (it must look the same on light and dark tab strips)", () => {
    expect(svg).not.toMatch(/prefers-color-scheme/);
  });

  it("only uses colors that are globals.css tokens", () => {
    const tokens = new Set([...css.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()));
    const used = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(tokens.has(c), c).toBe(true);
  });

  // vinext は、その画面に効くどの階層の metadata に icons があっても、app の icon ファイルを head から外す
  // (node_modules/vinext/dist/server/file-based-metadata.js の iconRouteHasExplicitIconsAtSource)。なので app の下をすべて見る
  it("is not hidden by an explicit metadata.icons in any layout / page under app/", () => {
    expect(metadataSources.some(({ rel }) => /(?:^|[\\/])layout\.tsx$/.test(rel))).toBe(true); // 走査が空振りしていないこと
    for (const { rel, text } of metadataSources) expect(text, rel).not.toMatch(/\bicons\s*:/);
  });

  // public/ の同じ名前のファイルは、Workers の静的配信(dist/client。vinext build が public/ を写す)が Worker より先に返すので、
  // app/icon.svg を上書きする: public/icon.svg を置くと、head の link(/icon.svg?<app/icon.svg のハッシュ>)にも public 側の中身が返る。
  // public/favicon.ico は /favicon.ico を直接取りに来る相手にだけ返り、head の link を読むブラウザとで図柄が割れる。
  // どちらも build と wrangler dev(pnpm preview と同じ)で確かめた(2026-10-26)。next dev(pnpm dev)での扱いは見ていない
  it("has no public/favicon.ico or public/icon.* that would shadow or split app/icon.svg", () => {
    const pub = new URL("../public/", import.meta.url);
    if (!existsSync(pub)) return;
    const names = readdirSync(pub);
    expect(names).not.toContain("favicon.ico");
    expect(names.filter((n) => /^icon\./.test(n))).toEqual([]);
  });
});
