import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { call, createExperiment, createSite, experimentRow, expectEnvelope, fakeDeployer, fakeResultsBudget, inviteAndJoin, json, seedResults, setupOwner, siteRow, TEXT_CHANGE } from "./helpers";
import {
  adoptionRow,
  backdate,
  DAY,
  db,
  draftTest,
  getResults,
  HOUR,
  noteKeys,
  recordingSite,
  resultsOverride,
  seedWinner,
  setStatus,
  snapshotRows,
  startTest,
  type Owner,
  type Report,
} from "./results-fixtures";

// D9 plan ③ Task 10(K16、設計書 §8): 終了と採用の記録

const putAdoption = (owner: Owner, sid: string, eid: string, body: unknown, token = owner.token) => call("PUT", `/sites/${sid}/experiments/${eid}/adoption`, { token, body });
const setText = (owner: Owner, sid: string, eid: string, vid: string, text: string) =>
  call("PUT", `/sites/${sid}/experiments/${eid}/variants/${vid}/changes`, { token: owner.token, body: [{ ...TEXT_CHANGE(`c_${vid}`), payload: { text } }] });
type ListItem = { id: string; adoption: { variantId: string | null; variantName: string | null; baseline: boolean; decidedAt: number; summary: { diffPoints: number | null; relative: number | null; probBeat: number | null; verdict: string | null } | null } | null };
const listOf = async (owner: Owner, sid: string) => json<ListItem[]>(await call("GET", `/sites/${sid}/experiments`, { token: owner.token }));

describe("終了と採用", () => {
  test("adopt_baseline_with_changes / baseline_without_changes_is_stored_as_null", async () => {
    // 結果を記録しないサイト(配信の記録が無い = 保存済みの Change で判断する)
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 基準 a(オリジナル、Change なし)を採用 → 採用なし(null)
    const { id: e1 } = await createExperiment(owner.token, sid);
    expect((await setText(owner, sid, e1, "b", "B")).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${e1}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const stop1 = await call("POST", `/sites/${sid}/experiments/${e1}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "a", note: "元のまま" } } });
    expect(stop1.status).toBe(200);
    expect((await json(stop1)).results).toEqual({ recorded: true });
    expect(await adoptionRow(sid, e1)).toMatchObject({ variant_id: null, note: "元のまま", decided_by: owner.userId });
    // 基準 b(Change あり)を採用 → b のまま
    const { id: e2 } = await createExperiment(owner.token, sid);
    expect((await setText(owner, sid, e2, "b", "B")).status).toBe(200);
    expect((await call("PUT", `/sites/${sid}/experiments/${e2}/evaluation-plan`, { token: owner.token, body: { plan: { baselineVariantId: "b" } } })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${e2}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${e2}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "b" } } })).status).toBe(200);
    expect(await adoptionRow(sid, e2)).toMatchObject({ variant_id: "b", note: "" });
    // 基準以外(オリジナル a)は Change が無くても a のまま
    const { id: e3 } = await createExperiment(owner.token, sid);
    expect((await setText(owner, sid, e3, "b", "B")).status).toBe(200);
    expect((await call("PUT", `/sites/${sid}/experiments/${e3}/evaluation-plan`, { token: owner.token, body: { plan: { baselineVariantId: "b" } } })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${e3}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${e3}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "a" } } })).status).toBe(200);
    expect((await adoptionRow(sid, e3))!.variant_id).toBe("a");
    // 結果の記録が無いテストの一覧の要約は null(採用の ID と時刻は出す)
    const list = await listOf(owner, sid);
    expect(list.find((x) => x.id === e3)!.adoption).toMatchObject({ variantId: "a", baseline: false, summary: null });
    expect(list.find((x) => x.id === e1)!.adoption).toMatchObject({ variantId: null, variantName: null, baseline: false, summary: null });
  });

  test("基準に未公開の Change だけがある場合(終了の直前に届いていた定義で判断する。K16)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 基準 b は開始の時点で Change なし → 開始の Publish の届く定義(配信を確かめた)は b に Change なし。開始の後に b に Change を保存だけする
    const deployer = fakeDeployer();
    await startTest(owner, sid, "exp_unpub", { baselineVariantId: "b" }, { bChanges: false, envOverride: { DEPLOYER: deployer } });
    expect((await setText(owner, sid, "exp_unpub", "b", "未公開")).status).toBe(200);
    const stop = await setStatus(owner, sid, "exp_unpub", { status: "archived", adoption: { variantId: "b" } }, { ...resultsOverride(), DEPLOYER: deployer });
    expect(stop.status).toBe(200);
    expect((await json(stop)).results).toEqual({ recorded: true });
    expect((await adoptionRow(sid, "exp_unpub"))!.variant_id).toBeNull();
    // 配信を確かめた定義が無い(出し直しが済んでいない)ときは保存済みの Change で判断する → b のまま
    await startTest(owner, sid, "exp_saved", { baselineVariantId: "b" }, { bChanges: false, envOverride: { DEPLOYER: fakeDeployer("pending") } });
    expect((await setText(owner, sid, "exp_saved", "b", "保存済み")).status).toBe(200);
    expect((await setStatus(owner, sid, "exp_saved", { status: "archived", adoption: { variantId: "b" } }, resultsOverride())).status).toBe(200);
    expect((await adoptionRow(sid, "exp_saved"))!.variant_id).toBe("b");
  });

  test("stop_with_unpublished_changes_warns", async () => {
    // 終了の応答の warnings と、終了のモーダルが読む結果の注記 unpublished_changes・配信していた定義の Change の有無
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const deployer = fakeDeployer();
    await startTest(owner, sid, "exp_warn", {}, { envOverride: { DEPLOYER: deployer } });
    expect((await setText(owner, sid, "exp_warn", "b", "保存だけ")).status).toBe(200);
    const before = await json<Report>(await getResults(owner, sid, "exp_warn"));
    expect(before.notes.filter((n) => n.key === "unpublished_changes")).toEqual([{ key: "unpublished_changes", params: { variantId: "b" } }]);
    expect(before.deliveredChanges).toEqual({ a: false, b: true });
    const stop = await setStatus(owner, sid, "exp_warn", { status: "archived" }, { ...resultsOverride(), DEPLOYER: deployer });
    const body = await json(stop);
    expect(body.warnings).toEqual([{ path: "variants.b.changes", message: "パターン「B」に未公開の編集があります。テストで配信したのは編集の前の中身です" }]);
    expect(body.results).toEqual({ recorded: true });
    // 終了した後も、終了の直前の定義と比べる
    const after = await json<Report>(await getResults(owner, sid, "exp_warn"));
    expect(noteKeys(after)).toContain("unpublished_changes");
    // 未公開の変更が無ければ警告しない
    await startTest(owner, sid, "exp_clean", {}, { envOverride: { DEPLOYER: deployer } });
    const clean = await json(await setStatus(owner, sid, "exp_clean", { status: "archived" }, { ...resultsOverride(), DEPLOYER: deployer }));
    expect(clean.warnings).toEqual([]);
  });

  test("edited_after_evaluation: 評価時点の記録に写した定義と保存済みの Change が違えば注記", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const deployer = fakeDeployer();
    const runId = await startTest(owner, sid, "exp_edit", {}, { envOverride: { DEPLOYER: deployer } });
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_edit", s);
    await env.DB.prepare("update experiment_delivered_definitions set delivered_from = ? where site_id = ? and experiment_id = ?").bind(s, sid, "exp_edit").run();
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const fixed = await json<Report>(await getResults(owner, sid, "exp_edit"));
    expect(fixed.phase).toBe("fixed");
    expect(noteKeys(fixed)).not.toContain("edited_after_evaluation");
    expect((await setText(owner, sid, "exp_edit", "b", "評価時点の後")).status).toBe(200);
    const edited = await json<Report>(await getResults(owner, sid, "exp_edit"));
    expect(edited.notes.filter((n) => n.key === "edited_after_evaluation")).toEqual([{ key: "edited_after_evaluation", params: { variantId: "b" } }]);
    // 記録そのものは変わらない(注記は応答のたびに足す)
    expect(JSON.parse((await snapshotRows(sid, "exp_edit"))[0]!.result_json).notes.map((n: { key: string }) => n.key)).not.toContain("edited_after_evaluation");
  });

  test("stop_with_read_budget_refused_records_later", async () => {
    // 終了のときに予約を断られる → results.recorded false・採用も未記録。後で(Cron。ここでは同じ規則の結果の API)記録を作り、採用は PUT で記録し直す
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    const runId = await startTest(owner, sid, "exp_refused");
    const s = Date.now() - 3 * DAY;
    await backdate(sid, "exp_refused", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const refused = fakeResultsBudget({ readBudget: 0 });
    const stop = await setStatus(owner, sid, "exp_refused", { status: "archived", adoption: { variantId: "b" } }, resultsOverride(refused));
    expect(stop.status).toBe(200);
    const body = await json(stop);
    expect(body.results).toEqual({ recorded: false });
    expect(body.experiment.status).toBe("archived");
    expect(body.publish.ok).toBe(true);
    expect(refused.calls.filter((c) => c.method === "settleRead")).toHaveLength(0);
    expect(await snapshotRows(sid, "exp_refused")).toEqual([]);
    expect(await adoptionRow(sid, "exp_refused")).toBeUndefined();
    const later = await json<Report>(await getResults(owner, sid, "exp_refused"));
    expect(later).toMatchObject({ phase: "stopped", stoppedEarly: true });
    expect((await snapshotRows(sid, "exp_refused")).map((x) => x.kind)).toEqual(["stop"]);
    expect((await putAdoption(owner, sid, "exp_refused", { variantId: "b" })).status).toBe(200);
    expect((await adoptionRow(sid, "exp_refused"))!.variant_id).toBe("b");
  });

  test("single_archive_with_adoption_is_rejected", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: single } = await createExperiment(owner.token, sid, { kind: "single" });
    expect((await call("POST", `/sites/${sid}/experiments/${single}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const res = await call("POST", `/sites/${sid}/experiments/${single}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "a" } } });
    expect(res.status).toBe(422);
    expect((await expectEnvelope(res)).error).toBe("adoption_not_allowed");
    expect((await experimentRow(sid, single)).status).toBe("running");
    // 採用なしでのパーソナライズの終了は今のまま(results を返さない)
    const plain = await json(await call("POST", `/sites/${sid}/experiments/${single}/status`, { token: owner.token, body: { status: "archived" } }));
    expect(plain.experiment.status).toBe("archived");
    expect(plain.results).toBeUndefined();
    // テストでも、終了以外の遷移に採用は付けられない・パターンに無い ID・長すぎるメモ
    const { id: t } = await createExperiment(owner.token, sid);
    expect((await call("POST", `/sites/${sid}/experiments/${t}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const pause = await call("POST", `/sites/${sid}/experiments/${t}/status`, { token: owner.token, body: { status: "paused", adoption: { variantId: "b" } } });
    expect(pause.status).toBe(422);
    expect((await expectEnvelope(pause)).error).toBe("adoption_not_allowed");
    const unknown = await call("POST", `/sites/${sid}/experiments/${t}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "zz" } } });
    expect(unknown.status).toBe(422);
    expect((await expectEnvelope(unknown)).error).toBe("unknown_variant");
    const long = await call("POST", `/sites/${sid}/experiments/${t}/status`, { token: owner.token, body: { status: "archived", adoption: { variantId: "b", note: "x".repeat(1001) } } });
    expect(long.status).toBe(422);
    expect((await experimentRow(sid, t)).status).toBe("running");
  });

  test("PUT adoption は終了後だけ・上書き。一覧の要約は正の判定の記録から(基準を採用したら差と確率は null)", async () => {
    const owner = await setupOwner();
    const sid = await recordingSite(owner);
    // 基準 = b(Change あり)。a(オリジナル)は基準との比較を持つ
    const runId = await startTest(owner, sid, "exp_put", { baselineVariantId: "b" });
    // 実行中は 409
    const running = await putAdoption(owner, sid, "exp_put", { variantId: "a" });
    expect(running.status).toBe(409);
    expect((await expectEnvelope(running)).error).toBe("adoption_not_allowed");
    const s = Date.now() - 15 * DAY;
    await backdate(sid, "exp_put", s);
    await seedResults(seedWinner(runId, sid, s + HOUR));
    const report = await json<Report>(await getResults(owner, sid, "exp_put"));
    expect(report.phase).toBe("fixed");
    const stop = await setStatus(owner, sid, "exp_put", { status: "archived" }, resultsOverride());
    expect((await json(stop)).results).toEqual({ recorded: true });
    // 採用を付けずに終了 = 一覧の採用は null
    expect((await listOf(owner, sid)).find((x) => x.id === "exp_put")!.adoption).toBeNull();
    const expBefore = await experimentRow(sid, "exp_put");
    const siteBefore = await siteRow(sid);
    // 閲覧者・編集者は 403
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await putAdoption(owner, sid, "exp_put", { variantId: "a" }, editor.token)).status).toBe(403);
    // 基準以外(a)を採用: 要約 = 記録の a の差と確率・判定
    const put = await putAdoption(owner, sid, "exp_put", { variantId: "a", note: "A に戻す" });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({ variantId: "a", note: "A に戻す", decidedBy: owner.userId });
    const a = report.variants.find((v) => v.id === "a")!;
    expect(a.diff).not.toBeNull();
    expect((await listOf(owner, sid)).find((x) => x.id === "exp_put")!.adoption).toMatchObject({
      variantId: "a",
      variantName: a.name,
      baseline: false,
      summary: { diffPoints: a.diff!.mean, relative: a.diff!.relMean, probBeat: a.diff!.pAboveDelta, verdict: a.state },
    });
    // 上書き: 基準(Change あり)を採用 → 差と確率は null
    expect((await putAdoption(owner, sid, "exp_put", { variantId: "b" })).status).toBe(200);
    expect((await listOf(owner, sid)).find((x) => x.id === "exp_put")!.adoption).toMatchObject({
      variantId: "b",
      variantName: report.variants.find((v) => v.id === "b")!.name,
      baseline: true,
      summary: { diffPoints: null, relative: null, probBeat: null, verdict: null },
    });
    // 採用なし → summary は null
    expect((await putAdoption(owner, sid, "exp_put", { variantId: null })).status).toBe(200);
    expect((await listOf(owner, sid)).find((x) => x.id === "exp_put")!.adoption).toMatchObject({ variantId: null, variantName: null, baseline: false, summary: null });
    // パターンに無い ID は 422
    const unknown = await putAdoption(owner, sid, "exp_put", { variantId: "zz" });
    expect(unknown.status).toBe(422);
    expect((await expectEnvelope(unknown)).error).toBe("unknown_variant");
    // 採用の記録は未公開の変更に数えない
    const expAfter = await experimentRow(sid, "exp_put");
    expect(expAfter.updated_at).toBe(expBefore.updated_at);
    expect((await siteRow(sid)).content_updated_at).toBe(siteBefore.content_updated_at);
    // 結果の API の採用も最後の記録
    expect((await json<Report>(await getResults(owner, sid, "exp_put"))).adoption).toMatchObject({ variantId: null });
    // パーソナライズは 422
    const { id: single } = await createExperiment(owner.token, sid, { kind: "single" });
    expect((await putAdoption(owner, sid, single, { variantId: null })).status).toBe(422);
    // 下書きのテストは 409
    await draftTest(owner, sid, "exp_draft");
    expect((await putAdoption(owner, sid, "exp_draft", { variantId: null })).status).toBe(409);
  });

  test("list_adoption_has_name_and_baseline_flag(重み 0 のパターンの採用は基準と取り違えない。消したパターンは記録の名前)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const names = new Map((await db().selectFrom("variants").select(["id", "name"]).where("site_id", "=", sid).where("experiment_id", "=", eid).execute()).map((v) => [v.id, v.name]));
    // 正の判定の記録: 基準 a、b は重み 0(配信していない = 差・確率・判定が無い)、消したパターン z は記録にだけ名前がある
    const variant = (id: string, name: string, weight: number, diff: unknown) => ({ id, name, original: false, weight, diff, state: diff ? "adopt" : null });
    const snapshot = {
      plan: { baselineVariantId: "a" },
      variants: [variant("a", names.get("a")!, 100, null), variant("b", names.get("b")!, 0, null), variant("z", "消した Z", 0, { mean: 0.5, relMean: 10, pAboveDelta: 0.97 })],
    };
    await env.DB.prepare("insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json) values (?, ?, 'evaluation', 'run_x', 1, 1, '1', ?)")
      .bind(sid, eid, JSON.stringify(snapshot))
      .run();
    const adopt = (vid: string | null) => env.DB.prepare("insert or replace into adoptions (site_id, experiment_id, variant_id, note, decided_by, decided_at) values (?, ?, ?, '', null, 1)").bind(sid, eid, vid).run();
    const item = async () => (await listOf(owner, sid)).find((x) => x.id === eid)!.adoption;
    await adopt("b");
    expect(await item()).toEqual({ variantId: "b", variantName: names.get("b"), baseline: false, decidedAt: 1, summary: { diffPoints: null, relative: null, probBeat: null, verdict: null } });
    await adopt("a");
    expect(await item()).toMatchObject({ variantId: "a", variantName: names.get("a"), baseline: true });
    await adopt("z");
    expect(await item()).toMatchObject({ variantId: "z", variantName: "消した Z", baseline: false });
  });
});
