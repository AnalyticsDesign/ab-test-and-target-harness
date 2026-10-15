import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import app from "../src/index";

describe("edge scaffold", () => {
  it("serves root and has a working KV binding", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request("https://edge.example/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("wtt-edge");
    await env.CONFIG_KV.put("smoke", "ok");
    expect(await env.CONFIG_KV.get("smoke")).toBe("ok");
  });

  it("edge_does_not_serve_bootstrap", async () => {
    // 決定 52: /s/* は配信専用の Worker の静的アセット。edge は受けず、KV も読まない
    const spy = vi.spyOn(env.CONFIG_KV, "get");
    for (const p of ["/s/site_demo.js", "/s/preview/abc.js"]) {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`https://edge.example${p}`), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
