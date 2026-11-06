import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment, failingD1Insert, expectEnvelope, seedAssetRow, recordingD1, testEnv } from "./helpers";
import { IMAGE_DISABLED_HINT, uploaderPublicBase } from "../src/capabilities";
import { extractUploaderSiteUrls } from "../src/asset-refs";
import type { Env } from "../src/env";

async function editorSetup() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
  const { id: eid } = await createExperiment(ed.token, sid);
  const put = (body: unknown, token = ed.token) => call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body });
  return { owner, sid, eid, ed, put };
}
const attr = (name: string, value: string, id = "c1") => ({ id, type: "ATTRIBUTE", selector: "a.cta", payload: { name, value } });

describe("change validation (spec §11, fail-closed on the save API)", () => {
  it("editor_cannot_set_event_handler_attribute", async () => {
    const { put } = await editorSetup();
    for (const name of ["onclick", "ONCLICK", "onmouseover"]) {
      const res = await put([attr(name, "alert(1)")]);
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body).toMatchObject({
        error: "attribute_not_allowed",
        attribute: name,
        hint: "HTML タイプを使ってください",
        message: `属性 ${name} は ATTRIBUTE では設定できません`, // Task 12: 旧は core の英語診断文がそのまま出ていた
      });
    }
  });

  it("editor_cannot_use_javascript_url", async () => {
    const { put } = await editorSetup();
    for (const value of ["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x"]) {
      const res = await put([attr("href", value)]);
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.error).toBe("attribute_url_not_allowed");
      expect(body.message, "message が core の英語診断文のまま").toBe("属性 href には http(s) か相対 URL だけを指定できます"); // Task 12
    }
    expect((await put([attr("href", "/lp2/"), attr("src", "https://cdn.example/a.png", "c2")])).status).toBe(200);
  });

  it("empty_html_payload_is_rejected_with_a_path", async () => {
    const { put } = await editorSetup();
    const res = await put([{ id: "c1", type: "HTML", selector: ".hero", payload: { html: "", position: "replace", runScripts: false } }]);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ error: "invalid_change", path: ["payload", "html"], message: "変更の内容が不正です" });
  });

  it("editor_cannot_change_form_target_to_external_origin", async () => {
    const { put } = await editorSetup();
    for (const name of ["action", "formaction"]) {
      const res = await put([{ id: "c1", type: "ATTRIBUTE", selector: "form", payload: { name, value: "https://evil.example/collect" } }]);
      expect(res.status).toBe(422);
      expect((await json(res)).error).toBe("attribute_not_allowed");
    }
  });

  it("unlisted_attribute_is_rejected_fail_closed", async () => {
    const { put, owner } = await editorSetup();
    // Role に関係なく(ADMIN でも)列挙外は 422
    for (const name of ["srcdoc", "style", "srcset", "contenteditable"]) {
      expect((await put([attr(name, "x")])).status).toBe(422);
      expect((await put([attr(name, "x")], owner.token)).status).toBe(422);
    }
    expect((await put([attr("data-track", "x"), attr("aria-label", "y", "c2"), attr("class", "z", "c3")])).status).toBe(200);
  });

  it("image_value_outside_r2_domain_rejected", async () => {
    const { put, sid } = await editorSetup();
    const img = (src: string) => ({ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src } });
    const base = env.AB_ASSET_PUBLIC_BASE; // wrangler.jsonc の vars(本番は R2 カスタムドメイン)
    const res = await put([img("https://placehold.co/600x200.png")]);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toBe("image_outside_r2_domain");
    // Task 12: 発見時は message 未設定で code(image_outside_r2_domain)がそのまま出ていた
    expect(body.message).toBe("画像 URL がこのサイトにアップロードした画像の URL ではありません");
    // B68 Task 3: 配下でも一覧に無い画像は 422 asset_not_found になるので、実在する画像の行(fixture)の公開 URL で 200 を見る
    await seedAssetRow(sid, { id: "asset_fixture001", url: `${base}/sites/${sid}/experiments/x/a.png` });
    await seedAssetRow(sid, { id: "asset_fixture002", url: `${base}/sites/${sid}/experiments/x/a%2eb.png` });
    expect((await put([img(`${base}/sites/${sid}/experiments/x/a.png`)])).status).toBe(200); // AB_ASSET_PUBLIC_BASE 配下 + 自 Site
    expect((await put([img(`${base}/sites/other_site/experiments/x/a.png`)])).status).toBe(422);
    expect((await put([img("/relative.png")])).status).toBe(422); // §6.4: IMAGE は絶対 URL のみ
    // 前方一致だけだと `…/sites/<sid>/../other_site/…` が通ってしまう(URL として正規化してから比べる)
    expect((await put([img(`${base}/sites/${sid}/../other_site/a.png`)])).status).toBe(422);
    expect((await put([img(`${base}/sites/${sid}/%2e%2e/other_site/a.png`)])).status).toBe(422);
    expect((await put([img(`${base}/sites/${sid}/%2E%2e/other_site/a.png`)])).status).toBe(422);
    expect((await put([img(`${base}/sites/${sid}/.%2e/other_site/a.png`)])).status).toBe(422);
    // 判定は「正規化後に配下か」の 1 本(rulings §4 CX-Low-1)。ドットセグメントでない場所の `%2e` は潜脱ではないので落とさない
    expect((await put([img(`${base}/sites/${sid}/experiments/x/a%2eb.png`)])).status).toBe(200);
  });

  it("routes a structurally invalid change to 422 invalid_change (core ChangeSchema の backstop)", async () => {
    const { put } = await editorSetup();
    // discriminatedUnion の判別子に無い type
    const unknownType = await put([{ id: "c1", type: "MAGIC", selector: ".x", payload: {} }]);
    expect(unknownType.status).toBe(422);
    const unknownTypeBody = await json(unknownType);
    expect(unknownTypeBody.error).toBe("invalid_change");
    expect(unknownTypeBody.message, "message が zod の英語メッセージのまま(旧: first?.message をそのまま流用)").toBe("変更の内容が不正です"); // Task 12
    // strictObject: 正しい branch でも payload に余計なキーがあれば拒否
    const extraKey = await put([{ id: "c1", type: "ATTRIBUTE", selector: "a", payload: { name: "href", value: "/x", extra: 1 } }]);
    expect(extraKey.status).toBe(422);
    expect((await json(extraKey)).error).toBe("invalid_change");
    // selector や payload そのものが欠けている場合も 500 ではなく 422
    for (const bad of [{ id: "c1", type: "TEXT", payload: { text: "x" } }, { id: "c1", type: "HIDE", selector: ".x" }, "not-an-object", null]) {
      const res = await put([bad]);
      expect(res.status).toBe(422);
      expect((await json(res)).error).toBe("invalid_change");
    }
  });

  it("change_value_over_64kb_rejected", async () => {
    const { put } = await editorSetup();
    // 境界: payload を JSON にした長さ(`{"text":"…"}` = 中身 + 11 バイト)が 65536 を 1 バイト超える
    const res = await put([{ id: "c1", type: "TEXT", selector: ".x", payload: { text: "x".repeat(65526) } }]);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toBe("change_too_large");
    // Task 12: 発見時は message 未設定で code(change_too_large)がそのまま出ていた
    expect(body.message).toBe("変更の内容が大きすぎます(最大 65536 バイト)");
    expect((await put([{ id: "c1", type: "TEXT", selector: ".x", payload: { text: "x".repeat(65525) } }])).status).toBe(200); // ちょうど 65536 バイト
  });

  it("rejects unknown change ids format and duplicate ids, and keeps the full set atomic", async () => {
    const { put, sid, eid, ed } = await editorSetup();
    const badId = await put([{ id: "Bad", type: "HIDE", selector: ".x", payload: {} }]);
    expect(badId.status).toBe(422);
    const badIdBody = await json(badId);
    expect(badIdBody.error).toBe("invalid_change_id");
    // Task 12: 発見時は英語(change id … must match slug rule)がそのまま出ていた
    expect(badIdBody.message).toBe("変更の ID(Bad)の形式が不正です(スラッグのみ)");
    const dup = await put([{ id: "c1", type: "HIDE", selector: ".x", payload: {} }, { id: "c1", type: "HIDE", selector: ".y", payload: {} }]);
    expect(dup.status).toBe(422);
    const dupBody = await json(dup);
    expect(dupBody.error).toBe("duplicate_change_id");
    expect(dupBody.message, "message が英語のまま(旧: duplicate change id)").toBe("変更の ID が重複しています"); // Task 12
    expect((await put([{ id: "c1", type: "HIDE", selector: ".x", payload: {} }, attr("onclick", "x", "c2")])).status).toBe(422);
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
    expect(exp.variants[1].changes).toEqual([]); // 1 件でも不正なら全体を書かない
  });

  it("replaces the whole set and keeps createdBy / createdAt of surviving changes", async () => {
    const { put, sid, eid, ed } = await editorSetup();
    expect((await put([attr("href", "/a/"), attr("href", "/b/", "c2")])).status).toBe(200);
    const first = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
    expect(first.variants[1].changes.map((ch: any) => ch.id)).toEqual(["c1", "c2"]);
    // created_by / created_at は API の応答に出さない列なので D1 を直接見る(全置換でも引き継ぐこと)
    const row = async () => env.DB.prepare("select created_at, created_by from changes where id = 'c1'").first<{ created_at: number; created_by: string }>();
    const created = (await row())!;
    await new Promise((r) => setTimeout(r, 2));
    expect((await put([attr("href", "/c/")])).status).toBe(200);
    const second = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
    expect(second.variants[1].changes.map((ch: any) => ch.id)).toEqual(["c1"]); // c2 は消える(全置換)
    expect(second.variants[1].changes[0].payload).toEqual({ name: "href", value: "/c/" });
    expect(await row()).toEqual(created); // 同じ id は作成情報を引き継ぐ
    expect(second.variants[1].changes[0].updatedAt).toBeGreaterThan(created.created_at);
    expect((await put([])).status).toBe(200); // 空配列で全消し
    expect((await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }))).variants[1].changes).toEqual([]);
  });

  // Task 13(E2E)で発覚: insert が 1 文 12 バインド × N 行の単一 INSERT だったため、9 件目で
  // D1 の「too many SQL variables」(上限 100/文)に当たって 500 になっていた。8 件ずつ複数の
  // INSERT 文に分けて同じ batch(= 1 トランザクション)に積む形に直した。8(旧チャンク境界)・
  // 9(旧: ここで壊れていた)・17(2 チャンク+1)・30(要件の目安)で境界をまたいでも壊れないことを見る
  it("replaces sets past the old D1 bind-parameter limit (30 changes) across chunk boundaries", async () => {
    const { put, sid, eid, ed } = await editorSetup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, type: "HIDE", selector: `.el-${i + 1}`, payload: {} }));
    for (const n of [8, 9, 17, 30]) {
      const res = await put(many(n));
      expect(res.status, `n=${n}`).toBe(200);
      expect(await json(res)).toEqual({ ok: true, count: n });
      const exp = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
      expect(exp.variants[1].changes.map((ch: any) => ch.id)).toEqual(many(n).map((c) => c.id));
    }
  });

  it("change replacement stays atomic across chunked inserts when the insert fails", async () => {
    const { put, sid, eid, ed } = await editorSetup();
    // 先に 1 件入れておく(バグ時は壊れて消える／不変であるべきの基準点)
    expect((await put([attr("href", "/keep/")])).status).toBe(200);
    const before = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i + 1}`, type: "HIDE", selector: `.el-${i + 1}`, payload: {} }));
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token: ed.token,
      body: many,
      envOverride: { DB: failingD1Insert(env.DB, "changes") },
    });
    expect(res.status).toBe(500);
    const after = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }));
    expect(after.variants[1].changes).toEqual(before.variants[1].changes); // 途中まで書けても丸ごとロールバックし、旧 c1 が残る
  });

  it("100 件は保存できるが 101 件は too_many_changes で拒否され、既存の Change は保持される(spec §11、決定 35)", async () => {
    const { put, sid, eid, ed } = await editorSetup();
    const text = (i: number) => ({ id: `c${i}`, type: "TEXT", selector: "h1", payload: { text: `t${i}` } });
    const hundred = Array.from({ length: 100 }, (_, i) => text(i));
    const ok = await put(hundred);
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, count: 100 });

    const res = await put([...hundred, text(100)]);
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: "too_many_changes",
      max: 100,
      message: "変更は 1 パターンあたり 100 件までです",
      hint: "変更を分割するか、不要な変更を削除してください",
    });
    // 拒否は保存前に起きるので、直前の 100 件がそのまま残る
    const list = await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token });
    expect(list.status).toBe(200);
    const body = await json<{ variants: Array<{ id: string; changes: unknown[] }> }>(list);
    expect(body.variants.find((v) => v.id === "b")!.changes).toHaveLength(100);
  });

  it("image_change_rejected_when_r2_disabled", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const { id: eid } = await createExperiment(token, sid);
    const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token,
      envOverride: { ASSETS: undefined },
      body: [{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: "https://cdn.example.com/x.png" } }],
    });
    expect(res.status).toBe(422);
    const body = await expectEnvelope(res);
    expect(body.error).toBe("image_upload_disabled"); // R2 配下検査(image_outside_r2_domain)より先に判定する
    // 同じ body で R2 ありなら従来どおり配下検査で落ちる
    const on = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token,
      body: [{ id: "c1", type: "IMAGE", selector: "img.hero", payload: { src: "https://cdn.example.com/x.png" } }],
    });
    expect((await expectEnvelope(on)).error).toBe("image_outside_r2_domain");
  });
});

// B68 plan Task 3(spec §4.5・§22.4、アップローダーの spec §10): IMAGE の保存を画像の一覧と照らす・アップローダーの URL・符号化した参照
describe("image changes point at existing site assets (B68)", () => {
  const R2 = env.AB_ASSET_PUBLIC_BASE!; // vitest.config.ts の値(http://localhost:8788/dev-assets)
  const UP = "https://up.example";
  const NO_R2: Partial<Env> = { ASSETS: undefined };
  const WITH_UP: Partial<Env> = { AB_UPLOADER_PUBLIC_BASE: UP };
  const UP_ONLY: Partial<Env> = { ASSETS: undefined, AB_UPLOADER_PUBLIC_BASE: UP };
  const img = (src: string, id = "c1") => ({ id, type: "IMAGE", selector: "img.hero", payload: { src } });
  const html = (h: string, id = "c1") => ({ id, type: "HTML", selector: ".hero", payload: { html: h, position: "replace", runScripts: false } });
  const css = (c: string, id = "c1") => ({ id, type: "CSS", payload: { css: c } });
  const putWith = (s: { sid: string; eid: string; ed: { token: string } }, body: unknown, envOverride?: Partial<Env>) =>
    call("PUT", `/sites/${s.sid}/experiments/${s.eid}/variants/b/changes`, { token: s.ed.token, body, envOverride });
  const touchesAssets = (sqls: string[]) => sqls.filter((q) => /\bassets\b/i.test(q));
  const snapshot = async (sid: string, eid: string) => ({
    changes: (await env.DB.prepare("select * from changes where site_id = ? and experiment_id = ? order by variant_id, position").bind(sid, eid).all()).results,
    exp: await env.DB.prepare("select updated_at, updated_by from experiments where site_id = ? and id = ?").bind(sid, eid).first(),
  });

  it("image_change_requires_existing_asset", async () => {
    const s = await editorSetup();
    const ok = await seedAssetRow(s.sid, { id: "asset_aaaaaaaaa1" });
    expect((await s.put([img(ok)])).status).toBe(200);
    const res = await s.put([attr("href", "/x/"), img(ok, "c2"), img(`${R2}/sites/${s.sid}/images/asset_missing001.png`, "c3")]);
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({
      error: "asset_not_found",
      path: ["changes", 2, "src"],
      hint: "この画像はサイトの画像の一覧にありません。削除された可能性があります。画像を選び直してください",
    });
  });

  it("rejected_save_writes_nothing", async () => {
    const s = await editorSetup();
    const ok = await seedAssetRow(s.sid, { id: "asset_aaaaaaaaa1" });
    expect((await s.put([attr("href", "/keep/"), img(ok, "c2")])).status).toBe(200);
    const before = await snapshot(s.sid, s.eid);
    await new Promise((r) => setTimeout(r, 2));
    // 正しい変更を同じ保存に混ぜても、どれも書かれない(オーナーで保存して updated_by の違いも見る)
    const res = await s.put([attr("href", "/new/"), img(ok, "c2"), img(`${R2}/sites/${s.sid}/images/asset_missing001.png`, "c3")], s.owner.token);
    expect(res.status).toBe(422);
    expect(await snapshot(s.sid, s.eid)).toEqual(before);
    // 符号化した参照の 422 も同じ
    const enc = await s.put([attr("href", "/new/"), html(`<img src="${ok.replaceAll("/", "&#47;")}">`, "c2")], s.owner.token);
    expect(enc.status).toBe(422);
    expect(await snapshot(s.sid, s.eid)).toEqual(before);
  });

  it("image_change_rejects_pending_deletion_asset", async () => {
    const s = await editorSetup();
    const url = await seedAssetRow(s.sid, { id: "asset_pending001", deletedAt: 5 });
    const res = await s.put([img(url)]);
    expect(res.status).toBe(422);
    expect((await expectEnvelope(res)).error).toBe("asset_not_found");
  });

  it("image_change_rejects_purge_marked_asset", async () => {
    const s = await editorSetup();
    const url = await seedAssetRow(s.sid, { id: "asset_purging001", deletedAt: 5, purgeMarkedAt: 6 });
    const res = await s.put([img(url)]);
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_not_found", path: ["changes", 0, "src"] });
  });

  it("image_change_rejects_thumbnail_url", async () => {
    const s = await editorSetup();
    await seedAssetRow(s.sid, { id: "asset_thumbed001" });
    const res = await s.put([img(`${R2}/sites/${s.sid}/thumbs/asset_thumbed001.webp`)]);
    expect(res.status).toBe(422);
    expect((await expectEnvelope(res)).error).toBe("asset_not_found");
  });

  it("image_change_rejects_other_site_asset", async () => {
    const s = await editorSetup();
    const other = await createSite(s.owner.token, s.owner.workspaceId);
    const url = await seedAssetRow(other.id, { id: "asset_othersite1" });
    const res = await s.put([img(url)]);
    expect(res.status).toBe(422);
    expect(await expectEnvelope(res)).toMatchObject({ error: "image_outside_r2_domain", allowedPrefix: `${R2}/sites/${s.sid}/` });
  });

  it("save_with_100_distinct_images_passes", async () => {
    const s = await editorSetup();
    const ids = Array.from({ length: 100 }, (_, i) => `asset_${String(i).padStart(10, "0")}`);
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at) values (?1, ?2, ?1, ?1, 'k', ?3, 'image/png', 1, 'skipped', 'u', 1, 1)`,
        ).bind(id, s.sid, `${R2}/sites/${s.sid}/images/${id}.png`),
      ),
    );
    const rec = recordingD1(env.DB);
    const res = await putWith(s, ids.map((id, i) => img(`${R2}/sites/${s.sid}/images/${id}.png`, `c${i}`)), { DB: rec.DB });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, count: 100 });
    expect(touchesAssets(rec.sqls), "IMAGE があっても assets の読みは 1 回").toHaveLength(1);
    expect(touchesAssets(rec.sqls)[0]).toMatch(/json_each/);
  });

  it("save_without_image_does_not_query_assets", async () => {
    const s = await editorSetup();
    const rec = recordingD1(env.DB);
    const res = await putWith(s, [attr("href", "/a/"), html("<p>x</p>", "c2"), css(".a{color:red}", "c3")], { DB: rec.DB });
    expect(res.status).toBe(200);
    expect(rec.sqls.length).toBeGreaterThan(0);
    expect(touchesAssets(rec.sqls)).toEqual([]);
  });

  it("image_change_accepts_uploader_url_without_asset_row", async () => {
    const s = await editorSetup();
    expect((await putWith(s, [img(`${UP}/u/${s.sid}/upl_a.png`)], WITH_UP)).status).toBe(200);
  });

  it("image_change_accepts_uploader_url_without_r2", async () => {
    const s = await editorSetup();
    expect((await putWith(s, [img(`${UP}/u/${s.sid}/upl_a.png`)], UP_ONLY)).status).toBe(200);
  });

  it("image_change_rejects_uploader_url_of_other_site", async () => {
    const s = await editorSetup();
    for (const [o, P] of [
      [WITH_UP, [`${R2}/sites/${s.sid}/`, `${UP}/u/${s.sid}/`]],
      [UP_ONLY, [`${UP}/u/${s.sid}/`]],
    ] as const) {
      for (const src of [`${UP}/u/other_site/upl_a.png`, `${UP}/u/${s.sid}/../other_site/upl_a.png`, `${UP}/u/${s.sid}/%2e%2e/other_site/upl_a.png`]) {
        const res = await putWith(s, [img(src)], o);
        expect(res.status, src).toBe(422);
        expect(await expectEnvelope(res)).toMatchObject({ error: "image_outside_r2_domain", allowedPrefix: P[0], allowedPrefixes: P });
      }
    }
  });

  it("image_change_rejects_uploader_shape_when_var_unset", async () => {
    const s = await editorSetup();
    const res = await s.put([img(`${UP}/u/${s.sid}/upl_a.png`)]); // 変数が無い(R2 だけ)
    expect(await expectEnvelope(res)).toMatchObject({ error: "image_outside_r2_domain", allowedPrefixes: [`${R2}/sites/${s.sid}/`] });
    const none = await putWith(s, [img(`${UP}/u/${s.sid}/upl_a.png`)], NO_R2);
    expect((await expectEnvelope(none)).error).toBe("image_upload_disabled");
  });

  it("image_change_ignores_malformed_uploader_base", async () => {
    const s = await editorSetup();
    for (const bad of ["http://up.example", "https://u:p@up.example", "https://up.example/?x=1", "https://up.example/#f", "https://up.example/x"]) {
      const host = new URL(bad).host.replace(/^.*@/, "");
      const src = `${new URL(bad).protocol}//${host}/u/${s.sid}/upl_a.png`;
      const withR2 = await putWith(s, [img(src)], { AB_UPLOADER_PUBLIC_BASE: bad });
      expect(await expectEnvelope(withR2), bad).toMatchObject({ error: "image_outside_r2_domain", allowedPrefixes: [`${R2}/sites/${s.sid}/`] });
      const noR2 = await putWith(s, [img(src)], { ASSETS: undefined, AB_UPLOADER_PUBLIC_BASE: bad });
      expect((await expectEnvelope(noR2)).error, bad).toBe("image_upload_disabled");
    }
  });

  it("uploader_url_does_not_query_assets", async () => {
    const s = await editorSetup();
    for (const o of [WITH_UP, UP_ONLY]) {
      const rec = recordingD1(env.DB);
      expect((await putWith(s, [img(`${UP}/u/${s.sid}/upl_a.png`)], { ...o, DB: rec.DB })).status).toBe(200);
      expect(touchesAssets(rec.sqls)).toEqual([]);
    }
  });

  it("image_upload_disabled_only_when_neither_r2_nor_uploader", async () => {
    const s = await editorSetup();
    const src = "https://cdn.example.com/x.png";
    expect((await expectEnvelope(await putWith(s, [img(src)], NO_R2))).error).toBe("image_upload_disabled");
    for (const o of [{}, WITH_UP, UP_ONLY]) expect((await expectEnvelope(await putWith(s, [img(src)], o))).error).toBe("image_outside_r2_domain");
  });

  // アップローダーの spec §10 の表(R2 の有無 × アップローダーの有無 × 6 行の src)の 24 のマス
  it("image_save_follows_the_uploader_spec_table", async () => {
    const s = await editorSetup();
    const sid = s.sid;
    const r2ok = await seedAssetRow(sid, { id: "asset_tablerow01" });
    const R2P = `${R2}/sites/${sid}/`;
    const UPP = `${UP}/u/${sid}/`;
    const configs = [
      { label: "r2_only", o: {} as Partial<Env>, P: [R2P] },
      { label: "r2_and_uploader", o: WITH_UP, P: [R2P, UPP] },
      { label: "uploader_only", o: UP_ONLY, P: [UPP] },
      { label: "neither", o: NO_R2, P: null },
    ];
    type Want = "ok" | "outside" | "disabled";
    const rows: Array<{ label: string; srcs: string[]; want: [Want, Want, Want, Want] }> = [
      { label: "r2_valid", srcs: [r2ok], want: ["ok", "ok", "outside", "disabled"] },
      { label: "uploader_valid", srcs: [`${UPP}upl_a.png`], want: ["outside", "ok", "ok", "disabled"] },
      { label: "r2_other_site", srcs: [`${R2}/sites/other_site/images/asset_tablerow01.png`], want: ["outside", "outside", "outside", "disabled"] },
      { label: "uploader_other_site", srcs: [`${UP}/u/other_site/upl_a.png`], want: ["outside", "outside", "outside", "disabled"] },
      {
        label: "dot_segments",
        srcs: [`${R2P}../other_site/x.png`, `${UPP}../other_site/x.png`, `${R2P}%2e%2e/other_site/x.png`, `${UPP}%2e%2e/other_site/x.png`],
        want: ["outside", "outside", "outside", "disabled"],
      },
      { label: "relative_or_external", srcs: ["/relative.png", "not a url", "https://cdn.example.com/x.png"], want: ["outside", "outside", "outside", "disabled"] },
    ];
    for (const row of rows) {
      for (const [ci, cfg] of configs.entries()) {
        for (const src of row.srcs) {
          const res = await putWith(s, [img(src)], cfg.o);
          const where = `${row.label} × ${cfg.label}: ${src}`;
          const want = row.want[ci];
          if (want === "ok") {
            expect(res.status, where).toBe(200);
            continue;
          }
          expect(res.status, where).toBe(422);
          const body = await expectEnvelope(res);
          if (want === "disabled") {
            expect(body, where).toMatchObject({ error: "image_upload_disabled", hint: IMAGE_DISABLED_HINT });
          } else {
            expect(body, where).toMatchObject({
              error: "image_outside_r2_domain",
              allowedPrefix: cfg.P![0],
              allowedPrefixes: cfg.P,
              message: "画像 URL がこのサイトにアップロードした画像の URL ではありません",
              hint: "IMAGE には、このサイトにアップロードした画像の URL だけを指定できます(左メニューの「画像」からコピーできます)。サイト内の既存画像は ATTRIBUTE(src)で差し替えてください",
            });
          }
        }
      }
    }
  });

  it("loopback_http_uploader_base_same_decision_everywhere", async () => {
    const s = await editorSetup();
    const LOOP = "http://127.0.0.1:8792";
    const o: Partial<Env> = { AB_UPLOADER_PUBLIC_BASE: LOOP };
    const own = `${LOOP}/u/${s.sid}/upl_a.png`;
    const rec = recordingD1(env.DB);
    expect((await putWith(s, [img(own)], { ...o, DB: rec.DB })).status).toBe(200);
    expect(touchesAssets(rec.sqls)).toEqual([]);
    const other = await putWith(s, [img(`${LOOP}/u/other_site/upl_a.png`)], o);
    expect((await expectEnvelope(other)).error).toBe("image_outside_r2_domain");
    // 公開・開始・再開・確認の画面の取り出しが使う値(同じ関数の値)
    const base = uploaderPublicBase({ ...testEnv, ...o } as Env);
    expect(base).toBe(LOOP);
    expect(extractUploaderSiteUrls(`<img src="${own}">`, base)).toEqual([{ url: own, siteId: s.sid }]);
  });

  it("outside_http_uploader_base_disabled_everywhere", async () => {
    const s = await editorSetup();
    const o: Partial<Env> = { ASSETS: undefined, AB_UPLOADER_PUBLIC_BASE: "http://up.example" };
    const src = `http://up.example/u/${s.sid}/upl_a.png`;
    expect((await expectEnvelope(await putWith(s, [img(src)], o))).error).toBe("image_upload_disabled");
    const base = uploaderPublicBase({ ...testEnv, ...o } as Env);
    expect(base).toBeNull();
    expect(extractUploaderSiteUrls(`<img src="${src}">`, base)).toEqual([]);
  });

  it("encoded_asset_url_rejected_in_any_change_type", async () => {
    const s = await editorSetup();
    const shapes = [
      `${R2}/sites/${s.sid}/images/asset_encoded001.png`,
      `${R2}/sites/${s.sid}/experiments/e1/asset_encoded001.jpg`,
      `${R2}/sites/${s.sid}/thumbs/asset_encoded001.webp`,
    ];
    await s.put([attr("href", "/keep/")]);
    const before = await snapshot(s.sid, s.eid);
    for (const url of shapes) {
      const cases = [
        html(`<img src="${url.replaceAll("/", "&#47;")}">`, "c2"),
        html(`<img src="${url.replace("asset_", "&#97;sset_")}">`, "c2"),
        css(`.hero{background:url(${url.replaceAll("/", "\\2f ")})}`, "c2"),
        css(`.hero{background:url(${url.replace("asset_", "\\61 sset_")})}`, "c2"),
        attr("src", url.replaceAll("/sites/", "%2Fsites%2F"), "c2"),
        attr("src", url.replace("asset_", "%61sset_"), "c2"),
      ];
      for (const ch of cases) {
        const res = await s.put([attr("href", "/x/"), ch]);
        expect(res.status, JSON.stringify(ch)).toBe(422);
        expect(await expectEnvelope(res)).toMatchObject({
          error: "asset_ref_encoded",
          path: ["changes", 1],
          hint: "画像の URL は、文字参照・エスケープ・% の形にせず、そのまま書いてください",
        });
      }
    }
    expect(await snapshot(s.sid, s.eid)).toEqual(before);
  });

  it("slash_only_encoded_url_is_rejected", async () => {
    const s = await editorSetup();
    const url = await seedAssetRow(s.sid, { id: "asset_slashonly1" });
    const res = await s.put([html(`<img src="${url.replaceAll("/", "&#47;")}">`)]);
    expect(res.status).toBe(422);
    expect((await expectEnvelope(res)).error).toBe("asset_ref_encoded");
  });

  it("encoded_id_word_without_url_passes", async () => {
    const s = await editorSetup();
    const res = await s.put([
      html(`<p>&#97;sset_abc123xyz0 &amp; 100%</p>`),
      attr("class", "asset_background", "c2"),
      css(".asset_x{width:50%;content:'\\2014'}", "c3"),
    ]);
    expect(res.status).toBe(200);
  });

  it("uppercase_host_url_passes", async () => {
    const s = await editorSetup();
    const upper = `${R2.replace("localhost", "LOCALHOST")}/sites/${s.sid}/images/asset_upperhost1.png`;
    expect((await s.put([html(`<img src="${upper}"> &amp;`)])).status).toBe(200);
  });

  it("encoded_url_raw_elsewhere_passes", async () => {
    const s = await editorSetup();
    const url = `${R2}/sites/${s.sid}/images/asset_rawalso001.png`;
    expect((await s.put([html(`<img src="${url}"><img src="${url.replaceAll("/", "&#47;")}">`)])).status).toBe(200);
  });

  it("encoded_check_does_not_query_d1", async () => {
    const s = await editorSetup();
    const url = `${R2}/sites/${s.sid}/images/asset_encoded001.png`;
    const rec = recordingD1(env.DB);
    const res = await putWith(s, [html(`<img src="${url.replaceAll("/", "&#47;")}">`)], { DB: rec.DB });
    expect((await expectEnvelope(res)).error).toBe("asset_ref_encoded");
    expect(rec.sqls.filter((q) => /\b(assets|changes)\b/i.test(q))).toEqual([]);
  });

  it("encoded_check_noop_without_r2", async () => {
    const s = await editorSetup();
    const url = `${R2}/sites/${s.sid}/images/asset_encoded001.png`;
    expect((await putWith(s, [html(`<img src="${url.replaceAll("/", "&#47;")}">`)], NO_R2)).status).toBe(200);
  });

  it("image_disabled_hint_is_uploader_spec_text", async () => {
    const s = await editorSetup();
    const res = await putWith(s, [img("https://cdn.example.com/x.png")], NO_R2);
    expect(await expectEnvelope(res)).toMatchObject({
      error: "image_upload_disabled",
      hint: "画像の差し替えは ATTRIBUTE の src で行えます。有効にするには R2 バケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定するか、画像のアップローダーの公開ベース URL(AB_UPLOADER_PUBLIC_BASE)を設定して再デプロイします",
    });
  });

  it("save_referencing_purge_marked_asset_in_html_passes", async () => {
    const s = await editorSetup();
    const url = await seedAssetRow(s.sid, { id: "asset_purging001", deletedAt: 5, purgeMarkedAt: 6 });
    const res = await s.put([html(`<img src="${url}">`), attr("src", url, "c2"), css(`.hero{background:url(${url})}`, "c3")]);
    expect(res.status).toBe(200);
  });

  it("save_referencing_pending_but_unmarked_asset_passes", async () => {
    const s = await editorSetup();
    const url = await seedAssetRow(s.sid, { id: "asset_pending001", deletedAt: 5 });
    expect((await s.put([html(`<img src="${url}">`)])).status).toBe(200);
  });
});
