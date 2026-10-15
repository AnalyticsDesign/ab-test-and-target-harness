// apps/control/test/usage-routes.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUsageCache } from "../src/usage";
import { call, expectEnvelope, googleSignIn, inviteAndJoin, json, setupOwner, uniqueEmail } from "./helpers";

// backlog D10 / brief K4・K6・K10・K13、plan K18・K26
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONFIGURED = { CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT } as const;
const emptyAccount = { workers: [], doRequests: [], doNamespaces: [], doRows: [], doStorage: [], d1: [], d1Storage: [], kv: [], kvStorage: [] };

function mockGraphql() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      return Response.json({ data: { viewer: { accounts: [{ ...emptyAccount, workers: [{ dimensions: { scriptName: "wtt-control" }, sum: { requests: 80_000 } }] }] } }, errors: null });
    }
    return real(input as RequestInfo, init);
  });
}
const key = async (token: string, workspaceId: string | null, roleCap: string | null = "viewer") =>
  (await json<{ key: string }>(await call("POST", "/me/api-keys", { token, body: { name: "monitor", workspaceId, roleCap } }))).key;
const getUsage = (token: string) => call("GET", "/usage", { token, envOverride: CONFIGURED });
const patch = (token: string, body: unknown) => call("PATCH", "/usage/settings", { token, body });

describe("usage routes (D10)", () => {
  beforeEach(() => resetUsageCache());
  afterEach(() => vi.restoreAllMocks());

  it("requires a session or a key", async () => {
    expect((await call("GET", "/usage")).status).toBe(401);
    expect((await call("GET", "/usage/settings")).status).toBe(401);
  });

  it("is 503 usage_not_configured without the token, with a hint (K10)", async () => {
    const owner = await setupOwner();
    const res = await call("GET", "/usage", { token: owner.token });
    expect(res.status).toBe(503);
    expect(await expectEnvelope(res)).toMatchObject({ error: "usage_not_configured" });
  });

  it("members (default): every member and every member's key can read (K4)", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const viewerKey = await key(editor.token, owner.workspaceId, "viewer");
    mockGraphql();
    for (const t of [owner.token, editor.token, viewerKey]) {
      const res = await getUsage(t);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toMatchObject({ plan: "free", settings: { usageVisibility: "members" }, worst: { id: "workers_requests", status: "warning" } });
      expect(body.resources).toHaveLength(14);
    }
  });

  it("members: a session of an invited but not yet joined user is 403 on both GETs", async () => {
    const owner = await setupOwner();
    const email = uniqueEmail("invited");
    const inv = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "viewer" } });
    expect(inv.status).toBe(201);
    // Google でログインするだけで、招待は受諾しない(セッションは招待を持つだけの人にも出る = access.ts の hasAccess)
    const { token } = await googleSignIn(email);
    expect(token).toBeTruthy();
    for (const res of [await getUsage(token!), await call("GET", "/usage/settings", { token: token! })]) {
      expect(res.status).toBe(403);
      await expectEnvelope(res);
    }
  });

  it("instance_admins: only instance admins, but their keys of any scope and role cap are fine (K4, review focus)", async () => {
    const owner = await setupOwner();
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const ownerWorkspaceViewerKey = await key(owner.token, owner.workspaceId, "viewer");
    const editorKey = await key(editor.token, owner.workspaceId, "viewer");
    expect((await patch(owner.token, { usageVisibility: "instance_admins" })).status).toBe(200);
    mockGraphql();
    expect((await getUsage(owner.token)).status).toBe(200);
    expect((await getUsage(ownerWorkspaceViewerKey)).status).toBe(200);
    for (const t of [editor.token, editorKey]) {
      const res = await getUsage(t);
      expect(res.status).toBe(403);
      expect(await expectEnvelope(res)).toMatchObject({ error: "forbidden", required: "instance_admin", message: "使用状況はシステム管理者だけが見られる設定になっています" });
    }
    // 設定の読み取りも同じ規則
    expect((await call("GET", "/usage/settings", { token: editor.token })).status).toBe(403);
    const viaKey = await call("GET", "/usage/settings", { token: ownerWorkspaceViewerKey, envOverride: CONFIGURED });
    expect(viaKey.status).toBe(200);
    expect((await json(viaKey)).configured).toBe(true); // トークンとアカウント ID があれば true
  });

  it("instance_admins: the key of a user who is no longer an instance admin is refused", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: admin.email } })).status).toBe(201);
    const adminKey = await key(admin.token, owner.workspaceId, "viewer");
    expect((await patch(owner.token, { usageVisibility: "instance_admins" })).status).toBe(200);
    mockGraphql();
    expect((await getUsage(adminKey)).status).toBe(200);
    expect((await call("DELETE", `/instance-admins/${admin.userId}`, { token: owner.token })).status).toBe(204);
    // 外したときに所属が残るか消えるかは別の変更で変わりうるため、どちらでも断られることだけを固定する
    expect([401, 403]).toContain((await getUsage(adminKey)).status);
  });

  it("PATCH /usage/settings: instance admin session only, partial, validated (K6, K18)", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const ownerKey = await key(owner.token, null, null);
    // 鍵では断る(人とアクセス権の書き込み)
    const byKey = await patch(ownerKey, { cloudflarePlan: "paid" });
    expect(byKey.status).toBe(403);
    expect((await json(byKey)).error).toBe("session_required");
    // ワークスペースの管理者でも、システム管理者でなければ断る
    const byAdmin = await patch(admin.token, { cloudflarePlan: "paid" });
    expect(byAdmin.status).toBe(403);
    expect((await json(byAdmin)).required).toBe("instance_admin");
    // 空・知らないキー・不正な値は 422
    for (const bad of [{}, { other: 1 }, { cloudflarePlan: "enterprise" }, { showPaidReference: "yes" }]) {
      const res = await patch(owner.token, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
      await expectEnvelope(res);
    }
    const ok = await patch(owner.token, { cloudflarePlan: "paid", showPaidReference: false });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false });
    // configured は読み取り専用(テストの既定は未設定 = false)。PATCH の応答には含めない
    expect(await json(await call("GET", "/usage/settings", { token: owner.token }))).toEqual({ usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false, configured: false });
  });

  it("paid with the reference hidden on screen still returns the reference (K13)", async () => {
    const owner = await setupOwner();
    await patch(owner.token, { cloudflarePlan: "paid", showPaidReference: false });
    mockGraphql();
    const body = await json(await getUsage(owner.token));
    const w = body.resources.find((r: { id: string }) => r.id === "workers_requests");
    expect(w).toMatchObject({ status: "within_reference", limit: null });
    expect(w.reference.value).toBeCloseTo(10_000_000 / 30);
  });

  it("an upstream failure is 503 usage_upstream_failed (K10)", async () => {
    const owner = await setupOwner();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.cloudflare.com/client/v4/graphql") return Response.json({ data: null, errors: [{ message: "not authorized" }] });
      return real(input as RequestInfo, init);
    });
    const res = await getUsage(owner.token);
    expect(res.status).toBe(503);
    const env = await expectEnvelope(res);
    expect(env.error).toBe("usage_upstream_failed");
    expect(JSON.stringify(env)).not.toContain("not authorized"); // 上流の生の文言は detail(ログ)だけ
  });
});
