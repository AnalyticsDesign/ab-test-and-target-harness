// deploy-secrets.env(KEY=value の行だけのファイル)の読み書き。
// 値は秘密なので、例外の文・ログに値もファイルの中身も入れない。入れてよいのはキーの名前・パス・エラーの code だけ。
// 書き換えは、同じフォルダの一時ファイル(0600)に書いてから rename で置き換える(途中で止まっても元のファイルが半端にならない)。
// ほかの行・コメント・改行の形(CRLF の行)はそのまま残す。
import * as nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/** トークンの値に使える文字(空の値も通す)。引用符・空白・$ などは入らない */
const VALUE_RE = /^[A-Za-z0-9._~+/=-]*$/;

/** 1 行(改行の文字を除いた本体)が key の行か */
const isKeyLine = (body, key) => body.startsWith(`${key}=`);

/** ファイルを行に分ける。各行は { body, eol }(eol は "\r\n" / "\n" / "")。末尾の改行の後の空の行は作らない */
function splitLines(text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) { out.push({ body: text.slice(pos), eol: "" }); break; }
    const raw = text.slice(pos, nl);
    if (raw.endsWith("\r")) out.push({ body: raw.slice(0, -1), eol: "\r\n" });
    else out.push({ body: raw, eol: "\n" });
    pos = nl + 1;
  }
  return out;
}

const joinLines = (lines) => lines.map((l) => l.body + l.eol).join("");

/** ファイルを読む。無ければ null。ほかの読みの失敗はそのまま投げる(fs の文はパスと code だけで中身を含まない) */
function readText(path, ops) {
  try {
    return ops.readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** 前の実行が残した `<path>.tmp-*` を消す。消せないものは次の書き込みの邪魔にならないので、そのままにする */
export function removeStaleTemps(path, ops = nodeFs) {
  const dir = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  let names;
  try {
    names = ops.readdirSync(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
  for (const name of names) {
    if (!String(name).startsWith(prefix)) continue;
    try { ops.unlinkSync(join(dir, String(name))); } catch { /* 消せなくても、自分の一時ファイルは pid で別の名前になる */ }
  }
}

/**
 * text を path に置き換えで書く(一時ファイル `<path>.tmp-<pid>` に 0600 で書いて rename)。
 * 失敗したら一時ファイルを消し、中身を含まない文で投げる。
 * Windows で rename が断られたとき(エディタがファイルを開いている)は、閉じて打ち直すよう示す。
 */
export function writeFileAtomic(path, text, { ops = nodeFs, platform = process.platform, label = path } = {}) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    ops.writeFileSync(tmp, text, { mode: 0o600, flag: "w" });
    // 既に同じ名前の一時ファイルがあったときも 0600 にそろえる
    if (platform !== "win32") ops.chmodSync(tmp, 0o600);
    ops.renameSync(tmp, path);
  } catch (e) {
    try { ops.unlinkSync(tmp); } catch { /* 作る前に失敗したときは無い */ }
    const code = e && typeof e.code === "string" ? e.code : "unknown";
    const refused = platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code);
    const hint = refused
      ? "ほかのプログラム(エディタなど)がファイルを開いている。エディタを閉じて打ち直す"
      : "フォルダの権限と空き容量を確かめて打ち直す";
    // 元の例外の文は使わない(書こうとした中身の手がかりを残さないため)。code だけを写す
    const err = new Error(`${label} を書き換えられなかった(${code})。${hint}`);
    err.code = code;
    // 値を含まない文の印。入口は、想定外の例外のうちこの印のあるものだけ文を出す(ほかは型と場所だけ)
    err.safeMessage = err.message;
    throw err;
  }
}

/** ファイルの mode が 0600 より広ければ 0600 に直す(Windows では mode の意味が違うので見ない) */
function tightenMode(path, ops, platform) {
  if (platform === "win32") return;
  const st = ops.statSync(path);
  if ((st.mode & 0o077) !== 0) ops.chmodSync(path, 0o600);
}

/**
 * deploy-secrets.env を読む。ファイルが無ければ null。
 * KEY=value の行だけを採り、行末の CR を取り除く。コメント(#)・空行・形の違う行は無視する。同じキーが複数あれば後の行が勝つ。
 * @returns {Map<string, string> | null}
 */
export function readSecrets(path, { ops = nodeFs } = {}) {
  const text = readText(path, ops);
  if (text === null) return null;
  const map = new Map();
  for (const { body } of splitLines(text)) {
    if (body.trimStart().startsWith("#")) continue;
    const m = LINE_RE.exec(body);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** キーと値の形を確かめる。値は文に入れない */
function checkKeyValue(key, value) {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error("deploy-secrets.env のキーの形が違う(英字・数字・_ だけ、先頭は数字以外)");
  if (typeof value !== "string") throw new Error(`${key} の値が文字列でない`);
  if (/[\r\n]/.test(value)) throw new Error(`${key} の値に改行が入っている。1 行の値だけを書ける`);
  if (!VALUE_RE.test(value)) throw new Error(`${key} の値に使えない文字が入っている(使えるのは英数字と . _ ~ + / = - だけ)`);
}

/**
 * keys の行が厳しい形(`KEY=value`)かを確かめる。ファイルが無ければ空。
 * 前に `export ` が付く・行の頭や `=` の前後の空白・引用符で囲んだ値・値の前後の空白・値の中の CR のどれかがあれば、その行を返す。
 * 値の文字は英数字と . _ ~ + / = - だけ。空の値(`KEY=`)は通す。行末の CRLF は通す。コメント(#)の行とほかのキーの行は見ない。
 * readSecrets はこの形の外の行を読まない(値が空に見える)ので、流れは API を呼ぶ前にこれで止める。
 * @returns {{ key: string, line: number }[]} 形の違う行(line は 1 から)。値は入れない
 */
export function checkSecretsForm(path, keys, { ops = nodeFs } = {}) {
  for (const key of keys) if (!KEY_RE.test(key)) throw new Error("deploy-secrets.env のキーの形が違う(英字・数字・_ だけ、先頭は数字以外)");
  const text = readText(path, ops);
  if (text === null) return [];
  const out = [];
  splitLines(text).forEach(({ body }, i) => {
    if (body.trimStart().startsWith("#")) return;
    for (const key of keys) {
      // 空白・export・= の前の空白を許して、そのキーの行かを見る(キーは英字・数字・_ だけなので、そのまま正規表現に入れてよい)
      if (!new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(body)) continue;
      const strict = body.startsWith(`${key}=`) && VALUE_RE.test(body.slice(key.length + 1));
      if (!strict) out.push({ key, line: i + 1 });
    }
  });
  return out;
}

/**
 * key の行の値を value にする。行があれば(同じキーの行が複数あればすべて)値を置き換え、無ければ末尾に足す。
 * 始めに残った一時ファイルを消す。ファイルが無ければ 0600 で作り、あって 0600 より広ければ 0600 に直してから書く。
 * opts は差し替え口(テスト用): ops = fs の関数の組、platform = process.platform の代わり。
 */
export function setSecret(path, key, value, { ops = nodeFs, platform = process.platform } = {}) {
  checkKeyValue(key, value);
  removeStaleTemps(path, ops);
  const text = readText(path, ops);
  if (text !== null) tightenMode(path, ops, platform);
  const lines = text === null ? [] : splitLines(text);
  let found = false;
  for (const line of lines) {
    if (!isKeyLine(line.body, key)) continue;
    // 文字列の連結で作る(replace の置換文字列に値を渡すと $& などが効いてしまうため)
    line.body = `${key}=${value}`;
    found = true;
  }
  if (!found) {
    const last = lines[lines.length - 1];
    if (last && last.eol === "") last.eol = "\n";
    lines.push({ body: `${key}=${value}`, eol: "\n" });
  }
  writeFileAtomic(path, joinLines(lines), { ops, platform, label: basename(path) });
}

/**
 * key の行を残して値だけを空にする(同じキーの行が複数あればすべて)。ファイルも行も無ければ何もしない。
 */
export function clearSecret(path, key, { ops = nodeFs, platform = process.platform } = {}) {
  checkKeyValue(key, "");
  const text = readText(path, ops);
  if (text === null) return;
  const has = splitLines(text).some((l) => isKeyLine(l.body, key));
  if (!has) return;
  setSecret(path, key, "", { ops, platform });
}
