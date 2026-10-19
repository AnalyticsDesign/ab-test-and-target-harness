import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * admin E2E の初期状態を作る。
 *
 * control と edge は同じ `--persist-to`(`apps/control/.e2e-state`)で起動して KV を共有する
 * (control の Publish が edge の bootstrap に現れることを確かめるため)。そのディレクトリごと
 * D1 / KV / R2 のローカル状態を捨て、D1 migrations(wtt-control と計測用の wtt-results)を当て直す — `/setup` は user が 0 件のときしか
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

// 前の実行の wrangler のログ(.e2e-state/logs。fixtures.ts の e2eWranglerEnv)は、消す前に退避して .e2e-state/logs-prev に 1 回分だけ残す
// (wrangler dev が落ちた実行の後に流し直しても、落ちた実行のログを読めるように)
const state = resolve(control, ".e2e-state");
const keptLogs = existsSync(resolve(state, "logs")) ? mkdtempSync(join(tmpdir(), "wtt-e2e-logs-")) : null;
if (keptLogs) cpSync(resolve(state, "logs"), keptLogs, { recursive: true });
rmSync(state, { recursive: true, force: true });
if (keptLogs) {
  mkdirSync(state, { recursive: true });
  cpSync(keptLogs, resolve(state, "logs-prev"), { recursive: true });
  rmSync(keptLogs, { recursive: true, force: true });
}
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "wtt-control", "--local", "--persist-to", ".e2e-state"], { cwd: control, stdio: "inherit" });
// D9 ③(plan ③ の K26): 計測用 D1(wtt-results)も同じ状態ディレクトリに作る。control の wrangler.jsonc の migrations_dir は
// edge の results-migrations を指し、database_id も edge と同じなので、control と edge が同じローカルの wtt-results を読み書きする
// (edge が受けた参加・CV を control の結果の API が読む)
execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "wtt-results", "--local", "--persist-to", ".e2e-state"], { cwd: control, stdio: "inherit" });
// D9 ③(Task 17 の修正 1): この実行の wrangler dev だけが使う dev registry とログの置き場所(fixtures.ts の e2eWranglerEnv)。
// 状態ディレクトリごと消しているので、前の実行の古い登録は残らない
mkdirSync(resolve(control, ".e2e-state", "registry"), { recursive: true });
for (const name of ["control", "edge", "admin"]) mkdirSync(resolve(control, ".e2e-state", "logs", name), { recursive: true });
