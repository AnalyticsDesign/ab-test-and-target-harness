import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  beforeD1Batch,
  call,
  countingD1,
  createExperiment,
  createSite,
  experimentRow,
  failingD1Insert,
  json,
  runDirect,
  setupOwner,
  TEXT_CHANGE,
} from "./helpers";
import { recordingSite, resultsOverride, setStatus, startTest, type Owner } from "./results-fixtures";

/**
 * B129 Task 6(spec §3.1 の区分 content のうちエクスペリエンス・§3.2・§5.1・§5.2): エクスペリエンスの操作は、操作と同じ batch に記録の文を入れる。
 * 記録の文は操作の文の前に置き、前の値を同じ文で読み、guard は操作の文と同じ条件(Review Focus 1)。通ったときだけ 1 行、
 * 断られた(409・404・422)・同時の要求に負けたときは 0 行。往復は変えない(1 文の execute だった所は 2 文の batch)
 */

type Row = {
  id: number;
  category: string;
  action: string;
  workspace_id: string | null;
  site_id: string | null;
  experiment_id: string | null;
  site_generation: string | null;
  experiment_generation: string | null;
  via: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail_json: string;
};
type Event = Row & { detail: Record<string, unknown> };
const events = async (action?: string): Promise<Event[]> =>
  (
    await (action === undefined
      ? env.DB.prepare(`select * from audit_events where category = 'content' order by id`)
      : env.DB.prepare(`select * from audit_events where action = ?1 order by id`).bind(action)
    ).all<Row>()
  ).results.map((r) => ({ ...r, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));

const urlMatch = { op: "contains", value: "/" };
/** オーナーとサイト・テストの下書き(名前 Hero。a = オリジナル / b) */
async function draft(eid = "exp_a"): Promise<{ owner: Owner; sid: string; eid: string; base: string }> {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  await createExperiment(owner.token, sid, { id: eid, name: "Hero" });
  return { owner, sid, eid, base: `/sites/${sid}/experiments/${eid}` };
}
const generationOf = async (sid: string, eid: string) => (await experimentRow(sid, eid)).generation;
const siteGenerationOf = async (sid: string) => (await env.DB.prepare(`select generation from sites where id = ?1`).bind(sid).first<{ generation: string }>())!.generation;
const deleteRow = (sid: string, eid: string) => env.DB.prepare(`delete from experiments where site_id = ?1 and id = ?2`).bind(sid, eid).run();

describe("experiment.create / duplicate / delete", () => {
  it("create_records_kind", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const res = await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_p", name: "Promo", kind: "single", urlMatch } });
    expect(res.status).toBe(201);
    const [e, ...rest] = await events("experiment.create");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      category: "content",
      workspace_id: owner.workspaceId,
      site_id: sid,
      experiment_id: "exp_p",
      via: "google",
      actor_user_id: owner.userId,
      target_type: "experiment",
      target_id: "exp_p",
      target_label: "Promo",
      detail: { kind: "single" },
    });
    // 既に使われている ID(409)では記録しない
    expect((await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_p", name: "Promo", urlMatch } })).status).toBe(409);
    expect(await events("experiment.create")).toHaveLength(1);
  });

  it("create_sets_generation (Q14)", async () => {
    const { owner, sid, eid, base } = await draft();
    const first = await generationOf(sid, eid);
    expect((await call("POST", `${base}/duplicate`, { token: owner.token, body: { mode: "same", id: "exp_copy" } })).status).toBe(201);
    const [created] = await events("experiment.create");
    const [dup] = await events("experiment.duplicate");
    expect(created!.experiment_generation).toBe(first);
    expect(dup!.experiment_generation).toBe(await generationOf(sid, "exp_copy"));
    expect(dup!.experiment_generation).not.toBe(first);
    // 同じ ID で作り直すと新しい値(下書きの削除は ID を退役させない)
    expect((await call("DELETE", base, { token: owner.token })).status).toBe(204);
    await createExperiment(owner.token, sid, { id: eid });
    const second = await generationOf(sid, eid);
    expect(second).not.toBe(first);
    expect((await events("experiment.create")).map((e) => e.experiment_generation)).toEqual([first, second]);
    // 削除の記録は、削除の前の行(前の世代)から読む
    const [deleted] = await events("experiment.delete");
    expect(deleted!.experiment_generation).toBe(first);
  });

  it("duplicate_records_source", async () => {
    const { owner, sid, eid, base } = await draft();
    const res = await call("POST", `${base}/duplicate`, { token: owner.token, body: { mode: "variant", variantId: "b", name: "B だけ" } });
    expect(res.status).toBe(201);
    const copy = await json<{ id: string }>(res);
    const [e, ...rest] = await events("experiment.duplicate");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: copy.id, target_type: "experiment", target_id: copy.id, target_label: "B だけ", detail: { source: eid } });
    // 複製の途中で元が変わった(409 duplicate_source_changed)ときは記録しない
    const racing = beforeD1Batch(env.DB, () => env.DB.prepare(`update experiments set updated_at = updated_at + 1 where site_id = ?1 and id = ?2`).bind(sid, eid).run());
    const changed = await call("POST", `${base}/duplicate`, { token: owner.token, body: { mode: "same" }, envOverride: { DB: racing } });
    expect(changed.status).toBe(409);
    expect((await json(changed)).error).toBe("duplicate_source_changed");
    expect(await events("experiment.duplicate")).toHaveLength(1);
  });

  it("delete_records_name", async () => {
    const { owner, sid, eid, base } = await draft();
    expect((await call("DELETE", base, { token: owner.token })).status).toBe(204);
    const [e, ...rest] = await events("experiment.delete");
    expect(rest).toEqual([]);
    // 消えた後も対象の控えに名前が残る
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: {} });
    // 配信中(409 experiment_active)では記録しない
    await createExperiment(owner.token, sid, { id: "exp_live" });
    await runDirect(sid, "exp_live");
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_live`, { token: owner.token })).status).toBe(409);
    expect(await events("experiment.delete")).toHaveLength(1);
  });

  it("delete_concurrent_second_writes_no_event", async () => {
    const { owner, base } = await draft();
    const racing = beforeD1Batch(env.DB, async () => {
      expect((await call("DELETE", base, { token: owner.token })).status).toBe(204);
    });
    expect((await call("DELETE", base, { token: owner.token, envOverride: { DB: racing } })).status).toBe(404);
    expect(await events("experiment.delete")).toHaveLength(1);
  });

  it("delete_started_after_read_writes_no_event", async () => {
    // 読んだ後に開始された(削除の条件 status in (draft, archived) が偽 → 409)
    const { owner, sid, eid, base } = await draft();
    const racing = beforeD1Batch(env.DB, () => runDirect(sid, eid));
    expect((await call("DELETE", base, { token: owner.token, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("experiment.delete")).toEqual([]);
  });
});

describe("experiment.update / memo", () => {
  it("patch_records_changed_fields", async () => {
    const { owner, sid, eid, base } = await draft();
    const res = await call("PATCH", base, { token: owner.token, body: { trafficPercentage: 40, name: "Hero 2" } });
    expect(res.status).toBe(200);
    const [e, ...rest] = await events("experiment.update");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      site_id: sid,
      experiment_id: eid,
      target_type: "experiment",
      target_id: eid,
      target_label: "Hero",
      detail: { fields: ["name", "trafficPercentage"], name: { from: "Hero", to: "Hero 2" }, trafficPercentage: { from: 100, to: 40 } },
    });
    // 配信条件は名前だけ(値は持たない)、割当の固定は前後
    const targeting = { ctx: "device", op: "in", value: ["mobile"] };
    expect((await call("PATCH", base, { token: owner.token, body: { targeting, persistAssignment: true } })).status).toBe(200);
    const [, e2] = await events("experiment.update");
    expect(e2!.detail).toEqual({ fields: ["targeting", "persistAssignment"], persistAssignment: { from: false, to: true } });
    expect(e2!.detail_json).not.toContain("mobile");
    expect(e2!.target_label).toBe("Hero 2");
  });

  /** B129 final review(R64): 値が変わった欄だけ(全部の欄を送る保存でも、変えていない欄は並ばない) */
  it("patch_records_only_changed_fields (final review)", async () => {
    const { owner, sid, eid, base } = await draft();
    const analytics = { overrides: { experimentName: "hero" }, extra: { team: "web" } };
    expect((await call("PATCH", base, { token: owner.token, body: { analytics } })).status).toBe(200);
    const cur = await json<Record<string, unknown>>(await call("GET", base, { token: owner.token }));
    const full = (over: Record<string, unknown> = {}) => ({
      ...Object.fromEntries(["name", "urlMatch", "targeting", "trafficPercentage", "persistAssignment", "analytics", "description"].map((k) => [k, cur[k]])),
      ...over,
    });
    const patch = async (body: unknown) => expect((await call("PATCH", base, { token: owner.token, body })).status).toBe(200);
    // (1) 1 欄だけ変えて全部の欄を送る (2) 同じ値の送り直し (3) 長い値の欄(配信条件・対象 URL)の変更は名前だけ
    await patch(full({ trafficPercentage: 40 }));
    await patch(full({ trafficPercentage: 40 }));
    await patch(full({ trafficPercentage: 40, urlMatch: { op: "contains", value: "/lp" }, targeting: { ctx: "device", op: "in", value: ["mobile"] } }));
    // (4) 保存してある外部計測の JSON の鍵の順だけが違う(同じ値の送り直しは変わらず)
    await env.DB.prepare(`update experiments set analytics_json = ?1 where site_id = ?2 and id = ?3`)
      .bind(JSON.stringify({ extra: { team: "web" }, overrides: { experimentName: "hero" } }), sid, eid)
      .run();
    await patch(full({ trafficPercentage: 40, urlMatch: { op: "contains", value: "/lp" }, targeting: { ctx: "device", op: "in", value: ["mobile"] } }));
    const rows = (await events("experiment.update")).slice(1);
    expect(rows.map((e) => e.detail)).toEqual([
      { fields: ["trafficPercentage"], trafficPercentage: { from: 100, to: 40 } },
      { fields: [] },
      { fields: ["urlMatch", "targeting"] },
      { fields: [] },
    ]);
  });

  it("memo_only_patch_is_memo_action", async () => {
    const { owner, sid, eid, base } = await draft();
    expect((await call("PATCH", base, { token: owner.token, body: { description: "経緯のメモ" } })).status).toBe(200);
    expect(await events("experiment.update")).toEqual([]);
    const [e, ...rest] = await events("experiment.memo");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: {} });
    expect(e!.detail_json).not.toContain("経緯");
    // 終了したテストにも書ける(状態を問わない)
    await runDirect(sid, eid, "archived");
    expect((await call("PATCH", base, { token: owner.token, body: { description: "終了後" } })).status).toBe(200);
    expect(await events("experiment.memo")).toHaveLength(2);
    // 読んだ後に消された(行が無い)ときは記録しない
    await call("PATCH", base, { token: owner.token, body: { description: "消えた" }, envOverride: { DB: beforeD1Batch(env.DB, () => deleteRow(sid, eid)) } });
    expect(await events("experiment.memo")).toHaveLength(2);
  });

  it("memo_audit_failure_rolls_back (Q8)", async () => {
    const { owner, sid, eid, base } = await draft();
    const res = await call("PATCH", base, { token: owner.token, body: { description: "書けない" }, envOverride: { DB: failingD1Insert(env.DB, "audit_events") } });
    expect(res.status).toBe(500);
    expect((await experimentRow(sid, eid)).description).toBe("");
  });

  it("archived_edit_refused_writes_no_event", async () => {
    const { owner, sid, eid, base } = await draft();
    expect((await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(200);
    await runDirect(sid, eid);
    const before = (await events()).length;
    // 読んだ後に終了された: PATCH(experiment.update)・PUT …/changes(experiment.changes)の書き込みは断られ、記録も無い
    const archive = () => runDirect(sid, eid, "archived");
    const patch = await call("PATCH", base, { token: owner.token, body: { name: "X" }, envOverride: { DB: beforeD1Batch(env.DB, archive) } });
    expect(patch.status).toBe(409);
    expect((await json(patch)).error).toBe("experiment_archived_readonly");
    await runDirect(sid, eid);
    const changes = await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE("c2")], envOverride: { DB: beforeD1Batch(env.DB, archive) } });
    expect(changes.status).toBe(409);
    expect((await json(changes)).error).toBe("experiment_archived_readonly");
    // 終了してから: 事前の検査で断る
    expect((await call("PATCH", base, { token: owner.token, body: { name: "X" } })).status).toBe(409);
    expect((await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: [] })).status).toBe(409);
    expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 21 } } })).status).toBe(409);
    expect((await events()).length).toBe(before);
  });

  it("patch_locked_setting_race_writes_no_event", async () => {
    // 開始後のテストで配信率を上げる保存の、読んだ後に別の要求が配信率をさらに上げた(書き込みの条件 traffic_percentage <= 新しい値 が偽 → 409)
    const { owner, sid, eid, base } = await draft();
    await runDirect(sid, eid);
    await env.DB.prepare(`update experiments set traffic_percentage = 50 where site_id = ?1 and id = ?2`).bind(sid, eid).run();
    const racing = beforeD1Batch(env.DB, () => env.DB.prepare(`update experiments set traffic_percentage = 90 where site_id = ?1 and id = ?2`).bind(sid, eid).run());
    expect((await call("PATCH", base, { token: owner.token, body: { trafficPercentage: 60 }, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("experiment.update")).toEqual([]);
  });
});

describe("experiment.variants / variant_memo / changes", () => {
  it("variants_records_names_and_weights", async () => {
    const { owner, sid, eid, base } = await draft();
    const body = [
      { id: "a", name: "A", weight: 40 },
      { id: "b", name: "B2", weight: 30 },
      { id: "c", name: "C", weight: 30 },
    ];
    expect((await call("PUT", `${base}/variants`, { token: owner.token, body })).status).toBe(200);
    const [e, ...rest] = await events("experiment.variants");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      site_id: sid,
      experiment_id: eid,
      target_type: "experiment",
      target_id: eid,
      target_label: "Hero",
      detail: { from: ["A", "B"], to: ["A", "B2", "C"], weights: { from: [50, 50], to: [40, 30, 30] } },
    });
    // 読んだ後に開始された(409 experiment_active)ときは記録しない
    const racing = beforeD1Batch(env.DB, () => runDirect(sid, eid));
    expect((await call("PUT", `${base}/variants`, { token: owner.token, body, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("experiment.variants")).toHaveLength(1);
  });

  it("variant_memo_records_variant", async () => {
    const { owner, sid, eid, base } = await draft();
    const res = await call("PATCH", `${base}/variants/b`, { token: owner.token, body: { description: "B のメモ" } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: "b", name: "B", description: "B のメモ" });
    const [e, ...rest] = await events("experiment.variant_memo");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "variant", target_id: "b", target_label: "B", detail: { variant: "B" } });
    expect(e!.detail_json).not.toContain("メモ");
    // 無いパターン(404)では記録しない
    expect((await call("PATCH", `${base}/variants/zz`, { token: owner.token, body: { description: "x" } })).status).toBe(404);
    expect(await events("experiment.variant_memo")).toHaveLength(1);
  });

  it("changes_records_counts_and_types", async () => {
    const { owner, sid, eid, base } = await draft();
    const three = [TEXT_CHANGE("c1"), TEXT_CHANGE("c2"), { id: "c3", type: "CSS", payload: { css: "a{}" } }];
    expect((await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: three })).status).toBe(200);
    const four = [...three, { id: "c4", type: "HIDE", selector: ".x", payload: {} }];
    expect((await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: four })).status).toBe(200);
    const [first, second, ...rest] = await events("experiment.changes");
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "variant", target_id: "b", target_label: "B", detail: { variant: "B", from: 0, to: 3, types: { TEXT: 2, CSS: 1 } } });
    expect(second!.detail).toEqual({ variant: "B", from: 3, to: 4, types: { TEXT: 2, CSS: 1, HIDE: 1 } });
    // 中身(セレクタ・本文)は持たない
    expect(second!.detail_json).not.toContain(".x");
  });

  it("original_variant_change_refused_writes_no_event", async () => {
    const { owner, base } = await draft();
    // オリジナル(a)への保存は 422。空配列は受けるが何もしないので記録しない
    expect((await call("PUT", `${base}/variants/a/changes`, { token: owner.token, body: [TEXT_CHANGE()] })).status).toBe(422);
    expect((await call("PUT", `${base}/variants/a/changes`, { token: owner.token, body: [] })).status).toBe(200);
    // 読んだ後に b がオリジナルになった(後始末の文が変更を消して 422): 記録の guard も同じ条件(variantIsOriginal の否定)
    const racing = beforeD1Batch(env.DB, async () => {
      const r = await call("PUT", `${base}/variants`, {
        token: owner.token,
        body: [
          { id: "a", name: "A", weight: 50, original: false },
          { id: "b", name: "B", weight: 50, original: true },
        ],
      });
      expect(r.status).toBe(200);
    });
    expect((await call("PUT", `${base}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()], envOverride: { DB: racing } })).status).toBe(422);
    expect(await events("experiment.changes")).toEqual([]);
  });
});

describe("experiment.status / adoption / evaluation_plan", () => {
  it("status_records_from_to", async () => {
    const { owner, sid, eid, base } = await draft();
    const res = await call("POST", `${base}/status`, { token: owner.token, body: { status: "running" } });
    expect(res.status).toBe(200);
    const [e, ...rest] = await events("experiment.status");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: { from: "draft", to: "running" } });
    // CAS で負けた(読んだ後に別の要求が一時停止した → 409 invalid_transition)ときは記録しない
    const racing = beforeD1Batch(env.DB, () => runDirect(sid, eid, "paused"));
    expect((await call("POST", `${base}/status`, { token: owner.token, body: { status: "archived" }, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("experiment.status")).toHaveLength(1);
    // 表に無い遷移(409)でも記録しない
    await runDirect(sid, eid, "archived");
    expect((await call("POST", `${base}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(409);
    expect(await events("experiment.status")).toHaveLength(1);
  });

  it("adoption_records_variant", async () => {
    const { owner, sid, eid, base } = await draft();
    // 終了していない(409)では記録しない
    expect((await call("PUT", `${base}/adoption`, { token: owner.token, body: { variantId: "b" } })).status).toBe(409);
    await runDirect(sid, eid, "archived");
    const res = await call("PUT", `${base}/adoption`, { token: owner.token, body: { variantId: "b", note: "B を採用" } });
    expect(res.status).toBe(200);
    const [e, ...rest] = await events("experiment.adoption");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: { variant: "b" } });
    expect(e!.detail_json).not.toContain("採用");
    // 読んだ後に消された(404)ときは記録しない
    expect((await call("PUT", `${base}/adoption`, { token: owner.token, body: { variantId: null }, envOverride: { DB: beforeD1Batch(env.DB, () => deleteRow(sid, eid)) } })).status).toBe(404);
    expect(await events("experiment.adoption")).toHaveLength(1);
  });

  it("stop_with_adoption_records_adoption (2026-11-05 ユーザー決定 Q276)", async () => {
    // 結果を記録しないサイト: 終了と同時に付けた採用も experiment.adoption の行(PUT …/adoption と同じ形。メモの本文は持たない)
    const { owner, sid, eid, base } = await draft();
    await runDirect(sid, eid, "running");
    const res = await call("POST", `${base}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "b", note: "B を採用" } } });
    expect(res.status).toBe(200);
    expect((await json<{ results: unknown }>(res)).results).toEqual({ recorded: true });
    const [e, ...rest] = await events("experiment.adoption");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: { variant: "b" } });
    expect(e!.detail_json).not.toContain("採用");
    expect((await events("experiment.status")).map((r) => r.detail)).toEqual([{ from: "running", to: "archived" }]);
    // 採用を付けない終了では experiment.adoption を書かない
    await createExperiment(owner.token, sid, { id: "exp_b", name: "Other" });
    await runDirect(sid, "exp_b", "running");
    expect((await call("POST", `/sites/${sid}/experiments/exp_b/status`, { token: owner.token, body: { status: "archived" } })).status).toBe(200);
    expect(await events("experiment.adoption")).toHaveLength(1);
  });

  it("stop_with_adoption_on_a_recording_site_records_adoption_with_the_snapshot (Q276)", async () => {
    // 結果を記録するサイト: 採用は結果の記録と同じ batch(採用の upsert と同じ条件 = 記録があること)で記録する
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    const res = await setStatus(owner, sid, "exp_t", { status: "archived", adoption: { variantId: "b" } }, resultsOverride());
    expect(res.status).toBe(200);
    expect((await json<{ results: unknown }>(res)).results).toEqual({ recorded: true });
    const rows = await events("experiment.adoption");
    expect(rows.map((r) => [r.experiment_id, r.detail])).toEqual([["exp_t", { variant: "b" }]]);
    expect((await env.DB.prepare(`select count(*) as n from result_snapshots where site_id = ?1 and experiment_id = 'exp_t'`).bind(sid).first<{ n: number }>())!.n).toBeGreaterThan(0);
  });

  it("evaluation_plan_records_fields", async () => {
    // 下書き: 読んだ計画と比べて変えた項目の名前(同じ値の項目は入らない)
    const { owner, sid, eid, base } = await draft();
    expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 21, threshold: 95, delta: 1 } } })).status).toBe(200);
    const [e, ...rest] = await events("experiment.evaluation_plan");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ site_id: sid, experiment_id: eid, target_type: "experiment", target_id: eid, target_label: "Hero", detail: { fields: ["minDays", "delta"] } });
    // 読んだ後に開始された(409)ときは記録しない
    const racing = beforeD1Batch(env.DB, () => runDirect(sid, eid));
    expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 28 } }, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("experiment.evaluation_plan")).toHaveLength(1);
  });

  it("evaluation_plan_draft_concurrent_save_records_actual_changes (B129 final review FR-Medium-2)", async () => {
    // 下書きの保存は読んだ version を条件にしない。A が読んだ後に B が minDays を変えると、A の保存は minDays を A の読んだ値に戻す。
    // 記録の fields は今の行と比べるので、A の記録には送った maxWeeks に加えて、実際に書き換えた minDays も入る
    const { owner, base } = await draft();
    expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 21 } } })).status).toBe(200);
    const racing = beforeD1Batch(env.DB, async () => expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { minDays: 14 } } })).status).toBe(200));
    expect((await call("PUT", `${base}/evaluation-plan`, { token: owner.token, body: { plan: { maxWeeks: 12 } }, envOverride: { DB: racing } })).status).toBe(200);
    const rows = await events("experiment.evaluation_plan");
    expect(rows.map((r) => r.detail)).toEqual([{ fields: ["minDays"] }, { fields: ["minDays"] }, { fields: ["minDays", "maxWeeks"] }]);
    // 書いた計画は A の読んだ値 + A の変更(B の minDays は戻っている)
    const saved = await call("GET", `${base}/evaluation-plan`, { token: owner.token });
    expect((await json<{ plan: { minDays: number; maxWeeks: number } }>(saved)).plan).toMatchObject({ minDays: 21, maxWeeks: 12 });
  });

  it("evaluation_plan_extension_records_fields", async () => {
    // 開始後の延長(結果を記録するサイトで開始し、計画を固定したテスト)
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    await startTest(owner, sid, "exp_t");
    const before = (await events("experiment.evaluation_plan")).length;
    const plan = `/sites/${sid}/experiments/exp_t/evaluation-plan`;
    expect((await call("PUT", plan, { token: owner.token, body: { plan: { minDays: 21 }, reason: "流入が少ない" } })).status).toBe(200);
    const all = await events("experiment.evaluation_plan");
    expect(all).toHaveLength(before + 1);
    expect(all[before]).toMatchObject({ site_id: sid, experiment_id: "exp_t", target_label: "Hero", detail: { fields: ["minDays"] } });
    expect(all[before]!.detail_json).not.toContain("流入");
    // 縮める(409 evaluation_plan_locked)・読んだ後に別の保存が割り込んだ(version が進んだ → 409)ときは記録しない
    expect((await call("PUT", plan, { token: owner.token, body: { plan: { minDays: 14 } } })).status).toBe(409);
    const racing = beforeD1Batch(env.DB, () => env.DB.prepare(`update evaluation_plans set version = version + 1 where site_id = ?1 and experiment_id = 'exp_t'`).bind(sid).run());
    expect((await call("PUT", plan, { token: owner.token, body: { plan: { minDays: 28 } }, envOverride: { DB: racing } })).status).toBe(409);
    // 同じ計画の送り直しは書かないので記録しない
    expect((await call("PUT", plan, { token: owner.token, body: { plan: { minDays: 21 } } })).status).toBe(200);
    expect(await events("experiment.evaluation_plan")).toHaveLength(before + 1);
  });
});

describe("history columns", () => {
  it("experiment_id_is_set_for_history (Q29)", async () => {
    const { owner, sid, eid, base } = await draft();
    const t = owner.token;
    expect((await call("PATCH", base, { token: t, body: { name: "N" } })).status).toBe(200);
    expect((await call("PATCH", base, { token: t, body: { description: "m" } })).status).toBe(200);
    expect((await call("PUT", `${base}/variants`, { token: t, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50 }] })).status).toBe(200);
    expect((await call("PATCH", `${base}/variants/b`, { token: t, body: { description: "m" } })).status).toBe(200);
    expect((await call("PUT", `${base}/variants/b/changes`, { token: t, body: [TEXT_CHANGE()] })).status).toBe(200);
    expect((await call("PUT", `${base}/evaluation-plan`, { token: t, body: { plan: { minDays: 21 } } })).status).toBe(200);
    expect((await call("POST", `${base}/status`, { token: t, body: { status: "running" } })).status).toBe(200);
    expect((await call("POST", `${base}/status`, { token: t, body: { status: "archived" } })).status).toBe(200);
    expect((await call("PUT", `${base}/adoption`, { token: t, body: { variantId: "b" } })).status).toBe(200);
    expect((await call("POST", `${base}/duplicate`, { token: t, body: { mode: "same", id: "exp_dup" } })).status).toBe(201);
    const generation = await generationOf(sid, eid);
    expect((await call("DELETE", base, { token: t })).status).toBe(204);
    const rows = (await events()).filter((e) => e.action.startsWith("experiment."));
    expect(rows.map((e) => e.action)).toEqual([
      "experiment.create",
      "experiment.update",
      "experiment.memo",
      "experiment.variants",
      "experiment.variant_memo",
      "experiment.changes",
      "experiment.evaluation_plan",
      "experiment.status",
      "experiment.status",
      "experiment.adoption",
      "experiment.duplicate",
      "experiment.delete",
    ]);
    const siteGeneration = await siteGenerationOf(sid);
    const dupGeneration = await generationOf(sid, "exp_dup");
    for (const e of rows) {
      expect(e.workspace_id).toBe(owner.workspaceId);
      expect(e.site_id).toBe(sid);
      expect(e.site_generation).toBe(siteGeneration);
      if (e.action === "experiment.duplicate") {
        expect(e.experiment_id).toBe("exp_dup");
        expect(e.experiment_generation).toBe(dupGeneration);
      } else {
        expect(e.experiment_id).toBe(eid);
        expect(e.experiment_generation).toBe(generation);
      }
    }
  });
});

describe("round trips", () => {
  /**
   * 往復は実装の前と同じ(Global Constraints・spec §10.1)。実装の前の値(2026-11-04、下の順の操作で測った queries / batches):
   * patch 7/1・memo 7/0・variants 7/1・changes 8/1・variantMemo 7/0・plan 12/1・create 7/1・duplicate 9/1・deleteDraft 6/1・
   * status 28/2・archive 33/2・adoption 9/0。1 文の execute だった 3 つ(memo・variantMemo・adoption)は 2 文の batch になり、
   * 1 文の照会が 1 つ減って batch が 1 つ増える(往復の合計は同じ)。記録の文は batch の中だけにあり、1 文の往復にならない
   */
  it("save_round_trips_unchanged", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_rt" });
    const counting = countingD1(env.DB);
    // audits = batch に入る記録の文の数。状態の変更は experiment.status と、続く自動の公開の publish.publish(公開の CAS の batch。Task 7)の 2 つ
    const req = async (method: string, path: string, body: unknown, status = 200, audits = 1) => {
      counting.reset();
      const res = await call(method, path, { token: owner.token, body, envOverride: { DB: counting.db } });
      expect(res.status).toBe(status);
      const c = counting.counts();
      expect(c.sql.some((s) => /audit_events/.test(s)), `${method} ${path}: 記録の文が 1 文の往復になっている`).toBe(false);
      expect(c.batchSql.flat().filter((s) => /^insert into audit_events/.test(s)), `${method} ${path}: 記録の文は batch に ${audits} つ`).toHaveLength(audits);
      return { queries: c.queries, batches: c.batches };
    };
    const base = `/sites/${sid}/experiments/${eid}`;
    const out = {
      patch: await req("PATCH", base, { name: "New", trafficPercentage: 50 }),
      memo: await req("PATCH", base, { description: "memo" }),
      variants: await req("PUT", `${base}/variants`, [
        { id: "a", name: "A", weight: 50 },
        { id: "b", name: "B", weight: 50 },
      ]),
      changes: await req("PUT", `${base}/variants/b/changes`, [TEXT_CHANGE()]),
      variantMemo: await req("PATCH", `${base}/variants/b`, { description: "m" }),
      plan: await req("PUT", `${base}/evaluation-plan`, { plan: { minDays: 21 } }),
      create: await req("POST", `/sites/${sid}/experiments`, { id: "exp_rt2", name: "N", urlMatch }, 201),
      duplicate: await req("POST", `${base}/duplicate`, { mode: "same", id: "exp_rt3" }, 201),
      deleteDraft: await req("DELETE", `/sites/${sid}/experiments/exp_rt3`, undefined, 204),
      status: await req("POST", `${base}/status`, { status: "running" }, 200, 2),
      archive: await req("POST", `${base}/status`, { status: "archived" }, 200, 2),
      adoption: await req("PUT", `${base}/adoption`, { variantId: "b" }),
    };
    expect(out).toEqual({
      patch: { queries: 7, batches: 1 },
      memo: { queries: 6, batches: 1 },
      variants: { queries: 7, batches: 1 },
      changes: { queries: 8, batches: 1 },
      variantMemo: { queries: 6, batches: 1 },
      plan: { queries: 12, batches: 1 },
      create: { queries: 7, batches: 1 },
      duplicate: { queries: 9, batches: 1 },
      deleteDraft: { queries: 6, batches: 1 },
      status: { queries: 28, batches: 2 },
      archive: { queries: 33, batches: 2 },
      adoption: { queries: 8, batches: 1 },
    });
  });
});
