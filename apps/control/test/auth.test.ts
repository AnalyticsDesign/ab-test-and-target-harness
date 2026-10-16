import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import app from "../src/index";
import { errorHandler } from "../src/errors";
import { alignToWindow, BREAK_GLASS, call, json, setupOwner, SETUP_TOKEN, uniqueEmail, expectEnvelope, failingD1Insert, failingD1Query, setupReq, googleSignIn } from "./helpers";
import type { Env } from "../src/env";

describe("setup and sign-up gate", () => {
  it("setup creates owner and workspace, then /me works with bearer", async () => {
    const { token, workspaceId } = await setupOwner();
    const me = await call("GET", "/me", { token });
    expect(me.status).toBe(200);
    expect((await json(me)).name).toBe("Owner");
    expect(workspaceId).toMatch(/\S/);
  });
  it("setup is rejected without the token and after the first user exists", async () => {
    const body = { email: uniqueEmail(), name: "x", workspaceName: "W" };
    expect((await call("POST", "/setup", { body })).status).toBe(403);
    expect((await call("POST", "/setup", { headers: { "x-setup-token": "wrong" }, body })).status).toBe(403);
    await setupOwner();
    expect((await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body })).status).toBe(403);
  });
  it("setup takes no password, returns no session token, and leaves no session behind (決定 46 (4))", async () => {
    const email = uniqueEmail("owner");
    const res = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email, workspaceName: "W" } });
    expect(res.status).toBe(201);
    const data = await json<Record<string, unknown>>(res);
    expect(Object.keys(data).sort()).toEqual(["userId", "workspaceId"]);
    const { env } = await import("cloudflare:workers");
    const n = await (env as { DB: D1Database }).DB.prepare(`select count(*) as n from session where userId = ?`).bind(data.userId).first<{ n: number }>();
    expect(n?.n).toBe(0);
    // 名前を省くとメールの @ より前。ログインは Google
    const { token } = await googleSignIn(email);
    expect(await json(await call("GET", "/me", { token: token! }))).toMatchObject({ email, name: email.split("@")[0] });
  });
  it("setup rejects a password field", async () => {
    const res = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email: uniqueEmail(), workspaceName: "W", password: "password123" } });
    expect(res.status).toBe(422);
  });
  it("setup recovers after organization creation fails", async () => {
    const broken = { ...env, DB: failingD1Insert(env.DB, "organization") }; // helpers: organization への insert だけ throw する D1 ラッパ
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await app.request(setupReq(), undefined, broken);
      expect(first.status).toBe(503);
      const body = (await first.json()) as Record<string, unknown>;
      expect(body.error).toBe("setup_failed");
      // 利用者向けの message は日本語のまま(生の例外文字列で上書きしない)
      expect(body.message).toBe("初回セットアップに失敗しました");
      // 内部の原因(生の例外文字列)は**クライアントに出さず**、サーバーログにだけ残す(rulings §4 CX-Medium-1)
      expect(body).not.toHaveProperty("detail");
      const logged = errorLog.mock.calls.flat().map((a) => (typeof a === "object" && a !== null && !(a instanceof Error) ? JSON.stringify(a) : String(a))).join("\n");
      expect(logged).toContain("injected d1 insert failure for organization");
    } finally {
      errorLog.mockRestore();
    }
    const second = await app.request(setupReq(), undefined, env);
    expect(second.status).toBe(201);
  });
  it("setup keeps the lock when compensation cannot delete the user, so the stale path can recover", async () => {
    // Workspace 作成が失敗し、さらに補償の user 削除も失敗する(D1 障害が続いている)状況。
    // 旧実装は user 削除の失敗を捨てて lock だけ消していたため、孤児 user が残った状態で lock が無くなり、
    // 次の setup は hooks.before の「user 0 件」ゲートで永久に 403 になった(rulings §4 CX-High-4)
    const broken = { ...env, DB: failingD1Query(failingD1Insert(env.DB, "organization"), /^\s*delete from "user" where id/i) };
    const first = await app.request(setupReq(), undefined, broken);
    expect(first.status).toBe(503);
    const lock = await env.DB.prepare("select completed from setup_lock where id = 1").first<{ completed: number }>();
    expect(lock?.completed).toBe(0); // 未完了の lock が残る(= 60 秒後に stale 経路へ入れる)
    const users = () => env.DB.prepare('select count(*) as n from "user"').first<{ n: number }>().then((r) => r?.n);
    expect(await users()).toBe(1); // 孤児 user は残っている
    expect((await app.request(setupReq("b@example.com"), undefined, env)).status).toBe(403); // 60 秒以内は同時実行扱い
    await env.DB.prepare("update setup_lock set created_at = ? where id = 1").bind(Date.now() - 61_000).run();
    const second = await app.request(setupReq("b@example.com"), undefined, env);
    expect(second.status).toBe(201); // stale 経路が孤児 user を消して OWNER を作り直す
    expect(await users()).toBe(1);
  });
  it("a stale interrupted setup can be redone after 60 seconds", async () => {
    // 前回が lock 取得 + user 作成の直後に中断した状態を作る
    await env.DB.prepare("insert into setup_lock (id, created_at, completed) values (1, ?, 0)").bind(Date.now() - 61_000).run();
    await env.DB.prepare('insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 0, ?, ?)').bind("u_stale", "Ghost", "ghost@example.com", new Date().toISOString(), new Date().toISOString()).run();
    const res = await app.request(setupReq(), undefined, env);
    expect(res.status).toBe(201);
    const ghost = await env.DB.prepare('select count(*) as n from "user" where id = ?').bind("u_stale").first<{ n: number }>();
    expect(ghost?.n).toBe(0);
    expect((await app.request(setupReq("second@example.com"), undefined, env)).status).toBe(403);
  });

  it("concurrent setup creates exactly one owner workspace", async () => {
    const results = await Promise.all([app.request(setupReq(), undefined, env), app.request(setupReq("b@example.com"), undefined, env)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    const orgs = await env.DB.prepare('select count(*) as n from organization').first<{ n: number }>();
    expect(orgs?.n).toBe(1);
  });
  it("concurrent setup against a stale lock creates exactly one owner workspace", async () => {
    // 中断された前回(lock 取得 + user 作成の直後)に、2 本のリクエストが同時に入る。
    // stale 回復が観測した行への CAS でなければ、両方が lock を取り直して OWNER が 2 つできる
    await env.DB.prepare("insert into setup_lock (id, created_at, completed) values (1, ?, 0)").bind(Date.now() - 61_000).run();
    await env.DB.prepare('insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 0, ?, ?)').bind("u_stale", "Ghost", "ghost@example.com", new Date().toISOString(), new Date().toISOString()).run();
    // 2 本目を D1 の 1 往復ぶん遅らせる。完全に歩調が揃っていると「後から来た側が、先に来た側の取った
    // lock を消してから自分の lock を入れる」という一番危険な並びにならないため、意図的にずらす
    const first = app.request(setupReq(), undefined, env);
    await env.DB.prepare("select 1 as n").first();
    const second = app.request(setupReq("b@example.com"), undefined, env);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    const orgs = await env.DB.prepare("select count(*) as n from organization").first<{ n: number }>();
    expect(orgs?.n).toBe(1);
    // 前回の痕跡(ghost)は消え、CAS に勝った側の OWNER だけが残る
    const users = await env.DB.prepare('select count(*) as n from "user"').first<{ n: number }>();
    expect(users?.n).toBe(1);
    expect((await app.request(setupReq("third@example.com"), undefined, env)).status).toBe(403);
  });
  it("signup_without_invitation_403", async () => {
    await setupOwner();
    // Better Auth のエンドポイントを直接叩いても、招待 ID もセットアップトークンも無ければ 403(hooks.before のゲート)
    const res = await call("POST", "/auth/sign-up/email", { body: { email: uniqueEmail(), name: "Stranger", password: "password123" }, envOverride: BREAK_GLASS });
    expect(res.status).toBe(403);
    const bogus = await call("POST", "/auth/sign-up/email", { headers: { "x-invitation-id": "does-not-exist" }, body: { email: uniqueEmail(), name: "Stranger", password: "password123" }, envOverride: BREAK_GLASS });
    expect(bogus.status).toBe(403);
  });
  it("unauthenticated /me is 401", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
    expect((await call("GET", "/me", { token: "not-a-token" })).status).toBe(401);
  });
  it("openapi document is served as 3.1 and covers the routes this app mounts", async () => {
    const res = await app.request("/openapi.json", {}, env);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    expect(doc.openapi).toMatch(/^3\.1/);
    // 決定 34 / DoD 7b: mount したルートは describeRoute 経由で paths に出る(メソッドまで固定する)
    const operations = Object.entries(doc.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
      .sort();
    expect(operations).toEqual([
      "DELETE /instance-admins/{userId}",
      "DELETE /me/api-keys/{kid}",
      "DELETE /sites/{sid}",
      "DELETE /sites/{sid}/audiences/{aid}",
      "DELETE /sites/{sid}/experiments/{eid}",
      "DELETE /sites/{sid}/goals/{gid}",
      "DELETE /workspaces/{wid}",
      "DELETE /workspaces/{wid}/api-keys/{kid}",
      "DELETE /workspaces/{wid}/invitations/{id}",
      "DELETE /workspaces/{wid}/members/{memberId}",
      "GET /auth/callback/google",
      "GET /auth/google/start",
      "GET /capabilities",
      "GET /instance-admins",
      "GET /instance-admins/candidates",
      "GET /invitations/{id}",
      "GET /llms.txt",
      "GET /login-options",
      "GET /me",
      "GET /me/api-keys",
      "GET /sites/{sid}",
      "GET /sites/{sid}/assets",
      "GET /sites/{sid}/audiences",
      "GET /sites/{sid}/audiences/{aid}",
      "GET /sites/{sid}/experiments",
      "GET /sites/{sid}/experiments/{eid}",
      "GET /sites/{sid}/experiments/{eid}/analytics-recipe",
      "GET /sites/{sid}/experiments/{eid}/draft-bootstrap",
      "GET /sites/{sid}/goals",
      "GET /sites/{sid}/publish-preview",
      "GET /sites/{sid}/publishes",
      "GET /sites/{sid}/publishes/{version}",
      "GET /usage",
      "GET /usage/settings",
      "GET /workspaces",
      "GET /workspaces/summary",
      "GET /workspaces/{wid}/api-keys",
      "GET /workspaces/{wid}/invitations",
      "GET /workspaces/{wid}/members",
      "GET /workspaces/{wid}/sites",
      "PATCH /sites/{sid}",
      "PATCH /sites/{sid}/audiences/{aid}",
      "PATCH /sites/{sid}/experiments/{eid}",
      "PATCH /sites/{sid}/goals/{gid}",
      "PATCH /usage/settings",
      "PATCH /workspaces/{wid}/members/{memberId}",
      "POST /auth/handoff/exchange",
      "POST /break-glass/reset-link",
      "POST /instance-admins",
      "POST /invitations/{id}/accept",
      "POST /me/api-keys",
      "POST /setup",
      "POST /sites/{sid}/assets",
      "POST /sites/{sid}/audiences",
      "POST /sites/{sid}/evaluate",
      "POST /sites/{sid}/experiments",
      "POST /sites/{sid}/experiments/{eid}/duplicate",
      "POST /sites/{sid}/experiments/{eid}/status",
      "POST /sites/{sid}/goals",
      "POST /sites/{sid}/publish",
      "POST /sites/{sid}/static/redeploy",
      "POST /workspaces",
      "POST /workspaces/{wid}/invitations",
      "POST /workspaces/{wid}/members/{memberId}/reset-link",
      "POST /workspaces/{wid}/sites",
      "PUT /sites/{sid}/experiments/{eid}/variants",
      "PUT /sites/{sid}/experiments/{eid}/variants/{vid}/changes",
    ]);
    // 決定 34: PUT …/changes の validator は緩い配列(検証は parseChange が機械可読コードで返す)だが、
    // requestBody の items は core の ChangeSchema から生成し、エージェントが要素の形を doc から読める
    const changesBody = (doc.paths as any)["/sites/{sid}/experiments/{eid}/variants/{vid}/changes"].put.requestBody;
    const items = changesBody.content["application/json"].schema.items;
    expect(Object.keys(items).length).toBeGreaterThan(0);
    expect(items.oneOf.map((s: any) => s.properties.type.const)).toEqual(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]);
    // 封筒のエラー応答が付いている(errorResponses ヘルパ)
    expect(Object.keys(doc.paths["/setup"]!.post!.responses).sort()).toEqual(["201", "400", "403", "422", "429", "503"]);
    expect(Object.keys(doc.paths["/me"]!.get!.responses).sort()).toEqual(["200", "401"]);
  });
  it("http exceptions keep their status and get a code in the envelope", async () => {
    // errorHandler は Task 2 以降が継承する共有基盤。hono / ミドルウェアが投げる HTTPException の
    // status を握りつぶして 500 にしないこと(Task 9 の envelope.test が 400/401/403/404/409/422/429 を固定する)
    const probe = new Hono();
    probe.onError(errorHandler);
    probe.get("/conflict", () => { throw new HTTPException(409); });
    probe.get("/too-large", () => { throw new HTTPException(413); });
    probe.get("/teapot", () => { throw new HTTPException(418); }); // 表に無い 4xx はフォールバック
    const cases: [string, number, string][] = [
      ["/conflict", 409, "conflict"],
      ["/too-large", 413, "payload_too_large"],
      ["/teapot", 418, "request_failed"],
    ];
    for (const [path, status, code] of cases) {
      const res = await probe.request(path);
      expect(res.status).toBe(status);
      const body = await expectEnvelope(res);
      expect(body.error).toBe(code);
      expect(body.message).not.toBe(code); // 日本語の既定文が入る(code の素通しではない)
    }
  });
  it("a body that is not json is 400 bad_request, not 500", async () => {
    const res = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN, "content-type": "application/json" }, raw: "not json at all" });
    expect(res.status).toBe(400);
    expect((await expectEnvelope(res)).error).toBe("bad_request");
    // 形は JSON だが schema に合わない body は 422 validation_failed(path + issues 付き)
    const bad = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email: "not-an-email", name: "x", workspaceName: "" } });
    expect(bad.status).toBe(422);
    const body = await expectEnvelope(bad);
    expect(body.error).toBe("validation_failed");
    expect(body.path).toEqual(["email"]);
    expect((body.issues as { path: string[] }[]).map((i) => i.path[0]).sort()).toEqual(["email", "workspaceName"]);
  });
  it("unknown route returns an error envelope", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    await expectEnvelope(res);
  });
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  // パスワード経路は break-glass のときだけ開く(決定 46 (2))。枠そのものを試すテストなので開けた状態で叩く
  const signIn = (headers: Record<string, string> = ip) =>
    call("POST", "/auth/sign-in/email", { body: { email: "nobody@example.com", password: "wrong-password" }, headers, envOverride: BREAK_GLASS });
  const requestReset = () =>
    call("POST", "/auth/request-password-reset", { body: { email: "nobody@example.com", redirectTo: "http://localhost:3000/reset" }, headers: ip, envOverride: BREAK_GLASS });
  const setup = (headers: Record<string, string> = ip) => call("POST", "/setup", { body: {}, headers: { ...headers, "x-setup-token": "wrong" } });
  const accept = (id: string) => call("POST", `/invitations/${id}/accept`, { body: { name: "x", password: "password123" }, headers: ip, envOverride: BREAK_GLASS });

  it("each unauthenticated entry point has its own per-ip limit of 10 per 10 seconds", async () => {
    await alignToWindow();
    // 1 経路を使い切る。sign-in はパスワードハッシュ比較を挟むため 11 回連続だと(並行実行される他
    // ファイルの Miniflare インスタンスの分だけ CPU を取り合い)10 秒窓を超えうる — setup はトークン
    // 不一致で即 403 になり計算コストが軽いので、ここでは setup を使って枠を使い切る
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await setup()).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // 決定 35 (3): 他の経路は巻き込まれない(同じ IP でも別枠)
    expect((await signIn()).status).not.toBe(429);
    expect((await requestReset()).status).not.toBe(429);
    expect((await accept("inv_x")).status).not.toBe(429);
    // 別 IP は別枠(同じ経路でも)
    expect((await setup({ "cf-connecting-ip": "198.51.100.1" })).status).not.toBe(429);
  }, 15_000);

  it("invitation accept shares one limit across invitation ids", async () => {
    await alignToWindow();
    // 招待 ID を変えても枠は同じ(ID ごとに枠が分かれると総当たりの枠が無限になる)
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await accept(`inv_${i}`)).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  }, 15_000);

  it("rate limiter failure is fail-open (the request goes through and the error is logged)", async () => {
    const boom = { limit: async () => { throw new Error("limiter down"); } } as unknown as Env["AUTH_RATE_LIMITER"];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 比較対象: limiter が正常なときの同じ失敗ログイン(存在しないユーザー)の status
      const normal = (await signIn({ "cf-connecting-ip": "203.0.113.51" })).status;
      const res = await call("POST", "/auth/sign-in/email", {
        body: { email: "nobody@example.com", password: "wrong-password" },
        headers: { "cf-connecting-ip": "203.0.113.50" },
        // 比較対象(signIn)と同じく break-glass を開けた状態にする。閉じたままだと両方 404 になり、
        // 「Better Auth まで届いている」ことを何も試さなくなる
        envOverride: { ...BREAK_GLASS, AUTH_RATE_LIMITER: boom },
      });
      // 通っている = Better Auth まで届いて正常時と同じ status(4xx)。500 でも 429 でもない
      expect(res.status).toBe(normal);
      expect(res.status).toBeLessThan(500);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
