import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { capabilities, edgeOnWorkersDev, edgeOrigin, imageStore, tagOrigin } from "../src/capabilities";
import type { Env } from "../src/env";
import { call, setupOwner } from "./helpers";

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

  it("GET_capabilities_requires_session_and_reflects_env", async () => {
    expect((await call("GET", "/capabilities")).status).toBe(401);
    const { token } = await setupOwner();
    const on = await call("GET", "/capabilities", { token, envOverride: { AB_EDGE_ORIGIN: "https://wtt-edge.my-sub.workers.dev" } });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ imageUpload: true, edgeOrigin: "https://wtt-edge.my-sub.workers.dev", tagOrigin: "https://wtt-edge.my-sub.workers.dev", edgeOnWorkersDev: true, passwordLogin: false, writeFreeze: null });
    const off = await call("GET", "/capabilities", { token, envOverride: { ASSETS: undefined, AB_EDGE_ORIGIN: undefined } });
    expect(await off.json()).toEqual({ imageUpload: false, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, writeFreeze: null });
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
});
