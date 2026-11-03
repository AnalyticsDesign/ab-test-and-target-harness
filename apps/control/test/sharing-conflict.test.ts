import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { kvKeys, parseSiteSettings } from "@wtt/core";
import { runCron, type CronContext } from "../src/cron/runner";
import { siteSettingsRefreshJob } from "../src/cron/site-settings-refresh";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { migrateSharing, MIGRATION_PAGE } from "../src/sharing-conflict";
import { beforeD1Batch, call, cloneSites, createSite, failingKv, inviteAndJoin, json, setupOwner, siteRow, testEnv } from "./helpers";

// B139 Task 4(spec §6.4・Q23・Q28・Q29): 訪問者 ID の Cookie の共有の衝突の検査・予約の表・作成の調整・既存のサイトの共有の自動の移行

const HIDDEN = "同じ導入の別のワークスペースのサイトと、訪問者 ID の Cookie がぶつかります";
const nowSec = () => Math.floor(Date.now() / 1000);

async function kvSettings(siteId: string, kv: KVNamespace = env.CONFIG_KV) {
  const raw = await kv.get(kvKeys.settings(siteId));
  return raw === null ? null : parseSiteSettings(JSON.parse(raw));
}
const patch = (token: string, sid: string, body: Record<string, unknown>, envOverride?: Partial<Env>) => call("PATCH", `/sites/${sid}`, { token, body, envOverride });
async function claimsOf(sid: string): Promise<Array<{ domain: string; cookie_name: string; until: number | null }>> {
  return (await env.DB.prepare("select domain, cookie_name, until from sharing_claims where site_id = ? order by domain, cookie_name").bind(sid).all<{ domain: string; cookie_name: string; until: number | null }>()).results;
}
/** 時間の経過の代わりに、サイトの前の範囲・旧名と予約の期限を過去にする */
async function expire(sid: string): Promise<void> {
  const past = nowSec() - 10;
  await env.DB.prepare(
    `update sites set previous_cookie_domains_json = (select json_group_array(json_object('domain', json_extract(value, '$.domain'), 'until', ?2)) from json_each(previous_cookie_domains_json)),
       previous_cookie_names_json = (select json_group_array(json_object('name', json_extract(value, '$.name'), 'until', ?2)) from json_each(previous_cookie_names_json)) where id = ?1`,
  )
    .bind(sid, past)
    .run();
  await env.DB.prepare("update sharing_claims set until = ?2 where site_id = ?1 and until is not null").bind(sid, past).run();
}
/** 一度も共有したことのないオフのサイトにする(作成は共有オンなので、オフにした保存が残す前の範囲と予約を消す) */
async function offWithoutHistory(token: string, sid: string): Promise<void> {
  expect((await patch(token, sid, { shareSubdomains: false })).status).toBe(200);
  await env.DB.prepare("update sites set previous_cookie_domains_json = '[]' where id = ?").bind(sid).run();
  await env.DB.prepare("delete from sharing_claims where site_id = ?").bind(sid).run();
}
async function freeze(): Promise<void> {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
}
async function expectConflict(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(422);
  const body = await json<Record<string, unknown>>(res);
  expect(body).toMatchObject({ error: "sharing_conflict", path: ["shareSubdomains"] });
  expect(typeof body.message).toBe("string");
  return body;
}

describe("sharing conflicts on save (B139 Q23)", () => {
  it("conflict_when_one_side_sharing_on", async () => {
    const { token, workspaceId } = await setupOwner();
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com" });
    await offWithoutHistory(token, b.id);
    // A は B(共有オフ・同じ名前)とぶつかるので、作成ではオフで作られる。共有オンの A がある状態は D1 を直に書いて作る(移行より前の状態)
    const a = await createSite(token, workspaceId, { id: "site_a", name: "Site A", domain: "www.example.com" });
    await env.DB.prepare("update sites set share_subdomains = 1 where id = ?").bind(a.id).run();
    const body = await expectConflict(await patch(token, b.id, { name: "B2" }));
    expect(body).toMatchObject({ domain: "example.com", message: "サイト「Site A」と、訪問者 ID の Cookie がぶつかります" });
    expect(body.hint).toBe(
      "このサイトの訪問者 ID の Cookie 名を変えると解けます(共有をオフにしても、相手が共有していれば解けません)。名前を変えたサイトがその登録ドメインで共有を始められるのは、旧い名前の保持期間が過ぎてからです",
    );
    // 共有をオフにしたままでも解けない(相手が共有している)
    await expectConflict(await patch(token, b.id, { shareSubdomains: false }));
  });

  // Q32(2026-10-29 ユーザー決定): 旧名は、そのサイトが共有している登録ドメインでだけ照合する
  it("renaming_resolves_conflict_for_unshared_site", async () => {
    const { token, workspaceId } = await setupOwner();
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com" });
    await offWithoutHistory(token, b.id);
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await env.DB.prepare("update sites set share_subdomains = 1 where id = ?").bind(a.id).run(); // 共有オンの A(移行より前の状態)
    await expectConflict(await patch(token, b.id, { name: "B2" })); // 今の名前が重なる
    // オフの B が名前を変えると解ける(旧名 _wtt_vid は B が共有していない example.com では照合しない)
    expect((await patch(token, b.id, { visitorCookieName: "_b" })).status).toBe(200);
    expect((await patch(token, b.id, { name: "B3" })).status).toBe(200);
    // B が旧名の保持期間の中に共有を始めるのはぶつかる(B の旧名の後始末が Domain=example.com の _wtt_vid を消すため)
    await expectConflict(await patch(token, b.id, { shareSubdomains: true }));
    await expire(b.id);
    expect((await patch(token, b.id, { shareSubdomains: true })).status).toBe(200);
  });

  it("other_site_can_share_right_after_unshared_site_renames", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await offWithoutHistory(token, a.id);
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com" }); // A(オフ)とぶつかるのでオフで作られる
    expect((await siteRow(b.id)).share_subdomains).toBe(0);
    await expectConflict(await patch(token, a.id, { shareSubdomains: true }));
    expect((await patch(token, b.id, { visitorCookieName: "_b" })).status).toBe(200);
    // B が名前を変えた直後に、A は共有を始められる
    expect((await patch(token, a.id, { shareSubdomains: true })).status).toBe(200);
    // B が共有を始めるのは、B の旧名の保持期間の中はぶつかる
    await expectConflict(await patch(token, b.id, { shareSubdomains: true }));
  });

  it("conflict_on_uuid_or_marker_name", async () => {
    const { token, workspaceId } = await setupOwner();
    await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com", uuidCookieEnabled: true });
    // B の正本名が A の印の名前(_wtt_vid_js)と同じ
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "www.b-site.com", visitorCookieName: "_wtt_vid_js" });
    await expectConflict(await patch(token, b.id, { domains: ["https://form.example.com"] }));
    // UUID の名前が重なる
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com", visitorCookieName: "_c_vid", uuidCookieEnabled: true });
    await expectConflict(await patch(token, c.id, { domains: ["https://shop.example.com"] }));
    // UUID Cookie が無効なら UUID の名前は重ならない
    const d = await createSite(token, workspaceId, { id: "site_d", domain: "www.d-site.com", visitorCookieName: "_d_vid" });
    expect((await patch(token, d.id, { domains: ["https://shop.example.com"] })).status).toBe(200);
  });

  it("conflict_with_previous_range_within_retention", async () => {
    const { token, workspaceId } = await setupOwner();
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "www.b-site.com" });
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    // A は共有をオフにして example.com から離れる(example.com は前の範囲に残る)
    expect((await patch(token, a.id, { shareSubdomains: false, domains: ["https://www.a-site.com"] })).status).toBe(200);
    expect(JSON.parse((await siteRow(a.id)).previous_cookie_domains_json).map((p: { domain: string }) => p.domain)).toEqual(["example.com"]);
    await expectConflict(await patch(token, b.id, { domains: ["https://form.example.com"] }));
    // 期限を過ぎたら通る
    await expire(a.id);
    expect((await patch(token, b.id, { domains: ["https://form.example.com"] })).status).toBe(200);
  });

  it("removing_last_domain_keeps_previous_range_reserved", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    expect((await patch(token, a.id, { domains: ["https://www.example.com", "https://www.a-site.com"] })).status).toBe(200);
    // まとまり example.com を一覧から消す(共有はオンのまま。前の範囲に残る)
    expect((await patch(token, a.id, { domains: ["https://www.a-site.com"] })).status).toBe(200);
    expect(await claimsOf(a.id)).toContainEqual(expect.objectContaining({ domain: "example.com", cookie_name: "_wtt_vid" }));
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "www.b-site.com" });
    await expectConflict(await patch(token, b.id, { domains: ["https://form.example.com"] }));
  });

  it("conflict_message_hides_other_workspace_site", async () => {
    const owner = await setupOwner();
    await createSite(owner.token, owner.workspaceId, { id: "site_secret", name: "Secret Site", domain: "www.example.com" });
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const admin = await inviteAndJoin(owner.token, second.id, "admin"); // 1 つ目のワークスペースには入っていない
    const b = await createSite(admin.token, second.id, { id: "site_other", domain: "www.b-site.com" });
    const res = await patch(admin.token, b.id, { domains: ["https://form.example.com"] });
    const text = await res.clone().text();
    const body = await expectConflict(res);
    expect(body.message).toBe(HIDDEN);
    expect(text).not.toContain("Secret Site");
    expect(text).not.toContain("site_secret");
    // 両方のワークスペースを見られる人にはサイト名を出す
    const seen = await expectConflict(await patch(owner.token, b.id, { domains: ["https://form.example.com"] }));
    expect(seen.message).toBe("サイト「Secret Site」と、訪問者 ID の Cookie がぶつかります");
  });

  it("no_conflict_when_both_off", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await offWithoutHistory(token, a.id);
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "www.b-site.com" });
    await offWithoutHistory(token, b.id);
    expect((await patch(token, b.id, { domains: ["https://form.example.com"] })).status).toBe(200);
    // 片方が共有を始めるとぶつかる
    await expectConflict(await patch(token, b.id, { shareSubdomains: true }));
    // 共有オフで前の範囲も無いサイトは予約を持たない
    expect(await claimsOf(a.id)).toEqual([]);
  });
});

describe("sharing claims (B139 Q28)", () => {
  it("claims_follow_the_shared_range_and_cookie_names", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com", uuidCookieEnabled: true });
    expect((await claimsOf(a.id)).map((c) => [c.domain, c.cookie_name, c.until])).toEqual([
      ["example.com", "_wtt_uuid", null],
      ["example.com", "_wtt_vid", null],
      ["example.com", "_wtt_vid_js", null],
    ]);
    // 正本名を変えると旧名(と旧名の印)は期限付きで残る
    expect((await patch(token, a.id, { visitorCookieName: "_a_vid" })).status).toBe(200);
    const claims = await claimsOf(a.id);
    expect(claims.filter((c) => c.until === null).map((c) => c.cookie_name)).toEqual(["_a_vid", "_a_vid_js", "_wtt_uuid"]);
    expect(claims.filter((c) => c.until !== null).map((c) => c.cookie_name)).toEqual(["_wtt_vid", "_wtt_vid_js"]);
  });

  it("expired_claim_can_be_acquired_without_owner_patch", async () => {
    const { token, workspaceId } = await setupOwner();
    // 前の範囲
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    expect((await patch(token, a.id, { domains: ["https://www.a-site.com"] })).status).toBe(200);
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "www.b-site.com" });
    await expectConflict(await patch(token, b.id, { domains: ["https://form.example.com"] }));
    await expire(a.id); // A は保存しない
    expect((await patch(token, b.id, { domains: ["https://form.example.com"] })).status).toBe(200);
    expect((await claimsOf(b.id)).map((c) => c.domain)).toContain("example.com");
    expect((await claimsOf(a.id)).map((c) => c.domain)).not.toContain("example.com");
    // 旧 Cookie 名
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com", visitorCookieName: "_c_vid" });
    expect((await patch(token, c.id, { visitorCookieName: "_c_new" })).status).toBe(200);
    const d = await createSite(token, workspaceId, { id: "site_d", domain: "www.d-site.com", visitorCookieName: "_c_vid" });
    await expectConflict(await patch(token, d.id, { domains: ["https://form.c-site.com"] }));
    await expire(c.id);
    expect((await patch(token, d.id, { domains: ["https://form.c-site.com"] })).status).toBe(200);
    expect(await claimsOf(d.id)).toContainEqual(expect.objectContaining({ domain: "c-site.com", cookie_name: "_c_vid", until: null }));
  });

  it("concurrent_sharing_updates_allow_only_one", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", name: "Site A", domain: "www.a-site.com" });
    const b = await createSite(token, workspaceId, { id: "site_b", name: "Site B", domain: "www.b-site.com" });
    // A の保存が事前の検査を通った後(batch の直前)に、B の保存が検査から KV まで終える
    let bStatus = 0;
    const db = beforeD1Batch(env.DB, async () => {
      bStatus = (await patch(token, b.id, { domains: ["https://www.b-site.com", "https://y.example.com"] })).status;
    });
    const res = await patch(token, a.id, { domains: ["https://www.a-site.com", "https://x.example.com"] }, { DB: db });
    expect(bStatus).toBe(200);
    const body = await expectConflict(res);
    expect(body.message).toBe("サイト「Site B」と、訪問者 ID の Cookie がぶつかります");
    // KV に共有の設定(example.com)が 1 つだけ載る。A の拒んだ設定は KV に一度も載らない
    expect((await kvSettings(b.id))?.cookieDomains).toContain("example.com");
    expect((await kvSettings(a.id))?.cookieDomains).toEqual(["a-site.com"]);
    expect(JSON.parse((await siteRow(a.id)).allowed_origins_json)).toEqual(["https://www.a-site.com"]);
  });

  it("concurrent_cookie_name_changes_do_not_publish_rejected_settings", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com", visitorCookieName: "_a_vid" });
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com", visitorCookieName: "_b_vid" });
    let bStatus = 0;
    const db = beforeD1Batch(env.DB, async () => {
      bStatus = (await patch(token, b.id, { visitorCookieName: "_same_vid" })).status;
    });
    await expectConflict(await patch(token, a.id, { visitorCookieName: "_same_vid" }, { DB: db }));
    expect(bStatus).toBe(200);
    expect((await kvSettings(a.id))?.visitorCookieName).toBe("_a_vid");
    expect((await kvSettings(b.id))?.visitorCookieName).toBe("_same_vid");
    expect((await siteRow(a.id)).visitor_cookie_name).toBe("_a_vid");
  });

  it("concurrent_uuid_enablement_allows_only_one", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com", visitorCookieName: "_a_vid" });
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com", visitorCookieName: "_b_vid" });
    let bStatus = 0;
    const db = beforeD1Batch(env.DB, async () => {
      bStatus = (await patch(token, b.id, { uuidCookieEnabled: true })).status;
    });
    await expectConflict(await patch(token, a.id, { uuidCookieEnabled: true }, { DB: db }));
    expect(bStatus).toBe(200);
    expect((await kvSettings(a.id))?.uuidCookieEnabled).toBe(false);
    expect((await kvSettings(b.id))?.uuidCookieEnabled).toBe(true);
  });

  it("failed_settings_write_after_d1_restores_d1", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.a-site.com" });
    const before = await siteRow(a.id);
    const claimsBefore = await claimsOf(a.id);
    // 予約が増える保存は D1 が先。KV の書き込みが失敗したら D1 を戻す
    const res = await patch(token, a.id, { domains: ["https://www.a-site.com", "https://x.example.com"] }, { CONFIG_KV: failingKv(new RegExp(`^${kvKeys.settings(a.id)}$`)) });
    expect(res.status).toBe(503);
    const after = await siteRow(a.id);
    expect(after.allowed_origins_json).toBe(before.allowed_origins_json);
    expect(after.updated_at).toBe(before.updated_at);
    expect(await claimsOf(a.id)).toEqual(claimsBefore);
    expect((await kvSettings(a.id))?.cookieDomains).toEqual(["a-site.com"]);
  });
});

describe("undo after a failed settings write (B139)", () => {
  it("undo_batch_failure_returns_internal_error", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.a-site.com" });
    // 予約が増える保存: D1 が先に確定 → KV の書き込みが落ちる → 戻す batch も落ちる
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 2) throw new Error("injected undo failure");
            return target.batch(stmts);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const res = await patch(token, a.id, { domains: ["https://www.a-site.com", "https://x.example.com"] }, { DB: db, CONFIG_KV: failingKv(new RegExp(`^${kvKeys.settings(a.id)}$`)) });
    expect(res.status).toBe(500);
    expect(await json(res)).toMatchObject({ error: "internal" });
  });
});

describe("site creation with sharing conflicts (B139 Q29)", () => {
  it("create_site_conflict_with_unshared_site_creates_unshared", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await offWithoutHistory(token, a.id);
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domains: ["form.example.com"] } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ shareSubdomains: false, visitorCookieName: "_wtt_vid", sharingAdjusted: { reason: "conflict", shareSubdomains: false, visitorCookieName: "_wtt_vid" } });
    expect((await siteRow("site_b")).share_subdomains).toBe(0);
    expect((await kvSettings("site_b"))?.cookieDomains).toEqual([]);
  });

  it("create_site_without_conflict_has_no_adjustment", async () => {
    const { token, workspaceId } = await setupOwner();
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domains: ["www.example.com"] } });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.sharingAdjusted).toBeUndefined();
    expect(body.previousCookieNames).toEqual([]);
  });

  it("create_site_conflict_with_shared_site_renames_cookie", async () => {
    const { token, workspaceId } = await setupOwner();
    await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domains: ["form.example.com"] } });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ shareSubdomains: true, visitorCookieName: "_wtt_vid_site_b", sharingAdjusted: { reason: "conflict", shareSubdomains: true, visitorCookieName: "_wtt_vid_site_b" } });
    // 新しいサイトなので、既定の名前を旧名に残さない
    expect(body.previousCookieNames).toEqual([]);
    expect((await kvSettings("site_b"))?.cookieDomains).toEqual(["example.com"]);
    expect((await claimsOf("site_b")).map((c) => c.cookie_name)).toEqual(["_wtt_vid_site_b", "_wtt_vid_site_b_js"]);
  });

  it("create_site_conflict_renames_uuid_cookie_too", async () => {
    const { token, workspaceId } = await setupOwner();
    await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com", uuidCookieEnabled: true });
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domains: ["form.example.com"], uuidCookieEnabled: true } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ visitorCookieName: "_wtt_vid_site_b", uuidCookieName: "_wtt_uuid_site_b", uuidCookieEnabled: true, sharingAdjusted: { visitorCookieName: "_wtt_vid_site_b" } });
  });

  it("create_site_conflict_long_site_id_uses_hash", async () => {
    const { token, workspaceId } = await setupOwner();
    await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    const id = `site_${"x".repeat(55)}`; // `_wtt_vid_` + 60 字 = 68 字 > 64
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id, name: "B", domains: ["form.example.com"] } });
    expect(res.status).toBe(201);
    expect((await json(res)).visitorCookieName).toBe(`_wtt_vid_${hex}`);
  });

  it("create_site_conflict_lost_claim_race_returns_422", async () => {
    const { token, workspaceId } = await setupOwner();
    const other = await createSite(token, workspaceId, { id: "site_other", name: "Other", domain: "www.other-site.com" });
    // 事前の検査を通った後に、同時の作成が同じ組(example.com × _wtt_vid)を予約した
    const db = beforeD1Batch(env.DB, () => env.DB.prepare("insert into sharing_claims (domain, cookie_name, site_id, until) values ('example.com', '_wtt_vid', ?, null)").bind(other.id).run());
    const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { id: "site_b", name: "B", domains: ["www.example.com"] }, envOverride: { DB: db } });
    const body = await expectConflict(res);
    expect(body.hint).toBe("もう一度作ってください。続くときは、訪問者 ID の Cookie 名を指定して作ってください");
    expect(await env.DB.prepare("select id from sites where id = 'site_b'").first()).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.settings("site_b"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 共有の自動の移行

/** 移行より前の既存のサイト(共有オフ・KV もオフ・移行の対象)にする */
async function asPending(token: string, sid: string): Promise<void> {
  await offWithoutHistory(token, sid);
  await env.DB.prepare("update sites set share_migration_pending = 1 where id = ?").bind(sid).run();
}
/** n 個の移行の対象のサイト(登録ドメインはそれぞれ別)を D1 の中で写して作る。ID は site_m000〜 */
async function pendingSites(token: string, workspaceId: string, n: number): Promise<string[]> {
  const src = await createSite(token, workspaceId, { id: "site_src", domain: "www.src-site.com" });
  await asPending(token, src.id);
  const ids = await cloneSites(src.id, n, "site_m");
  await env.DB.prepare(
    // B148: タグを置くドメインは domains_json が正(3 列は一覧から導いた値にそろえる)
    `update sites set domains_json = json_array(json_object('value', 'www.' || replace(id, '_', '-') || '.com', 'verdict', 'unknown', 'checkedAt', NULL, 'triedAt', NULL)),
       domain = 'www.' || replace(id, '_', '-') || '.com', allowed_origins_json = json_array('https://www.' || replace(id, '_', '-') || '.com'),
       share_migration_pending = 1 where id like 'site_m%'`,
  ).run();
  await env.DB.prepare("update sites set share_migration_pending = 0 where id = ?").bind(src.id).run();
  return ids;
}
function recordingKv(): { kv: KVNamespace; puts: string[] } {
  const puts: string[] = [];
  const kv = new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "put") return (key: string, ...rest: unknown[]) => (puts.push(key), (v as (...a: unknown[]) => unknown).call(target, key, ...rest));
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as KVNamespace;
  return { kv, puts };
}
const migrate = (overrides: Partial<Env> = {}) => {
  const e = { ...testEnv, ...overrides };
  return migrateSharing(e, e.DB, nowSec());
};
/** site-settings-refresh のジョブを、共有の自動の移行(runCron の最初)を通さずに 1 回動かす */
async function refreshSettingsOnly(): Promise<void> {
  const ctx: CronContext = { env: testEnv, db: getDb(testEnv), now: Date.now(), assertNotFrozen: async () => {}, queries: { left: () => 1000, use: () => true } };
  await siteSettingsRefreshJob.run(ctx);
}

describe("sharing migration (B139)", () => {
  it("migration_turns_sharing_on_except_conflicts", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await asPending(token, a.id);
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com" }); // A(オフ)とぶつかるのでオフで作られる
    expect((await siteRow(b.id)).visitor_cookie_name).toBe("_wtt_vid");
    await asPending(token, b.id);
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    const { kv, puts } = recordingKv();
    expect(await migrate({ CONFIG_KV: kv })).toEqual({ done: true, turnedOn: [c.id] });
    for (const sid of [a.id, b.id]) expect(await siteRow(sid)).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    expect(await siteRow(c.id)).toMatchObject({ share_subdomains: 1, share_migration_pending: 0 });
    expect(puts).toEqual([kvKeys.settings(c.id), kvKeys.installMarker]); // KV の設定は違うサイト(C)だけを書き直す
    expect((await kvSettings(c.id))?.cookieDomains).toEqual(["c-site.com"]);
    expect((await kvSettings(a.id))?.cookieDomains).toEqual([]);
    expect((await claimsOf(c.id)).map((x) => x.domain)).toEqual(["c-site.com", "c-site.com"]);
    // 2 回目も同じ(何も書かない)
    const again = recordingKv();
    expect(await migrate({ CONFIG_KV: again.kv })).toEqual({ done: true, turnedOn: [] });
    expect(again.puts).toEqual([]);
    expect((await siteRow(a.id)).share_subdomains).toBe(0);
  });

  it("settings_record_stays_unshared_before_migration", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await asPending(token, a.id);
    await env.CONFIG_KV.put(kvKeys.settings(a.id), "{}"); // 書き直しの対象にする
    await refreshSettingsOnly();
    expect((await kvSettings(a.id))?.cookieDomains).toEqual([]);
    expect((await siteRow(a.id)).share_subdomains).toBe(0);
  });

  it("settings_refresh_before_migration_does_not_enable_conflicting_sites", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.example.com" });
    await asPending(token, a.id);
    const b = await createSite(token, workspaceId, { id: "site_b", domain: "form.example.com" });
    await asPending(token, b.id);
    for (const sid of [a.id, b.id]) await env.CONFIG_KV.put(kvKeys.settings(sid), "{}");
    await refreshSettingsOnly();
    for (const sid of [a.id, b.id]) expect((await kvSettings(sid))?.cookieDomains).toEqual([]);
    await migrate();
    for (const sid of [a.id, b.id]) {
      expect((await kvSettings(sid))?.cookieDomains).toEqual([]);
      expect((await siteRow(sid)).share_subdomains).toBe(0);
    }
  });

  // B148(P11): 完了の印があっても、印 1 のサイト(B148 のマイグレーションが渡したもの)は処理する。利用者がオフにした印 0 のサイトはそのまま
  it("migration_processes_pending_sites_even_after_install_marker", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    expect((await migrate()).turnedOn).toEqual([c.id]);
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).not.toBeNull();
    // 印のある導入で、別のサイトが移行待ちになった
    const d = await createSite(token, workspaceId, { id: "site_d", domain: "www.d-site.com" });
    await asPending(token, d.id);
    expect(await migrate()).toEqual({ done: true, turnedOn: [d.id] });
    expect((await siteRow(d.id)).share_subdomains).toBe(1);
  });

  it("migration_keeps_user_choice_after_completion", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    expect((await migrate()).turnedOn).toEqual([c.id]);
    // 完了の後に利用者が C をオフにした(印 0)。次の移行は触らない
    expect((await patch(token, c.id, { shareSubdomains: false })).status).toBe(200);
    expect((await siteRow(c.id)).share_migration_pending).toBe(0);
    expect(await migrate()).toEqual({ done: true, turnedOn: [] });
    expect((await siteRow(c.id)).share_subdomains).toBe(0);
  });

  it("install_marker_created_without_static_rebuild", async () => {
    await setupOwner();
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBeNull();
    await runCron(testEnv, Date.now(), []); // Cron だけ(/static/rebuild は呼ばない)
    const marker = await env.CONFIG_KV.get(kvKeys.installMarker);
    expect(marker).toMatch(/^[0-9a-f-]{36}$/);
    await runCron(testEnv, Date.now(), []);
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBe(marker); // 一度きり(書き換えない)
  });

  it("sharing_migration_resumes_within_request_budget", async () => {
    const { token, workspaceId } = await setupOwner();
    const ids = await pendingSites(token, workspaceId, MIGRATION_PAGE + 1);
    const first = await migrate();
    expect(first).toEqual({ done: false, turnedOn: ids.slice(0, MIGRATION_PAGE) });
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBeNull();
    expect((await siteRow(ids.at(-1)!)).share_migration_pending).toBe(1);
    expect(await migrate()).toEqual({ done: true, turnedOn: ids.slice(MIGRATION_PAGE) });
    for (const sid of ids) {
      expect(await siteRow(sid)).toMatchObject({ share_subdomains: 1, share_migration_pending: 0 });
      expect((await kvSettings(sid))?.cookieDomains).toEqual([`${sid.replace("_", "-")}.com`]);
    }
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).not.toBeNull();
  });

  it("migration_preserves_user_choice_before_site_is_processed", async () => {
    const { token, workspaceId } = await setupOwner();
    const ids = await pendingSites(token, workspaceId, MIGRATION_PAGE + 1);
    await migrate(); // 先頭の 25 サイトだけ
    const last = ids.at(-1)!;
    // 移行の途中に、まだ処理していないサイトを共有オフで保存(利用者の選んだ値)
    expect((await patch(token, last, { shareSubdomains: false })).status).toBe(200);
    expect((await siteRow(last)).share_migration_pending).toBe(0);
    expect(await migrate()).toEqual({ done: true, turnedOn: [] });
    expect((await siteRow(last)).share_subdomains).toBe(0);
  });

  it("migration_resume_keeps_user_choice", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    const d = await createSite(token, workspaceId, { id: "site_d", domain: "www.d-site.com" });
    await asPending(token, d.id);
    // 中断: C の batch の後に凍結が入る(D は印が 1 のまま。凍結を解いた後の呼び出しで続ける)
    let calls = 0;
    const interrupting = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            const r = await target.batch(stmts);
            if (++calls === 1) await freeze();
            return r;
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    expect(await migrate({ DB: interrupting })).toEqual({ done: false, turnedOn: [c.id] });
    expect((await siteRow(d.id)).share_migration_pending).toBe(1);
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    // 再開の前に、利用者が D の共有をオフに選んだ
    expect((await patch(token, d.id, { shareSubdomains: false })).status).toBe(200);
    expect(await migrate()).toEqual({ done: true, turnedOn: [] });
    expect((await siteRow(d.id)).share_subdomains).toBe(0);
    expect((await siteRow(c.id)).share_subdomains).toBe(1);
  });

  it("migration_leaves_sites_with_unreadable_settings_unshared", async () => {
    const { token, workspaceId } = await setupOwner();
    const a = await createSite(token, workspaceId, { id: "site_a", domain: "www.a-site.com" });
    await asPending(token, a.id);
    // 今の規則に反する名前(UUID の名前が正本の印と同じ)の古い行
    await env.DB.prepare("update sites set uuid_cookie_enabled = 1, uuid_cookie_name = '_wtt_vid_js' where id = ?").bind(a.id).run();
    expect(await migrate()).toEqual({ done: true, turnedOn: [] });
    expect(await siteRow(a.id)).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
  });

  it("migration_does_nothing_while_frozen", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"更新\"}', 1, null)").run();
    expect(await migrate()).toEqual({ done: false, turnedOn: [] });
    expect((await siteRow(c.id)).share_migration_pending).toBe(1);
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBeNull();
  });
  it("migration_clears_a_persistently_failing_site", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    const d = await createSite(token, workspaceId, { id: "site_d", domain: "www.d-site.com" });
    await asPending(token, d.id);
    // D をオンにする batch が毎回落ちる(予約の違反ではない失敗)。C は先に処理される(ID の順)
    let calls = 0;
    const failing = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (++calls >= 2) throw new Error("injected failure");
            return target.batch(stmts);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    // 1 回の呼び出しで終わる(D はオフのまま印を 0 にする)
    expect(await migrate({ DB: failing })).toEqual({ done: true, turnedOn: [c.id] });
    expect(await siteRow(d.id)).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).not.toBeNull();
  });

  it("migration_does_not_overwrite_install_marker", async () => {
    const { token, workspaceId } = await setupOwner();
    const c = await createSite(token, workspaceId, { id: "site_c", domain: "www.c-site.com" });
    await asPending(token, c.id);
    // 移行の途中(C の設定の記録を書いたとき)で別の実行が印を書いた。B148: 移行は先頭で印を読まなくなったので、途中の書き込みで再現する
    let wrote = false;
    const kv = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "put")
          return async (key: string, ...rest: unknown[]) => {
            const r = await (v as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
            if (key === kvKeys.settings(c.id) && !wrote) {
              wrote = true;
              await target.put(kvKeys.installMarker, "existing-marker");
            }
            return r;
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as KVNamespace;
    expect(await migrate({ CONFIG_KV: kv })).toEqual({ done: true, turnedOn: [c.id] });
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBe("existing-marker");
  });
});
