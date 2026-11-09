import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { IMAGE_DISABLED_HINT, LIBRARY_DISABLED_HINT } from "../src/capabilities";
import { call, choosePrimaryGoal, createExperiment, createSite, fakeDeployer, fakeResultsBudget, joinWithPassword, json, RESULTS_STORE, setupOwner } from "./helpers";

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

  it("openapi_url_match_describes_and", async () => {
    // B69 追補(追 §9): 契約の基準(contract-snapshot)は description を除くので、urlMatch の説明に and と上限を書いたことをここで見る
    const text = await (await call("GET", "/openapi.json")).text();
    const desc = /対象 URL。含める行[^"]*/u.exec(text)?.[0] ?? "";
    expect(desc).toContain("and");
    expect(desc).toMatch(/and。0〜5 個/u);
    noPrivateRef("urlMatch description", desc);
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

  it("asset_guard_failures", async () => {
    // B68: 公開の失敗(asset_missing / asset_other_site)と、状態を変える口の開始の 409 の封筒
    const { token, workspaceId } = await setupOwner();
    const base = env.AB_ASSET_PUBLIC_BASE as string;
    for (const src of [(sid: string) => `${base}/sites/${sid}/images/asset_pubstraaaa.png`, () => `${base}/sites/site_other/images/asset_pubstrbbbb.png`]) {
      const { id: sid } = await createSite(token, workspaceId);
      const { id: eid } = await createExperiment(token, sid);
      const html = { id: "c1", type: "HTML", selector: ".box", payload: { html: `<img src="${src(sid)}">`, position: "append", runScripts: false } };
      expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [html] })).status).toBe(200);
      const start = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "running" } });
      expect(start.status).toBe(409);
      noPrivateRef("asset guard 409", JSON.stringify(await json(start)));
      await env.DB.prepare("update experiments set status = 'running' where site_id = ?1").bind(sid).run();
      const pub = await json<{ ok: boolean }>(await call("POST", `/sites/${sid}/publish`, { token }));
      expect(pub.ok).toBe(false);
      noPrivateRef("asset guard publish failure", JSON.stringify(pub));
    }
  });

  it("asset_library_envelopes", async () => {
    // B68: 画像のライブラリの口と、IMAGE の保存のエラーの封筒(message / hint)に非公開参照が無い。画面・エージェントが読む文をここで固定する
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id: eid } = await createExperiment(token, sid);
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const upload = async (name: string, over: Partial<typeof env> = {}) => {
      const fd = new FormData();
      fd.set("file", new File([PNG], name, { type: "image/png" }));
      return call("POST", `/sites/${sid}/assets`, { token, raw: fd, envOverride: over });
    };
    const a = await json<{ id: string; publicUrl: string }>(await upload("a.png"));
    const b = await json<{ id: string; publicUrl: string }>(await upload("b.png"));
    const put = (changes: unknown[]) => call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: changes });
    const envelope = async (label: string, res: Response, status: number, error: string) => {
      expect(res.status, label).toBe(status);
      const body = await json<{ error: string; message: string; hint?: string }>(res);
      expect(body.error, label).toBe(error);
      expect(body.message, label).toBeTruthy();
      noPrivateRef(label, JSON.stringify(body));
      return body;
    };
    // 名前の重なり(409)・上限(409)
    await envelope("asset_name_taken", await call("PATCH", `/sites/${sid}/assets/${b.id}`, { token, body: { name: "a.png" } }), 409, "asset_name_taken");
    await envelope("asset_quota_exceeded", await upload("c.png", { AB_ASSET_SITE_MAX_COUNT: "2" }), 409, "asset_quota_exceeded");
    // 保存の確かめ: 一覧に無い画像(422)・符号化した参照(422)・サイトの外の URL(422)
    const gone = `${a.publicUrl.replace(a.id, "asset_goneaaaaaa")}`;
    await envelope("asset_not_found", await put([{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: gone } }]), 422, "asset_not_found");
    await envelope(
      "asset_ref_encoded",
      await put([{ id: "c1", type: "HTML", selector: ".box", payload: { html: `<img src="${a.publicUrl.replaceAll("/", "&#47;")}">`, position: "append", runScripts: false } }]),
      422,
      "asset_ref_encoded",
    );
    // R2 の配下でない URL(image_outside_r2_domain)
    const outside = await envelope(
      "image_outside_r2_domain",
      await put([{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: "https://cdn.example.com/x.png" } }]),
      422,
      "image_outside_r2_domain",
    );
    expect(outside.hint).toContain("このサイトにアップロードした画像の URL だけ");
    // 使用中の画像の削除(409)
    expect((await put([{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: a.publicUrl } }])).status).toBe(200);
    const inUse = await envelope("asset_in_use", await call("DELETE", `/sites/${sid}/assets/${a.id}`, { token }), 409, "asset_in_use");
    expect(inUse.hint).toBeTruthy();
    // R2 が無い導入の IMAGE の 422 の hint(アップローダーの公開ベースだけの導入は、IMAGE の URL が外れれば image_outside_r2_domain)
    for (const over of [{ ASSETS: undefined }, { ASSETS: undefined, AB_UPLOADER_PUBLIC_BASE: "https://up.example.com" }] as Array<Partial<typeof env>>) {
      const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
        token,
        envOverride: over,
        body: [{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: "https://cdn.example.com/x.png" } }],
      });
      expect(res.status).toBe(422);
      const body = await json<{ error: string; hint?: string }>(res);
      noPrivateRef(`IMAGE without R2 (${body.error})`, JSON.stringify(body));
      if (body.error === "image_outside_r2_domain") expect(body.hint).toContain("このサイトにアップロードした画像の URL だけ");
    }
  }, 20_000);

  it("error_envelopes_with_hints", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const byoid = await call("PATCH", `/sites/${sid}`, { token, body: { idSource: "cookie:_wtt_vid" } });
    expect(byoid.status).toBe(422);
    noPrivateRef("byoid_cookie_name_conflict", JSON.stringify(await json(byoid)));
    const modeB = await call("PATCH", `/sites/${sid}`, { token, body: { mode: "B", idSource: "cookie:sid" } });
    expect(modeB.status).toBe(422);
    noPrivateRef("mode_b_requires_id_source_ab", JSON.stringify(await json(modeB)));
    // B148: 旧い欄と一覧の行の誤り
    const legacy = await call("PATCH", `/sites/${sid}`, { token, body: { hosts: ["www.example.com"] } });
    expect(legacy.status).toBe(422);
    noPrivateRef("legacy_domain_fields", JSON.stringify(await json(legacy)));
    const badDomains = await call("PATCH", `/sites/${sid}`, { token, body: { domains: ["www.example.com/a", "co.jp", "", "*.example.com"] } });
    expect(badDomains.status).toBe(422);
    noPrivateRef("invalid_domains", JSON.stringify(await json(badDomains)));
    const suffix = await call("PATCH", `/sites/${sid}`, { token, body: { domains: ["co.jp"] } });
    expect(suffix.status).toBe(422);
    noPrivateRef("invalid_domains (suffix)", JSON.stringify(await json(suffix)));
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
    const imgBody = await json<{ hint: string }>(img);
    noPrivateRef("image_upload_disabled", JSON.stringify(imgBody));
    // B68 Task 3: IMAGE の 422 とライブラリの口の 409 の hint は定数を分ける(どちらも非公開の参照が無い)
    expect(imgBody.hint).toBe(IMAGE_DISABLED_HINT);
    const lib = await call("POST", `/sites/${sid}/assets`, { token, raw: new FormData(), envOverride: { ASSETS: undefined } });
    expect(lib.status).toBe(409);
    const libBody = await json<{ hint: string }>(lib);
    expect(libBody.hint).toBe(LIBRARY_DISABLED_HINT.noUploader);
    noPrivateRef("image_upload_disabled (library)", JSON.stringify(libBody));
    noPrivateRef("LIBRARY_DISABLED_HINT.withUploader", LIBRARY_DISABLED_HINT.withUploader);
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
    const recorded = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domains: ["www.example.com"] }, envOverride: RESULTS_STORE });
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
    // 7o K21: デプロイ専用の Worker の状態を取れない 503(binding が無い / 届かない)
    for (const [reason, envOverride] of [["not_configured", {}], ["unreachable", { DEPLOYER: fakeDeployer("throw") }]] as const) {
      const unavailable = await call("GET", "/static/status", { token, envOverride });
      expect(unavailable.status).toBe(503);
      const body = await json(unavailable);
      expect(body).toMatchObject({ error: "static_deployer_unavailable", reason });
      noPrivateRef(`static_deployer_unavailable (${reason})`, JSON.stringify(body));
    }
  }, 20_000);
});
