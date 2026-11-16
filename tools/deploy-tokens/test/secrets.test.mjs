// deploy-secrets.env の読み書きのテスト(B130 Task 3)。一時ディレクトリだけを使う。値は短い偽の値だけ
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecrets, setSecret, clearSecret, checkSecretsForm } from "../lib/secrets.mjs";

const isWin = process.platform === "win32";

/** テストごとの一時ディレクトリ。終わったら消す */
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tokens-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "deploy-secrets.env") };
}

const tempsIn = (dir) => readdirSync(dir).filter((n) => n.includes(".tmp-"));

test("read_secrets_null_when_absent", (t) => {
  const { file } = tmp(t);
  assert.equal(readSecrets(file), null);
});

test("read_secrets_strips_cr_and_skips_comments", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "# c\r\n\r\nGOOGLE_CLIENT_ID=a\r\nCF_TOKEN=\nnot a line\n");
  const m = readSecrets(file);
  assert.deepEqual([...m.entries()], [["GOOGLE_CLIENT_ID", "a"], ["CF_TOKEN", ""]]);
});

test("set_secret_keeps_other_lines_and_comments", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "# c\nGOOGLE_CLIENT_ID=a\r\nCF_TOKEN=\n");
  setSecret(file, "CF_TOKEN", "v");
  assert.equal(readFileSync(file, "utf8"), "# c\nGOOGLE_CLIENT_ID=a\r\nCF_TOKEN=v\n");
});

test("set_secret_appends_missing_key_and_adds_newline_first", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "GOOGLE_CLIENT_ID=a");
  setSecret(file, "CF_TOKEN", "v");
  assert.equal(readFileSync(file, "utf8"), "GOOGLE_CLIENT_ID=a\nCF_TOKEN=v\n");
});

test("set_secret_keeps_crlf_on_replaced_line", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=old\r\n");
  setSecret(file, "CF_TOKEN", "a.b_c~d+e/f=g-h");
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=a.b_c~d+e/f=g-h\r\n");
});

// Task 6a: 値の文字は [A-Za-z0-9._~+/=-] だけ($ などの置換の文字はもう書けない)。断る文に値を入れない
test("set_secret_rejects_chars_outside_token_charset_without_echoing", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=old\n");
  for (const v of ["zq$&zq", "zq zq", "\"zqzq\"", "zq'zq", "zq#zq", "zq\tzq"]) {
    assert.throws(() => setSecret(file, "CF_TOKEN", v), (e) => !String(e.message).includes("zq") && !String(e.stack).includes("zq"), JSON.stringify(v));
  }
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=old\n");
});

// Task 6a: 流れが使うキーの行の厳しい形の検査。返すのはキーと行の番号だけ
test("check_secrets_form_reports_key_and_line_only", (t) => {
  const { file } = tmp(t);
  assert.deepEqual(checkSecretsForm(file, ["CF_TOKEN"]), [], "ファイルが無ければ問題なし");
  writeFileSync(file, [
    "# CF_TOKEN=\"x\"", // コメントは見ない
    "export CF_TOKEN=zq",
    "CF_DEPLOY_TOKEN =zq",
    "CF_USAGE_TOKEN=\"zq\"",
    "CF_BOOTSTRAP_TOKEN=zq\r",
    "OTHER=\"free form\"",
    "CF_TOKEN=",
    "CF_USAGE_TOKEN=zq\rzq",
  ].join("\n") + "\n");
  const got = checkSecretsForm(file, ["CF_BOOTSTRAP_TOKEN", "CF_TOKEN", "CF_DEPLOY_TOKEN", "CF_USAGE_TOKEN"]);
  assert.deepEqual(got, [
    { key: "CF_TOKEN", line: 2 },
    { key: "CF_DEPLOY_TOKEN", line: 3 },
    { key: "CF_USAGE_TOKEN", line: 4 },
    { key: "CF_USAGE_TOKEN", line: 8 },
  ], "CRLF の行(5 行目)・空の値(7 行目)・ほかのキー(6 行目)は通る");
  assert.ok(!JSON.stringify(got).includes("zq"));
});

test("set_secret_replaces_every_duplicate_line", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=a\nX=1\nCF_TOKEN=b\n");
  setSecret(file, "CF_TOKEN", "v");
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=v\nX=1\nCF_TOKEN=v\n");
});

test("set_secret_rejects_newline_in_value_without_echoing_it", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=\n");
  assert.throws(() => setSecret(file, "CF_TOKEN", "zq\nzq"), (e) => !String(e.message).includes("zq") && !String(e.stack).includes("zq"));
  assert.throws(() => setSecret(file, "CF_TOKEN", "zq\rzq"), (e) => !String(e.message).includes("zq"));
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=\n");
});

test("set_secret_rejects_bad_key", (t) => {
  const { file } = tmp(t);
  assert.throws(() => setSecret(file, "BAD KEY", "v"));
  assert.throws(() => setSecret(file, "", "v"));
});

test("set_secret_creates_0600_and_tightens_wide_mode", { skip: isWin }, (t) => {
  const { dir, file } = tmp(t);
  setSecret(file, "CF_TOKEN", "v");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const wide = join(dir, "wide.env");
  writeFileSync(wide, "CF_TOKEN=\n");
  chmodSync(wide, 0o644);
  setSecret(wide, "CF_TOKEN", "v");
  assert.equal(statSync(wide).mode & 0o777, 0o600);
  assert.equal(readFileSync(wide, "utf8"), "CF_TOKEN=v\n");
});

test("set_secret_tightens_wide_mode_before_write_even_if_rename_fails", { skip: isWin }, (t) => {
  // rename が失敗しても、ほかの秘密が入った元のファイルが広い権限のまま残らない(書く前に直す)
  const { file } = tmp(t);
  writeFileSync(file, "GOOGLE_CLIENT_SECRET=s\nCF_TOKEN=\n");
  chmodSync(file, 0o644);
  const ops = { ...fs, renameSync: () => { const e = new Error("x"); e.code = "EBUSY"; throw e; } };
  assert.throws(() => setSecret(file, "CF_TOKEN", "v", { ops }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("set_secret_is_atomic", (t) => {
  const { dir, file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=\n");
  // 本物の fs を包み、目的のファイルへ直接書かず、一時ファイルからの rename で置き換えることを見る
  const calls = [];
  const ops = {
    ...fs,
    writeFileSync: (p, ...rest) => { calls.push(["write", String(p)]); return fs.writeFileSync(p, ...rest); },
    renameSync: (a, b) => { calls.push(["rename", String(a), String(b)]); return fs.renameSync(a, b); },
  };
  setSecret(file, "CF_TOKEN", "v", { ops });
  assert.ok(!calls.some((c) => c[0] === "write" && c[1] === file), "目的のファイルに直接書いていない");
  const renames = calls.filter((c) => c[0] === "rename");
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], `${file}.tmp-${process.pid}`);
  assert.equal(renames[0][2], file);
  assert.deepEqual(tempsIn(dir), []);
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=v\n");
});

test("set_secret_removes_temp_on_failure", (t) => {
  const { dir, file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=old\n");
  const ops = { ...fs, renameSync: () => { const e = new Error("EBUSY: resource busy"); e.code = "EBUSY"; throw e; } };
  const secret = "zqzqzq";
  assert.throws(() => setSecret(file, "CF_TOKEN", secret, { ops }), (e) => {
    assert.ok(!String(e.message).includes(secret), "message に値が無い");
    assert.ok(!String(e.stack).includes(secret), "stack に値が無い");
    assert.ok(!String(e.message).includes("エディタ"), "Windows 以外では、エディタの案内を出さない");
    return true;
  });
  assert.deepEqual(tempsIn(dir), []);
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=old\n", "元の中身は変わらない");
});

test("set_secret_rename_refused_on_windows_mentions_editor", (t) => {
  const { dir, file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=\n");
  const ops = { ...fs, renameSync: () => { const e = new Error("EPERM: operation not permitted"); e.code = "EPERM"; throw e; } };
  assert.throws(() => setSecret(file, "CF_TOKEN", "zqzq", { ops, platform: "win32" }), (e) => {
    assert.match(e.message, /エディタを閉じて打ち直す/);
    assert.ok(!e.message.includes("zqzq"));
    return true;
  });
  assert.deepEqual(tempsIn(dir), []);
});

test("set_secret_removes_stale_temp_files", (t) => {
  const { dir, file } = tmp(t);
  writeFileSync(file, "CF_TOKEN=\n");
  writeFileSync(`${file}.tmp-999999`, "CF_TOKEN=left\n");
  writeFileSync(join(dir, "other.tmp-1"), "keep");
  setSecret(file, "CF_TOKEN", "v");
  assert.deepEqual(tempsIn(dir), ["other.tmp-1"], "ほかのファイルの一時ファイルは触らない");
  assert.equal(readFileSync(file, "utf8"), "CF_TOKEN=v\n");
});

test("clear_secret_keeps_key_line", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "# c\nCF_BOOTSTRAP_TOKEN=x\nCF_TOKEN=y\r\n");
  clearSecret(file, "CF_BOOTSTRAP_TOKEN");
  assert.equal(readFileSync(file, "utf8"), "# c\nCF_BOOTSTRAP_TOKEN=\nCF_TOKEN=y\r\n");
});

test("clear_secret_clears_every_duplicate_line", (t) => {
  const { file } = tmp(t);
  writeFileSync(file, "CF_BOOTSTRAP_TOKEN=x\nCF_BOOTSTRAP_TOKEN=y\n");
  clearSecret(file, "CF_BOOTSTRAP_TOKEN");
  assert.equal(readFileSync(file, "utf8"), "CF_BOOTSTRAP_TOKEN=\nCF_BOOTSTRAP_TOKEN=\n");
});

test("clear_secret_noop_when_file_or_line_absent", (t) => {
  const { dir, file } = tmp(t);
  clearSecret(file, "CF_TOKEN");
  assert.deepEqual(readdirSync(dir), [], "ファイルを作らない");
  writeFileSync(file, "X=1");
  clearSecret(file, "CF_TOKEN");
  assert.equal(readFileSync(file, "utf8"), "X=1", "行が無ければ書き換えない");
});
