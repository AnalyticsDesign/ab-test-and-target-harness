import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createExperiment, createSite, experimentRow, json, setupOwner, siteRow } from "./helpers";

/**
 * B129 Task 1(spec §4.1・§4.2): 操作の記録の表(audit_events)・索引・追記だけのトリガー・保持の 1 日の枠の表と、
 * sites・experiments の世代(generation。Q14・Q25)。番号は main に入る順で振るので、ファイル名の末尾で探す
 */

const DAY = 86_400_000;
const MIGRATION_SUFFIX = "_audit_events.sql";
/** control が作成のときに入れる世代(crypto.randomUUID()) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** マイグレーションとトリガーが埋める世代(lower(hex(randomblob(16)))) */
const HEX_RE = /^[0-9a-f]{32}$/;

const insertEvent = (at: number, extra: { category?: string; via?: string } = {}) =>
  env.DB.prepare(`insert into audit_events (at, category, action, workspace_id, via) values (?1, ?2, 'member.role', 'w1', ?3)`).bind(
    at,
    extra.category ?? "access",
    extra.via ?? "google",
  );

const T = 1_700_000_000_000;
const insertOrg = () => env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`);
/** 旧 control の形(世代の列を書かない)。列の既定に頼れない列だけを書く */
const legacySite = (id: string) =>
  env.DB.prepare(`insert into sites (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at) values (?1, 'w1', ?1, 'example.com', 'salt', ?2, ?2, ?2)`).bind(id, T);
const legacyExperiment = (siteId: string, id: string) =>
  env.DB.prepare(`insert into experiments (site_id, id, name, url_match_json, created_by, updated_by, created_at, updated_at) values (?1, ?2, ?2, '{}', 'u', 'u', ?3, ?3)`).bind(siteId, id, T);

type IndexListRow = { name: string; unique: number; origin: string; partial: number };
type IndexXinfoRow = { seqno: number; cid: number; name: string | null; key: number };

async function indexList(table: string): Promise<IndexListRow[]> {
  return (await env.DB.prepare(`select name, "unique", origin, partial from pragma_index_list(?1)`).bind(table).all<IndexListRow>()).results;
}
async function indexColumns(index: string): Promise<string[]> {
  const rows = (await env.DB.prepare(`select seqno, cid, name, key from pragma_index_xinfo(?1)`).bind(index).all<IndexXinfoRow>()).results;
  // key = 1 が索引の列(0 は末尾に付く rowid)
  return rows.filter((r) => r.key === 1).sort((a, b) => a.seqno - b.seqno).map((r) => r.name ?? "");
}
async function indexSql(index: string): Promise<string> {
  const r = await env.DB.prepare(`select sql from sqlite_master where type = 'index' and name = ?1`).bind(index).first<{ sql: string }>();
  return (r?.sql ?? "").replace(/\s+/g, " ");
}

describe("migration audit_events (B129)", () => {
  it("insert_and_read_back", async () => {
    const at = Date.now();
    await env.DB.prepare(
      `insert into audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via, actor_user_id, actor_email, actor_name, api_key_id, api_key_name, target_type, target_id, target_label, detail_json)
       values (?1, 'content', 'experiment.update', 'w1', 's1', 'e1', 'sg', 'eg', 'api_key', 'u1', 'a@example.com', 'A', 'k1', 'key', 'experiment', 'e1', '購入テスト', '{"fields":["name"]}')`,
    ).bind(at).run();
    const row = await env.DB.prepare(`select * from audit_events`).first();
    expect(row).toEqual({
      id: 1, at, category: "content", action: "experiment.update", workspace_id: "w1", site_id: "s1", experiment_id: "e1",
      site_generation: "sg", experiment_generation: "eg", via: "api_key", actor_user_id: "u1", actor_email: "a@example.com", actor_name: "A",
      api_key_id: "k1", api_key_name: "key", target_type: "experiment", target_id: "e1", target_label: "購入テスト", detail_json: '{"fields":["name"]}',
    });
    // detail_json を省くと '{}'
    await insertEvent(at).run();
    expect(await env.DB.prepare(`select detail_json from audit_events where id = 2`).first("detail_json")).toBe("{}");
  });

  it("id_is_integer_rowid", async () => {
    // Q10: 主キーは rowid(暗黙の索引 sqlite_autoindex_audit_events_1 が無い)
    expect((await indexList("audit_events")).map((r) => r.name)).not.toContain("sqlite_autoindex_audit_events_1");
    const at = Date.now();
    await env.DB.batch([insertEvent(at), insertEvent(at)]);
    const ids = (await env.DB.prepare(`select id, typeof(id) as t from audit_events order by id`).all<{ id: number; t: string }>()).results;
    expect(ids).toEqual([{ id: 1, t: "integer" }, { id: 2, t: "integer" }]);
  });

  it("update_is_refused", async () => {
    await insertEvent(Date.now()).run();
    await expect(env.DB.prepare(`update audit_events set action = 'x'`).run()).rejects.toThrow(/audit_events is append-only/);
    expect(await env.DB.prepare(`select action from audit_events`).first("action")).toBe("member.role");
  });

  it("delete_within_365_days_is_refused", async () => {
    await insertEvent(Date.now() - 364 * DAY).run();
    await expect(env.DB.prepare(`delete from audit_events`).run()).rejects.toThrow(/audit_events rows are kept for 365 days/);
    expect(await env.DB.prepare(`select count(*) as n from audit_events`).first("n")).toBe(1);
  });

  it("delete_older_than_365_days_is_allowed", async () => {
    await env.DB.batch([insertEvent(Date.now() - 367 * DAY), insertEvent(Date.now() - 400 * DAY)]);
    await env.DB.prepare(`delete from audit_events`).run();
    expect(await env.DB.prepare(`select count(*) as n from audit_events`).first("n")).toBe(0);
  });

  it("trigger_failure_rolls_back_batch", async () => {
    // D1 がトリガーの RAISE を batch の失敗として返し、batch の前の文の書き込みも戻す
    await env.DB.batch([
      insertOrg(),
      env.DB.prepare(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('u1', 'U', 'u1@example.com', 1, '2026-09-01', '2026-09-01')`),
      env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values ('m1', 'w1', 'u1', 'editor', '2026-09-01')`),
      insertEvent(Date.now()),
    ]);
    await expect(
      env.DB.batch([env.DB.prepare(`update member set role = 'admin' where id = 'm1'`), env.DB.prepare(`update audit_events set action = 'x'`)]),
    ).rejects.toThrow(/audit_events is append-only/);
    expect(await env.DB.prepare(`select role from member where id = 'm1'`).first("role")).toBe("editor");
    expect(await env.DB.prepare(`select action from audit_events`).first("action")).toBe("member.role");
  });

  it("changes_in_batch_is_recorded", async () => {
    // 記録だけ(spec §5.2。guard に changes() は使わない)。batch の中の changes() が前の文の行数を返すかの参考
    await insertOrg().run();
    const results = await env.DB.batch([
      env.DB.prepare(`update organization set name = 'W2' where id = 'w1'`),
      env.DB.prepare(`select changes() as n`),
      env.DB.prepare(`update organization set name = 'W3' where id = 'nope'`),
      env.DB.prepare(`select changes() as n`),
    ]);
    console.log("changes() in batch:", JSON.stringify([results[1]?.results, results[3]?.results]));
  });

  it("audit_events_has_generation_columns", async () => {
    const cols = (await env.DB.prepare(`select name from pragma_table_info('audit_events')`).all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["site_generation", "experiment_generation"]));
    expect(await indexColumns("audit_events_exp_at")).toEqual(["site_id", "experiment_id", "experiment_generation", "at", "id"]);
    expect(await indexSql("audit_events_exp_at")).toMatch(/WHERE experiment_id IS NOT NULL$/);
  });

  it("indexes_are_seven", async () => {
    // Q18・Q27: 明示の索引は 7 つ(origin = 'c' が CREATE INDEX で作ったもの)
    const explicit = (await indexList("audit_events")).filter((r) => r.origin === "c");
    expect(explicit.map((r) => r.name).sort()).toEqual(
      ["audit_events_access_at", "audit_events_at", "audit_events_exp_at", "audit_events_pw_at", "audit_events_ws_access_at", "audit_events_ws_at", "audit_events_ws_pw_at"].sort(),
    );
    const partial = Object.fromEntries(explicit.map((r) => [r.name, r.partial]));
    expect(partial).toMatchObject({
      audit_events_at: 0, audit_events_ws_at: 0, audit_events_exp_at: 1,
      audit_events_access_at: 1, audit_events_ws_access_at: 1, audit_events_pw_at: 1, audit_events_ws_pw_at: 1,
    });
    expect(await indexColumns("audit_events_at")).toEqual(["at", "id"]);
    expect(await indexColumns("audit_events_ws_at")).toEqual(["workspace_id", "at", "id"]);
    expect(await indexColumns("audit_events_access_at")).toEqual(["at", "id"]);
    expect(await indexColumns("audit_events_pw_at")).toEqual(["at", "id"]);
    expect(await indexColumns("audit_events_ws_access_at")).toEqual(["workspace_id", "at", "id"]);
    expect(await indexColumns("audit_events_ws_pw_at")).toEqual(["workspace_id", "at", "id"]);
    expect(await indexSql("audit_events_access_at")).toMatch(/WHERE category = 'access'$/);
    expect(await indexSql("audit_events_ws_access_at")).toMatch(/WHERE category = 'access'$/);
    expect(await indexSql("audit_events_pw_at")).toMatch(/WHERE via IN \('password', 'break_glass'\)$/);
    expect(await indexSql("audit_events_ws_pw_at")).toMatch(/WHERE via IN \('password', 'break_glass'\)$/);
  });

  it("retention_state_allows_one_row", async () => {
    // Q15・Q26: 最初の 1 行はマイグレーションが入れる
    const rows = (await env.DB.prepare(`select id, day, deleted, run_id, last_limit from audit_retention_state`).all()).results;
    expect(rows).toEqual([{ id: 1, day: "1970-01-01", deleted: 0, run_id: "", last_limit: 0 }]);
    await expect(env.DB.prepare(`insert into audit_retention_state values (2, '2026-11-03', 0, '', 0)`).run()).rejects.toThrow(/CHECK constraint failed/);
    expect(await env.DB.prepare(`select count(*) as n from audit_retention_state`).first("n")).toBe(1);
  });

  it("existing_rows_get_generation", async () => {
    // Q14: このマイグレーションより前までを当て、古い形(世代の列の無い表)の行を入れてから残りを当てる
    const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith(MIGRATION_SUFFIX))!.name;
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
    await env.DB.batch([insertOrg(), legacySite("s1"), legacySite("s2"), legacyExperiment("s1", "e1"), legacyExperiment("s1", "e2"), legacyExperiment("s2", "e1")]);
    const before = {
      sites: (await env.DB.prepare(`select * from sites order by id`).all<Record<string, unknown>>()).results,
      experiments: (await env.DB.prepare(`select * from experiments order by site_id, id`).all<Record<string, unknown>>()).results,
    };
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const after = {
      sites: (await env.DB.prepare(`select * from sites order by id`).all<Record<string, unknown>>()).results,
      experiments: (await env.DB.prepare(`select * from experiments order by site_id, id`).all<Record<string, unknown>>()).results,
    };
    for (const table of ["sites", "experiments"] as const) {
      const gens = after[table].map((r) => r.generation);
      for (const g of gens) expect(g).toMatch(HEX_RE);
      expect(new Set(gens).size).toBe(gens.length); // 行ごとに違う
      // ほかの列は変わらない
      expect(after[table].map(({ generation: _g, ...rest }) => rest)).toEqual(before[table]);
    }
  });

  it("legacy_insert_after_generation_backfill", async () => {
    // Q25: マイグレーションの後に世代を書かない形(旧 control)で入れても、トリガーが世代を埋める
    await env.DB.batch([insertOrg(), legacySite("s1"), legacySite("s2"), legacyExperiment("s1", "e1"), legacyExperiment("s1", "e2"), legacyExperiment("s2", "e1")]);
    const gensOf = async (table: "sites" | "experiments") =>
      (await env.DB.prepare(`select generation from ${table} order by ${table === "sites" ? "id" : "site_id, id"}`).all<{ generation: string | null }>()).results.map((r) => r.generation);
    for (const table of ["sites", "experiments"] as const) {
      const gens = await gensOf(table);
      for (const g of gens) expect(g).toMatch(HEX_RE);
      expect(new Set(gens).size).toBe(gens.length);
    }
    // 同じ ID を消して同じ形で入れ直すと、前と違う世代になる
    const site1 = await env.DB.prepare(`select generation from sites where id = 's1'`).first<string>("generation");
    const exp1 = await env.DB.prepare(`select generation from experiments where site_id = 's2' and id = 'e1'`).first<string>("generation");
    await env.DB.batch([env.DB.prepare(`delete from experiments where site_id = 's2' and id = 'e1'`), legacyExperiment("s2", "e1")]);
    // サイトの削除は static_removing を付けないので退役しない(B155 のトリガーは動かない)。experiments は FK の CASCADE で消える
    await env.DB.batch([env.DB.prepare(`delete from sites where id = 's1'`), legacySite("s1")]);
    const site1b = await env.DB.prepare(`select generation from sites where id = 's1'`).first<string>("generation");
    const exp1b = await env.DB.prepare(`select generation from experiments where site_id = 's2' and id = 'e1'`).first<string>("generation");
    expect(site1b).toMatch(HEX_RE);
    expect(exp1b).toMatch(HEX_RE);
    expect(site1b).not.toBe(site1);
    expect(exp1b).not.toBe(exp1);
    // 世代を書いた INSERT はトリガーが上書きしない
    await env.DB.prepare(
      `insert into experiments (site_id, id, name, url_match_json, created_by, updated_by, created_at, updated_at, generation) values ('s1', 'e9', 'e9', '{}', 'u', 'u', ?1, ?1, 'given')`,
    ).bind(T).run();
    expect(await env.DB.prepare(`select generation from experiments where site_id = 's1' and id = 'e9'`).first("generation")).toBe("given");
  });

  it("create_and_duplicate_set_generation", async () => {
    // Q29: 新しい control は作成・複製のときに crypto.randomUUID() を入れる(トリガーは動かない)
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, { id: "exp_src" });
    const dup = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: owner.token, body: { mode: "same", id: "exp_dup" } });
    expect(dup.status).toBe(201);
    await json(dup);
    const site = await siteRow(sid);
    const src = await experimentRow(sid, "exp_src");
    const copy = await experimentRow(sid, "exp_dup");
    expect(site.generation).toMatch(UUID_RE);
    expect(src.generation).toMatch(UUID_RE);
    expect(copy.generation).toMatch(UUID_RE);
    expect(copy.generation).not.toBe(src.generation);
  });
});
