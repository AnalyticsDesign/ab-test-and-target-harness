import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// 決定 50: runtime 単体の上限(gzip)。packages/core/src/bake.ts の BOOTSTRAP_LIMITS.runtimeGzipMax と同じ値(bake.test.ts が照合する)。
// 上限を変えたくなったら本体 spec の決定 50 (6) から始める。超えそうなら、上げる前に同期で読まなくてよいコードを別ファイルに外す
// (Task 4・6 でサイズを超えて上限を前倒しで上げていれば、この定数はもう 11264。ここでは 2 つの出力への分割だけを行う)
const RUNTIME_GZIP_MAX = 11264;

const src = await readFile(new URL("../dist/runtime.iife.js", import.meta.url), "utf8");
const previewSrc = await readFile(new URL("../dist/preview.iife.js", import.meta.url), "utf8");
const previewHash = (await readFile(new URL("../dist/preview.hash", import.meta.url), "utf8")).trim();
const runtimeHash = createHash("sha256").update(src).digest("hex").slice(0, 12); // PREVIEW_HASH(build.mjs)と同じ作り方
const gz = gzipSync(Buffer.from(src)).length;
if (gz > RUNTIME_GZIP_MAX) throw new Error(`runtime bundle is ${gz} bytes gzipped — over the ${RUNTIME_GZIP_MAX} byte limit (decision 50)`);
const previewGz = gzipSync(Buffer.from(previewSrc)).length;

// zod 不在は bundle graph で判定する(minify 後の文字列検索は識別子が縮約されて偽陰性になる。r1 CX-Low-3)。
// 見るのは **実際に bundle に載った** 側 = `outputs[outfile].inputs`(bytesInOutput > 0)であって、
// `meta.inputs`(= esbuild が走査したグラフ全体)ではない。走査グラフに zod が現れること自体は正常で問題ない —
// `@wtt/core` の barrel が schema.ts を re-export し、schema.ts が zod を import するため、値として core を
// 使うと zod は必ず走査される。それが出力に載らないのは core が `sideEffects: false`(Task 0 で付与)だから。
// ここで走査グラフを見ると、core を値として import した瞬間にゲートが常時 false positive になり使い物にならない(R7)
for (const [metaFile, outfile] of [["meta.json", "dist/runtime.iife.js"], ["preview-meta.json", "dist/preview.iife.js"]]) {
  const meta = JSON.parse(await readFile(new URL(`../dist/${metaFile}`, import.meta.url), "utf8"));
  const outputEntry = meta.outputs[outfile];
  // outfile 改名などで参照先を見失ったら「何も検出しない」ではなく落とす — 黙って no-op 化するゲートは無いより悪い
  if (!outputEntry?.inputs) {
    throw new Error(`cannot locate metafile output entry for ${outfile} — zod check would silently pass (available: ${Object.keys(meta.outputs).join(", ")})`);
  }
  const zodInputs = Object.entries(outputEntry.inputs)
    .filter(([p, v]) => /(^|\/)node_modules\/(\.pnpm\/)?.*zod/.test(p) && v.bytesInOutput > 0)
    .map(([p]) => p);
  if (zodInputs.length > 0) throw new Error(`${outfile} must not contain zod (size budget): ${zodInputs.join(", ")}`);
}
const out =
  "// GENERATED — `pnpm runtime:build` で packages/runtime/dist から再生成する。直接編集しない(決定 39 (3))\n" +
  `export const RUNTIME_SOURCE = ${JSON.stringify(src)};\n` +
  "// 決定 50: プレビューの処理(別ファイル)。edge が /s/preview/<PREVIEW_HASH>.js で返し、下書きの bootstrap は先頭に埋め込む\n" +
  `export const PREVIEW_SOURCE = ${JSON.stringify(previewSrc)};\n` +
  `export const PREVIEW_HASH = ${JSON.stringify(previewHash)};\n` +
  "// 決定 52: runtime の中身(RUNTIME_SOURCE)の SHA-256 の先頭 12 桁。デプロイ専用の Worker が、焼いた runtime が古いかの判定と bootstrap の先頭の注釈に使う\n" +
  `export const RUNTIME_HASH = ${JSON.stringify(runtimeHash)};\n`;
await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../generated/source.ts", import.meta.url), out);
console.log(`embedded runtime into packages/runtime/generated/source.ts (${gz} bytes gzipped, zod-free; preview ${previewGz} bytes gzipped)`);
