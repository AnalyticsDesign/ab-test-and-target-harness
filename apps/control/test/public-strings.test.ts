import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, createExperiment, createSite, json, setupOwner } from "./helpers";

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
    // backlog D13: 凍結中の 503 の封筒(4 通りの hint のうち、未来の見込みと読めない値)
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\",\"until\":\"2099-01-01T00:00:00+09:00\"}', 1)").run();
    noPrivateRef("write_frozen", JSON.stringify(await json(await call("PATCH", `/sites/${sid}`, { token, body: {} }))));
    await env.DB.prepare("update instance_settings set value = 'x' where key = 'writeFreeze'").run();
    noPrivateRef("write_frozen_unreadable", JSON.stringify(await json(await call("PATCH", `/sites/${sid}`, { token, body: {} }))));
  });
});
