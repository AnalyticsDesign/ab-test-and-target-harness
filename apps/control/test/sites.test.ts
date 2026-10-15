import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys, parseSiteSettings } from "@wtt/core";
import { call, json, setupOwner, inviteAndJoin, createSite, failingKv, failingD1Insert, siteRow, expectEnvelope } from "./helpers";

async function kvSettings(siteId: string) {
  const raw = await env.CONFIG_KV.get(kvKeys.settings(siteId));
  return raw === null ? null : parseSiteSettings(JSON.parse(raw));
}

describe("sites", () => {
  it("creates a site with defaults, writes the settings record and returns no salt", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { id: "site_one" });
    expect(id).toBe("site_one");
    const site = await json(await call("GET", "/sites/site_one", { token }));
    expect(site).toMatchObject({ id: "site_one", mode: "A", idSource: "ab", consentMode: "implicit", visitorCookieName: "_ab_vid", uuidCookieEnabled: false, allowedOrigins: ["https://www.example.com"], hosts: [], analytics: { extraKey: "ab_extra" } });
    expect(site.siteSalt).toBeUndefined();
    // 時刻の単位: createdAt / updatedAt / contentUpdatedAt は epoch ミリ秒(epoch 秒なのは previousCookieNames.until だけ)
    const now = Date.now();
    for (const t of [site.createdAt, site.updatedAt, site.contentUpdatedAt]) {
      expect(t).toBeLessThanOrEqual(now);
      expect(t).toBeGreaterThan(now - 60_000);
    }
    const s = await kvSettings("site_one");
    expect(s?.allowedOrigins).toEqual(["https://www.example.com"]);
    expect(s?.settingsVersion).toBe(1);
    expect(await env.CONFIG_KV.get(kvKeys.active("site_one"))).toBeNull(); // config はまだ無い(settings が先、config は Publish)
  });
  it("tenant_isolation_cross_workspace_404", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const outsider = await inviteAndJoin(owner.token, second.id, "admin"); // 別 Workspace の ADMIN
    expect((await call("GET", `/sites/${id}`, { token: outsider.token })).status).toBe(404);
    expect((await call("PATCH", `/sites/${id}`, { token: outsider.token, body: { name: "x" } })).status).toBe(404);
    expect((await call("GET", `/workspaces/${owner.workspaceId}/sites`, { token: outsider.token })).status).toBe(404);
    expect((await call("GET", `/sites/${id}/experiments`, { token: outsider.token })).status).toBe(404);
    expect((await call("POST", `/sites/${id}/publish`, { token: outsider.token })).status).toBe(404);
    expect((await call("GET", "/sites/site_missing", { token: owner.token })).status).toBe(404);
  });
  it("site settings are admin-only and editor gets 403", async () => {
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("GET", `/sites/${id}`, { token: ed.token })).status).toBe(200);
    expect((await call("PATCH", `/sites/${id}`, { token: ed.token, body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: ed.token, body: { name: "S", domain: "a.example" } })).status).toBe(403);
  });
  it("renaming the canonical cookie keeps the old name in previousCookieNames and rejects reuse while alive", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { retentionDays: 30 });
    expect((await call("PATCH", `/sites/${id}`, { token, body: { visitorCookieName: "_wtt_vid" } })).status).toBe(200);
    const s = await kvSettings(id);
    expect(s?.visitorCookieName).toBe("_wtt_vid");
    expect(s?.previousCookieNames.map((p) => p.name)).toEqual(["_ab_vid"]);
    expect(s!.previousCookieNames[0]!.until).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
    // 決定 29: 生きている旧名への戻しは 422(正本・UUID とも)
    const back = await call("PATCH", `/sites/${id}`, { token, body: { visitorCookieName: "_ab_vid" } });
    expect(back.status).toBe(422);
    // review r2 finding 3: expectEnvelope は封筒を ErrorEnvelopeSchema(決定 34、/openapi.json の契約)で
    // パースする。path が(あれば)配列であることもここで固定される
    const backBody = (await expectEnvelope(back)) as { error: string; message: string };
    expect(backBody.error).toBe("cookie_name_in_use");
    // message は封筒の必須項目(日本語)。code をそのまま出さない(Task 11 で管理画面から実地確認して見つかった回帰)
    expect(backBody.message).not.toBe("cookie_name_in_use");
    expect(backBody.message).toBeTruthy();
    expect((await call("PATCH", `/sites/${id}`, { token, body: { uuidCookieEnabled: true, uuidCookieName: "_ab_vid" } })).status).toBe(422);
    // 失敗した PATCH は KV も D1 も変えない
    expect((await kvSettings(id))?.visitorCookieName).toBe("_wtt_vid");
  });
  it("disabling the uuid cookie records its old name for deletion", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { uuidCookieEnabled: true });
    expect((await call("PATCH", `/sites/${id}`, { token, body: { uuidCookieEnabled: false } })).status).toBe(200);
    expect((await kvSettings(id))?.previousCookieNames.map((p) => p.name)).toEqual(["_ab_uuid"]);
  });
  it("byoid conflicts and mode B with byoid are 422 with machine readable codes", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId);
    let res = await call("PATCH", `/sites/${id}`, { token, body: { idSource: "cookie:_ab_vid" } });
    expect(res.status).toBe(422);
    const byoidBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(byoidBody.error).toBe("byoid_cookie_name_conflict");
    expect(byoidBody.message).not.toBe("byoid_cookie_name_conflict");
    res = await call("PATCH", `/sites/${id}`, { token, body: { mode: "B", hosts: ["www.example.com"], idSource: "cookie:sid" } });
    expect(res.status).toBe(422);
    const modeBBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(modeBBody.error).toBe("mode_b_requires_id_source_ab");
    expect(modeBBody.message).not.toBe("mode_b_requires_id_source_ab");
    res = await call("PATCH", `/sites/${id}`, { token, body: { allowedOrigins: ["https://a.example/"] } });
    expect(res.status).toBe(422);
    // invalid_settings は review r2 finding 2 の対象そのもの: applySitePatch() が validationFailed() を
    // 経由しない独自 ApiError で path を文字列にしていたため、ErrorEnvelopeSchema(path は配列)への
    // parse がここで落ちる形で発見された
    const settingsBody = (await expectEnvelope(res)) as { error: string; message: string; path?: unknown };
    expect(settingsBody.error).toBe("invalid_settings");
    expect(settingsBody.message).not.toBe("invalid_settings");
    expect(Array.isArray(settingsBody.path)).toBe(true);
  });
  it("mode B writes host keys and removes stale ones", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { mode: "B", domain: "www.example.com" });
    expect(await env.CONFIG_KV.get(kvKeys.host("www.example.com"))).toBe(id); // 作成時 hosts = [domain]
    expect((await call("PATCH", `/sites/${id}`, { token, body: { hosts: ["blog.example.com"] } })).status).toBe(200);
    expect(await env.CONFIG_KV.get(kvKeys.host("www.example.com"))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.host("blog.example.com"))).toBe(id);
  });
  it("site level analytics names are validated and stored", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId);
    const bad = await call("PATCH", `/sites/${id}`, { token, body: { analytics: { exposure: { event: "page_view" } } } });
    expect(bad.status).toBe(422);
    // invalid_analytics も review r2 finding 2 の対象(invalid_settings と同じ理由)
    const badBody = (await expectEnvelope(bad)) as { error: string; message: string; hint?: string; path?: unknown; issues?: unknown[] };
    expect(badBody.error).toBe("invalid_analytics");
    // message は日本語の既定文(core の zod issue は英語で書かれているため、それは hint に落とす。Task 11 で発見)
    expect(badBody.message).not.toBe("invalid_analytics");
    expect(badBody.hint).toBeTruthy();
    expect(Array.isArray(badBody.path)).toBe(true);
    expect(badBody.issues?.length).toBeGreaterThan(0);
    expect((await call("PATCH", `/sites/${id}`, { token, body: { analytics: { extraKey: "wtt_extra", exposure: { event: "wtt_exposure" } } } })).status).toBe(200);
    const s = await kvSettings(id);
    expect(s?.analytics.extraKey).toBe("wtt_extra");
    expect(s?.analytics.exposure.event).toBe("wtt_exposure");
    expect(s?.analytics.conversion.event).toBe("ab_conversion"); // 未指定は既定
  });
  it("delete removes the site and every KV record", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { mode: "B" });
    expect((await call("DELETE", `/sites/${id}`, { token })).status).toBe(204);
    expect(await env.CONFIG_KV.get(kvKeys.settings(id))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.host("www.example.com"))).toBeNull();
    expect((await call("GET", `/sites/${id}`, { token })).status).toBe(404);
  });
  it("host claim rejects cross-workspace duplicates and deletes only own mapping", async () => {
    const a = await setupOwner();
    const wsB = await json<{ id: string }>(await call("POST", "/workspaces", { token: a.token, body: { name: "B" } })); // 別 Workspace(同じ OWNER で可。所有権は Site 単位)
    await createSite(a.token, a.workspaceId, { id: "s1", mode: "B", domain: "shop.example.com" }); // mode B は hosts = [domain]
    await createSite(a.token, wsB.id, { id: "s2", domain: "x.example.com" });
    const dup = await call("PATCH", `/sites/s2`, { token: a.token, body: { hosts: ["SHOP.example.com."] } }); // 正規化後に s1 と衝突
    expect(dup.status).toBe(409);
    const dupBody = (await expectEnvelope(dup)) as { error: string; message: string };
    expect(dupBody.error).toBe("host_in_use");
    expect(dupBody.message).not.toBe("host_in_use");
    expect(await env.CONFIG_KV.get(kvKeys.host("shop.example.com"))).toBe("s1");
    // s2 が自分の host を付けて外しても s1 の mapping は消えない
    expect((await call("PATCH", `/sites/s2`, { token: a.token, body: { hosts: ["two.example.com"] } })).status).toBe(200);
    expect((await call("PATCH", `/sites/s2`, { token: a.token, body: { hosts: [] } })).status).toBe(200);
    expect(await env.CONFIG_KV.get(kvKeys.host("two.example.com"))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.host("shop.example.com"))).toBe("s1");
  });
  it("settings kv failure leaves d1 unchanged", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { id: "site_kvfail" });
    const res = await call("PATCH", `/sites/${id}`, { token, body: { name: "新しい名前" }, envOverride: { CONFIG_KV: failingKv(/:settings$/) } });
    expect(res.status).toBe(503);
    // review 最終回 finding 1: この封筒はかつて message に生の例外(String(e))を流していた。
    // describeError が message をそのまま画面に出すので、日本語文言であることまで固定する
    const kvBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(kvBody.error).toBe("settings_write_failed");
    expect(kvBody.message).toBe("設定の保存に失敗しました");
    expect((await json(await call("GET", `/sites/${id}`, { token }))).name).toBe("Site");
  });
  it("mode b site creation claims its domain as a host", async () => {
    const { token, workspaceId } = await setupOwner();
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domain: "b.example.com", mode: "B" } });
    expect(res.status).toBe(201);
    expect(await env.CONFIG_KV.get(kvKeys.host("b.example.com"))).toBe("site_b");
    expect((await env.DB.prepare("select site_id from site_hosts where host = ?").bind("b.example.com").first<{ site_id: string }>())?.site_id).toBe("site_b");
  });
  it("host batch failure on patch removes the kv host keys it wrote", async () => {
    // failingD1Insert(Task 1 の helpers)は site_hosts への insert を含む batch 全体を失敗させる
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { id: "site_hb" });
    const res = await call("PATCH", `/sites/${id}`, { token, body: { hosts: ["hb.example.com"], visitorCookieName: "_wtt_vid" }, envOverride: { DB: failingD1Insert(env.DB, "site_hosts") } });
    expect(res.status).toBe(409);
    // review r2 finding 4: この catch はかつて生の例外(String(e))を message に流していた。
    // ErrorEnvelopeSchema には string 型としか宣言していないので通ってしまう ── ここで日本語文字を含む
    // ことまで確かめて、内部例外の文字列がそのまま出ていないことを固定する
    const hostBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(hostBody.error).toBe("host_in_use");
    expect(hostBody.message).toBe("ホスト名の登録が競合しました");
    expect(await env.CONFIG_KV.get(kvKeys.host("hb.example.com"))).toBeNull();
    const site = await json(await call("GET", `/sites/${id}`, { token }));
    expect(site.hosts).toEqual([]);
    // 失敗した PATCH の後、KV の settings record は D1 と一致していること。
    // KV だけが先に進んだまま残ると、次の PATCH が旧行から再導出して配信中の Cookie 名を
    // previousCookieNames にも載せずに捨ててしまう(= 全訪問者の再バケット)
    const s = await kvSettings(id);
    expect(s?.visitorCookieName).toBe("_ab_vid");
    expect(s?.visitorCookieName).toBe(site.visitorCookieName);
    expect(s?.previousCookieNames).toEqual([]);
    expect(s?.hosts).toEqual([]);
  });
  it("a host key failure on patch rolls the settings record back to match d1", async () => {
    // settings の put は通り、host の put で落ちる経路(failingKv(/:settings$/) では踏めない)
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { id: "site_hostfail" });
    const res = await call("PATCH", `/sites/${id}`, {
      token,
      body: { hosts: ["hf.example.com"], visitorCookieName: "_wtt_vid" },
      envOverride: { CONFIG_KV: failingKv(/^host:/) },
    });
    expect(res.status).toBe(503);
    const hostKvBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(hostKvBody.error).toBe("settings_write_failed");
    expect(hostKvBody.message).toBe("設定の保存に失敗しました");
    const site = await json(await call("GET", `/sites/${id}`, { token }));
    expect(site.visitorCookieName).toBe("_ab_vid"); // D1 は旧値のまま
    const s = await kvSettings(id);
    expect(s?.visitorCookieName).toBe("_ab_vid"); // KV も旧値に戻っている
    expect(s?.previousCookieNames).toEqual([]);
    expect(s?.hosts).toEqual([]);
    expect(await env.CONFIG_KV.get(kvKeys.host("hf.example.com"))).toBeNull();
  });
  it("a host key failure on create leaves no orphan settings record in kv", async () => {
    const { token, workspaceId } = await setupOwner();
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, {
      token,
      body: { id: "site_orphan", name: "B", domain: "orphan.example.com", mode: "B" },
      envOverride: { CONFIG_KV: failingKv(/^host:/) },
    });
    expect(res.status).toBe(503);
    // D1 を巻き戻したなら KV も巻き戻す(settings record だけが残らない)
    expect(await env.CONFIG_KV.get(kvKeys.settings("site_orphan"))).toBeNull();
    expect((await call("GET", "/sites/site_orphan", { token })).status).toBe(404);
    expect((await env.DB.prepare("select count(*) as n from sites where id = ?").bind("site_orphan").first<{ n: number }>())?.n).toBe(0);
  });
  it("a patch overlapping a publish does not clobber the publish bookkeeping columns", async () => {
    // PATCH は applySitePatch が触る列だけを SET する。リクエスト開始時に読んだ行をまるごと
    // 書き戻すと、その後に走った Publish の active_version / active_kv_stale を巻き戻してしまう。
    // とくに active_kv_stale を 0 に戻すと、KV と D1 の食い違いを直す契機(Task 6 の reconcileActive)が消える。
    // loadSite と batch の間に Publish が割り込んだ状況を D1 の batch を包んで再現する
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { id: "site_book" });
    const interleaving = new Proxy(env.DB, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            await t.prepare("update sites set active_version = 3, active_kv_stale = 1, last_activated_at = 111, content_updated_at = 222 where id = ?").bind(id).run();
            return t.batch(stmts);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    expect((await call("PATCH", `/sites/${id}`, { token, body: { name: "新しい名前" }, envOverride: { DB: interleaving } })).status).toBe(200);
    // PATCH 直後、GET を挟む前に D1 を直接読む。Task 8 の GET /sites/:sid は reconcileActive を呼び、
    // このシナリオの KV は壊していないので reconcile は必ず成功して active_kv_stale を 0 に正規化してしまう —
    // GET 越しに読むと「PATCH が clobber したから 0」なのか「reconcile が直したから 0」なのか区別が付かず、
    // この assertion が本来検出すべき退行(SITE_PATCH_COLUMNS に active_kv_stale が紛れ込む)を検出できなくなる
    // (review r2 finding 3)。なので PATCH が触れたかどうかは reconcile の手前、生の D1 row で確かめる
    expect((await siteRow(id)).active_kv_stale).toBe(1); // PATCH は触っていない(=1 のまま生きている)
    const site = await json(await call("GET", `/sites/${id}`, { token }));
    expect(site.name).toBe("新しい名前"); // PATCH の変更は入っている
    expect(site.activeVersion).toBe(3); // 割り込んだ Publish の記帳は生きている(reconcile はこの列を触らない)
    expect(site.lastActivatedAt).toBe(111);
    expect(site.contentUpdatedAt).toBe(222);
  });
  it("settings_record_carries_retention_and_forget_flags", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id } = await createSite(token, workspaceId, { retentionDays: 45 });
    const s0 = await kvSettings(id);
    expect(s0?.retentionDays).toBe(45);
    expect(s0?.forgetOnRevoke).toBe(true); // 既定 on(決定 37)
    expect(await json(await call("GET", `/sites/${id}`, { token }))).toMatchObject({ retentionDays: 45, forgetOnRevoke: true });
    const res = await call("PATCH", `/sites/${id}`, { token, body: { forgetOnRevoke: false, retentionDays: 30 } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ forgetOnRevoke: false, retentionDays: 30 });
    const s1 = await kvSettings(id);
    expect(s1?.forgetOnRevoke).toBe(false);
    expect(s1?.retentionDays).toBe(30);
    // 範囲外は validation_failed(SitePatchSchema)。この codebase では zod 失敗は常に 422(errors.ts の validationFailed)
    expect((await call("PATCH", `/sites/${id}`, { token, body: { retentionDays: 3651 } })).status).toBe(422);
  });
  it("site deletion is owner-only and an admin gets 403", async () => {
    // 決定 13: Site 設定は ADMIN 以上だが、Site 削除は OWNER のみ(破壊的なので狭める)
    const owner = await setupOwner();
    const { id } = await createSite(owner.token, owner.workspaceId);
    const ad = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("PATCH", `/sites/${id}`, { token: ad.token, body: { name: "admin can edit" } })).status).toBe(200);
    const res = await call("DELETE", `/sites/${id}`, { token: ad.token });
    expect(res.status).toBe(403);
    expect((await json(res)).required).toBe("owner");
    expect((await call("GET", `/sites/${id}`, { token: owner.token })).status).toBe(200); // 消えていない
    expect((await call("DELETE", `/sites/${id}`, { token: owner.token })).status).toBe(204);
  });
});
