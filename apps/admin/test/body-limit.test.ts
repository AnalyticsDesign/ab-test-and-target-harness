import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSON_BODY_MAX_BYTES } from "@wtt/core";
import { BFF_DECLARED_BODY_CEILING_BYTES } from "@/lib/body-limit";

/**
 * B154(security triage v2 G33): BFF と session のルートは、大きな本文を丸ごと読まずに 413 で断る。
 * Node の Request は文字列の本文に content-length を付けないので、Content-Length がある場合は明示的に付けて試す
 */

let jar = { get: (_: string) => undefined as { value: string } | undefined, set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => new Headers() }));
vi.mock("@/lib/control-binding", () => ({ controlBinding: async () => null }));

const { POST, PUT } = await import("@/app/api/control/[...path]/route");
const { POST: login } = await import("@/app/api/session/login/route");
const { POST: setup } = await import("@/app/api/session/setup/route");
const { POST: acceptInvite } = await import("@/app/api/session/accept-invite/route");
const { readBodyLimited } = await import("@/lib/body-limit");

const ORIGIN = "http://admin.test";
const MiB = 1024 * 1024;
let fetchMock: ReturnType<typeof vi.fn>;
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

/** 読まれたかを数えるストリーム。chunk を n 回まで出す(highWaterMark 0 = 読まれるまで pull しない) */
function counted(chunk: Uint8Array, n: number) {
  const state = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        state.pulls++;
        if (state.pulls > n) return c.close();
        c.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}
const req = (path: string, body: BodyInit, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);

beforeEach(() => {
  jar = { get: () => undefined, set: vi.fn(), delete: vi.fn() };
  fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function expect413(res: Response) {
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ error: "payload_too_large" });
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("BFF /api/control/* body limit", () => {
  it("refuses a declared body above the 100 MiB ceiling without reading it", async () => {
    const { stream, state } = counted(new Uint8Array(16), 1);
    await expect413(await POST(req("/api/control/workspaces", stream, { "content-length": String(BFF_DECLARED_BODY_CEILING_BYTES + 1) }), params(["workspaces"])));
    expect(state.pulls).toBe(0);
  });

  it("a declared body under the ceiling is streamed whatever the route (control applies the route's limit)", async () => {
    for (const path of [["workspaces"], ["sites", "s1", "assets"]]) {
      fetchMock.mockClear();
      const { stream, state } = counted(new Uint8Array(16), 1);
      const res = await POST(req(`/api/control/${path.join("/")}`, stream, { "content-length": String(50 * MiB) }), params(path));
      expect(res.status, path.join("/")).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeInstanceOf(ReadableStream);
      expect(state.pulls).toBe(0);
    }
  });

  it("stops reading a chunked body once it passes 1 MiB, on every route", async () => {
    for (const [method, path] of [
      ["POST", ["workspaces"]],
      ["POST", ["sites", "s1", "assets"]],
      ["PUT", ["sites", "s1", "experiments", "e1", "variants", "b", "changes"]],
    ] as const) {
      fetchMock.mockClear();
      const { stream, state } = counted(new Uint8Array(256 * 1024), 100); // 25MB まで出せるストリーム
      const handler = method === "PUT" ? PUT : POST;
      await expect413(await handler(req(`/api/control/${path.join("/")}`, stream, {}, method), params([...path])));
      expect(state.pulls, path.join("/")).toBeLessThan(10);
    }
  });

  it("a stream that fails while being read is 400, not 413", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection reset")); } }, { highWaterMark: 0 });
    const res = await POST(req("/api/control/workspaces", broken), params(["workspaces"]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unauthenticated password reset (no session cookie) is still forwarded", async () => {
    const body = JSON.stringify({ token: "t", newPassword: "password123" });
    const res = await POST(req("/api/control/auth/reset-password", body), params(["auth", "reset-password"]));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://control.test/auth/reset-password");
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(body);
  });

  it("with content-length within the limit, the body is streamed to control with duplex: half and the same content-length", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const res = await POST(req("/api/control/sites/s1/publish", bytes, { "content-length": String(bytes.byteLength) }), params(["sites", "s1", "publish"]));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }];
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe("half");
    expect(new Headers(init.headers).get("content-length")).toBe(String(bytes.byteLength));
    // 本物の Node の Request に組めること(duplex が無いと TypeError)と、中身がそのまま届くこと
    expect(await new Request(url, init).text()).toBe('{"a":1}');
  });

  it("a chunked body within 1 MiB is forwarded as bytes", async () => {
    const big = new Uint8Array(JSON_BODY_MAX_BYTES);
    const res = await PUT(req("/api/control/sites/s1/experiments/e1/variants/b/changes", big, {}, "PUT"), params(["sites", "s1", "experiments", "e1", "variants", "b", "changes"]));
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as Uint8Array).byteLength).toBe(JSON_BODY_MAX_BYTES);
  });
});

describe("session routes read at most 16KB", () => {
  const big = JSON.stringify({ email: "a@example.com", password: "x".repeat(20 * 1024), name: "x", id: "inv1", setupToken: "t" });
  for (const [name, fn, path] of [
    ["login", login, "/api/session/login"],
    ["setup", setup, "/api/session/setup"],
    ["accept-invite", acceptInvite, "/api/session/accept-invite"],
  ] as const) {
    it(`${name}: an oversized body is 413 and control is not called`, async () => {
      await expect413(await fn(req(path, big)));
    });
    it(`${name}: a declared oversized body is not read`, async () => {
      const { stream, state } = counted(new Uint8Array(16), 1);
      await expect413(await fn(req(path, stream, { "content-length": String(17 * 1024) })));
      expect(state.pulls).toBe(0);
    });
  }
  it("login: a stream that fails while being read is treated as an empty body", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("connection reset")); } }, { highWaterMark: 0 });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_credentials", message: "x" }, { status: 401 }));
    const res = await login(req("/api/session/login", broken));
    expect(res.status).toBe(401);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("{}");
  });
  it("a normal login body is still forwarded", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "set-auth-token": "tok" } }));
    const res = await login(req("/api/session/login", JSON.stringify({ email: "a@example.com", password: "password123" })));
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@example.com", password: "password123" });
  });
});

describe("readBodyLimited", () => {
  it("treats a malformed content-length as absent and counts instead", async () => {
    const r = await readBodyLimited(new Request(ORIGIN, { method: "POST", body: "abcd", headers: { "content-length": "4x" } }), 3);
    expect(r.ok).toBe(false);
  });
  it("returns the bytes when within the limit", async () => {
    const r = await readBodyLimited(new Request(ORIGIN, { method: "POST", body: "abc" }), 3);
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe("abc");
  });
});
