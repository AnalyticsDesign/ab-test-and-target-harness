// 記録ファイル・指紋・ロック・DELETE を許す ID の集合のテスト(B130 Task 3)。一時ディレクトリだけを使い、API は呼ばない
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRecord, writeRecord, removeRecord, isDone, fingerprint, acquireLock, allowedDeleteIds, isDeleteAllow, allowIncludes,
} from "../lib/record.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tokens-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, record: join(dir, "deploy-tokens.json"), lock: join(dir, "deploy-tokens.json.lock") };
}

/** 終わったプロセスの pid(kill(pid, 0) が ESRCH になる) */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid;
}

const child = (name, id) => ({ name, id, expires_on: null, created_at: id ? "2026-11-15T00:00:00.000Z" : null });
const baseRec = (over = {}) => ({
  version: 1, account_id: "0123456789abcdef0123456789abcdef", parent_id: "p1", parent_fp: "0123456789abcdef",
  pending: null, pending_at: null, children: {}, children_checked_at: null, parent_deleted_at: null, ...over,
});

const T1 = new Date("2026-11-15T01:00:00.000Z");
const T2 = new Date("2026-11-15T02:00:00.000Z");
const T3 = new Date("2026-11-15T03:00:00.000Z");

// --- 記録ファイル ---

test("read_record_null_when_absent", (t) => {
  const { record } = tmp(t);
  assert.equal(readRecord(record), null);
});

test("write_then_read_record_roundtrip", (t) => {
  const { dir, record } = tmp(t);
  const rec = baseRec({ children: { setup: child("wtt-setup-x", "c1"), deploy: child("wtt-deploy-x", null) } });
  writeRecord(record, rec);
  assert.deepEqual(readRecord(record), rec);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  if (process.platform !== "win32") assert.equal(fs.statSync(record).mode & 0o777, 0o600);
});

test("write_record_uses_temp_and_rename", (t) => {
  const { record } = tmp(t);
  const calls = [];
  const ops = { ...fs, renameSync: (a, b) => { calls.push([String(a), String(b)]); return fs.renameSync(a, b); } };
  writeRecord(record, baseRec(), { ops });
  assert.deepEqual(calls, [[`${record}.tmp-${process.pid}`, record]]);
});

test("write_record_removes_temp_on_failure", (t) => {
  const { dir, record } = tmp(t);
  const ops = { ...fs, renameSync: () => { const e = new Error("x"); e.code = "EBUSY"; throw e; } };
  assert.throws(() => writeRecord(record, baseRec(), { ops }));
  assert.deepEqual(readdirSync(dir), []);
});

test("read_record_corrupt_throws_without_content", (t) => {
  const { record } = tmp(t);
  writeFileSync(record, '{"version":1,"account_id":"zqzqzq"');
  assert.throws(() => readRecord(record), (e) => {
    assert.ok(!String(e.message).includes("zqzqzq"));
    assert.ok(!String(e.stack).includes("zqzqzq"));
    assert.equal(e.cause, undefined);
    return true;
  });
});

test("read_record_rejects_unknown_version", (t) => {
  const { record } = tmp(t);
  writeFileSync(record, JSON.stringify({ ...baseRec(), version: 2 }));
  assert.throws(() => readRecord(record), /version/);
  writeFileSync(record, "[]");
  assert.throws(() => readRecord(record));
});

test("remove_record_is_noop_when_absent", (t) => {
  const { record } = tmp(t);
  removeRecord(record);
  writeRecord(record, baseRec());
  removeRecord(record);
  assert.equal(existsSync(record), false);
});

test("is_done_needs_both_times", () => {
  assert.equal(isDone(null), false);
  assert.equal(isDone(baseRec()), false);
  assert.equal(isDone(baseRec({ children_checked_at: "t" })), false);
  assert.equal(isDone(baseRec({ parent_deleted_at: "t" })), false);
  assert.equal(isDone(baseRec({ children_checked_at: "t", parent_deleted_at: "t" })), true);
});

// --- 指紋 ---

test("fingerprint_is_16_hex_and_not_the_value", () => {
  const v = "abcdef0123";
  const fp = fingerprint(v);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.ok(!fp.includes(v));
  assert.equal(fingerprint(v), fp, "同じ値なら同じ指紋");
  assert.notEqual(fingerprint("abcdef0124"), fp);
});

// --- ロック ---

test("lock_with_live_pid_refuses", (t) => {
  const { lock } = tmp(t);
  const first = acquireLock(lock, T1);
  assert.equal(first.removedStale, null);
  assert.throws(() => acquireLock(lock, T2), (e) => {
    assert.ok(e.message.includes(String(process.pid)), "pid を含む");
    assert.ok(e.message.includes(T1.toISOString()), "時刻を含む");
    // pid が使い回されたときの抜け方(最終レビュー Minor 7)
    assert.ok(e.message.includes(`このファイルを消して打ち直す: ${lock}`), e.message);
    return true;
  });
  first.release();
  assert.equal(existsSync(lock), false);
  const again = acquireLock(lock, T2);
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), { pid: process.pid, started_at: T2.toISOString() });
  again.release();
});

test("stale_lock_with_dead_pid_is_removed", (t) => {
  const { dir, lock } = tmp(t);
  const pid = deadPid();
  writeFileSync(lock, JSON.stringify({ pid, started_at: T1.toISOString() }));
  const got = acquireLock(lock, T2);
  assert.deepEqual(got.removedStale, { pid, started_at: T1.toISOString() });
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), { pid: process.pid, started_at: T2.toISOString() });
  assert.equal(existsSync(`${lock}.reap`), false, "回収用のロックは外す");
  got.release();
  assert.deepEqual(readdirSync(dir), []);
});

test("concurrent_stale_lock_recovery_allows_only_one_owner", (t) => {
  // B が死んだロックの中身を読んだ直後に、A が回収を終えて取る。その後 B が .reap を取り、読み直しで A のロックを見て外さない
  const { lock } = tmp(t);
  const pid = deadPid();
  const stale = JSON.stringify({ pid, started_at: T1.toISOString() });
  writeFileSync(lock, stale);
  let a = null;
  let injected = false;
  const opsB = {
    ...fs,
    readFileSync: (p, ...rest) => {
      const out = fs.readFileSync(p, ...rest);
      if (!injected && String(p) === lock) { injected = true; a = acquireLock(lock, T2); }
      return out;
    },
  };
  assert.throws(() => acquireLock(lock, T3, { ops: opsB }), (e) => {
    assert.ok(e.message.includes(T2.toISOString()), "後の方は、A のロックの時刻を示して止まる");
    return true;
  });
  assert.ok(injected);
  assert.deepEqual(a.removedStale, { pid, started_at: T1.toISOString() });
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), { pid: process.pid, started_at: T2.toISOString() }, "A のロックが残る");
  assert.equal(existsSync(`${lock}.reap`), false);
  a.release();
});

test("concurrent_stale_lock_recovery_second_reaper_refused", (t) => {
  // A が .reap を取った直後に B が回収しようとする → B は .reap が取れずに止まる
  const { lock } = tmp(t);
  const pid = deadPid();
  writeFileSync(lock, JSON.stringify({ pid, started_at: T1.toISOString() }));
  let bError = null;
  const opsA = {
    ...fs,
    openSync: (p, ...rest) => {
      const fd = fs.openSync(p, ...rest);
      if (String(p) === `${lock}.reap` && bError === null) {
        try { acquireLock(lock, T3); bError = false; } catch (e) { bError = e; }
      }
      return fd;
    },
  };
  const a = acquireLock(lock, T2, { ops: opsA });
  assert.ok(bError instanceof Error, "B は止まる");
  assert.match(bError.message, /回収/);
  assert.match(bError.message, /動いている実行が無ければ、このファイルを消して打ち直す/);
  assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), { pid: process.pid, started_at: T2.toISOString() });
  assert.equal(existsSync(`${lock}.reap`), false);
  a.release();
});

test("leftover_reap_file_refuses_with_remove_hint", (t) => {
  const { lock } = tmp(t);
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), started_at: T1.toISOString() }));
  writeFileSync(`${lock}.reap`, "");
  assert.throws(() => acquireLock(lock, T2), (e) => {
    assert.ok(e.message.includes(`${lock}.reap`));
    assert.match(e.message, /動いている実行が無ければ、このファイルを消して打ち直す/);
    return true;
  });
  assert.equal(existsSync(lock), true, "ロックは外さない");
});

test("unreadable_lock_content_is_not_treated_as_dead", (t) => {
  const { lock } = tmp(t);
  for (const text of ["", "{", '{"pid":0,"started_at":"x"}', '{"pid":-1,"started_at":"x"}', '{"pid":"12","started_at":"x"}']) {
    writeFileSync(lock, text);
    assert.throws(() => acquireLock(lock, T2), /動いている実行が無ければ、このファイルを消して打ち直す/, text);
    assert.equal(readFileSync(lock, "utf8"), text, "外さない");
  }
});

test("release_does_not_remove_successor_lock", (t) => {
  const { lock } = tmp(t);
  const got = acquireLock(lock, T1);
  const successor = JSON.stringify({ pid: process.pid, started_at: T2.toISOString() });
  writeFileSync(lock, successor);
  got.release();
  assert.equal(readFileSync(lock, "utf8"), successor);
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), started_at: T1.toISOString() }));
  got.release();
  assert.equal(existsSync(lock), true, "pid が違えば外さない");
});

test("release_twice_is_safe", (t) => {
  const { lock } = tmp(t);
  const got = acquireLock(lock, T1);
  got.release();
  got.release();
  assert.equal(existsSync(lock), false);
});

// --- DELETE を許す ID の集合 ---

test("allowed_delete_ids_restart_has_all_recorded_children", () => {
  const rec = baseRec({ children: { setup: child("wtt-setup-x", "c1"), deploy: child("wtt-deploy-x", null), usage: child("wtt-usage-x", "c3") } });
  const allow = allowedDeleteIds(rec, "restart");
  assert.equal(isDeleteAllow(allow), true);
  assert.equal(allowIncludes(allow, "c1"), true);
  assert.equal(allowIncludes(allow, "c3"), true);
  assert.equal(allowIncludes(allow, null), false);
  assert.equal(allowIncludes(allow, "p1"), false, "親は restart に入らない");
  assert.deepEqual([...allow.ids].sort(), ["c1", "c3"]);
});

test("allowed_delete_ids_restart_is_empty_after_done", () => {
  const rec = baseRec({
    children: { setup: child("wtt-setup-x", "c1") }, children_checked_at: "2026-11-15T00:00:00.000Z", parent_deleted_at: "2026-11-15T00:00:00.000Z",
  });
  const allow = allowedDeleteIds(rec, "restart");
  assert.equal(isDeleteAllow(allow), true);
  assert.deepEqual([...allow.ids], []);
  assert.equal(allowIncludes(allow, "c1"), false);
  assert.deepEqual([...allowedDeleteIds(null, "restart").ids], [], "記録が無ければ空");
});

test("allowed_delete_ids_parent_is_one_id", () => {
  const allow = allowedDeleteIds(baseRec(), "parent", "p9");
  assert.equal(isDeleteAllow(allow), true);
  assert.deepEqual([...allow.ids], ["p9"]);
  assert.equal(allowIncludes(allow, "p1"), false);
  assert.throws(() => allowedDeleteIds(baseRec(), "parent"));
  assert.throws(() => allowedDeleteIds(baseRec(), "parent", ""));
  assert.throws(() => allowedDeleteIds(baseRec(), "other", "p9"));
});

test("allowed_delete_ids_is_frozen_and_unforgeable", () => {
  const allow = allowedDeleteIds(baseRec({ children: { setup: child("wtt-setup-x", "c1") } }), "restart");
  assert.ok(Object.isFrozen(allow));
  assert.ok(Object.isFrozen(allow.ids));
  assert.throws(() => { "use strict"; allow.ids.push("evil"); });
  assert.equal(allowIncludes(allow, "evil"), false);
  const forged = [
    new Set(["c1"]), ["c1"], { ids: ["c1"] }, { ...allow }, Object.create(allow), new Proxy(allow, {}),
    Object.assign(Object.create(Object.getPrototypeOf(allow)), allow), null, undefined, "c1",
  ];
  for (const f of forged) {
    assert.equal(isDeleteAllow(f), false);
    assert.equal(allowIncludes(f, "c1"), false);
  }
});
