import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, choosePrimaryGoal, createExperiment, createSite, fakeResultsBudget, joinWithPassword, json, RESULTS_STORE, setupOwner } from "./helpers";

/**
 * 利用者(エージェント・運用者)に見える文字列に、非公開の開発記録への参照を出さない。
 * パターンの正は開発リポジトリの release/manifest.json の privateRefPatterns をそのまま写す(同期を保つ)。
 */
const PRIVATE_REF = /決定 ?[0-9]+|spec ?§|spec R[0-9]|§ ?[0-9]|Plan ?[0-9]+|Task ?[0-9]+|(^|[^A-Za-z0-9])S[0-9]+([^A-Za-z0-9]|$)|判断記録|superpowers\/|docs\/dev\/|_study_|research_v[0-9]|competitor_research|backlog\.md|s1-probe|release-checklist|1 号サイト/u;
const noPrivateRef = (label: string, text: string) => expect(PRIVATE_REF.exec(text)?.[0], `${label} に非公開参照がある`).toBeUndefined();

describe("public strings carry no private design references", () => {
  it("openapi_json_and_llms_txt", async () => {
    noPrivateRef("/openapi.json", await (await call("GET", "/openapi.json")).text());
    noPrivateRef("/llms.txt", await (await call("GET", "/llms.txt")).text());
  });

  it("analytics_recipe_response", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id: eid } = await createExperiment(token, sid);
    const res = await call("GET", `/sites/${sid}/experiments/${eid}/analytics-recipe`, { token });
    expect(res.status).toBe(200);
    noPrivateRef("analytics-recipe", JSON.stringify(await json(res)));
  });

  it("b77_openapi_fields_and_value_envelopes", async () => {
    // B77: 目標の analytics・パターンの original / description・パターンのメモのルートが文書に載り、その説明に非公開参照が無い
    const doc = (await (await call("GET", "/openapi.json")).json()) as { paths: Record<string, Record<string, unknown>> };
    const memoRoute = doc.paths["/sites/{sid}/experiments/{eid}/variants/{vid}"]?.patch;
    expect(memoRoute).toBeDefined();
    noPrivateRef("PATCH …/variants/{vid}", JSON.stringify(memoRoute));
    for (const [path, method] of [
      ["/sites/{sid}/goals", "post"],
      ["/sites/{sid}/goals/{gid}", "patch"],
      ["/sites/{sid}/experiments/{eid}/variants", "put"],
    ] as const) {
      const op = JSON.stringify(doc.paths[path]?.[method]);
      expect(op, `${method} ${path}`).toMatch(/"(analytics|original)"/);
      noPrivateRef(`${method} ${path}`, op);
    }
    // 値の検査の封筒と、名前の長さの封筒(hint を改めた)
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const value = await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_x", name: "x", type: "CUSTOM", config: {}, analytics: { overrides: { goalName: "改\n行" } } } });
    expect(value.status).toBe(422);
    noPrivateRef("invalid_analytics_value", JSON.stringify(await json(value)));
    const name = await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_y", name: "あ".repeat(101), type: "CUSTOM", config: {} } });
    const nameBody = await json(name);
    expect(nameBody.hint).toBe("名前は管理画面の中だけで使います。100 字以内にしてください");
    noPrivateRef("name_too_long", JSON.stringify(nameBody));
  });

  it("error_envelopes_with_hints", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const byoid = await call("PATCH", `/sites/${sid}`, { token, body: { idSource: "cookie:_ab_vid" } });
    expect(byoid.status).toBe(422);
    noPrivateRef("byoid_cookie_name_conflict", JSON.stringify(await json(byoid)));
    const modeB = await call("PATCH", `/sites/${sid}`, { token, body: { mode: "B", hosts: ["www.example.com"], idSource: "cookie:sid" } });
    expect(modeB.status).toBe(422);
    noPrivateRef("mode_b_requires_id_source_ab", JSON.stringify(await json(modeB)));
    const { id: eid } = await createExperiment(token, sid);
    const attr = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token,
      body: [{ id: "c1", type: "ATTRIBUTE", selector: "a.cta", payload: { name: "onclick", value: "x" } }],
    });
    expect(attr.status).toBe(422);
    noPrivateRef("attribute_not_allowed", JSON.stringify(await json(attr)));
    const img = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token,
      envOverride: { ASSETS: undefined },
      body: [{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: "https://cdn.example.com/x.png" } }],
    });
    expect(img.status).toBe(422);
    noPrivateRef("image_upload_disabled", JSON.stringify(await json(img)));
    const count = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 100 }] });
    expect(count.status).toBe(422);
    noPrivateRef("variant_count_invalid", JSON.stringify(await json(count)));
    await call("POST", `/sites/${sid}/experiments/${eid}/duplicate`, { token, body: { mode: "variant", variantId: "b", id: "exp_dup_single" } });
    const mode = await call("POST", `/sites/${sid}/experiments/exp_dup_single/duplicate`, { token, body: { mode: "variant", variantId: "b" } });
    expect(mode.status).toBe(422);
    noPrivateRef("duplicate_mode_not_allowed", JSON.stringify(await json(mode)));
    // B112: 非常用のパスワードログインのセッションからの API キーの発行(パスワードのセッションは非常口を開いた env で作る)
    const pw = await joinWithPassword({ token, workspaceId });
    const pwKey = await call("POST", "/me/api-keys", { token: pw.token, body: { name: "pw", workspaceId } });
    expect(pwKey.status).toBe(403);
    const pwKeyBody = await json(pwKey);
    expect(pwKeyBody.error).toBe("password_session");
    noPrivateRef("password_session", JSON.stringify(pwKeyBody));
    // D9 ②: 計測用 D1 が無い導入で結果の記録を有効にしようとした
    const store = await call("PATCH", `/sites/${sid}`, { token, body: { resultsEnabled: true } });
    expect(store.status).toBe(409);
    const storeBody = await json(store);
    expect(storeBody.error).toBe("results_store_missing");
    noPrivateRef("results_store_missing", JSON.stringify(storeBody));
    // D9 ③(K25): 評価計画のエラー。結果を記録するサイトで、判定に使う目標が無い・基準の重みが 0 の開始
    const recorded = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
    const { id: rec } = await json<{ id: string }>(recorded);
    const { id: planExp } = await createExperiment(token, rec);
    const start = () => call("POST", `/sites/${rec}/experiments/${planExp}/status`, { token, body: { status: "running" }, envOverride: RESULTS_STORE });
    // 下書きのテストの結果
    const notStarted = await json(await call("GET", `/sites/${rec}/experiments/${planExp}/results`, { token, envOverride: RESULTS_STORE }));
    expect(notStarted.error).toBe("results_not_started");
    noPrivateRef("results_not_started", JSON.stringify(notStarted));
    const noGoal = await start();
    expect((await json(noGoal.clone())).error).toBe("evaluation_plan_incomplete");
    noPrivateRef("evaluation_plan_incomplete (goal)", JSON.stringify(await json(noGoal)));
    await choosePrimaryGoal(token, rec, planExp);
    await call("PUT", `/sites/${rec}/experiments/${planExp}/variants`, { token, body: [{ id: "a", name: "A", weight: 0 }, { id: "b", name: "B", weight: 100 }] });
    const zero = await json(await start());
    expect(zero.error).toBe("evaluation_plan_incomplete");
    noPrivateRef("evaluation_plan_incomplete (baseline)", JSON.stringify(zero));
    const planPath = `/sites/${rec}/experiments/${planExp}/evaluation-plan`;
    expect((await call("PUT", planPath, { token, body: { plan: { baselineVariantId: "b" } } })).status).toBe(200);
    expect((await start()).status).toBe(200);
    // 開始後に縮める・評価時点の後・終了したテスト・結果を記録しない開始のテスト・パーソナライズ
    const locked = await json(await call("PUT", planPath, { token, body: { plan: { minDays: 7 } } }));
    expect(locked.error).toBe("evaluation_plan_locked");
    noPrivateRef("evaluation_plan_locked", JSON.stringify(locked));
    await env.DB.prepare("update experiments set started_at = ? where site_id = ? and id = ?").bind(Date.now() - 15 * 24 * 60 * 60 * 1000, rec, planExp).run();
    const fixed = await json(await call("PUT", planPath, { token, body: { plan: { minDays: 21 } } }));
    expect(fixed.error).toBe("evaluation_already_fixed");
    noPrivateRef("evaluation_already_fixed", JSON.stringify(fixed));
    // 目標参加者数のある計画を延ばすとき、到達を確かめる読み取りの予約が断られた(503)
    const { id: reachExp } = await createExperiment(token, rec, { id: "exp_reach" });
    await choosePrimaryGoal(token, rec, reachExp);
    const reachPlan = `/sites/${rec}/experiments/${reachExp}/evaluation-plan`;
    expect((await call("PUT", reachPlan, { token, body: { plan: { targetPerVariant: 1000 } } })).status).toBe(200);
    expect((await call("POST", `/sites/${rec}/experiments/${reachExp}/status`, { token, body: { status: "running" }, envOverride: RESULTS_STORE })).status).toBe(200);
    const unavailable = await json(
      await call("PUT", reachPlan, { token, body: { plan: { minDays: 21 } }, envOverride: { ...RESULTS_STORE, RESULTS_BUDGET: fakeResultsBudget({ readBudget: 0 }).ns } }),
    );
    expect(unavailable.error).toBe("results_read_unavailable");
    noPrivateRef("results_read_unavailable", JSON.stringify(unavailable));
    // 開始後のテストで配信率を下げる・割当の固定を変える
    const lockedTraffic = await json(await call("PATCH", `/sites/${rec}/experiments/${planExp}`, { token, body: { trafficPercentage: 10 } }));
    expect(lockedTraffic.error).toBe("test_setting_locked");
    noPrivateRef("test_setting_locked (traffic)", JSON.stringify(lockedTraffic));
    const lockedPersist = await json(await call("PATCH", `/sites/${rec}/experiments/${planExp}`, { token, body: { persistAssignment: true } }));
    expect(lockedPersist.error).toBe("test_setting_locked");
    noPrivateRef("test_setting_locked (persist)", JSON.stringify(lockedPersist));
    // 採用: 実行中のテストへの PUT(409)・パターンに無い ID(422)・終了以外の遷移に付けた採用(422)
    const adoptRunning = await json(await call("PUT", `/sites/${rec}/experiments/${planExp}/adoption`, { token, body: { variantId: "b" } }));
    expect(adoptRunning.error).toBe("adoption_not_allowed");
    noPrivateRef("adoption_not_allowed (409)", JSON.stringify(adoptRunning));
    const adoptPause = await json(await call("POST", `/sites/${rec}/experiments/${planExp}/status`, { token, body: { status: "paused", adoption: { variantId: "b" } } }));
    expect(adoptPause.error).toBe("adoption_not_allowed");
    noPrivateRef("adoption_not_allowed (422)", JSON.stringify(adoptPause));
    const adoptUnknown = await json(await call("POST", `/sites/${rec}/experiments/${planExp}/status`, { token, body: { status: "archived", adoption: { variantId: "zz" } } }));
    expect(adoptUnknown.error).toBe("unknown_variant");
    noPrivateRef("unknown_variant", JSON.stringify(adoptUnknown));
    expect((await call("POST", `/sites/${rec}/experiments/${planExp}/status`, { token, body: { status: "archived" } })).status).toBe(200);
    const readonlyPatch = await json(await call("PATCH", `/sites/${rec}/experiments/${planExp}`, { token, body: { name: "終了後" } }));
    expect(readonlyPatch.error).toBe("experiment_archived_readonly");
    noPrivateRef("experiment_archived_readonly (patch)", JSON.stringify(readonlyPatch));
    const readonly = await json(await call("PUT", planPath, { token, body: { plan: { minDays: 21 } } }));
    expect(readonly.error).toBe("experiment_archived_readonly");
    noPrivateRef("experiment_archived_readonly", JSON.stringify(readonly));
    const { id: unfixed } = await createExperiment(token, sid);
    expect((await call("POST", `/sites/${sid}/experiments/${unfixed}/status`, { token, body: { status: "running" } })).status).toBe(200);
    const unfixedBody = await json(await call("PUT", `/sites/${sid}/experiments/${unfixed}/evaluation-plan`, { token, body: { plan: { minDays: 21 } } }));
    expect(unfixedBody.error).toBe("evaluation_plan_locked");
    noPrivateRef("evaluation_plan_locked (not fixed)", JSON.stringify(unfixedBody));
    const { id: single } = await createExperiment(token, sid, { kind: "single" });
    const na = await json(await call("GET", `/sites/${sid}/experiments/${single}/evaluation-plan`, { token }));
    expect(na.error).toBe("results_not_applicable");
    noPrivateRef("results_not_applicable", JSON.stringify(na));
    // backlog D13: 凍結中の 503 の封筒(4 通りの hint のうち、未来の見込みと読めない値)
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\",\"until\":\"2099-01-01T00:00:00+09:00\"}', 1)").run();
    noPrivateRef("write_frozen", JSON.stringify(await json(await call("PATCH", `/sites/${sid}`, { token, body: {} }))));
    await env.DB.prepare("update instance_settings set value = 'x' where key = 'writeFreeze'").run();
    noPrivateRef("write_frozen_unreadable", JSON.stringify(await json(await call("PATCH", `/sites/${sid}`, { token, body: {} }))));
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    // plan12: 古い管理画面の書き込みを断る 426 の封筒(代表の 4 種目)。形に合わない名乗りは版 0 = 古い
    const tooOld = await call("PATCH", `/sites/${sid}`, { token, headers: { "x-wtt-client-version": "abc" }, body: {} });
    expect(tooOld.status).toBe(426);
    const tooOldBody = await json(tooOld);
    expect(tooOldBody.error).toBe("client_too_old");
    noPrivateRef("client_too_old", JSON.stringify(tooOldBody));
  }, 20_000);
});
