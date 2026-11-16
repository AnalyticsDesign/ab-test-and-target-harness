// 入口 run.mjs のテスト。main(argv, env, io) をこのプロセスの中で呼び、io の fetch は偽の Cloudflare(fake-cf.mjs)、
// spawnSync は偽の wrangler auth token --json(呼ばれた引数を残す)に差し替える。本物の Cloudflare・wrangler・pnpm は呼ばない。
// シグナルのテストだけは、test/signal-child.mjs を子のプロセスの node で動かし、途中で SIGINT・SIGTERM を送る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../run.mjs";
import { acquireLock, writeRecord } from "../lib/record.mjs";
import { stage, scene, AID, IDENT, childName, parentName } from "./flow-stage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const ROUTE_YAML = [
  "cloudflare_account: new",
  "edge_address: route",
  "install_host: www.example.com",
  "zone_name: example.com",
  "asset_public_base: none",
  "control_address: workers-dev",
  "admin_address: workers-dev",
  "plan: free",
  "owner_email: owner@example.com",
  "accepted: recommended",
  "",
].join("\n");
const WORKERS_DEV_YAML = ROUTE_YAML.replace("edge_address: route\ninstall_host: www.example.com\nzone_name: example.com\n", "edge_address: workers-dev\n");

const LEAK_POINTER = /docs\/deploy\.md の 0\.5 の「親トークンの値が漏れたとき」/;
const SENTINEL = "SENTINEL_wrangler_output_must_not_show";

/**
 * 舞台(flow-stage の stage)に答えのファイルを足し、main を呼べるようにする。
 * spawnStdout = 偽の wrangler auth token --json の標準出力(関数なら呼ばれるたびに値を返す)
 */
function bench(t, { yaml = ROUTE_YAML, noParent = false, spawnStdout, spawnStatus = 0, sceneOpts } = {}) {
  const s = sceneOpts ? scene(t, sceneOpts) : stage(t, { noParent });
  writeFileSync(join(s.dir, "deploy-answers.yaml"), yaml);
  const spawns = [];
  let text = "";
  const io = {
    cwd: s.dir,
    platform: "linux",
    fetch: s.fake.fetch,
    sleep: s.fake.sleep,
    now: s.fake.now,
    write: (chunk) => { text += chunk; },
    // POSIX は (cmd, args, opts)、Windows は (1 本のコマンドの文字列, opts) で呼ばれる
    spawnSync: (cmd, a, b) => {
      const [args, opts] = Array.isArray(a) ? [a, b] : [null, a];
      spawns.push({ cmd, args, opts });
      const out = spawnStdout === undefined ? JSON.stringify({ type: "oauth", token: s.oauth }) : spawnStdout;
      return { status: spawnStatus, stdout: out, stderr: `${SENTINEL} stderr`, error: undefined };
    },
  };
  const env = { CLOUDFLARE_ACCOUNT_ID: AID };
  return {
    s, io, env, spawns,
    get out() { return text; },
    reset() { text = ""; },
    run: (argv = ["--ident", IDENT], over = {}) => main(argv, over.env ?? env, { ...io, ...over.io }),
  };
}

/** rename を EBUSY で断る fs で記録を書く(Windows でエディタが開いているときの形) */
function writeRecordWith(path, rec, platform) {
  const ops = {
    writeFileSync, chmodSync: () => {}, unlinkSync: () => {}, readdirSync: () => [],
    renameSync: () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); },
  };
  return writeRecord(path, rec, { ops, platform });
}

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

/** 出してはいけない値(親・子の値、OAuth の値、親の指紋、作った人のメールアドレス) */
function assertNoValues(b, text) {
  const secrets = b.s.secrets();
  const values = [b.s.parent && b.s.parent.value, b.s.oauth, ...["CF_BOOTSTRAP_TOKEN", "CF_TOKEN", "CF_DEPLOY_TOKEN", "CF_USAGE_TOKEN"].map((k) => secrets[k])].filter((v) => typeof v === "string" && v !== "");
  for (const v of values) assert.ok(!text.includes(v), "出してはいけない値が出た");
  const rec = b.s.record();
  if (rec && rec.parent_fp) assert.ok(!text.includes(rec.parent_fp), "親の指紋が出た");
  assert.doesNotMatch(text, /creator_email_at_creation|token_suffix|creator@example\.com/);
}

test("missing_account_id_is_usage_error", async (t) => {
  const b = bench(t);
  assert.equal(await b.run(undefined, { env: {} }), 1);
  assert.match(b.out, /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(lastLine(b.out), "deploy-tokens: error");
  b.reset();
  assert.equal(await b.run(undefined, { env: { CLOUDFLARE_ACCOUNT_ID: "0123" } }), 1);
  assert.match(b.out, /32 桁の 16 進/);
  assert.equal(b.s.fake.requests.length, 0);
  assert.equal(existsSync(b.s.files.lock), false);
  // 大文字の 16 進は小文字に直して通す
  b.reset();
  assert.equal(await b.run(undefined, { env: { CLOUDFLARE_ACCOUNT_ID: AID.toUpperCase() } }), 0);
  assert.equal(lastLine(b.out), "deploy-tokens: done");
});

test("non_bootstrap_mode_is_usage_error", async (t) => {
  const b = bench(t, { yaml: `${ROUTE_YAML}cloudflare_tokens: manual-account\n` });
  assert.equal(await b.run(), 1);
  assert.match(b.out, /cloudflare_tokens が manual-account なので、このスクリプトは使わない/);
  assert.equal(lastLine(b.out), "deploy-tokens: error");
  assert.equal(b.s.fake.requests.length, 0);
  assert.equal(b.s.recordText(), null);
  // --parent-deleted でも同じ。--reset のときは流れに任せる(救済の手順に切り替えた後にも打つため)
  b.reset();
  assert.equal(await b.run(["--ident", IDENT, "--parent-deleted"]), 1);
  assert.equal(b.s.fake.requests.length, 0);
  b.reset();
  // 記録が無く親が生きている --reset: 親を消して done(救済の手順へ)
  assert.equal(await b.run(["--ident", IDENT, "--reset"]), 0);
  assert.doesNotMatch(b.out, /このスクリプトは使わない/);
  assert.equal(b.s.fake.count("deleteToken"), 1);
  assert.equal(lastLine(b.out), "deploy-tokens: done");
});

test("reset_and_parent_deleted_together_is_usage_error", async (t) => {
  const b = bench(t);
  assert.equal(await b.run(["--ident", IDENT, "--reset", "--parent-deleted"]), 1);
  assert.match(b.out, /--reset と --parent-deleted は一緒に使えない/);
  assert.equal(lastLine(b.out), "deploy-tokens: error");
  assert.equal(b.s.fake.requests.length, 0);
  assert.equal(existsSync(b.s.files.lock), false);
});

test("invalid_cloudflare_tokens_value_is_usage_error", async (t) => {
  const b = bench(t, { yaml: `${ROUTE_YAML}cloudflare_tokens: parent\n` });
  assert.equal(await b.run(), 1);
  assert.match(b.out, /cloudflare_tokens: 選択肢に無い値: parent/);
  assert.equal(lastLine(b.out), "deploy-tokens: error");
  assert.equal(b.s.fake.requests.length, 0);
});

test("other_usage_errors_stop_before_api", async (t) => {
  const cases = [
    { argv: [], re: /--ident/ },
    { argv: ["--ident", "Has.Dot"], re: /識別子は小文字・数字・ハイフンだけ/ },
    { argv: ["--ident", IDENT, "--bogus"], re: /使い方/ },
    { argv: ["--ident", IDENT, "--answers", "missing.yaml"], re: /missing\.yaml が見つからない/ },
  ];
  for (const c of cases) {
    const b = bench(t);
    assert.equal(await b.run(c.argv), 1, c.argv.join(" "));
    assert.match(b.out, c.re);
    assert.equal(lastLine(b.out), "deploy-tokens: error");
    assert.equal(b.s.fake.requests.length, 0);
  }
  // 答えの書式の誤り・構成が決まっていない・checkConfigured の問題
  for (const [yaml, re] of [
    ["edge_address route\n", /deploy-answers\.yaml の 1 行目: key: value の形になっていない/],
    ["cloudflare_account: new\nowner_email: owner@example.com\n", /構成が決まっていない/],
    [ROUTE_YAML.replace("asset_public_base: none\n", ""), /asset_public_base: 必須/],
  ]) {
    const b = bench(t, { yaml });
    assert.equal(await b.run(), 1);
    assert.match(b.out, re);
    assert.equal(b.s.fake.requests.length, 0);
  }
});

test("full_run_prints_names_ids_and_done", async (t) => {
  const b = bench(t);
  assert.equal(await b.run(), 0);
  const rec = b.s.record();
  const lines = b.out.trimEnd().split("\n");
  for (const role of ["setup", "deploy", "usage"]) {
    const c = rec.children[role];
    const exp = c.expires_on ?? "none";
    assert.ok(lines.includes(`token ${role} name=${childName(role)} id=${c.id} expires=${exp}`), role);
  }
  assert.ok(lines.includes(`parent deleted name=${parentName} id=${b.s.parent.id}`));
  assert.equal(lines.at(-1), "deploy-tokens: done");
  assert.doesNotMatch(b.out, LEAK_POINTER);
  assertNoValues(b, b.out);
  assert.ok(!b.out.includes(SENTINEL));
  // wrangler auth token --json を 1 回、出力を継がずに呼んだ
  assert.equal(b.spawns.length, 1);
  const sp = b.spawns[0];
  assert.equal(sp.cmd, "pnpm");
  assert.deepEqual(sp.args, ["-C", "apps/control", "exec", "wrangler", "auth", "token", "--json"]);
  assert.deepEqual(sp.opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(sp.opts.cwd, b.s.dir);
  assert.equal(sp.opts.shell, false);
  assert.equal(sp.opts.env.WRANGLER_WRITE_LOGS, "false");
  assert.equal(existsSync(b.s.files.lock), false);
});

test("workers_dev_run_does_not_spawn_wrangler_and_windows_uses_shell", async (t) => {
  const b = bench(t, { yaml: WORKERS_DEV_YAML });
  assert.equal(await b.run(), 0);
  assert.equal(b.spawns.length, 0);
  // Windows は shell: true で 1 本の文字列(引数の配列と shell: true を一緒に渡すと DEP0190 の警告が出る)
  const w = bench(t);
  assert.equal(await w.run(undefined, { io: { platform: "win32" } }), 0);
  assert.equal(w.spawns[0].opts.shell, true);
  assert.equal(w.spawns[0].cmd, "pnpm -C apps/control exec wrangler auth token --json");
  assert.equal(w.spawns[0].args, null);
});

test("human_exit_code_is_3", async (t) => {
  const b = bench(t, { noParent: true });
  assert.equal(await b.run(), 3);
  const lines = b.out.trimEnd().split("\n");
  assert.equal(lines.at(-1), "deploy-tokens: human");
  assert.match(lines.at(-2), LEAK_POINTER);
  assert.match(b.out, /CF_BOOTSTRAP_TOKEN に貼ってから、同じコマンドを打ち直す/);
  assert.ok(lines.includes(`parent none name=none id=none`));
});

test("second_run_in_same_folder_refuses", async (t) => {
  const b = bench(t);
  const held = acquireLock(b.s.files.lock, b.s.fake.now);
  t.after(() => held.release());
  const started = JSON.parse(readFileSync(b.s.files.lock, "utf8")).started_at;
  assert.equal(await b.run(), 1);
  assert.match(b.out, new RegExp(`pid ${process.pid}`));
  assert.ok(b.out.includes(started), "ロックを取った時刻が出る");
  assert.equal(lastLine(b.out), "deploy-tokens: error");
  assert.equal(b.s.fake.requests.length, 0);
  assert.equal(existsSync(b.s.files.lock), true, "ほかの実行のロックは外さない");
});

test("wrangler_auth_token_unreadable_is_error", async (t) => {
  const cases = [
    { stdout: `not json ${SENTINEL}`, code: "WRANGLER_AUTH_NOT_JSON" },
    { stdout: "", code: "WRANGLER_AUTH_EMPTY" },
    { stdout: JSON.stringify({ type: "oauth", note: SENTINEL }), code: "WRANGLER_AUTH_NO_TOKEN" },
    { stdout: JSON.stringify({ token: SENTINEL }), status: 1, code: "WRANGLER_AUTH_FAILED" },
  ];
  for (const c of cases) {
    const b = bench(t, { spawnStdout: c.stdout, spawnStatus: c.status ?? 0 });
    assert.equal(await b.run(), 1, c.code);
    const lines = b.out.trimEnd().split("\n");
    assert.equal(lines.at(-1), "deploy-tokens: error");
    assert.match(lines.at(-2), LEAK_POINTER);
    assert.match(b.out, new RegExp(`wrangler のログインの資格情報を読めなかった\\(${c.code}\\)`));
    assert.ok(!b.out.includes(SENTINEL), "wrangler の出力の中身を出さない");
    assert.equal(b.s.fake.count("createToken"), 0);
    assertNoValues(b, b.out);
  }
});

test("unexpected_exception_prints_type_and_place_only", async (t) => {
  // 流れの外に出る例外(記録の書き込みの失敗)を差し込む。例外の文に値に見立てた文字を入れ、出ないことを見る
  const b = bench(t);
  const secret = "VALUE_IN_MESSAGE_must_not_show";
  const fsOps = { writeRecord: () => { throw new TypeError(`broken ${secret}`); } };
  assert.equal(await b.run(undefined, { io: { fsOps } }), 1);
  assert.match(b.out, /想定外の例外で止まった\(TypeError、tools\/deploy-tokens\/test\/run\.test\.mjs の \d+ 行目\)/);
  assert.ok(!b.out.includes(secret));
  assert.doesNotMatch(b.out, /何も変えていない/);
  assertNoValues(b, b.out);
  const lines = b.out.trimEnd().split("\n");
  assert.equal(lines.at(-1), "deploy-tokens: error");
  assert.match(lines.at(-2), LEAK_POINTER);
  assert.equal(existsSync(b.s.files.lock), false);
  // Error でないものが投げられても、型だけを出す
  const c = bench(t);
  assert.equal(await c.run(undefined, { io: { fsOps: { writeRecord: () => { throw secret; } } } }), 1);
  assert.match(c.out, /想定外の例外で止まった\(string、場所は不明\)/);
  assert.ok(!c.out.includes(secret));
});

/** 子のプロセスで run.mjs の入口を動かし、最初の要求で止まったところでシグナルを送る */
async function interrupted(t, signal) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tokens-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "deploy-answers.yaml"), WORKERS_DEV_YAML);
  const parentValue = "fakeparentvalue0123456789abcdef";
  writeFileSync(join(dir, "deploy-secrets.env"), `CF_BOOTSTRAP_TOKEN=${parentValue}\nCF_TOKEN=\nCF_DEPLOY_TOKEN=\nCF_USAGE_TOKEN=\n`);
  const lock = join(dir, "deploy-tokens.json.lock");
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: AID };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [join(HERE, "signal-child.mjs"), "--ident", IDENT], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  // close を待つ(exit の後に届く標準出力を取りこぼさない)
  const exited = new Promise((resolve) => child.on("close", (code, sig) => resolve({ code, sig })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`子のプロセスが止まる所まで来なかった: ${err}`)); }, 10000);
    child.stderr.on("data", (d) => {
      err += d;
      if (err.includes("READY")) { clearTimeout(timer); resolve(); }
    });
  });
  assert.equal(existsSync(lock), true, "止まった時点ではロックがある");
  child.kill(signal);
  const r = await exited;
  return { ...r, out, lock, parentValue };
}

test("io_without_fetch_is_refused_before_anything", async (t) => {
  // io に既定は無い。fetch を渡し忘れても本物の Cloudflare に落ちない
  const b = bench(t);
  await assert.rejects(b.run(undefined, { io: { fetch: undefined } }), /main の io が足りない\(fetch\)/);
  assert.equal(b.s.fake.requests.length, 0);
  assert.equal(existsSync(b.s.files.lock), false);
});

// Windows では child.kill("SIGINT") が handler を呼ばずに子を終わらせるので、POSIX でだけ確かめる
test("sigint_releases_lock", { skip: process.platform === "win32" && "Windows ではシグナルを送って handler を呼べない" }, async (t) => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const r = await interrupted(t, signal);
    assert.equal(r.code, code, signal);
    assert.equal(existsSync(r.lock), false, `${signal} でロックが残った`);
    assert.match(r.out, new RegExp(`${signal} で途中で止めた`));
    assert.match(r.out, LEAK_POINTER);
    assert.equal(lastLine(r.out), "deploy-tokens: error");
    assert.ok(!r.out.includes(r.parentValue));
  }
});

test("wrangler_env_api_credentials_are_dropped_and_non_oauth_is_refused", async (t) => {
  // env の API トークン・API キーは wrangler auth token --json の答えを変える(oauth でなくなる)ので、子に渡さない
  const env = {
    CLOUDFLARE_ACCOUNT_ID: AID, CLOUDFLARE_API_TOKEN: "envtoken1", CF_API_TOKEN: "envtoken2", CLOUDFLARE_API_KEY: "envkey1",
    CF_API_KEY: "envkey2", CLOUDFLARE_EMAIL: "a@example.org", CF_EMAIL: "b@example.org", PATH: "/usr/bin",
  };
  const b = bench(t);
  assert.equal(await b.run(undefined, { env }), 0);
  const childEnv = b.spawns[0].opts.env;
  for (const k of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"]) {
    assert.equal(Object.hasOwn(childEnv, k), false, `${k} が子に渡った`);
  }
  assert.equal(childEnv.PATH, "/usr/bin");
  // oauth でない答え(env の値を返した、など)は断る。値は出さない
  for (const type of ["api_token", "api_key", undefined]) {
    const c = bench(t, { spawnStdout: JSON.stringify({ type, token: SENTINEL }) });
    assert.equal(await c.run(), 1, String(type));
    assert.match(c.out, /wrangler のログインの資格情報を読めなかった\(WRANGLER_AUTH_NOT_OAUTH\)/);
    assert.ok(!c.out.includes(SENTINEL));
    assert.equal(c.s.fake.count("zones"), 0, "oauth でない値で GET /zones を引かない");
    assert.equal(c.s.fake.count("createToken"), 0);
  }
});

test("mode_change_after_children_checked_does_not_dead_end", async (t) => {
  const MANUAL = `${WORKERS_DEV_YAML}cloudflare_tokens: manual-account\n`;
  // 後(済んだ後)で manual-account に書き換えて引数なし → 済んだ後の確かめに進む
  const after = bench(t, { yaml: MANUAL, sceneOpts: { rec: "after", value: "none", roles: ["deploy", "usage"] } });
  assert.equal(await after.run(), 0);
  assert.equal(lastLine(after.out), "deploy-tokens: done");
  assert.doesNotMatch(after.out, /このスクリプトは使わない/);
  assert.equal(after.s.fake.count("createToken"), 0);
  assert.equal(after.s.fake.count("deleteToken"), 0);
  // 確(子を確かめた後・親を消す前)で書き換えて引数なし → 親を消して済む
  const checked = bench(t, { yaml: MANUAL, sceneOpts: { rec: "checked", value: "same", roles: ["deploy", "usage"] } });
  assert.equal(await checked.run(), 0);
  assert.equal(lastLine(checked.out), "deploy-tokens: done");
  assert.deepEqual(checked.s.deleteIds(), [checked.s.P.id]);
  assert.equal(checked.s.fake.count("createToken"), 0);
  // 記録なしで manual-account → API 0 回で使い方の誤り
  const none = bench(t, { yaml: MANUAL });
  assert.equal(await none.run(), 1);
  assert.match(none.out, /cloudflare_tokens が manual-account なので、このスクリプトは使わない/);
  assert.equal(none.s.fake.requests.length, 0);
  // 前(子を確かめる前)で書き換えて引数なし → API 0 回で使い方の誤り(--reset を勧める)
  const before = bench(t, { yaml: MANUAL, sceneOpts: { rec: "before", value: "same", roles: ["deploy"] } });
  assert.equal(await before.run(), 1);
  assert.match(before.out, /--reset を付けて打つ/);
  assert.equal(before.s.fake.requests.length, 0);
});

test("value_free_fs_error_message_is_shown", async (t) => {
  // 値を含まない文として作られた例外(書き換えの失敗の案内)は、その文を出す。ほかの例外は型と場所だけ
  const b = bench(t);
  const fsOps = { writeRecord: (path, rec) => writeRecordWith(path, rec, "win32") };
  assert.equal(await b.run(undefined, { io: { fsOps } }), 1);
  assert.match(b.out, /記録ファイル deploy-tokens\.json を書き換えられなかった\(EBUSY\)。ほかのプログラム\(エディタなど\)がファイルを開いている。エディタを閉じて打ち直す。/);
  assert.doesNotMatch(b.out, /想定外の例外/);
  const lines = b.out.trimEnd().split("\n");
  assert.equal(lines.at(-1), "deploy-tokens: error");
  assert.match(lines.at(-2), LEAK_POINTER);
  assertNoValues(b, b.out);
});
