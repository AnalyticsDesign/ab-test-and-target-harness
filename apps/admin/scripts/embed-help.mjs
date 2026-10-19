// 説明(ヘルプ)の原稿 docs/experiment-results.md を admin の TS モジュールに焼く(D9 plan ③ K22)。
// control の embed-guide.mjs と同じく、生成物 generated/help.ja.ts はコミットする(admin の test / build の前に実行する)。
// 書くのは help.ja.ts だけ(generated/release.ts は版の表示で、公開の作業が書き換える。ここでは作り直さない)。
// 言語ごとにファイルを分ける形だけを用意する(今は日本語だけ)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseHelp, renderHelpModule } from "./help-lib.mjs";

const SOURCE = "docs/experiment-results.md";
const md = await readFile(new URL(`../../../${SOURCE}`, import.meta.url), "utf8");
const { entries, problems } = parseHelp(md);
if (problems.length) {
  console.error(problems.map((p) => `${SOURCE}:${p.line} help-marker: ${p.message}`).join("\n"));
  process.exit(1);
}
await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../generated/help.ja.ts", import.meta.url), renderHelpModule(entries, SOURCE));
console.log(`embedded ${SOURCE} into apps/admin/generated/help.ja.ts (${entries.length} items)`);
