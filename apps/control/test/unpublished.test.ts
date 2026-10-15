import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "../src/db";
import {
  call,
  json,
  setupOwner,
  inviteAndJoin,
  createSite,
  createExperiment,
  TEXT_CHANGE,
  publishRes,
  siteWithRunning,
  active,
  siteRow,
  failingD1Query,
} from "./helpers";

describe("unpublished changes (spec §13.9)", () => {
  it("child_edit_marks_experiment_unpublished", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_hero" });
    await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } });
    const before = await json(await call("GET", `/sites/${sid}/experiments`, { token: owner.token }));
    expect(before[0].unpublished).toBe(false);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(false);
    // Change の書込みだけで親 Experiment が未公開扱いになる(EDITOR の編集)
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect(
      (
        await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
          token: ed.token,
          body: [{ ...TEXT_CHANGE(), type: "HTML", payload: { html: "<b>x</b>", position: "append", runScripts: false } }],
        })
      ).status,
    ).toBe(200);
    const after = await json(await call("GET", `/sites/${sid}/experiments`, { token: owner.token }));
    expect(after[0].unpublished).toBe(true);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(true);
    const preview = await json(await call("GET", `/sites/${sid}/publish-preview`, { token: owner.token }));
    expect(preview.experiments).toHaveLength(1);
    expect(preview.experiments[0]).toMatchObject({ id: "exp_hero", hasCodeChange: true, updatedBy: { name: "editor" } });
    expect(preview.experiments[0].changedChanges).toEqual([expect.objectContaining({ variantId: "b", id: "c_text", type: "HTML" })]);
    // Publish で解消
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    expect((await json(await call("GET", `/sites/${sid}/experiments`, { token: owner.token })))[0].unpublished).toBe(false);
    expect((await json(await call("GET", `/sites/${sid}/publish-preview`, { token: owner.token }))).experiments).toEqual([]);
  });
  it("goal / site settings changes are surfaced at site level", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    expect((await json(await call("GET", `/sites/${sid}/publish-preview`, { token: owner.token }))).siteLevelChanged).toBe(false);
    await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g", name: "g", type: "CUSTOM", config: {} } });
    let site = await json(await call("GET", `/sites/${sid}`, { token: owner.token }));
    expect(site.hasUnpublishedChanges).toBe(true);
    expect((await json(await call("GET", `/sites/${sid}/publish-preview`, { token: owner.token }))).siteLevelChanged).toBe(true);
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    site = await json(await call("GET", `/sites/${sid}`, { token: owner.token }));
    expect(site.hasUnpublishedChanges).toBe(false);
  });
  it("changing site settings does not raise the unpublished banner", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { retentionDays: 30 } })).status).toBe(200);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(false);
  });
  it("ambiguous active put marks the site stale and the next read reconciles it", async () => {
    // Task 6 の publish の仕様(reconcile の入口が GET /sites/:sid = Task 8 なのでここに置く)
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    // put は通るが throw する KV(成否不明)
    const kv = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "put") return typeof v === "function" ? v.bind(t) : v;
        return async (k: string, ...rest: unknown[]) => {
          await t.put(k, ...(rest as [string]));
          if (/:active$/.test(k)) throw new Error("timeout after commit");
        };
      },
    }) as KVNamespace;
    const res = await json(await publishRes(owner.token, sid, { CONFIG_KV: kv }));
    expect(res).toMatchObject({ ok: false, error: "kv_rate_limited" });
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
    expect((await siteRow(sid)).active_version).toBe(1);
    // GET /sites/:sid の reconcile で KV が D1(1)に揃う
    const getRes = await call("GET", `/sites/${sid}`, { token: owner.token });
    // review r1 finding 2: 直った瞬間のレスポンス自体が正しい値を返す(loadSite 時点の古い activeKvStale のままではない)
    expect((await json(getRes)).activeKvStale).toBe(false);
    expect(await active(sid)).toBe("1");
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });
  it("a reconcile failure inside GET /sites/:sid cannot fail the read (review r1 finding 1 red-check)", async () => {
    // reconcileActive の「状態を読む最初の select」を狙い撃ちで 1 回だけ落とす。
    // 直す前はこの select が reconcileActive 自身の try の外にあり、GET が丸ごと 500 になり得た
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const kv = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "put") return typeof v === "function" ? v.bind(t) : v;
        return async (k: string, ...rest: unknown[]) => {
          await t.put(k, ...(rest as [string]));
          if (/:active$/.test(k)) throw new Error("timeout after commit");
        };
      },
    }) as KVNamespace;
    expect(await json(await publishRes(owner.token, sid, { CONFIG_KV: kv }))).toMatchObject({ ok: false, error: "kv_rate_limited" });
    expect((await siteRow(sid)).active_kv_stale).toBe(1); // reconcile が働く条件(stale)を満たした
    const boomOnce = failingD1Query(env.DB, /select\s+"active_kv_stale",\s*"active_version"\s+from\s+"sites"/i, 1);
    const getRes = await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { DB: boomOnce } });
    expect(getRes.status).toBe(200); // reconcile の内部失敗が GET を巻き込んでいない
    const body = await json(getRes);
    expect(body.hasUnpublishedChanges).toBeDefined(); // 応答自体は普通に組み立てられている
    expect(body.activeKvStale).toBe(true); // 今回の reconcile は失敗した(まだ stale)ので、応答もそう言う
    // reconcile 自体は失敗しているので D1 は stale のまま残り、次の GET(注入なし)で直る
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
    const getRes2 = await call("GET", `/sites/${sid}`, { token: owner.token });
    expect((await json(getRes2)).activeKvStale).toBe(false);
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });
  // 決定 34 のとおり badge/banner は「Task 5/4 が親を touch する経路」を正しく読めているかに懸かる。
  // Change 編集(上の child_edit_marks_experiment_unpublished)に続き、残りの編集種別も個別に before:false → after:true で確かめる
  it("variant weight edit marks the parent experiment unpublished", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_w" });
    await call("POST", `/sites/${sid}/publish`, { token: owner.token }); // baseline activation(draft のみでも last_activated_at は進む)
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(false);
    expect(
      (
        await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, {
          token: owner.token,
          body: [
            { id: "a", name: "A", weight: 70 },
            { id: "b", name: "B", weight: 30 },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(true);
  });
  it("goal rename marks the site level changed", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const created = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_rename", name: "before", type: "CUSTOM", config: {} } });
    expect(created.status).toBe(201);
    await call("POST", `/sites/${sid}/publish`, { token: owner.token });
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(false);
    expect((await call("PATCH", `/sites/${sid}/goals/g_rename`, { token: owner.token, body: { name: "after" } })).status).toBe(200);
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges).toBe(true);
  });
  it("publish-preview: オーディエンスの変更・数えるのをやめるページの条件・画面の幅の条件・Publish で止まる理由(決定 49)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const PRICING = { part: "path", op: "startsWith", value: "/pricing/" };
    await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_x", name: "x", type: "CUSTOM", config: {} } });
    await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_p", name: "料金", definition: { hist: "visited", page: PRICING } } });
    const { id: eid } = await createExperiment(owner.token, sid, { name: "料金表", targeting: { and: [{ audience: "aud_p" }, { ctx: "viewport", minWidth: 768 }] } });
    expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200); // 自動 Publish
    const preview = async () => json(await call("GET", `/sites/${sid}/publish-preview`, { token: owner.token }));
    expect(await preview()).toMatchObject({ audienceChanges: [], droppedPageConditions: [], viewportExperiments: [{ id: eid, name: "料金表" }], compileError: null });
    // 定義を変える → 参照する running のエクスペリエンスと一緒に出る。前のページの条件は次の Publish で数えるのをやめる
    await call("PATCH", `/sites/${sid}/audiences/aud_p`, { token: owner.token, body: { definition: { hist: "visited", page: { ...PRICING, value: "/plans/" } } } });
    const changed = await preview();
    expect(changed.audienceChanges).toEqual([{ id: "aud_p", name: "料金", updatedAt: expect.any(Number), experiments: [{ id: eid, name: "料金表" }] }]);
    expect(changed.droppedPageConditions).toEqual([PRICING]);
    // いまの下書きが Publish で止まるなら、その理由を先に出す(参照する Goal を D1 から直接消して再現する)
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { targeting: { and: [{ audience: "aud_p" }, { hist: "converted", goal: "g_x" }] } } })).status).toBe(200);
    await getDb(env).deleteFrom("goals").where("site_id", "=", sid).where("id", "=", "g_x").execute();
    const broken = await preview();
    expect(broken.compileError).toMatchObject({ error: "unknown_goal", message: "参照している目標が見つかりません", hint: expect.stringContaining("g_x") });
    expect(broken.droppedPageConditions).toEqual([]); // compile できないときは比べない
  });
});
