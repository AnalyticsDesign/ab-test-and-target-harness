import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { capabilities, edgeOnWorkersDev, edgeOrigin, IMAGE_DISABLED_HINT, imageStore, LIBRARY_DISABLED_HINT, libraryDisabledHint, resultsStore, tagOrigin } from "../src/capabilities";
import type { Env } from "../src/env";
import { call, json, createSite, expectEnvelope, RESULTS_STORE, seedAssetRow, setupOwner } from "./helpers";

import { RELEASE_VERSION } from "../src/generated/release";

const withEnv = (o: Partial<Env>): Env => ({ ...(env as unknown as Env), ...o }) as Env;

// 決定 43 (4) / 決定 44 (4): 判定は 1 関数に集める。ここはその関数と GET /capabilities の契約
describe("capabilities", () => {
  const base = env as unknown as Env;

  it("imageStore_requires_both_binding_and_public_base", () => {
    expect(imageStore(base)).not.toBeNull();
    expect(imageStore(base)?.publicBase).toBe("http://localhost:8788/dev-assets");
    expect(imageStore(withEnv({ ASSETS: undefined }))).toBeNull();
    expect(imageStore(withEnv({ AB_ASSET_PUBLIC_BASE: "" }))).toBeNull();
    expect(imageStore(withEnv({ AB_ASSET_PUBLIC_BASE: undefined }))).toBeNull();
    expect(imageStore(withEnv({ AB_ASSET_PUBLIC_BASE: "https://assets.example.com/" }))?.publicBase).toBe("https://assets.example.com");
  });

  it("image_store_rejects_malformed_public_base", () => {
    // CX-Medium-1: URL でない値・パスだけ・sentinel の none・非 http(s)・credential / query 付きは無効側
    for (const bad of ["/", "none", "dev-assets", "ftp://assets.example.com", "https://u:p@assets.example.com", "https://assets.example.com/?x=1", "   "]) {
      expect(imageStore(withEnv({ AB_ASSET_PUBLIC_BASE: bad }))).toBeNull();
    }
    expect(imageStore(withEnv({ AB_ASSET_PUBLIC_BASE: "http://localhost:8788/dev-assets/" }))?.publicBase).toBe("http://localhost:8788/dev-assets");
  });

  it("edge_origin_three_ways", () => {
    expect(edgeOrigin(withEnv({ AB_EDGE_ORIGIN: undefined }))).toBeNull();
    expect(edgeOnWorkersDev(withEnv({ AB_EDGE_ORIGIN: undefined }))).toBe(false);
    expect(edgeOrigin(withEnv({ AB_EDGE_ORIGIN: "https://www.example.com/" }))).toBe("https://www.example.com");
    expect(edgeOnWorkersDev(withEnv({ AB_EDGE_ORIGIN: "https://www.example.com" }))).toBe(false);
    expect(edgeOrigin(withEnv({ AB_EDGE_ORIGIN: "https://wtt-edge.my-sub.workers.dev" }))).toBe("https://wtt-edge.my-sub.workers.dev");
    expect(edgeOnWorkersDev(withEnv({ AB_EDGE_ORIGIN: "https://wtt-edge.my-sub.workers.dev" }))).toBe(true);
    // 似た名前のドメインに騙されない(ホストの末尾一致だけを見る)
    expect(edgeOnWorkersDev(withEnv({ AB_EDGE_ORIGIN: "https://workers.dev.example.com" }))).toBe(false);
    expect(edgeOrigin(withEnv({ AB_EDGE_ORIGIN: "not a url" }))).toBeNull();
  });

  it("tag_origin_follows_static_origin_or_falls_back_to_edge", () => {
    // AB_STATIC_ORIGIN 無し = edge と同じ(Route 構成)
    expect(tagOrigin(withEnv({ AB_EDGE_ORIGIN: "https://www.example.com/", AB_STATIC_ORIGIN: undefined }))).toBe("https://www.example.com");
    // 有り = その origin(ドメインなし構成。末尾スラッシュは落とす)
    expect(tagOrigin(withEnv({ AB_EDGE_ORIGIN: "https://wtt-edge.my-sub.workers.dev", AB_STATIC_ORIGIN: "https://wtt-static.my-sub.workers.dev/" }))).toBe("https://wtt-static.my-sub.workers.dev");
    // 不正 = edge と同じ
    expect(tagOrigin(withEnv({ AB_EDGE_ORIGIN: "https://www.example.com", AB_STATIC_ORIGIN: "not a url" }))).toBe("https://www.example.com");
    expect(tagOrigin(withEnv({ AB_EDGE_ORIGIN: "https://www.example.com", AB_STATIC_ORIGIN: "ftp://x.example.com" }))).toBe("https://www.example.com");
    expect(tagOrigin(withEnv({ AB_EDGE_ORIGIN: undefined, AB_STATIC_ORIGIN: undefined }))).toBeNull();
  });

  // D9 ②(設計書 §6.6): 計測用 D1 の binding があるか。無い導入では Site で結果の記録を有効にできない
  it("results_store_follows_the_binding", () => {
    expect(resultsStore(base)).toBe(true); // vitest の miniflare が渡す
    expect(resultsStore(withEnv({ RESULTS_DB: undefined }))).toBe(false);
  });

  it("GET_capabilities_requires_session_and_reflects_env", async () => {
    expect((await call("GET", "/capabilities")).status).toBe(401);
    const { token } = await setupOwner();
    const on = await call("GET", "/capabilities", { token, envOverride: { ...RESULTS_STORE, AB_EDGE_ORIGIN: "https://wtt-edge.my-sub.workers.dev" } });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ imageUpload: true, edgeOrigin: "https://wtt-edge.my-sub.workers.dev", tagOrigin: "https://wtt-edge.my-sub.workers.dev", edgeOnWorkersDev: true, passwordLogin: false, resultsStore: true, imageThumbnails: false, writeFreeze: null, productVersion: RELEASE_VERSION, apiVersion: 7, minClientVersion: 7 });
    const off = await call("GET", "/capabilities", { token, envOverride: { ASSETS: undefined, AB_EDGE_ORIGIN: undefined } });
    expect(await off.json()).toEqual({ imageUpload: false, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, resultsStore: false, imageThumbnails: false, writeFreeze: null, productVersion: RELEASE_VERSION, apiVersion: 7, minClientVersion: 7 });
    expect(capabilities(withEnv({ AB_ASSET_PUBLIC_BASE: "" })).imageUpload).toBe(false);
  });

  // backlog D13 / 決定 56: 管理画面のバナーとエージェントの事前確認に使う
  it("GET_capabilities_reports_the_write_freeze", async () => {
    const { token } = await setupOwner();
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"v1.1 への更新\",\"until\":\"2026-10-10T12:00:00+09:00\"}', 42)").run();
    expect((await (await call("GET", "/capabilities", { token })).json() as { writeFreeze: unknown }).writeFreeze).toEqual({ reason: "v1.1 への更新", until: "2026-10-10T12:00:00+09:00", since: 42 });
    await env.DB.prepare("update instance_settings set value = 'x' where key = 'writeFreeze'").run();
    expect((await (await call("GET", "/capabilities", { token })).json() as { writeFreeze: unknown }).writeFreeze).toEqual({ reason: null, until: null, since: 42 });
  });

  // B68 plan Task 3(spec §4.5 の 2・§8): IMAGE の 422 とライブラリの口の 409 の hint は定数を分ける
  const LIBRARY_NO_UPLOADER =
    "画像の差し替えは ATTRIBUTE の src で行えます。有効にするには R2 バケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定して再デプロイします";
  it("library_disabled_hint_without_uploader_is_current_text", async () => {
    expect(LIBRARY_DISABLED_HINT.noUploader).toBe(LIBRARY_NO_UPLOADER);
    expect(libraryDisabledHint(false)).toBe(LIBRARY_NO_UPLOADER);
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAssetRow(sid, { id: "asset_libhint001" });
    const envOverride = { ASSETS: undefined };
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "a.png", { type: "image/png" }));
    const responses = [
      await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: fd, envOverride }),
      await call("PATCH", `/sites/${sid}/assets/asset_libhint001`, { token: owner.token, body: { name: "z.png" }, envOverride }),
      await call("DELETE", `/sites/${sid}/assets/asset_libhint001`, { token: owner.token, envOverride }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(await expectEnvelope(res)).toMatchObject({ error: "image_upload_disabled", hint: LIBRARY_NO_UPLOADER });
    }
  });

  it("library_disabled_hint_with_uploader", () => {
    expect(LIBRARY_DISABLED_HINT.withUploader).toBe("この導入では、画像は左メニューの「画像」からアップロードします(API は /sites/<siteId>/uploads)");
    expect(libraryDisabledHint(true)).toBe(LIBRARY_DISABLED_HINT.withUploader);
    // B285: IMAGE の 422 もアップローダーを案内せず、ライブラリの口のアップローダーなしの文と同じ
    expect(IMAGE_DISABLED_HINT).toBe(LIBRARY_NO_UPLOADER);
    expect(IMAGE_DISABLED_HINT).not.toContain("AB_UPLOADER_PUBLIC_BASE");
  });
});

it("capabilities_return_product_version_for_session_and_api_key_b142", async () => {
  const { token } = await setupOwner();
  expect((await json(await call("GET", "/capabilities", { token }))).productVersion).toBe(RELEASE_VERSION);
  const { key } = await json<{ key: string }>(await call("POST", "/me/api-keys", { token, body: { name: "agent", workspaceId: null } }));
  expect((await json(await call("GET", "/capabilities", { token: key }))).productVersion).toBe(RELEASE_VERSION);
});
