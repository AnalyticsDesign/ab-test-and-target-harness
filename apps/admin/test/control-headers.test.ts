import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backlog D13 / 決定 56 (1): admin の BFF は control へのすべての要求で版を名乗る(x-wtt-client-version)。
 * 古い admin が名乗る処理は後から足せないので、control を呼ぶ箇所の漏れをソースの静的な検査で止める。
 * control を呼ぶ箇所 = `${controlUrl()}` を使う fetch(controlFetch・/api/session/* の 5 本・招待ページ)。Google ログインの入口(リダイレクトを返すだけで fetch しない)は対象外。
 * 関数の定義行(`function clientVersionHeaders()`)とコメントは名乗りとして数えない(レビュー r1 CX-Medium-4: 定義を数えると controlFetch の付け忘れを見逃す)
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROOT = path.join(import.meta.dirname, "..");
const files = (dir: string) =>
  readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f).split(path.sep).join("/"));

describe("every control call names the client version (D13 / decision 56 (1))", () => {
  it("each fetch to controlUrl() carries clientVersionHeaders()", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const f of [...files("app"), ...files("lib")]) {
      const src = stripComments(readFileSync(path.join(ROOT, f), "utf8"));
      const fetches = src.match(/fetch\(\s*`\$\{controlUrl\(\)\}/g)?.length ?? 0;
      if (fetches === 0) continue;
      calls += fetches;
      const named = src.match(/(?<!function )clientVersionHeaders\(\)/g)?.length ?? 0;
      if (named < fetches) offenders.push(`${f}(fetch ${fetches} / 名乗り ${named})`);
    }
    // controlFetch 1 + /api/session/* 5 + 招待ページ 1。汎用プロキシは `fetch(target, …)` なので別に数える(下の bff.test.ts で確かめる)
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(offenders).toEqual([]);
  });
});
