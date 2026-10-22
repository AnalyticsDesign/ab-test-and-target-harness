import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { RUN_ID_RE } from "@wtt/core";
import { sql } from "kysely";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { recordDeliveredDefinitions, type DeliveredDefinition } from "../src/results/delivered";
import { call, choosePrimaryGoal, createExperiment, createSite, expectEnvelope, experimentRow, fakeDeployer, inviteAndJoin, json, RESULTS_STORE, setupOwner, TEXT_CHANGE } from "./helpers";

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

  it("duplicate_does_not_copy_run_id", async () => {
    // D9 ②: 計測用 D1 がある導入で作った Site(結果を記録する)の実行中のテスト。複製は別のテストなので run_id を写さない
    const owner = await setupOwner();
    const created = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
    const { id: sid } = await json<{ id: string }>(created);
    await createExperiment(owner.token, sid, { id: "exp_src" });
    await call("PUT", `/sites/${sid}/experiments/exp_src/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await choosePrimaryGoal(owner.token, sid, "exp_src"); // 結果を記録する開始は判定に使う目標が要る(D9 ③ Task 5)
    expect((await call("POST", `/sites/${sid}/experiments/exp_src/status`, { token: owner.token, body: { status: "running" }, envOverride: RESULTS_STORE })).status).toBe(200);
    const src = await experimentRow(sid, "exp_src");
    expect(src.run_id).toMatch(RUN_ID_RE);
    for (const [mode, id] of [["same", "exp_same"], ["variant", "exp_variant"]] as const) {
      const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: owner.token, body: { mode, id, ...(mode === "variant" ? { variantId: "b" } : {}) } });
      expect(res.status).toBe(201);
      expect((await json(res)).runId).toBeNull();
      const row = await experimentRow(sid, id);
      expect(row.run_id).toBeNull();
      expect(row.results_purged_at).toBeNull();
    }
    // 複製を開始すると、元とは別の run_id が振られる(variant の複製はパーソナライズなので振らない)。
    // same の複製は評価計画(判定に使う目標を含む)を写す(D9 ③ Task 12)ので、目標を選び直さずに開始できる
    expect((await call("POST", `/sites/${sid}/experiments/exp_same/status`, { token: owner.token, body: { status: "running" }, envOverride: RESULTS_STORE })).status).toBe(200);
    const copied = (await experimentRow(sid, "exp_same")).run_id;
    expect(copied).toMatch(RUN_ID_RE);
    expect(copied).not.toBe(src.run_id);
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

  it("duplicate_copies_original_and_description", async () => {
    // B77(K8・K9): 複製はオリジナルの印とメモを写す(作成の既定で a がオリジナル)
    const { token, sid } = await sourceTest();
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_src`, { token, body: { description: "経緯のメモ" } })).status).toBe(200);
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_src/variants/b`, { token, body: { description: "B のメモ" } })).status).toBe(200);
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.description).toBe("経緯のメモ");
    const d = await detail(token, sid, created.id);
    expect(d.variants.map((v: any) => [v.id, v.original, v.description])).toEqual([["a", true, ""], ["b", false, "B のメモ"]]);
  });

  it("duplicate_variant_mode_rejects_original", async () => {
    const { token, sid } = await sourceTest();
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "variant", variantId: "a" } });
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({
      error: "duplicate_original_variant",
      path: ["variantId"],
      message: "オリジナルのパターンはパーソナライズに複製できません",
      hint: "変更のあるパターンを選んでください",
    });
  });

  it("needs an editor", async () => {
    const { token, sid, workspaceId } = await sourceTest();
    const viewer = await inviteAndJoin(token, workspaceId, "viewer");
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: viewer.token, body: { mode: "same" } });
    expect(res.status).toBe(403);
  });
});

// D9 ③(設計書 §4.1、plan ③ の Task 12): variant の複製は配信した中身、same の複製は保存済みの中身と評価計画
describe("複製の中身と評価計画(D9 ③)", () => {
  const db = () => getDb(env as unknown as Env);
  /** 計測用 D1 がある導入の Site(結果を記録する) */
  async function resultsSite() {
    const owner = await setupOwner();
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(201);
    const { id: sid } = await json<{ id: string }>(res);
    return { ...owner, sid };
  }
  /** b に TEXT_CHANGE("Hello")を持ち、判定に使う目標を選んだテスト */
  async function testExperiment(token: string, sid: string, id: string) {
    await createExperiment(token, sid, { id });
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] })).status).toBe(200);
    await choosePrimaryGoal(token, sid, id);
  }
  async function transition(token: string, sid: string, eid: string, status: string, envOverride: Partial<Env> = {}) {
    const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride: { ...RESULTS_STORE, ...envOverride } });
    expect(res.status).toBe(200);
  }
  const setText = (token: string, sid: string, eid: string, text: string) =>
    call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [{ ...TEXT_CHANGE(), payload: { text } }] });
  const duplicate = (token: string, sid: string, eid: string, body: Record<string, unknown>) => call("POST", `/sites/${sid}/experiments/${eid}/duplicate`, { token, body });
  const savedChanges = (sid: string, eid: string) =>
    db()
      .selectFrom("changes")
      .select(["variant_id", "id", "type", "selector", "payload_json", "position", "created_by"])
      .where("site_id", "=", sid)
      .where("experiment_id", "=", eid)
      .orderBy("variant_id")
      .orderBy("position")
      .execute();
  const def = (text: string): DeliveredDefinition => ({
    variants: [
      { id: "a", changes: [] },
      { id: "b", changes: [{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text } }, { id: "c_hide", type: "HIDE", selector: ".old", payload: {} }] },
    ],
    urlMatch: { op: "contains", value: "/" },
    targeting: null,
    primaryGoal: { id: "g_primary", config: {} },
  });

  it("variant_duplicate_uses_delivered_definition", async () => {
    // 開始後に B の変更を保存だけして未公開 → variant の複製は配信した中身(開始の Publish で配った "Hello")
    const { token, userId, sid } = await resultsSite();
    await testExperiment(token, sid, "exp_t");
    await transition(token, sid, "exp_t", "running", { DEPLOYER: fakeDeployer() });
    const [row] = await db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).execute();
    expect(row!.delivered_from).not.toBeNull(); // 配信を確かめた行がある
    expect((await setText(token, sid, "exp_t", "saved, not published")).status).toBe(200);
    const res = await duplicate(token, sid, "exp_t", { mode: "variant", variantId: "b", id: "exp_b_only" });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ id: "exp_b_only", kind: "single", status: "draft", trafficPercentage: 100, persistAssignment: false });
    const copied = await savedChanges(sid, "exp_b_only");
    expect(copied.map(({ payload_json, ...c }) => ({ ...c, payload: JSON.parse(payload_json) }))).toEqual([
      { variant_id: "b", id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "Hello" }, position: 0, created_by: userId },
    ]);
    // same の複製は保存済みの中身(配信の記録があっても)
    expect((await duplicate(token, sid, "exp_t", { mode: "same", id: "exp_same" })).status).toBe(201);
    const same = await savedChanges(sid, "exp_same");
    expect(same.map((c) => [c.variant_id, c.id, JSON.parse(c.payload_json)])).toEqual([["b", "c_text", { text: "saved, not published" }]]);
    // 元は保存済みの中身のまま(元には何も書かない)
    expect((await savedChanges(sid, "exp_t")).map((c) => JSON.parse(c.payload_json))).toEqual([{ text: "saved, not published" }]);
  });

  it("variant の複製: 終了したテストは終了の直前に配信していた中身", async () => {
    // 行は直接入れる(終了の後に確かめた行は API では作れない)。v1 = "Before"(1000〜2000)、v2 = "After"(2000〜)
    const { token, sid } = await resultsSite();
    await testExperiment(token, sid, "exp_t");
    expect((await setText(token, sid, "exp_t", "Saved")).status).toBe(200);
    await sql`update experiments set status = 'running', run_id = 'run_dup_archived' where site_id = ${sid} and id = 'exp_t'`.execute(db());
    const rows = [await experimentRow(sid, "exp_t")];
    await recordDeliveredDefinitions(db(), sid, 1, null, new Map([["exp_t", def("Before")]]), rows);
    await recordDeliveredDefinitions(db(), sid, 2, null, new Map([["exp_t", def("After")]]), rows);
    await sql`update experiment_delivered_definitions set delivered_from = 1000, delivered_until = 2000, settled = 'delivered' where site_id = ${sid} and publish_version = 1`.execute(db());
    await sql`update experiment_delivered_definitions set delivered_from = 2000, settled = 'delivered' where site_id = ${sid} and publish_version = 2`.execute(db());
    await sql`update experiments set status = 'archived', started_at = 500, stopped_at = 1500 where site_id = ${sid} and id = 'exp_t'`.execute(db());
    expect((await duplicate(token, sid, "exp_t", { mode: "variant", variantId: "b", id: "exp_archived" })).status).toBe(201);
    const copied = await savedChanges(sid, "exp_archived");
    expect(copied.map((c) => [c.id, c.type, c.selector, JSON.parse(c.payload_json), c.position])).toEqual([
      ["c_text", "TEXT", ".hero-title", { text: "Before" }, 0],
      ["c_hide", "HIDE", ".old", {}, 1],
    ]);
    // 終了の後に配信が確かめられた行は使わない。終了の時刻が v2 の配信の後なら v2
    await sql`update experiments set stopped_at = 2500 where site_id = ${sid} and id = 'exp_t'`.execute(db());
    expect((await duplicate(token, sid, "exp_t", { mode: "variant", variantId: "b", id: "exp_archived_late" })).status).toBe(201);
    expect((await savedChanges(sid, "exp_archived_late")).map((c) => JSON.parse(c.payload_json))).toEqual([{ text: "After" }, {}]);
  });

  it("variant の複製: 配信の記録が無いテストは保存済みの中身", async () => {
    // 配信を確かめていない(出し直しが pending のまま)行しか無いテスト・配信の記録が無いテストは、variant の複製でも保存済みの中身
    const { token, workspaceId, sid } = await resultsSite();
    await testExperiment(token, sid, "exp_pending");
    await transition(token, sid, "exp_pending", "running", { DEPLOYER: fakeDeployer("pending") });
    const pending = await db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).execute();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.delivered_from).toBeNull();
    expect((await setText(token, sid, "exp_pending", "Saved pending")).status).toBe(200);
    expect((await duplicate(token, sid, "exp_pending", { mode: "variant", variantId: "b", id: "exp_p1" })).status).toBe(201);
    expect((await savedChanges(sid, "exp_p1")).map((c) => JSON.parse(c.payload_json))).toEqual([{ text: "Saved pending" }]);
    // 結果を記録しない Site のテスト(run_id も届く定義の行も無い)
    const plain = { token, workspaceId };
    const { id: sid2 } = await createSite(plain.token, plain.workspaceId);
    await createExperiment(plain.token, sid2, { id: "exp_plain" });
    expect((await setText(plain.token, sid2, "exp_plain", "Plain saved")).status).toBe(200);
    expect((await call("POST", `/sites/${sid2}/experiments/exp_plain/status`, { token: plain.token, body: { status: "running" } })).status).toBe(200);
    expect((await setText(plain.token, sid2, "exp_plain", "Plain saved later")).status).toBe(200);
    expect((await duplicate(plain.token, sid2, "exp_plain", { mode: "variant", variantId: "b", id: "exp_p2" })).status).toBe(201);
    expect((await savedChanges(sid2, "exp_p2")).map((c) => JSON.parse(c.payload_json))).toEqual([{ text: "Plain saved later" }]);
  });

  it("same の複製は評価計画を写し、固定と到達は写さない", async () => {
    const { token, sid } = await resultsSite();
    await testExperiment(token, sid, "exp_t");
    const planBody = { primaryGoalId: "g_primary", baselineVariantId: "b", minDays: 21, maxWeeks: 10, targetPerVariant: 500, delta: 1, rope: 0.5, threshold: 97 };
    expect((await call("PUT", `/sites/${sid}/experiments/exp_t/evaluation-plan`, { token, body: { plan: planBody } })).status).toBe(200);
    await transition(token, sid, "exp_t", "running");
    // 開始後の変更(履歴に残る)と、到達の記録
    expect((await call("PUT", `/sites/${sid}/experiments/exp_t/evaluation-plan`, { token, body: { plan: { minDays: 28 }, reason: "延長" } })).status).toBe(200);
    await sql`update evaluation_plans set reached_at = 111, reached_recorded_at = 222, reach_checked_day = '2026-10-19' where site_id = ${sid} and experiment_id = 'exp_t'`.execute(db());
    const src = await db().selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", "exp_t").executeTakeFirstOrThrow();
    expect(src.fixed_at).not.toBeNull();

    expect((await duplicate(token, sid, "exp_t", { mode: "same", id: "exp_same" })).status).toBe(201);
    const copy = await db().selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", "exp_same").executeTakeFirstOrThrow();
    expect(copy).toMatchObject({ plan_json: src.plan_json, version: 1, fixed_at: null, reached_at: null, reached_recorded_at: null, reach_checked_day: null });
    // 評価計画の変更の履歴は写さない
    const history = await db().selectFrom("evaluation_plan_changes").select("id").where("site_id", "=", sid).where("experiment_id", "=", "exp_same").execute();
    expect(history).toHaveLength(0);
    // API では下書きの計画として見える(固定されていない・元の値)
    const view = await json(await call("GET", `/sites/${sid}/experiments/exp_same/evaluation-plan`, { token }));
    expect(view).toMatchObject({ fixed: false, fixedAt: null, changes: [], plan: { ...planBody, minDays: 28 } });
    // 下書きの間は変えられ、そのまま開始できる(判定に使う目標を選び直さない)
    expect((await call("PUT", `/sites/${sid}/experiments/exp_same/evaluation-plan`, { token, body: { plan: { minDays: 14 } } })).status).toBe(200);
    await transition(token, sid, "exp_same", "running");
    expect((await db().selectFrom("evaluation_plans").select("fixed_at").where("site_id", "=", sid).where("experiment_id", "=", "exp_same").executeTakeFirstOrThrow()).fixed_at).not.toBeNull();

    // variant の複製(パーソナライズ)と、計画の行が無いテストの same の複製は、計画の行を作らない
    expect((await duplicate(token, sid, "exp_t", { mode: "variant", variantId: "b", id: "exp_variant" })).status).toBe(201);
    await createExperiment(token, sid, { id: "exp_noplan" });
    expect((await duplicate(token, sid, "exp_noplan", { mode: "same", id: "exp_noplan_copy" })).status).toBe(201);
    for (const id of ["exp_variant", "exp_noplan_copy"]) {
      const r = await db().selectFrom("evaluation_plans").select("experiment_id").where("site_id", "=", sid).where("experiment_id", "=", id).executeTakeFirst();
      expect(r, id).toBeUndefined();
    }
  });

  it("複製の応答に元の判定・採用の要約を出さない(元に何も書かない)", async () => {
    const { token, sid } = await resultsSite();
    await testExperiment(token, sid, "exp_t");
    await transition(token, sid, "exp_t", "running", { DEPLOYER: fakeDeployer() });
    await transition(token, sid, "exp_t", "archived", { DEPLOYER: fakeDeployer() });
    const runId = (await experimentRow(sid, "exp_t")).run_id!;
    // 元の結果の記録と採用
    await sql`insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (${sid}, 'exp_t', 'stop', ${runId}, 1, 2, 'v1', '{"verdict":"winner"}')`.execute(db());
    await sql`insert into adoptions (site_id, experiment_id, variant_id, note, decided_by, decided_at) values (${sid}, 'exp_t', 'b', 'B を採用', null, 3)`.execute(db());
    const snapshotOf = async () => {
      const out: Record<string, unknown> = {};
      for (const table of ["experiments", "variants", "changes", "evaluation_plans", "evaluation_plan_changes", "result_snapshots", "adoptions", "experiment_delivered_definitions", "experiment_delivery_changes"]) {
        const col = table === "experiments" ? "id" : "experiment_id";
        out[table] = (await env.DB.prepare(`select * from ${table} where site_id = ? and ${col} = 'exp_t' order by rowid`).bind(sid).all()).results;
      }
      return out;
    };
    const before = await snapshotOf();
    for (const [mode, id] of [["same", "exp_c_same"], ["variant", "exp_c_variant"]] as const) {
      const res = await duplicate(token, sid, "exp_t", { mode, id, ...(mode === "variant" ? { variantId: "b" } : {}) });
      expect(res.status).toBe(201);
      const body = await json(res);
      // 応答はエクスペリエンスの形だけ(判定・採用・結果の要約のキーを持たない)
      expect(Object.keys(body).sort()).toEqual(
        ["id", "siteId", "name", "description", "kind", "status", "publishedStatus", "urlMatch", "targeting", "trafficPercentage", "persistAssignment", "analytics", "runId", "createdBy", "updatedBy", "createdAt", "updatedAt", "unpublished"].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(/verdict|winner|adopt|B を採用/);
      // 複製には結果の記録・採用・届く定義を写さない
      for (const table of ["result_snapshots", "adoptions", "experiment_delivered_definitions", "experiment_delivery_changes", "evaluation_plan_changes"]) {
        const n = await env.DB.prepare(`select count(*) as n from ${table} where site_id = ? and experiment_id = ?`).bind(sid, id).first<{ n: number }>();
        expect(n!.n, `${mode} ${table}`).toBe(0);
      }
    }
    expect(await snapshotOf()).toEqual(before); // 元には何も書かない
  });
});

// B37: 管理画面は experiments/new を新規作成の画面にしているので、ID の new はエクスペリエンスでも予約する(オーディエンスと同じ 422 validation_failed)
describe("experiment id `new` is reserved (B37)", () => {
  it("作成と複製の ID に new を使うと 422 validation_failed(path は id)", async () => {
    const { token, sid } = await sourceTest();
    const created = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "new", name: "x", urlMatch: { op: "contains", value: "/" } } });
    expect(created.status).toBe(422);
    expect(await json(created)).toMatchObject({ error: "validation_failed", path: ["id"] });
    const dup = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", id: "new" } });
    expect(dup.status).toBe(422);
    expect(await json(dup)).toMatchObject({ error: "validation_failed", path: ["id"] });
    // new を含むだけの ID は使える
    expect((await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", id: "new-hero" } })).status).toBe(201);
  });
});
