import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { sqlStatement } from "../src/db";
import { expect, it } from "vitest";
import { activeGuard, publishedStatusStatement, publishActiveStatement, snapshotMatches, type StatusAfter, type StatusSnapshot } from "../src/publish-snapshot";
import { createSite, setupOwner, testEnv } from "./helpers";

const REPAIR_CANDIDATE = `active_kv_stale = 1 and active_version is not null and static_removing is null
  and coalesce(last_activated_at, 0) < ?1`;

async function fixture() {
  const { token, workspaceId, userId } = await setupOwner();
  const { id: sid } = await createSite(token, workspaceId);
  return { sid, workspaceId, userId };
}

type SnapshotRow = StatusSnapshot[number];

function experimentInsert(sid: string, userId: string, row: SnapshotRow): D1PreparedStatement {
  return env.DB.prepare(`
    insert into experiments
      (site_id, id, name, status, published_status, url_match_json, last_started_at, created_by, updated_by, created_at, updated_at)
    values (?1, ?2, ?2, ?3, 'draft', '{}', ?4, ?5, ?5, 1, 1)`)
    .bind(sid, row.id, row.status, row.lastStartedAt, userId);
}

function reserveVersion(sid: string, userId: string, version: number): D1PreparedStatement {
  return env.DB.prepare(`
    insert into publishes (id, site_id, version, status, published_by, created_at)
    values (?, ?, ?, 'reserved', ?, 1)`).bind(`pub_${version}`, sid, version, userId);
}

it("snapshot_condition_shape_on_miniflare", async () => {
  const { sid, userId } = await fixture();
  const running = { id: "running", status: "running", lastStartedAt: 1 } as const;
  const draft = { id: "draft", status: "draft", lastStartedAt: null } as const;
  const matches = (rows: StatusSnapshot) => sqlStatement(env.DB, sql`select ${snapshotMatches(sid, rows)} as matches`).first<number>("matches");

  await experimentInsert(sid, userId, running).run();
  expect(await matches([running])).toBe(1);
  await experimentInsert(sid, userId, draft).run();
  expect(await matches([running, draft])).toBe(1);
  expect(await matches([running])).toBe(1);
  expect(await matches([draft])).toBe(0);
});

it("published_status_one_statement_shape_on_miniflare", async () => {
  const { sid, userId } = await fixture();
  await env.DB.batch([
    experimentInsert(sid, userId, { id: "a", status: "running", lastStartedAt: 1 }),
    experimentInsert(sid, userId, { id: "b", status: "paused", lastStartedAt: 1 }),
    experimentInsert(sid, userId, { id: "c", status: "archived", lastStartedAt: 1 }),
    experimentInsert(sid, userId, { id: "d", status: "running", lastStartedAt: 1 }),
    reserveVersion(sid, userId, 1),
    env.DB.prepare("update sites set active_version = 1 where id = ?").bind(sid),
  ]);
  const after: StatusAfter = [{ id: "a", status: "running" }, { id: "b", status: "paused" }, { id: "c", status: "archived" }];
  await publishedStatusStatement(testEnv, sid, after, activeGuard(sid, 1, "pub_1")).run();
  const { results } = await env.DB.prepare("select id, published_status from experiments where site_id = ? order by id").bind(sid).all();
  expect(results).toEqual([
    { id: "a", published_status: "running" },
    { id: "b", published_status: "paused" },
    { id: "c", published_status: "archived" },
    { id: "d", published_status: "draft" },
  ]);
});

it("repair_candidate_sql_offset_subquery_on_miniflare", async () => {
  const { workspaceId } = await fixture();
  const ids = ["a", "b", "c", "d", "e"];
  await env.DB.batch(ids.map((id) => env.DB.prepare(`
      insert into sites
        (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at, active_kv_stale, active_version, last_activated_at)
      values (?1, ?2, ?1, ?3, 'salt', 1, 1, 1, 1, 1, 1)`)
    .bind(id, workspaceId, `${id}.example.com`)));
  const candidates = env.DB.prepare(`
    select id, active_kv_stale, active_version, last_activated_at from sites
    where ${REPAIR_CANDIDATE}
    order by id
    limit 3 offset (?2 % max(1, (select count(*) from sites where ${REPAIR_CANDIDATE})))`);
  for (let slot = 0; slot <= 6; slot++) {
    const { results } = await candidates.bind(60_000 - 30_000, slot).all<{ id: string }>();
    expect(results[0]?.id, `slot ${slot}`).toBe(ids[slot % ids.length]);
  }
});

it("activation_batch_scale_200_experiments", async () => {
  const { sid, userId } = await fixture();
  const rows: SnapshotRow[] = Array.from({ length: 200 }, (_, i) => ({
    id: `exp_${i}`,
    status: i % 2 === 0 ? "running" : "draft",
    lastStartedAt: i % 2 === 0 ? 1 : null,
  }));
  const samples = 20;
  await env.DB.batch(rows.map((row) => experimentInsert(sid, userId, row)));
  await env.DB.batch(Array.from({ length: samples }, (_, i) => reserveVersion(sid, userId, i + 1)));
  const condition = snapshotMatches(sid, rows);
  const after = rows.map(({ id, status }) => ({ id, status }));
  const snapshotCheck = sqlStatement(env.DB, sql`select ${condition} as matches`);
  const durations: number[] = [];
  for (let version = 1; version <= samples; version++) {
    const rowId = `pub_${version}`;
    const previous = version === 1 ? null : version - 1;
    // 比較用の SELECT も同じ batch に入れて 4 文で測る。CAS にも写しの条件を含める。
    const guard = activeGuard(sid, version, rowId);
    const batch = [
      sqlStatement(env.DB, sql`update sites set active_version = ${version}, last_activated_at = ${version}, static_seq = static_seq + 1,
        static_stale = 1, active_kv_stale = 1
        where id = ${sid} and active_version is ${previous}
          and exists (select 1 from publishes where id = ${rowId} and site_id = ${sid} and version = ${version} and status = 'reserved')
          and ${condition}`),
      snapshotCheck,
      publishedStatusStatement(testEnv, sid, after, guard),
      publishActiveStatement(testEnv, rowId, version, guard),
    ];
    const start = performance.now();
    const results = await env.DB.batch(batch);
    durations.push(performance.now() - start);
    expect(results.every(({ success }) => success)).toBe(true);
  }
  durations.sort((a, b) => a - b);
  const middle = samples / 2;
  const median = (durations[middle - 1]! + durations[middle]!) / 2;
  console.log(`b298 activation batch (200 experiments, ${samples} samples): median=${median.toFixed(2)}ms max=${durations.at(-1)!.toFixed(2)}ms`);
});
