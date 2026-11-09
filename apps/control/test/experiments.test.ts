import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  kvKeys,
  parseCompiledConfig,
  PAGE_CONDITION_MOVED_AUDIENCE_HINT,
  PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE,
  PAGE_CONDITION_MOVED_HINT,
  PAGE_CONDITION_MOVED_MESSAGE,
} from "@wtt/core";
import { AudienceJsonSchema } from "../src/routes/audiences";
import { ExperimentDetailJsonSchema, ExperimentJsonSchema } from "../src/routes/experiments";
import { beforeD1Batch, call, json, setupOwner, inviteAndJoin, createSite, createExperiment, experimentRow, expectEnvelope, failingD1Insert, TEXT_CHANGE } from "./helpers";

describe("experiments / variants", () => {
  it("creates a draft with two default variants and rejects id changes", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid, { id: "exp_hero" });
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(exp).toMatchObject({ id: "exp_hero", status: "draft", publishedStatus: null, trafficPercentage: 100, persistAssignment: false, unpublished: true });
    expect(exp.variants.map((v: any) => [v.id, v.weight])).toEqual([["a", 50], ["b", 50]]);
    const idPatch = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { id: "exp_other" } });
    expect(idPatch.status).toBe(422);
    expect((await json(idPatch)).error).toBe("validation_failed");
    const statusPatch = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { status: "running" } });
    expect(statusPatch.status).toBe(422);
    expect((await json(statusPatch)).error).toBe("validation_failed");
    const dup = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_hero", name: "dup", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    expect(dup.status).toBe(409);
    const dupBody = await json(dup);
    expect(dupBody.error).toBe("id_taken");
    // Task 12: 発見時は message 未設定で code(id_taken)がそのまま出ていた
    expect(dupBody.message).toBe("このエクスペリエンス ID は既に使われています");
  });

  it("PATCH writes only the given fields and leaves the publish bookkeeping alone", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid);
    const first = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { trafficPercentage: 40, persistAssignment: true, urlMatch: { include: [{ page: { op: "startsWith", value: "/lp" } }] } } });
    expect(first.status).toBe(200);
    // 別のフィールドだけを送った PATCH が既定値(100 / false)に戻さない
    const patched = await json(await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { name: "Hero 2" } }));
    expect(patched).toMatchObject({ name: "Hero 2", trafficPercentage: 40, persistAssignment: true, urlMatch: { include: [{ page: { op: "startsWith", value: "/lp" } }] }, status: "draft" });
    // status / published_status / started_at は Task 6 / 7 の帳簿列。PATCH は触らない
    const row = await env.DB.prepare("select status, published_status, started_at from experiments where id = ?").bind(id).first();
    expect(row).toEqual({ status: "draft", published_status: null, started_at: null });
  });

  it("validates names (100 chars), traffic range, targeting references and analytics on save", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid);
    let res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { name: "x".repeat(101) } });
    expect(res.status).toBe(422);
    const tooLongName = await json(res);
    expect(tooLongName.error).toBe("name_too_long");
    // Task 12: 発見時は message 未設定で code(name_too_long)がそのまま出ていた
    expect(tooLongName.message).toBe("名前が長すぎます(100 字以内)");
    expect(tooLongName.path).toEqual(["name"]); // 封筒の path は配列(openapi.ts の ErrorEnvelopeSchema)
    // Variant の name も同じ 100 字。path は要素まで指す
    const longVariant = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "あ".repeat(101), weight: 50 }] });
    expect(longVariant.status).toBe(422);
    expect(await json(longVariant)).toMatchObject({ error: "name_too_long", path: ["variants", "b", "name"], max: 100 });
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "あ".repeat(100), weight: 50 }] })).status).toBe(200); // 素の文字列長で数える(§10.9)
    const traffic0 = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { trafficPercentage: 0 } }); // 0 は paused で表現(§6.4)
    expect(traffic0.status).toBe(422);
    expect((await json(traffic0)).error).toBe("validation_failed");
    res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { targeting: { hist: "converted", goal: "g_none" } } });
    const unknownGoal = await json(res);
    expect(unknownGoal.error).toBe("unknown_goal");
    expect(unknownGoal.message).toBe("参照している目標が見つかりません");
    // Experiment 側で variantName を書くのはスキーマ違反(決定 32 追記)
    res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { analytics: { overrides: { variantName: "x" } } } });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toBe("validation_failed");
    // 値の長さは保存のルートの値の検査が拒否する(B77 K12。受け口のスキーマは値を文字列として受けるだけ)
    res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { analytics: { extra: { test_group: "x".repeat(101) } } } });
    const tooLong = await json(res);
    expect(res.status).toBe(422);
    expect(tooLong.error).toBe("invalid_analytics_value");
    expect(tooLong.code).toBe("too_long");
    expect(tooLong.path).toEqual(["analytics", "extra", "test_group"]);
    expect((await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { analytics: { overrides: { experimentName: "Hero copy" }, extra: { test_group: "q3" } } } })).status).toBe(200);
    // 解決後のキー数(Experiment 15 + Variant 6 = 21 > 20)は保存時に invalid_analytics
    const e15 = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`e${String(i + 1).padStart(2, "0")}`, "v"]));
    expect((await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { analytics: { extra: e15 } } })).status).toBe(200);
    const v6 = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`v${String(i + 1).padStart(2, "0")}`, "v"]));
    const over = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50, analytics: { extra: v6 } }] });
    expect(over.status).toBe(422);
    const overBody = await json(over);
    expect(overBody.error).toBe("invalid_analytics");
    // Task 12: message が英語の core 診断文のまま(旧: extra has N keys …)だった。今は中立の日本語 message。
    // 英語の詳細は応答に載せない(hint に置くと describeError が結局英語を表示し、detail に置いても封筒は extra を展開して届いていた)
    expect(overBody.message).toBe("外部計測の設定が不正です");
    expect(overBody.hint).toBeUndefined();
    expect(overBody).not.toHaveProperty("detail"); // 英語の診断文はサーバーログ限り(rulings §4 CX-Medium-1)
  });

  it("PUT variants replaces the set, keeps changes of surviving variants and enforces weights", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid);
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] })).status).toBe(200);
    const sum120 = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 60 }, { id: "b", name: "B", weight: 60 }] });
    expect(sum120.status).toBe(422);
    const sum120Body = await json(sum120);
    expect(sum120Body.error).toBe("variant_weights_invalid");
    // Task 12: message が英語のまま(旧: variant weights must sum to 100 …)だった
    expect(sum120Body.message).toBe("重みの合計は 100 である必要があります(現在 120)");
    const single = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 100 }] });
    expect(single.status).toBe(422);
    expect(await json(single)).toMatchObject({ error: "variant_count_invalid", kind: "test", count: 1 }); // 決定 51: テストは 2 つ以上
    const dup = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "a", name: "A2", weight: 50 }] });
    expect(dup.status).toBe(422);
    const dupBody = await json(dup);
    expect(dupBody.error).toBe("duplicate_variant_id");
    // Task 12: 発見時は message が英語のまま(旧: duplicate variant id)だった
    expect(dupBody.message).toBe("パターン ID が重複しています");
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 30 }, { id: "b", name: "B", weight: 30, analytics: { overrides: { variantName: "New hero" } } }, { id: "c", name: "C", weight: 40 }] })).status).toBe(200);
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(exp.variants.map((v: any) => v.id)).toEqual(["a", "b", "c"]);
    expect(exp.variants[1].changes).toHaveLength(1);
    expect(exp.variants[1].analytics).toEqual({ overrides: { variantName: "New hero" } });
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "c", name: "C", weight: 50 }] })).status).toBe(200);
    expect((await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }))).variants.map((v: any) => v.id)).toEqual(["a", "c"]);
  });

  it("a variant or change write moves the parent experiment's updatedAt and updatedBy", async () => {
    // spec §13.1: 子(Variant / Change / analytics)への書込みは親 Experiment の updated_at / updated_by を動かす
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const ed = await inviteAndJoin(token, workspaceId, "editor");
    const { id } = await createExperiment(token, sid);
    const before = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(before.updatedBy).not.toBe(ed.userId);
    await new Promise((r) => setTimeout(r, 2)); // epoch ミリ秒なので 1 ms 進める
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token: ed.token, body: [TEXT_CHANGE()] })).status).toBe(200);
    const afterChange = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(afterChange.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(afterChange.updatedBy).toBe(ed.userId);
    await new Promise((r) => setTimeout(r, 2));
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token: ed.token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50 }] })).status).toBe(200);
    const afterVariants = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(afterVariants.updatedAt).toBeGreaterThan(afterChange.updatedAt);
    expect(afterVariants.updatedBy).toBe(ed.userId);
  });

  it("targeting references block deletion of the referenced goal", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_buy", name: "購入", type: "CUSTOM", config: {} } });
    await createExperiment(token, sid, { id: "exp_ref", targeting: { and: [{ hist: "visited", page: { op: "contains", value: "/pricing" } }, { hist: "converted", goal: "g_buy" }] } });
    const g = await call("DELETE", `/sites/${sid}/goals/g_buy`, { token });
    expect(g.status).toBe(409);
    const gBody = (await expectEnvelope(g)) as { error: string; message: string };
    expect(gBody.error).toBe("goal_in_use");
    expect(gBody.message).not.toBe("goal_in_use");
    expect((gBody as Record<string, unknown>).hint).toBe("参照するエクスペリエンスの配信条件を外してください。参照を外してから削除してください"); // 終了したテストが無ければ今の案内のまま
    expect(gBody).not.toHaveProperty("archivedTests");
    // 参照を外せば削除できる
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_ref`, { token, body: { targeting: null } })).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/goals/g_buy`, { token })).status).toBe(204);
  });

  it("終了したテストの配信条件が参照する目標は、テストを削除するまで削除できない(D9 ③ の K10。hint は行き止まりにしない)", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_buy", name: "購入", type: "CUSTOM", config: {} } });
    await createExperiment(token, sid, { id: "exp_done", name: "終了した購入テスト", targeting: { hist: "converted", goal: "g_buy" } });
    await env.DB.prepare("update experiments set status = 'archived' where site_id = ? and id = 'exp_done'").bind(sid).run();
    const only = (await expectEnvelope(await call("DELETE", `/sites/${sid}/goals/g_buy`, { token }))) as Record<string, unknown>;
    expect(only).toMatchObject({ error: "goal_in_use", archivedTests: ["exp_done"], message: "この目標はエクスペリエンスの配信条件から参照されています" });
    expect(only.hint).toBe("終了したテスト(終了した購入テスト)が参照している間は削除できません(終了したテストを削除すると削除できます)");
    // 外せる参照も並ぶとき
    await createExperiment(token, sid, { id: "exp_draft", targeting: { hist: "converted", goal: "g_buy" } });
    const mixed = (await expectEnvelope(await call("DELETE", `/sites/${sid}/goals/g_buy`, { token }))) as Record<string, unknown>;
    expect(mixed.hint).toBe(
      "参照するエクスペリエンスの配信条件を外してください。参照を外してから削除してください。終了したテスト(終了した購入テスト)が参照している間は削除できません(終了したテストを削除すると削除できます)",
    );
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_draft`, { token, body: { targeting: null } })).status).toBe(200);
    // 終了したテストを削除すれば目標も削除できる
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_done`, { token })).status).toBe(204);
    expect((await call("DELETE", `/sites/${sid}/goals/g_buy`, { token })).status).toBe(204);
  });

  it("保存する形の配信条件の検査(古い書式・形の制限・参照・期間・正規表現・正規化。決定 49)", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId); // retentionDays は既定の 90
    const { id } = await createExperiment(token, sid);
    const V = { hist: "visited", page: { part: "path", op: "startsWith", value: "/pricing/" } };
    const patch = async (targeting: unknown) => json(await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { targeting } }));
    // 古い書式は zod の形の検査より先に見つけ、書き換え方を案内する(validation_failed に紛れさせない)
    expect(await patch({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, { hist: "visited", pattern: "p_pricing" }] })).toMatchObject({
      error: "legacy_targeting", path: ["targeting", "and", 1], hint: expect.stringContaining('"page"'),
    });
    expect(await patch({ and: [V, { or: [V, V] }] })).toMatchObject({ error: "invalid_experiment_targeting", path: ["targeting", "and", 1] });
    expect((await patch({ not: { ctx: "time", days: ["mon"] } })).error).toBe("invalid_experiment_targeting");
    expect(await patch({ audience: "aud_none" })).toMatchObject({ error: "unknown_audience", path: ["targeting"] });
    expect(await patch({ ...V, withinDays: 91 })).toMatchObject({ error: "within_days_exceeds_retention", max: 90 });
    expect(await patch({ hist: "visited", page: { op: "regex", value: "a" } })).toMatchObject({ error: "regex_not_allowed_on_url", path: ["targeting", "page", "value"] });
    // 受けたものは正規化して保存する(子 1 つのグループ・min: 1・part: url・not(not))
    const ok = await call("PATCH", `/sites/${sid}/experiments/${id}`, {
      token,
      body: { targeting: { and: [{ or: [{ hist: "visited", page: { part: "url", op: "contains", value: "/pricing/" }, min: 1 }] }, { not: { not: { ctx: "device", op: "in", value: ["mobile"] } } }] } },
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).targeting).toEqual({ and: [{ hist: "visited", page: { op: "contains", value: "/pricing/" } }, { ctx: "device", op: "in", value: ["mobile"] }] });
  });

  it("editor can create and edit, viewer cannot, delete only for draft/archived", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const ed = await inviteAndJoin(token, workspaceId, "editor");
    const v = await inviteAndJoin(token, workspaceId, "viewer");
    const { id } = await createExperiment(ed.token, sid);
    expect((await call("PATCH", `/sites/${sid}/experiments/${id}`, { token: v.token, body: { name: "x" } })).status).toBe(403);
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token: v.token, body: [TEXT_CHANGE()] })).status).toBe(403);
    expect((await call("GET", `/sites/${sid}/experiments`, { token: v.token })).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/experiments/${id}`, { token: ed.token })).status).toBe(204);
  });

  // 7n(G31 (b)): 終了の公開が失敗している間(status は archived、published_status は running / paused のまま)は削除できない
  it("delete_refuses_experiments_still_published_7n", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const setRow = (id: string, status: string, published: string | null) =>
      env.DB.prepare("update experiments set status = ?, published_status = ? where site_id = ? and id = ?").bind(status, published, sid, id).run();
    for (const published of ["running", "paused"]) {
      const { id } = await createExperiment(token, sid, { id: `exp_pub_${published}` });
      await setRow(id, "archived", published);
      const res = await call("DELETE", `/sites/${sid}/experiments/${id}`, { token });
      expect(res.status).toBe(409);
      expect(await expectEnvelope(res)).toMatchObject({ error: "experiment_active", message: "終了の公開が済んでいないため、まだ配信中です", hint: "もう一度公開して、終了を配り終えてから削除してください" });
      expect((await experimentRow(sid, id)).status).toBe("archived");
    }
    // 一度も公開していない下書き(published_status は NULL)と、終了を公開し終えたものは今までどおり消せる
    const { id: draft } = await createExperiment(token, sid, { id: "exp_never" });
    expect((await experimentRow(sid, draft)).published_status).toBeNull();
    expect((await call("DELETE", `/sites/${sid}/experiments/${draft}`, { token })).status).toBe(204);
    const { id: done } = await createExperiment(token, sid, { id: "exp_done_pub" });
    await setRow(done, "archived", "archived");
    expect((await call("DELETE", `/sites/${sid}/experiments/${done}`, { token })).status).toBe(204);
  });

  it("delete_refuses_when_published_status_turns_running_after_the_read_7n", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid, { id: "exp_race_pub" });
    await env.DB.prepare("update experiments set status = 'archived', published_status = 'archived', started_at = 1, run_id = 'run_race_pub' where site_id = ? and id = ?").bind(sid, id).run();
    // 削除の要求が読んだ後・削除の batch の前に、配信中の状態の写しが running になった(並行する公開が書いた)
    const racing = beforeD1Batch(env.DB, async () => {
      await env.DB.prepare("update experiments set published_status = 'running' where site_id = ? and id = ?").bind(sid, id).run();
    });
    const res = await call("DELETE", `/sites/${sid}/experiments/${id}`, { token, envOverride: { DB: racing } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "experiment_active", message: "終了の公開が済んでいないため、まだ配信中です", hint: "もう一度公開して、終了を配り終えてから削除してください" });
    expect((await experimentRow(sid, id)).published_status).toBe("running");
    // 退役・削除待ち・締め切りの印も書かない
    expect(await env.DB.prepare("select count(*) as n from retired_experiment_ids where site_id = ?").bind(sid).first("n")).toBe(0);
    expect(await env.DB.prepare("select count(*) as n from results_purge_queue where site_id = ?").bind(sid).first("n")).toBe(0);
    expect(await env.DB.prepare("select collect_until_dirty as d from sites where id = ?").bind(sid).first("d")).toBe(0);
  });

  it("hides experiments of other workspaces behind 404", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid);
    // 非メンバーは「別の Workspace に居るログイン済みの人」で作る。外された人はログイン状態そのものが切れるので(B20)
    // この Workspace の中身が 404 で隠れることを確かめるには使えない
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token, body: { name: "Second" } }));
    const outsider = await inviteAndJoin(token, second.id, "viewer");
    expect((await call("GET", `/sites/${sid}/experiments/${id}`, { token: outsider.token })).status).toBe(404);
    expect((await call("GET", `/sites/${sid}/experiments/exp_missing`, { token })).status).toBe(404);
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/zz/changes`, { token, body: [] })).status).toBe(404);
  });

  it("experiment can be recreated with the same id after delete", async () => {
    // D1 は FK を既定で強制する(公式 docs Foreign key constraints)。miniflare の CASCADE をこのテストで固定する
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid, { id: "exp_recreate" });
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] })).status).toBe(200);
    expect((await call("DELETE", `/sites/${sid}/experiments/${id}`, { token })).status).toBe(204);
    expect((await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_recreate", name: "Hero", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } })).status).toBe(201);
    const exp = await json(await call("GET", `/sites/${sid}/experiments/exp_recreate`, { token }));
    expect(exp.variants.map((v: any) => v.id)).toEqual(["a", "b"]); // 既定の Variant だけ
    expect(exp.variants.flatMap((v: any) => v.changes)).toEqual([]); // 旧 Change は CASCADE で消えている
  });

  it("variant replacement is atomic when a later statement fails", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid, { id: "exp_atomic" });
    const res = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "c", name: "C", weight: 50 }], envOverride: { DB: failingD1Insert(env.DB, "variants") } });
    expect(res.status).toBe(500);
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(exp.variants.map((v: any) => v.id)).toEqual(["a", "b"]); // 既定の集合が丸ごと残る
  });

  // carried-forward from Task 5's review (§13.8 決定): Variant の id / 重みは割当ハッシュの入力なので、
  // running / paused の間の全置換(PUT /variants)は配信中の訪問者を無言で再バケットしうる。archived は復帰不可
  // (「Stop してから編集」は行き止まり)かつ variant id を過去の analytics イベントが参照する履歴データなので、
  // task 7 review で draft 以外はすべて拒否する決定に拡張された。Task 5 は status を動かす手段が無かったため
  // 未検証のまま Task 7 に持ち越した。ここで DELETE と同じ 409 guard(draft 以外)を固定する
  it("PUT /variants is locked outside draft (running / paused / archived) — variant set is an input to assignment hashing and, once archived, a historical analytics reference", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid, { id: "exp_locked" });
    const body = [{ id: "a", name: "A", weight: 50 }, { id: "c", name: "C", weight: 50 }];
    // draft の間は編集できる(以降このまま誰にも変わらないことを確認する)
    expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/experiments/${id}/status`, { token, body: { status: "running" } })).status).toBe(200);
    const runningRes = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body });
    expect(runningRes.status).toBe(409);
    // Task 12: 発見時は message 未設定で code(experiment_active)がそのまま出ていた
    expect(await json(runningRes)).toMatchObject({ error: "experiment_active", message: "このエクスペリエンスのパターンは変更できません" });
    expect((await call("POST", `/sites/${sid}/experiments/${id}/status`, { token, body: { status: "paused" } })).status).toBe(200);
    const pausedRes = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body });
    expect(pausedRes.status).toBe(409);
    expect((await call("POST", `/sites/${sid}/experiments/${id}/status`, { token, body: { status: "archived" } })).status).toBe(200);
    const archivedRes = await call("PUT", `/sites/${sid}/experiments/${id}/variants`, { token, body });
    expect(archivedRes.status).toBe(409);
    const archivedBody = await json(archivedRes);
    // D9 ③(K10): 終了したテストは読み取り専用の専用コード(実行中・一時停止中は experiment_active のまま)
    expect(archivedBody).toMatchObject({ error: "experiment_archived_readonly", message: "終了したテストは編集できません" });
    // B65(A6)で外した複製の案内を、複製の機能(D9 ①)と一緒に戻す
    expect(archivedBody.hint).toContain("複製してください");
    // 3 回とも拒否されている = draft のときに置換した集合(a / c)のまま
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(exp.variants.map((v: any) => v.id)).toEqual(["a", "c"]);
  });
});

describe("experiment kind (決定 51、設計書 §3.1)", () => {
  it("creates a test by default and a single with one variant of weight 100", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id: tid } = await createExperiment(token, sid, { id: "exp_t" });
    const t = await json(await call("GET", `/sites/${sid}/experiments/${tid}`, { token }));
    expect(t.kind).toBe("test");
    expect(t.variants.map((v: any) => [v.id, v.weight])).toEqual([["a", 50], ["b", 50]]);
    const created = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_s", name: "S", kind: "single", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    expect(created.status).toBe(201);
    expect((await json(created)).kind).toBe("single");
    const s = await json(await call("GET", `/sites/${sid}/experiments/exp_s`, { token }));
    expect(s.variants.map((v: any) => [v.id, v.name, v.weight])).toEqual([["a", "A", 100]]);
    const list = await json(await call("GET", `/sites/${sid}/experiments`, { token }));
    expect(list.map((e: any) => [e.id, e.kind])).toEqual([["exp_t", "test"], ["exp_s", "single"]]);
  });

  it("variant count follows the kind", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_s", name: "S", kind: "single", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    const two = await call("PUT", `/sites/${sid}/experiments/exp_s/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50 }] });
    expect(two.status).toBe(422);
    const body = await expectEnvelope(two);
    expect(body).toMatchObject({ error: "variant_count_invalid", kind: "single", count: 2, message: "パーソナライズのパターンは 1 つだけです" });
    const renamed = await call("PUT", `/sites/${sid}/experiments/exp_s/variants`, { token, body: [{ id: "main", name: "本命", weight: 100 }] });
    expect(renamed.status).toBe(200);
    const weight50 = await call("PUT", `/sites/${sid}/experiments/exp_s/variants`, { token, body: [{ id: "main", name: "本命", weight: 50 }] });
    expect((await json(weight50)).error).toBe("variant_weights_invalid");
  });

  it("kind cannot be changed after creation", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id } = await createExperiment(token, sid);
    const res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { kind: "single" } });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toBe("validation_failed");
  });

  it("rejects an unknown kind", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const res = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_x", name: "X", kind: "personalize", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    expect(res.status).toBe(422);
  });

  it("single_start_publishes_one_variant", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_s", name: "S", kind: "single", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    await call("PUT", `/sites/${sid}/experiments/exp_s/variants/a/changes`, { token, body: [TEXT_CHANGE()] });
    const started = await json(await call("POST", `/sites/${sid}/experiments/exp_s/status`, { token, body: { status: "running" } }));
    expect(started.publish.ok).toBe(true);
    const detail = await json(await call("GET", `/sites/${sid}/publishes/${started.publish.version}`, { token }));
    expect(detail.config.experiments[0].variants.map((v: any) => [v.id, v.weight])).toEqual([["a", 100]]);
  });
});

// B69(spec §2.1・§4・§6.2.1・§9): 対象 URL の行の形と、配信条件・オーディエンスから外したページの条件
describe("対象 URL の行と外したページの条件(B69)", () => {
  const QUERY = { ctx: "query", name: "a", op: "exists" };
  const DEVICE = { ctx: "device", op: "in", value: ["mobile"] };
  const ROW = { page: { part: "path", op: "startsWith", value: "/lp/" } };
  async function site() {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    return { owner, sid };
  }
  /** 保存の検査を通らない古い条件を D1 に直接書く(更新の前に保存された行の形) */
  const writeLegacyTargeting = (sid: string, eid: string, targeting: unknown) =>
    env.DB.prepare("update experiments set targeting_json = ? where site_id = ? and id = ?").bind(JSON.stringify(targeting), sid, eid).run();
  const writeLegacyAudience = (sid: string, aid: string, definition: unknown) =>
    env.DB.prepare("insert into audiences (site_id, id, name, definition_json, created_at, updated_at) values (?, ?, ?, ?, 1, 1)").bind(sid, aid, aid, JSON.stringify(definition)).run();

  it("old_url_match_shape_is_422", async () => {
    const { owner, sid } = await site();
    for (const old of [{ op: "contains", value: "/" }, { part: "path", op: "startsWith", value: "/lp/" }]) {
      const res = await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_old", name: "Old", urlMatch: old } });
      expect(res.status).toBe(422);
      const body = await json<{ error: string; path: unknown; hint: string }>(res);
      expect(body).toMatchObject({ error: "invalid_input", path: ["urlMatch"] });
      expect(body.hint).toContain('"include"');
    }
    const { id: eid } = await createExperiment(owner.token, sid);
    const patched = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch: { op: "contains", value: "/" } } });
    expect(patched.status).toBe(422);
    expect(await json(patched)).toMatchObject({ error: "invalid_input", path: ["urlMatch"] });
  });

  it("url_match_limits_are_422", async () => {
    const { owner, sid } = await site();
    const post = (urlMatch: unknown) => call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_lim", name: "L", urlMatch } });
    // 含める行は 1〜10 行・除く行は 10 行まで・パラメータは 1 行 5 個まで(どの欄かを path で)
    expect(await json(await post({ include: Array.from({ length: 11 }, () => ROW) }))).toMatchObject({ error: "validation_failed", path: ["urlMatch", "include"] });
    expect(await json(await post({ include: [] }))).toMatchObject({ error: "validation_failed", path: ["urlMatch", "include"] });
    expect(await json(await post({ include: [ROW], exclude: Array.from({ length: 11 }, () => ROW) }))).toMatchObject({ error: "validation_failed", path: ["urlMatch", "exclude"] });
    const params = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, op: "exists" }));
    expect(await json(await post({ include: [{ ...ROW, params }] }))).toMatchObject({ error: "validation_failed", path: ["urlMatch", "include", 0, "params"] });
    // 全行の正規表現の命令数の合計が 500 を超えると早く断る(1 つは 198 命令。3 行で 594)
    const big = (k: number) => ({ page: { part: "path", op: "regex", value: `^/${k}.{0,97}` } });
    const total = await post({ include: [big(1), big(2)], exclude: [big(3)] });
    expect(total.status).toBe(422);
    expect(await json(total)).toMatchObject({ error: "url_match_too_large", path: ["urlMatch"] });
    // 範囲の中なら保存する(空の exclude・params は省く。行とパラメータの順は入力のまま)
    const kept = [{ ...ROW, params: [{ name: "b", op: "exists" }, { name: "a", op: "equals", value: "" }] }, { page: { op: "contains", value: "/x" }, params: [] }];
    const ok = await post({ include: kept, exclude: [] });
    expect(ok.status).toBe(201);
    expect((await json(ok)).urlMatch).toEqual({ include: [kept[0], { page: { op: "contains", value: "/x" } }] });
  });

  // B69 追補: 行の「かつ」の条件(and)
  const AND_HOST = { part: "host", op: "equals", value: "www.example.com" };
  const AND_REGEX = { part: "path", op: "regex", value: "^/[a-z]+/$" };

  it("save_and_round_trip", async () => {
    const { owner, sid } = await site();
    // 入力の順のまま保存・正規化(part 省略 = url の contains は正規化で part: "url" になる)。空の and は省く
    const sent = { include: [{ page: { part: "path", op: "startsWith", value: "/lp/" }, and: [AND_HOST, { part: "path", op: "contains", value: "x" }, AND_REGEX] }, { page: { op: "contains", value: "/y" }, and: [] }] };
    const stored = { include: [{ page: sent.include[0]!.page, and: sent.include[0]!.and }, { page: { part: "url", op: "contains", value: "/y" } }] };
    const post = await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_and", name: "And", urlMatch: sent } });
    expect(post.status).toBe(201);
    const posted = (await json(post)).urlMatch;
    expect(posted.include[0]).toEqual(stored.include[0]);
    expect(posted.include[1].and).toBeUndefined();
    const got = await json(await call("GET", `/sites/${sid}/experiments/exp_and`, { token: owner.token }));
    expect(got.urlMatch).toEqual(posted);
    // PATCH で and を入れ替える(順は入力のまま)
    const next = { include: [{ page: { part: "host", op: "equals", value: "a.example.com" }, and: [AND_REGEX, AND_HOST] }] };
    const patch = await call("PATCH", `/sites/${sid}/experiments/exp_and`, { token: owner.token, body: { urlMatch: next } });
    expect(patch.status).toBe(200);
    expect((await json(patch)).urlMatch).toEqual(next);
    expect((await json(await call("GET", `/sites/${sid}/experiments/exp_and`, { token: owner.token }))).urlMatch).toEqual(next);
  });

  it("save_and_limit_422", async () => {
    const { owner, sid } = await site();
    const and6 = Array.from({ length: 6 }, () => AND_HOST);
    const res = await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_and6", name: "A6", urlMatch: { include: [{ ...ROW, and: and6 }] } } });
    expect(res.status).toBe(422);
    const body = await json<{ error: string; path: unknown[] }>(res);
    expect(body.error).toBe("validation_failed");
    expect(body.path).toEqual(["urlMatch", "include", 0, "and"]);
    // 5 個までは保存できる
    expect((await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_and5", name: "A5", urlMatch: { include: [{ ...ROW, and: and6.slice(0, 5) }] } } })).status).toBe(201);
  });

  it("save_and_regex_error_has_index_length", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid);
    const patch = (urlMatch: unknown) => call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch } });
    // URL 全体の正規表現の and は 422(page と同じ)
    const urlWide = await patch({ include: [{ ...ROW, and: [{ op: "regex", value: "^/a" }] }] });
    expect(urlWide.status).toBe(422);
    expect(await json(urlWide)).toMatchObject({ error: "regex_not_allowed_on_url", path: ["urlMatch", "include", 0, "and", 0, "value"], index: expect.any(Number), length: expect.any(Number) });
    // 対象 URL の保存だけが、ホストを絞るときの and の案内を足す
    expect((await json<{ message: string }>(await patch({ include: [{ ...ROW, and: [{ op: "regex", value: "^/a" }] }] }))).message).toContain("かつ");
    // 式の誤りは位置(index / length)と書き換えの例つき。2 行目・exclude の and の path も正しい
    const bad = await patch({ include: [ROW, { ...ROW, and: [AND_HOST, { part: "path", op: "regex", value: "^/a(?=b)" }] }], exclude: [{ ...ROW, and: [AND_REGEX] }] });
    expect(bad.status).toBe(422);
    const body = await json<{ error: string; path: unknown[]; index: number; length: number; message: string }>(bad);
    expect(body.path).toEqual(["urlMatch", "include", 1, "and", 1, "value"]);
    expect(typeof body.index).toBe("number");
    expect(typeof body.length).toBe("number");
    expect(body.message.length).toBeGreaterThan(0);
    // page の誤りの封筒と同じ形(error・path 以外のキーが同じ)
    const pageBad = await json<Record<string, unknown>>(await patch({ include: [{ page: { part: "path", op: "regex", value: "^/a(?=b)" } }] }));
    expect(Object.keys(pageBad).sort()).toEqual(Object.keys(body).sort());
    expect(pageBad).toMatchObject({ error: body.error, path: ["urlMatch", "include", 0, "page", "value"], index: body.index, length: body.length });
    // exclude の and
    const ex = await json(await patch({ include: [ROW], exclude: [{ ...ROW, and: [{ part: "path", op: "regex", value: "^/a(?=b)" }] }] }));
    expect(ex).toMatchObject({ path: ["urlMatch", "exclude", 0, "and", 0, "value"] });
  });

  it("save_and_instructions_422", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid);
    const big = (k: number) => ({ part: "path", op: "regex", value: `^/${k}.{0,97}` }); // 198 命令
    // page が 198 + and が 198 + 198 = 594 > 500(and だけの追加で超える)
    const res = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch: { include: [{ page: big(1), and: [big(2), big(3)] }] } } });
    expect(res.status).toBe(422);
    const body = await json<{ error: string; path: unknown[]; hint: string; index?: number }>(res);
    expect(body).toMatchObject({ error: "url_match_too_large", path: ["urlMatch"] });
    expect(body.hint).toContain("かつ");
    expect(body.index).toBeUndefined();
    // 2 つ(396)なら保存できる
    expect((await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch: { include: [{ page: big(1), and: [big(2)] }] } } })).status).toBe(200);
  });

  it("publish_compiles_and", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_pub", urlMatch: { include: [{ page: { part: "path", op: "startsWith", value: "/lp/" }, and: [AND_HOST, AND_REGEX] }] } });
    await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const version = Number(await env.CONFIG_KV.get(kvKeys.active(sid)));
    const cfg = parseCompiledConfig(JSON.parse((await env.CONFIG_KV.get(kvKeys.config(sid, version)))!))!;
    const row = cfg.experiments.find((e) => e.id === eid)!.urlMatch.include[0]!;
    expect(row.and).toHaveLength(2);
    expect(row.and![0]).toEqual({ part: "host", op: "equals", value: "www.example.com" }); // 正規表現でなければ prog は付かない
    expect(row.and![1]).toMatchObject({ part: "path", op: "regex", value: "^/[a-z]+/$" });
    expect(row.and![1]).toHaveProperty("prog"); // 正規表現の and にはコンパイル済みの prog
    expect(row.page).not.toHaveProperty("prog");
  });

  it("moved_page_condition_is_422", async () => {
    const { owner, sid } = await site();
    const post = (targeting: unknown) => call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_q", name: "Q", urlMatch: { include: [ROW] }, targeting } });
    const direct = await post(QUERY);
    expect(direct.status).toBe(422);
    expect(await json(direct)).toMatchObject({ error: "invalid_experiment_targeting", path: ["targeting"], message: PAGE_CONDITION_MOVED_MESSAGE, hint: PAGE_CONDITION_MOVED_HINT });
    const nested = await post({ and: [DEVICE, { not: { ctx: "path", op: "startsWith", value: "/lp/" } }] });
    expect(await json(nested)).toMatchObject({ error: "invalid_experiment_targeting", path: ["targeting", "and", 1, "not"], message: PAGE_CONDITION_MOVED_MESSAGE });
    const { id: eid } = await createExperiment(owner.token, sid);
    const patched = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { targeting: { ctx: "host", op: "equals", value: "example.com" } } });
    expect(await json(patched)).toMatchObject({ error: "invalid_experiment_targeting", message: PAGE_CONDITION_MOVED_MESSAGE });
    // オーディエンスの保存(作成・更新)
    const aud = await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_q", name: "Q", definition: { or: [DEVICE, { ctx: "url", op: "contains", value: "/lp/" }] } } });
    expect(aud.status).toBe(422);
    expect(await json(aud)).toMatchObject({ error: "invalid_audience_definition", path: ["definition", "or", 1], message: PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE, hint: PAGE_CONDITION_MOVED_AUDIENCE_HINT });
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_ok", name: "OK", definition: DEVICE } })).status).toBe(201);
    const audPatch = await call("PATCH", `/sites/${sid}/audiences/aud_ok`, { token: owner.token, body: { definition: QUERY } });
    expect(await json(audPatch)).toMatchObject({ error: "invalid_audience_definition", path: ["definition"], message: PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE });
  });

  it("get_returns_legacy_targeting", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_legacy" });
    const legacy = { and: [DEVICE, QUERY, { not: { ctx: "path", op: "regex", value: "^/a" } }] };
    await writeLegacyTargeting(sid, eid, legacy);
    await writeLegacyAudience(sid, "aud_legacy", { or: [DEVICE, { ctx: "host", op: "endsWith", value: "example.com" }] });
    const one = await call("GET", `/sites/${sid}/experiments/${eid}`, { token: owner.token });
    expect(one.status).toBe(200);
    const body = await json(one);
    expect(body.targeting).toEqual(legacy);
    // 応答は OpenAPI の応答の schema に合う(読み取りの schema は古い条件も表せる)
    expect(ExperimentDetailJsonSchema.safeParse(body).success).toBe(true);
    const list = await json(await call("GET", `/sites/${sid}/experiments`, { token: owner.token }));
    expect(z.array(ExperimentJsonSchema).safeParse(list).success).toBe(true);
    const aud = await call("GET", `/sites/${sid}/audiences/aud_legacy`, { token: owner.token });
    expect(aud.status).toBe(200);
    expect(AudienceJsonSchema.safeParse(await json(aud)).success).toBe(true);
    expect(z.array(AudienceJsonSchema).safeParse(await json(await call("GET", `/sites/${sid}/audiences`, { token: owner.token }))).success).toBe(true);
    // 同じ値の保存は案内付きの 422
    const resave = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { targeting: body.targeting } });
    expect(await json(resave)).toMatchObject({ error: "invalid_experiment_targeting", path: ["targeting", "and", 1], hint: PAGE_CONDITION_MOVED_HINT });
  });

  it("patch_without_targeting_passes_on_legacy_row", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid);
    await writeLegacyTargeting(sid, eid, QUERY);
    const res = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { name: "改名", trafficPercentage: 50, urlMatch: { include: [ROW] } } });
    expect(res.status).toBe(200);
    const row = await experimentRow(sid, eid);
    expect(JSON.parse(row.targeting_json!)).toEqual(QUERY); // 古い条件はそのまま残る(片付けを止めない)
    expect(row.name).toBe("改名");
    expect(JSON.parse(row.url_match_json)).toEqual({ include: [ROW] });
  });

  it("duplicate_copies_legacy_row", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_src" });
    await writeLegacyTargeting(sid, eid, { and: [DEVICE, QUERY] });
    const res = await call("POST", `/sites/${sid}/experiments/${eid}/duplicate`, { token: owner.token, body: { mode: "same" } });
    expect(res.status).toBe(201);
    const copy = await json<{ id: string; targeting: unknown }>(res);
    expect(copy.targeting).toEqual({ and: [DEVICE, QUERY] });
    expect(JSON.parse((await experimentRow(sid, copy.id)).targeting_json!)).toEqual({ and: [DEVICE, QUERY] });
  });
});
