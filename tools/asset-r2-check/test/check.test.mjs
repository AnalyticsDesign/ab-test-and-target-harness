// 画像の行と R2 の一覧を比べる道具のテスト。手元の偽の D1 の行と R2 の一覧だけを使い、子のプロセス(wrangler)も API も呼ばない
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findMissingObjects, markSql, activeRefsSql, readBucketName, readDatabaseName, listR2Keys, r2ObjectExists, run, ASSETS_SQL, FREEZE_SQL, localObjectResult,
} from "../lib.mjs";

const NOW = 1_800_000_000_000;
const row = (id, site, extra = {}) => ({ id, site_id: site, r2_key: `sites/${site}/images/${id}.png`, deleted_at: null, purge_marked_at: null, ...extra });
const A1 = "asset_aaaaaaaaa1";
const A2 = "asset_bbbbbbbbb2";
const A3 = "asset_ccccccccc3";

/** run に渡す偽の道具一式。D1 の読みは SQL の中身で振り分け、書き込み(UPDATE)は記録だけする */
function fakeDeps({ rows = [], keys = [], refs = [], frozen = true, bucket = "test-bucket", present = [] } = {}) {
  const out = [];
  const err = [];
  const writes = [];
  const reads = [];
  const rechecked = [];
  return {
    out, err, writes, reads, rechecked,
    deps: {
      bucket,
      preflight: () => {},
      listKeys: async () => ({ keys: new Set(keys), pages: 1 }),
      // 一覧に無かったキーを 1 つずつ確かめ直す。present に入れたキーだけ「在る」
      objectExists: async (key) => { rechecked.push(key); return present.includes(key); },
      d1: async (sql) => {
        // 印の文(書き込み)は記録だけして、印を付けた行の ID(RETURNING)を返す
        if (sql.startsWith("UPDATE")) {
          writes.push(sql);
          return [...sql.matchAll(/'(asset_[a-z0-9]{10})'/g)].map((m) => ({ id: m[1] }));
        }
        reads.push(sql);
        if (sql === ASSETS_SQL) return rows;
        if (sql === FREEZE_SQL) return [{ n: frozen ? 1 : 0 }];
        if (sql.includes("JOIN publishes")) return refs;
        throw new Error(`unexpected sql: ${sql}`);
      },
      now: () => NOW,
      log: (s) => out.push(s),
      error: (s) => err.push(s),
    },
  };
}

test("finds_rows_without_r2_object", () => {
  const rows = [row(A1, "site_a"), row(A2, "site_a"), row(A3, "site_b")];
  const keys = new Set([rows[0].r2_key, rows[2].r2_key]);
  assert.deepEqual(findMissingObjects(rows, keys).map((r) => r.id), [A2]);
});

test("ignores_purge_marked_rows", () => {
  // 印の付いた行(消す途中・墓標)は R2 に無くても出さない(定期処理が扱う)
  const rows = [row(A1, "site_a", { purge_marked_at: NOW - 1 }), row(A2, "site_a", { deleted_at: NOW - 5 })];
  assert.deepEqual(findMissingObjects(rows, new Set()).map((r) => r.id), [A2]);
  assert.match(ASSETS_SQL, /purge_marked_at IS NULL/);
});

test("reports_sites_whose_active_config_points_at_missing_image", async () => {
  const f = fakeDeps({
    rows: [row(A1, "site_a", { deleted_at: NOW - 10 }), row(A2, "site_b")],
    keys: [],
    refs: [{ asset_id: A1, site_id: "site_a" }],
  });
  const code = await run({ apply: false }, f.deps);
  assert.equal(code, 0);
  const text = f.out.join("\n");
  assert.match(text, new RegExp(`site_a.*${A1}.*削除待ち: はい.*配信中の設定で使っているサイト: site_a`));
  assert.match(text, new RegExp(`site_b.*${A2}.*削除待ち: いいえ.*配信中の設定で使っているサイト: なし`));
  assert.match(text, /2 件/);
  // 配信中の設定の照らしは 1 回の問い合わせで、サイトの中の参照だけを見る
  const refSql = f.reads.filter((s) => s.includes("JOIN publishes"));
  assert.equal(refSql.length, 1);
  assert.match(refSql[0], /s\.active_version = p\.version/);
  assert.match(refSql[0], /p\.kv_deleted = 0/);
  assert.match(refSql[0], /p\.site_id = m\.site_id/);
  assert.match(refSql[0], /instr\(p\.config_json, m\.asset_id\)/);
});

test("dry_run_writes_nothing", async () => {
  const f = fakeDeps({ rows: [row(A1, "site_a")], keys: [] });
  const code = await run({ apply: false }, f.deps);
  assert.equal(code, 0);
  assert.equal(f.writes.length, 0);
  // 見るだけでは凍結の印も読まない(凍結が無くても動く)
  assert.ok(!f.reads.includes(FREEZE_SQL));
  assert.match(f.out.join("\n"), /--apply/);
});

test("apply_builds_single_mark_statement", async () => {
  const sql = markSql([{ id: A1, site_id: "site_a" }, { id: A2, site_id: "site_b" }], NOW);
  assert.equal((sql.match(/UPDATE/g) ?? []).length, 1);
  assert.match(sql, new RegExp(`deleted_at = coalesce\\(deleted_at, ${NOW}\\)`)); // 既にあれば残す
  assert.match(sql, new RegExp(`purge_marked_at = ${NOW}`));
  assert.match(sql, new RegExp(`updated_at = ${NOW}`));
  assert.match(sql, /purge_marked_at IS NULL/);
  assert.match(sql, new RegExp(`\\('site_a', '${A1}'\\)`));
  assert.match(sql, new RegExp(`\\('site_b', '${A2}'\\)`));
  // 凍結が外れていれば書かない(読んだ後に外された場合の守り)
  assert.match(sql, /EXISTS \(SELECT 1 FROM instance_settings WHERE key = 'writeFreeze'\)/);
  assert.match(sql, /RETURNING id$/);

  const f = fakeDeps({ rows: [row(A1, "site_a"), row(A2, "site_b"), row(A3, "site_b")], keys: [row(A3, "site_b").r2_key] });
  const code = await run({ apply: true }, f.deps);
  assert.equal(code, 0);
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], new RegExp(A1));
  assert.match(f.writes[0], new RegExp(A2));
  assert.doesNotMatch(f.writes[0], new RegExp(A3));
  assert.match(f.out.join("\n"), /印を付けた画像: 2 件\(対象 2 件\)/);
});

test("apply_refuses_without_write_freeze", async () => {
  const f = fakeDeps({ rows: [row(A1, "site_a")], keys: [], frozen: false });
  const code = await run({ apply: true }, f.deps);
  assert.notEqual(code, 0);
  assert.equal(f.writes.length, 0);
  assert.match(f.err.join("\n"), /書き込みの凍結が入っていません/);
});

test("rejects_unexpected_asset_id_shapes", async () => {
  for (const bad of ["asset_ABCDEFGHIJ", "asset_short", "asset_aaaaaaaaa1'--", "x", ""]) {
    assert.throws(() => markSql([{ id: bad, site_id: "site_a" }], NOW), /画像の ID/);
    assert.throws(() => activeRefsSql([{ id: bad, site_id: "site_a" }]), /画像の ID/);
  }
  for (const bad of ["site'a", "", "a".repeat(65), "site a"]) {
    assert.throws(() => markSql([{ id: A1, site_id: bad }], NOW), /サイトの ID/);
  }
  assert.throws(() => markSql([{ id: A1, site_id: "site_a" }], Number.NaN), /時刻/);
  // 見つかった行に変な形の ID があれば、印を付けずに止める
  const f = fakeDeps({ rows: [row("asset_bad'id", "site_a")], keys: [] });
  const code = await run({ apply: true }, f.deps);
  assert.notEqual(code, 0);
  assert.equal(f.writes.length, 0);
});

test("noop_without_r2_binding", async () => {
  const f = fakeDeps({ bucket: null });
  let preflight = 0;
  f.deps.preflight = () => { preflight++; };
  const code = await run({ apply: true }, f.deps);
  assert.equal(code, 0);
  assert.equal(preflight, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.match(f.out.join("\n"), /R2 を使っていない導入です。確かめることはありません/);

  // wrangler.jsonc の読み方: binding が無い・行ごと注釈にした形は null
  assert.equal(readBucketName(`{ "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "my-assets" }] }`), "my-assets");
  assert.equal(readBucketName(`{\n  "r2_buckets": [\n    { "binding": "ASSETS", "bucket_name": "my-assets" }\n  ]\n}`), "my-assets");
  assert.equal(readBucketName(`{ "vars": {} }`), null);
  assert.equal(readBucketName(`{\n  // "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "my-assets" }],\n  "vars": {}\n}`), null);
});

test("paginates_r2_listing", async () => {
  const calls = [];
  const pages = {
    "": { result: [{ key: "sites/a/images/1.png" }, { key: "sites/a/thumbs/1.webp" }], result_info: { cursor: "c1", is_truncated: true } },
    // is_truncated を持たないページでも、続きのしるしがあれば次を読む
    c1: { result: [{ key: "sites/b/images/2.png" }], result_info: { cursor: "c2" } },
    // is_truncated が false でも、続きのしるしがあれば読む(余分に読む向きに倒す)
    c2: { result: [{ key: "sites/b/images/3.png" }], result_info: { cursor: "c3", is_truncated: false } },
    // 続きのしるしが無ければ終わり(is_truncated も無い形)
    c3: { result: [{ key: "sites/c/images/4.png" }], result_info: {} },
  };
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ u, auth: init.headers.Authorization });
    const body = pages[u.searchParams.get("cursor") ?? ""];
    return { ok: true, status: 200, json: async () => ({ success: true, ...body }) };
  };
  const { keys, pages: pageCount } = await listR2Keys({ fetch, accountId: "acc0123", bucket: "test-bucket", token: "fake-token-for-test" });
  assert.deepEqual([...keys].sort(), ["sites/a/images/1.png", "sites/a/thumbs/1.webp", "sites/b/images/2.png", "sites/b/images/3.png", "sites/c/images/4.png"]);
  assert.equal(calls.length, 4);
  assert.equal(pageCount, 4);
  assert.equal(calls[0].u.pathname, "/client/v4/accounts/acc0123/r2/buckets/test-bucket/objects");
  assert.equal(calls[0].u.searchParams.get("prefix"), "sites/");
  assert.equal(calls[0].auth, "Bearer fake-token-for-test");

  // 同じ続きのしるしが返り続けたら、止めて失敗にする(終わらない読みを避ける)
  const loop = async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: [], result_info: { cursor: "same", is_truncated: true } }) });
  await assert.rejects(listR2Keys({ fetch: loop, accountId: "acc0123", bucket: "test-bucket", token: "fake-token-for-test" }), /続き/);
});

test("output_has_no_secret_or_url", async () => {
  const token = "fake-token-for-test-0123456789abcdef";
  // API の失敗: 状態と API の文言だけを出し、トークンは出さない
  const denied = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: `Authentication error ${token}` }] }) });
  const e = await listR2Keys({ fetch: denied, accountId: "acc0123", bucket: "test-bucket", token }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.match(e.message, /403/);
  assert.ok(!e.message.includes(token));

  // ふつうの出力: 画像の名前・URL・R2 のキーを出さない
  const rows = [{ ...row(A1, "site_a"), name: "社長の写真.png", public_url: "https://img.example.com/sites/site_a/images/x.png" }];
  const f = fakeDeps({ rows, keys: [], refs: [{ asset_id: A1, site_id: "site_a" }] });
  assert.equal(await run({ apply: true }, f.deps), 0);
  const text = [...f.out, ...f.err].join("\n");
  assert.match(text, new RegExp(A1));
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /社長の写真/);
  assert.doesNotMatch(text, /sites\/site_a\/images/);
  assert.ok(!text.includes(token));
});

test("reports_r2_key_and_page_counts", async () => {
  const f = fakeDeps({ rows: [row(A1, "site_a")], keys: ["sites/x/images/1.png", "sites/x/thumbs/1.webp"] });
  assert.equal(await run({ apply: false, db: "wtt-control" }, f.deps), 0);
  const text = f.out.join("\n");
  assert.match(text, /R2 から読んだキー: 2 件\(1 ページ\)/);
  assert.match(text, /D1 wtt-control/);
});

test("rechecks_missing_objects_before_marking", async () => {
  // 一覧に無かった 2 枚のうち、確かめ直すと A2 は在った → 印は A1 だけ
  const rows = [row(A1, "site_a"), row(A2, "site_a")];
  const f = fakeDeps({ rows, keys: [], present: [rows[1].r2_key] });
  assert.equal(await run({ apply: true }, f.deps), 0);
  assert.deepEqual(f.rechecked.sort(), [rows[0].r2_key, rows[1].r2_key].sort());
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], new RegExp(A1));
  assert.doesNotMatch(f.writes[0], new RegExp(A2));
  const text = f.out.join("\n");
  assert.match(text, /一覧に無かったが、確かめ直すと在った画像: 1 件/);
  assert.match(text, /R2 に中身の無い画像: 1 件/);
  assert.match(text, /印を付けた画像: 1 件\(対象 1 件\)/);

  // 確かめ直すとすべて在った → 何も書かない
  const g = fakeDeps({ rows, keys: [], present: rows.map((r) => r.r2_key) });
  assert.equal(await run({ apply: true }, g.deps), 0);
  assert.equal(g.writes.length, 0);
  assert.match(g.out.join("\n"), /R2 に中身の無い画像: 0 件/);
});

test("r2_object_exists_reads_one_key", async () => {
  const calls = [];
  const fetchFor = (status) => async (url, init) => {
    calls.push({ u: new URL(url), auth: init.headers.Authorization });
    return { ok: status === 200, status, json: async () => ({ success: status === 200, errors: status === 200 ? [] : [{ code: 10007, message: "not found" }] }), body: null };
  };
  const base = { accountId: "acc0123", bucket: "test-bucket", token: "fake-token-for-test", key: "sites/a/images/asset_aaaaaaaaa1.png" };
  assert.equal(await r2ObjectExists({ ...base, fetch: fetchFor(200) }), true);
  assert.equal(calls[0].u.pathname, "/client/v4/accounts/acc0123/r2/buckets/test-bucket/objects/sites/a/images/asset_aaaaaaaaa1.png");
  assert.equal(calls[0].auth, "Bearer fake-token-for-test");
  assert.equal(await r2ObjectExists({ ...base, fetch: fetchFor(404) }), false);
  // 404 以外の失敗は「無い」と見なさずに止める(在る画像に印を付けないため)
  await assert.rejects(r2ObjectExists({ ...base, fetch: fetchFor(403) }), /403/);
});

test("reads_database_name_from_config", () => {
  assert.equal(readDatabaseName(`{ "d1_databases": [{ "binding": "DB", "database_name": "wtt-control-restore", "database_id": "x" }, { "binding": "R", "database_name": "other" }] }`), "wtt-control-restore");
  assert.equal(readDatabaseName(`{\n  "d1_databases": [\n    { "binding": "DB", "database_name": "my-db" }\n  ]\n}`), "my-db");
  assert.equal(readDatabaseName(`{ "vars": {} }`), null);
  assert.equal(readDatabaseName(`{\n  // "d1_databases": [{ "binding": "DB", "database_name": "my-db" }],\n  "vars": {}\n}`), null);
});

test("local_object_result_only_treats_no_such_key_as_missing (I6)", () => {
  assert.equal(localObjectResult({ status: 0, stdout: "", stderr: "" }), true);
  // wrangler 4 の --local で、無いキーを get したときの出力(stderr、終了コード 1)
  assert.equal(localObjectResult({ status: 1, stdout: "", stderr: "✘ [ERROR] The specified key does not exist.\n" }), false);
  // それ以外の失敗(保存先を読めない・起動しない)は「無い」にしない
  assert.throws(() => localObjectResult({ status: 1, stdout: "", stderr: "✘ [ERROR] EACCES: permission denied, open '.wrangler/state/v3/r2/x'" }), /有無を確かめられませんでした/);
  assert.throws(() => localObjectResult({ status: null, stdout: "", stderr: "" }), /有無を確かめられませんでした/);
});

test("local_read_failure_marks_nothing (I6)", async () => {
  const rows = [row(A1, "site_a"), row(A2, "site_a")];
  const f = fakeDeps({ rows, keys: [] });
  // 確かめ直しの読み取りが失敗する(キーが無いとは分からない)
  f.deps.objectExists = async () => localObjectResult({ status: 1, stdout: "", stderr: "✘ [ERROR] SQLITE_BUSY: database is locked" });
  assert.equal(await run({ apply: true }, f.deps), 1);
  assert.equal(f.writes.length, 0);
  assert.match(f.err.join("\n"), /有無を確かめられませんでした/);
});

test("old_schema_stops_with_migration_hint (I4)", async () => {
  for (const message of ["D1 の実行に失敗しました(wtt-control):\n✘ [ERROR] no such column: deleted_at: SQLITE_ERROR", "no such column: purge_marked_at", "no such table: assets"]) {
    const f = fakeDeps({ rows: [] });
    const d1 = f.deps.d1;
    f.deps.d1 = async (sql) => {
      if (sql === ASSETS_SQL) throw new Error(message);
      return d1(sql);
    };
    assert.equal(await run({ apply: true }, f.deps), 1);
    assert.equal(f.writes.length, 0);
    const text = f.err.join("\n");
    assert.match(text, /マイグレーションを当ててから/);
    assert.doesNotMatch(text, /決定|§|Task|superpowers/);
  }
  // ほかの失敗はそのまま出す
  const g = fakeDeps({ rows: [] });
  g.deps.d1 = async (sql) => {
    if (sql === ASSETS_SQL) throw new Error("network down");
    return [{ n: 1 }];
  };
  assert.equal(await run({ apply: false }, g.deps), 1);
  assert.match(g.err.join("\n"), /network down/);
});
