#!/usr/bin/env node
// 導入の答えの検査と構成の提示。リポジトリ直下で実行する:
//   node tools/deploy-answers/cli.mjs [--file <ファイル>] [--accept recommended|lightest|manual [--confirm-account-change]] [--resolve-zone <ゾーン名>]
// 終了コード: 0 = 提示・要約・書き込み / 1 = 書式や引数の誤り・ファイルが無い / 2 = 聞き直す問い・断り
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { run } from "./run.mjs";

const USAGE =
  "使い方: node tools/deploy-answers/cli.mjs [--file <ファイル>] [--accept recommended|lightest|manual [--confirm-account-change]] [--resolve-zone <ゾーン名>]\n";
const FLAGS = { "--file": "file", "--accept": "accept", "--resolve-zone": "resolveZone" };

function fail(message) {
  process.stdout.write(message);
  process.exit(1);
}

const opts = { file: "deploy-answers.yaml", accept: null, resolveZone: null, confirmAccountChange: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--confirm-account-change") {
    opts.confirmAccountChange = true;
    continue;
  }
  const name = FLAGS[args[i]];
  const value = args[i + 1];
  if (!name || value === undefined || value.trim() === "" || value.startsWith("--")) fail(USAGE);
  opts[name] = value;
  i++;
}
if (opts.accept && opts.resolveZone) fail("--accept と --resolve-zone は別々に実行する\n");
if (opts.confirmAccountChange && !opts.accept) fail("--confirm-account-change は --accept と一緒に使う\n");
if (!existsSync(opts.file)) fail(`${opts.file} が見つからない。リポジトリ直下で deploy-answers.example.yaml を写して作る\n`);

const result = run(readFileSync(opts.file, "utf8"), opts);
if (result.text !== undefined) writeFileSync(opts.file, result.text);
process.stdout.write(result.output);
process.exitCode = result.code;
