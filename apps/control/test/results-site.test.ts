import { describe, expect, it } from "vitest";
import { call, createExperiment, createSite, expectEnvelope, json, publishRes, RESULTS_STORE, runDirect, setupOwner, siteRow } from "./helpers";

// D9 ②(設計書 §6.6、plan ② の Task 10): Site ごとの「結果を記録する」と「個票の保持期間」。
// 計測用 D1(RESULTS_DB)の有無は envOverride の RESULTS_STORE で切り替える(既定の testEnv は「無い」)
describe("Site の結果の記録の設定(D9 ②)", () => {
  it("site_create_defaults_results_off_without_store", async () => {
    const { token, workspaceId } = await setupOwner();
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domains: ["www.example.com"] } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ resultsEnabled: false, resultsRetentionDays: 90 });
  });

  it("site create defaults results on with store", async () => {
    const { token, workspaceId } = await setupOwner();
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domains: ["www.example.com"] }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(201);
    const site = await json<{ id: string }>(res);
    expect(site).toMatchObject({ resultsEnabled: true, resultsRetentionDays: 90 });
    expect((await siteRow(site.id)).results_enabled).toBe(1);
  });

  it("enabling without store is 409 results_store_missing", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const res = await call("PATCH", `/sites/${sid}`, { token, body: { resultsEnabled: true } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({
      error: "results_store_missing",
      message: "結果を記録するためのデータベースが導入されていません",
      hint: "導入ガイドの手順で計測用のデータベースを作り、control を設定し直してから有効にしてください",
    });
    expect((await siteRow(sid)).results_enabled).toBe(0);
    // 無効にする向き・保持期間だけの変更は、計測用 D1 が無くても受ける
    expect((await call("PATCH", `/sites/${sid}`, { token, body: { resultsEnabled: false, resultsRetentionDays: 30 } })).status).toBe(200);
    // 計測用 D1 があれば有効にできる
    const on = await call("PATCH", `/sites/${sid}`, { token, body: { resultsEnabled: true }, envOverride: RESULTS_STORE });
    expect(on.status).toBe(200);
    expect(await json(on)).toMatchObject({ resultsEnabled: true, resultsRetentionDays: 30 });
  });

  it("retention days accept 7..365", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    for (const bad of [6, 366, 30.5]) expect((await call("PATCH", `/sites/${sid}`, { token, body: { resultsRetentionDays: bad } })).status).toBe(422);
    for (const ok of [7, 365]) {
      const res = await call("PATCH", `/sites/${sid}`, { token, body: { resultsRetentionDays: ok } });
      expect(res.status).toBe(200);
      expect((await json(res)).resultsRetentionDays).toBe(ok);
      expect((await siteRow(sid)).results_retention_days).toBe(ok);
    }
  });

  it("toggling results counts as an unpublished change", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId, {}); // 計測用 D1 なしで作る(results_enabled = 0)
    const { id: eid } = await createExperiment(owner.token, sid);
    await runDirect(sid, eid);
    const publish = async () => expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    const unpublished = async () => (await json<{ hasUnpublishedChanges: boolean }>(await call("GET", `/sites/${sid}`, { token: owner.token }))).hasUnpublishedChanges;
    await publish();
    expect(await unpublished()).toBe(false);

    // 有効にする: 未公開の変更に数え、D1 に保存し、再公開で消える
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: true }, envOverride: RESULTS_STORE })).status).toBe(200);
    expect((await siteRow(sid)).results_enabled).toBe(1);
    expect(await unpublished()).toBe(true);
    await publish();
    expect(await unpublished()).toBe(false);

    // 保持期間だけの変更は compiled config に載らないので数えない(D1 には保存する)
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsRetentionDays: 120 } })).status).toBe(200);
    expect((await siteRow(sid)).results_retention_days).toBe(120);
    expect(await unpublished()).toBe(false);

    // 同じ値の PATCH は切り替えではない
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: true }, envOverride: RESULTS_STORE })).status).toBe(200);
    expect(await unpublished()).toBe(false);

    // 無効にする向きも数える
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: false } })).status).toBe(200);
    expect((await siteRow(sid)).results_enabled).toBe(0);
    expect(await unpublished()).toBe(true);
    await publish();
    expect(await unpublished()).toBe(false);
  });

  it("capabilities reports resultsStore", async () => {
    const { token } = await setupOwner();
    expect((await json(await call("GET", "/capabilities", { token }))).resultsStore).toBe(false);
    expect((await json(await call("GET", "/capabilities", { token, envOverride: RESULTS_STORE }))).resultsStore).toBe(true);
  });
});
