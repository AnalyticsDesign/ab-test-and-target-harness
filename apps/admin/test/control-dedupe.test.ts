import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";

/**
 * admin speed C: ページの描画中の同じ control への GET を 1 回にまとめる(lib/control-dedupe.ts)。
 * vinext の要求の文脈を作って、ページの描画中(isFetchDedupeActive)・Route Handler(文脈はあるが描画中でない)・範囲の外を再現する
 */

let token = "t1";
let reqHeaders = new Headers();
let binding: { fetch: ReturnType<typeof vi.fn> };

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "wtt_session" && token ? { value: token } : undefined) }),
  headers: async () => reqHeaders,
}));
vi.mock("@/lib/control-binding", () => ({ controlBinding: async () => binding }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

const { controlFetch, controlRequest } = await import("@/lib/control");

/** ページの描画中(vinext が自分の fetch をまとめている範囲) */
const inRender = <T>(fn: () => Promise<T>) => runWithRequestContext(createRequestContext({ isFetchDedupeActive: true }), fn);
/** Route Handler(要求の文脈はあるが、vinext は fetch をまとめていない) */
const inRouteHandler = <T>(fn: () => Promise<T>) => runWithRequestContext(createRequestContext(), fn);

const sentPaths = () => binding.fetch.mock.calls.map(([req]) => `${(req as Request).method} ${new URL((req as Request).url).pathname}`);

beforeEach(() => {
  token = "t1";
  // host が手元 = http の Cookie の名前(wtt_session)を読む
  reqHeaders = new Headers({ host: "localhost:3000", "cf-connecting-ip": "203.0.113.1" });
  binding = { fetch: vi.fn(async (req: Request) => Response.json({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), items: [1, 2] })) };
});

describe("ページの描画中の同じ GET は 1 回にまとめる(admin speed C)", () => {
  it("同じ要求の中の同じ GET 2 回 → binding に 1 回。どちらも同じ値を受け取る", async () => {
    const [a, b] = await inRender(async () => [await controlFetch<{ path: string }>("/me"), await controlFetch<{ path: string }>("/me")]);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ status: 200, data: { path: "/me", auth: "Bearer t1", items: [1, 2] } });
    expect(b).toEqual(a);
  });

  it("並行した同じ GET も 1 回(Promise を覚える)", async () => {
    await inRender(() => Promise.all([controlFetch("/me"), controlFetch("/me"), controlFetch("/me")]));
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("呼び出し元が結果を書き換えても、ほかの呼び出し元には漏れない(応答は呼び出し元ごとに clone)", async () => {
    const second = await inRender(async () => {
      const first = await controlFetch<{ items: number[] }>("/me");
      first.data.items.push(99);
      return controlFetch<{ items: number[] }>("/me");
    });
    expect(second.data.items).toEqual([1, 2]);
  });

  it("パスが違えば別に送る(query も鍵に入る)", async () => {
    await inRender(() => Promise.all([controlFetch("/me"), controlFetch("/workspaces"), controlFetch("/me?x=1")]));
    expect(binding.fetch).toHaveBeenCalledTimes(3);
  });

  it("セッションの token が違えば 2 回(利用者をまたいで値を返さない)", async () => {
    await inRender(async () => {
      await controlFetch("/me");
      token = "t2";
      const r = await controlFetch<{ auth: string }>("/me");
      expect(r.data.auth).toBe("Bearer t2");
    });
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("接続元 IP・名乗る版が違えば 2 回", async () => {
    await inRender(async () => {
      await controlRequest("/me", { clientIp: "203.0.113.1" });
      await controlRequest("/me", { clientIp: "203.0.113.2" });
      await controlRequest("/me", { clientIp: "203.0.113.1", clientVersion: 0 });
    });
    expect(binding.fetch).toHaveBeenCalledTimes(3);
  });

  it("POST はまとめない", async () => {
    await inRender(() => Promise.all([controlFetch("/x", { method: "POST", body: "{}" }), controlFetch("/x", { method: "POST", body: "{}" })]));
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("書き込みの後の読み直しは送り直す(その要求の覚えを捨てる)", async () => {
    await inRender(async () => {
      await controlFetch("/me");
      await controlFetch("/me", { method: "PATCH", body: "{}" });
      await controlFetch("/me");
      await controlFetch("/me");
    });
    expect(sentPaths()).toEqual(["GET /me", "PATCH /me", "GET /me"]);
  });

  it("書き込みの最中に始まった GET の覚えも、書き込みの後には使わない", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    binding.fetch.mockImplementation(async (req: Request) => {
      if (req.method === "PATCH") await gate;
      return Response.json({ method: req.method });
    });
    await inRender(async () => {
      const write = controlFetch("/me", { method: "PATCH", body: "{}" });
      const during = controlFetch("/me");
      // GET が binding に届く(= 覚えに入る)まで待ってから、書き込みを終わらせる
      await vi.waitFor(() => expect(binding.fetch).toHaveBeenCalledTimes(2));
      release();
      await Promise.all([write, during]);
      await controlFetch("/me");
    });
    expect(sentPaths()).toEqual(["PATCH /me", "GET /me", "GET /me"]);
  });

  it("signal などが付いた GET は素通し", async () => {
    await inRender(async () => {
      await controlRequest("/me", { signal: new AbortController().signal });
      await controlRequest("/me", { signal: new AbortController().signal });
    });
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("届かなかった null と 5xx は、その要求の中では使い回す", async () => {
    binding.fetch.mockRejectedValue(new Error("down"));
    const results = await inRender(async () => [await controlFetch("/me"), await controlFetch("/me")]);
    expect(results).toEqual([{ status: 502, data: null }, { status: 502, data: null }]);
    expect(binding.fetch).toHaveBeenCalledTimes(1);

    binding.fetch.mockReset();
    binding.fetch.mockImplementation(async () => Response.json({ error: "x" }, { status: 503 }));
    const r = await inRender(async () => [await controlFetch("/me"), await controlFetch("/me")]);
    expect(r.map((x) => x.status)).toEqual([503, 503]);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("3 つの呼び出し元が全部本文を読め、届いた応答の本文は読み切ってある(読まれない枝を残さない)", async () => {
    const originals: Response[] = [];
    binding.fetch.mockImplementation(async () => {
      const res = Response.json({ items: [1, 2] }, { status: 201, statusText: "Made", headers: { "x-a": "1" } });
      originals.push(res);
      return res;
    });
    const got = await inRender(() => Promise.all([1, 2, 3].map(() => controlRequest("/me"))));
    expect(originals).toHaveLength(1);
    // clone で返す形なら、覚えた元は読まれないまま(bodyUsed が false)残る
    expect(originals[0]!.bodyUsed).toBe(true);
    for (const res of got) {
      expect(res).not.toBe(originals[0]);
      expect([res!.status, res!.statusText, res!.headers.get("x-a")]).toEqual([201, "Made", "1"]);
      expect(await res!.json()).toEqual({ items: [1, 2] });
    }
  });

  it("本文を持てない応答(204)もまとめて返せる", async () => {
    binding.fetch.mockImplementation(async () => new Response(null, { status: 204 }));
    const got = await inRender(() => Promise.all([controlRequest("/me"), controlRequest("/me")]));
    expect(got.map((r) => r?.status)).toEqual([204, 204]);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("本文を読む途中で壊れたら、届かなかったのと同じ null", async () => {
    binding.fetch.mockImplementation(
      async () => new Response(new ReadableStream({ pull: (c) => c.error(new Error("broken")) }), { status: 200 }),
    );
    const got = await inRender(() => Promise.all([controlRequest("/me"), controlRequest("/me")]));
    expect(got).toEqual([null, null]);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("要求をまたいでは覚えない", async () => {
    await inRender(() => controlFetch("/me"));
    await inRender(() => controlFetch("/me"));
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("Route Handler(描画中でない要求の文脈)では素通し", async () => {
    await inRouteHandler(async () => {
      await controlFetch("/me");
      await controlFetch("/me");
    });
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it("要求の範囲の外では素通し", async () => {
    await controlFetch("/me");
    await controlFetch("/me");
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });
});
