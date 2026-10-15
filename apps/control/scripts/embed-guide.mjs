// docs/agent-guide.md を control の TS モジュールに焼く(GET /llms.txt。決定 34)。
// wrangler の Text module ルールを使わないのは、wrangler・vitest(miniflare)・tsc の 3 者に同じ設定を
// 教える必要があり、普通の TS モジュールなら 3 者とも追加設定なしで同じものを見るため(runtime の embed.mjs と同じ形)
import { mkdir, readFile, writeFile } from "node:fs/promises";

const md = await readFile(new URL("../../../docs/agent-guide.md", import.meta.url), "utf8");
const out = `// GENERATED — \`node scripts/embed-guide.mjs\`(control の test / build が実行する)で docs/agent-guide.md から再生成する。直接編集しない\nexport const AGENT_GUIDE = ${JSON.stringify(md)};\n`;
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/agent-guide.ts", import.meta.url), out);
console.log(`embedded docs/agent-guide.md into apps/control/src/generated/agent-guide.ts (${md.length} chars)`);
