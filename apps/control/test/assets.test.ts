import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment, expectEnvelope } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
function form(bytes: Uint8Array, type: string, experimentId: string, name = "a.png") {
  const fd = new FormData();
  fd.set("file", new File([bytes], name, { type }));
  fd.set("experimentId", experimentId);
  return fd;
}

/** ISO-BMFF コンテナの先頭 16 バイト(box size + `ftyp` + major brand + 予備) */
const isoBmff = (brand: string) =>
  new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand), 0, 0, 0, 0]);

describe("assets (spec §13.7)", () => {
  it("uploads an image to R2 under the site/experiment key and returns the public url", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await call("POST", `/sites/${sid}/assets`, { token: ed.token, raw: form(PNG, "image/png", eid) });
    expect(res.status).toBe(201);
    const a = await json<{ id: string; publicUrl: string; key: string; mime: string; size: number }>(res);
    expect(a.key).toMatch(new RegExp(`^sites/${sid}/experiments/${eid}/[a-z0-9_]+\\.png$`));
    expect(a.publicUrl).toBe(`http://localhost:8788/dev-assets/${a.key}`);
    expect(a).toMatchObject({ mime: "image/png", size: PNG.byteLength });
    expect(await env.ASSETS!.head(a.key)).not.toBeNull();
    const served = await call("GET", `/dev-assets/${a.key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // 一覧は VIEWER 以上
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const list = await json<Array<{ id: string; experimentId: string }>>(await call("GET", `/sites/${sid}/assets?experimentId=${eid}`, { token: v.token }));
    expect(list.map((x) => x.id)).toEqual([a.id]);
    expect((await json<unknown[]>(await call("GET", `/sites/${sid}/assets?experimentId=exp_other`, { token: v.token }))).length).toBe(0);
    // アップロードした URL は IMAGE Change として受理される(Task 5 の image_outside_r2_domain と対)
    expect(
      (
        await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
          token: ed.token,
          body: [{ id: "c_img", type: "IMAGE", selector: "img.hero", payload: { src: a.publicUrl } }],
        })
      ).status,
    ).toBe(200);
  });

  it("asset_upload_rejects_non_image_and_over_limit", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    // 宣言が image/* でも先頭バイトが画像でなければ拒否
    let res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(new TextEncoder().encode("<svg/>"), "image/png", eid, "x.png") });
    expect(res.status).toBe(415);
    expect((await json(res)).error).toBe("unsupported_media_type");
    // 先頭バイトが本物の PNG でも宣言が画像でなければ拒否
    res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(PNG, "text/html", eid, "x.html") });
    expect(res.status).toBe(415);
    await expectEnvelope(res);
    // SVG は script を含みうるので MVP では受けない
    res = await call("POST", `/sites/${sid}/assets`, {
      token: owner.token,
      raw: form(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", eid, "x.svg"),
    });
    expect(res.status).toBe(415);
    // AVIF は `ftyp` の後ろの brand まで見る。brand を見ないと MP4 / MOV / HEIC など
    // あらゆる ISO-BMFF コンテナが image/avif を名乗って R2 に入ってしまう
    res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(isoBmff("mp42"), "image/avif", eid, "x.avif") });
    expect(res.status).toBe(415);
    await expectEnvelope(res);
    // 上限(env AB_ASSET_MAX_MB)超過。テストでは 1MB に下げる
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(big, "image/png", eid), envOverride: { AB_ASSET_MAX_MB: "1" } });
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ error: "asset_too_large", maxMb: 1 });
    // 拒否された分は R2 にも D1 にも残らない
    expect((await env.ASSETS!.list({ prefix: `sites/${sid}/` })).objects.length).toBe(0);
    expect((await json<unknown[]>(await call("GET", `/sites/${sid}/assets`, { token: owner.token }))).length).toBe(0);
    // 本物の AVIF brand(`avif`)は通る — brand 判定が AVIF そのものを閉め出していないこと
    res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(isoBmff("avif"), "image/avif", eid, "x.avif") });
    expect(res.status).toBe(201);
    expect(await json<{ mime: string; key: string }>(res)).toMatchObject({ mime: "image/avif" });
    // experimentId が不明なら 404
    expect((await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: form(PNG, "image/png", "exp_missing") })).status).toBe(404);
    // VIEWER は 403(認可判定は roles.ts の loadSite)
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await call("POST", `/sites/${sid}/assets`, { token: v.token, raw: form(PNG, "image/png", eid) })).status).toBe(403);
    // 別 Workspace の ADMIN(= 非メンバー)は 404
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const outsider = await inviteAndJoin(owner.token, second.id, "admin");
    expect((await call("POST", `/sites/${sid}/assets`, { token: outsider.token, raw: form(PNG, "image/png", eid) })).status).toBe(404);
    expect((await call("GET", `/sites/${sid}/assets`, { token: outsider.token })).status).toBe(404);
  });

  it("dev-assets is disabled when the public base is not control itself", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const res = await call("GET", `/dev-assets/sites/${sid}/experiments/x/a.png`, {
      token: owner.token,
      envOverride: { AB_ASSET_PUBLIC_BASE: "https://assets.example.com" },
    });
    expect(res.status).toBe(404);
    await expectEnvelope(res);
  });

  // 決定 43 (5): R2 binding が無い導入では画像の口を閉じる。公開ベースだけ空でも同じ(設定漏れは無効側)
  for (const [label, envOverride] of [
    ["no_binding", { ASSETS: undefined }],
    ["empty_public_base", { AB_ASSET_PUBLIC_BASE: "" }],
  ] as const) {
    it(`r2_disabled_${label}`, async () => {
      const { token, workspaceId } = await setupOwner();
      const { id: sid } = await createSite(token, workspaceId);
      const { id: eid } = await createExperiment(token, sid);
      const up = await call("POST", `/sites/${sid}/assets`, { token, raw: form(PNG, "image/png", eid), envOverride });
      expect(up.status).toBe(409);
      expect((await expectEnvelope(up)).error).toBe("image_upload_disabled");
      const list = await call("GET", `/sites/${sid}/assets`, { token, envOverride });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([]);
      const dev = await call("GET", `/dev-assets/sites/${sid}/experiments/${eid}/x.png`, { envOverride });
      expect(dev.status).toBe(404);
    });
  }

  it("site_delete_leaves_r2_untouched_when_binding_missing", async () => {
    // 決定 43 (5): R2 なし構成の Site 削除は R2 に触らない。R2 ありで 1 枚置いてから binding 無しで削除し、オブジェクトが残ることで早期 return を証明する
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id: eid } = await createExperiment(token, sid);
    const up = await call("POST", `/sites/${sid}/assets`, { token, raw: form(PNG, "image/png", eid) });
    expect(up.status).toBe(201);
    expect((await call("DELETE", `/sites/${sid}`, { token, envOverride: { ASSETS: undefined } })).status).toBe(204);
    expect((await env.ASSETS!.list({ prefix: `sites/${sid}/` })).objects.length).toBe(1);
    // 公開ベースが空でも binding があれば消す(publish.test.ts の R2 あり削除と同じ結果)
    const { id: sid2 } = await createSite(token, workspaceId);
    const { id: eid2 } = await createExperiment(token, sid2);
    expect((await call("POST", `/sites/${sid2}/assets`, { token, raw: form(PNG, "image/png", eid2) })).status).toBe(201);
    expect((await call("DELETE", `/sites/${sid2}`, { token, envOverride: { AB_ASSET_PUBLIC_BASE: "" } })).status).toBe(204);
    expect((await env.ASSETS!.list({ prefix: `sites/${sid2}/` })).objects.length).toBe(0);
  });
});
