import { beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { kvKeys } from "@wtt/core";
import { extractAssetIds } from "../src/asset-refs";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { publishSite, type PublishResult } from "../src/publish";
import {
  call,
  createExperiment,
  createSite,
  failingKv,
  fakeDeployer,
  json,
  publishRes,
  runDirect,
  seedAssetRow,
  setupOwner,
  siteRow,
  TEXT_CHANGE,
  testEnv,
  userActor,
} from "./helpers";
import { ASSET_READ, CONFIG_RECORD, countingD1, tripsMatching } from "./d1-trips";
import { runHousekeeping } from "./housekeeping-helpers";

// B68 Task 4(spec §3.1・§22.2・§22.3・§22.5): 公開の画像の確かめと、公開したときの定義が使う画像の表

const PB = env.AB_ASSET_PUBLIC_BASE as string; // vitest.config.ts の値(R2 の binding もある)
const UP = "https://up.example.com";
const WITH_UP: Partial<Env> = { AB_UPLOADER_PUBLIC_BASE: UP };
const NO_R2: Partial<Env> = { ASSETS: undefined };
const PRIVATE_REF = /決定 ?[0-9]+|spec ?§|§ ?[0-9]|Plan ?[0-9]+|Task ?[0-9]+|superpowers\/|docs\/dev\/|1 号サイト/u;

const db = () => getDb(env);
const newKey = (sid: string, aid: string) => `${PB}/sites/${sid}/images/${aid}.png`;
const htmlChange = (html: string, id = "c_html") => ({ id, type: "HTML", selector: ".box", payload: { html, position: "append", runScripts: false } });
const cssChange = (css: string, id = "c_css") => ({ id, type: "CSS", payload: { css } });
const attrSrc = (value: string, id = "c_attr") => ({ id, type: "ATTRIBUTE", selector: "img.side", payload: { name: "src", value } });
const imageChange = (src: string, id = "c_img") => ({ id, type: "IMAGE", selector: "img.hero", payload: { src } });

async function putChanges(token: string, sid: string, eid: string, body: unknown[], vid = "b") {
  const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/${vid}/changes`, { token, body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
}

/** 実行中のエクスペリエンス(パターン b に changes)を 1 つ持つサイト */
async function siteWith(changes: unknown[], opts: { eid?: string } = {}) {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: eid } = await createExperiment(owner.token, sid, { id: opts.eid ?? "exp_img" });
  if (changes.length > 0) await putChanges(owner.token, sid, eid, changes);
  await runDirect(sid, eid);
  return { owner, sid, eid };
}

const publish = async (token: string, sid: string, over?: Partial<Env>) => json<PublishResult & { assetProblems?: unknown[] }>(await publishRes(token, sid, over));
const publishRows = (sid: string) => db().selectFrom("publishes").select(["version", "status", "config_hash", "kv_deleted", "error"]).where("site_id", "=", sid).orderBy("version").execute();
const refsOf = (sid: string) => db().selectFrom("asset_delivered_refs").select(["asset_id", "experiment_id"]).where("site_id", "=", sid).orderBy("asset_id").execute();

/** 結果の記録の run を持つ実行中のテスト(届く定義と asset_delivered_refs が書かれる) */
async function runTest(sid: string, eid: string) {
  await sql`update experiments set status = 'running', run_id = ${`run_${Math.random().toString(36).slice(2, 10)}`} where site_id = ${sid} and id = ${eid}`.execute(db());
}

/**
 * spec §6.1 の Cron の削除の段を 1 回流し、その画像に印が付いたか(行が消えたも含む)・一覧に戻ったかを返す
 * (Task 5 の本物のジョブ。Task 4 の手で書いた印と戻しの 2 文から置き換えた)
 */
async function cronMarkAndRestore(aid: string, now: number): Promise<{ marked: number; restored: number }> {
  await runHousekeeping({}, now);
  const r = await db().selectFrom("assets").select(["deleted_at", "purge_marked_at", "kept_at"]).where("id", "=", aid).executeTakeFirst();
  return { marked: !r || r.purge_marked_at !== null ? 1 : 0, restored: r && r.deleted_at === null && r.kept_at !== null ? 1 : 0 };
}

describe("asset_delivered_refs (spec §3.1)", () => {
  it("extract_asset_ids_from_definition_json", () => {
    // 重なりを除く。境は見ない(Cron の instr と同じ規則。ほかの文字列の中の似た形も拾う = 広く守る向き)
    const json = JSON.stringify({ a: `${PB}/sites/s/images/asset_aaaaaaaaaa.png`, b: "asset_aaaaaaaaaa", c: "hero_asset_bbbbbbbbbb", d: "images%2fasset_cccccccccc.png", e: "asset_short" });
    expect(extractAssetIds(json)).toEqual(["asset_aaaaaaaaaa", "asset_bbbbbbbbbb", "asset_cccccccccc"]);
  });

  it("publish_writes_asset_delivered_refs", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refaaaaaaa" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_refs" });
    await putChanges(owner.token, sid, eid, [imageChange(url)]);
    await runTest(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true);
    expect(await refsOf(sid)).toEqual([{ asset_id: "asset_refaaaaaaa", experiment_id: eid }]);
    // 2 回公開しても重ならない
    expect((await publish(owner.token, sid)).ok).toBe(true);
    expect(await refsOf(sid)).toEqual([{ asset_id: "asset_refaaaaaaa", experiment_id: eid }]);
  });

  it("refs_removed_on_experiment_delete", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refbbbbbbb" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_refdel" });
    await putChanges(owner.token, sid, eid, [imageChange(url)]);
    await runTest(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true);
    expect(await refsOf(sid)).toHaveLength(1);
    await sql`update experiments set status = 'archived', published_status = 'archived' where site_id = ${sid} and id = ${eid}`.execute(db());
    expect((await call("DELETE", `/sites/${sid}/experiments/${eid}`, { token: owner.token })).status).toBe(204);
    expect(await refsOf(sid)).toEqual([]);
  });

  it("publish_returns_state_changed_without_asset_refs_when_running_experiment_deleted_before_activation", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refccccccc" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_gone" });
    await putChanges(owner.token, sid, eid, [imageChange(url)]);
    await runTest(sid, eid);
    // compile の後・activation の batch の直前にエクスペリエンスを消す(外部キーの違反で batch ごと落ちない)
    const { DB } = countingD1(env.DB, { match: /insert or ignore into asset_delivered_refs/i, run: () => env.DB.prepare("delete from experiments where site_id = ?1 and id = ?2").bind(sid, eid).run() });
    const r = await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
    expect(r).toMatchObject({ ok: false, error: "state_changed" });
    expect(await refsOf(sid)).toEqual([]);
  });

  it("superseded_publish_writes_no_refs", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refddddddd" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_sup" });
    await putChanges(owner.token, sid, eid, [imageChange(url)]);
    await runTest(sid, eid);
    await sql`update sites set active_version = 999 where id = ${sid}`.execute(db());
    const r = await publishSite(testEnv, db(), await siteRow(sid), userActor(owner.userId));
    expect(r).toMatchObject({ ok: true, superseded: true });
    expect(await refsOf(sid)).toEqual([]);
  });

  it("delete_blocked_after_publish", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refeeeeeee" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_blk" });
    await putChanges(owner.token, sid, eid, [imageChange(url)]);
    await runTest(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true);
    await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]); // 下書きから外す
    const del = await call("DELETE", `/sites/${sid}/assets/asset_refeeeeeee`, { token: owner.token });
    expect(del.status).toBe(409);
    expect((await json<{ deliveredIn: string[] }>(del)).deliveredIn).toEqual([eid]);
  });
});

describe("publish guards images (spec §22.2)", () => {
  it("publish_passes_with_existing_assets", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await seedAssetRow(sid, { id: "asset_okaaaaaaaa" });
    const legacy = await seedAssetRow(sid, { id: "asset_okbbbbbbbb", url: `${PB}/sites/${sid}/experiments/exp_old/asset_okbbbbbbbb.jpg` });
    const c = await seedAssetRow(sid, { id: "asset_okcccccccc" });
    const d = await seedAssetRow(sid, { id: "asset_okdddddddd" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_ok" });
    // 新しいキー(IMAGE)・今あるキーと HTML の中の URL・CSS の url(…) の中の URL
    await putChanges(owner.token, sid, eid, [imageChange(a), htmlChange(`<img src="${legacy}"><img src='${c}'>`), cssChange(`.hero{background:url(${d})}`)]);
    await runDirect(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true);
  });

  it("publish_passes_with_pending_deletion_asset", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_pend" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${newKey(sid, "asset_pendaaaaaa")}">`)]);
    await runDirect(sid, eid);
    await seedAssetRow(sid, { id: "asset_pendaaaaaa", deletedAt: 1 }); // 削除待ち・印なし
    expect((await publish(owner.token, sid)).ok).toBe(true);
  });

  for (const [name, interrupt] of [
    ["publish_fails_asset_missing_when_row_purged_after_draft_read", (aid: string) => env.DB.prepare("delete from assets where id = ?1").bind(aid).run()],
    ["publish_fails_asset_missing_when_marked_after_draft_read", (aid: string) => env.DB.prepare("update assets set deleted_at = 1, purge_marked_at = 2 where id = ?1").bind(aid).run()],
  ] as const) {
    it(name, async () => {
      const owner = await setupOwner();
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const url = await seedAssetRow(sid, { id: "asset_raceaaaaaa" });
      const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_race" });
      await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]);
      await runDirect(sid, eid);
      expect((await publish(owner.token, sid)).ok).toBe(true); // v1
      // 下書きを読んだ後・手順 4 の前に Cron が割り込む
      const { DB } = countingD1(env.DB, { match: CONFIG_RECORD, run: () => interrupt("asset_raceaaaaaa") });
      const r = await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
      expect(r).toMatchObject({ ok: false, version: 2, error: "asset_missing" });
      expect(await env.CONFIG_KV.get(kvKeys.config(sid, 2))).toBeNull();
      expect((await publishRows(sid)).map((p) => [p.version, p.status, p.config_hash === null])).toEqual([
        [1, "active", false],
        [2, "failed", true],
      ]);
      expect((await siteRow(sid)).active_version).toBe(1);
    });
  }

  it("purge_mark_after_publish_step4_is_not_applied", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_keepaaaaaa" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_keep" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]);
    await runDirect(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true); // 手順 4 が先に確定した
    await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]); // 下書きの参照は外す(届きうる版の設定だけが残る)
    await sql`update assets set deleted_at = 1 where id = 'asset_keepaaaaaa'`.execute(db());
    expect(await cronMarkAndRestore("asset_keepaaaaaa", Date.now())).toEqual({ marked: 0, restored: 1 });
    const row = await db().selectFrom("assets").select(["deleted_at", "purge_marked_at", "kept_at"]).where("id", "=", "asset_keepaaaaaa").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ deleted_at: null, purge_marked_at: null });
    expect(row.kept_at).not.toBeNull();
  });

  it("publish_fails_on_tombstone", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // R2 は消えた・行は残る墓標(印の付いた行)
    const url = await seedAssetRow(sid, { id: "asset_tombaaaaaa", deletedAt: 1, purgeMarkedAt: 2 });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_tomb" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]);
    await runDirect(sid, eid);
    const r = await publish(owner.token, sid);
    expect(r).toMatchObject({ ok: false, error: "asset_missing" });
  });

  it("publish_fails_on_thumbnail_url_of_missing_asset", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_thumb" });
    const thumb = `${PB}/sites/${sid}/thumbs/asset_thumbaaaaa.webp`;
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${thumb}">`)]);
    await runDirect(sid, eid);
    const r = await publish(owner.token, sid);
    expect(r).toMatchObject({ ok: false, error: "asset_missing", assetProblems: [{ url: thumb, reason: "missing", experimentId: eid, variantId: "b", changeId: "c_html" }] });
  });

  it("publish_not_blocked_by_asset_like_words", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "asset_promo12345" });
    await putChanges(owner.token, sid, eid, [cssChange(".asset_background{color:red} .asset_abcdefghij{}"), htmlChange('<div class="asset_abcdefghij">x</div>')]);
    await runDirect(sid, eid);
    expect((await publish(owner.token, sid)).ok).toBe(true);
  });

  it("publish_fails_other_site_without_d1_read", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const other = `${PB}/sites/site_other/images/asset_otheraaaaa.png`;
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_other" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${other}"><img src="${newKey(sid, "asset_nonexistnt")}">`)]);
    await runDirect(sid, eid);
    const { DB, trips } = countingD1(env.DB);
    const r = await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
    expect(r).toMatchObject({ ok: false, error: "asset_other_site", assetProblems: [{ url: other, reason: "other_site", experimentId: eid, variantId: "b", changeId: "c_html" }] });
    expect(tripsMatching(trips, /from "?assets"? /i)).toBe(0); // assets を読まない(手順 4 の UPDATE にも届かない)
    expect(tripsMatching(trips, CONFIG_RECORD)).toBe(0);
  });

  it("publish_passes_with_foreign_base_urls", async () => {
    const { owner, sid } = await siteWith([htmlChange('<img src="https://cdn.example.org/sites/x/images/asset_foreignaaa.png">'), cssChange(".a{background:url(https://img.example.net/a.png)}")]);
    expect((await publish(owner.token, sid, WITH_UP)).ok).toBe(true);
  });

  it("publish_passes_with_own_site_uploader_url", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_up" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${UP}/u/${sid}/hero.png">`)]);
    await runDirect(sid, eid);
    const { DB, trips } = countingD1(env.DB);
    const r = await publishSite({ ...testEnv, ...WITH_UP, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
    expect(r.ok).toBe(true);
    expect(tripsMatching(trips, ASSET_READ)).toBe(0);
  });

  for (const [label, over] of [
    ["with r2", WITH_UP],
    ["without r2", { ...WITH_UP, ...NO_R2 }],
  ] as const) {
    it(`publish_fails_other_site_uploader_url_without_reads (${label})`, async () => {
      const owner = await setupOwner();
      for (const [i, change] of [
        htmlChange(`<img src="${UP}/u/site_other/a.png">`),
        attrSrc(`${UP}/u/site_other/b.png`),
        cssChange(`.x{background:url(${UP}/u/site_other/c.png)}`),
      ].entries()) {
        const { id: sid } = await createSite(owner.token, owner.workspaceId);
        const { id: eid } = await createExperiment(owner.token, sid, { id: `exp_upo${i}` });
        await putChanges(owner.token, sid, eid, [change]);
        await runDirect(sid, eid);
        const { DB, trips } = countingD1(env.DB);
        const r = await publishSite({ ...testEnv, ...over, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId));
        expect(r, change.type).toMatchObject({ ok: false, error: "asset_other_site", assetProblems: [{ reason: "other_site", experimentId: eid, changeId: change.id }] });
        expect(tripsMatching(trips, /from "?assets"? /i)).toBe(0);
      }
    });
  }

  it("publish_ignores_uploader_shape_without_uploader_base", async () => {
    const { owner, sid } = await siteWith([htmlChange(`<img src="${UP}/u/site_other/a.png">`)]);
    expect((await publish(owner.token, sid)).ok).toBe(true);
  });

  it("publish_skips_managed_extraction_without_r2", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_nor2" });
    // R2 なしでは管理する画像の URL(別のサイト・無い画像)を見ない
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${PB}/sites/site_other/images/asset_nor2aaaaaa.png"><img src="${newKey(sid, "asset_nor2bbbbbb")}">`)]);
    await runDirect(sid, eid);
    expect((await publish(owner.token, sid, NO_R2)).ok).toBe(true);
    // アップローダーの検査は動く
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${UP}/u/site_other/a.png">`)]);
    expect(await publish(owner.token, sid, { ...NO_R2, ...WITH_UP })).toMatchObject({ ok: false, error: "asset_other_site" });
  });

  it("publish_round_trips_unchanged", async () => {
    // 画像を使う公開と使わない公開で、成功の D1 の往復の数が同じ(取り出しは Worker の中・条件は手順 4 の UPDATE の中)
    const owner = await setupOwner();
    const count = async (changes: (sid: string) => Promise<unknown[]>) => {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_trip" });
      await putChanges(owner.token, sid, eid, await changes(sid));
      await runDirect(sid, eid);
      const { DB, trips } = countingD1(env.DB);
      expect((await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId))).ok).toBe(true);
      return trips;
    };
    const plain = await count(async () => [TEXT_CHANGE()]);
    const withImages = await count(async (sid) => [
      imageChange(await seedAssetRow(sid, { id: "asset_tripaaaaaa" })),
      htmlChange(`<img src="${await seedAssetRow(sid, { id: "asset_tripbbbbbb" })}">`),
    ]);
    expect(withImages.length).toBe(plain.length);
    expect(tripsMatching(withImages, CONFIG_RECORD)).toBe(1);
    expect(tripsMatching(withImages, ASSET_READ)).toBe(0);
  });

  it("publish_failure_includes_asset_problems", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const gone = newKey(sid, "asset_goneaaaaaa");
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_two" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${gone}">`, "c_h1"), cssChange(`.x{background:url(${gone})}`, "c_c1")]);
    await runDirect(sid, eid);
    const r = await publish(owner.token, sid);
    expect(r).toMatchObject({ ok: false, error: "asset_missing", message: "公開する内容に、見つからない画像があります" });
    expect(r.assetProblems).toEqual([
      { url: gone, reason: "missing", experimentId: eid, variantId: "b", changeId: "c_h1" },
      { url: gone, reason: "missing", experimentId: eid, variantId: "b", changeId: "c_c1" },
    ]);
  });

  it("publish_missing_reads_d1_once_more", async () => {
    const owner = await setupOwner();
    const ok = await (async () => {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const url = await seedAssetRow(sid, { id: "asset_onceaaaaaa" });
      const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_once" });
      await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]);
      await runDirect(sid, eid);
      const { DB, trips } = countingD1(env.DB);
      expect((await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId))).ok).toBe(true);
      return trips;
    })();
    expect(tripsMatching(ok, ASSET_READ)).toBe(0);
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_once" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${newKey(sid, "asset_oncebbbbbb")}">`)]);
    await runDirect(sid, eid);
    const { DB, trips } = countingD1(env.DB);
    expect(await publishSite({ ...testEnv, DB }, getDb({ ...env, DB } as Env), await siteRow(sid), userActor(owner.userId))).toMatchObject({ ok: false, error: "asset_missing" });
    expect(tripsMatching(trips, ASSET_READ)).toBe(1);
    // 手順 4 の 0 行の後は、読み 1 回と失敗の記録 1 回だけ(KV の後始末・activation は無い)
    const after = trips.slice(trips.findIndex((t) => CONFIG_RECORD.test(t)) + 1);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatch(ASSET_READ);
    expect(after[1]).toMatch(/update "publishes" set "status"/i);
  });

  it("failure_messages_have_asset_missing_and_other_site", async () => {
    const owner = await setupOwner();
    for (const [html, error, hint] of [
      [(sid: string) => `<img src="${newKey(sid, "asset_msgaaaaaaa")}">`, "asset_missing", "次の画像が見つからないため公開できません。パターンの変更から外すか、別の画像を選び直してください"],
      [() => `<img src="${PB}/sites/site_other/images/asset_msgbbbbbbb.png">`, "asset_other_site", "別のサイトの画像は使えません。このサイトに画像をアップロードして、その画像に差し替えてください"],
    ] as const) {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_msg" });
      await putChanges(owner.token, sid, eid, [htmlChange(html(sid))]);
      await runDirect(sid, eid);
      const r = await publish(owner.token, sid);
      expect(r).toMatchObject({ ok: false, error, hint });
      expect(PRIVATE_REF.exec(JSON.stringify(r))?.[0]).toBeUndefined();
    }
  });
});

describe("kv put failure after the config record (spec §22.2 手順 5)", () => {
  const deployEnv = (over: Partial<Env> = {}): Env => ({ ...testEnv, DEPLOYER: fakeDeployer(), ...over });

  it("kv_put_failed_row_is_cleaned_by_cleanup_old_versions", async () => {
    const { owner, sid } = await siteWith([TEXT_CHANGE()]);
    const t0 = Date.now();
    expect((await publishSite(deployEnv(), db(), await siteRow(sid), userActor(owner.userId), t0)).ok).toBe(true); // v1
    const failed = await publishSite(deployEnv({ CONFIG_KV: failingKv(/config:v2$/) }), db(), await siteRow(sid), userActor(owner.userId), t0 + 1000);
    expect(failed).toMatchObject({ ok: false, version: 2, error: "kv_put_failed" });
    expect((await publishRows(sid))[1]).toMatchObject({ version: 2, status: "failed", kv_deleted: 0 });
    expect((await publishRows(sid))[1]!.config_hash).not.toBeNull(); // 手順 4 が先に書いた
    // 掃除は配信ファイルの出し直しの前に走るので、v3 の掃除の時点ではまだ v1 を配っている(v2 は「配っている版以上」で残る)。v4 の掃除が v2 を消す
    expect((await publishSite(deployEnv(), db(), await siteRow(sid), userActor(owner.userId), t0 + 600_000)).ok).toBe(true);
    expect((await publishRows(sid)).find((p) => p.version === 2)).toMatchObject({ kv_deleted: 0 });
    expect((await publishSite(deployEnv(), db(), await siteRow(sid), userActor(owner.userId), t0 + 601_000)).ok).toBe(true);
    expect((await publishRows(sid)).find((p) => p.version === 2)).toMatchObject({ kv_deleted: 1 });
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, 2))).toBeNull();
  });

  it("kv_put_failed_version_keeps_its_images", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_kvfailaaaa" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_kvf" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${url}">`)]);
    await runDirect(sid, eid);
    expect(await publish(owner.token, sid, { CONFIG_KV: failingKv(/config:v1$/) })).toMatchObject({ ok: false, error: "kv_put_failed" });
    await putChanges(owner.token, sid, eid, [TEXT_CHANGE()]);
    await sql`update assets set deleted_at = 1 where id = 'asset_kvfailaaaa'`.execute(db());
    // 失敗した版の行(config_hash あり・kv_deleted = 0)が届きうる版に入るので、Cron は印を付けない
    expect((await cronMarkAndRestore("asset_kvfailaaaa", Date.now())).marked).toBe(0);
  });
});

describe("publish preview reports asset problems (spec §22.5)", () => {
  const preview = async (token: string, sid: string, over?: Partial<Env>, query = "") =>
    json<{ assetProblems: unknown[]; compileError: unknown; overlaps: unknown[] }>(await call("GET", `/sites/${sid}/publish-preview${query}`, { token, envOverride: over }));

  it("publish_preview_reports_asset_problems", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const gone = newKey(sid, "asset_prevaaaaaa");
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_prev" });
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${gone}">`)]);
    await runDirect(sid, eid);
    const p = await preview(owner.token, sid);
    const r = await publish(owner.token, sid);
    expect(r.ok).toBe(false);
    expect(p.assetProblems).toEqual(r.assetProblems);
    expect(p.assetProblems).toEqual([{ url: gone, reason: "missing", experimentId: eid, variantId: "b", changeId: "c_html" }]);
  });

  it("publish_preview_skips_d1_without_managed_urls", async () => {
    const { owner, sid } = await siteWith([TEXT_CHANGE()]);
    const { DB, trips } = countingD1(env.DB);
    const p = await preview(owner.token, sid, { DB });
    expect(p.assetProblems).toEqual([]);
    expect(tripsMatching(trips, ASSET_READ)).toBe(0);
    // 管理する画像の URL があるときだけ 1 回
    const owner2 = owner;
    const { id: sid2 } = await createSite(owner2.token, owner2.workspaceId);
    const url = await seedAssetRow(sid2, { id: "asset_prevbbbbbb" });
    const { id: eid2 } = await createExperiment(owner2.token, sid2, { id: "exp_prev2" });
    await putChanges(owner2.token, sid2, eid2, [htmlChange(`<img src="${url}">`)]);
    await runDirect(sid2, eid2);
    const c2 = countingD1(env.DB);
    expect((await preview(owner2.token, sid2, { DB: c2.DB })).assetProblems).toEqual([]);
    expect(tripsMatching(c2.trips, ASSET_READ)).toBe(1);
  });

  it("publish_preview_starting_unchanged", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 下書きのエクスペリエンスの壊れた参照は、starting を付けても assetProblems に入らない(starting は重なりだけに効く)
    const { id: draft } = await createExperiment(owner.token, sid, { id: "exp_draft" });
    await putChanges(owner.token, sid, draft, [htmlChange(`<img src="${newKey(sid, "asset_draftaaaaa")}">`)]);
    const { id: live } = await createExperiment(owner.token, sid, { id: "exp_live" });
    await putChanges(owner.token, sid, live, [htmlChange(`<img src="${newKey(sid, "asset_liveaaaaaa")}">`)]);
    await runDirect(sid, live);
    const plain = await preview(owner.token, sid);
    const starting = await preview(owner.token, sid, undefined, `?starting=${draft}`);
    expect(plain.assetProblems).toEqual([{ url: newKey(sid, "asset_liveaaaaaa"), reason: "missing", experimentId: live, variantId: "b", changeId: "c_html" }]);
    expect(starting.assetProblems).toEqual(plain.assetProblems);
  });

  it("publish_preview_reports_other_site_uploader_url_without_r2", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_pup" });
    const other = `${UP}/u/site_other/a.png`;
    await putChanges(owner.token, sid, eid, [htmlChange(`<img src="${other}"><img src="${UP}/u/${sid}/mine.png">`)]);
    await runDirect(sid, eid);
    const { DB, trips } = countingD1(env.DB);
    const p = await preview(owner.token, sid, { ...NO_R2, ...WITH_UP, DB });
    expect(p.assetProblems).toEqual([{ url: other, reason: "other_site", experimentId: eid, variantId: "b", changeId: "c_html" }]);
    expect(tripsMatching(trips, ASSET_READ)).toBe(0);
  });
});

describe("uploader url normalization at publish (spec §22.3)", () => {
  let owner: Awaited<ReturnType<typeof setupOwner>> | null = null;
  const failsWith = async (html: (sid: string) => string) => {
    owner ??= await setupOwner();
    const o = owner;
    const { id: sid } = await createSite(o.token, o.workspaceId);
    const { id: eid } = await createExperiment(o.token, sid, { id: "exp_norm" });
    await putChanges(o.token, sid, eid, [htmlChange(html(sid))]);
    await runDirect(sid, eid);
    return publish(o.token, sid, WITH_UP);
  };
  beforeEach(() => {
    owner = null; // テストごとに D1 が戻るので、ログインも作り直す
  });

  it("publish_fails_other_site_uploader_url_with_dot_segments", async () => {
    expect(await failsWith((sid) => `<img src="${UP}/u/${sid}/../site_other/x.png">`)).toMatchObject({ ok: false, error: "asset_other_site" });
    expect(await failsWith((sid) => `<img src="${UP}/u/${sid}/%2e%2e/site_other/x.png">`)).toMatchObject({ ok: false, error: "asset_other_site" });
  });

  it("publish_fails_other_site_uploader_url_with_uppercase_host", async () => {
    expect(await failsWith(() => `<img src="https://UP.EXAMPLE.COM/u/site_other/x.png">`)).toMatchObject({ ok: false, error: "asset_other_site" });
  });

  it("publish_passes_encoded_uploader_url", async () => {
    // 文字参照で区切りを書いた形は候補に当たらず通る(受け入れる形の表明)
    expect((await failsWith(() => `<img src="https://up.example.com&#47;u&#47;site_other&#47;x.png">`)).ok).toBe(true);
  });
});
