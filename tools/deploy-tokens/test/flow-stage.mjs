// 一本道の流れのテストの舞台(flow-new・flow-cells・flow-stops・flow-done の各 test.mjs が使う。B130 Task 6b・6c)。
// 偽の Cloudflare(fake-cf.mjs)と一時ディレクトリだけを使う。本物の Cloudflare にはつながない。
// - stage(): 偽物・一時ディレクトリ・答え・親トークン 1 本・fsOps の呼ばれた順の記録・fsOps の失敗の差し込み・要求の前の差し込み
// - scene(): 「記録の状態 × 親の値」の始めの状態を直接作る(表のマスのテスト用)
// - reachStopped()・parentDeleteUnknown(): 前の実行を止まりうる点の 5・6 で止める
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createFakeCf } from "./fake-cf.mjs";
import { createCf } from "../lib/cf.mjs";
import { execute, DEFAULT_FS_OPS } from "../lib/flow.mjs";
import { tokenName, ENV_KEY, PERMISSIONS } from "../lib/spec.mjs";
import { fingerprint, readRecord, allowedDeleteIds } from "../lib/record.mjs";
import { readSecrets } from "../lib/secrets.mjs";

export const AID = "0123456789abcdef0123456789abcdef";
export const IDENT = "quiet-river-1a2b";
export const ZID = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
export const LIST_PLACE = "Account API tokens(アカウント API トークン)の一覧";
export const ROLES = ["setup", "deploy", "usage"];

export const ROUTE = Object.freeze({ cloudflare_account: "new", edge_address: "route", zone_name: "example.com", control_address: "workers-dev", admin_address: "workers-dev" });
export const WORKERS_DEV = Object.freeze({ cloudflare_account: "new", edge_address: "workers-dev", control_address: "workers-dev", admin_address: "workers-dev" });

const PARENT_PERMS = ["Account API Tokens Write"];
export const NOT_BEFORE = "2026-11-13T15:00:00Z";
export const EXPIRES = "2026-11-15T14:59:59Z";
/** 作業用の期限(偽物の今の 24 時間後) */
const SETUP_EXPIRES = "2026-11-15T05:52:39Z";

export const childName = (role) => tokenName(role, IDENT);
export const parentName = tokenName("parent", IDENT);
export const joined = (out) => out.lines.join("\n");
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * @param {{ answers?, zones?, noParent?: boolean, parent?, secretsText?: string }} [o] secretsText = deploy-secrets.env の始めの中身(省けば 4 つのキーの行と、ほかの行 1 つ)
 */
export function stage(t, { answers = ROUTE, zones = [{ id: ZID, name: "example.com", status: "active" }], noParent = false, parent = {}, secretsText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-tokens-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { secrets: join(dir, "deploy-secrets.env"), record: join(dir, "deploy-tokens.json"), lock: join(dir, "deploy-tokens.json.lock") };
  const fake = createFakeCf({ accountId: AID, zones });
  const p = noParent ? null : fake.addToken({ name: parentName, permissions: PARENT_PERMS, not_before: NOT_BEFORE, expires_on: EXPIRES, ...parent });
  const oauth = fake.addOauth();

  /** deploy-secrets.env を書く(4 つのキーの行と、ほかの行 1 つ) */
  const setSecrets = (vals = {}) => {
    const v = { CF_BOOTSTRAP_TOKEN: "", CF_TOKEN: "", CF_DEPLOY_TOKEN: "", CF_USAGE_TOKEN: "", ...vals };
    writeFileSync(files.secrets, `GOOGLE_CLIENT_ID=abc\nCF_BOOTSTRAP_TOKEN=${v.CF_BOOTSTRAP_TOKEN}\nCF_TOKEN=${v.CF_TOKEN}\nCF_DEPLOY_TOKEN=${v.CF_DEPLOY_TOKEN}\nCF_USAGE_TOKEN=${v.CF_USAGE_TOKEN}\n`);
  };
  if (secretsText === undefined) setSecrets({ CF_BOOTSTRAP_TOKEN: p ? p.value : "" });
  else writeFileSync(files.secrets, secretsText);

  // fsOps の呼ばれた順と、失敗の差し込み(差し込んだ操作は、行う前に投げる)
  const calls = [];
  const fails = [];
  let prev = null;
  const describe = (op, a) => {
    if (op === "writeRecord") return { rec: clone(a[1]) };
    if (op === "setSecret") return { key: a[1], empty: a[2] === "" };
    if (op === "clearSecret") return { key: a[1] };
    return {};
  };
  const wrap = (op) => (...a) => {
    // at = この操作の時点までに送った要求の数(要求との前後を見るため)
    const entry = { op, at: fake.requests.length, ...describe(op, a) };
    const f = fails.find((x) => x.op === op && x.times > 0 && (!x.when || x.when(entry, prev)));
    prev = entry;
    calls.push(entry);
    if (f) {
      f.times--;
      throw new Error(`テストの差し込み: ${op} を失敗させた`);
    }
    return DEFAULT_FS_OPS[op](...a);
  };
  const fsOps = { ...DEFAULT_FS_OPS, writeRecord: wrap("writeRecord"), setSecret: wrap("setSecret"), clearSecret: wrap("clearSecret"), removeRecord: wrap("removeRecord") };

  // 要求の前の差し込み(遅れて成立した POST が一覧に見えるようになる、など)
  const hooks = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const info = { method: String(init.method ?? "GET").toUpperCase(), path: u.pathname };
    for (const h of hooks) h(info);
    return fake.fetch(url, init);
  };

  // ctx.sleep の呼ばれた時点(その時までの要求の数)を残す
  const sleepLog = [];
  const sleep = async (ms) => { sleepLog.push({ ms, at: fake.requests.length }); await fake.sleep(ms); };

  // OAuth の値を求めた回数(要るゾーンが無ければ 0)
  let oauthCalls = 0;
  const run = (args = {}, over = {}) => execute({
    cf: createCf({ fetch, sleep: fake.sleep, accountId: AID, now: fake.now }),
    oauthToken: async () => { oauthCalls++; return oauth; },
    files,
    fsOps,
    answers,
    ident: IDENT,
    accountId: AID,
    now: fake.now,
    sleep,
    args: { reset: false, parentDeleted: false, ...args },
    ...over,
  });

  const s = {
    dir, files, fake, parent: p, oauth, calls, run, setSecrets, sleepLog,
    /** getter(scene() の戻りのように広げると、その時点の数に固まる) */
    get oauthCalls() { return oauthCalls; },
    secrets: () => readSecrets(files.secrets),
    secretsText: () => readFileSync(files.secrets, "utf8"),
    record: () => readRecord(files.record),
    recordText: () => (existsSync(files.record) ? readFileSync(files.record, "utf8") : null),
    writeRecordFile: (rec) => writeFileSync(files.record, `${JSON.stringify(rec, null, 2)}\n`),
    /** fsOps の op を times 回だけ失敗させる。when(今の呼び出し, 前の呼び出し) で絞れる */
    failFs: (op, when, { times = 1 } = {}) => fails.push({ op, when, times }),
    /** n 回目のトークンの一覧の要求(この時点から数える)の直前に fn を呼ぶ */
    beforeList: (n, fn) => {
      let seen = 0;
      hooks.push((i) => {
        if (i.method === "GET" && /\/accounts\/[^/]+\/tokens$/.test(i.path) && ++seen === n) fn();
      });
    },
    /** DELETE を送った ID(順) */
    deleteIds: (fromSeq = 0) => fake.requests.filter((r) => r.route === "deleteToken" && r.seq > fromSeq).map((r) => r.id),
    lastSeq: () => (fake.requests.length ? fake.requests[fake.requests.length - 1].seq : 0),
    count: (route, fromSeq = 0) => fake.requests.filter((r) => r.route === route && r.seq > fromSeq).length,
  };
  return s;
}

/** 役割の子のトークンを偽物に置く(画面で作ったのと同じ形) */
export function seedChildren(s, roles = ROLES) {
  const out = {};
  for (const role of roles) {
    const tk = s.fake.addToken({
      name: childName(role),
      permissions: PERMISSIONS[role].map(([n]) => n),
      zoneIds: role === "setup" ? [ZID] : [],
      expires_on: role === "setup" ? SETUP_EXPIRES : null,
    });
    out[role] = { id: tk.id, value: tk.value, name: tk.name };
  }
  return out;
}

/** 記録の中身を作る */
export function recordOf({ parentId = null, parentFp = null, kids = {}, checked = false, deleted = false, pending = null, pendingAt = null }) {
  const children = {};
  for (const [role, k] of Object.entries(kids)) {
    children[role] = { name: k.name, id: k.id, expires_on: role === "setup" ? SETUP_EXPIRES : null, created_at: "2026-11-14T05:00:00Z" };
  }
  return {
    version: 1,
    account_id: AID,
    parent_id: parentId,
    parent_fp: parentFp,
    pending,
    pending_at: pendingAt,
    children,
    children_checked_at: checked || deleted ? "2026-11-14T05:10:00Z" : null,
    parent_deleted_at: deleted ? "2026-11-14T05:11:00Z" : null,
  };
}

/**
 * 「記録の状態 × 親の値」の始めの状態を直接作る。
 * - rec: none(記録ファイルなし)/ before / checked / after(記録の親 P は消えている)
 * - value: none(CF_BOOTSTRAP_TOKEN が空)/ same(P の値)/ other(P と別の、確かめを通る親 Q の値)/ gone(消えた P の値。指紋は記録と同じ)
 * - roles: 記録の子の役割(rec が none のときは置かない)
 * - parentIdInRecord: 記録に P の ID と指紋を書くか
 */
export function scene(t, { rec = "none", value = "none", roles = ROLES, parentIdInRecord = true, answers, pending = null, pendingAt = null } = {}) {
  const s = stage(t, answers ? { answers } : {});
  const P = s.parent;
  const kids = rec === "none" ? {} : seedChildren(s, roles);
  if (rec !== "none") {
    s.writeRecordFile(recordOf({
      parentId: parentIdInRecord ? P.id : null,
      parentFp: parentIdInRecord ? fingerprint(P.value) : null,
      kids,
      checked: rec === "checked",
      deleted: rec === "after",
      pending,
      pendingAt,
    }));
  }
  if (rec === "after" || value === "gone") s.fake.removeToken(P.id);
  let Q = null;
  if (value === "other") Q = s.fake.addToken({ name: parentName, permissions: PARENT_PERMS, not_before: NOT_BEFORE, expires_on: EXPIRES });
  const parentValue = value === "same" || value === "gone" ? P.value : value === "other" ? Q.value : "";
  s.setSecrets({
    CF_BOOTSTRAP_TOKEN: parentValue,
    ...Object.fromEntries(Object.entries(kids).map(([role, k]) => [ENV_KEY[role], k.value])),
  });
  return { ...s, P, Q, kids };
}

/**
 * DELETE を送った ID が、始めの記録の allowedDeleteIds(restart)と、確かめを通った親の ID の中にあるか。
 * expectDeletes を渡したときは、DELETE の数も見る(0 回のマスで空回りしないため)
 */
export function assertDeletesAllowed(s, rec0, parentId, { fromSeq = 0, expectDeletes } = {}) {
  const allow = new Set(rec0 ? allowedDeleteIds(rec0, "restart").ids : []);
  if (parentId) allow.add(parentId);
  const sent = s.deleteIds(fromSeq);
  for (const id of sent) assert.ok(allow.has(id), `DELETE を送った ID ${id} が集合の外`);
  if (expectDeletes !== undefined) assert.equal(sent.length, expectDeletes, `DELETE の数: ${sent.join(", ")}`);
}

export const AUTH_ERROR = Object.freeze({ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null } });

/** 届き先で止まった状態(止まりうる点 5): 子がそろい、children_checked_at なし、親は生きている */
export async function reachStopped(t, opts = {}) {
  const s = stage(t, opts);
  s.fake.failReach(opts.answers === WORKERS_DEV ? "workerScripts" : "ruleset", 4, AUTH_ERROR);
  const out = await s.run();
  assert.equal(out.status, "human", joined(out));
  return s;
}

/** 親の DELETE の後の verify が通信の失敗になるようにする(止まりうる点 6 で止める) */
export function failVerifyAfterParentDelete(s) {
  const pid = s.parent.id;
  s.fake.inject({
    route: "verify",
    match: (e) => e.tokenId === pid && s.fake.count({ route: "deleteToken", match: (d) => d.id === pid }) > 0,
    action: { type: "networkError" },
  });
}

/** 止まりうる点 6: 親の DELETE を送った後で止まる。alive = DELETE がサーバーに届かなかった(親は生きている) */
export async function parentDeleteUnknown(t, { alive }) {
  const s = stage(t);
  const sel = { route: "deleteToken", match: (e) => e.id === s.parent.id };
  if (alive) s.fake.networkErrorNext(sel);
  else s.fake.dropNext(sel);
  failVerifyAfterParentDelete(s);
  const out = await s.run();
  assert.equal(out.status, "error", joined(out));
  // 親の DELETE は送った後なので「何も変えていない」と言わない(最終レビュー Minor 4)
  assert.match(joined(out), /親の DELETE は送った。親の記録と CF_BOOTSTRAP_TOKEN の値は変えていない/);
  assert.ok(!/何も変えていない/.test(joined(out)), joined(out));
  const rec = s.record();
  assert.ok(rec.children_checked_at);
  assert.equal(rec.parent_deleted_at, null);
  assert.ok(s.secrets().get("CF_BOOTSTRAP_TOKEN"), "親の値は残る");
  assert.equal(Boolean(s.fake.token(s.parent.id)), alive);
  return s;
}
