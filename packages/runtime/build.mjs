import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const common = { bundle: true, format: "iife", target: "es2020", minify: true, metafile: true };
// 決定 50: プレビューは別ファイル。runtime は内容のハッシュ入りの URL で読む(edge は同じ build のハッシュだけを返す = 版が食い違わない)
const preview = await build({ ...common, entryPoints: ["src/preview-entry.ts"], banner: { js: "/*! wtt-preview */" }, outfile: "dist/preview.iife.js" });
const previewHash = createHash("sha256").update(await readFile("dist/preview.iife.js")).digest("hex").slice(0, 12);
const result = await build({
  ...common,
  entryPoints: ["src/index.ts"],
  banner: { js: "/*! wtt-runtime */" }, // bootstrap 結合後の識別 marker(edge テストが検証)
  outfile: "dist/runtime.iife.js",
  define: { __WTT_PREVIEW_HASH__: JSON.stringify(previewHash) },
});
await writeFile("dist/meta.json", JSON.stringify(result.metafile));
await writeFile("dist/preview-meta.json", JSON.stringify(preview.metafile));
await writeFile("dist/preview.hash", previewHash);
console.log(`built dist/runtime.iife.js and dist/preview.iife.js (preview ${previewHash})`);
