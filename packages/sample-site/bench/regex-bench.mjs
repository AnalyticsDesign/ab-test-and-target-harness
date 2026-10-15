import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "@playwright/test";

// 先に: pnpm -C packages/runtime exec esbuild ../core/bench/regex-bench-browser.ts --bundle --format=iife --outfile=../core/bench/dist/regex-bench.js
const bundle = await readFile(new URL("../../core/bench/dist/regex-bench.js", import.meta.url), "utf8");
const measured = [];
for (const [name, type] of [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]]) {
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    // 起動の失敗(エンジンが入っていない など)
    console.log(`## ${name}: 起動できない(${String(e).split("\n")[0]})。pnpm -C packages/sample-site exec playwright install ${name}`);
    continue;
  }
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle });
    const rows = await page.evaluate(() => globalThis.runRegexBench());
    console.log(`## ${name}`);
    for (const r of rows) console.log(`${r.src}\t${r.instructions}\t${r.len}\t${r.ms.toFixed(3)} ms`);
    measured.push(name);
  } catch (e) {
    // ベンチの実行の失敗(起動はできた)
    console.log(`## ${name}: ベンチの実行に失敗(${String(e).split("\n")[0]})`);
  } finally {
    await browser.close();
  }
}
// 3 エンジンのどれかが欠けた・例外なら 0 以外で終える(欠けた結果で上限を確定しない)
if (measured.length !== 3) {
  console.log(`測れたエンジン: ${measured.join(", ") || "なし"}(3 つすべてが必要)`);
  process.exitCode = 1;
}
