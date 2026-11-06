import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { call, createExperiment, createSite, experimentRow, json, publishRes, runDirect, seedAssetRow, setupOwner, siteRow, TEXT_CHANGE } from "./helpers";
import { ASSET_READ, COMPILE_INPUT_READ, CONFIG_RECORD, countingD1, tripsMatching } from "./d1-trips";
import { runHousekeeping } from "./housekeeping-helpers";

// B68 Task 4(spec §22.2 の「状態を変える口」・§22.5・§22.9。Q264・Q266): 開始・再開は CAS の前に画像を確かめ、止める操作は確かめない

const PB = env.AB_ASSET_PUBLIC_BASE as string;
const UP = "https://up.example.com";
const WITH_UP: Partial<Env> = { AB_UPLOADER_PUBLIC_BASE: UP };
const PRIVATE_REF = /決定 ?[0-9]+|spec ?§|§ ?[0-9]|Plan ?[0-9]+|Task ?[0-9]+|superpowers\/|docs\/dev\/|1 号サイト/u;

const db = () => getDb(env);
const newKey = (sid: string, aid: string) => `${PB}/sites/${sid}/images/${aid}.png`;
const htmlChange = (html: string, id = "c_html") => ({ id, type: "HTML", selector: ".box", payload: { html, position: "append", runScripts: false } });
const cssChange = (css: string, id = "c_css") => ({ id, type: "CSS", payload: { css } });
const attrSrc = (value: string, id = "c_attr") => ({ id, type: "ATTRIBUTE", selector: "img.side", payload: { name: "src", value } });

type Owner = Awaited<ReturnType<typeof setupOwner>>;
async function putChanges(token: string, sid: string, eid: string, body: unknown[]) {
  const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
}
/** 状態 status のエクスペリエンス(パターン b に changes) */
async function exp(owner: Owner, sid: string, id: string, changes: unknown[], status: "draft" | "running" | "paused" = "draft") {
  await createExperiment(owner.token, sid, { id });
  await putChanges(owner.token, sid, id, changes.length > 0 ? changes : [TEXT_CHANGE()]);
  if (status !== "draft") await runDirect(sid, id, status);
  return id;
}
const setStatus = (token: string, sid: string, eid: string, status: string, over?: Partial<Env>) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride: over });
const publishCount = async (sid: string) => (await db().selectFrom("publishes").select("id").where("site_id", "=", sid).execute()).length;
type StatusBody = { experiment: { status: string }; publish: { ok: boolean; error?: string; version?: number | null; assetProblems?: unknown[] } };

describe("start / resume guard before the status CAS (Q264)", () => {
  for (const from of ["draft", "paused"] as const) {
    it(`start_or_resume_rejected_before_cas_when_other_running_experiment_points_to_missing_image (${from})`, async () => {
      const owner = await setupOwner();
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const url = await seedAssetRow(sid, { id: "asset_purgingaaa", deletedAt: 1, purgeMarkedAt: 2 }); // 消す途中
      const b = await exp(owner, sid, "exp_b", [htmlChange(`<img src="${url}">`)], "running");
      const a = await exp(owner, sid, "exp_a", [], from);
      const before = await experimentRow(sid, a);
      const pubs = await publishCount(sid);
      const res = await setStatus(owner.token, sid, a, "running");
      expect(res.status).toBe(409);
      const body = await json<{ error: string; assetProblems: unknown[] }>(res);
      expect(body).toMatchObject({ error: "asset_missing", message: "画像の確かめに通らないため、状態を変えませんでした" });
      expect(body.assetProblems).toEqual([{ url, reason: "missing", experimentId: b, variantId: "b", changeId: "c_html" }]);
      const after = await experimentRow(sid, a);
      expect(after.status).toBe(from);
      expect(after.updated_at).toBe(before.updated_at);
      expect(await publishCount(sid)).toBe(pubs); // 予約行も足さない(公開が走らない)
    });
  }

  it("start_or_resume_rejected_for_other_site_url", async () => {
    const owner = await setupOwner();
    for (const ref of [`${PB}/sites/site_other/images/asset_otheraaaaa.png`, `${UP}/u/site_other/x.png`]) {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      await exp(owner, sid, "exp_b", [htmlChange(`<img src="${ref}">`)], "running");
      const a = await exp(owner, sid, "exp_a", []);
      const { DB, trips } = countingD1(env.DB);
      const res = await setStatus(owner.token, sid, a, "running", { ...WITH_UP, DB });
      expect(res.status, ref).toBe(409);
      expect(await json(res)).toMatchObject({ error: "asset_other_site", assetProblems: [{ url: ref, reason: "other_site", experimentId: "exp_b" }] });
      expect(tripsMatching(trips, ASSET_READ)).toBe(0); // assets を読まない
      expect((await experimentRow(sid, a)).status).toBe("draft");
    }
  });

  it("status_change_start_rejected_when_target_has_problem", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await exp(owner, sid, "exp_a", [cssChange(`.x{background:url(${newKey(sid, "asset_selfaaaaaa")})}`)]);
    const res = await setStatus(owner.token, sid, a, "running");
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "asset_missing", assetProblems: [{ experimentId: a, changeId: "c_css" }] });
    expect((await experimentRow(sid, a)).status).toBe("draft");
  });

  it("status_change_extra_d1_read_only_when_managed_urls_exist", async () => {
    const owner = await setupOwner();
    // 管理する画像の URL が無い compile では assets を読まない
    const { id: s1 } = await createSite(owner.token, owner.workspaceId);
    const a1 = await exp(owner, s1, "exp_a", []);
    const c1 = countingD1(env.DB);
    expect((await setStatus(owner.token, s1, a1, "running", { DB: c1.DB })).status).toBe(200);
    expect(tripsMatching(c1.trips, ASSET_READ)).toBe(0);
    expect(tripsMatching(c1.trips, COMPILE_INPUT_READ)).toBe(2); // CAS の前の確かめ + 公開
    // ある compile では 1 回だけ(公開は手順 4 の UPDATE の条件で見るので、読みは足さない)
    const { id: s2 } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(s2, { id: "asset_existaaaaa" });
    const a2 = await exp(owner, s2, "exp_a", [htmlChange(`<img src="${url}">`)]);
    const c2 = countingD1(env.DB);
    const res = await setStatus(owner.token, s2, a2, "running", { DB: c2.DB });
    expect(res.status).toBe(200);
    expect((await json<StatusBody>(res)).publish.ok).toBe(true);
    expect(tripsMatching(c2.trips, ASSET_READ)).toBe(1);
  });

  it("status_change_skips_guard_without_r2_and_uploader", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await exp(owner, sid, "exp_a", [htmlChange(`<img src="${newKey(sid, "asset_nor2aaaaaa")}">`)]);
    const { DB, trips } = countingD1(env.DB);
    const res = await setStatus(owner.token, sid, a, "running", { ASSETS: undefined, DB });
    expect(res.status).toBe(200);
    expect(tripsMatching(trips, COMPILE_INPUT_READ)).toBe(1); // 公開の 1 回だけ(CAS の前に compile の入力を読まない)
    expect(tripsMatching(trips, ASSET_READ)).toBe(0);
  });

  it("status_change_compile_error_is_not_rejected_by_guard", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await exp(owner, sid, "exp_b", [], "running");
    // 保存の検査を通らない形(無いオーディエンスの参照)を直接入れる。compile は CompileError で落ちる
    await sql`update experiments set targeting_json = ${JSON.stringify({ audience: "aud_missing" })} where site_id = ${sid} and id = 'exp_b'`.execute(db());
    const a = await exp(owner, sid, "exp_a", []);
    const res = await setStatus(owner.token, sid, a, "running");
    expect(res.status).toBe(200);
    const body = await json<StatusBody>(res);
    expect(body.experiment.status).toBe("running");
    expect(body.publish).toMatchObject({ ok: false, error: "unknown_audience" });
  });

  it("start_publish_asset_missing_after_guard_keeps_previous_config", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_raceaaaaaa" });
    await exp(owner, sid, "exp_b", [htmlChange(`<img src="${url}">`)], "running");
    expect((await json<{ ok: boolean }>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const a = await exp(owner, sid, "exp_a", []);
    // 確かめ(CAS の前)の後・公開の手順 4 の前に Cron が印を付ける
    const { DB } = countingD1(env.DB, { match: CONFIG_RECORD, run: () => env.DB.prepare("update assets set deleted_at = 1, purge_marked_at = 2 where id = 'asset_raceaaaaaa'").run() });
    const res = await setStatus(owner.token, sid, a, "running", { DB });
    expect(res.status).toBe(200);
    const body = await json<StatusBody>(res);
    expect(body.experiment.status).toBe("running");
    expect(body.publish).toMatchObject({ ok: false, version: 2, error: "asset_missing", assetProblems: [{ url, reason: "missing", experimentId: "exp_b" }] });
    expect((await siteRow(sid)).active_version).toBe(1);
  });

  it("status_change_409_hint_has_no_private_refs", async () => {
    const owner = await setupOwner();
    for (const [ref, error] of [
      [(sid: string) => newKey(sid, "asset_hintaaaaaa"), "asset_missing"],
      [() => `${PB}/sites/site_other/images/asset_hintbbbbbb.png`, "asset_other_site"],
    ] as const) {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      const a = await exp(owner, sid, "exp_a", [htmlChange(`<img src="${ref(sid)}">`)]);
      const res = await setStatus(owner.token, sid, a, "running");
      expect(res.status).toBe(409);
      const body = await json<{ error: string; hint: string }>(res);
      expect(body.error).toBe(error);
      expect(body.hint).toMatch(/状態は変わっていません。直してからもう一度操作してください$/);
      expect(PRIVATE_REF.exec(JSON.stringify(body))?.[0]).toBeUndefined();
    }
  });
});

describe("stop operations skip the image guard (Q266)", () => {
  /** 実行中の B に、消す途中の画像・行を消した画像・別のサイトの R2 の URL・別のサイトのアップローダーの URL を書いた変更 */
  const brokenRefs = (sid: string) => {
    const refs = [newKey(sid, "asset_markedaaaa"), newKey(sid, "asset_deletedaaa"), `${PB}/sites/site_other/images/asset_otheraaaaa.png`, `${UP}/u/site_other/x.png`];
    return { refs, changes: [htmlChange(`<img src="${refs[0]}"><img src="${refs[1]}">`), attrSrc(refs[2]!), cssChange(`.x{background:url(${refs[3]})}`)] };
  };

  for (const [from, to] of [
    ["running", "paused"],
    ["running", "archived"],
    ["paused", "archived"],
  ] as const) {
    it(`stop_passes_despite_other_running_experiment_broken_refs (${from} -> ${to})`, async () => {
      const owner = await setupOwner();
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      await seedAssetRow(sid, { id: "asset_markedaaaa", deletedAt: 1, purgeMarkedAt: 2 });
      const { refs, changes } = brokenRefs(sid);
      await exp(owner, sid, "exp_b", changes, "running");
      const a = await exp(owner, sid, "exp_a", [], from);
      const res = await setStatus(owner.token, sid, a, to, WITH_UP);
      expect(res.status).toBe(200);
      const body = await json<StatusBody>(res);
      expect(body.experiment.status).toBe(to);
      expect(body.publish).toMatchObject({ ok: true, version: 1 });
      expect((await siteRow(sid)).active_version).toBe(1);
      const cfg = (await db().selectFrom("publishes").select("config_json").where("site_id", "=", sid).where("version", "=", 1).executeTakeFirstOrThrow()).config_json!;
      for (const r of refs) expect(cfg).toContain(r);
    });
  }

  it("stop_passes_with_two_offending_running_experiments", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await exp(owner, sid, "exp_b1", [htmlChange(`<img src="${newKey(sid, "asset_gone1aaaaa")}">`)], "running");
    await exp(owner, sid, "exp_b2", [htmlChange(`<img src="${PB}/sites/site_other/images/asset_gone2aaaaa.png">`)], "running");
    for (const id of ["exp_b1", "exp_b2"]) {
      const res = await setStatus(owner.token, sid, id, "paused");
      expect(res.status, id).toBe(200);
      expect((await json<StatusBody>(res)).publish.ok, id).toBe(true);
    }
  });

  it("stop_has_no_extra_reads_and_single_compile", async () => {
    const owner = await setupOwner();
    const pause = async (over: Partial<Env>) => {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      await exp(owner, sid, "exp_b", [htmlChange(`<img src="${newKey(sid, "asset_stopaaaaaa")}">`)], "running");
      const a = await exp(owner, sid, "exp_a", [], "running");
      const { DB, trips } = countingD1(env.DB);
      const res = await setStatus(owner.token, sid, a, "paused", { ...over, DB });
      expect(res.status).toBe(200);
      expect((await json<StatusBody>(res)).publish.ok).toBe(true);
      return trips;
    };
    const guarded = await pause(WITH_UP); // R2 とアップローダーがある導入
    const plain = await pause({ ASSETS: undefined }); // 確かめそのものが無い導入
    expect(tripsMatching(guarded, COMPILE_INPUT_READ)).toBe(1); // compile は公開の 1 回だけ
    expect(tripsMatching(guarded, ASSET_READ)).toBe(0);
    expect(guarded.length).toBe(plain.length); // D1 の呼び出しの数が確かめの無い状態の変更と同じ
  });

  it("stop_publish_writes_config_without_image_condition", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_markedbbbb", deletedAt: 1, purgeMarkedAt: 2 });
    await exp(owner, sid, "exp_b", [htmlChange(`<img src="${url}">`)], "running");
    const a = await exp(owner, sid, "exp_a", [], "running");
    const res = await setStatus(owner.token, sid, a, "paused");
    expect((await json<StatusBody>(res)).publish.ok).toBe(true);
    const row = await db().selectFrom("publishes").select(["status", "config_json"]).where("site_id", "=", sid).where("version", "=", 1).executeTakeFirstOrThrow();
    expect(row.status).toBe("active"); // 手順 4 の UPDATE が 1 行になった
    expect(row.config_json).toContain("asset_markedbbbb");
  });

  it("stop_publish_still_writes_asset_delivered_refs", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_refsaaaaaa" });
    await exp(owner, sid, "exp_b", [{ id: "c_img", type: "IMAGE", selector: "img.hero", payload: { src: url } }], "running");
    await sql`update experiments set run_id = 'run_stoprefs1' where site_id = ${sid} and id = 'exp_b'`.execute(db());
    const a = await exp(owner, sid, "exp_a", [], "running");
    expect((await json<StatusBody>(await setStatus(owner.token, sid, a, "paused"))).publish.ok).toBe(true);
    const refs = await db().selectFrom("asset_delivered_refs").select(["asset_id", "experiment_id"]).where("site_id", "=", sid).execute();
    expect(refs).toEqual([{ asset_id: "asset_refsaaaaaa", experiment_id: "exp_b" }]);
  });

  it("normal_publish_after_stop_still_guards", async () => {
    const owner = await setupOwner();
    for (const [ref, error] of [
      [(sid: string) => newKey(sid, "asset_aftraaaaaa"), "asset_missing"],
      [() => `${UP}/u/site_other/x.png`, "asset_other_site"],
    ] as const) {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      await exp(owner, sid, "exp_b", [htmlChange(`<img src="${ref(sid)}">`)], "running");
      const a = await exp(owner, sid, "exp_a", [], "running");
      const c = await exp(owner, sid, "exp_c", []);
      expect((await json<StatusBody>(await setStatus(owner.token, sid, a, "paused", WITH_UP))).publish.ok).toBe(true);
      expect(await json(await publishRes(owner.token, sid, WITH_UP))).toMatchObject({ ok: false, error });
      const start = await setStatus(owner.token, sid, c, "running", WITH_UP);
      expect(start.status).toBe(409);
      expect((await json<{ error: string }>(start)).error).toBe(error);
    }
  });

  // Task 4 から移した(controller の Ruling): 止める操作の公開が、削除待ちで印の無い画像を指す設定を書いた後の Cron の回で、その画像に印が付かず戻る
  it("stop_publish_keeps_unmarked_pending_image_via_cron", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const url = await seedAssetRow(sid, { id: "asset_pendstopaa", deletedAt: 1 }); // 削除待ち・印なし(猶予は過ぎている)
    await exp(owner, sid, "exp_b", [htmlChange(`<img src="${url}">`)], "running");
    const a = await exp(owner, sid, "exp_a", [], "running");
    expect((await json<StatusBody>(await setStatus(owner.token, sid, a, "paused"))).publish.ok).toBe(true);
    // 下書きの参照でも戻るので、B の下書きから参照を外し、届きうる版の設定だけで戻ることを見る
    await putChanges(owner.token, sid, "exp_b", [TEXT_CHANGE()]);
    await runHousekeeping();
    const row = await db().selectFrom("assets").select(["deleted_at", "purge_marked_at", "kept_at"]).where("id", "=", "asset_pendstopaa").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ deleted_at: null, purge_marked_at: null });
    expect(row.kept_at).not.toBeNull();
  });
});
