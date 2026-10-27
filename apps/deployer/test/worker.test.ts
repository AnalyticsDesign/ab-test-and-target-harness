import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { staticInputDigest, type CompiledConfig } from "@wtt/core";
import workerImpl, { Deployer } from "../src/index";
import { cfApiConfigOf } from "../src/queue-do";

const CONFIG: CompiledConfig = {
  schemaVersion: 2, version: 1, siteId: "site_a", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [], exposurePayloads: {},
};
const req = { protocol: 1 as const, siteId: "site_a", generation: { epoch: 10, seq: 1 }, config: CONFIG, settings: { settingsVersion: 1, siteId: "site_a" }, apiBase: null };

/** 偽の Cloudflare API(準備 → スクリプトの登録)。呼ばれた URL を控える */
function stubApi(status = 200) {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const r = new Request(input as RequestInfo, init);
    urls.push(`${r.method} ${r.url}`);
    const body = r.url.endsWith("/assets-upload-session") ? { success: true, result: { jwt: "j", buckets: [] } } : { success: true, result: {} };
    return new Response(JSON.stringify(status === 200 ? body : { success: false, errors: [{ code: 1, message: "x" }] }), { status, headers: { "content-type": "application/json" } });
  });
  return urls;
}
// 実装は引数を使わない形に推論されるので、ランタイムが渡す 3 引数で呼べる型に広げる
const worker: ExportedHandler<Cloudflare.Env> = workerImpl;
const queue = () => env.DEPLOY_QUEUE.get(env.DEPLOY_QUEUE.idFromName("global"));

afterEach(() => vi.restoreAllMocks());

describe("wtt-deployer", () => {
  it("既定の fetch はどの要求にも 404(インターネットから依頼を受けない。plan K3)", async () => {
    for (const [m, p] of [["GET", "/"], ["POST", "/sites/site_a"], ["PUT", "/"]] as const) {
      const ctx = createExecutionContext();
      const res = await worker.fetch!(new Request(`https://deployer.test${p}`, { method: m }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(404);
    }
  });

  it("RPC の redeploySite は DO で焼いて API を呼び、deployed を返す", async () => {
    const urls = stubApi();
    const r = await queue().redeploySite(req);
    const d = await staticInputDigest(req);
    expect(r).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, deployedAt: expect.any(String), acceptedDigest: d, deployedDigest: d });
    expect(urls).toEqual([
      "POST https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static/assets-upload-session",
      "PUT https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static",
    ]);
  });

  it("API の失敗は pending で、DO の alarm で再試行して片づく", async () => {
    stubApi(503);
    const stub = queue();
    expect((await stub.redeploySite({ ...req, generation: { epoch: 10, seq: 2 }, config: { ...CONFIG, version: 2 } })).state).toBe("pending");
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
    vi.restoreAllMocks();
    stubApi(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.siteStatus("site_a")).pending).toBe(false);
  });

  it("RPC の instanceStatus と redeploySites は DO を通って返り、配置は alarm で 1 回(7o K9 K10)", async () => {
    const urls = stubApi();
    const stub = queue();
    const siteId = "site_batch";
    const site = { siteId, generation: { epoch: 10, seq: 1 }, config: { ...CONFIG, siteId }, settings: { settingsVersion: 1, siteId }, apiBase: null };
    expect(await stub.redeploySites({ protocol: 1, sites: [site], flush: "soon" })).toEqual({ state: "accepted", sites: [{ siteId, accepted: { epoch: 10, seq: 1 } }] });
    expect(urls).toEqual([]); // 配置は待たない
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(urls).toEqual([
      "POST https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static/assets-upload-session",
      "PUT https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static",
    ]);
    const d = await staticInputDigest(site);
    const st = await stub.instanceStatus();
    // 前のテストの記録が残っているので、このテストのサイトだけを見る
    expect(st.sites.find((s) => s.siteId === siteId)).toEqual({ siteId, accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, removed: false, acceptedDigest: d, deployedDigest: d });
    expect(st).toMatchObject({ failures: 0, lastError: null, lastDeployedAt: expect.any(String) });
  });

  it("cfApiConfigOf はトークンかアカウントが無い設定を not_configured にする", () => {
    // 返った not_configured が pending と理由になることは queue.node.test.ts(Task 3)が確かめる
    expect(cfApiConfigOf(env)).toMatchObject({ accountId: "acc", token: "tok", scriptName: "wtt-static" });
    expect(() => cfApiConfigOf({ ...env, CF_DEPLOY_TOKEN: undefined })).toThrow("not_configured");
    expect(() => cfApiConfigOf({ ...env, CF_ACCOUNT_ID: "" })).toThrow("not_configured");
  });

  it("cfApiConfigOf は配信専用の Worker の名前の規則に合わない STATIC_SCRIPT_NAME を not_configured にする(別の Worker を上書きしない)", () => {
    expect(cfApiConfigOf({ ...env, STATIC_SCRIPT_NAME: "wtt-static-stg" }).scriptName).toBe("wtt-static-stg");
    for (const name of ["wtt-edge", "wtt-control", "wtt-static_x", "my-wtt-static"]) {
      expect(() => cfApiConfigOf({ ...env, STATIC_SCRIPT_NAME: name })).toThrow("not_configured");
    }
  });

  it("scheduled は DO の tick を呼ぶ(毎時の Cron)", async () => {
    stubApi();
    const stub = queue();
    // 前のテストの記録が残っているので、プレビューの記録(tick の ensurePreviews が書く)を消して、tick が書き直すのを見る
    await runInDurableObject(stub, (_i, state) => state.storage.delete("previews"));
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get("previews"))).toBeUndefined();
    const waits: Promise<unknown>[] = [];
    await worker.scheduled!({ cron: "17 * * * *", scheduledTime: Date.now(), type: "scheduled", noRetry() {} } as unknown as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    // tick だけが書く効果: 同梱した runtime のプレビューを今の版として記録する
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get<unknown[]>("previews"))).toHaveLength(1);
  });

  it("Deployer の入口(control が呼ぶクラス)は DO の結果をそのまま返す", async () => {
    stubApi();
    const ctx = createExecutionContext();
    const deployer = new Deployer(ctx, env);
    const r = await deployer.redeploySite({ ...req, siteId: "site_via_entry", config: { ...CONFIG, siteId: "site_via_entry" }, settings: { settingsVersion: 1, siteId: "site_via_entry" } });
    expect(r.state).toBe("deployed");
    const viaEntry = await deployer.siteStatus("site_via_entry");
    expect(viaEntry).toEqual(await queue().siteStatus("site_via_entry"));
    expect(viaEntry.deployed).toEqual({ epoch: 10, seq: 1 });
    // まとめた受け付けの rejected も同じ形で返す(入口で RPC の型を作り直している)
    expect(await deployer.redeploySites({ protocol: 1, sites: [], flush: "soon" } as never)).toEqual({ state: "rejected", sites: [], error: "invalid_request" });
    expect((await deployer.instanceStatus()).sites.find((s) => s.siteId === "site_via_entry")?.deployed).toEqual({ epoch: 10, seq: 1 });
    await waitOnExecutionContext(ctx);
  });
});
