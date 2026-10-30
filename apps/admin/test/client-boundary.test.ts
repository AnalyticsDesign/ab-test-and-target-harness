import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * サーバーの部品("use client" の無いファイル)が "use client" のファイルから関数・値を import して呼ぶと、
 * サーバー側ではその export がクライアント参照に置き換わり、呼んだ時点で
 * 「Unexpectedly client reference export '…' is called on server」が投げられて画面がエラーになる(ソースの静的な検査)。
 * 単体テストは "use client" を無視して直接 import するので、この食い違いは本番ビルドと E2E でしか見えない
 * (B139: サイト設定の page.tsx が SharingCard.tsx の sharingNoticeFor を呼び、サイト設定がすべて開けなくなった)。
 * サーバーから "use client" のファイルを import してよいのは、部品(大文字で始まる名前。JSX で描くだけ)と型だけ。
 * サーバーでも使う関数・定数は "use client" の無いファイル(sections.ts など)に置く。
 * 見るのは app/ の下の "use client" の無いファイル(page / layout / route など。必ずサーバーで動く入口)だけ。
 * components/ や lib/ の指示の無いファイルは、クライアントの部品からしか読まれないこともあり、ここからはサーバーかどうか決められない
 */
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f).split(path.sep).join("/"));
}

/** 先頭の指示文が "use client" か(コメント・空行の後の最初の文) */
const isClient = (src: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(src);

/** import の指定子をリポジトリ内のファイルに解決する(@/ と相対だけ。パッケージは見ない) */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (/\.(ts|tsx)$/.test(cand) && existsSync(path.join(ROOT, cand))) return cand;
  }
  return null;
}

/** `import X, { a, type B, c as d } from "…"` から、値として取り込む名前(ローカル名でなく export 名)を取る。`import type` は除く */
function valueImports(src: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  const re = /import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const clause = m[1]!;
    const names: string[] = [];
    const def = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (def) names.push(def[1]!);
    const braces = clause.match(/\{([^}]*)\}/);
    for (const part of braces ? braces[1]!.split(",") : []) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      names.push(p.split(/\s+as\s+/)[0]!.trim());
    }
    out.push({ spec: m[2]!, names });
  }
  return out;
}

describe("server modules do not call exports of 'use client' modules", () => {
  const all = DIRS.flatMap(files);
  const client = new Set(all.filter((f) => isClient(readFileSync(path.join(ROOT, f), "utf8"))));

  it("finds client modules (the scan itself works)", () => {
    expect(client.has("components/settings/SharingCard.tsx")).toBe(true);
    expect(client.has("components/settings/sections.ts")).toBe(false);
  });

  it("server entries under app/ import only components (capitalized) and types from client modules", () => {
    const bad: string[] = [];
    for (const f of all) {
      if (client.has(f) || !f.startsWith("app/")) continue;
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const { spec, names } of valueImports(src)) {
        const target = resolve(f, spec);
        if (!target || !client.has(target)) continue;
        for (const n of names) if (!/^[A-Z]/.test(n)) bad.push(`${f}: ${n} from ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
