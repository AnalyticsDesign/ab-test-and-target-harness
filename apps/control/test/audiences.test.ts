import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { patternIdOf } from "@wtt/core";
import { getDb } from "../src/db";
import { call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, publishRes, setupOwner } from "./helpers";

const PRICING = { part: "path", op: "startsWith", value: "/pricing/" };
const DEF = { and: [{ hist: "visited", page: PRICING, min: 2, withinDays: 30 }, { not: { hist: "converted", goal: "g_lead" } }] };

async function siteWithGoal() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId); // retentionDays は既定の 90
  expect((await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_lead", name: "資料請求", type: "CUSTOM", config: {} } })).status).toBe(201);
  return { owner, sid };
}
const createAudience = (token: string, sid: string, body: Record<string, unknown>) => call("POST", `/sites/${sid}/audiences`, { token, body: { id: "aud_pricing", name: "料金ページ閲覧・資料請求前", definition: DEF, ...body } });

describe("オーディエンスの API(決定 49、設計書 §5)", () => {
  it("作成・一覧・取得・更新・削除。保存する値は正規化した後のもの。Site レベルの未公開の変更に数える", async () => {
    const { owner, sid } = await siteWithGoal();
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    const created = await createAudience(owner.token, sid, { description: "料金を比較している段階", definition: { and: [{ or: [{ hist: "visited", page: { ...PRICING, value: "/料金/" }, min: 1 }] }, { not: { hist: "converted", goal: "g_lead" } }] } });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      id: "aud_pricing", description: "料金を比較している段階", usedBy: [],
      definition: { and: [{ hist: "visited", page: { part: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" } }, { not: { hist: "converted", goal: "g_lead" } }] },
    });
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(true);
    expect((await json<Array<{ id: string }>>(await call("GET", `/sites/${sid}/audiences`, { token: owner.token }))).map((a) => a.id)).toEqual(["aud_pricing"]);
    const patched = await call("PATCH", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token, body: { name: "改名", definition: DEF } });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ name: "改名", definition: DEF });
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_pricing", name: "dup", definition: DEF } })).status).toBe(409);
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token })).status).toBe(204);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(true); // 削除も未公開の変更
    expect((await call("GET", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token })).status).toBe(404);
  });

  it("閲覧は VIEWER 以上、作成・更新・削除は EDITOR 以上(Goal と同じ)", async () => {
    const { owner, sid } = await siteWithGoal();
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await createAudience(viewer.token, sid, {})).status).toBe(403);
    expect((await createAudience(editor.token, sid, {})).status).toBe(201);
    expect((await call("GET", `/sites/${sid}/audiences`, { token: viewer.token })).status).toBe(200);
    expect((await call("PATCH", `/sites/${sid}/audiences/aud_pricing`, { token: viewer.token, body: { name: "x" } })).status).toBe(403);
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: viewer.token })).status).toBe(403);
  });

  it("定義の検査: 古い書式・別のオーディエンスの参照・入れ子の上限・保存期間を超える期間・名前と説明の長さ", async () => {
    const { owner, sid } = await siteWithGoal();
    const err = async (body: Record<string, unknown>) => json(await createAudience(owner.token, sid, body));
    expect(await err({ definition: { and: [{ hist: "visited", pattern: "p_x" }] } })).toMatchObject({ error: "legacy_targeting", path: ["definition", "and", 0] });
    expect(await err({ definition: { and: [{ audience: "aud_other" }, { ctx: "device", op: "in", value: ["mobile"] }] } })).toMatchObject({ error: "invalid_audience_definition", path: ["definition", "and", 0] });
    const deep = (n: number): unknown => (n === 0 ? { ctx: "device", op: "in", value: ["mobile"] } : { and: [{ ctx: "os", op: "in", value: ["ios"] }, deep(n - 1)] });
    expect((await createAudience(owner.token, sid, { id: "aud_deep5", definition: deep(5) })).status).toBe(201); // 一番外側 + 入れ子 4 段
    expect((await err({ id: "aud_deep6", definition: deep(6) })).error).toBe("invalid_audience_definition");
    expect(await err({ id: "aud_long", definition: { hist: "converted", goal: "g_lead", withinDays: 91 } })).toMatchObject({ error: "within_days_exceeds_retention", max: 90, path: ["definition"] });
    expect((await err({ id: "aud_name", name: "あ".repeat(101) })).error).toBe("validation_failed");
    expect((await err({ id: "aud_desc", description: "あ".repeat(501) })).error).toBe("validation_failed");
    // オーディエンスでは否定の形を持たない条件も除外できる(エクスペリエンスの形の制限は掛からない)
    expect((await createAudience(owner.token, sid, { id: "aud_not_time", definition: { not: { ctx: "time", days: ["sat", "sun"] } } })).status).toBe(201);
  });

  it("audience_unknown_goal_is_rejected / audience_cross_site_goal_is_rejected", async () => {
    const { owner, sid } = await siteWithGoal();
    const { id: other } = await createSite(owner.token, owner.workspaceId, { id: "site_other", domain: "other.example" });
    await call("POST", `/sites/${other}/goals`, { token: owner.token, body: { id: "g_other", name: "o", type: "CUSTOM", config: {} } });
    expect(await json(await createAudience(owner.token, sid, { definition: { hist: "converted", goal: "g_none" } }))).toMatchObject({ error: "unknown_goal" });
    expect(await json(await createAudience(owner.token, sid, { definition: { hist: "converted", goal: "g_other" } }))).toMatchObject({ error: "unknown_goal" });
  });

  it("エクスペリエンスから参照し、usedBy に出る。Publish で定義に展開され、パターン ID が値から決まる", async () => {
    const { owner, sid } = await siteWithGoal();
    await createAudience(owner.token, sid, {});
    const { id: eid } = await createExperiment(owner.token, sid, { name: "料金表", targeting: { and: [{ audience: "aud_pricing" }, { ctx: "device", op: "in", value: ["mobile"] }] } });
    expect((await json(await call("GET", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token }))).usedBy).toEqual([{ id: eid, name: "料金表", status: "draft" }]);
    expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const site = await json<{ activeVersion: number }>(await call("GET", `/sites/${sid}`, { token: owner.token }));
    const { config } = await json<{ config: { patterns: Record<string, unknown>; experiments: Array<{ targeting: unknown }> } }>(await call("GET", `/sites/${sid}/publishes/${site.activeVersion}`, { token: owner.token }));
    const id = patternIdOf(PRICING as never);
    expect(config.patterns).toEqual({ [id]: PRICING });
    expect(config.experiments[0]!.targeting).toEqual({ and: [{ and: [{ hist: "visited", pattern: id, min: 2, withinDays: 30 }, { not: { hist: "converted", goal: "g_lead" } }] }, { ctx: "device", op: "in", value: ["mobile"] }] });
  });

  it("audience_in_use_cannot_be_deleted(参照しているエクスペリエンスを 409 の hint に出す)", async () => {
    const { owner, sid } = await siteWithGoal();
    await createAudience(owner.token, sid, {});
    await createExperiment(owner.token, sid, { id: "exp_ref", name: "料金表", targeting: { not: { audience: "aud_pricing" } } });
    const res = await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token });
    expect(res.status).toBe(409);
    const body = (await expectEnvelope(res)) as { error: string; hint: string; experiments: string[] };
    expect(body.error).toBe("audience_in_use");
    expect(body.hint).toContain("料金表");
    expect(body.experiments).toEqual(["exp_ref"]);
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_ref`, { token: owner.token, body: { targeting: null } })).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token })).status).toBe(204);
  });

  it("goal_used_by_audience_cannot_be_deleted(どのエクスペリエンスからも使われていないオーディエンスでも数える)", async () => {
    const { owner, sid } = await siteWithGoal();
    await createAudience(owner.token, sid, {});
    const res = await call("DELETE", `/sites/${sid}/goals/g_lead`, { token: owner.token });
    expect(res.status).toBe(409);
    const body = (await expectEnvelope(res)) as { error: string; hint: string };
    expect(body.error).toBe("goal_in_use");
    expect(body.hint).toContain("料金ページ閲覧・資料請求前");
  });

  it("publish_fails_on_missing_audience(参照先が消えていれば Publish を止める。条件を落として配信を広げない)", async () => {
    const { owner, sid } = await siteWithGoal();
    await createAudience(owner.token, sid, {});
    const { id: eid } = await createExperiment(owner.token, sid, { targeting: { audience: "aud_pricing" } });
    await getDb(env).updateTable("experiments").set({ status: "running" }).where("site_id", "=", sid).where("id", "=", eid).execute();
    await getDb(env).deleteFrom("audiences").where("site_id", "=", sid).where("id", "=", "aud_pricing").execute(); // API では 409 で消せないので D1 を直接
    const r = await json(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "unknown_audience", message: "参照しているオーディエンスが見つかりません" });
    expect(r.hint).toContain("aud_pricing");
  });

  it("retention_shrink_rejects_unpublished_condition_change(保存しただけ / 公開まで完了、の 2 通り)", async () => {
    const { owner, sid } = await siteWithGoal();
    const shrink = () => call("PATCH", `/sites/${sid}`, { token: owner.token, body: { retentionDays: 30 } });
    // (1) 保存しただけ: 期間 60 日のオーディエンスがあれば短くできない
    await createAudience(owner.token, sid, { definition: { hist: "converted", goal: "g_lead", withinDays: 60 } });
    const saved = await shrink();
    expect(saved.status).toBe(422);
    expect(await json(saved)).toMatchObject({ error: "within_days_exceeds_retention", path: ["retentionDays"], conflicts: [{ kind: "audience", id: "aud_pricing", withinDays: 60 }] });
    // (2) 公開まで完了: 実行中のエクスペリエンスで公開した後、定義を 20 日に直しても、公開中の設定が 60 日のままなら止める
    const { id: eid } = await createExperiment(owner.token, sid, { name: "料金表", targeting: { audience: "aud_pricing" } });
    expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    await call("PATCH", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token, body: { definition: { hist: "converted", goal: "g_lead", withinDays: 20 } } });
    const published = await shrink();
    expect(published.status).toBe(422);
    const body = await json<{ conflicts: unknown[]; hint: string }>(published); // 本文は 1 回だけ読む(2 回目は Body has already been read)
    expect(body).toMatchObject({ conflicts: [{ kind: "published", id: eid, withinDays: 60 }] });
    expect(body.hint).toContain("公開中のエクスペリエンス「料金表」(60 日)");
    // Publish すれば短くできる
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    expect((await shrink()).status).toBe(200);
  });

  it("archived のエクスペリエンスの期間は保存期間の短縮を止めない(復帰できず、二度と配らないため)", async () => {
    const { owner, sid } = await siteWithGoal();
    const { id: eid } = await createExperiment(owner.token, sid, { targeting: { hist: "converted", goal: "g_lead", withinDays: 60 } });
    await getDb(env).updateTable("experiments").set({ status: "archived" }).where("site_id", "=", sid).where("id", "=", eid).execute();
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { retentionDays: 30 } })).status).toBe(200);
  });

  it("archived のエクスペリエンスが参照するオーディエンスも削除できない(409 audience_in_use)。PATCH で参照を外せば削除できる", async () => {
    const { owner, sid } = await siteWithGoal();
    await createAudience(owner.token, sid, {});
    const { id: eid } = await createExperiment(owner.token, sid, { targeting: { audience: "aud_pricing" } });
    await getDb(env).updateTable("experiments").set({ status: "archived" }).where("site_id", "=", sid).where("id", "=", eid).execute();
    const res = await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token });
    expect(res.status).toBe(409);
    expect(((await expectEnvelope(res)) as { error: string }).error).toBe("audience_in_use");
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { targeting: null } })).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_pricing`, { token: owner.token })).status).toBe(204);
  });

  it("ID の new は新規作成の画面(/audiences/new)と重なるので 422(plan ② P19)", async () => {
    const { owner, sid } = await siteWithGoal();
    const res = await createAudience(owner.token, sid, { id: "new" });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ error: "validation_failed", path: ["id"] });
  });
});
