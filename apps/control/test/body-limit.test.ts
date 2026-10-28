import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/env";
import {
  BREAK_GLASS,
  BREAK_GLASS_PASSWORD,
  call,
  createExperiment,
  createSite,
  expectEnvelope,
  inviteAndJoin,
  joinWithPassword,
  json,
  nextTestIp,
  setupOwner,
  testEnv,
} from "./helpers";

/**
 * B154(security triage v2 の G19・G17): 本文の上限と、回数の上限の分類。
 * テストの Request は文字列の本文に content-length を付けない(= bodyLimit は数えながら読む側を通る)ので、
 * content-length がある経路を試すときは明示的に付ける
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MiB = 1024 * 1024;

async function send(req: Request, e: Env = testEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(req, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** 読まれたかを記録するストリーム。pull が呼ばれたら read = true(highWaterMark 0 = 読まれるまで pull しない) */
function trackedStream(bytes: Uint8Array): { stream: ReadableStream<Uint8Array>; state: { read: boolean } } {
  const state = { read: false };
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.read = true;
      if (sent) return controller.close();
      sent = true;
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 }); // 既定の 1 だと作った時点で pull が 1 回呼ばれる
  return { stream, state };
}

async function multipart(bytes: Uint8Array, experimentId: string): Promise<{ body: Uint8Array; contentType: string }> {
  const fd = new FormData();
  fd.set("file", new File([bytes], "a.png", { type: "image/png" }));
  fd.set("experimentId", experimentId);
  const r = new Response(fd);
  return { body: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type")! };
}

/** 常に断る limiter(429 になるかだけを見る) */
const denyAll = { ...testEnv, AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } as unknown as Env["AUTH_RATE_LIMITER"] } as Env;

describe("rate limit classification uses the decoded path (G17)", () => {
  for (const path of ["/s%65tup", "/break-glass/res%65t-link", "/auth/handoff/%65xchange", "/invit%61tions/inv_x/accept"]) {
    it(`percent-encoded alias ${path} is rate limited`, async () => {
      const res = await send(
        new Request(`http://control.test${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextTestIp() }, body: "{}" }),
        denyAll,
      );
      expect(res.status).toBe(429);
      expect((await expectEnvelope(res)).error).toBe("rate_limited");
    });
  }
  it("percent-encoded alias of the Google start GET is rate limited", async () => {
    const res = await send(new Request("http://control.test/auth/google/st%61rt", { headers: { "cf-connecting-ip": nextTestIp() } }), denyAll);
    expect(res.status).toBe(429);
  });
});

describe("request body limit (G19)", () => {
  const big = "x".repeat(2 * MiB);

  for (const [path, envOverride] of [
    ["/break-glass/reset-link", BREAK_GLASS],
    ["/auth/handoff/exchange", {}],
  ] as const) {
    it(`unauthenticated ${path} refuses an oversized body with 413 (no content-length)`, async () => {
      const res = await call("POST", path, { raw: JSON.stringify({ token: big }), headers: { "content-type": "application/json" }, envOverride });
      expect(res.status).toBe(413);
      const body = await expectEnvelope(res);
      expect(body.error).toBe("payload_too_large");
      expect(typeof body.hint).toBe("string");
    });
    it(`unauthenticated ${path} refuses by content-length without reading the body`, async () => {
      const { stream, state } = trackedStream(new TextEncoder().encode("{}"));
      const res = await send(
        new Request(`http://control.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(2 * MiB), "cf-connecting-ip": nextTestIp() },
          body: stream,
          // @ts-expect-error workerd の RequestInit には duplex が無いが、Node 互換のため付けても害は無い
          duplex: "half",
        }),
        { ...testEnv, ...envOverride } as Env,
      );
      expect(res.status).toBe(413);
      expect(state.read).toBe(false);
    });
  }

  it("a JSON route under the default limit still works, an oversized one is 413", async () => {
    const owner = await setupOwner();
    const ok = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "S", domain: "s.example.com" } });
    expect(ok.status).toBe(201);
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: big, domain: "s.example.com" } });
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe("payload_too_large");
  });

  it("/auth/* still reads a normal body after the limiter re-wraps the stream", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    // 本文に content-length が無い(= bodyLimit が c.req.raw を数えたストリームに差し替える)要求でも、Better Auth が本文を読めること
    const res = await call("POST", "/auth/sign-in/email", {
      body: { email: pw.email, password: BREAK_GLASS_PASSWORD },
      headers: { origin: "http://localhost:3000" },
      envOverride: BREAK_GLASS,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-token")).toBeTruthy();
  });

  it("the full replacement of changes is allowed beyond the default limit", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    // 1 件 64KB 近くの変更を 20 件 = 約 1.3MB(既定の上限を超えるが、この経路の上限の中)
    const changes = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, type: "TEXT", selector: ".x", payload: { text: "x".repeat(65000) } }));
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: changes });
    expect(res.status).toBe(200);
  });
});

describe("full replacement of changes (review r1)", () => {
  /** JSON.stringify の後に、非 ASCII を `\uXXXX` にする(Python の json.dumps の既定 ensure_ascii と同じ形) */
  const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  /** 保存できる最大の TEXT: JSON.stringify(payload) が 64KB(65536 B)以内に収まる「あ」の数 */
  const MAX_A = Math.floor((65536 - '{"text":""}'.length) / 3);
  const changes = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, type: "TEXT", selector: ".x", payload: { text: "あ".repeat(n) } }));
  const setup = async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    return { owner, path: `/sites/${sid}/experiments/${eid}/variants/b/changes` };
  };

  it("the largest storable content is accepted both as UTF-8 and as \\u escapes", async () => {
    const { owner, path } = await setup();
    for (const [label, raw] of [
      ["utf-8", JSON.stringify(changes(MAX_A))],
      ["\\u escapes", asciiJson(changes(MAX_A))],
      ["\\u escapes, 21,000 chars", asciiJson(changes(21000))],
    ] as const) {
      const res = await call("PUT", path, { token: owner.token, raw, headers: { "content-type": "application/json" } });
      expect(res.status, `${label}: ${new TextEncoder().encode(raw).byteLength} B`).toBe(200);
    }
  }, 60_000);

  it("an unauthenticated chunked body is refused without reading it", async () => {
    const { path } = await setup();
    const { stream, state } = trackedStream(new Uint8Array(1024));
    const res = await send(
      new Request(`http://control.test${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error workerd の RequestInit には duplex が無い
        duplex: "half",
      }),
    );
    expect(res.status).toBe(401);
    expect(state.read).toBe(false);
  });

  it("beyond the route limit is 413 by content-length", async () => {
    const { owner, path } = await setup();
    const { stream, state } = trackedStream(new TextEncoder().encode("[]"));
    const res = await send(
      new Request(`http://control.test${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": String(20 * MiB), authorization: `Bearer ${owner.token}`, "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe("payload_too_large");
    expect(state.read).toBe(false);
  });
});

describe("a malformed content-length is 400 (review r1)", () => {
  it("refuses a non-numeric content-length before reading the body", async () => {
    const { stream, state } = trackedStream(new TextEncoder().encode("{}"));
    const res = await send(
      new Request("http://control.test/break-glass/reset-link", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "12abc", "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
      { ...testEnv, ...BREAK_GLASS } as Env,
    );
    expect(res.status).toBe(400);
    expect((await expectEnvelope(res)).error).toBe("bad_request");
    expect(state.read).toBe(false);
  });
});

describe("asset upload checks access before reading the body (G19 (a))", () => {
  it("a viewer gets 403 and the body is never read", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const { body, contentType } = await multipart(PNG, eid);
    const { stream, state } = trackedStream(body);
    const res = await send(
      new Request(`http://control.test/sites/${sid}/assets`, {
        method: "POST",
        headers: { "content-type": contentType, "content-length": String(body.byteLength), authorization: `Bearer ${viewer.token}`, "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
    );
    expect(res.status).toBe(403);
    expect(state.read).toBe(false);
  });

  it("an unauthenticated chunked upload is refused without reading the body", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { stream, state } = trackedStream(new Uint8Array(1024));
    const res = await send(
      new Request(`http://control.test/sites/${sid}/assets`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
    );
    expect(res.status).toBe(401);
    expect(state.read).toBe(false);
  });

  it("uploads disabled (no R2) is 409 for an editor, without reading the body", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const { body, contentType } = await multipart(PNG, eid);
    const { stream, state } = trackedStream(body);
    const res = await send(
      new Request(`http://control.test/sites/${sid}/assets`, {
        method: "POST",
        headers: { "content-type": contentType, "content-length": String(body.byteLength), authorization: `Bearer ${owner.token}`, "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
      { ...testEnv, ASSETS: undefined } as Env,
    );
    expect(res.status).toBe(409);
    expect(state.read).toBe(false);
  });

  it("an upload above the default JSON limit but within the asset limit is accepted", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const img = new Uint8Array(2 * MiB);
    img.set(PNG);
    const { body, contentType } = await multipart(img, eid);
    const res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: body, headers: { "content-type": contentType } });
    expect(res.status).toBe(201);
    await env.ASSETS!.delete((await json<{ key: string }>(res)).key);
  });

  it("an upload far beyond the asset limit is 413 by content-length", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const { body, contentType } = await multipart(PNG, eid);
    const { stream, state } = trackedStream(body);
    const res = await send(
      new Request(`http://control.test/sites/${sid}/assets`, {
        method: "POST",
        headers: { "content-type": contentType, "content-length": String(50 * MiB), authorization: `Bearer ${owner.token}`, "cf-connecting-ip": nextTestIp() },
        body: stream,
        // @ts-expect-error 上と同じ
        duplex: "half",
      }),
      { ...testEnv, AB_ASSET_MAX_MB: "1" } as Env,
    );
    expect(res.status).toBe(413);
    // 画像の経路の 413 は、本文を読む前でも読んだ後でも asset_too_large にそろえる
    expect(await json(res)).toMatchObject({ error: "asset_too_large", maxMb: 1, size: 50 * MiB });
    expect(state.read).toBe(false);
  });

  it("a chunked upload beyond the asset limit is asset_too_large too", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const img = new Uint8Array(3 * MiB);
    img.set(PNG);
    const { body, contentType } = await multipart(img, eid);
    const res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: body, headers: { "content-type": contentType }, envOverride: { AB_ASSET_MAX_MB: "1" } });
    expect(res.status).toBe(413);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_too_large", maxMb: 1 });
  });
});
