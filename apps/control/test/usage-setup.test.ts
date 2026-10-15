import { describe, expect, it } from "vitest";
import { beforeD1Batch, call, failingD1Insert, failingD1Query, json, SETUP_TOKEN } from "./helpers";
import { env } from "cloudflare:workers";

// backlog D10 / brief K7: 初期導入で「見られる人」を決める(deploy-answers の usage_visibility → POST /setup)
const setup = (extra: Record<string, unknown>) =>
  call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email: "owner@example.com", workspaceName: "W", ...extra } });

describe("setup with usage visibility (D10 K7)", () => {
  it("stores the chosen visibility", async () => {
    expect((await setup({ usageVisibility: "instance_admins" })).status).toBe(201);
    const row = await env.DB.prepare("select value, updated_by from instance_settings where key = 'usageVisibility'").first();
    expect(row).toEqual({ value: '"instance_admins"', updated_by: null });
  });

  it("leaves the default when omitted (no row)", async () => {
    expect((await setup({})).status).toBe(201);
    const n = await env.DB.prepare("select count(*) as n from instance_settings").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("rejects an unknown value with 422 before creating anything", async () => {
    const res = await setup({ usageVisibility: "everyone" });
    expect(res.status).toBe(422);
    expect((await json(res)).path).toEqual(["usageVisibility"]);
    const users = await env.DB.prepare('select count(*) as n from "user"').first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("a failed settings write leaves no workspace, user or setting and the retry succeeds", async () => {
    const count = async (table: string) => (await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n;
    const failed = await call("POST", "/setup", {
      headers: { "x-setup-token": SETUP_TOKEN },
      body: { email: "owner@example.com", workspaceName: "W", usageVisibility: "instance_admins" },
      envOverride: { DB: failingD1Insert(env.DB, "instance_settings") },
    });
    expect(failed.status).toBe(503);
    expect((await json(failed)).error).toBe("setup_failed");
    expect(await count("organization")).toBe(0);
    expect(await count('"user"')).toBe(0);
    expect(await count("instance_settings")).toBe(0);
    // 失敗注入なし・usageVisibility 省略で再試行できる。前回の値は引き継がない
    expect((await setup({})).status).toBe(201);
    expect(await count("instance_settings")).toBe(0);
  });

  it("a failed completion write leaves nothing behind and the retry succeeds", async () => {
    const count = async (table: string) => (await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n;
    const failed = await call("POST", "/setup", {
      headers: { "x-setup-token": SETUP_TOKEN },
      body: { email: "owner@example.com", workspaceName: "W" },
      envOverride: { DB: failingD1Query(env.DB, /update setup_lock set completed/i) },
    });
    expect(failed.status).toBe(503);
    expect(await count("organization")).toBe(0);
    expect(await count('"user"')).toBe(0);
    expect((await setup({})).status).toBe(201);
  });

  it("when even the workspace cleanup fails, the stale path recovers after 60 seconds", async () => {
    const count = async (table: string) => (await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n;
    const failed = await call("POST", "/setup", {
      headers: { "x-setup-token": SETUP_TOKEN },
      body: { email: "owner@example.com", workspaceName: "W" },
      envOverride: { DB: failingD1Query(failingD1Query(env.DB, /update setup_lock set completed/i), /delete from organization where id/i) },
    });
    expect(failed.status).toBe(503);
    // lock・user・organization を残す(compensate を呼ばない)
    expect(await count("organization")).toBe(1);
    expect(await env.DB.prepare("select completed from setup_lock where id = 1").first()).toEqual({ completed: 0 });
    // 60 秒より古くして、stale の経路に入れる
    await env.DB.prepare("update setup_lock set created_at = created_at - 61000").run();
    expect((await setup({})).status).toBe(201);
    expect(await count("organization")).toBe(1); // 前回の残りは消え、新しいものだけ
  });
});

// D10 最終レビュー finding 2: stale の経路(前回の残りを消す)はトークンを確かめてから。完了の書き込みは lock を取った本人だけ
describe("setup hardening (D10 final review finding 2)", () => {
  const count = async (table: string) => (await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>())?.n;
  const lockRow = () => env.DB.prepare("select id, created_at, completed from setup_lock where id = 1").first();

  it("without the token or with a wrong token, a stale setup deletes nothing (403)", async () => {
    // 補償のワークスペースの削除まで失敗した前回の残り: 未完了の古い lock + user + organization
    const old = Date.now() - 61_000;
    await env.DB.prepare("insert into setup_lock (id, created_at, completed) values (1, ?, 0)").bind(old).run();
    const iso = new Date().toISOString();
    await env.DB.prepare('insert into "user" (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 0, ?, ?)').bind("u_left", "Left", "left@example.com", iso, iso).run();
    await env.DB.prepare('insert into organization (id, name, slug, "createdAt") values (?, ?, ?, ?)').bind("o_left", "Left", "left", iso).run();
    const body = { email: "intruder@example.com", workspaceName: "X" };
    for (const headers of [{}, { "x-setup-token": "wrong" }] as Record<string, string>[]) {
      const res = await call("POST", "/setup", { headers, body });
      expect(res.status).toBe(403);
      expect((await json(res)).error).toBe("setup_closed");
    }
    expect(await count("organization")).toBe(1);
    expect(await count('"user"')).toBe(1);
    expect(await lockRow()).toEqual({ id: 1, created_at: old, completed: 0 });
  });

  it("when another request takes over the lock before completion, the request compensates and leaves completed = 0 and no setting", async () => {
    // 完了を書く直前に、別のリクエストが stale の lock を CAS で取り直した(created_at が書き換わった)状態にする
    const takeover = () => env.DB.prepare("update setup_lock set created_at = created_at + 1 where id = 1").run();
    const res = await call("POST", "/setup", {
      headers: { "x-setup-token": SETUP_TOKEN },
      body: { email: "owner@example.com", workspaceName: "W", usageVisibility: "instance_admins" },
      envOverride: { DB: beforeD1Batch(env.DB, takeover) },
    });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("setup_failed");
    expect(await lockRow()).toMatchObject({ completed: 0 }); // 取り直した側の lock は消さない
    expect(await count("instance_settings")).toBe(0);
    expect(await count("organization")).toBe(0);
    expect(await count('"user"')).toBe(0);
  });
});
