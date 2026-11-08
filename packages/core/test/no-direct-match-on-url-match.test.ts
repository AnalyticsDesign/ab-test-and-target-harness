import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * B69 spec §3.2: 対象 URL(urlMatch)は必ず matchTargetUrl / matchesTargetUrl を通す。
 * matchPage / matchesUrl に urlMatch を直接渡す所が残ると、除くの行・パラメータの条件・判定できない行の扱いが抜ける
 * (版 2 の PageMatch を前提にした古い呼び方。版 3 の UrlMatch を渡すと op が無く常に「一致しない」になる)
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = [
  "packages/core/src",
  "packages/runtime/src",
  "apps/control/src",
  "apps/edge/src",
  "apps/deployer/src",
  "apps/admin/lib",
  "apps/admin/components",
  "apps/admin/app",
];
const DIRECT = /match(Page|esUrl)\([^)]*urlMatch/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("対象 URL の照合の入口(B69)", () => {
  it("no_direct_matchPage_on_urlMatch", () => {
    const files = DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50); // 走査先を見失って黙って通らないように
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => (DIRECT.test(line) ? `${f.slice(ROOT.length)}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null),
    );
    expect(hits).toEqual([]);
  });
});
