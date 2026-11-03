import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys } from "@wtt/core";
import { getDb, toStatement } from "../src/db";
import type { Env } from "../src/env";
import { isRetiredSiteIdAbort } from "../src/retired-sites";
import {
  beforeD1Batch,
  beforeD1Query,
  call,
  choosePrimaryGoal,
  createExperiment,
  createSite,
  experimentRow,
  expectEnvelope,
  failingKv,
  inviteAndJoin,
  json,
  RESULTS_STORE,
  setupOwner,
  siteRow,
  TEXT_CHANGE,
} from "./helpers";

// B155(G26): 削除したサイトの ID の退役。記録は D1 のトリガー(migrations/0021)が積む(Q9)。削除の batch のコードは変えていない。
// ここでは「削除で積まれる」「取りやめ・作成の戻しでは(ふつう)積まれない」を固定する。作成の断り(別のワークスペース)は下の Task 3 の describe

type Owner = Awaited<ReturnType<typeof setupOwner>>;

const retiredRows = () => getDb(env).selectFrom("retired_site_ids").selectAll().orderBy("id").execute();
const retiredOf = (id: string) => getDb(env).selectFrom("retired_site_ids").selectAll().where("id", "=", id).execute();
const siteGone = async (id: string) => (await getDb(env).selectFrom("sites").select("id").where("id", "=", id).executeTakeFirst()) === undefined;
const queueRows = () => getDb(env).selectFrom("results_purge_queue").selectAll().orderBy("run_id").execute();
const claimRows = (id: string) => env.DB.prepare("select domain from sharing_claims where site_id = ?").bind(id).all();
const hostRows = (id: string) => env.DB.prepare("select host from site_hosts where site_id = ?").bind(id).all();
const orgExists = async (id: string) => (await getDb(env).selectFrom("organization").select("id").where("id", "=", id).executeTakeFirst()) !== undefined;

async function newWorkspace(owner: Owner, name: string): Promise<string> {
  const res = await call("POST", "/workspaces", { token: owner.token, body: { name } });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** 結果を記録するサイト(計測用 D1 がある導入で作る)に、開始済みの run を 1 つ持たせる。削除の取りやめで queue に積まれないことを見るため */
async function siteWithRun(owner: Owner, workspaceId: string, eid: string): Promise<string> {
  const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token: owner.token, body: { name: "Site", domains: ["www.example.com"] }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  const { id: sid } = await json<{ id: string }>(res);
  await createExperiment(owner.token, sid, { id: eid });
  await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  await choosePrimaryGoal(owner.token, sid, eid);
  expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" }, envOverride: RESULTS_STORE })).status).toBe(200);
  expect((await experimentRow(sid, eid)).run_id).toMatch(/.+/);
  expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "archived" }, envOverride: RESULTS_STORE })).status).toBe(200);
  return sid;
}

describe("削除したサイトの ID の退役(B155)", () => {
  it("site_delete_records_retired_id", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    expect(await retiredOf(id)).toEqual([]);
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    expect(await siteGone(id)).toBe(true);
    expect(await retiredOf(id)).toEqual([{ id, workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
  });

  it("workspace_delete_records_retired_ids_of_all_sites", async () => {
    const owner = await setupOwner();
    const wid = await newWorkspace(owner, "Second"); // 最後の 1 つではない
    const a = (await createSite(owner.token, wid)).id;
    const b = (await createSite(owner.token, wid)).id;
    const keep = (await createSite(owner.token, owner.workspaceId)).id; // 消さないワークスペースのサイトは積まない
    expect((await call("DELETE", `/workspaces/${wid}`, { token: owner.token })).status).toBe(204);
    // organization の DELETE の FK CASCADE で sites が消える。それでもトリガーが記録する
    expect(await siteGone(a)).toBe(true);
    expect(await siteGone(b)).toBe(true);
    const rows = (await retiredRows()).filter((r) => [a, b, keep].includes(r.id));
    expect(rows).toEqual([a, b].sort().map((id) => ({ id, workspace_id: wid, retired_at: expect.any(Number) })));
  });

  it("aborted_site_delete_does_not_record", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    // 印を立てた後・D1 の削除の前に、別の削除(または作り直し)が印を別の token にした
    let ran = 0;
    const racing = beforeD1Batch(env.DB, async () => {
      ran++;
      await env.DB.prepare("update sites set static_removing = 'other-token' where id = ?").bind(id).run();
    });
    const res = await call("DELETE", `/sites/${id}`, { token: owner.token, envOverride: { DB: racing } });
    expect(ran).toBe(1);
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("static_remove_conflict");
    expect(await siteGone(id)).toBe(false);
    expect(await retiredOf(id)).toEqual([]);
  });

  it("aborted_workspace_delete_by_last_workspace_race_does_not_record", async () => {
    const owner = await setupOwner();
    const wid = await newWorkspace(owner, "Second");
    const a = await siteWithRun(owner, wid, "exp_a");
    const b = (await createSite(owner.token, wid)).id;
    const queueBefore = await queueRows();
    const retiredBefore = await retiredRows();
    // 最後の 1 つかの確かめの後・削除の batch の前に、もう 1 つのワークスペースが消えた(同時の削除)。配下にサイトは無い
    let ran = 0;
    const racing = beforeD1Batch(env.DB, async () => {
      ran++;
      await env.DB.prepare("delete from organization where id = ?").bind(owner.workspaceId).run();
    });
    const res = await call("DELETE", `/workspaces/${wid}`, { token: owner.token, envOverride: { ...RESULTS_STORE, DB: racing } });
    expect(ran).toBe(1);
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("last_workspace");
    expect(await orgExists(wid)).toBe(true);
    expect(await siteGone(a)).toBe(false);
    expect(await siteGone(b)).toBe(false);
    // キューへの積みと organization の DELETE は同じ条件なので、どちらも 0 行になる。削除の token を付けた Site があっても退役の行も queue の行も増えない
    expect(await queueRows()).toEqual(queueBefore);
    expect(await retiredRows()).toEqual(retiredBefore);
  });

  it("aborted_workspace_delete_by_token_conflict_does_not_record", async () => {
    const owner = await setupOwner();
    const wid = await newWorkspace(owner, "Second");
    const a = await siteWithRun(owner, wid, "exp_a");
    const b = (await createSite(owner.token, wid)).id;
    const queueBefore = await queueRows();
    const retiredBefore = await retiredRows();
    // 全サイトに印を付けた後・削除の batch の前に、配下の 1 サイトの印を別の token にした
    let ran = 0;
    const racing = beforeD1Batch(env.DB, async () => {
      ran++;
      await env.DB.prepare("update sites set static_removing = 'other-token' where id = ?").bind(b).run();
    });
    const res = await call("DELETE", `/workspaces/${wid}`, { token: owner.token, envOverride: { ...RESULTS_STORE, DB: racing } });
    expect(ran).toBe(1);
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("static_remove_conflict");
    expect(await orgExists(wid)).toBe(true);
    expect(await siteGone(a)).toBe(false);
    expect(await siteGone(b)).toBe(false);
    expect(await queueRows()).toEqual(queueBefore);
    expect(await retiredRows()).toEqual(retiredBefore);
  });

  it("redelete_in_same_workspace_updates_retired_at", async () => {
    const owner = await setupOwner();
    const id = "site_redelete";
    await createSite(owner.token, owner.workspaceId, { id });
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    expect(await retiredOf(id)).toHaveLength(1);
    // 1 回目の時刻を古い値に置き、上書きされたことを時計の刻みに頼らず見る
    await env.DB.prepare("update retired_site_ids set retired_at = 1 where id = ?").bind(id).run();
    // 同じワークスペースの作り直しは通る
    await createSite(owner.token, owner.workspaceId, { id });
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    const rows = await retiredOf(id);
    expect(rows).toHaveLength(1); // 行は増えず 1 つ
    expect(rows[0]).toMatchObject({ id, workspace_id: owner.workspaceId });
    expect(rows[0]!.retired_at).toBeGreaterThan(1_000_000_000_000); // epoch ミリ秒の今ごろ
  });

  // B148 Task 4: Mode B の作成は要求の中で 1 行目を確かめ、edge ならホストを取る(偽の edge が edge と答える)
  it("rollback_after_host_claim_failure_does_not_record", async () => {
    const owner = await setupOwner();
    const host = "claimed.example.com";
    await createSite(owner.token, owner.workspaceId, { id: "site_host_owner", mode: "B", domain: host });
    // 同じホストを使う Mode B のサイトの作成: sites の batch は通り、claimHosts が host_in_use で落ちて sites の行を消して戻す
    let ran = 0;
    const hooked = beforeD1Query(env.DB, /^delete from "?sites"?/i, async () => {
      ran++;
    });
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
      token: owner.token,
      body: { id: "site_host_rejected", name: "B", domains: [host], mode: "B" },
      envOverride: { DB: hooked.db },
    });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("host_in_use");
    expect(hooked.ran()).toBe(true); // 戻しの DELETE FROM sites を実際に通った
    expect(ran).toBe(1);
    expect(await siteGone("site_host_rejected")).toBe(true);
    expect((await claimRows("site_host_rejected")).results).toEqual([]);
    expect((await hostRows("site_host_rejected")).results).toEqual([]);
    expect(await retiredOf("site_host_rejected")).toEqual([]);
  });

  it("rollback_after_kv_write_failure_does_not_record", async () => {
    const owner = await setupOwner();
    const id = "site_kv_rejected";
    let ran = 0;
    const hooked = beforeD1Query(env.DB, /^delete from "?sites"?/i, async () => {
      ran++;
    });
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
      token: owner.token,
      body: { id, name: "B", domains: ["www.kv-fail.example.com"] },
      envOverride: { DB: hooked.db, CONFIG_KV: failingKv(/:settings$/) },
    });
    expect(res.status).toBe(503);
    expect(hooked.ran()).toBe(true);
    expect(ran).toBe(1);
    expect(await siteGone(id)).toBe(true);
    expect((await claimRows(id)).results).toEqual([]);
    expect((await hostRows(id)).results).toEqual([]);
    expect(await retiredOf(id)).toEqual([]);
  });

  it("create_rollback_after_delete_token_records_retirement", async () => {
    const owner = await setupOwner();
    const id = "site_overlap";
    // 作成の batch の後・戻しの DELETE の前に、別の要求の削除がこのサイトに印(token)を付けた重なり。戻しの DELETE でもトリガーが記録する(安全側)
    const hooked = beforeD1Query(env.DB, /^delete from "?sites"?/i, async () => {
      await env.DB.prepare("update sites set static_removing = 'racing-delete-token' where id = ?").bind(id).run();
    });
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
      token: owner.token,
      body: { id, name: "B", domains: ["www.overlap.example.com"] },
      envOverride: { DB: hooked.db, CONFIG_KV: failingKv(/:settings$/) },
    });
    expect(res.status).toBe(503);
    expect(hooked.ran()).toBe(true);
    expect(await siteGone(id)).toBe(true);
    expect(await retiredOf(id)).toEqual([{ id, workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
    // 同じワークスペースは作り直せる(退役は同じワークスペースを止めない)
    expect((await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id, name: "B", domains: ["www.overlap.example.com"] } })).status).toBe(201);
  });

  it("delete_by_old_code_path_is_recorded", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    // control を通さず、古い control の削除と同じ形(印を付けてから DELETE FROM sites)を D1 に直接流す。migration の後なら取りこぼさない
    await env.DB.prepare("update sites set static_removing = 'old-code-token' where id = ?").bind(id).run();
    await env.DB.prepare("delete from sites where id = ? and static_removing = 'old-code-token'").bind(id).run();
    expect(await siteGone(id)).toBe(true);
    expect(await retiredOf(id)).toEqual([{ id, workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3(B155・Q7・Q10): 作成で別のワークスペースの退役の ID を断る

/** 今あるサイトと同じ 409(見られない人への退役の断りも、id 以外はこれと同じ。Q7) */
const GENERIC_409 = { error: "site_id_taken", message: "このサイト ID は既に使われています", hint: "別の ID を指定してください" };
/** 元のワークスペースを見られる人への退役の断り(Q7) */
const RETIRED_ELSEWHERE_409 = {
  error: "site_id_taken",
  reason: "retired_elsewhere",
  message: "このサイト ID は、別のワークスペースで削除したサイトが使っていたため使えません",
  hint: "別の ID を指定してください。削除したサイトを作り直すときは、そのサイトがあったワークスペースで作成してください",
};

let domainSeq = 0;
/** 呼ぶたびに登録ドメインが違う(B139 の共有の衝突の調整・予約の衝突を起こさない) */
const freshDomain = () => `www.retired-${++domainSeq}.com`;
const createRes = (token: string, wid: string, id: string | undefined, envOverride?: Partial<Env>) =>
  call("POST", `/workspaces/${wid}/sites`, { token, body: { ...(id ? { id } : {}), name: "Site", domains: [freshDomain()] }, envOverride });

async function expect409(res: Response, expected: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
  expect(res.status).toBe(409);
  const body = await expectEnvelope(res);
  expect(body).toEqual({ ...expected, id });
  return body;
}

/** wid にサイト id を作って消す(退役の行が wid で入る) */
async function retireIn(owner: Owner, wid: string, id: string): Promise<void> {
  await createSite(owner.token, wid, { id });
  expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
  expect(await retiredOf(id)).toEqual([{ id, workspace_id: wid, retired_at: expect.any(Number) }]);
}

async function deleteWorkspace(owner: Owner, wid: string): Promise<void> {
  expect((await call("DELETE", `/workspaces/${wid}`, { token: owner.token })).status).toBe(204);
  expect(await orgExists(wid)).toBe(false);
}

async function makeKey(token: string, workspaceId: string | null, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call("POST", "/me/api-keys", { token, body: { name: "k", workspaceId, ...extra } });
  expect(res.status).toBe(201);
  return (await json<{ key: string }>(res)).key;
}

const insertRetired = (id: string, workspaceId: string) =>
  env.DB.prepare("insert into retired_site_ids (id, workspace_id, retired_at) values (?, ?, ?)").bind(id, workspaceId, Date.now()).run();

/** 作成の確かめの 1 文(readSiteIdState)が何回流れたか。2 回 = トリガーに断られて読み直した */
const STATE_SQL = /SELECT EXISTS \(SELECT 1 FROM sites WHERE id = \?1\) AS live/;
function countStateReads(db: D1Database): { db: D1Database; reads(): number } {
  let n = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare")
        return (sqlText: string) => {
          if (STATE_SQL.test(sqlText)) n++;
          return target.prepare(sqlText);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, reads: () => n };
}

/** batch が落ちた直後(読み直しの前)に hook を 1 回だけ走らせてから、元の例外を投げ直す */
function afterFailedBatch(db: D1Database, hook: () => Promise<unknown>): { db: D1Database; ran(): number } {
  let ran = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          try {
            return await target.batch(stmts);
          } catch (e) {
            if (ran === 0) {
              ran++;
              await hook();
            }
            throw e;
          }
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, ran: () => ran };
}

/** 確かめの後・作成の batch の前に hook を差し込み、確かめの回数も数える */
function raceBeforeBatch(hook: () => Promise<unknown>): { db: D1Database; ran(): number; reads(): number } {
  let ran = 0;
  const counted = countStateReads(env.DB);
  const db = beforeD1Batch(counted.db, async () => {
    ran++;
    await hook();
  });
  return { db, ran: () => ran, reads: counted.reads };
}

async function expectNoSiteLeft(id: string): Promise<void> {
  expect(await siteGone(id)).toBe(true);
  expect((await claimRows(id)).results).toEqual([]);
  expect((await hostRows(id)).results).toEqual([]);
  expect(await env.CONFIG_KV.get(kvKeys.settings(id))).toBeNull();
}

describe("作成で別のワークスペースの退役の ID を断る(B155 Task 3)", () => {
  it("is_retired_site_id_abort_matches_trigger_message", () => {
    // Task 1 で確かめた Workers の D1 binding の文(migrations/0021 の RAISE(ABORT, 'retired_site_id'))
    expect(isRetiredSiteIdAbort(new Error("D1_ERROR: retired_site_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"))).toBe(true);
    expect(isRetiredSiteIdAbort(new Error("D1_ERROR: UNIQUE constraint failed: sites.id: SQLITE_CONSTRAINT"))).toBe(false);
    expect(isRetiredSiteIdAbort(new Error("D1_ERROR: no such table: retired_site_ids: SQLITE_ERROR"))).toBe(false);
  });

  it("other_workspace_cannot_reuse_deleted_site_id", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    const xAdmin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await retireIn(owner, y, "shop");
    // X の管理者は Y を見られないので、今あるサイトと同じ文(Q7)
    await expect409(await createRes(xAdmin.token, owner.workspaceId, "shop"), GENERIC_409, "shop");
    await expectNoSiteLeft("shop");
    expect(await retiredOf("shop")).toEqual([{ id: "shop", workspace_id: y, retired_at: expect.any(Number) }]);
  });

  it("same_workspace_can_recreate_deleted_site_id", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    const yAdmin = await inviteAndJoin(owner.token, y, "admin");
    await retireIn(owner, y, "shop");
    expect((await createRes(yAdmin.token, y, "shop")).status).toBe(201);
    expect((await siteRow("shop")).workspace_id).toBe(y);
  });

  it("instance_admin_cannot_move_id_while_original_workspace_exists", async () => {
    const owner = await setupOwner(); // システム管理者で、Y のオーナー(見られる)
    const y = await newWorkspace(owner, "Y");
    await retireIn(owner, y, "shop");
    await expect409(await createRes(owner.token, owner.workspaceId, "shop"), RETIRED_ELSEWHERE_409, "shop");
    await expectNoSiteLeft("shop");
    expect((await retiredOf("shop"))[0]!.workspace_id).toBe(y); // 付け替えない
  });

  it("after_workspace_delete_only_instance_admin_can_reuse", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    const xAdmin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    await retireIn(owner, y, "shop");
    await deleteWorkspace(owner, y);
    await expect409(await createRes(xAdmin.token, owner.workspaceId, "shop"), GENERIC_409, "shop");
    await expectNoSiteLeft("shop");
    expect((await createRes(owner.token, owner.workspaceId, "shop")).status).toBe(201);
    expect((await siteRow("shop")).workspace_id).toBe(owner.workspaceId);
  });

  it("capped_or_workspace_key_of_instance_admin_is_not_admin_for_retired_id", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    await retireIn(owner, y, "shop");
    await deleteWorkspace(owner, y);
    const capped = await makeKey(owner.token, null, { roleCap: "admin" }); // 作成に足りる上限(admin)。上限付きはシステム管理者として扱わない
    const wsKey = await makeKey(owner.token, owner.workspaceId); // ワークスペースの鍵も扱わない
    await expect409(await createRes(capped, owner.workspaceId, "shop"), GENERIC_409, "shop");
    await expect409(await createRes(wsKey, owner.workspaceId, "shop"), GENERIC_409, "shop");
    await expectNoSiteLeft("shop");
    expect((await retiredOf("shop"))[0]!.workspace_id).toBe(y);
  });

  it("trigger_rejects_id_retired_between_check_and_insert", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y"); // 別のワークスペース(システム管理者は見られる)
    const xAdmin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["shop_a", xAdmin.token, GENERIC_409],
      ["shop_b", owner.token, RETIRED_ELSEWHERE_409],
    ];
    for (const [id, token, expected] of cases) {
      // 確かめでは退役の行は無い。確かめの後・batch の前に、Y が同じ ID を作って消し終えた重なり
      const race = raceBeforeBatch(() => insertRetired(id, y));
      await expect409(await createRes(token, owner.workspaceId, id, { DB: race.db }), expected, id);
      expect(race.ran()).toBe(1);
      expect(race.reads()).toBe(2); // 確かめ + 断られた後の読み直し(D1 のトリガーが断った経路)
      await expectNoSiteLeft(id);
      expect((await retiredOf(id))[0]!.workspace_id).toBe(y);
    }
  });

  it("trigger_rejects_orphan_retirement_between_check_and_insert", async () => {
    const owner = await setupOwner();
    const xAdmin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const capped = await makeKey(owner.token, null, { roleCap: "admin" });
    const wsKey = await makeKey(owner.token, owner.workspaceId);
    const cases: Array<[string, string]> = [
      ["orphan_a", xAdmin.token],
      ["orphan_b", capped],
      ["orphan_c", wsKey],
    ];
    for (const [id, token] of cases) {
      // 存在しないワークスペースの退役の行が、確かめの後・batch の前に入った
      const race = raceBeforeBatch(() => insertRetired(id, "ws_gone"));
      await expect409(await createRes(token, owner.workspaceId, id, { DB: race.db }), GENERIC_409, id);
      expect(race.ran()).toBe(1);
      expect(race.reads()).toBe(2);
      await expectNoSiteLeft(id);
    }
  });

  it("old_create_after_migration_cannot_claim_retired_id", async () => {
    const owner = await setupOwner();
    const a = await newWorkspace(owner, "A");
    const s = "site_old_create";
    await createSite(owner.token, a, { id: s });
    const row = await siteRow(s);
    expect((await call("DELETE", `/sites/${s}`, { token: owner.token })).status).toBe(204);
    expect((await retiredOf(s))[0]!.workspace_id).toBe(a);
    // 古い control の作成と同じ形(退役の表を見ない): sites の INSERT と sharing_claims の INSERT を 1 つの batch で B に入れる
    let caught: unknown = null;
    try {
      await env.DB.batch([
        toStatement(env, getDb(env).insertInto("sites").values({ ...row, workspace_id: owner.workspaceId, static_removing: null })),
        env.DB.prepare("insert into sharing_claims (domain, cookie_name, site_id, until) values (?, ?, ?, null)").bind("old-create.example", row.visitor_cookie_name, s),
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught)).toContain("retired_site_id"); // D1 での実際の文を固定する
    expect(isRetiredSiteIdAbort(caught)).toBe(true);
    expect(await siteGone(s)).toBe(true);
    expect((await claimRows(s)).results).toEqual([]);
  });

  it("instance_admin_reclaim_reassigns_retired_row", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    await retireIn(owner, y, "shop");
    await deleteWorkspace(owner, y);
    expect((await createRes(owner.token, owner.workspaceId, "shop")).status).toBe(201);
    expect(await retiredOf("shop")).toEqual([{ id: "shop", workspace_id: owner.workspaceId, retired_at: expect.any(Number) }]);
    await env.DB.prepare("update retired_site_ids set retired_at = 1 where id = ?").bind("shop").run();
    expect((await call("DELETE", "/sites/shop", { token: owner.token })).status).toBe(204);
    const rows = await retiredOf("shop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: owner.workspaceId });
    expect(rows[0]!.retired_at).toBeGreaterThan(1_000_000_000_000);
  });

  it("trigger_abort_reread_after_concurrent_reclaim_returns_generic_409", async () => {
    const owner = await setupOwner();
    const xAdmin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    // (a) 取り直したサイトが残る / (b) 取り直しの作成が token なしで戻され、退役の行だけが X に残る
    const cases: Array<[string, Partial<Env> | undefined, number]> = [
      ["reclaim_a", undefined, 201],
      ["reclaim_b", { CONFIG_KV: failingKv(/:settings$/) }, 503],
    ];
    for (const [id, innerEnv, innerStatus] of cases) {
      let inner = 0;
      const counted = countStateReads(env.DB);
      // 確かめの後・batch の前に、元のワークスペースが消えた退役の行(ws_gone)が入る → X の管理者の作成はトリガーに断られる
      let ran = 0;
      const racing = beforeD1Batch(counted.db, async () => {
        ran++;
        await insertRetired(id, "ws_gone");
      });
      // 断られた後・読み直しの前に、システム管理者が同じ ID を X に取り直す
      const after = afterFailedBatch(racing, async () => {
        inner = (await createRes(owner.token, owner.workspaceId, id, innerEnv)).status;
      });
      await expect409(await createRes(xAdmin.token, owner.workspaceId, id, { DB: after.db }), GENERIC_409, id);
      expect(ran).toBe(1);
      expect(after.ran()).toBe(1);
      expect(inner).toBe(innerStatus);
      expect(counted.reads()).toBe(2);
      expect((await retiredOf(id))[0]!.workspace_id).toBe(owner.workspaceId);
      expect(await siteGone(id)).toBe(innerStatus !== 201);
    }
  });

  it("instance_admin_reclaim_rejected_when_retired_row_changed", async () => {
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    await retireIn(owner, y, "shop");
    await deleteWorkspace(owner, y);
    const y2 = await newWorkspace(owner, "Y2");
    // 確かめ(元のワークスペースが消えた退役)の後に、退役の行が別の存在するワークスペースに変わった → 付け替えは 0 行、トリガーが断る
    const race = raceBeforeBatch(() => env.DB.prepare("update retired_site_ids set workspace_id = ? where id = ?").bind(y2, "shop").run());
    await expect409(await createRes(owner.token, owner.workspaceId, "shop", { DB: race.db }), RETIRED_ELSEWHERE_409, "shop");
    expect(race.ran()).toBe(1);
    expect(race.reads()).toBe(2);
    await expectNoSiteLeft("shop");
    expect((await retiredOf("shop"))[0]!.workspace_id).toBe(y2);
  });

  it("create_lost_site_id_race_returns_409", async () => {
    const owner = await setupOwner();
    let inner = 0;
    // 確かめの後・batch の前に、同じ ID のサイトが(別のドメインで)入った → sites の主キーの違反(Review Focus 5)
    const race = raceBeforeBatch(async () => {
      inner = (await createRes(owner.token, owner.workspaceId, "shop")).status;
    });
    await expect409(await createRes(owner.token, owner.workspaceId, "shop", { DB: race.db }), GENERIC_409, "shop");
    expect(race.ran()).toBe(1);
    expect(inner).toBe(201);
    expect(race.reads()).toBe(1); // 主キーの違反は読み直さない
    const rows = await env.DB.prepare("select id from sites where id = ?").bind("shop").all();
    expect(rows.results).toHaveLength(1);
  });

  it("concurrent_creates_with_same_new_id_one_wins", async () => {
    const owner = await setupOwner();
    const [r1, r2] = await Promise.all([createRes(owner.token, owner.workspaceId, "shop"), createRes(owner.token, owner.workspaceId, "shop")]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect((await expectEnvelope(loser)).error).toBe("site_id_taken");
    const rows = await env.DB.prepare("select id from sites where id = ?").bind("shop").all();
    expect(rows.results).toHaveLength(1);
  });

  it("recreated_site_reclaims_sharing_claims", async () => {
    const owner = await setupOwner();
    await createSite(owner.token, owner.workspaceId, { id: "shop" }); // 共有オンで作る(既定)
    expect((await claimRows("shop")).results.length).toBeGreaterThan(0);
    expect((await call("DELETE", "/sites/shop", { token: owner.token })).status).toBe(204);
    expect((await claimRows("shop")).results).toEqual([]);
    await createSite(owner.token, owner.workspaceId, { id: "shop" });
    expect((await claimRows("shop")).results.length).toBeGreaterThan(0);
  });

  it("auto_generated_ids_unaffected", async () => {
    const owner = await setupOwner();
    await insertRetired("site_other_retired", "ws_gone"); // 関係の無い退役の行があっても
    const res = await createRes(owner.token, owner.workspaceId, undefined);
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect(await siteGone(id)).toBe(false);
  });
});
