import { describe, expect, it } from "vitest";
import { BREAK_GLASS, call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, setupOwner } from "./helpers";

/**
 * 決定 34: 代表的な status ごとに `{ error, message }` の封筒を持つことを 1 箇所で固定する。
 * どの case も **実在のルートへの実リクエスト**で誘発する(`ApiError` を直接組み立てない)。
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
function imageForm(bytes: Uint8Array, type: string, experimentId: string): FormData {
  const fd = new FormData();
  fd.set("file", new File([bytes], "a.png", { type }));
  fd.set("experimentId", experimentId);
  return fd;
}

describe("error envelope contract", () => {
  it("every representative error status returns the envelope", async () => {
    const owner = await setupOwner();
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);

    const cases: Array<[number, string, () => Promise<Response>]> = [
      // validator("json", …) が JSON として読めない body に投げる HTTPException(400) を errorHandler が bad_request に写す。
      // **content-type が application/json のときだけ** hono の validator は body を読む(付いていなければ value = {} → 422)
      [400, "bad_request", () =>
        call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, raw: "{not json", headers: { "content-type": "application/json" } })],
      [401, "unauthorized", () => call("GET", "/me")],
      [403, "forbidden", () => call("POST", `/sites/${sid}/publish`, { token: viewer.token })],
      [404, "not_found", () => call("GET", "/sites/nope", { token: owner.token })],
      [409, "site_id_taken", () => call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: sid, name: "dup", domain: "dup.example.com" } })],
      [413, "asset_too_large", () =>
        call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: imageForm(big, "image/png", eid), envOverride: { AB_ASSET_MAX_MB: "1" } })],
      [415, "unsupported_media_type", () => call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: imageForm(PNG, "text/html", eid) })],
      [422, "validation_failed", () =>
        call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: "Bad ID", name: "x", domain: "x.example.com" } })],
      // content-type 無しの壊れた body は validator が読まずに素通しするので、空 object として 422 になる(400 ではない)
      [422, "validation_failed", () => call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, raw: "{not json" })],
      // 無認証の POST 6 経路は経路ごとに IP 単位で 10 回 / 10 秒。11 回目が 429(枠の作り自体は auth.test.ts が固定する)
      [429, "rate_limited", async () => {
        // Rate Limiting binding の枠は period 秒ごとの壁時計固定枠(miniflare 実装)。境界をまたぐと数え直しになる
        const PERIOD_MS = 10_000;
        const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);
        if (remaining < 5_000) await new Promise((r) => setTimeout(r, remaining + 50));
        let last!: Response;
        for (let i = 0; i < 11; i++)
          last = await call("POST", "/invitations/inv_missing/accept", {
            body: { name: "x", password: "password123" },
            headers: { "cf-connecting-ip": "203.0.113.77" },
            envOverride: BREAK_GLASS, // 枠そのものを試すので、パスワード経路を開けた状態で 11 回叩く(決定 46 (2))
          });
        return last;
      }],
    ];

    for (const [status, code, fn] of cases) {
      const res = await fn();
      expect(res.status, `status ${status} (${code})`).toBe(status);
      const body = await expectEnvelope(res);
      expect(body.error, `status ${status}`).toBe(code);
      expect((body.message as string).length, `status ${status}: message が空`).toBeGreaterThan(0);
      // message が機械可読な code そのままではないこと(Task 11: cookie_name_in_use / site_has_running_experiments 等で
      // hint はあるが message が無く、code がそのまま出ていた回帰の再発防止)
      expect(body.message, `status ${status} (${code}): message が code そのまま`).not.toBe(code);
    }
  }, 20_000); // 429 の枠の境界待ち(最大 5 秒)+ 11 回の試行

  it("validation failures carry a machine-readable path and issues", async () => {
    const owner = await setupOwner();
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "x", domain: "not a domain" } });
    expect(res.status).toBe(422);
    const body = await json<{ error: string; path: unknown[]; issues: Array<{ path: unknown[]; message: string }> }>(res);
    expect(body.error).toBe("validation_failed");
    expect(body.path).toEqual(["domain"]); // 封筒の path は string | number の配列(spec §13.5)
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
