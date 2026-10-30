import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { kvKeys } from "@wtt/core";
import app from "../src/index";
import { handleCheck } from "../src/check";
import { __resetEdgeCaches } from "../src/store";
import type { Env } from "../src/env";

// B139 §4.2: GET /__ab/ping|decision|event は導入の確認(meta:install の SHA-256)。Cookie・サイト設定には触れず、B158 の門(POST のみ)の外
const MARKER = "install-marker-value";
const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

async function get(path: string, init: { host?: string; headers?: Record<string, string>; envOverride?: Partial<Env> } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://${init.host ?? "any.example"}${path}`, { method: "GET", headers: init.headers }),
    { ...env, ...init.envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  __resetEdgeCaches();
  await env.CONFIG_KV.delete(kvKeys.installMarker); // テスト間で KV が残るため、印が無い状態から始める
});

describe("GET /__ab/* install check (B139 §4.2)", () => {
  it("edge_answers_install_marker_on_get_for_decision_and_event", async () => {
    await env.CONFIG_KV.put(kvKeys.installMarker, MARKER);
    const expected = await sha256Hex(MARKER);
    for (const path of ["/__ab/ping", "/__ab/decision", "/__ab/event"]) {
      // Sec-Fetch-Site も Content-Type も付けない要求で通る。登録されていないホストでも同じ
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.json()).toEqual({ edge: "wtt", install: expected });
    }
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does_not_read_cookie_or_site_settings_and_sets_no_cookie", async () => {
    await env.CONFIG_KV.put(kvKeys.installMarker, MARKER);
    const keys: string[] = [];
    const CONFIG_KV = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "get") return typeof v === "function" ? v.bind(t) : v;
        return (key: string, ...rest: unknown[]) => { keys.push(key); return (v as (...a: unknown[]) => unknown).call(t, key, ...rest); };
      },
    }) as Env["CONFIG_KV"];
    const res = await get("/__ab/ping", { headers: { Cookie: `_ab_vid=${"A".repeat(22)}`, "Sec-Fetch-Site": "cross-site" }, envOverride: { CONFIG_KV } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(keys).toEqual([kvKeys.installMarker]); // 読むのは印だけ(設定・host の対応は読まない)
  });

  it("check_returns_503_without_install_marker", async () => {
    const res = await handleCheck(env);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).not.toContain("wtt");
    // ルート経由でも 503
    expect((await get("/__ab/ping")).status).toBe(503);
  });

  it("the_install_value_changes_with_the_marker", async () => {
    await env.CONFIG_KV.put(kvKeys.installMarker, "one");
    const a = (await (await get("/__ab/ping")).json()) as { install: string };
    await env.CONFIG_KV.put(kvKeys.installMarker, "two");
    const b = (await (await get("/__ab/ping")).json()) as { install: string };
    expect(a.install).not.toBe(b.install);
  });
});
