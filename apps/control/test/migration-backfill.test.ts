import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** B77(K7): 0015 のマイグレーションが、開始済みのデータに名前を外部計測の名前として写す */

type Row = { id: string; analytics_json: string | null; updated_at: number };
type VarRow = { experiment_id: string; id: string; analytics_json: string | null };

const parse = (r: { analytics_json: string | null }) => (r.analytics_json === null ? null : JSON.parse(r.analytics_json));
/** 辞書から行を取る(無ければテストの失敗にする) */
const at = <T>(rows: Record<string, T>, key: string): T => {
  const r = rows[key];
  if (r === undefined) throw new Error(`row not found: ${key}`);
  return r;
};

describe("migration 0015: variant original / memo / goal analytics", () => {
  it("backfill_copies_names_for_started_only", async () => {
    // 既存の導入を再現する: このマイグレーションより前までを当て、古い形(列の無い表)で種を入れてから残りを当てる
    const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_variant_original_and_memo.sql"))!.name;
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
    const t = 1_700_000_000_000;
    const extraOnly = JSON.stringify({ extra: { team: { value: "x" } } });
    const overridden = JSON.stringify({ overrides: { experimentName: "指定済み", variantName: "指定済みの名前" }, extra: { k: "v" } });
    const otherOverride = JSON.stringify({ overrides: { variantName: "V指定" } });
    const insertExp =
      `insert into experiments (site_id, id, name, url_match_json, analytics_json, started_at, created_by, updated_by, created_at, updated_at) values (?1, ?2, ?3, '{}', ?4, ?5, 'u', 'u', ?6, ?6)`;
    const insertVar = `insert into variants (site_id, experiment_id, id, name, weight, position, analytics_json) values ('s1', ?1, ?2, ?3, 50, 0, ?4)`;
    const insertGoal = `insert into goals (site_id, id, name, type, config_json, created_at, updated_at) values ('s1', ?1, ?2, 'CUSTOM', '{}', ?3, ?3)`;
    await env.DB.batch([
      env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`),
      env.DB.prepare(
        `insert into sites (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at) values ('s1', 'w1', 'S', 'example.com', 'salt', ?1, ?1, ?1)`,
      ).bind(t),
      // 開始済み: 上書き無し(analytics_json NULL)・extra だけ・上書きのあるもの・別の上書きだけ。下書き 1 つ
      env.DB.prepare(insertExp).bind("s1", "e_plain", "開始済みの名前", null, t, t),
      env.DB.prepare(insertExp).bind("s1", "e_extra", "extra のあるテスト", extraOnly, t, t),
      env.DB.prepare(insertExp).bind("s1", "e_over", "上書きのあるテスト", overridden, t, t),
      env.DB.prepare(insertExp).bind("s1", "e_other", "別のキー", otherOverride, t, t),
      env.DB.prepare(insertExp).bind("s1", "e_draft", "下書きの名前", null, null, t),
      env.DB.prepare(insertVar).bind("e_plain", "a", "パターン A", null),
      env.DB.prepare(insertVar).bind("e_extra", "a", "パターン A2", extraOnly),
      env.DB.prepare(insertVar).bind("e_over", "a", "パターン A3", overridden),
      env.DB.prepare(insertVar).bind("e_draft", "a", "下書きのパターン", null),
      env.DB.prepare(insertVar).bind("e_other", "a", "パターン A4", otherOverride),
      env.DB.prepare(insertVar).bind("e_other", "b", "パターン B4", null),
      env.DB.prepare(insertGoal).bind("g1", "購入", t),
      env.DB.prepare(insertGoal).bind("g2", "資料請求", t),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const exps = Object.fromEntries(
      (await env.DB.prepare(`select id, analytics_json, updated_at from experiments where site_id = 's1'`).all<Row>()).results.map((r) => [r.id, r]),
    );
    // 開始済みで上書き無し → experimentName に名前
    expect(parse(at(exps, "e_plain"))).toEqual({ overrides: { experimentName: "開始済みの名前" } });
    // extra だけ → extra は残り、experimentName が足される
    expect(parse(at(exps, "e_extra"))).toEqual({ extra: { team: { value: "x" } }, overrides: { experimentName: "extra のあるテスト" } });
    // 上書きのあるもの → 変わらない
    expect(at(exps, "e_over").analytics_json).toBe(overridden);
    // 別のキーの上書きだけ → 別のキーは残り、experimentName が足される
    expect(parse(at(exps, "e_other"))).toEqual({ overrides: { variantName: "V指定", experimentName: "別のキー" } });
    // 下書き → 変わらない(NULL のまま)
    expect(at(exps, "e_draft").analytics_json).toBeNull();

    const vars = Object.fromEntries(
      (await env.DB.prepare(`select experiment_id, id, analytics_json from variants where site_id = 's1'`).all<VarRow>()).results.map((r) => [`${r.experiment_id}/${r.id}`, r]),
    );
    expect(parse(at(vars, "e_plain/a"))).toEqual({ overrides: { variantName: "パターン A" } });
    expect(parse(at(vars, "e_extra/a"))).toEqual({ extra: { team: { value: "x" } }, overrides: { variantName: "パターン A2" } });
    expect(at(vars, "e_over/a").analytics_json).toBe(overridden); // variantName の指定がある → 変わらない
    expect(at(vars, "e_draft/a").analytics_json).toBeNull(); // 下書きのパターンは写さない
    expect(parse(at(vars, "e_other/a"))).toEqual({ overrides: { variantName: "V指定" } }); // 既存の指定を保つ
    expect(parse(at(vars, "e_other/b"))).toEqual({ overrides: { variantName: "パターン B4" } });

    // 目標: すべて goalName に名前
    const goals = (await env.DB.prepare(`select id, analytics_json, updated_at from goals where site_id = 's1' order by id`).all<Row>()).results;
    expect(goals.map(parse)).toEqual([{ overrides: { goalName: "購入" } }, { overrides: { goalName: "資料請求" } }]);

    // どの行の updated_at も変わらない(出力が変わらないので「未公開の編集あり」を付けない)
    for (const r of [...Object.values(exps), ...goals]) expect(r.updated_at).toBe(t);

    // 新しい列の既定値
    const v = await env.DB.prepare(`select original, description from variants where experiment_id = 'e_plain'`).first<{ original: number; description: string }>();
    expect(v).toEqual({ original: 0, description: "" });
    const e = await env.DB.prepare(`select description from experiments where id = 'e_plain'`).first<{ description: string }>();
    expect(e!.description).toBe("");
  });
});

describe("migration 0017: new profile budget column (plan12 K15)", () => {
  it("existing sites get NULL (= the plan default)", async () => {
    const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_plan12_defense.sql"))!.name;
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
    const t = 1_700_000_000_000;
    await env.DB.batch([
      env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`),
      env.DB.prepare(`insert into sites (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at) values ('s1', 'w1', 'S', 'example.com', 'salt', ?1, ?1, ?1)`).bind(t),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const row = await env.DB.prepare(`select new_profile_budget_per_day as v from sites where id = 's1'`).first<{ v: number | null }>();
    expect(row).toEqual({ v: null });
  });
});
