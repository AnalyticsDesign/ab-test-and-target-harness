import { afterEach, describe, expect, it, vi } from "vitest";
import { resetUsageCache } from "../src/usage";
import { call, createSite, json, setupOwner } from "./helpers";

/** エージェントと同じ経路: API キーだけで一連の手順を通す(§13.10「レシピは control の統合テストでなぞる」) */
async function agentKey(): Promise<{ key: string; wid: string; token: string }> {
  const owner = await setupOwner();
  const { key } = (await json(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "agent", workspaceId: owner.workspaceId } }))) as { key: string };
  return { key, wid: owner.workspaceId, token: owner.token };
}

// レシピ 6(backlog D10): 使用状況の監視。GraphQL の応答だけを差し替える(test/usage-routes.test.ts と同じ形)
const USAGE_ENV = { CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" } as const;
const emptyUsageAccount = { workers: [], doRequests: [], doNamespaces: [], doRows: [], doStorage: [], d1: [], d1Storage: [], kv: [], kvStorage: [] };
function mockGraphql() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      return Response.json({ data: { viewer: { accounts: [{ ...emptyUsageAccount, workers: [{ dimensions: { scriptName: "wtt-control" }, sum: { requests: 80_000 } }] }] } }, errors: null });
    }
    return real(input as RequestInfo, init);
  });
}

describe("docs/agent-guide.md のレシピ(§13.10)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("llms_txt_serves_the_agent_guide_without_auth", async () => {
    const res = await call("GET", "/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith("# エージェント向けガイド")).toBe(true);
    for (const needle of ["/sites/$SID/evaluate", "draft-bootstrap", "analytics-recipe", "__ab_preview", "AB_API_KEY"]) {
      expect(body, `guide に「${needle}」が無い`).toContain(needle);
    }

    // 契約にも無認証の入口として載っている(hono-openapi の excludeStaticFile 既定 true では paths から落ちる)
    const spec = await json<{ paths: Record<string, { get?: { security?: unknown[] } }> }>(await call("GET", "/openapi.json"));
    expect(spec.paths["/llms.txt"]?.get, "/llms.txt が openapi.json の paths に無い").toBeDefined();
    expect(spec.paths["/llms.txt"]!.get!.security, "/llms.txt は security: [] = 無認証").toEqual([]);
  });

  it("agent_guide_recipe_create_and_publish", async () => {
    const { key, wid, token } = await agentKey();
    const { id: sid } = await createSite(token, wid);
    // レシピ 1 の 4 手順をそのままなぞる
    expect((await call("GET", `/workspaces/${wid}/sites`, { token: key })).status).toBe(200);
    const created = await call("POST", `/sites/${sid}/experiments`, {
      token: key,
      body: { id: "exp_hero_q1", name: "Hero Q1", urlMatch: { op: "contains", value: "/lp/" }, trafficPercentage: 100 },
    });
    expect(created.status).toBe(201);
    const changes = await call("PUT", `/sites/${sid}/experiments/exp_hero_q1/variants/b/changes`, {
      token: key,
      body: [{ id: "c_text", type: "TEXT", selector: "h1.hero", payload: { text: "新しい見出し" } }],
    });
    expect(changes.status).toBe(200);
    const started = await call("POST", `/sites/${sid}/experiments/exp_hero_q1/status`, { token: key, body: { status: "running" } });
    expect(started.status).toBe(200);
    expect((await json<{ publish: { ok: boolean } }>(started)).publish.ok).toBe(true);
    expect((await json<{ activeVersion: number | null }>(await call("GET", `/sites/${sid}`, { token: key }))).activeVersion).not.toBeNull();
  });

  it("agent_guide_recipe_verify_draft", async () => {
    const { key, wid, token } = await agentKey();
    const { id: sid } = await createSite(token, wid);
    await call("POST", `/sites/${sid}/experiments`, { token: key, body: { id: "exp_draft", name: "D", urlMatch: { op: "contains", value: "/lp/" } } });
    await call("PUT", `/sites/${sid}/experiments/exp_draft/variants/b/changes`, {
      token: key,
      body: [{ id: "c_text", type: "TEXT", selector: "h1.hero", payload: { text: "下書き" } }],
    });
    const res = await call("GET", `/sites/${sid}/experiments/exp_draft/draft-bootstrap`, { token: key });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("下書き");
    expect(body).toContain("/*! wtt-runtime */"); // ページに注入できる本物の bootstrap
  });

  it("agent_guide_recipe_read_results", async () => {
    const { key, wid, token } = await agentKey();
    const { id: sid } = await createSite(token, wid);
    await call("POST", `/sites/${sid}/experiments`, { token: key, body: { id: "exp_r", name: "R", urlMatch: { op: "contains", value: "/" } } });
    const r = await json<{
      ga4: { propertyId: string; exposureByVariant: { method: string; url: string; body: Record<string, unknown> } };
      bigquery: { visitorCvrSql: string };
    }>(await call("GET", `/sites/${sid}/experiments/exp_r/analytics-recipe`, { token: key }));
    expect(r.ga4.propertyId).toBe("{{GA4_PROPERTY_ID}}");
    expect(r.ga4.exposureByVariant.method).toBe("POST");
    expect(r.ga4.exposureByVariant.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/{{GA4_PROPERTY_ID}}:runReport");
    expect(r.ga4.exposureByVariant.body).not.toHaveProperty("property"); // property は URL に入る
    expect(r.bigquery.visitorCvrSql).toContain("SAFE_DIVIDE");
  });

  it("agent_guide_recipe_what_if", async () => {
    const { key, wid, token } = await agentKey();
    const { id: sid } = await createSite(token, wid);
    await call("POST", `/sites/${sid}/experiments`, { token: key, body: { id: "exp_w", name: "W", urlMatch: { op: "contains", value: "/lp/" } } });
    await call("PUT", `/sites/${sid}/experiments/exp_w/variants/b/changes`, {
      token: key,
      body: [{ id: "c_text", type: "TEXT", selector: "h1.hero", payload: { text: "b" } }],
    });
    await call("POST", `/sites/${sid}/experiments/exp_w/status`, { token: key, body: { status: "running" } });
    type Item = { experimentId: string; status: string; published: boolean; eligible: boolean; reason?: string; variantId?: string };
    type Body = { source: "published" | "draft"; version: number | null; experiments: Item[] };
    const miss = await json<Body>(
      await call("POST", `/sites/${sid}/evaluate`, { token: key, body: { url: "https://www.example.com/", device: "mobile" } }),
    );
    // ガイドのレシピ 4 の応答例と同じ形(決定 39 (7))
    expect(miss.source).toBe("published");
    expect(miss.version).toBeGreaterThan(0);
    expect(miss.experiments[0]).toMatchObject({
      experimentId: "exp_w",
      status: "running",
      published: true,
      eligible: false,
      reason: "url_mismatch",
    });
    const hit = await json<Body>(
      await call("POST", `/sites/${sid}/evaluate`, { token: key, body: { url: "https://www.example.com/lp/", visitorId: "test-visitor-1" } }),
    );
    expect(hit.experiments[0]!.eligible).toBe(true);
    expect(["a", "b"]).toContain(hit.experiments[0]!.variantId);
  });

  // レシピ 7(D9 plan ①): 複製。同じ内容 / 選んだパターンだけを表示するパーソナライズ
  it("agent_guide_recipe_duplicate", async () => {
    const { key, wid, token } = await agentKey();
    const { id: sid } = await createSite(token, wid);
    expect((await call("POST", `/sites/${sid}/experiments`, { token: key, body: { id: "exp_src", name: "Source", urlMatch: { op: "contains", value: "/" } } })).status).toBe(201);
    const same = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: key, body: { mode: "same" } });
    expect(same.status).toBe(201);
    expect(await json(same)).toMatchObject({ kind: "test", status: "draft" });
    const variant = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token: key, body: { mode: "variant", variantId: "b" } });
    expect(variant.status).toBe(201);
    expect(await json(variant)).toMatchObject({ kind: "single", status: "draft", trafficPercentage: 100, persistAssignment: false });
  });

  it("agent_guide_recipe_watch_usage", async () => {
    const owner = await setupOwner();
    // 監視用の鍵 = ワークスペース 1 つ・閲覧者(レシピ 6 の「閲覧者の鍵で可」)
    const { key } = await json<{ key: string }>(
      await call("POST", "/me/api-keys", { token: owner.token, body: { name: "usage-monitor", workspaceId: owner.workspaceId, roleCap: "viewer" } }),
    );
    mockGraphql();
    resetUsageCache();
    const res = await call("GET", "/usage", { token: key, envOverride: USAGE_ENV });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.worst).toMatchObject({ id: "workers_requests", status: "warning" });
    expect(typeof body.resetAt).toBe("number");
  });
});
