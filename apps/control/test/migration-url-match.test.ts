import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { compileRegex, matchPage, matchTargetUrl, pageOf, UrlMatchInputSchema, type PageMatch } from "@wtt/core";

/**
 * B69(spec §6.1): 対象 URL を含める行に包む・届いた定義の urlMatch を包む・ページの条件が残った running を一時停止して記録する
 * マイグレーション。番号は main に入る順で振るので、ファイル名の末尾で探す
 */

const MIGRATION_SUFFIX = "_url_match_include.sql";
const T = 1_700_000_000_000;

/** このマイグレーションより前までを当て、古い形の行を入れてから残りを当てる */
async function migrateWith(seed: D1PreparedStatement[]): Promise<void> {
  const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith(MIGRATION_SUFFIX))!.name;
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
  await env.DB.batch([
    env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`),
    site("s1"),
    site("s2"),
    ...seed,
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
/** applyD1Migrations は当てた版を飛ばすので、2 回目は文を直接流す */
async function applyMineAgain(): Promise<void> {
  const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith(MIGRATION_SUFFIX))!;
  for (const q of mine.queries) {
    // ALTER TABLE ADD COLUMN は 2 回は当てられない(列の追加は D1 のマイグレーションの記録が 1 回にする)。ほかの文は冪等であること
    if (/^\s*ALTER TABLE/i.test(q)) continue;
    await env.DB.prepare(q).run();
  }
}

const site = (id: string) =>
  env.DB.prepare(`insert into sites (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at) values (?1, 'w1', ?1, 'example.com', 'salt', ?2, ?2, ?2)`).bind(id, T);
const experiment = (siteId: string, id: string, urlMatch: unknown, opts: { status?: string; targeting?: unknown } = {}) =>
  env.DB.prepare(
    `insert into experiments (site_id, id, name, status, url_match_json, targeting_json, created_by, updated_by, created_at, updated_at) values (?1, ?2, ?2, ?3, ?4, ?5, 'u', 'u', ?6, ?6)`,
  ).bind(siteId, id, opts.status ?? "running", JSON.stringify(urlMatch), opts.targeting === undefined ? null : JSON.stringify(opts.targeting), T);
const audience = (siteId: string, id: string, definition: unknown) =>
  env.DB.prepare(`insert into audiences (site_id, id, name, definition_json, created_at, updated_at) values (?1, ?2, ?2, ?3, ?4, ?4)`).bind(siteId, id, JSON.stringify(definition), T);
const delivered = (siteId: string, experimentId: string, definition: unknown) =>
  env.DB.prepare(
    `insert into experiment_delivered_definitions (site_id, experiment_id, run_id, publish_version, definition_json, definition_hash) values (?1, ?2, 'run_1', 1, ?3, 'h')`,
  ).bind(siteId, experimentId, JSON.stringify(definition));
const snapshot = (siteId: string, experimentId: string, result: unknown) =>
  env.DB.prepare(
    `insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?1, ?2, 'stop', 'run_1', ?3, ?3, 'v1', ?4)`,
  ).bind(siteId, experimentId, T, JSON.stringify(result));

type ExpRow = { site_id: string; id: string; status: string; url_match_json: string; updated_at: number };
async function experiments(): Promise<Record<string, ExpRow>> {
  const rows = (await env.DB.prepare(`select site_id, id, status, url_match_json, updated_at from experiments`).all<ExpRow>()).results;
  return Object.fromEntries(rows.map((r) => [`${r.site_id}/${r.id}`, r]));
}
type AuditRow = { category: string; action: string; workspace_id: string; site_id: string; experiment_id: string; via: string; actor_user_id: string | null; target_type: string; target_id: string; target_label: string; experiment_generation: string | null; detail_json: string };
const audits = async () =>
  (await env.DB.prepare(`select category, action, workspace_id, site_id, experiment_id, via, actor_user_id, target_type, target_id, target_label, experiment_generation, detail_json from audit_events where action = 'experiment.status' order by site_id, experiment_id`).all<AuditRow>()).results;

/** 照合に渡す形(正規表現は命令列を付ける。compile と同じ) */
const compiled = (m: { part?: string; op: string; value: string }): PageMatch => {
  if (m.op !== "regex") return m as PageMatch;
  const c = compileRegex(m.value);
  if (!c.ok) throw new Error(c.issue.code);
  return { ...(m as PageMatch), prog: c.prog };
};

/** 代表の 6 形と、各形で一致する URL・一致しない URL(spec §6.1) */
const SHAPES: Array<{ id: string; m: { part?: "url" | "path" | "host"; op: string; value: string } }> = [
  { id: "e_url_eq", m: { part: "url", op: "equals", value: "https://example.com/lp/a" } },
  { id: "e_url_contains", m: { part: "url", op: "contains", value: "/lp/" } },
  { id: "e_url_starts", m: { part: "url", op: "startsWith", value: "https://example.com/lp" } },
  { id: "e_path_regex", m: { part: "path", op: "regex", value: "^/p/\\d+$" } },
  { id: "e_host_ends", m: { part: "host", op: "endsWith", value: "example.com" } },
  { id: "e_no_part", m: { op: "contains", value: "/lp/" } },
];
const URLS = [
  "https://example.com/lp/a",
  "https://example.com/lp/b?x=1",
  "https://shop.example.com/p/123",
  "https://other.test/p/12a",
  "https://other.test/",
  "not a url",
];

describe("migration url_match_include (B69)", () => {
  it("migration_wraps_url_match_as_include_page_row", async () => {
    const snap = { definition: { urlMatch: SHAPES[0]!.m }, variants: [] };
    await migrateWith([
      ...SHAPES.map((s) => experiment("s1", s.id, s.m, { status: "draft" })),
      delivered("s1", "e_path_regex", { primaryGoal: null, targeting: null, urlMatch: SHAPES[3]!.m, variants: [] }),
      snapshot("s1", "e_url_eq", snap),
    ]);
    const check = async () => {
      const rows = await experiments();
      for (const s of SHAPES) {
        const stored = JSON.parse(rows[`s1/${s.id}`]!.url_match_json);
        expect(stored).toEqual({ include: [{ page: s.m }] });
        // 保存の形の schema を通る
        expect(UrlMatchInputSchema.safeParse(stored).success).toBe(true);
        // 照合の結果が元の matchPage と同じ(判定できない null は対象外 = false)
        const wrapped = { include: [{ page: compiled(s.m) }] };
        for (const url of URLS) expect([s.id, url, matchTargetUrl(wrapped, pageOf(url))]).toEqual([s.id, url, matchPage(compiled(s.m), pageOf(url)) === true]);
      }
      const d = await env.DB.prepare(`select definition_json, definition_hash from experiment_delivered_definitions`).first<{ definition_json: string; definition_hash: string }>();
      const def = JSON.parse(d!.definition_json);
      expect(def).toEqual({ primaryGoal: null, targeting: null, urlMatch: { include: [{ page: SHAPES[3]!.m }] }, variants: [] });
      expect(UrlMatchInputSchema.safeParse(def.urlMatch).success).toBe(true);
      // hash は SQL で計算し直せないので古いまま(spec §6.1)
      expect(d!.definition_hash).toBe("h");
      // 結果の記録は包まない
      const r = await env.DB.prepare(`select result_json from result_snapshots`).first<{ result_json: string }>();
      expect(JSON.parse(r!.result_json)).toEqual(snap);
    };
    await check();
    const before = await experiments();
    await applyMineAgain();
    await check();
    expect(await experiments()).toEqual(before);
  });

  it("migration_pauses_running_with_page_conditions", async () => {
    const url = { op: "contains", value: "/" };
    const query = { ctx: "query", name: "utm", op: "exists" };
    const device = { ctx: "device", op: "in", value: ["mobile"] };
    await migrateWith([
      audience("s1", "aud_page", { and: [device, { not: { ctx: "path", op: "startsWith", value: "/lp/" } }] }),
      audience("s1", "aud_ok", device),
      // 別のサイトに同じ ID の正常なオーディエンス(s2 の参照は s2 の定義で見る)
      audience("s2", "aud_page", device),
      experiment("s1", "e_direct", url, { targeting: { and: [device, query] } }),
      experiment("s1", "e_via_aud", url, { targeting: { or: [{ audience: "aud_ok" }, { audience: "aud_page" }] } }),
      experiment("s2", "e_other_site", url, { targeting: { audience: "aud_page" } }),
      experiment("s1", "e_clean", url, { targeting: { and: [device, { audience: "aud_ok" }] } }),
      experiment("s1", "e_no_targeting", url),
      experiment("s1", "e_draft", url, { status: "draft", targeting: query }),
      experiment("s1", "e_paused", url, { status: "paused", targeting: { audience: "aud_page" } }),
      experiment("s1", "e_archived", url, { status: "archived", targeting: { ctx: "host", op: "equals", value: "example.com" } }),
    ]);
    const check = async () => {
      const rows = await experiments();
      expect(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.status]))).toEqual({
        "s1/e_direct": "paused",
        "s1/e_via_aud": "paused",
        "s2/e_other_site": "running",
        "s1/e_clean": "running",
        "s1/e_no_targeting": "running",
        "s1/e_draft": "draft",
        "s1/e_paused": "paused",
        "s1/e_archived": "archived",
      });
      // 一時停止したものだけ updated_at が進む(未公開の変更になる)
      expect(rows["s1/e_direct"]!.updated_at).toBeGreaterThan(T);
      expect(rows["s1/e_via_aud"]!.updated_at).toBeGreaterThan(T);
      expect(rows["s1/e_clean"]!.updated_at).toBe(T);
      expect(rows["s1/e_paused"]!.updated_at).toBe(T);
      const a = await audits();
      expect(a).toHaveLength(2);
      for (const [row, eid] of [[a[0]!, "e_direct"], [a[1]!, "e_via_aud"]] as const) {
        expect(row).toMatchObject({
          category: "content", action: "experiment.status", workspace_id: "w1", site_id: "s1", experiment_id: eid,
          via: "system", actor_user_id: null, target_type: "experiment", target_id: eid, target_label: eid,
        });
        expect(row.experiment_generation).toMatch(/^[0-9a-f]{32}$/);
        expect(JSON.parse(row.detail_json)).toEqual({ from: "running", to: "paused", reason: "page_condition_moved" });
      }
    };
    await check();
    await applyMineAgain();
    await check();
  });

  it("publishes に experiment_ids_json の列を足す(既存の行は NULL)", async () => {
    await migrateWith([
      env.DB.prepare(`insert into publishes (id, site_id, version, status, published_by, created_at) values ('p1', 's1', 1, 'active', 'u', ?1)`).bind(T),
    ]);
    const r = await env.DB.prepare(`select experiment_ids_json from publishes where id = 'p1'`).first<{ experiment_ids_json: string | null }>();
    expect(r).toEqual({ experiment_ids_json: null });
  });
});
