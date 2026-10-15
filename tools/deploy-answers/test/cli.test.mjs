import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const runCli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const ANSWERS = "features: [ab]\ndaily_pv: unknown\nimage_upload: false\ncloudflare_account: none\nsite_on_cloudflare: no_site\nowner_email: a@example.com\n# edge_address: route  # x\n";

test("既定のファイル(deploy-answers.yaml)を読み、提示して終了コード 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-answers-"));
  writeFileSync(join(dir, "deploy-answers.yaml"), ANSWERS);
  const r = runCli([], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /## 推奨構成/);
});

test("--accept でファイルに書き戻す", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-answers-"));
  writeFileSync(join(dir, "a.yaml"), ANSWERS);
  const r = runCli(["--file", "a.yaml", "--accept", "lightest"], dir);
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(dir, "a.yaml"), "utf8"), /^edge_address: workers-dev   # x$/m);
});

test("ファイルが無い・不明な引数・空の値・--accept と --resolve-zone の同時指定は終了コード 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-answers-"));
  assert.equal(runCli([], dir).status, 1);
  writeFileSync(join(dir, "deploy-answers.yaml"), ANSWERS);
  assert.equal(runCli(["--bogus"], dir).status, 1);
  assert.equal(runCli(["--accept"], dir).status, 1);
  assert.equal(runCli(["--resolve-zone", ""], dir).status, 1);
  assert.equal(runCli(["--accept", "lightest", "--resolve-zone", "example.com"], dir).status, 1);
  assert.equal(runCli(["--confirm-account-change"], dir).status, 1);
});

test("--confirm-account-change は値を取らないフラグとして --accept と一緒に使える", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-answers-"));
  const text = ANSWERS.replace("cloudflare_account: none\nsite_on_cloudflare: no_site", "cloudflare_account: existing\nexisting_plan: paid\nsite_on_cloudflare: no");
  writeFileSync(join(dir, "deploy-answers.yaml"), text);
  assert.equal(runCli(["--accept", "lightest"], dir).status, 2);
  assert.equal(readFileSync(join(dir, "deploy-answers.yaml"), "utf8"), text);
  assert.equal(runCli(["--confirm-account-change", "--accept", "lightest"], dir).status, 0);
  assert.match(readFileSync(join(dir, "deploy-answers.yaml"), "utf8"), /^cloudflare_account: separate   # 元の答え: existing/m);
});

test("聞き直しは終了コード 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-answers-"));
  writeFileSync(join(dir, "deploy-answers.yaml"), "features: [ab]\n");
  const r = runCli([], dir);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /## 聞き直す問い/);
});
