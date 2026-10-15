import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * admin E2E の初期状態を作る。
 *
 * control と edge は同じ `--persist-to`(`apps/control/.e2e-state`)で起動して KV を共有する
 * (control の Publish が edge の bootstrap に現れることを確かめるため)。そのディレクトリごと
 * D1 / KV / R2 のローカル状態を捨て、D1 migrations を当て直す — `/setup` は user が 0 件のときしか
 * 通らないので(spec §13.3)、毎回作り直さないと 2 回目以降が 403 setup_closed で落ちる。
 *
 * **playwright.config.ts の `globalSetup` には置かない。** Playwright は `webServer` を `globalSetup` より
 * 先に起動する(1.62.1 で実測)ため、globalSetup に置くと「起動済みの wrangler dev の足元でディレクトリを消す」
 * ことになり、worker が掴んでいる sqlite と作り直した sqlite が食い違う。そのため
 * ルートの `pnpm e2e:admin` が `playwright test` の **前に** この 1 ファイルを実行する
 * (= 状態削除 + D1 migrate → 3 サーバー起動 → spec の順)。
 *
 * リセットせずに `playwright test` を直接叩いた場合は、publish-flow の最初のテストが
 * control の 403 setup_closed(「初回セットアップは既に完了しています」)で落ちるので、原因は画面に出る。
 *
 * admin の Workers ビルド(pnpm -C apps/admin build = vinext build)もこの後・playwright の前にルートの e2e:admin が行う(生成設定(パスは package.json の preview / deploy:cf)が無いと admin の webServer が起動できない)
 */
const control = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../control"); // ESM なので __dirname は使えない

rmSync(resolve(control, ".e2e-state"), { recursive: true, force: true });
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "wtt-control", "--local", "--persist-to", ".e2e-state"], { cwd: control, stdio: "inherit" });
