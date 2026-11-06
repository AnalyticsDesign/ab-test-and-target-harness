import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys } from "@wtt/core";
import { ASSET_PURGE_GRACE_MS } from "../src/asset-usage";
import { ASSET_PURGE_PER_TICK, assetHousekeepingJob, HOUSEKEEPING_SUBREQUESTS, THUMB_SUBREQUESTS, THUMBNAILS_PER_TICK } from "../src/cron/asset-housekeeping";
import { CronFrozen, runCron } from "../src/cron/runner";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { publishSite } from "../src/publish";
import { IMAGES_QUOTA_KEY } from "../src/thumbnails";
import { call, createExperiment, createSite, json, publishRes, runDirect, setupOwner, siteRow, TEXT_CHANGE, testEnv, userActor } from "./helpers";
import { CONFIG_RECORD, countingD1 } from "./d1-trips";
import { fakeImages, housekeepingCtx, runHousekeeping, wrapBucket } from "./housekeeping-helpers";

// B68 Task 5(spec §5.3・§6.1・§10.2・§14・§22.1): Cron `asset-housekeeping`(削除の段 → 縮小版の段)

const PB = env.AB_ASSET_PUBLIC_BASE as string;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const NOW = Date.now();
/** 猶予の過ぎた削除待ちの時刻(i が大きいほど新しい) */
const graced = (i = 0) => NOW - ASSET_PURGE_GRACE_MS - 60_000 + i * 1000;

type Owner = Awaited<ReturnType<typeof setupOwner>>;
type Row = { id: string; deleted_at: number | null; deleted_by: string | null; purge_marked_at: number | null; kept_at: number | null; thumb_state: string; thumb_attempts: number; thumb_key: string | null; width: number | null; height: number | null };

const keyOf = (sid: string, aid: string) => `sites/${sid}/images/${aid}.png`;
const urlOf = (sid: string, aid: string) => `${PB}/${keyOf(sid, aid)}`;
const thumbOf = (sid: string, aid: string) => `sites/${sid}/thumbs/${aid}.webp`;
const htmlChange = (html: string, id = "c_html") => ({ id, type: "HTML", selector: ".box", payload: { html, position: "append", runScripts: false } });
const attrSrc = (value: string, id = "c_attr") => ({ id, type: "ATTRIBUTE", selector: "img.side", payload: { name: "src", value } });

/**
 * 画像の行と R2 の元のファイルを入れる。既定は削除待ちでない・縮小版は作らない(skipped)。
 * `thumb: true` で作り待ち(pending)。`withThumb` で R2 に縮小版も置く
 */
async function seed(
  sid: string,
  id: string,
  o: { deletedAt?: number | null; marked?: number | null; thumb?: boolean; createdAt?: number; withThumb?: boolean } = {},
): Promise<string> {
  await env.DB.prepare(
    `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, deleted_at, deleted_by, purge_marked_at, updated_at)
     values (?1, ?2, ?1, ?1, ?3, ?4, 'image/png', ?5, ?6, 'u', ?7, ?8, ?9, ?10, 1)`,
  )
    .bind(id, sid, keyOf(sid, id), urlOf(sid, id), PNG.byteLength, o.thumb ? "pending" : "skipped", o.createdAt ?? 1, o.deletedAt ?? null, o.deletedAt ? "u" : null, o.marked ?? null)
    .run();
  await env.ASSETS!.put(keyOf(sid, id), PNG);
  if (o.withThumb) await env.ASSETS!.put(thumbOf(sid, id), new Uint8Array([1]));
  return urlOf(sid, id);
}
const row = (id: string) => env.DB.prepare(`select * from assets where id = ?`).bind(id).first<Row>();
const r2Has = async (key: string) => (await env.ASSETS!.head(key)) !== null;
async function freeze() {
  await env.DB.prepare(`insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{"reason":"更新"}', 1, null) on conflict(key) do nothing`).run();
}
async function unfreeze() {
  await env.DB.prepare(`delete from instance_settings where key = 'writeFreeze'`).run();
}
async function site(owner?: Owner): Promise<{ owner: Owner; sid: string }> {
  const o = owner ?? (await setupOwner());
  const { id } = await createSite(o.token, o.workspaceId);
  return { owner: o, sid: id };
}
async function putChanges(token: string, sid: string, eid: string, body: unknown[]) {
  const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
}
/** 実行中のエクスペリエンス(パターン b に changes) */
async function running(owner: Owner, sid: string, changes: unknown[], id = "exp_hk") {
  await createExperiment(owner.token, sid, { id });
  await putChanges(owner.token, sid, id, changes.length > 0 ? changes : [TEXT_CHANGE()]);
  await runDirect(sid, id);
  return id;
}
/** 変更の行を直接入れる(保存の検査を通らない、B68 の前に保存された形の種) */
async function rawChange(sid: string, eid: string, id: string, type: string, payload: unknown) {
  await env.DB.prepare(
    `insert into changes (site_id, experiment_id, variant_id, id, type, selector, payload_json, position, created_by, updated_by, created_at, updated_at)
     values (?1, ?2, 'b', ?3, ?4, '.box', ?5, 99, 'u', 'u', 1, 1)`,
  )
    .bind(sid, eid, id, type, JSON.stringify(payload))
    .run();
}
async function rawPublish(sid: string, version: number, configJson: string, kvDeleted: 0 | 1) {
  await env.DB.prepare(
    `insert into publishes (id, site_id, version, status, config_hash, config_json, kv_deleted, published_by, created_at) values (?1, ?2, ?3, 'retired', 'h', ?4, ?5, 'u', 1)`,
  )
    .bind(`pub_${sid}_${version}`, sid, version, configJson, kvDeleted)
    .run();
}
/** 削除の段の結果: 消えた(行も R2 も)/ 戻った / 墓標 / そのまま */
async function fate(sid: string, id: string): Promise<"purged" | "restored" | "tombstone" | "pending" | "normal"> {
  const r = await row(id);
  if (!r) {
    expect(await r2Has(keyOf(sid, id)), `${id} R2 original`).toBe(false);
    expect(await r2Has(thumbOf(sid, id)), `${id} R2 thumb`).toBe(false);
    return "purged";
  }
  if (r.purge_marked_at !== null) return "tombstone";
  if (r.deleted_at !== null) return "pending";
  return r.kept_at !== null ? "restored" : "normal";
}

afterEach(() => vi.restoreAllMocks());

describe("asset-housekeeping: the job (spec §5.3)", () => {
  it("housekeeping_runs_purge_before_thumbnails", async () => {
    const { sid } = await site();
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced() });
    await seed(sid, "asset_thumbaaaaa", { thumb: true });
    const log: string[] = [];
    const IMAGES = fakeImages({ log });
    await runHousekeeping({ IMAGES, ASSETS: wrapBucket(env.ASSETS!, { log }) });
    expect(log).toEqual(["r2.delete", "images.info"]);
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("purged");
    expect((await row("asset_thumbaaaaa"))!.thumb_state).toBe("ready");
  });

  it("housekeeping_does_not_thumbnail_purged_asset", async () => {
    const { sid } = await site();
    await seed(sid, "asset_bothaaaaaa", { deletedAt: graced(), thumb: true });
    const IMAGES = fakeImages();
    await runHousekeeping({ IMAGES });
    expect(await fate(sid, "asset_bothaaaaaa")).toBe("purged");
    expect(IMAGES.calls).toEqual([]);
    expect(await r2Has(thumbOf(sid, "asset_bothaaaaaa"))).toBe(false);
  });

  it("housekeeping_shares_subrequest_budget", async () => {
    // 予算の見込みの式の確かめ(1 枚 5 = 凍結の確かめを 1 枚ごとにしなくなった分、削除の無い回も削除の段を全部使った回も 4 枚が収まる)
    expect(Math.floor((HOUSEKEEPING_SUBREQUESTS - 3) / THUMB_SUBREQUESTS)).toBeGreaterThanOrEqual(THUMBNAILS_PER_TICK);
    expect(Math.floor((HOUSEKEEPING_SUBREQUESTS - 6) / THUMB_SUBREQUESTS)).toBeGreaterThanOrEqual(THUMBNAILS_PER_TICK);
    expect(1 + 4 + 1 + THUMBNAILS_PER_TICK * THUMB_SUBREQUESTS).toBeLessThanOrEqual(HOUSEKEEPING_SUBREQUESTS);
    const { sid } = await site();
    for (let i = 0; i < 8; i++) await seed(sid, `asset_thumb${i}aaaa`, { thumb: true, createdAt: 10 + i });
    const ready = async () => (await env.DB.prepare(`select count(*) as n from assets where thumb_state = 'ready'`).first<{ n: number }>())!.n;
    const IMAGES = fakeImages();
    await runHousekeeping({ IMAGES });
    expect(await ready()).toBe(4); // 削除の段は読みだけ
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced() });
    await runHousekeeping({ IMAGES });
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("purged");
    expect(await ready()).toBe(8); // 削除の段を使った回も 4 枚(上限)
  });

  it("housekeeping_stops_when_query_budget_runs_out", async () => {
    const { sid } = await site();
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced() });
    for (let i = 0; i < 3; i++) await seed(sid, `asset_thumb${i}aaaa`, { thumb: true, createdAt: 10 + i });
    const IMAGES = fakeImages();
    // 残りが 0: 何もせず続きを次の回に
    expect(await runHousekeeping({ IMAGES }, NOW, 0)).toEqual({ more: true });
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("pending");
    expect(IMAGES.calls).toEqual([]);
    // 途中で足りなくなる: 凍結の確かめ 1 + 削除の段 3 + 縮小版の読み 1 + 1 枚 1 = 6 で、削除の段と 1 枚まで
    expect(await runHousekeeping({ IMAGES }, NOW, 6)).toEqual({ more: true });
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("purged");
    expect((await env.DB.prepare(`select id from assets where thumb_state = 'ready'`).all()).results).toEqual([{ id: "asset_thumb0aaaa" }]);
    // 足りれば最後まで(続きなし)
    expect(await runHousekeeping({ IMAGES })).toBeUndefined();
    expect((await row("asset_thumb2aaaa"))!.thumb_state).toBe("ready");
  });

  it("housekeeping_noop_without_r2", async () => {
    const { sid } = await site();
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced(), thumb: true });
    const { DB, trips } = countingD1(env.DB);
    const IMAGES = fakeImages();
    expect(await runHousekeeping({ ASSETS: undefined, IMAGES, DB })).toBeUndefined();
    expect(trips).toEqual([]);
    expect(IMAGES.calls).toEqual([]);
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("pending");
  });

  it("housekeeping_skipped_when_frozen", async () => {
    const { sid } = await site();
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced() });
    await freeze();
    expect(await runCron(testEnv, NOW, [assetHousekeepingJob])).toEqual([{ job: "asset-housekeeping", outcome: "skipped_frozen" }]);
    // 実行の後に凍結が入った: 最初の確かめで止まる
    await expect(assetHousekeepingJob.run(housekeepingCtx({}, NOW))).rejects.toBeInstanceOf(CronFrozen);
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("pending");
    await unfreeze();
    expect(await runCron(testEnv, NOW, [assetHousekeepingJob])).toEqual([{ job: "asset-housekeeping", outcome: "ran" }]);
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("purged");
  });
});

describe("asset-housekeeping: thumbnail stage (spec §5.3)", () => {
  it("thumbnails_up_to_per_tick", async () => {
    const { sid } = await site();
    for (let i = 0; i < 6; i++) await seed(sid, `asset_thumb${i}aaaa`, { thumb: true, createdAt: 10 + i });
    const IMAGES = fakeImages({ width: 1200, height: 800 });
    await runHousekeeping({ IMAGES });
    const rows = (await env.DB.prepare(`select id, thumb_state, thumb_key, width, height from assets order by created_at`).all()).results;
    expect(rows.filter((r) => r.thumb_state === "ready").map((r) => r.id)).toEqual(["asset_thumb0aaaa", "asset_thumb1aaaa", "asset_thumb2aaaa", "asset_thumb3aaaa"]); // 古い順に 4 枚
    expect(rows[0]).toMatchObject({ thumb_key: thumbOf(sid, "asset_thumb0aaaa"), width: 1200, height: 800 });
    expect(await r2Has(thumbOf(sid, "asset_thumb3aaaa"))).toBe(true);
    expect(await r2Has(thumbOf(sid, "asset_thumb4aaaa"))).toBe(false);
  });

  it("thumbnail_stage_checks_freeze_once_per_tick", async () => {
    // 凍結の確かめはジョブの最初の 1 回だけ(1 枚ごとにしない)。D1 の往復: 削除の段の読み 1 + 縮小版の読み 1 + 1 枚ごとの更新 1
    const { sid } = await site();
    for (let i = 0; i < 3; i++) await seed(sid, `asset_thumb${i}aaaa`, { thumb: true, createdAt: 10 + i });
    const { DB, trips } = countingD1(env.DB);
    const ctx = housekeepingCtx({ IMAGES: fakeImages(), DB }, NOW);
    const check = vi.spyOn(ctx, "assertNotFrozen");
    expect(await assetHousekeepingJob.run(ctx)).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare(`select count(*) as n from assets where thumb_state = 'ready'`).first<{ n: number }>())!.n).toBe(3);
    expect(trips).toHaveLength(2 + 3);
    expect(trips.filter((t) => /UPDATE assets SET thumb_key/.test(t))).toHaveLength(3);
  });

  it("thumbnail_stage_stops_when_frozen_after_the_first_check", async () => {
    // 最初の確かめの後に凍結が入った: 縮小版の UPDATE が 0 行 → その回を止める(2 枚目の変換をしない)。行は pending のまま・回数は増えず・縮小版は消えない
    const { sid } = await site();
    for (let i = 0; i < 3; i++) await seed(sid, `asset_thumb${i}aaaa`, { thumb: true, createdAt: 10 + i });
    const IMAGES = fakeImages();
    const info = IMAGES.info.bind(IMAGES);
    IMAGES.info = async (stream) => {
      await freeze();
      return info(stream);
    };
    await expect(runHousekeeping({ IMAGES })).rejects.toBeInstanceOf(CronFrozen);
    expect(IMAGES.calls.filter((c) => c.op === "info")).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect(await row(`asset_thumb${i}aaaa`)).toMatchObject({ thumb_state: "pending", thumb_attempts: 0, thumb_key: null });
    expect(await r2Has(thumbOf(sid, "asset_thumb0aaaa"))).toBe(true);
    await unfreeze();
    await runHousekeeping({ IMAGES: fakeImages() });
    for (let i = 0; i < 3; i++) expect((await row(`asset_thumb${i}aaaa`))!.thumb_state).toBe("ready");
  });

  it("thumbnails_failed_after_three_attempts", async () => {
    const { sid } = await site();
    await seed(sid, "asset_failaaaaaa", { thumb: true });
    const IMAGES = fakeImages();
    IMAGES.fail = { at: "output" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 1; i <= 3; i++) {
      await runHousekeeping({ IMAGES });
      expect(await row("asset_failaaaaaa")).toMatchObject({ thumb_attempts: i, thumb_state: i < 3 ? "pending" : "failed" });
    }
    const calls = IMAGES.calls.length;
    await runHousekeeping({ IMAGES });
    expect(IMAGES.calls.length).toBe(calls); // failed は二度と拾わない
  });

  it("thumbnails_stop_on_quota_until_month_end_without_counting", async () => {
    const { sid } = await site();
    await seed(sid, "asset_quota1aaaa", { thumb: true, createdAt: 10 });
    await seed(sid, "asset_quota2aaaa", { thumb: true, createdAt: 11 });
    const IMAGES = fakeImages();
    IMAGES.fail = { at: "info", code: 9422 };
    const mid = Date.UTC(2026, 10, 10, 12); // 2026-11-10
    await runHousekeeping({ IMAGES }, mid);
    expect(IMAGES.calls).toHaveLength(1); // その回を止める(2 枚目に進まない)
    expect(await row("asset_quota1aaaa")).toMatchObject({ thumb_attempts: 0, thumb_state: "pending" });
    const mark = await env.DB.prepare(`select value from instance_settings where key = ?`).bind(IMAGES_QUOTA_KEY).first<{ value: string }>();
    expect(JSON.parse(mark!.value)).toEqual({ until: Date.UTC(2026, 11, 1) });
    // 同じ月の次の回は見送る(Images を呼ばない)
    IMAGES.fail = null;
    await runHousekeeping({ IMAGES }, Date.UTC(2026, 10, 30, 23, 45));
    expect(IMAGES.calls).toHaveLength(1);
    // 翌月の最初の回で再開する
    await runHousekeeping({ IMAGES }, Date.UTC(2026, 11, 1, 0, 0));
    expect((await row("asset_quota1aaaa"))!.thumb_state).toBe("ready");
    expect((await row("asset_quota2aaaa"))!.thumb_state).toBe("ready");
  });

  it("thumbnails_stage_noop_without_images_binding_but_purge_runs", async () => {
    const { sid } = await site();
    await seed(sid, "asset_purgeaaaaa", { deletedAt: graced() });
    await seed(sid, "asset_thumbaaaaa", { thumb: true });
    expect(await runHousekeeping({ IMAGES: undefined })).toBeUndefined();
    expect(await fate(sid, "asset_purgeaaaaa")).toBe("purged");
    expect(await row("asset_thumbaaaaa")).toMatchObject({ thumb_state: "pending", thumb_attempts: 0 });
  });

  it("thumbnails_retry_when_original_is_missing_from_r2", async () => {
    const { sid } = await site();
    await seed(sid, "asset_noobjaaaaa", { thumb: true });
    await env.ASSETS!.delete(keyOf(sid, "asset_noobjaaaaa"));
    const IMAGES = fakeImages();
    await runHousekeeping({ IMAGES });
    expect(await row("asset_noobjaaaaa")).toMatchObject({ thumb_attempts: 1, thumb_state: "pending" });
    expect(IMAGES.calls).toEqual([]);
  });
});

describe("asset-housekeeping: purge stage (spec §6.1・§22.1)", () => {
  it("purge_up_to_per_tick", async () => {
    const { sid } = await site();
    for (let i = 0; i < 6; i++) await seed(sid, `asset_purge${i}aaaa`, { deletedAt: graced(i) });
    await runHousekeeping();
    const left = (await env.DB.prepare(`select id from assets`).all<{ id: string }>()).results.map((r) => r.id);
    expect(ASSET_PURGE_PER_TICK).toBe(5);
    expect(left).toEqual(["asset_purge5aaaa"]); // 古い順に 5 枚
  });

  it("purge_across_five_sites", async () => {
    const owner = await setupOwner();
    const sids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { sid } = await site(owner);
      await seed(sid, `asset_site${i}aaaaa`, { deletedAt: graced(i) });
      sids.push(sid);
    }
    const { DB, trips } = countingD1(env.DB);
    await runHousekeeping({ DB });
    for (const [i, sid] of sids.entries()) expect(await fate(sid, `asset_site${i}aaaaa`)).toBe("purged");
    // 読み 1 + 印と戻しの batch 1 + 行の削除 1(凍結の確かめはこの数の外。縮小版の段は binding が無いので走らない)
    expect(trips).toHaveLength(3);
    expect(trips[1]!.split(" ;; ")).toHaveLength(10); // 5 枚 × (印 + 戻し)
  });

  it("purge_keeps_before_grace", async () => {
    const { sid } = await site();
    await seed(sid, "asset_freshaaaaa", { deletedAt: NOW - ASSET_PURGE_GRACE_MS + 60_000 });
    await runHousekeeping();
    expect(await fate(sid, "asset_freshaaaaa")).toBe("pending");
    expect(await r2Has(keyOf(sid, "asset_freshaaaaa"))).toBe(true);
  });

  it("purge_removes_row_and_two_r2_objects_when_unreferenced", async () => {
    const { sid } = await site();
    await seed(sid, "asset_bothaaaaaa", { deletedAt: graced(), withThumb: true });
    const ASSETS = wrapBucket(env.ASSETS!);
    await runHousekeeping({ ASSETS });
    expect(ASSETS.deleted).toEqual([[keyOf(sid, "asset_bothaaaaaa"), thumbOf(sid, "asset_bothaaaaaa")]]);
    expect(await fate(sid, "asset_bothaaaaaa")).toBe("purged");
  });

  // `/` を符号化した URL は B68 の後の保存では 422 になるので、B68 の前に保存された形として変更の行を直接入れる
  for (const [name, encode, type] of [
    ["purge_restores_when_html_uses_char_ref", (u: string) => `<img src="${u.replaceAll("/", "&#47;")}">`, "HTML"],
    ["purge_restores_when_css_uses_escape", (u: string) => `.x{background:url(${u.replaceAll("/", "\\/")})}`, "CSS"],
  ] as const) {
    it(name, async () => {
      const { owner, sid } = await site();
      await seed(sid, "asset_encodedaaa", { deletedAt: graced() });
      await createExperiment(owner.token, sid, { id: "exp_raw" });
      const text = encode(urlOf(sid, "asset_encodedaaa"));
      await rawChange(sid, "exp_raw", "c_raw", type, type === "HTML" ? { html: text, position: "append", runScripts: false } : { css: text });
      await runHousekeeping();
      expect(await fate(sid, "asset_encodedaaa")).toBe("restored");
    });
  }

  it("purge_restores_when_host_is_uppercase", async () => {
    const { owner, sid } = await site();
    await seed(sid, "asset_upperaaaaa", { deletedAt: graced() });
    await createExperiment(owner.token, sid, { id: "exp_up" });
    await putChanges(owner.token, sid, "exp_up", [htmlChange(`<img src="${urlOf(sid, "asset_upperaaaaa").replace("localhost", "LOCALHOST")}">`)]);
    await runHousekeeping();
    expect(await fate(sid, "asset_upperaaaaa")).toBe("restored");
  });

  it("purge_restores_when_only_in_live_publish_config", async () => {
    const { owner, sid } = await site();
    const { sid: sid2 } = await site(owner);
    await seed(sid, "asset_liveaaaaaa", { deletedAt: graced() });
    await seed(sid2, "asset_goneaaaaaa", { deletedAt: graced() });
    await rawPublish(sid, 1, JSON.stringify({ img: urlOf(sid, "asset_liveaaaaaa") }), 0); // 訪問者に届きうる版
    await rawPublish(sid2, 1, JSON.stringify({ img: urlOf(sid2, "asset_goneaaaaaa") }), 1); // KV から消した版
    await runHousekeeping();
    expect(await fate(sid, "asset_liveaaaaaa")).toBe("restored");
    expect(await fate(sid2, "asset_goneaaaaaa")).toBe("purged");
  });

  it("purge_restores_when_in_delivered_refs", async () => {
    const { owner, sid } = await site();
    await seed(sid, "asset_deliveaaaa", { deletedAt: graced() });
    await createExperiment(owner.token, sid, { id: "exp_dl" });
    await env.DB.prepare(`insert into asset_delivered_refs (site_id, asset_id, experiment_id) values (?, 'asset_deliveaaaa', 'exp_dl')`).bind(sid).run();
    await runHousekeeping();
    expect(await fate(sid, "asset_deliveaaaa")).toBe("restored");
  });

  it("purge_restores_and_sets_kept_at", async () => {
    const { owner, sid } = await site();
    await seed(sid, "asset_keptaaaaaa", { deletedAt: graced() });
    await createExperiment(owner.token, sid, { id: "exp_kept" });
    await putChanges(owner.token, sid, "exp_kept", [htmlChange(`<img src="${urlOf(sid, "asset_keptaaaaaa")}">`)]);
    await runHousekeeping({}, NOW);
    expect(await row("asset_keptaaaaaa")).toMatchObject({ deleted_at: null, deleted_by: null, purge_marked_at: null, kept_at: NOW });
    const list = await json<{ assets: Array<{ id: string; keptAt: number | null }> }>(await call("GET", `/sites/${sid}/assets`, { token: owner.token }));
    expect(list.assets).toEqual([expect.objectContaining({ id: "asset_keptaaaaaa", keptAt: NOW })]);
  });

  it("purge_keeps_asset_referenced_by_save_after_pending", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_saveaaaaaa");
    await createExperiment(owner.token, sid, { id: "exp_save" });
    // IMAGE の保存の確かめ(一覧の読み)の後・変更の書き込みの前に、削除待ちになった
    const { DB } = countingD1(env.DB, {
      match: /delete from "changes"/i,
      run: () => env.DB.prepare(`update assets set deleted_at = ?1, deleted_by = 'u' where id = 'asset_saveaaaaaa'`).bind(graced()).run(),
    });
    const res = await call("PUT", `/sites/${sid}/experiments/exp_save/variants/b/changes`, { token: owner.token, body: [{ id: "c_img", type: "IMAGE", selector: "img", payload: { src: url } }], envOverride: { DB } });
    expect(res.status).toBe(200);
    expect((await row("asset_saveaaaaaa"))!.deleted_at).not.toBeNull();
    await runHousekeeping();
    expect(await fate(sid, "asset_saveaaaaaa")).toBe("restored"); // 画像が切れない
  });

  it("purge_keeps_asset_published_during_pending", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_pubaaaaaaa");
    const eid = await running(owner, sid, [htmlChange(`<img src="${url}">`)]);
    // 公開の途中(下書きを読んだ後・手順 4 の前)に削除待ちにした。印の前なので公開は通る
    const { DB } = countingD1(env.DB, {
      match: CONFIG_RECORD,
      run: () => env.DB.prepare(`update assets set deleted_at = ?1, deleted_by = 'u' where id = 'asset_pubaaaaaaa'`).bind(graced()).run(),
    });
    const r = await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
    expect(r.ok).toBe(true);
    await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]); // 下書きの参照を外す(届きうる版の設定だけが残る)
    await runHousekeeping();
    expect(await fate(sid, "asset_pubaaaaaaa")).toBe("restored");
  });

  it("purge_restore_respects_freeze", async () => {
    const { sid } = await site();
    await seed(sid, "asset_frozenaaaa", { deletedAt: graced() });
    // 印と戻しの batch の直前に凍結が入る → どちらも 0 行
    const mark = countingD1(env.DB, { match: /UPDATE assets SET purge_marked_at/, run: freeze });
    await runHousekeeping({ DB: mark.DB });
    expect(await row("asset_frozenaaaa")).toMatchObject({ purge_marked_at: null, kept_at: null });
    expect((await row("asset_frozenaaaa"))!.deleted_at).not.toBeNull();
    await unfreeze();
    // 行の削除の直前に凍結が入る → R2 は消えたが行は墓標のまま
    const del = countingD1(env.DB, { match: /DELETE FROM assets/, run: freeze });
    await runHousekeeping({ DB: del.DB });
    expect(await fate(sid, "asset_frozenaaaa")).toBe("tombstone");
    expect(await r2Has(keyOf(sid, "asset_frozenaaaa"))).toBe(false);
    await unfreeze();
    // 次の回にやり直す
    await runHousekeeping();
    expect(await fate(sid, "asset_frozenaaaa")).toBe("purged");
  });

  it("purge_mark_is_never_cleared", async () => {
    const { owner, sid } = await site();
    await seed(sid, "asset_markedaaaa", { deletedAt: graced() });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runHousekeeping({ ASSETS: wrapBucket(env.ASSETS!, { failDelete: 1 }) });
    expect(await fate(sid, "asset_markedaaaa")).toBe("tombstone");
    // 印の後に参照が現れても(下書きに ID)、印は外れず、R2 のやり直しと行の削除だけをする
    await createExperiment(owner.token, sid, { id: "exp_mark" });
    await rawChange(sid, "exp_mark", "c_raw", "HTML", { html: `<img src="${urlOf(sid, "asset_markedaaaa")}">`, position: "append", runScripts: false });
    const ASSETS = wrapBucket(env.ASSETS!);
    const { DB, trips } = countingD1(env.DB);
    await runHousekeeping({ ASSETS, DB });
    expect(ASSETS.deleted).toEqual([[keyOf(sid, "asset_markedaaaa"), thumbOf(sid, "asset_markedaaaa")]]);
    expect(await fate(sid, "asset_markedaaaa")).toBe("purged");
    expect(trips.some((t) => /purge_marked_at = NULL|kept_at = \?1/.test(t))).toBe(false); // 印と戻しの batch を流さない(新しい印の候補が無い)
  });
});

describe("asset-housekeeping: races after the decision to delete (spec §6.1・§22.2)", () => {
  it("save_after_mark_passes_and_later_publish_fails", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_raceaaaaaa", { deletedAt: graced() });
    const eid = await running(owner, sid, []);
    // 印の batch の後・R2 の delete の前に、その画像の URL を含む ATTRIBUTE・HTML の保存が割り込む
    const ASSETS = wrapBucket(env.ASSETS!, { beforeDelete: () => putChanges(owner.token, sid, eid, [attrSrc(url), htmlChange(`<img src="${url}">`)]) });
    await runHousekeeping({ ASSETS });
    expect(await fate(sid, "asset_raceaaaaaa")).toBe("purged"); // 保存は 200(putChanges の中で確かめた)・画像は消える
    const r = await json<{ ok: boolean; error?: string }>(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "asset_missing" });
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, 1))).toBeNull(); // KV に何も置かれない
  });

  it("save_committed_just_before_mark_keeps_asset", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_raceaaaaaa", { deletedAt: graced() });
    await createExperiment(owner.token, sid, { id: "exp_race" });
    const { DB } = countingD1(env.DB, { match: /UPDATE assets SET purge_marked_at/, run: () => putChanges(owner.token, sid, "exp_race", [htmlChange(`<img src="${url}">`)]) });
    await runHousekeeping({ DB });
    expect(await fate(sid, "asset_raceaaaaaa")).toBe("restored");
  });

  it("publish_step4_committed_just_before_mark_keeps_asset", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_raceaaaaaa", { deletedAt: graced() });
    const eid = await running(owner, sid, [htmlChange(`<img src="${url}">`)]);
    // 印の batch の直前に公開(手順 4 まで)が確定し、その後に下書きの参照を外した(届きうる版の設定だけが参照する)
    const { DB } = countingD1(env.DB, {
      match: /UPDATE assets SET purge_marked_at/,
      run: async () => {
        expect((await json<{ ok: boolean }>(await publishRes(owner.token, sid))).ok).toBe(true);
        await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]);
      },
    });
    await runHousekeeping({ DB });
    expect(await fate(sid, "asset_raceaaaaaa")).toBe("restored");
  });

  it("publish_reading_before_mark_fails_after_mark", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_raceaaaaaa", { deletedAt: graced() });
    const eid = await running(owner, sid, [htmlChange(`<img src="${url}">`)]);
    // 公開が下書きを読んだ後・手順 4 の前に、下書きの参照が外れ、Cron が印を付けて消す
    const { DB } = countingD1(env.DB, {
      match: CONFIG_RECORD,
      run: async () => {
        await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]);
        await runHousekeeping();
      },
    });
    const r = await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
    expect(r).toMatchObject({ ok: false, error: "asset_missing" });
    expect(await fate(sid, "asset_raceaaaaaa")).toBe("purged");
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, r.version!))).toBeNull();
  });

  it("publish_after_row_deleted_fails", async () => {
    const { owner, sid } = await site();
    const url = await seed(sid, "asset_raceaaaaaa", { deletedAt: graced() });
    const eid = await running(owner, sid, []);
    await runHousekeeping();
    expect(await fate(sid, "asset_raceaaaaaa")).toBe("purged");
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]); // HTML の保存は断らない
    expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: false, error: "asset_missing" });
  });
});

describe("asset-housekeeping: tombstones (spec §6.1)", () => {
  it("purge_r2_delete_failure_keeps_tombstone", async () => {
    const { owner, sid } = await site();
    await seed(sid, "asset_tombaaaaaa", { deletedAt: graced() });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runHousekeeping({ ASSETS: wrapBucket(env.ASSETS!, { failDelete: 1 }) });
    expect(await fate(sid, "asset_tombaaaaaa")).toBe("tombstone");
    expect(await r2Has(keyOf(sid, "asset_tombaaaaaa"))).toBe(true);
    const list = await json<{ assets: unknown[]; usage: { count: number; pendingCount: number } }>(await call("GET", `/sites/${sid}/assets`, { token: owner.token }));
    expect(list.assets).toEqual([]); // 一覧に出ない
    expect(list.usage).toMatchObject({ count: 1, pendingCount: 1 }); // 使用量の削除待ちに数える
  });

  it("tombstone_retried_next_tick", async () => {
    const { sid } = await site();
    await seed(sid, "asset_tombaaaaaa", { deletedAt: graced(-100), marked: graced(-50) }); // 前の回に R2 を消せなかった墓標
    for (let i = 0; i < 5; i++) await seed(sid, `asset_purge${i}aaaa`, { deletedAt: graced(i) });
    const ASSETS = wrapBucket(env.ASSETS!);
    await runHousekeeping({ ASSETS });
    expect(ASSETS.deleted[0]![0]).toBe(keyOf(sid, "asset_tombaaaaaa")); // 墓標を先に拾う
    expect(await fate(sid, "asset_tombaaaaaa")).toBe("purged");
    for (let i = 0; i < 4; i++) expect(await fate(sid, `asset_purge${i}aaaa`)).toBe("purged");
    expect(await fate(sid, "asset_purge4aaaa")).toBe("pending"); // 5 枚のうち 1 枚は墓標が使った
  });

  it("purge_deletes_fixed_thumb_key", async () => {
    const { sid } = await site();
    await seed(sid, "asset_lateaaaaaa", { deletedAt: graced() });
    // 行を読んだ後に縮小版が置かれた(行の thumb_key は NULL のまま)
    const { DB } = countingD1(env.DB, { match: /UPDATE assets SET purge_marked_at/, run: () => env.ASSETS!.put(thumbOf(sid, "asset_lateaaaaaa"), new Uint8Array([1])) });
    await runHousekeeping({ DB });
    expect(await fate(sid, "asset_lateaaaaaa")).toBe("purged");
  });

  it("thumbnail_stage_skips_pending_and_tombstone_rows", async () => {
    const { sid } = await site();
    await seed(sid, "asset_waitingaaa", { deletedAt: NOW - 60_000, thumb: true, createdAt: 1 }); // 削除待ち(猶予の内)
    await seed(sid, "asset_tombaaaaaa", { deletedAt: graced(), marked: graced(), thumb: true, createdAt: 2 }); // 墓標
    await seed(sid, "asset_normalaaaa", { thumb: true, createdAt: 3 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const IMAGES = fakeImages();
    await runHousekeeping({ IMAGES, ASSETS: wrapBucket(env.ASSETS!, { failDelete: 1 }) });
    expect(IMAGES.calls.filter((c) => c.op === "info")).toHaveLength(1);
    expect(await row("asset_normalaaaa")).toMatchObject({ thumb_state: "ready" });
    for (const id of ["asset_waitingaaa", "asset_tombaaaaaa"]) expect(await row(id), id).toMatchObject({ thumb_state: "pending", thumb_attempts: 0, thumb_key: null });
  });
});
