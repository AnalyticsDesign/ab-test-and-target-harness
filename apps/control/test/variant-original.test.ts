import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { beforeD1Batch, call, createExperiment, createSite, expectEnvelope, experimentRow, inviteAndJoin, json, setupOwner, TEXT_CHANGE } from "./helpers";

// B77(設計書 Q5〜Q7・Q26〜Q29、plan の K8・K9): パターンの「オリジナル」とメモ
const detail = (token: string, sid: string, eid: string) => call("GET", `/sites/${sid}/experiments/${eid}`, { token }).then((r) => json(r));
const changeCount = async (sid: string, eid: string, vid: string): Promise<number> =>
  (await env.DB.prepare("select count(*) as n from changes where site_id = ? and experiment_id = ? and variant_id = ?").bind(sid, eid, vid).first<{ n: number }>())!.n;
const tick = () => new Promise((r) => setTimeout(r, 2)); // updated_at は epoch ミリ秒なので 1 ms 以上進める

async function siteAndTest(eid = "exp_t") {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  await createExperiment(owner.token, sid, { id: eid });
  return { ...owner, sid, eid };
}

describe("パターンのオリジナル(B77 K8)", () => {
  it("create_test_defaults_a_original", async () => {
    const { token, sid, eid } = await siteAndTest();
    const t = await detail(token, sid, eid);
    expect(t.variants.map((v: any) => [v.id, v.name, v.original, v.weight, v.description])).toEqual([["a", "A", true, 50, ""], ["b", "B", false, 50, ""]]);
    const created = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_s", name: "S", kind: "single", urlMatch: { op: "contains", value: "/" } } });
    expect(created.status).toBe(201);
    const s = await detail(token, sid, "exp_s");
    expect(s.variants.map((v: any) => [v.id, v.name, v.original, v.weight])).toEqual([["a", "A", false, 100]]);
  });

  it("original_variant_changes_deleted_in_same_put", async () => {
    const { token, sid, eid } = await siteAndTest();
    expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [TEXT_CHANGE("c1"), TEXT_CHANGE("c2")] })).status).toBe(200);
    expect(await changeCount(sid, eid, "b")).toBe(2);
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50, original: false }, { id: "b", name: "B", weight: 50, original: true }] });
    expect(res.status).toBe(200);
    expect(await changeCount(sid, eid, "b")).toBe(0);
    const d = await detail(token, sid, eid);
    expect(d.variants.map((v: any) => [v.id, v.original])).toEqual([["a", false], ["b", true]]);
  });

  it("original_delete_is_scoped_to_experiment", async () => {
    const { token, workspaceId, sid, eid } = await siteAndTest();
    // 同じサイトの別のエクスペリエンスと、別のサイトに、同じ ID b のパターンの変更を置く
    await createExperiment(token, sid, { id: "exp_other" });
    const { id: sid2 } = await createSite(token, workspaceId);
    await createExperiment(token, sid2, { id: eid });
    for (const [s, e] of [[sid, eid], [sid, "exp_other"], [sid2, eid]] as const)
      expect((await call("PUT", `/sites/${s}/experiments/${e}/variants/b/changes`, { token, body: [TEXT_CHANGE("c1"), TEXT_CHANGE("c2")] })).status).toBe(200);
    expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50, original: false }, { id: "b", name: "B", weight: 50, original: true }] })).status).toBe(200);
    expect(await changeCount(sid, eid, "b")).toBe(0);
    expect(await changeCount(sid, "exp_other", "b")).toBe(2);
    expect(await changeCount(sid2, eid, "b")).toBe(2);
  });

  it("variants_put_without_original_keeps_flag_and_memo", async () => {
    // deploy の途中で古い管理画面が original も description も無い body を送っても、オリジナルの印とメモは消えない(Review Focus 2)
    const { token, sid, eid } = await siteAndTest();
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/a`, { token, body: { description: "元のページ" } })).status).toBe(200);
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A2", weight: 40 }, { id: "b", name: "B", weight: 30 }, { id: "c", name: "C", weight: 30 }] });
    expect(res.status).toBe(200);
    const d = await detail(token, sid, eid);
    expect(d.variants.map((v: any) => [v.id, v.name, v.original, v.description])).toEqual([["a", "A2", true, "元のページ"], ["b", "B", false, ""], ["c", "C", false, ""]]);
    // 指定したものは保存する(values と doUpdateSet の両方)
    expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A2", weight: 40, description: "新しいメモ" }, { id: "b", name: "B", weight: 30 }, { id: "d", name: "D", weight: 30, description: "追加", original: false }] })).status).toBe(200);
    const d2 = await detail(token, sid, eid);
    expect(d2.variants.map((v: any) => [v.id, v.original, v.description])).toEqual([["a", true, "新しいメモ"], ["b", false, ""], ["d", false, "追加"]]);
  });

  it("variants_put_does_not_overwrite_concurrent_memo", async () => {
    // PUT …/variants が読んだ後・書く前に、別の PATCH …/variants/:vid がメモを書く。省いた description は doUpdateSet に入らないので残る
    const { token, sid, eid } = await siteAndTest();
    const racing = beforeD1Batch(env.DB, async () => {
      const r = await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token, body: { description: "同時に書いたメモ" } });
      expect(r.status).toBe(200);
    });
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, envOverride: { DB: racing }, body: [{ id: "a", name: "A", weight: 30 }, { id: "b", name: "B2", weight: 70 }] });
    expect(res.status).toBe(200);
    const d = await detail(token, sid, eid);
    expect(d.variants.map((v: any) => [v.id, v.name, v.weight, v.description])).toEqual([["a", "A", 30, ""], ["b", "B2", 70, "同時に書いたメモ"]]);
  });

  it("single_rejects_original", async () => {
    const { token, sid } = await siteAndTest();
    await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_s", name: "S", kind: "single", urlMatch: { op: "contains", value: "/" } } });
    const res = await call("PUT", `/sites/${sid}/experiments/exp_s/variants`, { token, body: [{ id: "a", name: "A", weight: 100, original: true }] });
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({ error: "original_not_allowed", path: ["variants", "a", "original"] });
    // original: false はパーソナライズでも受ける
    expect((await call("PUT", `/sites/${sid}/experiments/exp_s/variants`, { token, body: [{ id: "a", name: "A", weight: 100, original: false }] })).status).toBe(200);
  });

  it("changes_put_on_original", async () => {
    const { token, sid, eid } = await siteAndTest();
    const before = await experimentRow(sid, eid);
    await tick();
    const empty = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/a/changes`, { token, body: [] });
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({ ok: true, count: 0 });
    expect((await experimentRow(sid, eid)).updated_at).toBe(before.updated_at); // 何も書かない
    const one = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/a/changes`, { token, body: [TEXT_CHANGE()] });
    expect(one.status).toBe(422);
    expect((await expectEnvelope(one)).error).toBe("variant_original");
    expect(await changeCount(sid, eid, "a")).toBe(0);
  });

  it("changes_put_racing_original_leaves_no_changes", async () => {
    // PUT …/changes の事前の読み(original = 0)の後・batch の前に、同じパターンをオリジナルにする PUT …/variants が割り込む。
    // batch の最後の条件付き DELETE が効き、変更は残らず 422。拒否した保存は親の帳簿(updated_at・updated_by・未公開の印)を変えない
    const { token, workspaceId, sid, eid } = await siteAndTest();
    const ed = await inviteAndJoin(token, workspaceId, "editor");
    let afterOriginal: { updatedAt: number; updatedBy: string; unpublished: boolean } | undefined;
    const racing = beforeD1Batch(env.DB, async () => {
      const r = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50, original: false }, { id: "b", name: "B", weight: 50, original: true }] });
      expect(r.status).toBe(200);
      const d = await detail(token, sid, eid);
      afterOriginal = { updatedAt: d.updatedAt, updatedBy: d.updatedBy, unpublished: d.unpublished };
      await tick();
    });
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: ed.token, envOverride: { DB: racing }, body: [TEXT_CHANGE("c1"), TEXT_CHANGE("c2")] });
    expect(afterOriginal).toBeDefined(); // 割り込みは事前の読みの後の batch で起きた
    expect(res.status).toBe(422);
    expect((await expectEnvelope(res)).error).toBe("variant_original");
    expect(await changeCount(sid, eid, "b")).toBe(0);
    const d = await detail(token, sid, eid);
    expect({ updatedAt: d.updatedAt, updatedBy: d.updatedBy, unpublished: d.unpublished }).toEqual(afterOriginal);
    expect(d.updatedBy).not.toBe(ed.userId);
  });
});

describe("メモ(B77 K9)", () => {
  it("description_only_patch_keeps_unpublished_state", async () => {
    const { token, sid, eid } = await siteAndTest();
    expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [TEXT_CHANGE()] })).status).toBe(200);
    const started = await json(await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "running" } }));
    expect(started.publish.ok).toBe(true);
    // 配信中: パターンのメモ
    const running = await detail(token, sid, eid);
    await tick();
    const vRunning = await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token, body: { description: "配信中のメモ" } });
    expect(vRunning.status).toBe(200);
    expect(await json(vRunning)).toMatchObject({ id: "b", name: "B", weight: 50, original: false, description: "配信中のメモ", analytics: null });
    const afterRunningMemo = await detail(token, sid, eid);
    expect([afterRunningMemo.updatedAt, afterRunningMemo.unpublished]).toEqual([running.updatedAt, running.unpublished]);
    // 終了後: エクスペリエンスのメモとパターンのメモ
    const archived = await json(await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "archived" } }));
    expect(archived.publish.ok).toBe(true);
    const before = await detail(token, sid, eid);
    await tick();
    const res = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { description: "経緯" } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ description: "経緯", status: "archived", updatedAt: before.updatedAt, unpublished: before.unpublished });
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token, body: { description: "終了後のメモ" } })).status).toBe(200);
    const after = await detail(token, sid, eid);
    expect([after.description, after.variants[1].description]).toEqual(["経緯", "終了後のメモ"]);
    expect([after.updatedAt, after.updatedBy, after.unpublished]).toEqual([before.updatedAt, before.updatedBy, before.unpublished]);
    // ほかのキーと一緒なら今までどおり updated_at を進める
    await tick();
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { description: "経緯 2", name: "Hero 2" } })).status).toBe(200);
    expect((await detail(token, sid, eid)).updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it("description_too_long", async () => {
    const { token, sid, eid } = await siteAndTest();
    const long = "あ".repeat(1001);
    const cases = [
      { res: await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { description: long } }), path: ["description"] },
      { res: await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/a`, { token, body: { description: long } }), path: ["description"] },
      { res: await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50, description: long }] }), path: ["variants", "b", "description"] },
      { res: await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_long", name: "L", urlMatch: { op: "contains", value: "/" }, description: long } }), path: ["description"] },
    ];
    for (const { res, path } of cases) {
      expect(res.status).toBe(422);
      expect(await expectEnvelope(res)).toMatchObject({ error: "description_too_long", path, max: 1000 });
    }
    // 1,000 字までは受ける。作成のメモは保存される
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/a`, { token, body: { description: "あ".repeat(1000) } })).status).toBe(200);
    const created = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_memo", name: "M", urlMatch: { op: "contains", value: "/" }, description: "作成時のメモ" } });
    expect(created.status).toBe(201);
    expect((await json(created)).description).toBe("作成時のメモ");
  });

  it("variant_description_patch_is_strict", async () => {
    const { token, sid, eid } = await siteAndTest();
    const res = await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token, body: { description: "x", weight: 100 } });
    expect(res.status).toBe(422);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("validation_failed");
    expect(body.path).toBeDefined();
    const missing = await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token, body: {} });
    expect(missing.status).toBe(422);
    expect(await expectEnvelope(missing)).toMatchObject({ error: "validation_failed", path: ["description"] });
  });

  it("variant memo needs an editor and a known variant", async () => {
    const { token, workspaceId, sid, eid } = await siteAndTest();
    const viewer = await inviteAndJoin(token, workspaceId, "viewer");
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/b`, { token: viewer.token, body: { description: "x" } })).status).toBe(403);
    const unknown = await call("PATCH", `/sites/${sid}/experiments/${eid}/variants/zz`, { token, body: { description: "x" } });
    expect(unknown.status).toBe(404);
    expect((await expectEnvelope(unknown)).error).toBe("not_found");
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_none/variants/b`, { token, body: { description: "x" } })).status).toBe(404);
  });
});
