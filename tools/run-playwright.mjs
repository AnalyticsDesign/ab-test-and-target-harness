// E2E(playwright test)を、後ろに付けた引数で絞り込んで流す入口。
// 使い方: node tools/run-playwright.mjs <パッケージのディレクトリ> [playwright test に渡す引数…]
//   例: ルートの `pnpm e2e:admin -- leave-guard.spec.ts` → node tools/run-playwright.mjs apps/admin -- leave-guard.spec.ts
// pnpm は後ろの引数を「-- <引数>」のまま最後のコマンドに付ける。playwright test は「--」の後ろの名前を絞り込みに使わず、
// 全部を流してしまう。そこでパッケージのディレクトリの直後の「--」を 1 つだけ外してから渡す。
// shell を使わずに Node から playwright の CLI を呼ぶ(Windows の cmd でも同じに動くように)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { join, resolve } from "node:path";

const [dirArg, ...rest] = process.argv.slice(2);
if (!dirArg || dirArg === "--") {
  console.error("使い方: node tools/run-playwright.mjs <パッケージのディレクトリ> [playwright test に渡す引数…]");
  process.exit(1);
}
const packageDir = resolve(process.cwd(), dirArg);
const args = rest[0] === "--" ? rest.slice(1) : rest;

// playwright はそのパッケージが依存に持つものを使う(パッケージごとに版が違っても取り違えない)
let cli;
try {
  cli = createRequire(join(packageDir, "package.json")).resolve("@playwright/test/cli");
} catch {
  console.error(`${packageDir} から @playwright/test が見つかりません。そのパッケージで pnpm install を済ませたか、ディレクトリが正しいかを確かめてください`);
  process.exit(1);
}

const child = spawn(process.execPath, [cli, "test", ...args], { cwd: packageDir, stdio: "inherit" });

// 子(playwright)が webServer の停止などの後始末を終えるまで、親は先に終わらない。
// Ctrl-C(SIGINT)は端末が子にも直接送るので、親では受けるだけで何もしない(子に重ねて送ると、playwright は 2 回目で後始末を飛ばして止まる)。
// SIGTERM・SIGHUP は親にだけ届くことがある(CI の打ち切り・kill など)ので、子に転送する
process.on("SIGINT", () => {});
for (const sig of ["SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}

child.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
child.on("close", (code, signal) => {
  // シグナルで止まったときは、シェルの慣習どおり 128 + シグナルの番号で返す(失敗として扱われる)
  if (code !== null) process.exit(code);
  process.exit(128 + (constants.signals[signal] ?? 1));
});
