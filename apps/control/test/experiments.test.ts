import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment, expectEnvelope, failingD1Insert, TEXT_CHANGE } from "./helpers";

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
    const dup = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_hero", name: "dup", urlMatch: { op: "contains", value: "/" } } });
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
    const first = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { trafficPercentage: 40, persistAssignment: true, urlMatch: { op: "startsWith", value: "/lp" } } });
    expect(first.status).toBe(200);
    // 別のフィールドだけを送った PATCH が既定値(100 / false)に戻さない
    const patched = await json(await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { name: "Hero 2" } }));
    expect(patched).toMatchObject({ name: "Hero 2", trafficPercentage: 40, persistAssignment: true, urlMatch: { op: "startsWith", value: "/lp" }, status: "draft" });
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
    // 値の長さは core の schema が authored 段階で拒否する(§10.9)
    res = await call("PATCH", `/sites/${sid}/experiments/${id}`, { token, body: { analytics: { extra: { test_group: "x".repeat(101) } } } });
    const tooLong = await json(res);
    expect(res.status).toBe(422);
    expect(tooLong.error).toBe("validation_failed");
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
    expect((await json(single)).error).toBe("validation_failed");
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
    // 参照を外せば削除できる
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_ref`, { token, body: { targeting: null } })).status).toBe(200);
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
    expect((await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_recreate", name: "Hero", urlMatch: { op: "contains", value: "/" } } })).status).toBe(201);
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
    expect(archivedBody).toMatchObject({ error: "experiment_active", message: "このエクスペリエンスのパターンは変更できません" });
    // B65(A6): 複製の機能がまだ無い版では「複製して」と案内しない(D9 ① のマージで複製の案内に戻す)
    expect(archivedBody.hint).toContain("新しいエクスペリエンスを作成してください");
    expect(archivedBody.hint).not.toContain("複製");
    // 3 回とも拒否されている = draft のときに置換した集合(a / c)のまま
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${id}`, { token }));
    expect(exp.variants.map((v: any) => v.id)).toEqual(["a", "c"]);
  });
});
