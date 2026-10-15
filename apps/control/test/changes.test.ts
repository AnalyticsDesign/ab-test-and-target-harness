import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment, failingD1Insert, expectEnvelope } from "./helpers";

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
