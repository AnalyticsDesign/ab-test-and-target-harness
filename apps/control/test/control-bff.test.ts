// apps/control/test/control-bff.test.ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, CLIENT_VERSION_HEADER } from "@wtt/core";
import worker, { app, ControlBff } from "../src/index";
import { stripTrustedHeaders } from "../src/trusted-headers";
import type { Env } from "../src/env";
import { call, json, setupOwner, testEnv } from "./helpers";

/**
 * 記録する偽の limiter。AUTH_RATE_LIMITER に渡った `key` を並べる(回数には頼らない。常に通す)。
 * 鍵は `<経路種別>:<IP>`
 */
function recordingLimiter() {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) } as unknown as Env["AUTH_RATE_LIMITER"];
  return { keys, env: { ...testEnv, AUTH_RATE_LIMITER: limiter } as Env };
}
const ROUTE = "/auth/handoff/exchange";
const post = (headers: Headers | Record<string, string>, path = ROUTE, body: unknown = { code: "bogus" }) =>
  new Request(`http://control.test${path}`, { method: "POST", headers: new Headers(headers), body: JSON.stringify(body) });

/** default export(公開の入口)の fetch */
async function viaPublic(req: Request, e: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(req as never, e as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
/** ControlBff(admin の service binding の入口)の fetch */
async function viaBff(req: Request, e: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await new ControlBff(ctx, e as never).fetch(req);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("stripTrustedHeaders (plan12 K8)", () => {
  it("removes the client IP header whatever the case, keeps the others and the body", async () => {
    const h = new Headers({ "cf-connecting-ip": "198.19.0.1", "content-type": "application/json" });
    h.set("X-WTT-Client-IP", "203.0.113.9");
    const out = stripTrustedHeaders(post(h));
    expect(out.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(out.headers.get("cf-connecting-ip")).toBe("198.19.0.1");
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.method).toBe("POST");
    expect(out.url).toBe("http://control.test/auth/handoff/exchange");
    expect(await json(out as never)).toEqual({ code: "bogus" });
  });
});

describe("public entry and ControlBff (plan12 K8)", () => {
  it("public_entry_strips_client_ip_header", async () => {
    // 小文字・大文字・同名を 2 つ。どれでも鍵は cf-connecting-ip の値になる
    const variants: Array<[string, (h: Headers) => void]> = [
      ["lower", (h) => h.set(CLIENT_IP_HEADER, "203.0.113.1")],
      ["upper", (h) => h.set("X-WTT-Client-IP", "203.0.113.2")],
      ["twice", (h) => (h.append(CLIENT_IP_HEADER, "203.0.113.3"), h.append("X-WTT-Client-IP", "203.0.113.4"))],
    ];
    for (const [name, add] of variants) {
      const rec = recordingLimiter();
      const h = new Headers({ "cf-connecting-ip": "198.19.0.1" });
      add(h);
      await viaPublic(post(h), rec.env);
      expect(rec.keys, name).toEqual([`${ROUTE}:198.19.0.1`]);
    }
  });

  it("control_bff_keys_rate_limit_by_client_ip", async () => {
    const rec = recordingLimiter();
    for (const ip of ["203.0.113.10", "203.0.113.11"]) {
      await viaBff(post({ "cf-connecting-ip": "198.19.0.1", [CLIENT_IP_HEADER]: ip }), rec.env);
    }
    expect(rec.keys).toEqual([`${ROUTE}:203.0.113.10`, `${ROUTE}:203.0.113.11`]);
  });

  it("ControlBff falls back to cf-connecting-ip, then unknown, when the header is absent", async () => {
    const rec = recordingLimiter();
    await viaBff(post({ "cf-connecting-ip": "198.19.0.2" }), rec.env);
    await viaBff(post({}), rec.env);
    expect(rec.keys).toEqual([`${ROUTE}:198.19.0.2`, `${ROUTE}:unknown`]);
  });

  it("the version guard (426) applies through ControlBff", async () => {
    // 版 0(形に合わない名乗り)は最低の版より古い。認証より前に判定される
    const res = await viaBff(post({ [CLIENT_VERSION_HEADER]: "abc" }, "/workspaces", { name: "x" }), testEnv);
    expect(res.status).toBe(426);
    expect((await json(res)).error).toBe("client_too_old");
  });

  it("the write freeze (503) applies through ControlBff", async () => {
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\"}', 1)").run();
    const res = await viaBff(post({}, "/workspaces", { name: "x" }), testEnv);
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("write_frozen");
  });
});

/** すべて断り、渡った鍵を並べる limiter(枠を使い切った状態) */
function denyingLimiter() {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as Env["AUTH_RATE_LIMITER"];
  return { keys, env: { ...testEnv, AUTH_RATE_LIMITER: limiter } as Env };
}
const signOut = (headers: Record<string, string>, path = "/auth/sign-out") =>
  post({ "content-type": "application/json", ...headers }, path, {});

describe("sign-out is counted only on the public entry (Q528)", () => {
  it("ControlBff sign-out is not counted and revokes the session even when the limit is used up", async () => {
    const owner = await setupOwner();
    const rec = denyingLimiter();
    const res = await viaBff(signOut({ authorization: `Bearer ${owner.token}`, origin: testEnv.AB_ADMIN_URL, [CLIENT_IP_HEADER]: "203.0.113.20" }), rec.env);
    expect(res.status).toBe(200);
    expect(rec.keys).toEqual([]);
    // 失効したので、同じトークンではもう入れない
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(401);
  });

  it("ControlBff still counts the other unauthenticated routes", async () => {
    const rec = denyingLimiter();
    const res = await viaBff(post({ [CLIENT_IP_HEADER]: "203.0.113.21" }, "/auth/sign-in/email", { email: "x@example.com", password: "x" }), rec.env);
    expect(res.status).toBe(429);
    expect(rec.keys).toEqual(["/auth/sign-in/email:203.0.113.21"]);
  });

  it("the public entry counts sign-out whatever headers the sender adds", async () => {
    // binding 経由の見分けはヘッダーではないので、外から何を足しても公開の入口の sign-out は数える
    const forged: Record<string, string>[] = [
      {},
      { [CLIENT_IP_HEADER]: "203.0.113.22" },
      { "x-wtt-via-bff": "1", "x-wtt-bff": "1", "cf-worker": "admin.example", "x-forwarded-for": "127.0.0.1" },
      { origin: testEnv.AB_ADMIN_URL, "sec-fetch-site": "same-origin", "x-wtt-client-version": "7" },
    ];
    for (const headers of forged) {
      const rec = denyingLimiter();
      const res = await viaPublic(signOut({ "cf-connecting-ip": "198.19.0.9", ...headers }), rec.env);
      expect(res.status, JSON.stringify(headers)).toBe(429);
      expect(rec.keys, JSON.stringify(headers)).toEqual(["/auth/sign-out:198.19.0.9"]);
    }
    // エンコードした別名も同じ枠
    const rec = denyingLimiter();
    expect((await viaPublic(signOut({ "cf-connecting-ip": "198.19.0.9" }, "/auth/sign-%6fut"), rec.env)).status).toBe(429);
  });

  it("a sign-out handed to the app directly (not through ControlBff) is counted", async () => {
    const rec = denyingLimiter();
    const ctx = createExecutionContext();
    const res = await app.fetch(signOut({ [CLIENT_IP_HEADER]: "203.0.113.23" }), rec.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(rec.keys).toEqual(["/auth/sign-out:203.0.113.23"]);
  });
});
