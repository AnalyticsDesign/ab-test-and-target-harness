import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { alignToWindow, AUTH_RATE_LIMIT, BREAK_GLASS, beforeD1Batch, call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, setupOwner } from "./helpers";

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

    // 4 つ目 = 期待する reason(B155 Q7: 同じ error のまま reason で分ける)
    const cases: Array<[number, string, () => Promise<Response>, string?]> = [
      // validator("json", …) が JSON として読めない body に投げる HTTPException(400) を errorHandler が bad_request に写す。
      // **content-type が application/json のときだけ** hono の validator は body を読む(付いていなければ value = {} → 422)
      [400, "bad_request", () =>
        call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, raw: "{not json", headers: { "content-type": "application/json" } })],
      [401, "unauthorized", () => call("GET", "/me")],
      [403, "forbidden", () => call("POST", `/sites/${sid}/publish`, { token: viewer.token })],
      [404, "not_found", () => call("GET", "/sites/nope", { token: owner.token })],
      [409, "site_id_taken", () => call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: sid, name: "dup", domain: "dup.example.com" } })],
      // B155: 別のワークスペースで削除したサイトの ID。元のワークスペースを見られる人(ここではシステム管理者)にだけ reason を付ける
      [409, "site_id_taken", async () => {
        const other = (await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Other" } }))).id;
        await createSite(owner.token, other, { id: "site_retired_env" });
        expect((await call("DELETE", "/sites/site_retired_env", { token: owner.token })).status).toBe(204);
        return call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: "site_retired_env", name: "x", domain: "retired-env.example.com" } });
      }, "retired_elsewhere"],
      [413, "asset_too_large", () =>
        call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: imageForm(big, "image/png", eid), envOverride: { AB_ASSET_MAX_MB: "1" } })],
      [415, "unsupported_media_type", () => call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: imageForm(PNG, "text/html", eid) })],
      [422, "validation_failed", () =>
        call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: "Bad ID", name: "x", domain: "x.example.com" } })],
      // content-type 無しの壊れた body は validator が読まずに素通しするので、空 object として 422 になる(400 ではない)
      [422, "validation_failed", () => call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, raw: "{not json" })],
      // 無認証の POST 6 経路は経路ごとに IP 単位で 30 回 / 10 秒。31 回目が 429(枠の作り自体は auth.test.ts が固定する)
      [429, "rate_limited", async () => {
        // Rate Limiting binding の枠は period 秒ごとの壁時計固定枠(miniflare 実装)。境界をまたぐと数え直しになるので窓の頭から始める
        await alignToWindow({ fresh: true });
        let last!: Response;
        for (let i = 0; i < AUTH_RATE_LIMIT + 1; i++)
          last = await call("POST", "/invitations/inv_missing/accept", {
            body: { name: "x", password: "password123" },
            headers: { "cf-connecting-ip": "203.0.113.77" },
            envOverride: BREAK_GLASS, // 枠そのものを試すので、パスワード経路を開けた状態で 31 回叩く(決定 46 (2))
          });
        return last;
      }],
    ];

    for (const [status, code, fn, reason] of cases) {
      const res = await fn();
      expect(res.status, `status ${status} (${code})`).toBe(status);
      const body = await expectEnvelope(res);
      expect(body.error, `status ${status}`).toBe(code);
      expect(body.reason, `status ${status} (${code}): reason`).toBe(reason);
      expect((body.message as string).length, `status ${status}: message が空`).toBeGreaterThan(0);
      // message が機械可読な code そのままではないこと(Task 11: cookie_name_in_use / site_has_running_experiments 等で
      // hint はあるが message が無く、code がそのまま出ていた回帰の再発防止)
      expect(body.message, `status ${status} (${code}): message が code そのまま`).not.toBe(code);
    }
  }, 30_000); // 429 の窓の待ち(最大 10 秒)+ 31 回の試行

  it("retired_site_id_does_not_reveal_history_to_non_viewers", async () => {
    // B155 Q7: 元のワークスペースを見られない人への退役の 409 は、今あるサイトの 409 と id 以外すべて同じ(過去の利用も、元のワークスペースの存否も分からない)
    const owner = await setupOwner();
    const x = owner.workspaceId;
    const xAdmin = await inviteAndJoin(owner.token, x, "admin");
    const newWs = async (name: string) => (await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name } }))).id;
    const retire = async (wid: string, id: string) => {
      await createSite(owner.token, wid, { id });
      expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
    };
    const create = (id: string, db?: D1Database) =>
      call("POST", `/workspaces/${x}/sites`, { token: xAdmin.token, body: { id, name: "x", domain: `${id.replace(/_/g, "-")}.example.com` }, envOverride: db ? { DB: db } : undefined });
    const withoutId = (b: Record<string, unknown>) => JSON.stringify(Object.entries(b).filter(([k]) => k !== "id")); // キーの順も比べる

    await createSite(owner.token, x, { id: "site_live" });
    const liveRes = await create("site_live");
    expect(liveRes.status).toBe(409);
    const live = await expectEnvelope(liveRes);

    const kept = await newWs("Kept");
    const gone = await newWs("Gone");
    await retire(kept, "site_pre_kept"); // 事前の確かめで断る・元のワークスペースが残る
    await retire(gone, "site_pre_gone"); // 事前の確かめで断る・元のワークスペースが消えた
    expect((await call("DELETE", `/workspaces/${gone}`, { token: owner.token })).status).toBe(204);

    const cases: Array<[string, D1Database | undefined, () => boolean]> = [
      ["site_pre_kept", undefined, () => true],
      ["site_pre_gone", undefined, () => true],
    ];
    // 確かめの後の重なりで D1 のトリガーが断る(元のワークスペースが残る / 消えた)
    for (const [id, wid] of [["site_race_kept", kept], ["site_race_gone", "ws_gone"]] as const) {
      let ran = false;
      const db = beforeD1Batch(env.DB, async () => {
        ran = true;
        await env.DB.prepare("insert into retired_site_ids (id, workspace_id, retired_at) values (?, ?, ?)").bind(id, wid, Date.now()).run();
      });
      cases.push([id, db, () => ran]);
    }
    for (const [id, db, ran] of cases) {
      const res = await create(id, db);
      expect(res.status, id).toBe(409);
      const body = await expectEnvelope(res);
      expect(ran(), id).toBe(true);
      expect(body.id, id).toBe(id);
      expect(withoutId(body), id).toBe(withoutId(live));
    }
  });

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
