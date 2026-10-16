import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, setupOwner, TEXT_CHANGE } from "./helpers";

async function sourceTest() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  await createExperiment(owner.token, sid, { id: "exp_src", name: "購入ボタンの文言テスト", urlMatch: { op: "startsWith", value: "/lp" }, trafficPercentage: 50, persistAssignment: true, analytics: { overrides: { experimentName: "buy_copy" } } });
  await call("PUT", `/sites/${sid}/experiments/exp_src/variants`, { token: owner.token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50, analytics: { overrides: { variantName: "buy_b" } } }] });
  await call("PUT", `/sites/${sid}/experiments/exp_src/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE("c1"), { id: "c2", type: "HIDE", selector: ".old", payload: {} }] });
  return { ...owner, sid };
}
const detail = (token: string, sid: string, eid: string) => call("GET", `/sites/${sid}/experiments/${eid}`, { token }).then((r) => json(r));

describe("POST …/duplicate (決定 51、設計書 §4.1)", () => {
  it("same_duplicate_uses_saved_definition", async () => {
    const { token, sid } = await sourceTest();
    const started = await json(await call("POST", `/sites/${sid}/experiments/exp_src/status`, { token, body: { status: "running" } }));
    expect(started.publish.ok).toBe(true);
    // 公開した後に変更を書き換え、公開しない(保存済みの中身 ≠ 配信中の中身)
    await call("PUT", `/sites/${sid}/experiments/exp_src/variants/b/changes`, { token, body: [{ id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "saved after publish" } }] });
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({ id: "exp_src-copy", name: "購入ボタンの文言テスト のコピー", kind: "test", status: "draft", publishedStatus: null, trafficPercentage: 50, persistAssignment: true, urlMatch: { op: "startsWith", value: "/lp" }, analytics: { overrides: { experimentName: "buy_copy" } }, unpublished: true });
    const d = await detail(token, sid, created.id);
    expect(d.variants.map((v: any) => [v.id, v.name, v.weight, v.analytics])).toEqual([["a", "A", 50, null], ["b", "B", 50, { overrides: { variantName: "buy_b" } }]]);
    expect(d.variants[1].changes.map((c: any) => [c.id, c.payload])).toEqual([["c1", { text: "saved after publish" }]]); // 保存済みの中身
    const published = await json(await call("GET", `/sites/${sid}/publishes/${started.publish.version}`, { token }));
    expect(JSON.stringify(published.config)).toContain("Hello"); // 配信中の設定は書き換え前(TEXT_CHANGE の "Hello")のまま
    const row = await env.DB.prepare("select started_at, stopped_at from experiments where site_id = ? and id = ?").bind(sid, created.id).first();
    expect(row).toEqual({ started_at: null, stopped_at: null }); // 開始 / 終了の時刻は写さない
  });

  it("variant_duplicate_sets_traffic_100_and_persist_off", async () => {
    const { token, sid } = await sourceTest();
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "variant", variantId: "b" } });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({ id: "exp_src-copy", name: "購入ボタンの文言テスト(B だけを表示)", kind: "single", trafficPercentage: 100, persistAssignment: false, urlMatch: { op: "startsWith", value: "/lp" } });
    const d = await detail(token, sid, created.id);
    expect(d.variants.map((v: any) => [v.id, v.name, v.weight, v.analytics])).toEqual([["b", "B", 100, { overrides: { variantName: "buy_b" } }]]);
    expect(d.variants[0].changes.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  });

  it("works from any status and leaves the source untouched", async () => {
    const { token, sid } = await sourceTest();
    await env.DB.prepare("update experiments set status = 'archived', started_at = 1, stopped_at = 2 where site_id = ? and id = 'exp_src'").bind(sid).run();
    const before = await env.DB.prepare("select * from experiments where site_id = ? and id = 'exp_src'").bind(sid).first();
    expect((await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", id: "exp_again", name: "もう一度" } })).status).toBe(201);
    expect(await env.DB.prepare("select * from experiments where site_id = ? and id = 'exp_src'").bind(sid).first()).toEqual(before);
    expect((await detail(token, sid, "exp_again")).status).toBe("draft");
  });

  it("a single source only accepts mode same", async () => {
    const { token, sid } = await sourceTest();
    await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "variant", variantId: "b", id: "exp_single" } });
    const refused = await call("POST", `/sites/${sid}/experiments/exp_single/duplicate`, { token, body: { mode: "variant", variantId: "b" } });
    expect(refused.status).toBe(422);
    expect((await expectEnvelope(refused)).error).toBe("duplicate_mode_not_allowed");
    const same = await json(await call("POST", `/sites/${sid}/experiments/exp_single/duplicate`, { token, body: { mode: "same" } }));
    expect(same).toMatchObject({ id: "exp_single-copy", kind: "single", trafficPercentage: 100 });
  });

  it("validates the body", async () => {
    const { token, sid } = await sourceTest();
    const noVariant = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "variant" } });
    expect((await json(noVariant)).error).toBe("validation_failed");
    const unknown = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "variant", variantId: "zz" } });
    expect(await expectEnvelope(unknown)).toMatchObject({ error: "unknown_variant", path: ["variantId"] });
    const taken = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", id: "exp_src" } });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toBe("id_taken");
    const longName = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", name: "x".repeat(101) } });
    expect((await json(longName)).error).toBe("name_too_long");
    expect((await call("POST", `/sites/${sid}/experiments/exp_none/duplicate`, { token, body: { mode: "same" } })).status).toBe(404);
  });

  it("skips taken ids for the automatic id", async () => {
    const { token, sid } = await sourceTest();
    await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    const second = await json(await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } }));
    expect(second.id).toBe("exp_src-copy-2");
  });

  it("duplicate fails with id_taken when all candidates are taken", async () => {
    const { token, sid } = await sourceTest();
    const now = Date.now();
    const ids = ["exp_src-copy", ...Array.from({ length: 98 }, (_, i) => `exp_src-copy-${i + 2}`)];
    await env.DB.batch(ids.map((id) => env.DB.prepare("insert into experiments (site_id, id, name, url_match_json, created_by, updated_by, created_at, updated_at) values (?, ?, 'x', '{\"op\":\"contains\",\"value\":\"/\"}', 'u', 'u', ?, ?)").bind(sid, id, now, now)));
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "id_taken", hint: "使っていない複製を削除してから、もう一度複製してください(API では id を指定できます)" });
  });

  it("copies many patterns and changes within the D1 parameter limit", async () => {
    // パターンと変更は元の行から INSERT … SELECT で写すので、数にかかわらず batch は 3 文・1 文のパラメータは 100 個未満(レビュー r1 CL-Low-9)
    const { token, sid } = await sourceTest();
    const variants = Array.from({ length: 15 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, weight: i === 0 ? 16 : 6 }));
    expect((await call("PUT", `/sites/${sid}/experiments/exp_src/variants`, { token, body: variants })).status).toBe(200);
    const changes = Array.from({ length: 20 }, (_, i) => TEXT_CHANGE(`c${i}`));
    expect((await call("PUT", `/sites/${sid}/experiments/exp_src/variants/v1/changes`, { token, body: changes })).status).toBe(200);
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    expect(res.status).toBe(201);
    const d = await detail(token, sid, (await json(res)).id);
    expect(d.variants).toHaveLength(15);
    expect(d.variants[1].changes).toHaveLength(20);
  });

  it("variant_removed_during_duplicate_leaves_no_copy", async () => {
    // 読んだ後・書く前に元が編集された(ここではパターン b を消す)。batch の直前に割り込む D1 の Proxy で再現する(レビュー r2 CX-High-4)
    const { token, sid } = await sourceTest();
    const racingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            await target.batch([
              target.prepare("delete from variants where site_id = ? and experiment_id = 'exp_src' and id = 'b'").bind(sid),
              target.prepare("update variants set weight = 100 where site_id = ? and experiment_id = 'exp_src' and id = 'a'").bind(sid),
              target.prepare("update experiments set updated_at = updated_at + 1 where site_id = ? and id = 'exp_src'").bind(sid), // 子の書き込みは親の updated_at を進める
            ]);
            return target.batch(stmts);
          };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, envOverride: { DB: racingDb }, body: { mode: "variant", variantId: "b" } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "duplicate_source_changed", hint: "もう一度複製してください" });
    for (const table of ["experiments", "variants", "changes"]) {
      const n = await env.DB.prepare(`select count(*) as n from ${table} where site_id = ? and ${table === "experiments" ? "id" : "experiment_id"} = 'exp_src-copy'`).bind(sid).first<{ n: number }>();
      expect(n!.n, table).toBe(0);
    }
  });

  it("needs an editor", async () => {
    const { token, sid, workspaceId } = await sourceTest();
    const viewer = await inviteAndJoin(token, workspaceId, "viewer");
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: viewer.token, body: { mode: "same" } });
    expect(res.status).toBe(403);
  });
});
