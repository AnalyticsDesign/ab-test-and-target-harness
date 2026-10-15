import { describe, expect, it } from "vitest";
import { CfApiError, deployAssets, type CfApiConfig } from "../src/cf-api";

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** 応答を順に返す偽の fetch。リクエストの中身を控える */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const ct = req.headers.get("content-type") ?? "";
    const body = ct.startsWith("application/json") ? await req.json() : ct.startsWith("multipart/form-data") ? await req.formData() : null;
    calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body });
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const cfg = (fetchFn: typeof fetch): CfApiConfig => ({ accountId: "acc", token: "tok", scriptName: "wtt-static", apiBase: "https://api.test/client/v4", fetchFn });
const input = {
  manifest: { "/s/a.js": { hash: "h_a", size: 3 }, "/s/b.js": { hash: "h_b", size: 4 } },
  contentOf: async (h: string) => (h === "h_a" ? "YWFh" : "YmJiYg=="),
  headersFile: "/s/*\n  X-Test: 1\n",
  scriptSource: "export default {}",
  compatibilityDate: "2026-08-01",
};

describe("deployAssets", () => {
  it("準備 → バケットごとのアップロード → スクリプトの登録 の順に呼び、完了の印をスクリプトに渡す", async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: { jwt: "session-jwt", buckets: [["h_a"], ["h_b"]] } } },
      { status: 202, body: { success: true, result: {} } },
      { status: 201, body: { success: true, result: { jwt: "done-jwt" } } },
      { status: 200, body: { success: true, result: { id: "wtt-static" } } },
    ]);
    const out = await deployAssets(cfg(f.fn), input);
    expect(out).toEqual({ uploadedFiles: 2, buckets: 2, apiCalls: 4 });
    expect(f.calls[0]).toMatchObject({ method: "POST", url: "https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static/assets-upload-session", auth: "Bearer tok", body: { manifest: input.manifest } });
    expect(f.calls[1]).toMatchObject({ method: "POST", url: "https://api.test/client/v4/accounts/acc/workers/assets/upload?base64=true", auth: "Bearer session-jwt" });
    expect(await ((f.calls[1]!.body as FormData).get("h_a") as File).text()).toBe("YWFh");
    expect(f.calls[3]).toMatchObject({ method: "PUT", url: "https://api.test/client/v4/accounts/acc/workers/scripts/wtt-static", auth: "Bearer tok" });
    const form = f.calls[3]!.body as FormData;
    const meta = JSON.parse(await (form.get("metadata") as File).text());
    expect(meta).toEqual({ main_module: "index.js", compatibility_date: "2026-08-01", assets: { jwt: "done-jwt", config: { _headers: input.headersFile } } });
    expect(await (form.get("index.js") as File).text()).toBe("export default {}");
  });

  it("バケットが空(全ファイルがアップロード済み)なら準備の jwt をそのまま完了の印にする", async () => {
    const f = fakeFetch([
      { status: 200, body: { success: true, result: { jwt: "session-jwt", buckets: [] } } },
      { status: 200, body: { success: true, result: {} } },
    ]);
    expect(await deployAssets(cfg(f.fn), input)).toEqual({ uploadedFiles: 0, buckets: 0, apiCalls: 2 });
    const meta = JSON.parse(await ((f.calls[1]!.body as FormData).get("metadata") as File).text());
    expect(meta.assets.jwt).toBe("session-jwt");
  });

  it("失敗は CfApiError(段階・HTTP の状態・エラーコード)。トークンは message に出さない", async () => {
    const f = fakeFetch([{ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }]);
    const err = await deployAssets(cfg(f.fn), input).catch((e) => e);
    expect(err).toBeInstanceOf(CfApiError);
    expect(err).toMatchObject({ step: "upload_session", status: 403, codes: [10000] });
    expect(String(err.message)).not.toContain("tok");
  });

  it("success: false は HTTP 200 でも失敗にする", async () => {
    const f = fakeFetch([{ status: 200, body: { success: false, errors: [{ code: 7003, message: "x" }] } }]);
    await expect(deployAssets(cfg(f.fn), input)).rejects.toMatchObject({ step: "upload_session", codes: [7003] });
  });
});
