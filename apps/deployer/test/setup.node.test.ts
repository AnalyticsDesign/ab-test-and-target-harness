import { describe, expect, it } from "vitest";
import { setupStatic } from "../scripts/setup-static";
import type { CfApiConfig } from "../src/cf-api";

/** URL・メソッドごとの応答の表で動く偽の API */
function fakeApi(state: { scriptExists: boolean; routes: Array<{ id: string; pattern: string; script?: string }> }) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    const path = new URL(r.url).pathname.replace("/client/v4", "");
    calls.push(`${r.method} ${path}`);
    const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, result }), { status, headers: { "content-type": "application/json" } });
    if (r.method === "GET" && path === "/accounts/acc/workers/scripts/wtt-static/settings")
      return state.scriptExists ? ok({}) : new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: "not found" }] }), { status: 404 });
    if (r.method === "POST" && path.endsWith("/assets-upload-session")) return ok({ jwt: "j", buckets: [] });
    if (r.method === "PUT" && path === "/accounts/acc/workers/scripts/wtt-static") {
      state.scriptExists = true;
      return ok({});
    }
    if (r.method === "GET" && path === "/zones") return ok([{ id: "zone1", name: new URL(r.url).searchParams.get("name") }]);
    if (r.method === "GET" && path === "/zones/zone1/workers/routes") return ok(state.routes);
    if (r.method === "POST" && path === "/zones/zone1/workers/routes") return ok({ id: "new" });
    if (r.method === "PUT" && path.startsWith("/zones/zone1/workers/routes/")) return ok({});
    if (r.method === "POST" && path === "/accounts/acc/workers/scripts/wtt-static/subdomain") return ok({});
    return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: `unexpected ${r.method} ${path}` }] }), { status: 400 });
  }) as typeof fetch;
  return { fn, calls };
}
const cfg = (fetchFn: typeof fetch): CfApiConfig => ({ accountId: "acc", token: "t", scriptName: "wtt-static", apiBase: "https://api.test/client/v4", fetchFn });

describe("setupStatic", () => {
  it("スクリプトが無ければプレビューだけの asset で作り、ルートを作る", async () => {
    const f = fakeApi({ scriptExists: false, routes: [] });
    const log = await setupStatic(cfg(f.fn), { routes: [{ pattern: "www.example.com/s/*", zone: "example.com" }] });
    expect(f.calls).toContain("PUT /accounts/acc/workers/scripts/wtt-static");
    expect(f.calls).toContain("POST /zones/zone1/workers/routes");
    expect(log).toEqual(["script: created", "route www.example.com/s/*: created"]);
  });

  it("スクリプトが既にあれば上書きしない(asset を消さない)", async () => {
    const f = fakeApi({ scriptExists: true, routes: [{ id: "r1", pattern: "www.example.com/s/*", script: "wtt-static" }] });
    const log = await setupStatic(cfg(f.fn), { routes: [{ pattern: "www.example.com/s/*", zone: "example.com" }] });
    expect(f.calls).not.toContain("PUT /accounts/acc/workers/scripts/wtt-static");
    expect(log).toEqual(["script: exists (kept)", "route www.example.com/s/*: unchanged"]);
  });

  it("同じパターンのルートが他の Worker(edge)にあれば付け替える(移行)", async () => {
    const f = fakeApi({ scriptExists: true, routes: [{ id: "r1", pattern: "www.example.com/s/*", script: "wtt-edge" }] });
    const log = await setupStatic(cfg(f.fn), { routes: [{ pattern: "www.example.com/s/*", zone: "example.com" }] });
    expect(f.calls).toContain("PUT /zones/zone1/workers/routes/r1");
    expect(log).toContain("route www.example.com/s/*: moved from wtt-edge");
  });

  it("--workers-dev on は workers.dev を有効にする(ドメインなし構成と移行の確認)", async () => {
    const f = fakeApi({ scriptExists: true, routes: [] });
    const log = await setupStatic(cfg(f.fn), { routes: [], workersDev: true });
    expect(f.calls).toContain("POST /accounts/acc/workers/scripts/wtt-static/subdomain");
    expect(log).toContain("workers.dev: on");
  });

  it("toScript はルートだけを付け替え、スクリプトの確認・作成をしない(切り戻し)", async () => {
    const f = fakeApi({ scriptExists: false, routes: [{ id: "r1", pattern: "www.example.com/s/*", script: "wtt-static" }] });
    const log = await setupStatic(cfg(f.fn), { routes: [{ pattern: "www.example.com/s/*", zone: "example.com" }], toScript: "wtt-edge" });
    expect(f.calls).toContain("PUT /zones/zone1/workers/routes/r1");
    expect(f.calls.some((c) => c.includes("/workers/scripts/"))).toBe(false);
    expect(log).toEqual(["route www.example.com/s/*: moved from wtt-static (to wtt-edge)"]);
  });

  it("配信専用の Worker の名前の規則に合わなければ何も呼ばずに断る(wtt-edge を上書きしない)", async () => {
    const f = fakeApi({ scriptExists: false, routes: [] });
    await expect(setupStatic({ ...cfg(f.fn), scriptName: "wtt-edge" }, { routes: [] })).rejects.toThrow(/not_configured/);
    expect(f.calls).toEqual([]);
  });
});
