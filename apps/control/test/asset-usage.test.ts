import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { assetItemUrls } from "@wtt/core";
import { getDb } from "../src/db";
import { ASSET_PURGE_GRACE_MS, buildAssetList, buildUsageMaps, listAssetUsage, markAssetPendingDeletion, type AssetListRow } from "../src/asset-usage";
import { call, createExperiment, createSite, seedAssetRow, setupOwner, testEnv } from "./helpers";

/** B68(spec §4.1・§4.4): 一覧の「使用中」と削除の可否を同じ判定から出す部品 */

const limits = { maxCount: 10, maxBytes: 1000, maxFileBytes: 100 };
const row = (o: Partial<AssetListRow> & { id: string }): AssetListRow => ({
  site_id: "s", name: o.id, name_key: o.id, r2_key: `sites/s/images/${o.id}.png`, public_url: `https://a.example/sites/s/images/${o.id}.png`,
  mime: "image/png", size: 1, width: null, height: null, thumb_key: null, thumb_state: "skipped", thumb_attempts: 0,
  created_by: "u", created_at: 1, deleted_at: null, deleted_by: null, kept_at: null, purge_marked_at: null, updated_at: 1, creator_name: "U",
  ...o,
});
const draft = (o: { experiment_id: string; variant_id: string; src?: unknown; attr?: unknown }) => ({
  experiment_name: `${o.experiment_id} の名前`, status: "draft", variant_name: `${o.variant_id} の名前`, src: null, attr: null, ...o,
});

describe("asset usage (B68)", () => {
  it("grace_is_24_hours", () => expect(ASSET_PURGE_GRACE_MS).toBe(24 * 60 * 60 * 1000));

  it("build_usage_maps_dedupes_per_variant_and_keeps_names_once", () => {
    const url = "https://a.example/sites/s/images/asset_a.png";
    const maps = buildUsageMaps(
      [
        draft({ experiment_id: "e1", variant_id: "b", src: url }),
        draft({ experiment_id: "e1", variant_id: "b", attr: url }), // 同じパターンの 2 つ目の変更
        draft({ experiment_id: "e2", variant_id: "a", attr: url }),
        draft({ experiment_id: "e3", variant_id: "a", src: 42 }), // 文字列でない src は数えない
      ],
      [{ asset_id: "asset_a", experiment_id: "e4", experiment_name: "公開済み", status: "archived" }],
    );
    expect(maps.usedByUrl.get(url)).toEqual([{ experimentId: "e1", variantId: "b" }, { experimentId: "e2", variantId: "a" }]);
    expect(maps.deliveredByAssetId.get("asset_a")).toEqual(["e4"]);
    expect(Object.keys(maps.experiments).sort()).toEqual(["e1", "e2", "e4"]);
    expect(maps.experiments.e4).toEqual({ name: "公開済み", status: "archived", variants: {} });
  });

  it("experiment_ids_that_are_object_prototype_names_are_kept_as_data", () => {
    const url = "https://a.example/x.png";
    const maps = buildUsageMaps([draft({ experiment_id: "constructor", variant_id: "toString", src: url })], []);
    expect(maps.experiments.constructor).toMatchObject({ name: "constructor の名前", variants: { toString: "toString の名前" } });
    const out = buildAssetList([row({ id: "asset_a", public_url: url })], maps, { siteId: "s", publicBase: "https://a.example", imagesOn: false, limits });
    expect(JSON.parse(JSON.stringify(out.experiments))).toEqual({ constructor: { name: "constructor の名前", status: "draft", variants: { toString: "toString の名前" } } });
  });

  it("build_asset_list_counts_pending_in_usage_and_hides_them", () => {
    const maps = buildUsageMaps([], [{ asset_id: "asset_p", experiment_id: "e9", experiment_name: "x", status: "draft" }]);
    const out = buildAssetList(
      [row({ id: "asset_a", size: 10 }), row({ id: "asset_p", size: 5, deleted_at: 2 }), row({ id: "asset_t", size: 3, deleted_at: 3, purge_marked_at: 4 })],
      maps,
      { siteId: "s", publicBase: "https://a.example", imagesOn: true, limits },
    );
    expect(out.assets.map((a) => a.id)).toEqual(["asset_a"]);
    expect(out.usage).toEqual({ count: 3, bytes: 18, pendingCount: 2, pendingBytes: 8, ...limits });
    // 一覧に出ない画像だけが使うエクスペリエンスは載せない
    expect(out.experiments).toEqual({});
  });

  it("list_response_worst_case_size (I5・Q331: 1,000 枚・100 字の日本語の名前・作った人 5 人(ユーザー ID 32 字・名前 100 字)・縮小版あり・使われていない・公開ベースは変えていない)", () => {
    // 本番に近い長さ: 公開ベースは `https://wtt-assets.<ゾーン名>`、ID は control の newId(接頭辞 + 10 字)、作った人の ID は 32 字。
    // 作った人は少ない前提(5 人)で、名前は上限の 100 字の日本語
    // 使われていない条件なので、エクスペリエンス ID は各件にも experiments にも出ない(使われている形の大きさは usedBy の数に比例し、上限は無い)
    const sid = "site_abcdefghij";
    const base = "https://wtt-assets.example-company.com";
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const id = `asset_${String(i).padStart(10, "0")}`;
      return row({
        id, site_id: sid, name: "画".repeat(96) + ".png", name_key: "画".repeat(96) + ".png", r2_key: `sites/${sid}/images/${id}.png`,
        public_url: `${base}/sites/${sid}/images/${id}.png`, size: 5_242_880, width: 4096, height: 4096,
        thumb_state: "ready", thumb_key: `sites/${sid}/thumbs/${id}.webp`, created_by: `u${String(i % 5).padStart(31, "0")}`, created_at: 1_790_000_000_000, creator_name: `${"田".repeat(99)}${i % 5}`,
      });
    });
    const out = buildAssetList(rows, buildUsageMaps([], []), { siteId: sid, publicBase: base, imagesOn: true, limits: { maxCount: 1000, maxBytes: 10 * 1024 ** 3, maxFileBytes: 5 * 1024 ** 2 } });
    const bytes = new TextEncoder().encode(JSON.stringify(out)).byteLength;
    // 測った値 543,006 バイト(各件に作った人の ID(32 字)を持たせていた形は 584,981、作った人の名前も各件に繰り返していた形は
    // 891,243、さらに URL も各件に持たせていた形はその上)。画像の名前だけで約 300KB(3 バイトの字 × 100 × 1,000)あり、これは減らせない
    expect(bytes).toBeLessThanOrEqual(600_000);
    // 作った人の ID と名前は上の段の配列に 1 回だけ。各件はその添字だけ
    expect(out.creators).toHaveLength(5);
    expect(out.assets[0]).not.toHaveProperty("createdBy");
    expect(out.assets.slice(0, 6).map((a) => a.creator)).toEqual([0, 1, 2, 3, 4, 0]);
    expect(out.creators[out.assets[0]!.creator]).toEqual({ id: rows[0]!.created_by, name: rows[0]!.creator_name });
    expect(out.creators[out.assets[7]!.creator]).toEqual({ id: rows[7]!.created_by, name: rows[7]!.creator_name });
    // 各件は URL を持たず、path から戻した URL は D1 の public_url と一字一句同じ
    expect(out.urlPrefix).toBe(`${base}/sites/${sid}/`);
    expect(out.assets[0]).not.toHaveProperty("publicUrl");
    expect(out.assets[0]).not.toHaveProperty("thumbnailUrl");
    expect(assetItemUrls(out.urlPrefix!, out.assets[0]!)).toEqual({ publicUrl: rows[0]!.public_url, thumbnailUrl: `${base}/${rows[0]!.thumb_key}` });
  });

  it("creators_is_an_array_indexed_by_each_item (Q331)", () => {
    // 一覧に最初に出た順。作った人のユーザーが消えていれば name は null のまま表に入り、添字で指す。prototype の名前の ID もデータ
    const out = buildAssetList(
      [
        row({ id: "asset_a", created_by: "constructor", creator_name: null }),
        row({ id: "asset_b", created_by: "u2", creator_name: "B" }),
        row({ id: "asset_c", created_by: "constructor", creator_name: null }),
        row({ id: "asset_d", created_by: "u3", creator_name: "C", deleted_at: 1 }), // 削除待ちは一覧に出ず、表にも載らない
      ],
      buildUsageMaps([], []),
      { siteId: "s", publicBase: "https://a.example", imagesOn: false, limits },
    );
    expect(out.creators).toEqual([{ id: "constructor", name: null }, { id: "u2", name: "B" }]);
    expect(out.assets.map((a) => a.creator)).toEqual([0, 1, 0]);
    // キーの順は 1 件の形の createdBy の位置(createdAt の次)
    expect(Object.keys(out.assets[0]!).slice(Object.keys(out.assets[0]!).indexOf("createdAt"), Object.keys(out.assets[0]!).indexOf("createdAt") + 2)).toEqual(["createdAt", "creator"]);
  });

  it("thumbnail_url_only_when_ready", () => {
    const maps = buildUsageMaps([], []);
    const out = buildAssetList(
      [row({ id: "asset_r", thumb_state: "ready", thumb_key: "sites/s/thumbs/asset_r.webp" }), row({ id: "asset_p", thumb_state: "pending", thumb_key: null })],
      maps,
      { siteId: "s", publicBase: "https://a.example", imagesOn: true, limits },
    );
    expect(out.assets.map((a) => [a.thumbnail, assetItemUrls(out.urlPrefix!, a).thumbnailUrl])).toEqual([["ready", "https://a.example/sites/s/thumbs/asset_r.webp"], ["pending", null]]);
  });

  it("list_asset_usage_reads_draft_and_delivered_uses_from_d1", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { name: "E" });
    const url = `http://localhost:8788/dev-assets/sites/${sid}/images/asset_x.png`;
    await seedAssetRow(sid, { id: "asset_x", url }); // B68 Task 3: IMAGE の保存は一覧にある画像だけ
    expect(
      (await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [{ id: "c1", type: "IMAGE", selector: "img", payload: { src: url } }] })).status,
    ).toBe(200);
    await env.DB.prepare(`insert into asset_delivered_refs (site_id, asset_id, experiment_id) values (?1, 'asset_y', ?2)`).bind(sid, eid).run();
    const maps = await listAssetUsage(getDb(env), sid);
    expect(maps.usedByUrl.get(url)).toEqual([{ experimentId: eid, variantId: "b" }]);
    expect(maps.deliveredByAssetId.get("asset_y")).toEqual([eid]);
    expect(maps.experiments[eid]).toMatchObject({ name: "E", status: "draft" });
    expect(Object.keys(maps.experiments[eid]!.variants)).toEqual(["b"]);
  });

  it("mark_pending_deletion_is_one_batch_and_reads_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = `http://localhost:8788/dev-assets/sites/${sid}/images/asset_z.png`;
    await env.DB.prepare(
      `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, created_by, created_at, updated_at) values ('asset_z', ?1, 'z', 'z', 'k', ?2, 'image/png', 7, 'u', 1, 1)`,
    )
      .bind(sid, url)
      .run();
    let batches = 0;
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch") return (s: D1PreparedStatement[]) => (batches++, target.batch(s));
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const e = { ...testEnv, DB };
    const r = await markAssetPendingDeletion(e, getDb(e), sid, "asset_z", "u2", 5);
    expect(r).toMatchObject({ marked: true, usage: { count: 1, bytes: 7, pendingCount: 1, pendingBytes: 7 } });
    expect(batches).toBe(1);
    // 2 回目は削除待ちなので 0 行
    expect((await markAssetPendingDeletion(e, getDb(e), sid, "asset_z", "u2", 6)).marked).toBe(false);
  });
  it("mark_pending_deletion_reads_the_public_url_from_the_row_itself", async () => {
    // 先に行を読まず、印の 1 文の相関の部分問い合わせが assets.public_url を見る(同じサイトの下書きだけ)
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const url = `http://localhost:8788/dev-assets/sites/${sid}/images/asset_w.png`;
    const ins = `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, created_by, created_at, updated_at) values (?1, ?2, ?1, ?1, 'k', ?3, 'image/png', 1, 'u', 1, 1)`;
    await env.DB.prepare(ins).bind("asset_w", sid, url).run();
    await env.DB.prepare(ins).bind("asset_v", sid, `${url}?other`).run();
    expect(
      (await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [{ id: "c1", type: "ATTRIBUTE", selector: "img", payload: { name: "src", value: url } }] })).status,
    ).toBe(200);
    const db = getDb(env);
    expect((await markAssetPendingDeletion(testEnv, db, sid, "asset_w", "u", 5)).marked).toBe(false);
    expect((await markAssetPendingDeletion(testEnv, db, sid, "asset_v", "u", 5)).marked).toBe(true);
    // 別のサイトの ID を渡しても印は付かない
    const { id: other } = await createSite(owner.token, owner.workspaceId);
    await env.DB.prepare(ins).bind("asset_u", other, "x").run();
    expect((await markAssetPendingDeletion(testEnv, db, sid, "asset_u", "u", 5)).marked).toBe(false);
  });
});
