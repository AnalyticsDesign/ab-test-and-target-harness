#!/usr/bin/env node
// run.mjs — 導入の日に人が作る Cloudflare の API トークンを「親トークン」1 本にし、残りのトークンをこのスクリプトが作る。
//
// 何をするか: 人が deploy-secrets.env の CF_BOOTSTRAP_TOKEN に貼った親トークンで、下の表の子のトークンを作り、
// 値を deploy-secrets.env に書く。子がそれぞれの届き先に届くことを確かめたら、親トークンを消して値の行を空にする。
// 作ったトークンの名前・ID・期限は記録ファイル(既定 deploy-tokens.json)に残し、打ち直したときは記録から続きを決める。
// 自動で決められない状態では、何も消さずにトークンの名前と ID を出して止まり、人とエージェントが次にすることを書く。
//
// 使い方(リポジトリのルートで):
//   CLOUDFLARE_ACCOUNT_ID=<ID> node tools/deploy-tokens/run.mjs --ident <識別子>                    # 通常
//   CLOUDFLARE_ACCOUNT_ID=<ID> node tools/deploy-tokens/run.mjs --ident <識別子> --reset            # 済む前に、作った子と親を消し、記録を消す
//                                                                                                 # (人が直接作る手順に切り替えるとき)
//   CLOUDFLARE_ACCOUNT_ID=<ID> node tools/deploy-tokens/run.mjs --ident <識別子> --parent-deleted   # 記録の親が消えたのを、人が一覧で見たとき
//                                                                                                 # (CF_BOOTSTRAP_TOKEN が空のときだけ効く。値があれば値で決める)
//   任意: --answers <path>(既定 deploy-answers.yaml)・--secrets <path>(既定 deploy-secrets.env)・
//         --record <path>(既定 deploy-tokens.json。同じ記録を使う実行は 1 つだけで、ロックは <record>.lock)
//
// 要るもの:
//   - CLOUDFLARE_ACCOUNT_ID: 導入先のアカウントの ID(32 桁の 16 進)
//   - deploy-answers.yaml: 構成を確定した答え(cloudflare_tokens が bootstrap のとき。--reset はほかの値でも打てる)
//   - deploy-secrets.env の CF_BOOTSTRAP_TOKEN: 人が作った親トークンの値
//     (Account API Tokens Write だけ・導入先のアカウントだけ・期限は翌日)
//   - wrangler のログイン: 要るゾーンがあるときだけ、ゾーンの ID を引くために
//     `pnpm -C apps/control exec wrangler auth token --json` の OAuth のトークンを使う(出力は画面にもログにも出さない)。
//     環境変数の CLOUDFLARE_API_TOKEN などは、この子のプロセスに渡さない(渡すと wrangler がログインの資格情報ではなくその値を返す)
//   - Node の組み込みだけで動く(npm の依存は無い)
//
// 呼ぶ API(https://api.cloudflare.com/client/v4。:id は CLOUDFLARE_ACCOUNT_ID):
//   親トークンで: GET  /accounts/:id/tokens/verify(親の確かめ)・GET /accounts/:id/tokens/<トークンの ID>(親の詳細)・
//                 GET  /accounts/:id/tokens/permission_groups・GET /accounts/:id/tokens(一覧)・
//                 POST /accounts/:id/tokens(子を作る)・
//                 DELETE /accounts/:id/tokens/<トークンの ID>(親。済む前の打ち直しと --reset では記録の子も)
//   OAuth のトークンで: GET /zones?name=<ゾーン名>(要るゾーンの ID)
//   子のトークンで(届き先の確かめ): GET /accounts/:id/tokens/verify・
//                 作業用 GET /zones/<ゾーンの ID>/rulesets/phases/http_ratelimit/entrypoint・
//                 デプロイ用 GET /accounts/:id/workers/scripts・使用状況用 POST /graphql
//
// 作るトークン(権限は API の権限グループの名前。画面の Edit は API では Write):
//   | 役割         | 名前                   | deploy-secrets.env の行 | 権限                                                      | 対象                                                | 期限 |
//   | 親(人が作る) | wtt-bootstrap-<識別子> | CF_BOOTSTRAP_TOKEN      | Account API Tokens Write                                  | com.cloudflare.api.account.<アカウントの ID>        | 人が翌日にする(確かめの上限は今から 48 時間) |
//   | 作業用       | wtt-setup-<識別子>     | CF_TOKEN                | Zone Read・DNS Read・Cache Settings Write・Zone WAF Write | 要るゾーンごとに com.cloudflare.api.account.zone.<ゾーンの ID> | 作成から 24 時間 |
//   | デプロイ用   | wtt-deploy-<識別子>    | CF_DEPLOY_TOKEN         | Workers Scripts Write                                     | com.cloudflare.api.account.<アカウントの ID>        | なし |
//   | 使用状況用   | wtt-usage-<識別子>     | CF_USAGE_TOKEN          | Account Analytics Read                                    | com.cloudflare.api.account.<アカウントの ID>        | なし |
//   識別子は docs/deploy.md の 0.5 の「Cloudflare の API トークンの名前」のとおり。
//   作業用は、要るゾーン(zone_name か、control・管理画面を自分のドメインに置くときのホストのゾーン)があるときだけ作る。
//
// 出力(標準出力。トークンの値・OAuth のトークン・作った人のメールアドレスは出さない):
//   token <role> name=<name> id=<id> expires=<ISO|none>   … 記録の子 1 本ごとに 1 行
//   parent <state> name=<name|none> id=<id|none>          … 親の状態(same・deleted・none など)
//   (人とエージェントが次にすることの文。止まったときは、最後に親トークンの値が漏れたときの手順を指す 1 行)
//   deploy-tokens: done | deploy-tokens: human | deploy-tokens: error   … 最後の 1 行
// 想定外の例外では、例外の型と場所(ファイルと行)だけを出す(例外の文・API の応答の本文は出さない)。
// ただし値を含まない文として作った例外(値のファイル・記録を書き換えられなかったときの案内)は、その文を出す。
//
// 終了コード: 0 = done(済んだ)/ 3 = human(人の確かめが要る)/ 1 = error・使い方の誤り /
//             130・143 = SIGINT・SIGTERM で止めた(ロックは外す)
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseAnswers } from "../deploy-answers/parse.mjs";
import { checkConfigured, isConfigured } from "../deploy-answers/questions.mjs";
import { createCf } from "./lib/cf.mjs";
import { execute } from "./lib/flow.mjs";
import { tokenName } from "./lib/spec.mjs";

/** リポジトリのルート(想定外の例外の場所を、ここからの相対の path で出す) */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `使い方(リポジトリのルートで): CLOUDFLARE_ACCOUNT_ID=<ID> node tools/deploy-tokens/run.mjs --ident <識別子> [--reset | --parent-deleted]
  --ident           トークンの名前の末尾に付ける識別子(小文字・数字・ハイフンの 1〜63 文字)
  --reset           済む前に、作った子と親を消し、記録を消す(人が直接作る手順に切り替えるとき)
  --parent-deleted  記録の親が消えたのを、人が一覧で見たとき(CF_BOOTSTRAP_TOKEN が空のときだけ効く)
  --answers <path>  答えのファイル(既定 deploy-answers.yaml)
  --secrets <path>  値のファイル(既定 deploy-secrets.env)
  --record <path>   記録ファイル(既定 deploy-tokens.json。ロックは <record>.lock)`;

/** 止まったとき(human・error)の最後に出す、親トークンの値が漏れたときの手順の場所 */
const LEAK_LINE = "親トークンの値が漏れたときは、docs/deploy.md の 0.5 の「親トークンの値が漏れたとき」の手順に従う。";

const EXIT = Object.freeze({ done: 0, human: 3, error: 1 });
const SIGNALS = Object.freeze([["SIGINT", 130], ["SIGTERM", 143]]);
const ACCOUNT_ID_RE = /^[0-9a-fA-F]{32}$/;
/** io に必ず要る関数 */
const IO_FUNCS = Object.freeze(["fetch", "sleep", "now", "write", "spawnSync"]);

/** wrangler の子のプロセスを待つ上限 */
const WRANGLER_TIMEOUT_MS = 120000;

// ---- 出力 ----

/** Outcome を出力の行にする(値を含む欄は Outcome に無い) */
function renderOutcome(outcome) {
  const status = Object.hasOwn(EXIT, outcome.status) ? outcome.status : "error";
  const out = [];
  for (const tk of outcome.tokens ?? []) out.push(`token ${tk.role} name=${tk.name} id=${tk.id} expires=${tk.expires_on ?? "none"}`);
  const p = outcome.parent;
  if (p) out.push(`parent ${p.state} name=${p.name ?? "none"} id=${p.id ?? "none"}`);
  out.push(...(outcome.lines ?? []));
  if (status !== "done") out.push(LEAK_LINE);
  out.push(`deploy-tokens: ${status}`);
  return { status, text: `${out.join("\n")}\n` };
}

/** 想定外の例外: 型と場所(ファイルと行)だけ。例外の文は値や応答の断片を含みうるので出さない */
function describeUnexpected(e) {
  // 値を含まない文として作られた例外(safeMessage の印。値のファイル・記録の書き換えの失敗の案内など)は、その文を出す
  if (e instanceof Error && typeof e.safeMessage === "string" && e.safeMessage !== "") {
    const msg = /。$/.test(e.safeMessage) ? e.safeMessage : `${e.safeMessage}。`;
    return [msg, "途中まで進めたものがあるかもしれない。打ち直すと、記録とトークンの一覧から続きを決める。"];
  }
  const type = e instanceof Error ? (typeof e.name === "string" && /^[A-Za-z]+$/.test(e.name) ? e.name : "Error") : e === null ? "null" : typeof e;
  return [`想定外の例外で止まった(${type}、${placeOf(e)})。途中まで進めたものがあるかもしれない。同じコマンドを打ち直す(記録とトークンの一覧から続きを決める)。同じ所で止まり続けるなら、この行(例外の型と場所)を添えて報告する。`];
}

/** スタックの最初のファイルの場所。文の行(1 行目)は読まず、"at …(<path>:<行>:<列>)" の形の行だけを見る */
function placeOf(e) {
  const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : "";
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s+at (?:.*?\()?(file:\/\/[^\s()]+|\/[^\s()]+|[A-Za-z]:\\[^\s()]+):(\d+):\d+\)?$/.exec(line);
    if (!m) continue;
    let p = m[1];
    try {
      if (p.startsWith("file://")) p = fileURLToPath(p);
    } catch {
      continue;
    }
    const rel = relative(ROOT, p);
    const shown = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : basename(p);
    return `${shown} の ${m[2]} 行目`;
  }
  return "場所は不明";
}

// ---- wrangler の OAuth のトークン ----

const codedError = (code) => Object.assign(new Error(code), { code });

const WRANGLER_CMD = "pnpm";
const WRANGLER_ARGS = Object.freeze(["-C", "apps/control", "exec", "wrangler", "auth", "token", "--json"]);
/** wrangler auth token --json の答えを、ログインの OAuth のトークンから別の値に変える環境変数 */
const WRANGLER_CREDENTIAL_ENV = Object.freeze(["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"]);

/**
 * `pnpm -C apps/control exec wrangler auth token --json` の token を読む関数を返す(最初の 1 回だけ子のプロセスを起こす)。
 * 標準出力・標準エラーは継がずに受け取り、どこにも出さない。読めなければ中身を含まない code だけの例外を投げる
 */
function wranglerOauth(io, env) {
  let cached = null;
  return async () => {
    if (cached) return cached;
    // env に API トークン・API キーがあると、wrangler はログインの OAuth のトークンではなくその値を返すので、子に渡さない
    const childEnv = { ...env, WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false" };
    for (const k of WRANGLER_CREDENTIAL_ENV) delete childEnv[k];
    const options = {
      cwd: io.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: io.platform === "win32",
      windowsHide: true,
      timeout: WRANGLER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: childEnv,
    };
    // Windows は pnpm が .cmd なので shell を通す。引数の配列と shell を一緒に渡すと Node が警告するので、1 本の文字列で渡す
    const r = io.platform === "win32"
      ? io.spawnSync([WRANGLER_CMD, ...WRANGLER_ARGS].join(" "), options)
      : io.spawnSync(WRANGLER_CMD, WRANGLER_ARGS, options);
    if (!r || r.error) throw codedError("WRANGLER_NOT_STARTED");
    if (r.status !== 0) throw codedError("WRANGLER_AUTH_FAILED");
    const text = String(r.stdout ?? "").trim();
    if (text === "") throw codedError("WRANGLER_AUTH_EMPTY");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 例外の文は入力の断片を含むので使わない
      throw codedError("WRANGLER_AUTH_NOT_JSON");
    }
    // wrangler login の資格情報(oauth)だけを使う
    if (!parsed || parsed.type !== "oauth") throw codedError("WRANGLER_AUTH_NOT_OAUTH");
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    if (token === "") throw codedError("WRANGLER_AUTH_NO_TOKEN");
    cached = token;
    return token;
  };
}

// ---- 引数・環境変数・答え ----

/** 使い方の誤りなら { problems }、通れば { opts, accountId, values, label } */
function readInputs(argv, env, io) {
  let opts;
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        ident: { type: "string" },
        reset: { type: "boolean", default: false },
        "parent-deleted": { type: "boolean", default: false },
        answers: { type: "string" },
        secrets: { type: "string" },
        record: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // parseArgs の文は引数をそのまま含むので使わない
    return { problems: ["引数を読めなかった(知らない引数か、値の要る引数に値が無い)。"] };
  }
  if (opts.help) return { help: true };
  if (opts.reset && opts["parent-deleted"]) {
    return { problems: ["--reset と --parent-deleted は一緒に使えない。どちらか一方だけを付けて打ち直す。"] };
  }
  if (typeof opts.ident !== "string" || opts.ident === "") return { problems: ["--ident <識別子> が要る。"] };
  try {
    tokenName("parent", opts.ident);
  } catch (e) {
    return { problems: [`--ident: ${e.message}`] };
  }

  const rawId = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof rawId !== "string" || rawId === "") {
    return { problems: ["環境変数 CLOUDFLARE_ACCOUNT_ID が無い。導入先のアカウントの ID を入れて打つ。"] };
  }
  if (!ACCOUNT_ID_RE.test(rawId)) {
    return { problems: ["環境変数 CLOUDFLARE_ACCOUNT_ID の形が違う(32 桁の 16 進で書く)。"] };
  }

  const label = opts.answers ?? "deploy-answers.yaml";
  let text;
  try {
    text = readFileSync(resolve(io.cwd, label), "utf8");
  } catch (e) {
    const code = e && typeof e.code === "string" ? e.code : "unknown";
    return { problems: [code === "ENOENT" ? `${label} が見つからない。リポジトリのルートで打つか、--answers で場所を渡す。` : `${label} を読めなかった(${code})。`] };
  }
  const { values, errors } = parseAnswers(text);
  if (errors.length) return { problems: errors.map((x) => `${label} の ${x.line} 行目: ${x.message}`) };
  if (!isConfigured(values)) {
    return { problems: [`${label} の構成が決まっていない。deploy-answers を --accept 付きで打って構成を確定してから打つ。`] };
  }
  const issues = checkConfigured(values);
  if (issues.length) return { problems: issues.map((x) => `${label} の ${x.key}: ${x.message}`) };
  // cloudflare_tokens が bootstrap かは流れが記録の状態と合わせて決める(子を確かめた後の記録は、書き換えた後でも済むまで進める)
  return { opts, accountId: rawId.toLowerCase(), values };
}

// ---- 入口 ----

/**
 * @param {string[]} argv 引数(node と run.mjs の path を除いたもの)
 * @param {Record<string, string|undefined>} env 環境変数
 * @param {{ cwd: string, platform: string, fetch: typeof fetch, sleep: (ms: number) => Promise<void>, now: () => Date,
 *   write: (text: string) => void, spawnSync: Function, onSignals?: (release: () => void, info: { lock: string }) => () => void,
 *   fsOps?: object }} io 外とのやり取りのすべて(既定は持たない。本物は processIo())
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv, env, io) {
  // io に既定は無い(足りないまま本物の fetch などに落ちないよう、先に断る)
  const missing = IO_FUNCS.filter((k) => typeof io?.[k] !== "function");
  if (missing.length || typeof io.cwd !== "string") {
    throw new Error(`main の io が足りない(${[...missing, ...(typeof io?.cwd === "string" ? [] : ["cwd"])].join("・")})`);
  }
  const print = (lines) => io.write(`${lines.join("\n")}\n`);
  try {
    const input = readInputs(argv, env, io);
    if (input.help) {
      print([USAGE]);
      return 0;
    }
    if (input.problems) {
      print([...input.problems, USAGE, "deploy-tokens: error"]);
      return EXIT.error;
    }
    const { opts, accountId, values } = input;
    const record = resolve(io.cwd, opts.record ?? "deploy-tokens.json");
    const files = { secrets: resolve(io.cwd, opts.secrets ?? "deploy-secrets.env"), record, lock: `${record}.lock` };
    const ctx = {
      cf: createCf({ fetch: io.fetch, sleep: io.sleep, accountId, now: io.now }),
      oauthToken: wranglerOauth(io, env),
      files,
      fsOps: io.fsOps,
      answers: values,
      ident: opts.ident,
      accountId,
      now: io.now,
      sleep: io.sleep,
      args: { reset: opts.reset, parentDeleted: opts["parent-deleted"] },
      onSignals: typeof io.onSignals === "function" ? (release) => io.onSignals(release, { lock: files.lock }) : undefined,
    };
    const { status, text } = renderOutcome(await execute(ctx));
    io.write(text);
    return EXIT[status];
  } catch (e) {
    print([...describeUnexpected(e), LEAK_LINE, "deploy-tokens: error"]);
    return EXIT.error;
  }
}

/**
 * 本物の io。シグナルの扱いもここが持つ: SIGINT・SIGTERM でロックを外し、止めたことを書いて 130・143 で終わる。
 * 終わる直前の出力は writeSync で書く(process.exit がパイプへの書き込みを待たないため)
 */
export function processIo() {
  return {
    cwd: process.cwd(),
    platform: process.platform,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    write: (text) => { process.stdout.write(text); },
    spawnSync: nodeSpawnSync,
    onSignals: (release, { lock }) => {
      const handlers = new Map();
      for (const [sig, code] of SIGNALS) {
        const handler = () => {
          let released = true;
          try { release(); } catch { released = false; }
          const head = released
            ? `${sig} で途中で止めた。ロックは外した。`
            : `${sig} で途中で止めた。ロックを外せなかった(動いている実行が無ければ、このファイルを消す: ${lock})。`;
          const text = [
            head,
            "同じコマンドを打ち直す(途中で作ったトークンは、記録の印とトークンの一覧から確かめて進む。決められないときは名前と ID を出して止まる)。",
            LEAK_LINE,
            "deploy-tokens: error",
          ].join("\n");
          try { writeSync(1, `${text}\n`); } catch { /* 出力先が閉じていても終わる */ }
          process.exit(code);
        };
        handlers.set(sig, handler);
        process.on(sig, handler);
      }
      return () => { for (const [sig, h] of handlers) process.removeListener(sig, h); };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // process.exit は出力のパイプを待たずに終わり、長い出力の末尾が切れうるので、終了コードだけを置いて自然に終わらせる
  main(process.argv.slice(2), process.env, processIo()).then((code) => { process.exitCode = code; });
}
