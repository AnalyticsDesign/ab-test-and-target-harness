import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  beforeD1Batch,
  beforeD1BatchMatching,
  call,
  countingD1,
  createExperiment,
  createSite,
  expectEnvelope,
  failingD1Insert,
  failingKv,
  fakeDeployer,
  json,
  publishRes,
  runDirect,
  setupOwner,
  siteRow,
  siteWithRunning,
} from "./helpers";

/**
 * B129 Task 7(spec §3.1 の区分 content のうちサイト・目標・オーディエンス・画像・公開・§3.2・§5.1・§5.2): 操作と同じ batch に記録の文を入れる
 * (1 文の execute だった所は 2 文の batch。往復は変えない)。削除・条件付きの文は記録を前に置き、操作の文と同じ条件(Review Focus 1)。
 * 戻しの batch(サイトの設定の KV の失敗・作成の取り消し)には戻しの記録を足す。CAS より前の失敗は記録しない。
 * `static.rebuild` だけは「前」(writeAuditBefore。書けなければ 500 で作り直しを始めない)
 */

type Row = {
  id: number;
  category: string;
  action: string;
  workspace_id: string | null;
  site_id: string | null;
  experiment_id: string | null;
  site_generation: string | null;
  experiment_generation: string | null;
  via: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail_json: string;
};
type Event = Row & { detail: Record<string, unknown> };
const events = async (action?: string): Promise<Event[]> =>
  (
    await (action === undefined
      ? env.DB.prepare(`select * from audit_events where category = 'content' order by id`)
      : env.DB.prepare(`select * from audit_events where action = ?1 order by id`).bind(action)
    ).all<Row>()
  ).results.map((r) => ({ ...r, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));
const siteGenerationOf = async (sid: string) => (await env.DB.prepare(`select generation from sites where id = ?1`).bind(sid).first<{ generation: string }>())?.generation;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
// B68: 画像はサイトに属する(experimentId を送ると 422)。名前は任意(無ければファイル名)
function pngForm(name = "hero.png") {
  const fd = new FormData();
  fd.set("file", new File([PNG], name, { type: "image/png" }));
  return fd;
}
const goalBody = (id = "g_buy") => ({ id, name: "購入", type: "CUSTOM", config: {} });
const audienceBody = (id = "aud_a") => ({ id, name: "常連", definition: { ctx: "device", op: "in", value: ["mobile"] } });

describe("site.create / update / delete", () => {
  it("site_create_records_domain", async () => {
    const owner = await setupOwner();
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: "site_rec", name: "本店", domains: ["shop.example.com", "www.example.com"] } });
    expect(res.status).toBe(201);
    const [e, ...rest] = await events("site.create");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      category: "content",
      workspace_id: owner.workspaceId,
      site_id: "site_rec",
      experiment_id: null,
      via: "google",
      actor_user_id: owner.userId,
      target_type: "site",
      target_id: "site_rec",
      target_label: "本店",
      detail: { domain: "shop.example.com" },
    });
    // 既にある ID(409)では記録しない
    expect((await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { id: "site_rec", name: "本店", domains: ["a.example.com"] } })).status).toBe(409);
    expect(await events("site.create")).toHaveLength(1);
  });

  it("site_create_sets_generation (Q14)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const first = await siteGenerationOf(sid);
    expect(first).toBeTruthy();
    const [created] = await events("site.create");
    expect(created!.site_generation).toBe(first);
    // サイトに関わるほかの記録にも今の世代が入る
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_g" });
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "UTC" } })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: goalBody() })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: audienceBody() })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm() })).status).toBe(201);
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    expect((await call("DELETE", `/sites/${sid}/experiments/${eid}`, { token: owner.token })).status).toBe(204);
    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token })).status).toBe(204);
    const rows = await events();
    expect(rows.map((e) => e.action)).toEqual([
      "site.create",
      "experiment.create",
      "site.update",
      "goal.create",
      "audience.create",
      "asset.upload",
      "publish.publish",
      "experiment.delete",
      "site.delete",
    ]);
    for (const e of rows) {
      expect(e.workspace_id).toBe(owner.workspaceId);
      expect(e.site_id).toBe(sid);
      expect(e.site_generation).toBe(first);
    }
    // 同じ ID で作り直すと新しい世代(削除したサイトの ID は同じワークスペースでは作り直せる)
    await createSite(owner.token, owner.workspaceId, { id: sid });
    const second = await siteGenerationOf(sid);
    expect(second).not.toBe(first);
    expect((await events("site.create")).map((e) => e.site_generation)).toEqual([first, second]);
  });

  it("site_update_records_scalar_before_after", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const res = await call("PATCH", `/sites/${sid}`, {
      token: owner.token,
      body: { retentionDays: 30, timezone: "UTC", forgetOnRevoke: false, domains: ["new.example.com"], name: "新しい名前" },
    });
    expect(res.status).toBe(200);
    const [e, ...rest] = await events("site.update");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, target_type: "site", target_id: sid, target_label: "Site" });
    // 変えた項目の名前は欄の順。短い値は前後、長い値の欄(domains)は名前だけ
    expect(e!.detail).toEqual({
      fields: ["name", "domains", "retentionDays", "forgetOnRevoke", "timezone"],
      name: { from: "Site", to: "新しい名前" },
      retentionDays: { from: 90, to: 30 },
      forgetOnRevoke: { from: true, to: false },
      timezone: { from: "Asia/Tokyo", to: "UTC" },
    });
    // 保存期間の短縮が 422 で断られたときは記録しない(期間 20 日のオーディエンスがあると 10 日にはできない)
    expect((await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: goalBody("g_lead") })).status).toBe(201);
    expect(
      (await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_h", name: "h", definition: { hist: "converted", goal: "g_lead", withinDays: 20 } } })).status,
    ).toBe(201);
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { retentionDays: 10 } })).status).toBe(422);
    // KV の書き込みが D1 より先の保存で KV が失敗した(503)ときも、D1 は変わらないので記録しない
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { name: "x" }, envOverride: { CONFIG_KV: failingKv(/:settings$/) } })).status).toBe(503);
    expect(await events("site.update")).toHaveLength(1);
  });

  /**
   * B129 final review(R64): 記録するのは値が変わった欄だけ(サイト設定の画面は全部の欄を毎回送る)。比べるのは保存する形
   * (正規化した後の列の値。外部計測は既定値の省略(null)と鍵の順をそろえ、タグを置くドメインは一覧の値の並び)
   */
  const SITE_PATCH_KEYS = [
    "name", "domains", "mode", "idSource", "retentionDays", "forgetOnRevoke", "timezone", "resultsEnabled", "resultsRetentionDays", "newProfileBudgetPerDay",
    "consentMode", "decisionTimeoutMs", "visitorCookieName", "uuidCookieEnabled", "uuidCookieName", "shareSubdomains", "analytics", "ga4PropertyId", "bigqueryDataset",
  ] as const;
  /** 画面と同じく全部の欄を送る body(今の値に over を重ねる) */
  const fullSiteBody = async (token: string, sid: string, over: Record<string, unknown> = {}) => {
    const cur = await json<Record<string, unknown> & { domains: Array<{ value: string }> }>(await call("GET", `/sites/${sid}`, { token }));
    return { ...Object.fromEntries(SITE_PATCH_KEYS.map((k) => [k, k === "domains" ? cur.domains.map((d) => d.value) : cur[k]])), ...over };
  };

  /** 記録の文の bind の数の上限(全部の欄を送るサイト設定の保存で、2026-11-04 に測った値は 66。D1 の上限は 100) */
  const BIND_BUDGET = 80;
  it("site_update_records_only_changed_fields (final review)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const save = async (over: Record<string, unknown>) =>
      expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: await fullSiteBody(owner.token, sid, over) })).status).toBe(200);
    // (1) 1 欄だけ変えて全部の欄を送る(外部計測は作成のときの null と、画面が送る既定値が同じ)
    await save({ retentionDays: 30 });
    // (2) 同じ値を送り直す(行は残す)
    await save({});
    // (3) 長い値の欄(ドメイン・外部計測・BigQuery のデータセット)の変更は名前だけ。値が null → 値の欄(GA4)は前後
    const cur = await json<{ domains: Array<{ value: string }> }>(await call("GET", `/sites/${sid}`, { token: owner.token }));
    await save({
      domains: [...cur.domains.map((d) => d.value), "shop.example.net"],
      analytics: { dataLayerName: "dl2" },
      bigqueryDataset: "my-project.analytics_1",
      ga4PropertyId: "12345",
    });
    // (4) 保存してある外部計測の JSON の鍵の順だけが違う(古い版が書いた行)。同じ値の送り直しは変わらず
    const stored = JSON.parse((await siteRow(sid)).analytics_json!) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(stored).reverse());
    await env.DB.prepare(`update sites set analytics_json = ?1 where id = ?2`).bind(JSON.stringify(reversed), sid).run();
    await save({});
    const rows = await events("site.update");
    expect(rows.map((e) => e.detail)).toEqual([
      { fields: ["retentionDays"], retentionDays: { from: 90, to: 30 } },
      { fields: [] },
      { fields: ["domains", "analytics", "ga4PropertyId", "bigqueryDataset"], ga4PropertyId: { from: null, to: "12345" } },
      { fields: [] },
    ]);
    expect(rows.map((e) => e.detail_json).join()).not.toContain("shop.example.net");
    // 全部の欄を送る保存でも、記録の文の bind は D1 の 1 文の上限(100)に届かない(欄の名前と JSON の道は文の字面に書く)
    const counting = countingD1(env.DB);
    const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: await fullSiteBody(owner.token, sid, { name: "x".repeat(100) }), envOverride: { DB: counting.db } });
    expect(res.status).toBe(200);
    const auditSql = counting.counts().batchSql.flat().find((q) => /^insert into audit_events/.test(q))!;
    expect(auditSql.split("?").length - 1).toBeLessThanOrEqual(BIND_BUDGET);
  });

  it("site_update_audit_failure_is_500_not_host_in_use (final review)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 記録の文の失敗は、ホスト名の取り合い(409 host_in_use)ではなく 500 にする。保存は D1 に残らない
    for (const body of [{ timezone: "UTC" }, { uuidCookieEnabled: true }]) {
      const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body, envOverride: { DB: failingD1Insert(env.DB, "audit_events") } });
      expect(res.status).toBe(500);
      expect((await expectEnvelope(res)).error).toBe("internal");
    }
    const row = await siteRow(sid);
    expect([row.timezone, row.uuid_cookie_enabled]).toEqual(["Asia/Tokyo", 0]);
    expect(await events("site.update")).toEqual([]);
  });

  it("site_update_revert_records_reverted", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // UUID Cookie の有効化は予約の集合を増やす保存(D1 を先に確定してから KV)。KV が失敗すると D1 を戻す
    const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { uuidCookieEnabled: true }, envOverride: { CONFIG_KV: failingKv(/:settings$/) } });
    expect(res.status).toBe(503);
    expect((await siteRow(sid)).uuid_cookie_enabled).toBe(0);
    const rows = await events("site.update");
    expect(rows.map((e) => e.detail)).toEqual([{ fields: ["uuidCookieEnabled"], uuidCookieEnabled: { from: false, to: true } }, { reason: "reverted" }]);
    expect(rows[1]).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, target_type: "site", target_id: sid, target_label: "Site" });
    expect(rows[1]!.site_generation).toBe(await siteGenerationOf(sid));
  });

  it("site_update_revert_skips_a_deleted_site (task 7 review)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 保存の batch(D1 を先に確定)の後、KV の書き込みの間にサイトが消えた(直接消す)。戻しの記録は、戻す文と同じ条件で 0 行
    const vanishing = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "put")
          return async (key: string) => {
            if (/:settings$/.test(key)) {
              await env.DB.prepare(`delete from sites where id = ?1`).bind(sid).run();
              throw new Error(`injected kv put failure for ${key}`);
            }
            throw new Error("unexpected put");
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as KVNamespace;
    const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { uuidCookieEnabled: true }, envOverride: { CONFIG_KV: vanishing } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await siteGenerationOf(sid)).toBeUndefined();
    const rows = await events("site.update");
    expect(rows.map((e) => e.detail)).toEqual([{ fields: ["uuidCookieEnabled"], uuidCookieEnabled: { from: false, to: true } }]);
    expect(rows.every((e) => e.site_generation !== null)).toBe(true);
  });

  it("site_create_failure_records_rollback", async () => {
    const owner = await setupOwner();
    // (1) ホストの所有権(claimHosts)の失敗: Mode B の 1 行目は Cloudflare 経由と判定され、site_hosts の insert で落とす
    const claim = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
      token: owner.token,
      body: { id: "site_claim", name: "B", domains: ["claim.example.com"], mode: "B" },
      envOverride: { DB: failingD1Insert(env.DB, "site_hosts") },
    });
    expect(claim.status).toBe(409);
    expect(await siteGenerationOf("site_claim")).toBeUndefined();
    // (2) KV の失敗
    const kv = await call("POST", `/workspaces/${owner.workspaceId}/sites`, {
      token: owner.token,
      body: { id: "site_kv", name: "K", domains: ["kv.example.com"] },
      envOverride: { CONFIG_KV: failingKv(/:settings$/) },
    });
    expect(kv.status).toBe(503);
    expect(await siteGenerationOf("site_kv")).toBeUndefined();
    const rows = await events();
    expect(rows.map((e) => [e.action, e.site_id, e.detail])).toEqual([
      ["site.create", "site_claim", { domain: "claim.example.com" }],
      ["site.delete", "site_claim", { reason: "create_failed" }],
      ["site.create", "site_kv", { domain: "kv.example.com" }],
      ["site.delete", "site_kv", { reason: "create_failed" }],
    ]);
    // 取り消しの行は、作成の行と同じ世代・対象の控えを持つ
    for (const [create, undo] of [
      [rows[0]!, rows[1]!],
      [rows[2]!, rows[3]!],
    ] as const) {
      expect(undo).toMatchObject({ workspace_id: owner.workspaceId, target_type: "site", target_id: create.site_id, target_label: create.target_label, site_generation: create.site_generation });
    }
  });

  it("site_delete_records_name", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId, { domain: "del.example.com" });
    const generation = await siteGenerationOf(sid);
    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token })).status).toBe(204);
    const [e, ...rest] = await events("site.delete");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, site_generation: generation, target_type: "site", target_id: sid, target_label: "Site", detail: { domain: "del.example.com" } });
    // 配信中のエクスペリエンスがある(409)では記録しない
    const { id: live } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, live, { id: "exp_live" });
    await runDirect(live, "exp_live");
    expect((await call("DELETE", `/sites/${live}`, { token: owner.token })).status).toBe(409);
    expect(await events("site.delete")).toHaveLength(1);
  });

  it("site_delete_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 2 つ目の要求の削除の batch の直前に、1 つ目の要求が削除を終える(2 つ目の印 token は消えた行と合わない)
    const racing = beforeD1BatchMatching(env.DB, /delete from "sites"/, async () => {
      expect((await call("DELETE", `/sites/${sid}`, { token: owner.token })).status).toBe(204);
    });
    const second = await call("DELETE", `/sites/${sid}`, { token: owner.token, envOverride: { DB: racing.db } });
    expect(racing.ran()).toBe(true);
    expect(second.status).toBe(409);
    expect(await events("site.delete")).toHaveLength(1);
  });
});

describe("goal / audience / asset", () => {
  it("goal_audience_crud", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const t = owner.token;
    expect((await call("POST", `/sites/${sid}/goals`, { token: t, body: goalBody() })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/goals`, { token: t, body: goalBody() })).status).toBe(409); // 同じ ID は記録しない
    expect((await call("PATCH", `/sites/${sid}/goals/g_buy`, { token: t, body: { name: "購入完了", config: {} } })).status).toBe(200);
    expect((await call("PATCH", `/sites/${sid}/goals/g_none`, { token: t, body: { name: "x" } })).status).toBe(404);
    expect((await call("POST", `/sites/${sid}/audiences`, { token: t, body: audienceBody() })).status).toBe(201);
    expect((await call("PATCH", `/sites/${sid}/audiences/aud_a`, { token: t, body: { description: "メモ" } })).status).toBe(200);
    // 参照されているオーディエンス・目標(409)の削除は記録しない
    await createExperiment(t, sid, { id: "exp_ref", targeting: { audience: "aud_a" } });
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_a`, { token: t })).status).toBe(409);
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_ref`, { token: t })).status).toBe(204);
    expect((await call("DELETE", `/sites/${sid}/audiences/aud_a`, { token: t })).status).toBe(204);
    expect((await call("DELETE", `/sites/${sid}/goals/g_buy`, { token: t })).status).toBe(204);
    expect((await call("DELETE", `/sites/${sid}/goals/g_buy`, { token: t })).status).toBe(404);
    const rows = (await events()).filter((e) => e.action.startsWith("goal.") || e.action.startsWith("audience."));
    expect(rows.map((e) => [e.action, e.target_type, e.target_id, e.target_label, e.detail])).toEqual([
      ["goal.create", "goal", "g_buy", "購入", {}],
      // config は作成のときと同じ値なので変わらず(値が変わった欄だけ。final review)
      ["goal.update", "goal", "g_buy", "購入", { fields: ["name"] }],
      ["audience.create", "audience", "aud_a", "常連", {}],
      ["audience.update", "audience", "aud_a", "常連", { fields: ["description"] }],
      ["audience.delete", "audience", "aud_a", "常連", {}],
      ["goal.delete", "goal", "g_buy", "購入完了", {}],
    ]);
    for (const e of rows) expect(e).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, experiment_id: null, site_generation: await siteGenerationOf(sid) });
  });

  it("goal_audience_update_records_only_changed_fields (final review)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const t = owner.token;
    expect((await call("POST", `/sites/${sid}/goals`, { token: t, body: { ...goalBody(), analytics: { overrides: { goalName: "buy" } } } })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/audiences`, { token: t, body: { ...audienceBody(), description: "メモ" } })).status).toBe(201);
    // 画面と同じく全部の欄を送る
    const goal = { name: "購入", config: {}, analytics: { overrides: { goalName: "buy" } } };
    const audience = { name: "常連", description: "メモ", definition: { ctx: "device", op: "in", value: ["mobile"] } };
    const patch = async (path: string, body: unknown) => expect((await call("PATCH", `/sites/${sid}/${path}`, { token: t, body })).status).toBe(200);
    await patch("goals/g_buy", { ...goal, name: "購入完了" });
    await patch("goals/g_buy", { ...goal, name: "購入完了" });
    await patch("goals/g_buy", { ...goal, name: "購入完了", analytics: { overrides: { goalName: "purchase" } } });
    await patch("audiences/aud_a", { ...audience, description: "新しいメモ" });
    await patch("audiences/aud_a", { ...audience, description: "新しいメモ" });
    await patch("audiences/aud_a", { ...audience, description: "新しいメモ", definition: { ctx: "device", op: "in", value: ["desktop"] } });
    expect((await events("goal.update")).map((e) => e.detail)).toEqual([{ fields: ["name"] }, { fields: [] }, { fields: ["analytics"] }]);
    expect((await events("audience.update")).map((e) => e.detail)).toEqual([{ fields: ["description"] }, { fields: [] }, { fields: ["definition"] }]);
  });

  it("goal_audience_delete_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const t = owner.token;
    expect((await call("POST", `/sites/${sid}/goals`, { token: t, body: goalBody() })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/audiences`, { token: t, body: audienceBody() })).status).toBe(201);
    for (const path of [`/sites/${sid}/goals/g_buy`, `/sites/${sid}/audiences/aud_a`]) {
      const racing = beforeD1Batch(env.DB, async () => {
        expect((await call("DELETE", path, { token: t })).status).toBe(204);
      });
      expect((await call("DELETE", path, { token: t, envOverride: { DB: racing } })).status).toBe(204);
    }
    expect(await events("goal.delete")).toHaveLength(1);
    expect(await events("audience.delete")).toHaveLength(1);
  });

  it("asset_upload", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm() });
    expect(res.status).toBe(201);
    const a = await json<{ id: string }>(res);
    const [e, ...rest] = await events("asset.upload");
    expect(rest).toEqual([]);
    // 画像はエクスペリエンスの変更履歴には出さない(experiment_id を持たない)。B68 で画像はサイトに属するので、detail にエクスペリエンスを持たない
    expect(e).toMatchObject({
      workspace_id: owner.workspaceId,
      site_id: sid,
      experiment_id: null,
      target_type: "asset",
      target_id: a.id,
      target_label: "hero.png",
      detail: { bytes: PNG.byteLength, type: "image/png" },
    });
    expect(e!.detail).not.toHaveProperty("experiment");
    // 同じ名前は番号付きの名前で入る(記録の名前も番号付き)
    expect((await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm() })).status).toBe(201);
    expect((await events("asset.upload")).map((x) => x.target_label)).toEqual(["hero.png", "hero (2).png"]);
    // 記録が書けなければ画像の行も残らない(R2 の孤児は消す)
    const failed = await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm(), envOverride: { DB: failingD1Insert(env.DB, "audit_events") } });
    expect(failed.status).toBe(500);
    expect((await env.DB.prepare(`select count(*) as n from assets where site_id = ?1`).bind(sid).first<{ n: number }>())!.n).toBe(2);
    expect(await events("asset.upload")).toHaveLength(2);
  });

  it("asset_upload_over_quota_writes_no_record (B68: サイトの上限の 409 では書かない)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const one = { AB_ASSET_SITE_MAX_COUNT: "1" };
    expect((await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm(), envOverride: one })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm(), envOverride: one })).status).toBe(409);
    expect(await events("asset.upload")).toHaveLength(1);
  });

  it("asset_rename", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await json<{ id: string }>(await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm() }));
    const rename = (aid: string, name: string, envOverride?: Partial<typeof env>) => call("PATCH", `/sites/${sid}/assets/${aid}`, { token: owner.token, body: { name }, envOverride });
    expect((await rename(a.id, "トップの画像.png")).status).toBe(200);
    const [e, ...rest] = await events("asset.rename");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      workspace_id: owner.workspaceId,
      site_id: sid,
      experiment_id: null,
      target_type: "asset",
      target_id: a.id,
      target_label: "トップの画像.png",
      detail: { from: "hero.png", to: "トップの画像.png" },
    });
    // 無い画像(404)・同じ名前の画像がある(409)では書かない
    expect((await rename("asset_nope", "x.png")).status).toBe(404);
    await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm("other.png") });
    expect((await rename(a.id, "other.png")).status).toBe(409);
    expect(await events("asset.rename")).toHaveLength(1);
    // 記録が書けなければ名前も変わらない
    expect((await rename(a.id, "y.png", { DB: failingD1Insert(env.DB, "audit_events") })).status).toBe(500);
    expect((await env.DB.prepare(`select name from assets where id = ?1`).bind(a.id).first<{ name: string }>())!.name).toBe("トップの画像.png");
    expect(await events("asset.rename")).toHaveLength(1);
  });

  it("asset_delete", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await json<{ id: string }>(await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm() }));
    const del = (aid: string, envOverride?: Partial<typeof env>) => call("DELETE", `/sites/${sid}/assets/${aid}`, { token: owner.token, envOverride });
    // 記録が書けなければ削除待ちの印も付かない
    expect((await del(a.id, { DB: failingD1Insert(env.DB, "audit_events") })).status).toBe(500);
    expect((await env.DB.prepare(`select deleted_at from assets where id = ?1`).bind(a.id).first<{ deleted_at: number | null }>())!.deleted_at).toBeNull();
    expect(await events("asset.delete")).toEqual([]);
    expect((await del(a.id)).status).toBe(200);
    const [e, ...rest] = await events("asset.delete");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      workspace_id: owner.workspaceId,
      site_id: sid,
      experiment_id: null,
      target_type: "asset",
      target_id: a.id,
      target_label: "hero.png",
      detail: {},
    });
    // もう削除待ち(404)・使われている(409)では書かない
    expect((await del(a.id)).status).toBe(404);
    const { id: eid } = await createExperiment(owner.token, sid);
    const used = await json<{ id: string; publicUrl: string }>(await call("POST", `/sites/${sid}/assets`, { token: owner.token, raw: pngForm("used.png") }));
    const put = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, {
      token: owner.token,
      body: [{ id: "c_img", type: "IMAGE", selector: "img.hero", payload: { src: used.publicUrl } }],
    });
    expect(put.status).toBe(200);
    expect((await del(used.id)).status).toBe(409);
    expect(await events("asset.delete")).toHaveLength(1);
  });
});

describe("publish", () => {
  it("publish_records_version", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    // 追い越された(自分より新しい版が先に配信中になった)公開は superseded
    await env.DB.prepare(`update sites set active_version = 9 where id = ?1`).bind(sid).run();
    expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true, version: 2, superseded: true });
    const rows = await events("publish.publish");
    expect(rows.map((e) => e.detail)).toEqual([
      { version: 1, superseded: false },
      { version: 2, superseded: true },
    ]);
    for (const e of rows) {
      expect(e).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, experiment_id: null, via: "google", actor_user_id: owner.userId, target_type: "site", target_id: sid, target_label: "Site" });
      expect(e.site_generation).toBe(await siteGenerationOf(sid));
    }
  });

  it("status_auto_publish_records_publish", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_auto" });
    expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
    const rows = await events();
    expect(rows.map((e) => e.action)).toEqual(["site.create", "experiment.create", "experiment.status", "publish.publish"]);
    expect(rows[3]).toMatchObject({ experiment_id: null, actor_user_id: owner.userId, detail: { version: 1, superseded: false } });
  });

  it("publish_that_wins_after_losing_the_cas_records_once (task 7 review)", async () => {
    const { owner, sid } = await siteWithRunning();
    // 1 回目の CAS の batch の直前に active_version を動かす(読んだ prev = null と合わず負ける)。読み直した 0 は自分の版 1 より小さいので 2 回目で勝つ。
    // 1 回目の batch にも記録の文は入るが、guard(自分の版が active)で 0 行
    let casBatches = 0;
    const batchCounting = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch") return (stmts: D1PreparedStatement[]) => (casBatches++, target.batch(stmts));
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const racing = beforeD1BatchMatching(batchCounting, /^update "sites" set "active_version"/, () => env.DB.prepare(`update sites set active_version = 0 where id = ?1`).bind(sid).run());
    const before = casBatches;
    expect(await json(await publishRes(owner.token, sid, { DB: racing.db }))).toMatchObject({ ok: true, version: 1, superseded: false });
    expect(racing.ran()).toBe(true);
    expect(casBatches - before).toBeGreaterThanOrEqual(2); // CAS の batch を 2 回以上流した(負けた試み + 勝った試み)
    expect((await siteRow(sid)).active_version).toBe(1);
    expect((await events("publish.publish")).map((e) => e.detail)).toEqual([{ version: 1, superseded: false }]);
  });

  it("publish_active_put_failure_keeps_activation_record", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 2) });
    expect(await json(res)).toMatchObject({ ok: true, version: 2, warnings: expect.arrayContaining([expect.objectContaining({ path: "delivery" })]) });
    expect((await siteRow(sid)).active_version).toBe(2);
    expect((await events("publish.publish")).map((e) => e.detail)).toEqual([
      { version: 1, superseded: false },
      { version: 2, superseded: false },
    ]);
  });

  it("failure_before_cas_writes_no_event", async () => {
    const { owner, sid } = await siteWithRunning();
    // KV の put・読み戻しの失敗
    expect(await json(await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v1$/) }))).toMatchObject({ ok: false, error: "kv_put_failed" });
    expect(await json(await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v2$/, "get") }))).toMatchObject({ ok: false, error: "kv_verify_failed" });
    // compile の失敗(配信中のエクスペリエンスが参照するオーディエンスが無い)
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: audienceBody("aud_x") })).status).toBe(201);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_bad", targeting: { audience: "aud_x" } });
    await env.DB.prepare(`delete from audiences where site_id = ?1 and id = 'aud_x'`).bind(sid).run(); // API では 409 で消せないので D1 を直接
    await runDirect(sid, eid);
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(false);
    expect(await events("publish.publish")).toEqual([]);
  });
});

describe("static", () => {
  it("static_redeploy_and_rebuild", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    const fake = fakeDeployer();
    expect((await call("POST", `/sites/${sid}/static/redeploy`, { token: owner.token, envOverride: { DEPLOYER: fake } })).status).toBe(200);
    const [redeploy, ...more] = await events("publish.static_redeploy");
    expect(more).toEqual([]);
    expect(redeploy).toMatchObject({ workspace_id: owner.workspaceId, site_id: sid, target_type: "site", target_id: sid, target_label: "Site", detail: {} });
    expect(redeploy!.site_generation).toBe(await siteGenerationOf(sid));

    expect((await call("POST", "/static/rebuild", { token: owner.token, body: {}, envOverride: { DEPLOYER: fake } })).status).toBe(200);
    const [rebuild, ...rest] = await events("static.rebuild");
    expect(rest).toEqual([]);
    expect(rebuild).toMatchObject({ category: "access", workspace_id: null, site_id: null, via: "google", actor_user_id: owner.userId, target_type: "instance", detail: { after: null } });

    // 記録が書けなければ 500 で、作り直しを始めない(デプロイ専用の Worker に何も届かない)
    const untouched = fakeDeployer();
    const failed = await call("POST", "/static/rebuild", { token: owner.token, body: { after: sid }, envOverride: { DEPLOYER: untouched, DB: failingD1Insert(env.DB, "audit_events") } });
    expect(failed.status).toBe(500);
    expect(untouched.batches).toHaveLength(0);
    expect(untouched.deploys).toHaveLength(0);
    expect(await events("static.rebuild")).toHaveLength(1);
  });
});

describe("round trips", () => {
  /**
   * 往復は実装の前と同じ(Global Constraints・spec §10.1)。実装の前の値(2026-11-04、下の順の操作で測った queries / batches)は
   * 下の expect の前のコメント。1 文の execute だった所(目標・オーディエンス・画像・配信ファイルの作り直し)は 2 文の batch になり、
   * 1 文の照会が 1 つ減って batch が 1 つ増える(往復の合計は同じ)。記録の文は batch の中だけにあり、1 文の往復にならない
   */
  it("round_trips_unchanged", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_rt" });
    const counting = countingD1(env.DB);
    const req = async (method: string, path: string, opts: { body?: unknown; raw?: FormData }, status = 200) => {
      counting.reset();
      const res = await call(method, path, { token: owner.token, ...opts, envOverride: { DB: counting.db } });
      expect(res.status).toBe(status);
      const c = counting.counts();
      expect(c.sql.some((s) => /^insert into audit_events/i.test(s)), `${method} ${path}: 記録の文が 1 文の往復になっている`).toBe(false);
      expect(c.batchSql.flat().filter((s) => /^insert into audit_events/.test(s)), `${method} ${path}: 記録の文は batch に 1 つ`).toHaveLength(1);
      return { queries: c.queries, batches: c.batches };
    };
    const out = {
      goalCreate: await req("POST", `/sites/${sid}/goals`, { body: goalBody() }, 201),
      goalPatch: await req("PATCH", `/sites/${sid}/goals/g_buy`, { body: { name: "N" } }),
      goalDelete: await req("DELETE", `/sites/${sid}/goals/g_buy`, {}, 204),
      audienceCreate: await req("POST", `/sites/${sid}/audiences`, { body: audienceBody() }, 201),
      audiencePatch: await req("PATCH", `/sites/${sid}/audiences/aud_a`, { body: { name: "N" } }),
      audienceDelete: await req("DELETE", `/sites/${sid}/audiences/aud_a`, {}, 204),
      asset: await req("POST", `/sites/${sid}/assets`, { raw: pngForm() }, 201),
      siteCreate: await req("POST", `/workspaces/${owner.workspaceId}/sites`, { body: { name: "S2", domains: ["rt.example.com"] } }, 201),
      sitePatch: await req("PATCH", `/sites/${sid}`, { body: { timezone: "UTC" } }),
      publish: await req("POST", `/sites/${sid}/publish`, {}),
      redeploy: await req("POST", `/sites/${sid}/static/redeploy`, {}),
    };
    const s2 = (await env.DB.prepare(`select id from sites where name = 'S2'`).first<{ id: string }>())!.id;
    const siteDelete = await req("DELETE", `/sites/${s2}`, {}, 204);
    // B68: 画像の名前の変更・削除待ち(どちらも 1 つの batch に記録の文を足すだけ)
    const aid = (await env.DB.prepare(`select id from assets where site_id = ?1`).bind(sid).first<{ id: string }>())!.id;
    const assetRename = await req("PATCH", `/sites/${sid}/assets/${aid}`, { body: { name: "renamed.png" } });
    const assetDelete = await req("DELETE", `/sites/${sid}/assets/${aid}`, {});
    // 実装の前: goalCreate 10/0・goalPatch 10/0・goalDelete 11/0・audienceCreate 8/0・audiencePatch 9/0・audienceDelete 9/0・asset 7/0・
    // siteCreate 8/1・sitePatch 9/1・publish 24/1・redeploy 7/0・siteDelete 8/1
    // B68 の後(2026-11-06): 画像のアップロードは、使用量と名前の候補を読む batch と、足す文・使用量・記録の batch の 2 つ(照会 1 つが batch に替わり、
    // 往復の合計 7 は同じ)。公開は、画像の確かめの条件付きの設定の記録が 1 文の batch になった(照会 1 つが batch に替わり、往復の合計 25 は同じ)
    expect({ ...out, siteDelete, assetRename, assetDelete }).toEqual({
      goalCreate: { queries: 9, batches: 1 },
      goalPatch: { queries: 9, batches: 1 },
      goalDelete: { queries: 10, batches: 1 },
      audienceCreate: { queries: 7, batches: 1 },
      audiencePatch: { queries: 8, batches: 1 },
      audienceDelete: { queries: 8, batches: 1 },
      asset: { queries: 5, batches: 2 },
      siteCreate: { queries: 8, batches: 1 },
      sitePatch: { queries: 9, batches: 1 },
      // compile の 5 SELECT を 1 batch にまとめ、1 experiment 分の後処理 4 往復を activation に含める。
      // 版予約は直近の予約の失効と同じ batch。合計 17 往復を保つ。
      publish: { queries: 13, batches: 4 },
      redeploy: { queries: 6, batches: 1 },
      siteDelete: { queries: 8, batches: 1 },
      assetRename: { queries: 5, batches: 1 },
      assetDelete: { queries: 5, batches: 1 },
    });
  });
});
