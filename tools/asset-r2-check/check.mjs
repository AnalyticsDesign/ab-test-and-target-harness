#!/usr/bin/env node
// check.mjs — D1 を過去の時点に戻した後に、行はあるのに R2 に中身の無い画像を見つけて、印を付ける道具。
//
// なぜ要るか: D1 を戻すと、戻した時点より後に消した画像の行(と、それを指す設定・下書き)は戻るが、R2 の中身は戻らない。
// 公開の確かめは「行がある」で通るので、そのままでは中身の無い画像を指す設定を公開できてしまう。この道具で見つけて印を付けると、
// 公開がその画像を指す設定を断り、定期処理が行を消す。
//
// 使い方(リポジトリのルートで。deploy.md のバックアップ・復旧の節の「戻した後」の段で、書き込みの凍結の中で流す):
//   node tools/asset-r2-check/check.mjs                              # 見るだけ(D1 に書かない)
//   node tools/asset-r2-check/check.mjs --apply                      # 見つかった画像に印を付ける(凍結が入っていなければ止まる)
//   node tools/asset-r2-check/check.mjs --db wtt-control-restore     # D1 の名前を指定する(既定は apps/control/wrangler.jsonc の
//                                                                    # d1_databases の先頭の database_name。読めなければ wtt-control)
//   node tools/asset-r2-check/check.mjs --local [--persist-to <dir>] # 手元の D1・R2(wrangler の --local)で試す(道具の動作の確かめ用)
//
// 要るもの(本番の D1・R2 を見るとき):
//   - wrangler のログイン(D1 は `wrangler d1 execute --remote` で読み書きする)
//   - CLOUDFLARE_API_TOKEN: R2 の一覧を Cloudflare API で読む(wrangler に R2 のオブジェクトの一覧のコマンドが無いため)。
//     ふつうは deploy.md の「画像の中身の確かめ」の関数 r2check から流す(wrangler のログインのトークンを、サブシェルの中だけで入れる)
//     値は画面にもログにも出さない。設定すると子のプロセスの wrangler(D1 の読み書き)もこのトークンを使うので、
//     別に作ったトークンを入れるときは、R2 の読み取りに加えて D1 の編集の権限も要る
//   - CLOUDFLARE_ACCOUNT_ID(無ければ apps/control/wrangler.jsonc の vars の CF_ACCOUNT_ID)
// R2 のバケットは apps/control/wrangler.jsonc の r2_buckets から読む。R2 の binding が無い導入では何もせずに終わる。
//
// 出力: 見つかった画像ごとに、サイトの ID・画像の ID・削除待ちか・配信中の設定でその画像を使っているサイト。最後に件数。
// 画像の名前・URL は出さない(ID で足りる)。配信中の設定は道具では直せないので、挙がったサイトで画像を選び直して公開し直す。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listR2Keys, localObjectResult, r2ObjectExists, readBucketName, readDatabaseName, run } from "./lib.mjs";

const WRANGLER_CONFIG = "apps/control/wrangler.jsonc";
const DB_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const USAGE = `使い方(リポジトリのルートで): node tools/asset-r2-check/check.mjs [--db <D1 の名前>] [--apply] [--local [--persist-to <dir>]]
  --db          確かめる D1 の名前(既定は apps/control/wrangler.jsonc の d1_databases の先頭。読めなければ wtt-control)
  --apply       見つかった画像に印を付ける(書き込みの凍結が入っていなければ止まる)。付けなければ見るだけ
  --local       手元の D1・R2(wrangler の --local)で試す。道具の動作の確かめ用
  --persist-to  --local のときの手元の保存先(wrangler の --persist-to)`;

function fail(message) {
  console.error(`asset-r2-check: ${message}`);
  process.exit(1);
}

/** 子のプロセスの wrangler。ログのファイルを書かせない(D1 の中身やコマンドがログに残らないように) */
function wrangler(root, args) {
  const r = spawnSync("pnpm", ["-C", "apps/control", "exec", "wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false" },
  });
  if (r.error) throw new Error(`wrangler を起動できませんでした: ${r.error.message}`);
  return r;
}

/** 失敗した子のプロセスの出力の末尾だけを、トークンを伏せて返す */
function tail(text, token) {
  const s = String(text ?? "").trim().split("\n").slice(-8).join("\n");
  return token ? s.split(token).join("***") : s;
}

function accountId(root, config) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const m = config.match(/"CF_ACCOUNT_ID"\s*:\s*"([0-9a-f]{32})"/);
  return m?.[1];
}

function main() {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      options: {
        db: { type: "string" },
        apply: { type: "boolean", default: false },
        local: { type: "boolean", default: false },
        "persist-to": { type: "string" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts["persist-to"] !== undefined && !opts.local) fail("--persist-to は --local と一緒に使います");

  const root = process.cwd();
  const configPath = join(root, WRANGLER_CONFIG);
  if (!existsSync(configPath)) fail(`${WRANGLER_CONFIG} が見つかりません。リポジトリのルートで流してください`);
  const config = readFileSync(configPath, "utf8");
  const bucket = readBucketName(config);
  // D1 の名前の既定は control の設定から読む(控えから読み戻した導入で、既定のまま古い D1 を見ないように)
  opts.db ??= readDatabaseName(config) ?? "wtt-control";
  if (!DB_NAME_RE.test(opts.db)) fail(`D1 の名前の形が想定と違います: ${opts.db}`);

  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const where = opts.local ? ["--local", ...(opts["persist-to"] ? ["--persist-to", resolve(root, opts["persist-to"])] : [])] : ["--remote"];

  /** D1 に 1 文を流し、wrangler の --json の出力(文ごとの { results, meta } の配列)の先頭の results を返す */
  const execute = (sql) => {
    const r = wrangler(root, ["d1", "execute", opts.db, ...where, "--json", "--command", sql]);
    if (r.status !== 0) throw new Error(`D1 の実行に失敗しました(${opts.db}):\n${tail(r.stdout || r.stderr, token)}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error(`D1 の応答を読めませんでした(${opts.db}):\n${tail(r.stdout, token)}`);
    }
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!first || !Array.isArray(first.results)) throw new Error(`D1 の応答の形が想定と違います(${opts.db})`);
    return first.results;
  };

  /** 手元の R2 にキーがあるか(wrangler r2 object get --local。無いとはっきり分かるときだけ false、読めないときは止める) */
  const localObjectExists = (key) => localObjectResult(wrangler(root, ["r2", "object", "get", `${bucket}/${key}`, "--pipe", ...where]));

  const deps = {
    bucket,
    preflight: () => {
      if (opts.local) return;
      if (!token) throw new Error("CLOUDFLARE_API_TOKEN が設定されていません(R2 の一覧を読むのに使います)。deploy.md のバックアップ・復旧の節の「画像の中身の確かめ」の関数 r2check から流してください(wrangler login のトークンを、値を出さずにその実行の中だけで入れます。それで R2 の一覧を読めないときは、同じ節の「別のトークンを使うとき」)");
      if (!accountId(root, config)) throw new Error(`アカウント ID が見つかりません。CLOUDFLARE_ACCOUNT_ID を設定してください(または ${WRANGLER_CONFIG} の vars の CF_ACCOUNT_ID)`);
    },
    d1: async (sql) => execute(sql),
    // 本番は R2 の一覧を API で読む。手元(--local)は API から見えないので、行ごとに wrangler r2 object get で有無を確かめる
    listKeys: opts.local
      ? async (rows) => {
          const keys = new Set();
          for (const row of rows) if (localObjectExists(row.r2_key)) keys.add(row.r2_key);
          return { keys, pages: null };
        }
      : async () => listR2Keys({ fetch, accountId: accountId(root, config), bucket, token }),
    // 一覧に無かった画像を、印を付ける前に 1 つずつ確かめ直す
    objectExists: async (key) => (opts.local ? localObjectExists(key) : r2ObjectExists({ fetch, accountId: accountId(root, config), bucket, token, key })),
    now: () => Date.now(),
    log: (s) => console.log(s),
    error: (s) => console.error(`asset-r2-check: ${s}`),
  };
  // process.exit は出力のパイプを待たずに終わり、長い出力の末尾が切れうるので、終了コードだけを置いて自然に終わらせる
  return run({ apply: opts.apply, db: opts.db }, deps).then((code) => { process.exitCode = code; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
