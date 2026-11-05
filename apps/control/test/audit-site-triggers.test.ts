import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getDb, toStatement } from "../src/db";
import { beforeD1Batch, call, createSite, json, setupOwner, siteRow } from "./helpers";

/**
 * B129 plan Task 13 Step 1(Q23・Q30、spec §4.2 の「B155 との関係」): sites の 3 つのトリガー
 * (B155 の reject_retired_site_id_on_insert = BEFORE INSERT・retire_site_id_on_delete = AFTER DELETE、0023 の sites_fill_generation = AFTER INSERT)と
 * 操作の記録(audit_events)が同じ batch に入ったときの成功と失敗。失敗したら sites・retired_site_ids・audit_events が batch の前と同じ。
 *
 * 既存のテストで済んでいる所(ここでは重ねない):
 * - 削除の成功の退役の行 = retired-site-ids.test.ts の site_delete_records_retired_id、記録の行 = audit-content.test.ts の site_delete_records_name
 * - 削除の取りやめ(token の食い違いで DELETE が 0 行。batch は成功)= aborted_site_delete_does_not_record・site_delete_concurrent_second_writes_no_event
 * - 作成をトリガーが断ってサイトが残らない = trigger_rejects_id_retired_between_check_and_insert(ここでは記録の行と退役の行が変わらないことを足す)
 * - 作成の後の失敗の取り消し(作成の batch は成功)= site_create_failure_records_rollback・rollback_after_host_claim_failure_does_not_record
 * - 古い control の作成(世代なし)をトリガーが断る = old_create_after_migration_cannot_claim_retired_id、世代を埋める = audit-migration.test.ts の legacy_insert_after_generation_backfill
 * ここで足すのは、batch が文の途中・最後で失敗したときに 3 つの表が戻ること(D1 の batch は 1 トランザクション)と、3 つのトリガーが同じ batch で動く形
 */

type Owner = Awaited<ReturnType<typeof setupOwner>>;
type Snapshot = { sites: unknown[]; retired: unknown[]; audit: unknown[] };

const all = async (q: string, ...binds: unknown[]) => (await env.DB.prepare(q).bind(...binds).all()).results;
/** 3 つの表の今の中身(sites は対象の ID だけ、ほかは全部) */
const snapshot = async (siteIds: string[]): Promise<Snapshot> => ({
  sites: await all(`select * from sites where id in (select value from json_each(?1)) order by id`, JSON.stringify(siteIds)),
  retired: await all(`select * from retired_site_ids order by id`),
  audit: await all(`select * from audit_events order by id`),
});
const retiredOf = async (id: string) => all(`select id, workspace_id, retired_at from retired_site_ids where id = ?1`, id);
const auditOf = async (action: string, siteId: string) => all(`select action, site_id, site_generation, detail_json from audit_events where action = ?1 and site_id = ?2 order by id`, action, siteId);
const siteGone = async (id: string) => (await all(`select id from sites where id = ?1`, id)).length === 0;

/** batch の最後に足して batch ごと失敗させる文(状態の表は 1 行だけ。主キーの重複で必ず失敗する) */
const failingStatement = () => env.DB.prepare(`insert into audit_retention_state (id, day, deleted, run_id, last_limit) values (1, 'x', 0, '', 0)`);

/**
 * `sqlPattern` に合う文を含む最初の batch で、batch の直前に 3 つの表を控え(before)、batch の最後に失敗する文を足す D1 ラッパ。
 * 失敗する文は、前の文(削除・作成とそのトリガー・記録の INSERT)がすべて実行された後に落ちる
 */
function failAtEndOfBatch(sqlPattern: RegExp, siteIds: string[]): { db: D1Database; before(): Snapshot | null; error(): unknown } {
  let before: Snapshot | null = null;
  let error: unknown = null;
  const sqlOf = new WeakMap<object, string>();
  const remember = (stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement => {
    sqlOf.set(stmt, sqlText);
    const bind = stmt.bind.bind(stmt);
    return Object.assign(stmt, { bind: (...args: unknown[]) => remember(bind(...args), sqlText) });
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sqlText: string) => remember(target.prepare(sqlText), sqlText);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          if (before !== null || !stmts.some((s) => sqlPattern.test(sqlOf.get(s) ?? ""))) return target.batch(stmts);
          before = await snapshot(siteIds);
          try {
            return await target.batch([...stmts, failingStatement()]);
          } catch (e) {
            error = e;
            throw e;
          }
        };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db, before: () => before, error: () => error };
}

async function newWorkspace(owner: Owner, name: string): Promise<string> {
  const res = await call("POST", "/workspaces", { token: owner.token, body: { name } });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}
let domainSeq = 0;
const createRes = (owner: Owner, wid: string, id: string, envOverride?: { DB: D1Database }) =>
  call("POST", `/workspaces/${wid}/sites`, { token: owner.token, body: { id, name: "Site", domains: [`www.trig-${++domainSeq}.com`] }, envOverride });

describe("sites のトリガーと操作の記録の batch(B155 + B129)", () => {
  it("site_delete_batch_failure_keeps_sites_retired_and_log (Q30)", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    const generation = (await siteRow(id)).generation;
    const failing = failAtEndOfBatch(/^delete from "sites"/, [id]);
    const res = await call("DELETE", `/sites/${id}`, { token: owner.token, envOverride: { DB: failing.db } });
    expect(res.status).toBe(500);
    expect(String(failing.error())).toMatch(/UNIQUE constraint failed: audit_retention_state\.id/);
    // batch の前と同じ: サイトは残り(削除の印は batch の前に立てたまま)、退役と記録の行は増えない
    expect(failing.before()).not.toBeNull();
    expect(await snapshot([id])).toEqual(failing.before());
    expect(await siteGone(id)).toBe(false);
    expect(await retiredOf(id)).toEqual([]);
    expect(await auditOf("site.delete", id)).toEqual([]);
    // もう一度消すと、削除・退役・記録が揃う(同じ batch の 3 つ)
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    expect(await siteGone(id)).toBe(true);
    expect(await retiredOf(id)).toEqual([{ id, workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
    expect(await auditOf("site.delete", id)).toEqual([{ action: "site.delete", site_id: id, site_generation: generation, detail_json: expect.any(String) }]);
  });

  it("redelete_batch_failure_keeps_previous_retired_row (Q30)", async () => {
    const owner = await setupOwner();
    const id = "site_redelete_fail";
    await createSite(owner.token, owner.workspaceId, { id });
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    // 1 回目の退役の時刻を古い値に置き、上書きされたか(トリガーの ON CONFLICT DO UPDATE)を時計の刻みに頼らず見る
    await env.DB.prepare(`update retired_site_ids set retired_at = 1 where id = ?1`).bind(id).run();
    await createSite(owner.token, owner.workspaceId, { id }); // 同じワークスペースの作り直しは通る
    const failing = failAtEndOfBatch(/^delete from "sites"/, [id]);
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token, envOverride: { DB: failing.db } })).status).toBe(500);
    expect(await snapshot([id])).toEqual(failing.before());
    // 上書きの前の値が残る
    expect(await retiredOf(id)).toEqual([{ id, workspace_id: owner.workspaceId, retired_at: 1 }]);
    expect(await auditOf("site.delete", id)).toHaveLength(1); // 1 回目の削除の行だけ
    // 失敗しなければ上書きする
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    const [row] = (await retiredOf(id)) as Array<{ retired_at: number }>;
    expect(row!.retired_at).toBeGreaterThan(1_000_000_000_000);
    expect(await auditOf("site.delete", id)).toHaveLength(2);
  });

  it("site_create_batch_failure_leaves_no_site (Q30)", async () => {
    const owner = await setupOwner();
    // (1) 作成の batch(sites の INSERT・共有の予約・記録)が最後で失敗: 新しいサイトも、記録の行も残らない
    const failing = failAtEndOfBatch(/^insert into "sites"/, ["site_create_fail"]);
    expect((await createRes(owner, owner.workspaceId, "site_create_fail", { DB: failing.db })).status).toBe(500);
    expect(await snapshot(["site_create_fail"])).toEqual(failing.before());
    expect(await siteGone("site_create_fail")).toBe(true);
    expect(await auditOf("site.create", "site_create_fail")).toEqual([]);
    expect(await all(`select domain from sharing_claims where site_id = ?1`, "site_create_fail")).toEqual([]);
    // (2) システム管理者の取り直し(退役の行の付け替え → INSERT → 記録の batch)が最後で失敗: 付け替えも戻り、退役の行は元のワークスペースのまま
    const y = await newWorkspace(owner, "Y");
    await createSite(owner.token, y, { id: "shop" });
    expect((await call("DELETE", "/sites/shop", { token: owner.token })).status).toBe(204);
    expect((await call("DELETE", `/workspaces/${y}`, { token: owner.token })).status).toBe(204);
    const retiredBefore = await retiredOf("shop");
    expect(retiredBefore).toEqual([{ id: "shop", workspace_id: y, retired_at: expect.any(Number) }]);
    const reclaim = failAtEndOfBatch(/^insert into "sites"/, ["shop"]);
    expect((await createRes(owner, owner.workspaceId, "shop", { DB: reclaim.db })).status).toBe(500);
    expect(await snapshot(["shop"])).toEqual(reclaim.before());
    expect(await retiredOf("shop")).toEqual(retiredBefore);
    expect(await siteGone("shop")).toBe(true);
    expect(await auditOf("site.create", "shop")).toHaveLength(1); // Y での 1 回目の作成の行だけ
    // 失敗しなければ取り直せる(付け替え・INSERT・記録)
    expect((await createRes(owner, owner.workspaceId, "shop")).status).toBe(201);
    expect(await retiredOf("shop")).toEqual([{ id: "shop", workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
    expect(await auditOf("site.create", "shop")).toHaveLength(2);
    // (3) 確かめの後・batch の前に、別のワークスペースの退役の行が入った(重なり): トリガー(BEFORE INSERT)が batch を断り、
    // 記録の行と退役の行は batch の前と同じ(サイトが残らないことは trigger_rejects_id_retired_between_check_and_insert も見る)
    const z = await newWorkspace(owner, "Z");
    let raced: Snapshot | null = null;
    const race = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare(`insert into retired_site_ids (id, workspace_id, retired_at) values ('shop3', ?1, 1)`).bind(z).run();
      raced = await snapshot(["shop3"]);
    });
    const rejected = await createRes(owner, owner.workspaceId, "shop3", { DB: race });
    expect(rejected.status).toBe(409);
    expect(raced).not.toBeNull();
    expect(await snapshot(["shop3"])).toEqual(raced);
    expect(await auditOf("site.create", "shop3")).toEqual([]);
  });

  /**
   * 3 つのトリガーが 1 つの batch で動く形を、control を通さず D1 に直接流す(古い control の作成 = 世代なし の形を含む)。
   * 時点: reject = BEFORE INSERT、fill = AFTER INSERT(UPDATE で世代を埋める。retire・reject は UPDATE で動かない)、retire = AFTER DELETE
   */
  it("three_site_triggers_do_not_collide_in_one_batch (Q30)", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    const { id: tpl } = await createSite(owner.token, owner.workspaceId);
    const template = await siteRow(tpl);
    const a = (await createSite(owner.token, owner.workspaceId, { id: "site_a" })).id;
    const db = getDb(env);
    // generation = null は古い control の作成(列を書かない)と同じ形。型は新しい control の必須の列なので as で渡す
    const insertSite = (id: string, workspaceId: string, generation: string | null) =>
      toStatement(env, db.insertInto("sites").values({ ...template, id, workspace_id: workspaceId, generation: generation as string, static_removing: null }));
    const markAndDelete = (id: string) => [
      env.DB.prepare(`update sites set static_removing = 'trig-token' where id = ?1`).bind(id),
      env.DB.prepare(`delete from sites where id = ?1 and static_removing = 'trig-token'`).bind(id),
    ];
    const auditRow = (siteId: string) =>
      env.DB.prepare(`insert into audit_events (at, category, action, workspace_id, site_id, via) values (?1, 'content', 'site.delete', ?2, ?3, 'system')`).bind(Date.now(), owner.workspaceId, siteId);

    // 成功の batch: (i) 世代なしの作成(fill が動く)(ii) site_a の削除(retire が動く)と同じ batch の同じ ID・同じワークスペースの作り直し
    // (reject は retire が今入れた行を見るが、同じワークスペースなので通す。fill が動く)(iii) 世代ありの作成(fill は動かない)(iv) 記録
    await env.DB.batch([
      insertSite("site_new", owner.workspaceId, null),
      ...markAndDelete(a),
      insertSite(a, owner.workspaceId, null),
      insertSite("site_gen", owner.workspaceId, "given-generation"),
      auditRow(a),
    ]);
    const gens = (await all(`select id, generation from sites where id in ('site_new', 'site_a', 'site_gen') order by id`)) as Array<{ id: string; generation: string }>;
    expect(gens).toEqual([
      { id: "site_a", generation: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { id: "site_gen", generation: "given-generation" },
      { id: "site_new", generation: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    expect(await retiredOf(a)).toEqual([{ id: a, workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
    expect(await auditOf("site.delete", a)).toHaveLength(1);

    // 失敗の batch(reject が断る): 世代なしの作成(fill が動いた後)→ 削除(retire が動いた後)→ 同じ ID を別のワークスペースへ(reject が断る)→ 記録。
    // batch の前と同じ(作った行・消した行・退役・記録のどれも残らない)
    const before = await snapshot(["site_new2", "site_new"]);
    await expect(
      env.DB.batch([insertSite("site_new2", owner.workspaceId, null), ...markAndDelete("site_new"), insertSite("site_new", y, null), auditRow("site_new")]),
    ).rejects.toThrow(/retired_site_id/);
    expect(await snapshot(["site_new2", "site_new"])).toEqual(before);
    expect(await siteGone("site_new2")).toBe(true);
    expect(await retiredOf("site_new")).toEqual([]);

    // 失敗の batch(作成の失敗): 世代なしの作成(fill が動いた後)と記録の後に、主キーの重複の作成で落ちる。新しいサイトは残らない
    const before2 = await snapshot(["site_new3", "site_gen"]);
    await expect(
      env.DB.batch([insertSite("site_new3", owner.workspaceId, null), auditRow("site_new3"), insertSite("site_gen", owner.workspaceId, null)]),
    ).rejects.toThrow(/UNIQUE constraint failed: sites\.id/);
    expect(await snapshot(["site_new3", "site_gen"])).toEqual(before2);
    expect(await siteGone("site_new3")).toBe(true);
  });
});
