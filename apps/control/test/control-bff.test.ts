// apps/control/test/control-bff.test.ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENT_IP_HEADER, CLIENT_VERSION_HEADER } from "@wtt/core";
import worker, { ControlBff } from "../src/index";
import { stripTrustedHeaders } from "../src/trusted-headers";
import type { Env } from "../src/env";
import { json, testEnv } from "./helpers";

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
