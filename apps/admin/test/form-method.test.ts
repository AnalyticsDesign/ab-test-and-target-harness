import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(?:ts|tsx)$/.test(e.name) ? [p] : [];
  });

// app-link.test.ts と同じく、管理画面の実装を横断して付け忘れを止める。
// 例外は設けない。method はイベント処理より前に明示し、callback 本体を属性と取り違えない。
describe("forms declare their native submission method", () => {
  it("no form in app, components or lib omits method", () => {
    const offenders = DIRS.flatMap((d) => walk(path.join(ROOT, d))).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/<form\b([\s\S]*?)(?:\bonSubmit\s*=|>)/g)]
        .filter((match) => !/\bmethod\s*=\s*["'](?:post|get|dialog)["']/.test(match[1]!))
        .map((match) => `${path.relative(ROOT, file)}:${source.slice(0, match.index).split("\n").length}`);
    });
    expect(offenders).toEqual([]);
  });
});
