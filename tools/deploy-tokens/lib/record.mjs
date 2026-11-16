// 記録ファイル deploy-tokens.json(作ったトークンの名前・ID・期限と進み具合。値は入れない)の読み書き、
// 親の値の指紋、同じフォルダで 1 つだけ動かすためのロック、DELETE を許す ID の集合。
// 例外の文には、パス・pid・時刻・ID だけを入れる。ファイルの中身(JSON の断片)は入れない。
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { writeFileAtomic, removeStaleTemps } from "./secrets.mjs";

/**
 * @typedef {{ name: string, id: string|null, expires_on: string|null, created_at: string|null }} Child
 * @typedef {"setup"|"deploy"|"usage"} Role
 * @typedef {{
 *   version: 1, account_id: string, parent_id: string|null, parent_fp: string|null,
 *   pending: Role|null, pending_at: string|null,
 *   children: { setup?: Child, deploy?: Child, usage?: Child },
 *   children_checked_at: string|null, parent_deleted_at: string|null,
 * }} Record
 */

export const RECORD_VERSION = 1;
const ROLES = ["setup", "deploy", "usage"];

// --- 記録ファイル ---

/**
 * 記録を読む。ファイルが無ければ null。JSON が壊れている・形が違うときは、中身を含まない文で投げる(握りつぶさない)。
 * @returns {Record | null}
 */
export function readRecord(path, { ops = nodeFs } = {}) {
  let text;
  try {
    text = ops.readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    // SyntaxError の文は入力の断片を含むので、使わない(cause にも付けない)
    throw new Error(`記録ファイル ${path} の JSON が壊れている。手で直したなら元に戻すか、導入のやり直しの手順に従う`);
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    throw new Error(`記録ファイル ${path} の形が違う(オブジェクトでない)`);
  }
  if (rec.version !== RECORD_VERSION) {
    throw new Error(`記録ファイル ${path} の version が ${RECORD_VERSION} でない。このスクリプトの版では読めない`);
  }
  return rec;
}

/** 記録を書く(`<path>.tmp-<pid>` に 0600 で書いてから rename) */
export function writeRecord(path, rec, { ops = nodeFs, platform = process.platform } = {}) {
  removeStaleTemps(path, ops);
  writeFileAtomic(path, `${JSON.stringify(rec, null, 2)}\n`, { ops, platform, label: `記録ファイル ${basename(path)}` });
}

/** 記録を消す。無ければ何もしない */
export function removeRecord(path, { ops = nodeFs } = {}) {
  try {
    ops.unlinkSync(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
}

/**
 * 記録の上で済んでいるか。子を確かめた時刻と親を消した時刻の 2 つだけを見る。
 * (済んだと言うには、さらに親の値の行が空で、済んだ後の確かめを通ることが要る。それは流れの側で見る)
 */
export function isDone(rec) {
  return Boolean(rec && rec.children_checked_at && rec.parent_deleted_at);
}

// --- 指紋 ---

/** 値の SHA-256 の 16 進の先頭 16 文字。記録に書く(値には戻せない)。出力には出さない */
export function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16);
}

// --- ロック ---

const toIso = (now) => new Date(typeof now === "function" ? now() : now).toISOString();
const sameOwner = (a, b) => Boolean(a && b && a.pid === b.pid && a.started_at === b.started_at);

/** O_EXCL で作って中身を書く。既にあれば false */
function tryCreate(path, content, ops) {
  let fd;
  try {
    fd = ops.openSync(path, "wx", 0o600);
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    throw e;
  }
  try {
    ops.writeSync(fd, content);
  } finally {
    ops.closeSync(fd);
  }
  return true;
}

/**
 * ロックの中身を読む。無ければ { state: "absent" }。
 * 読めない・形が違う(作った直後で中身がまだ無い場合を含む)ときは { state: "unreadable" }。死んだとは見ない。
 */
function readLock(path, ops) {
  let text;
  try {
    text = ops.readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent" };
    throw e;
  }
  let v;
  try { v = JSON.parse(text); } catch { return { state: "unreadable" }; }
  if (!v || typeof v !== "object" || !Number.isSafeInteger(v.pid) || v.pid <= 0 || typeof v.started_at !== "string") {
    return { state: "unreadable" };
  }
  return { state: "held", owner: { pid: v.pid, started_at: v.started_at } };
}

/** pid のプロセスが動いているか。ESRCH だけを「動いていない」とする(EPERM などは動いている扱い) */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === "ESRCH");
  }
}

const removeHint = (path) => `動いている実行が無ければ、このファイルを消して打ち直す: ${path}`;
// 再起動の後などで別のプロセスが同じ pid を使うと、終わるのを待っても抜けられないので、消してよい条件と消し方を添える
const heldError = (lockPath, owner) => new Error(
  `同じフォルダで別の実行が動いている(pid ${owner.pid}、開始 ${owner.started_at})。終わるのを待ってから打ち直す。` +
  `その pid がこのスクリプトの実行でない(再起動の後などで、別のプロセスが同じ pid を使っている)と分かっていて、${removeHint(lockPath)}`,
);

/**
 * 同じ記録ファイルを使う実行を 1 つにするロックを取る。
 * 取れなければ、中の pid のプロセスが動いているかを見る。動いていれば止まる(pid が使い回されていても止まる側に倒れる)。
 * 動いていなければ、回収用のロック `<lockPath>.reap` を取ってから、中身が同じ pid と時刻のままのときだけ外して取り直す。
 * opts.ops はファイル操作の差し替え口(テストで操作の順を差し込むため)。
 * @returns {{ release: () => void, removedStale: { pid: number, started_at: string } | null }}
 */
export function acquireLock(lockPath, now, { ops = nodeFs } = {}) {
  const me = { pid: process.pid, started_at: toIso(now) };
  const content = JSON.stringify(me);
  const release = () => {
    // 自分の pid と時刻のときだけ外す(後から取った実行のロックを外さない)
    const cur = readLock(lockPath, ops);
    if (cur.state !== "held" || !sameOwner(cur.owner, me)) return;
    try { ops.unlinkSync(lockPath); } catch (e) { if (!(e && e.code === "ENOENT")) throw e; }
  };

  // 外されたのを読む間に取り合いが起きることがあるので、数回だけ試す
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockPath, content, ops)) return { release, removedStale: null };
    const seen = readLock(lockPath, ops);
    if (seen.state === "absent") continue;
    if (seen.state === "unreadable") {
      throw new Error(`ロックのファイルの中身を読めない(別の実行が作った直後かもしれない)。少し待って打ち直す。続くときは、${removeHint(lockPath)}`);
    }
    if (isAlive(seen.owner.pid)) throw heldError(lockPath, seen.owner);

    // 動いていない実行のロック。回収用のロックを取ってから外す
    const reapPath = `${lockPath}.reap`;
    if (!tryCreate(reapPath, content, ops)) {
      throw new Error(`別の実行が古いロックを回収している。打ち直す。続くときは、${removeHint(reapPath)}`);
    }
    let created = false;
    let after;
    try {
      after = readLock(lockPath, ops);
      // 死んだと見たときと同じ中身のときだけ外す(その間に別の実行が取り直していれば、それは外さない)
      if (after.state === "held" && sameOwner(after.owner, seen.owner)) ops.unlinkSync(lockPath);
      created = tryCreate(lockPath, content, ops);
    } finally {
      try { ops.unlinkSync(reapPath); } catch { /* 外せなければ、次の実行が案内の文で止まる */ }
    }
    if (created) return { release, removedStale: { ...seen.owner } };
    const now2 = readLock(lockPath, ops);
    if (now2.state === "held") throw heldError(lockPath, now2.owner);
    throw new Error(`ロックを取り直せなかった。打ち直す。続くときは、${removeHint(lockPath)}`);
  }
  throw new Error(`ロックを取れなかった(取り合いが続いた)。打ち直す。続くときは、${removeHint(lockPath)}`);
}

// --- DELETE を許す ID の集合 ---

// この集合に入った値だけが「allowedDeleteIds が作った」印を持つ。WeakSet なので、写し・Proxy・作り直しでは印が付かない
const BRAND = new WeakSet();

function makeAllow(purpose, ids) {
  const allow = Object.freeze({ purpose, ids: Object.freeze([...ids]) });
  BRAND.add(allow);
  return allow;
}

/**
 * DELETE を送ってよい ID の集合を作る。トークンを消す関数は、ここで作った値しか受け付けない。
 * - "restart": 済む前の記録の子の ID すべて(ID が null の子は除く)。済んだ記録・記録が無いときは空
 * - "parent": 確かめを通った今の親の ID 1 つ(parentId)
 * @returns {Readonly<{ purpose: "restart"|"parent", ids: readonly string[] }>}
 */
export function allowedDeleteIds(rec, purpose, parentId) {
  if (purpose === "restart") {
    if (!rec || isDone(rec)) return makeAllow(purpose, []);
    const children = rec.children && typeof rec.children === "object" ? rec.children : {};
    const ids = [];
    for (const role of ROLES) {
      const id = children[role] && children[role].id;
      if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
    }
    return makeAllow(purpose, ids);
  }
  if (purpose === "parent") {
    if (typeof parentId !== "string" || parentId === "") throw new Error("消す親の ID が空");
    return makeAllow(purpose, [parentId]);
  }
  throw new Error(`DELETE を許す集合の用途が違う: ${String(purpose)}(restart か parent)`);
}

/** allowedDeleteIds が作った値か */
export function isDeleteAllow(x) {
  return (typeof x === "object" && x !== null) && BRAND.has(x);
}

/** allowedDeleteIds が作った値で、id を含むか。印の無い値には常に false */
export function allowIncludes(allow, id) {
  return isDeleteAllow(allow) && typeof id === "string" && allow.ids.includes(id);
}
