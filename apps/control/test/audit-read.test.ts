import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditHistoryQuery,
  auditListIndex,
  auditListQuery,
  decodeAuditCursor,
  encodeAuditCursor,
  toAuditEventJson,
  type AuditListFilter,
  type AuditListScope,
  type AuditReadRow,
} from "../src/audit-read";
import { sqlCompiler } from "../src/db";
import { call, countingD1, createExperiment, createSite, experimentRow, expectEnvelope, inviteAndJoin, json, setupOwner, siteRow } from "./helpers";

/**
 * B129 Task 8(spec §6・§4.1・§10.2・§10.5): 読む API 3 本。変更履歴(閲覧者以上)・ワークスペースの記録(管理者以上)・導入全体の記録(システム管理者)。
 * 新しい順(at desc, id desc)・100 件ずつ・カーソル。メールアドレスは実効ロール(鍵の上限を当てた後)が管理者以上のときだけ(Review Focus 2)。
 * 変更履歴は今の世代の一致で引く(Q14。時刻の比較は使わない。Review Focus 5)。部分索引を使う問い合わせは literal で書き、
 * 使う索引を INDEXED BY で固定する(EXPLAIN QUERY PLAN と rows_read で確かめる。Q18・Q27・Q28)
 */

type Owner = Awaited<ReturnType<typeof setupOwner>>;
type EventJson = {
  id: string;
  at: number;
  category: string;
  action: string;
  workspaceId: string | null;
  siteId: string | null;
  experimentId: string | null;
  via: string;
  actor: { userId: string; email: string | null; name: string | null } | null;
  apiKey: { id: string; name: string | null } | null;
  target: { type: string; id: string | null; label: string | null } | null;
  detail: Record<string, unknown>;
  workspaceName?: string | null;
};
type Person = { userId: string; email: string | null; name: string | null };
type History = { events: EventJson[]; nextCursor: string | null; createdBy: Person | null; updatedBy: Person | null };
type Page = { events: EventJson[]; nextCursor: string | null };

const DAY = 86_400_000;
const urlMatch = { op: "contains", value: "/" };

const historyPath = (sid: string, eid: string, q = "") => `/sites/${sid}/experiments/${eid}/history${q}`;
const getJson = async <T>(path: string, token: string, status = 200): Promise<T> => {
  const res = await call("GET", path, { token });
  expect(res.status, path).toBe(status);
  return json<T>(res);
};
const makeKey = async (token: string, workspaceId: string | null, extra: Record<string, unknown> = {}) => {
  const res = await call("POST", "/me/api-keys", { token, body: { name: "reader", workspaceId, ...extra } });
  expect(res.status).toBe(201);
  return (await json<{ key: string }>(res)).key;
};
const newWorkspace = async (owner: Owner, name: string) => {
  const res = await call("POST", "/workspaces", { token: owner.token, body: { name } });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
};
/** 下書きのテスト(名前 Hero)を持つサイト */
async function draft(owner: Owner, eid = "exp_a", sid?: string): Promise<{ sid: string; eid: string }> {
  const site = sid ?? (await createSite(owner.token, owner.workspaceId)).id;
  await createExperiment(owner.token, site, { id: eid, name: "Hero" });
  return { sid: site, eid };
}
const patchName = async (token: string, sid: string, eid: string, name: string) =>
  expect((await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { name } })).status).toBe(200);
const deleteDraft = async (token: string, sid: string, eid: string) => expect((await call("DELETE", `/sites/${sid}/experiments/${eid}`, { token })).status).toBe(204);

/** 記録の行を直接入れる(カーソル・絞り込み・索引のテスト用。トリガーは UPDATE・DELETE だけを断るので INSERT は通る) */
type Seed = {
  at: number;
  category?: "access" | "content";
  action?: string;
  workspace_id?: string | null;
  site_id?: string | null;
  experiment_id?: string | null;
  site_generation?: string | null;
  experiment_generation?: string | null;
  via?: string;
  actor_user_id?: string | null;
  actor_email?: string | null;
  actor_name?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  detail_json?: string;
};
const seedStatement = (s: Seed) =>
  env.DB.prepare(
    `insert into audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via,
       actor_user_id, actor_email, actor_name, target_type, target_id, target_label, detail_json)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  ).bind(
    s.at,
    s.category ?? "content",
    s.action ?? (s.category === "access" ? "member.role_change" : "site.update"),
    s.workspace_id ?? null,
    s.site_id ?? null,
    s.experiment_id ?? null,
    s.site_generation ?? null,
    s.experiment_generation ?? null,
    s.via ?? "google",
    s.actor_user_id ?? null,
    s.actor_email ?? null,
    s.actor_name ?? null,
    s.target_type ?? (s.target_label != null ? "site" : null),
    s.target_id ?? null,
    s.target_label ?? null,
    s.detail_json ?? "{}",
  );
async function seed(rows: Seed[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) await env.DB.batch(rows.slice(i, i + 200).map(seedStatement));
}
const siteGeneration = async (sid: string) => (await siteRow(sid)).generation;

/** 文を D1 で直接実行し、EXPLAIN QUERY PLAN の detail と rows_read を返す */
async function explain(q: { compile(c: typeof sqlCompiler): { sql: string; parameters: readonly unknown[] } }): Promise<{ plan: string[]; rowsRead: number; returned: number }> {
  const { sql, parameters } = q.compile(sqlCompiler);
  const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...parameters).all<{ detail: string }>()).results.map((r) => r.detail);
  const run = await env.DB.prepare(sql).bind(...parameters).all();
  return { plan, rowsRead: run.meta.rows_read, returned: run.results.length };
}
const filter = (f: Partial<AuditListFilter> = {}): AuditListFilter => ({ since: Date.now() - 365 * DAY, until: Date.now() + 1000, cursor: null, limit: 100, ...f });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("権限と鍵", () => {
  it("history_requires_viewer_and_membership", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const b = await newWorkspace(owner, "B");
    const outsider = await inviteAndJoin(owner.token, b, "admin");
    expect((await call("GET", historyPath(sid, eid), { token: viewer.token })).status).toBe(200);
    expect((await call("GET", historyPath(sid, eid), { token: outsider.token })).status).toBe(404);
    // エクスペリエンスが無ければ 404(今の GET と同じ)
    const missing = await call("GET", historyPath(sid, "nope"), { token: owner.token });
    expect(missing.status).toBe(404);
    await expectEnvelope(missing);
    // 閲覧者の鍵でも読める
    const viewerKey = await makeKey(viewer.token, owner.workspaceId);
    expect((await call("GET", historyPath(sid, eid), { token: viewerKey })).status).toBe(200);
  });

  it("workspace_log_requires_admin", async () => {
    const owner = await setupOwner();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const b = await newWorkspace(owner, "B");
    const outsider = await inviteAndJoin(owner.token, b, "admin");
    const path = `/workspaces/${owner.workspaceId}/audit-events`;
    expect((await call("GET", path, { token: admin.token })).status).toBe(200);
    const refused = await call("GET", path, { token: editor.token });
    expect(refused.status).toBe(403);
    expect(await expectEnvelope(refused)).toMatchObject({ error: "forbidden", required: "admin" });
    expect((await call("GET", path, { token: outsider.token })).status).toBe(404);
    // ワークスペースの鍵: 上限なし(オーナー)は読める・上限が編集者は 403・範囲外のワークスペースは 404
    const wsKey = await makeKey(owner.token, owner.workspaceId);
    expect((await call("GET", path, { token: wsKey })).status).toBe(200);
    const editorCapped = await makeKey(owner.token, owner.workspaceId, { roleCap: "editor" });
    expect((await call("GET", path, { token: editorCapped })).status).toBe(403);
    expect((await call("GET", `/workspaces/${b}/audit-events`, { token: wsKey })).status).toBe(404);
    // 管理者の上限の鍵は読める
    const adminCapped = await makeKey(owner.token, owner.workspaceId, { roleCap: "admin" });
    expect((await call("GET", path, { token: adminCapped })).status).toBe(200);
  });

  it("instance_log_requires_instance_admin", async () => {
    const owner = await setupOwner(); // システム管理者
    const promoted = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${promoted.memberId}`, { token: owner.token, body: { role: "owner" } })).status).toBe(200);
    expect((await call("GET", "/audit-events", { token: owner.token })).status).toBe(200);
    // ワークスペースのオーナー(システム管理者でない)は 403
    const refused = await call("GET", "/audit-events", { token: promoted.token });
    expect(refused.status).toBe(403);
    expect(await expectEnvelope(refused)).toMatchObject({ required: "instance_admin" });
    // 鍵はすべてのワークスペースの鍵(上限なし)だけ
    expect((await call("GET", "/audit-events", { token: await makeKey(owner.token, null) })).status).toBe(200);
    expect((await call("GET", "/audit-events", { token: await makeKey(owner.token, owner.workspaceId) })).status).toBe(403);
    expect((await call("GET", "/audit-events", { token: await makeKey(owner.token, null, { roleCap: "admin" }) })).status).toBe(403);
  });
});

describe("メールアドレスの出し分け(Review Focus 2)", () => {
  /** オーナーが作り、名前の無い編集者が名前を変えた下書き */
  async function edited(): Promise<{ owner: Owner; sid: string; eid: string; editor: Awaited<ReturnType<typeof inviteAndJoin>> }> {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await env.DB.prepare(`update "user" set name = '' where id = ?1`).bind(editor.userId).run();
    await patchName(editor.token, sid, eid, "Hero 2");
    return { owner, sid, eid, editor };
  }

  it("viewer_sees_names_only", async () => {
    const { owner, sid, eid, editor } = await edited();
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const editorLocal = editor.email.split("@")[0];
    const readers = [viewer.token, editor.token, await makeKey(viewer.token, owner.workspaceId), await makeKey(editor.token, owner.workspaceId)];
    for (const token of readers) {
      const res = await call("GET", historyPath(sid, eid), { token });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("@");
      const body = JSON.parse(text) as History;
      expect(body.events.map((e) => [e.action, e.actor])).toEqual([
        ["experiment.update", { userId: editor.userId, email: null, name: editorLocal }],
        ["experiment.create", { userId: owner.userId, email: null, name: "Owner" }],
      ]);
      expect(body.createdBy).toEqual({ userId: owner.userId, email: null, name: "Owner" });
      expect(body.updatedBy).toEqual({ userId: editor.userId, email: null, name: editorLocal });
    }
    // 管理者以上(セッション・上限なしの鍵)には email がある
    for (const token of [owner.token, await makeKey(owner.token, owner.workspaceId)]) {
      const body = await getJson<History>(historyPath(sid, eid), token);
      expect(body.events.map((e) => e.actor?.email)).toEqual([editor.email, owner.email]);
      expect(body.createdBy?.email).toBe(owner.email);
      expect(body.updatedBy).toEqual({ userId: editor.userId, email: editor.email, name: editorLocal });
    }
  });

  it("admin_owned_viewer_capped_key_sees_no_email", async () => {
    const { owner, sid, eid } = await edited();
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    for (const cap of ["viewer", "editor"]) {
      const res = await call("GET", historyPath(sid, eid), { token: await makeKey(admin.token, owner.workspaceId, { roleCap: cap }) });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("@");
    }
    const adminKey = await makeKey(admin.token, owner.workspaceId, { roleCap: "admin" });
    expect((await getJson<History>(historyPath(sid, eid), adminKey)).createdBy?.email).toBe(owner.email);
  });

  it("deleted_person_has_null_email", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    const exp = await experimentRow(sid, eid);
    await seed([
      {
        at: Date.now(),
        workspace_id: owner.workspaceId,
        site_id: sid,
        experiment_id: eid,
        site_generation: await siteGeneration(sid),
        experiment_generation: exp.generation,
        action: "experiment.update",
        actor_user_id: "ghost",
        actor_email: "ghost@example.com",
        actor_name: "Ghost",
        target_type: "experiment",
        target_id: eid,
        target_label: "Hero",
        detail_json: JSON.stringify({ fields: ["name"] }),
      },
    ]);
    await env.DB.prepare(`update experiments set updated_by = 'ghost' where site_id = ?1 and id = ?2`).bind(sid, eid).run();
    const body = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(body.events[0]!.actor).toEqual({ userId: "ghost", email: null, name: "Ghost" });
    expect(body.events[1]!.actor?.email).toBe(owner.email); // 今もいる人はメールがある
    expect(body.updatedBy).toEqual({ userId: "ghost", email: null, name: null });
  });

  it("email_inventory_is_masked_for_non_admin_views", () => {
    // メールアドレスが入りうる所(target_label の user・invitation と、detail の api_key.revoke_member の owner)を、管理者未満の見え方で落とす。
    // 変更履歴(閲覧者以上)に出るのは experiment.* だけだが、出し分けは行の種類に依らず掛ける
    const row = (r: Partial<AuditReadRow>): AuditReadRow => ({
      id: 1,
      at: 1,
      category: "access",
      action: "member.role_change",
      workspace_id: "w",
      site_id: null,
      experiment_id: null,
      via: "google",
      actor_user_id: "u",
      actor_email: "hanako@example.com",
      actor_name: "",
      actor_exists: 1,
      api_key_id: null,
      api_key_name: null,
      target_type: "user",
      target_id: "u2",
      target_label: "jiro@example.com",
      detail_json: "{}",
      ...r,
    });
    const viewer = { showEmail: false, hideInvitationIds: false };
    expect(toAuditEventJson(row({}), viewer)).toMatchObject({ actor: { userId: "u", email: null, name: "hanako" }, target: { type: "user", id: "u2", label: "jiro" } });
    expect(toAuditEventJson(row({ action: "invitation.create", target_type: "invitation", target_id: "inv1" }), viewer).target).toEqual({ type: "invitation", id: "inv1", label: "jiro" });
    const revoke = row({ action: "api_key.revoke_member", target_type: "api_key", target_id: "k1", target_label: "ci", detail_json: JSON.stringify({ owner: "jiro@example.com" }) });
    expect(toAuditEventJson(revoke, viewer)).toMatchObject({ target: { label: "ci" }, detail: { owner: null } });
    expect(JSON.stringify(toAuditEventJson(revoke, viewer))).not.toContain("@");
    // API キーの名前も、メールアドレスの形なら管理者未満には @ より前だけ(final review)
    const keyRow = row({ via: "api_key", api_key_id: "k1", api_key_name: "ci-bot@example.com" });
    expect(toAuditEventJson(keyRow, viewer).apiKey).toEqual({ id: "k1", name: "ci-bot" });
    expect(toAuditEventJson(row({ via: "api_key", api_key_id: "k1", api_key_name: "ci" }), viewer).apiKey).toEqual({ id: "k1", name: "ci" });
    expect(toAuditEventJson(keyRow, { showEmail: true, hideInvitationIds: false }).apiKey).toEqual({ id: "k1", name: "ci-bot@example.com" });
    // 管理者以上は控えのまま
    const admin = { showEmail: true, hideInvitationIds: false };
    expect(toAuditEventJson(revoke, admin)).toMatchObject({ actor: { email: "hanako@example.com", name: "hanako" }, detail: { owner: "jiro@example.com" } });
    // API キーからは招待の ID を出さない
    const inv = row({ action: "invitation.cancel", target_type: "invitation", target_id: "inv1" });
    expect(toAuditEventJson(inv, { showEmail: true, hideInvitationIds: true }).target).toEqual({ type: "invitation", id: null, label: "jiro@example.com" });
  });

  it("email_shaped_names_are_cut_for_non_admins", async () => {
    // 名前にメールアドレスを入れた人: 閲覧者・編集者には @ より前だけ(actor・createdBy・updatedBy)、管理者以上には名前のまま
    const owner = await setupOwner();
    await env.DB.prepare(`update "user" set name = 'boss@example.com' where id = ?1`).bind(owner.userId).run();
    const { sid, eid } = await draft(owner);
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const res = await call("GET", historyPath(sid, eid), { token: viewer.token });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("@");
    const body = JSON.parse(text) as History;
    expect(body.events[0]!.actor).toEqual({ userId: owner.userId, email: null, name: "boss" });
    expect(body.createdBy).toEqual({ userId: owner.userId, email: null, name: "boss" });
    expect(body.updatedBy).toEqual({ userId: owner.userId, email: null, name: "boss" });
    const admin = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(admin.events[0]!.actor?.name).toBe("boss@example.com");
    expect(admin.createdBy?.name).toBe("boss@example.com");
  });

  it("invitation_ids_hidden_from_api_keys", async () => {
    const owner = await setupOwner();
    const pending = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: "pending@example.com", role: "editor" } }));
    const cancelled = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email: "cancel@example.com", role: "viewer" } }));
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${cancelled.id}`, { token: owner.token })).status).toBe(204);
    const accepted = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const invitationRows = (env.DB.prepare(`select target_id from audit_events where target_type = 'invitation'`).all<{ target_id: string }>());
    const invitationIds = new Set((await invitationRows).results.map((r) => r.target_id));
    expect(invitationIds.has(pending.id) && invitationIds.has(cancelled.id)).toBe(true);
    expect(invitationIds.size).toBe(3); // 発行 3 件(受諾した 1 件を含む)の ID

    const viaKeys = [
      [`/workspaces/${owner.workspaceId}/audit-events`, await makeKey(owner.token, owner.workspaceId)],
      ["/audit-events", await makeKey(owner.token, null)],
    ] as const;
    for (const [path, key] of viaKeys) {
      const res = await call("GET", path, { token: key });
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const id of invitationIds) expect(text, path).not.toContain(id);
      const body = JSON.parse(text) as Page;
      const inv = body.events.filter((e) => e.action.startsWith("invitation."));
      expect(inv.map((e) => e.action).sort()).toEqual(["invitation.accept", "invitation.cancel", "invitation.create", "invitation.create", "invitation.create"]);
      for (const e of inv) expect(e.target).toMatchObject({ type: "invitation", id: null });
      expect(inv.find((e) => e.action === "invitation.accept")?.actor?.userId).toBe(accepted.userId);
    }
    // セッションでは出る
    const session = await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events`, owner.token);
    expect(new Set(session.events.filter((e) => e.target?.type === "invitation").map((e) => e.target!.id))).toEqual(invitationIds);
  });
});

describe("変更履歴の世代(Q14。Review Focus 5)", () => {
  it("history_lists_experiment_rows_of_the_current_generation", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    await patchName(owner.token, sid, eid, "Hero 2");
    // 同じサイトのほかのエクスペリエンス・サイトの行は出ない
    await createExperiment(owner.token, sid, { id: "exp_other", name: "Other" });
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { name: "Renamed" } })).status).toBe(200);
    const body = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(body.events.map((e) => e.action)).toEqual(["experiment.update", "experiment.create"]);
    expect(body.events.every((e) => e.experimentId === eid && e.siteId === sid && e.workspaceId === owner.workspaceId && e.category === "content")).toBe(true);
    expect(body.events[0]).toMatchObject({ via: "google", apiKey: null, target: { type: "experiment", id: eid, label: "Hero" }, detail: { fields: ["name"], name: { from: "Hero", to: "Hero 2" } } });
    expect(body.events[0]!.id).toMatch(/^\d+$/);
    expect(Number(body.events[0]!.id)).toBeGreaterThan(Number(body.events[1]!.id));
    expect(body.nextCursor).toBeNull();
  });

  it("history_ignores_reused_experiment_id", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    await patchName(owner.token, sid, eid, "Old");
    await deleteDraft(owner.token, sid, eid);
    await createExperiment(owner.token, sid, { id: eid, name: "New" });
    const body = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(body.events.map((e) => [e.action, e.target?.label])).toEqual([["experiment.create", "New"]]);
  });

  it("history_ignores_same_millisecond_recreate", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    const t = Date.now();
    // draft の作成の記録が同じミリ秒に入ることがある(速い実行)ので、固定した後に増えた数を見る
    const atT = async () => (await env.DB.prepare(`select count(*) as n from audit_events where experiment_id = ?1 and at = ?2`).bind(eid, t).first<{ n: number }>())!.n;
    const before = await atT();
    vi.spyOn(Date, "now").mockReturnValue(t);
    await patchName(owner.token, sid, eid, "Old");
    await deleteDraft(owner.token, sid, eid);
    await createExperiment(owner.token, sid, { id: eid, name: "New" });
    vi.restoreAllMocks();
    expect((await atT()) - before).toBe(3);
    const body = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(body.events.map((e) => [e.action, e.target?.label])).toEqual([["experiment.create", "New"]]);
  });

  it("history_ignores_create_race", async () => {
    // 後の作成の要求が先に時刻を取った(前の世代の行より前の時刻で作られた)ときも、前の世代の行は出ない
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const t = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t + 5000);
    await createExperiment(owner.token, sid, { id: "exp_r", name: "First" });
    await patchName(owner.token, sid, "exp_r", "First 2");
    await deleteDraft(owner.token, sid, "exp_r");
    vi.spyOn(Date, "now").mockReturnValue(t);
    await createExperiment(owner.token, sid, { id: "exp_r", name: "Second" });
    vi.restoreAllMocks();
    const body = await getJson<History>(historyPath(sid, "exp_r"), owner.token);
    expect(body.events.map((e) => [e.action, e.target?.label, e.at])).toEqual([["experiment.create", "Second", t]]);
  });

  it("site_log_ignores_recreated_site", async () => {
    const owner = await setupOwner();
    await createSite(owner.token, owner.workspaceId, { id: "shop" });
    const old = await draft(owner, "exp_s", "shop");
    const oldSiteGeneration = await siteGeneration("shop");
    await patchName(owner.token, old.sid, old.eid, "Old");
    expect((await call("DELETE", "/sites/shop", { token: owner.token })).status).toBe(204);
    await createSite(owner.token, owner.workspaceId, { id: "shop" });
    await draft(owner, "exp_s", "shop");
    const exp = await experimentRow("shop", "exp_s");
    // 今のエクスペリエンスの世代でも、前のサイトの世代の行は出ない
    await seed([{ at: Date.now() + 10, workspace_id: owner.workspaceId, site_id: "shop", experiment_id: "exp_s", site_generation: oldSiteGeneration, experiment_generation: exp.generation, action: "experiment.update" }]);
    const body = await getJson<History>(historyPath("shop", "exp_s"), owner.token);
    expect(body.events.map((e) => e.action)).toEqual(["experiment.create"]);
    expect(oldSiteGeneration).not.toBe(await siteGeneration("shop"));
  });

  it("site_log_ignores_other_workspace_generation", async () => {
    // B155: 元のワークスペースを消した後、システム管理者が同じサイト ID を別のワークスペースで取り直す
    const owner = await setupOwner();
    const y = await newWorkspace(owner, "Y");
    await createSite(owner.token, y, { id: "shop" });
    await draft(owner, "exp_s", "shop");
    await patchName(owner.token, "shop", "exp_s", "Old");
    expect((await call("DELETE", `/workspaces/${y}`, { token: owner.token })).status).toBe(204);
    await createSite(owner.token, owner.workspaceId, { id: "shop" });
    await draft(owner, "exp_s", "shop");
    const exp = await experimentRow("shop", "exp_s");
    // 前のワークスペースの行は、世代が今のものと同じでも出ない(認可したサイトの workspace_id を必ず条件にする)
    await seed([{ at: Date.now() + 10, workspace_id: y, site_id: "shop", experiment_id: "exp_s", site_generation: await siteGeneration("shop"), experiment_generation: exp.generation, action: "experiment.update" }]);
    const body = await getJson<History>(historyPath("shop", "exp_s"), owner.token);
    expect(body.events.map((e) => [e.action, e.workspaceId])).toEqual([["experiment.create", owner.workspaceId]]);
  });

  it("history_after_legacy_insert", async () => {
    // Q25: 世代を書かない形(旧 control の形)で入れたサイト・エクスペリエンスも、トリガーが世代を埋め、新しい control の操作が変更履歴に出る
    const owner = await setupOwner();
    const { id: tmpl } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, tmpl, { id: "exp_t", name: "Legacy" });
    const columns = async (table: string) =>
      (await env.DB.prepare(`select name from pragma_table_info(?1)`).bind(table).all<{ name: string }>()).results.map((r) => r.name).filter((n) => n !== "generation");
    const siteCols = await columns("sites");
    const expCols = await columns("experiments");
    const legacySite = () =>
      env.DB.prepare(`insert into sites (${siteCols.join(", ")}) select ${siteCols.map((c) => (c === "id" ? "'legacy'" : c)).join(", ")} from sites where id = ?1`).bind(tmpl).run();
    const legacyExperiment = () =>
      env.DB.prepare(`insert into experiments (${expCols.join(", ")}) select ${expCols.map((c) => (c === "site_id" ? "'legacy'" : c)).join(", ")} from experiments where site_id = ?1 and id = 'exp_t'`)
        .bind(tmpl)
        .run();
    const legacyVariants = async () => {
      const cols = (await env.DB.prepare(`select name from pragma_table_info('variants')`).all<{ name: string }>()).results.map((r) => r.name);
      await env.DB.prepare(`insert into variants (${cols.join(", ")}) select ${cols.map((c) => (c === "site_id" ? "'legacy'" : c)).join(", ")} from variants where site_id = ?1 and experiment_id = 'exp_t'`)
        .bind(tmpl)
        .run();
    };
    await legacySite();
    await legacyExperiment();
    await legacyVariants();
    expect((await experimentRow("legacy", "exp_t")).generation).toMatch(/^[0-9a-f]{32}$/);
    await patchName(owner.token, "legacy", "exp_t", "Legacy 2");
    expect((await getJson<History>(historyPath("legacy", "exp_t"), owner.token)).events.map((e) => e.action)).toEqual(["experiment.update"]);
    // 同じ ID を消して同じ形で入れ直すと、前の世代の行は出ない
    await env.DB.prepare(`delete from experiments where site_id = 'legacy' and id = 'exp_t'`).run();
    await legacyExperiment();
    expect((await getJson<History>(historyPath("legacy", "exp_t"), owner.token)).events).toEqual([]);
  });

  it("history_created_by_before_recording", async () => {
    // D4: 記録の無い(記録を始める前に作られた)エクスペリエンスでも、作った人・最後に変えた人が返る
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await env.DB.prepare(`update experiments set updated_by = ?1 where site_id = ?2 and id = ?3`).bind(editor.userId, sid, eid).run();
    // 記録は消せないので、別の世代にして「記録の無いエクスペリエンス」を作る
    await env.DB.prepare(`update experiments set generation = 'before-recording' where site_id = ?1 and id = ?2`).bind(sid, eid).run();
    const body = await getJson<History>(historyPath(sid, eid), owner.token);
    expect(body).toEqual({
      events: [],
      nextCursor: null,
      createdBy: { userId: owner.userId, email: owner.email, name: "Owner" },
      updatedBy: { userId: editor.userId, email: editor.email, name: "editor" },
    });
  });

  it("history_reads_in_parallel", async () => {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    // 文の実行の重なりを数える(履歴と作った人の 2 本が同時に D1 に出ていること)
    let inFlight = 0;
    let maxInFlight = 0;
    const tracked: string[] = [];
    const inner = countingD1(env.DB);
    const wrap = (stmt: D1PreparedStatement, text: string): D1PreparedStatement =>
      new Proxy(stmt, {
        get(s, p) {
          if (p === "all" || p === "first" || p === "run" || p === "raw") {
            const f = Reflect.get(s, p) as (...a: unknown[]) => Promise<unknown>;
            return async (...a: unknown[]) => {
              const watched = /audit_events|created_by/.test(text);
              if (watched) {
                tracked.push(`start ${text.slice(0, 40)}`);
                maxInFlight = Math.max(maxInFlight, ++inFlight);
              }
              try {
                return await f.apply(s, a);
              } finally {
                if (watched) {
                  inFlight--;
                  tracked.push(`end ${text.slice(0, 40)}`);
                }
              }
            };
          }
          if (p === "bind") return (...a: unknown[]) => wrap(s.bind(...a), text);
          const x = Reflect.get(s, p);
          return typeof x === "function" ? x.bind(s) : x;
        },
      });
    const db = new Proxy(inner.db, {
      get(t, p) {
        if (p === "prepare") return (text: string) => wrap(t.prepare(text), text);
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    // 比べる基準: 同じ認証・loadSite の GET /sites/:sid(先頭の 4 本)
    inner.reset();
    expect((await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { DB: db } })).status).toBe(200);
    const base = inner.counts();
    inner.reset();
    expect((await call("GET", historyPath(sid, eid), { token: owner.token, envOverride: { DB: db } })).status).toBe(200);
    const history = inner.counts();
    expect(history.batches).toBe(0);
    // 2 本とも始まってから終わる(Kysely の接続の mutex を通すと start・end・start・end の順に直列になる)
    expect(tracked.map((t) => t.split(" ")[0])).toEqual(["start", "start", "end", "end"]);
    expect(maxInFlight).toBe(2);
    // 認証(セッション・人の 2 本)と loadSite(サイト・ロールの 2 本)は GET /sites/:sid と同じ 4 本で、その後に履歴と作った人の 2 本だけ
    expect(history.queries).toBe(6);
    expect(history.sql.slice(0, 4)).toEqual(base.sql.slice(0, 4));
    expect(history.sql[2]).toMatch(/from "sites"/);
    expect(history.sql[3]).toMatch(/from "member"/);
    expect(history.sql.slice(4).map((s) => (/from audit_events/.test(s) ? "history" : /from experiments e/.test(s) ? "people" : s))).toEqual(["history", "people"]);
  });
});

describe("カーソルと絞り込み", () => {
  it("cursor_has_no_gaps_with_equal_at", async () => {
    const owner = await setupOwner();
    const at = Date.now() - 1000;
    await seed(Array.from({ length: 150 }, () => ({ at, workspace_id: owner.workspaceId, category: "access" as const, action: "member.role_change" })));
    const path = `/workspaces/${owner.workspaceId}/audit-events`;
    const first = await getJson<Page>(path, owner.token);
    expect(first.events).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await getJson<Page>(`${path}?cursor=${first.nextCursor}`, owner.token);
    const ids = [...first.events, ...second.events].filter((e) => e.at === at).map((e) => Number(e.id));
    expect(ids).toHaveLength(150);
    expect(new Set(ids).size).toBe(150);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(second.nextCursor).toBeNull();
    // limit
    const small = await getJson<Page>(`${path}?limit=7`, owner.token);
    expect(small.events).toHaveLength(7);
    expect(decodeAuditCursor(small.nextCursor!)).toEqual({ at, id: Number(small.events[6]!.id) });
  });

  it("cursor_round_trip_and_invalid_cursor_is_validation_failed", async () => {
    expect(decodeAuditCursor(encodeAuditCursor({ at: 1730000000000, id: 42 }))).toEqual({ at: 1730000000000, id: 42 });
    expect(encodeAuditCursor({ at: 1, id: 2 })).toMatch(/^[A-Za-z0-9_-]+$/);
    for (const bad of ["", "%%%", "abc", btoa("1.x"), btoa("-1.2"), btoa("1.2.3"), btoa("99999999999999999999.1")]) expect(decodeAuditCursor(bad), bad).toBeNull();
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner);
    for (const path of [`/workspaces/${owner.workspaceId}/audit-events?cursor=nope`, "/audit-events?cursor=nope", historyPath(sid, eid, "?cursor=nope"), `/audit-events?limit=0`, `/audit-events?limit=101`]) {
      const res = await call("GET", path, { token: owner.token });
      expect(res.status, path).toBe(422);
      expect(await expectEnvelope(res), path).toMatchObject({ error: "validation_failed" });
    }
  });

  it("since_is_clamped_to_365_days", async () => {
    const owner = await setupOwner();
    const now = Date.now();
    await seed([
      { at: now - 400 * DAY, workspace_id: owner.workspaceId, target_label: "400d" },
      { at: now - 364 * DAY, workspace_id: owner.workspaceId, target_label: "364d" },
      { at: now - 31 * DAY, workspace_id: owner.workspaceId, target_label: "31d" },
      { at: now - 29 * DAY, workspace_id: owner.workspaceId, target_label: "29d" },
    ]);
    const labels = async (q: string) =>
      (await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events${q}`, owner.token)).events.map((e) => e.target?.label).filter((l) => l?.endsWith("d"));
    expect(await labels("")).toEqual(["29d"]); // 既定は 30 日
    expect(await labels("?since=0")).toEqual(["29d", "31d", "364d"]);
    expect(await labels(`?since=${now - 500 * DAY}`)).toEqual(["29d", "31d", "364d"]);
  });

  it("until_filters_the_end_of_range", async () => {
    const owner = await setupOwner();
    const t = Date.now() - 10 * DAY;
    await seed([1, 2, 3].map((n) => ({ at: t + n * 1000, workspace_id: owner.workspaceId, target_label: `t${n}` })));
    const page = await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events?since=${t}&until=${t + 2000}`, owner.token);
    expect(page.events.map((e) => e.target?.label)).toEqual(["t2", "t1"]);
    const inst = await getJson<Page>(`/audit-events?since=${t + 2000}&until=${t + 3000}`, owner.token);
    expect(inst.events.map((e) => e.target?.label)).toEqual(["t3", "t2"]);
  });

  it("category_filter", async () => {
    const owner = await setupOwner();
    const at = Date.now() - 1000;
    await seed([
      { at, workspace_id: owner.workspaceId, category: "access", target_label: "a" },
      { at: at + 1, workspace_id: owner.workspaceId, category: "content", target_label: "c" },
    ]);
    const labels = async (path: string) => (await getJson<Page>(path, owner.token)).events.map((e) => e.target?.label).filter((l) => l === "a" || l === "c");
    expect(await labels(`/workspaces/${owner.workspaceId}/audit-events?category=access`)).toEqual(["a"]);
    expect(await labels(`/workspaces/${owner.workspaceId}/audit-events?category=content`)).toEqual(["c"]);
    expect(await labels(`/workspaces/${owner.workspaceId}/audit-events`)).toEqual(["c", "a"]);
    expect(await labels(`/audit-events?category=access`)).toEqual(["a"]);
    expect(await labels(`/audit-events?category=content`)).toEqual(["c"]);
    expect((await call("GET", `/audit-events?category=other`, { token: owner.token })).status).toBe(422);
  });

  it("elevated_filter", async () => {
    const owner = await setupOwner();
    const at = Date.now() - 1000;
    await seed([
      { at, workspace_id: owner.workspaceId, via: "password", target_label: "pw" },
      { at: at + 1, workspace_id: null, category: "access", via: "break_glass", target_label: "bg" },
      { at: at + 2, workspace_id: owner.workspaceId, via: "google", target_label: "g" },
      { at: at + 3, workspace_id: owner.workspaceId, via: "setup", target_label: "setup" },
    ]);
    const labels = async (path: string) => (await getJson<Page>(path, owner.token)).events.map((e) => e.target?.label).filter((l) => ["pw", "bg", "g", "setup"].includes(l ?? ""));
    expect(await labels(`/workspaces/${owner.workspaceId}/audit-events?elevated=true`)).toEqual(["pw"]);
    expect(await labels(`/workspaces/${owner.workspaceId}/audit-events?elevated=false`)).toEqual(["setup", "g", "pw"]);
    expect(await labels(`/audit-events?elevated=true`)).toEqual(["bg", "pw"]);
    expect(await labels(`/audit-events?elevated=true&workspaceId=none`)).toEqual(["bg"]);
  });

  it("workspace_filter_none", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner, "B");
    const at = Date.now() - 1000;
    await seed([
      { at, workspace_id: null, category: "access", target_label: "instance" },
      { at: at + 1, workspace_id: owner.workspaceId, target_label: "a" },
      { at: at + 2, workspace_id: b, target_label: "b" },
    ]);
    const labels = async (q: string) => (await getJson<Page>(`/audit-events${q}`, owner.token)).events.map((e) => e.target?.label).filter((l) => ["instance", "a", "b"].includes(l ?? ""));
    expect(await labels("")).toEqual(["b", "a", "instance"]);
    expect(await labels("?workspaceId=none")).toEqual(["instance"]);
    expect(await labels(`?workspaceId=${b}`)).toEqual(["b"]);
    expect(await labels(`?workspaceId=${b}&category=access`)).toEqual([]);
    // ワークスペースの記録には自分のワークスペースの行だけ
    expect((await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events`, owner.token)).events.map((e) => e.target?.label).filter((l) => ["instance", "a", "b"].includes(l ?? ""))).toEqual(["a"]);
  });

  it("deleted_workspace_name_is_null", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner, "Gone");
    expect((await call("DELETE", `/workspaces/${b}`, { token: owner.token })).status).toBe(204);
    const page = await getJson<Page & { events: Array<EventJson & { workspaceName: string | null }> }>("/audit-events", owner.token);
    const create = page.events.find((e) => e.action === "workspace.create" && e.workspaceId === b)!;
    const del = page.events.find((e) => e.action === "workspace.delete")!;
    expect(create).toMatchObject({ workspaceName: null, target: { type: "workspace", id: b, label: "Gone" } });
    expect(del.workspaceName).toBeNull();
    const setup = page.events.find((e) => e.action === "setup.complete")!;
    expect(setup).toMatchObject({ workspaceId: owner.workspaceId, workspaceName: "Workspace A", via: "setup" });
    // 導入全体の行(ワークスペースに属さない)も null
    await seed([{ at: Date.now(), workspace_id: null, category: "access", target_label: "instance" }]);
    expect((await getJson<Page>("/audit-events?workspaceId=none", owner.token)).events[0]).toMatchObject({ workspaceId: null, workspaceName: null });
    // ワークスペースの記録の行には workspaceName を付けない
    expect((await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events`, owner.token)).events[0]).not.toHaveProperty("workspaceName");
  });

  it("row_shape_of_an_access_event", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "admin" } })).status).toBe(200);
    const key = await makeKey(owner.token, owner.workspaceId);
    const page = await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events?category=access`, key);
    const e = page.events.find((x) => x.action === "member.role_change")!;
    expect(e).toEqual({
      id: expect.stringMatching(/^\d+$/),
      at: expect.any(Number),
      category: "access",
      action: "member.role_change",
      workspaceId: owner.workspaceId,
      siteId: null,
      experimentId: null,
      via: "google",
      actor: { userId: owner.userId, email: owner.email, name: "Owner" },
      apiKey: null,
      target: { type: "user", id: ed.userId, label: ed.email },
      detail: { from: "editor", to: "admin" },
    });
    // 鍵の操作の行は apiKey を持つ
    const { id: sid } = await createSite(key, owner.workspaceId);
    const site = (await getJson<Page>(`/workspaces/${owner.workspaceId}/audit-events?category=content`, owner.token)).events.find((x) => x.action === "site.create" && x.siteId === sid)!;
    expect(site).toMatchObject({ via: "api_key", apiKey: { id: expect.any(String), name: "reader" }, actor: { userId: owner.userId } });
  });
});

describe("索引と読む行(Q18・Q27・Q28)", () => {
  const wsScope = (workspaceId: string): AuditListScope => ({ kind: "workspace", workspaceId });
  const all: AuditListScope = { kind: "instance" };

  it("list_uses_index", async () => {
    const cases: Array<[AuditListScope, Partial<AuditListFilter>, string]> = [
      [wsScope("w"), {}, "audit_events_ws_at"],
      [wsScope("w"), { category: "content" }, "audit_events_ws_at"],
      [wsScope("w"), { category: "access" }, "audit_events_ws_access_at"],
      [wsScope("w"), { elevated: true }, "audit_events_ws_pw_at"],
      [wsScope("w"), { elevated: true, category: "access" }, "audit_events_ws_pw_at"],
      [all, {}, "audit_events_at"],
      [all, { category: "content" }, "audit_events_at"],
      [all, { category: "access" }, "audit_events_access_at"],
      [all, { elevated: true }, "audit_events_pw_at"],
      [{ kind: "instance", workspaceId: null }, {}, "audit_events_ws_at"],
      [{ kind: "instance", workspaceId: "w" }, { category: "access" }, "audit_events_ws_access_at"],
      [{ kind: "instance", workspaceId: null }, { elevated: true }, "audit_events_ws_pw_at"],
    ];
    for (const [scope, f, index] of cases) {
      expect(auditListIndex(scope, filter(f))).toBe(index);
      for (const cursor of [null, { at: Date.now(), id: 10 }]) {
        const { plan } = await explain(auditListQuery(scope, filter({ ...f, cursor })));
        const label = `${JSON.stringify(scope)} ${JSON.stringify(f)} ${cursor ? "cursor" : ""}`;
        expect(plan[0], label).toMatch(new RegExp(`^SEARCH a USING INDEX ${index} \\(`));
        expect(plan.join("\n"), label).not.toMatch(/SCAN a\b|USE TEMP B-TREE/);
      }
    }
    const { plan } = await explain(auditHistoryQuery({ id: "s", workspace_id: "w", generation: "g" }, "e", { cursor: { at: 1, id: 1 }, limit: 100 }));
    expect(plan[0]).toMatch(/^SEARCH a USING INDEX audit_events_exp_at \(site_id=\? AND experiment_id=\? AND experiment_generation=\? AND at<\?\)/);
    expect(plan.join("\n")).not.toMatch(/SCAN a\b|USE TEMP B-TREE/);
    // 部分索引の条件は literal で書く(bind の値では部分索引が使えない)
    const { sql } = auditListQuery(wsScope("w"), filter({ elevated: true })).compile(sqlCompiler);
    expect(sql).toContain(`a.via in ('password', 'break_glass')`);
    expect(auditListQuery(wsScope("w"), filter({ category: "access" })).compile(sqlCompiler).sql).toContain(`a.category = 'access'`);
  });

  /**
   * 偏ったデータ: 対象のワークスペースに content(google)を多く・access を 0 行、別のワークスペースに access・content(password)を多く入れる。
   * 対象のエクスペリエンスには今の世代の行 150 と前の世代の行 100(変更履歴は今の世代の 101 行で止まる)
   */
  async function skewed(): Promise<{ w: string; sid: string; eid: string; siteGen: string }> {
    const owner = await setupOwner();
    const { sid, eid } = await draft(owner, "e_target");
    const w = owner.workspaceId;
    const siteGen = await siteGeneration(sid);
    const expGen = (await experimentRow(sid, eid)).generation;
    const now = Date.now() - 60_000;
    const rows: Seed[] = [];
    const actor = { actor_user_id: owner.userId, actor_email: owner.email, actor_name: "Owner" };
    for (let i = 0; i < 300; i++) rows.push({ ...actor, at: now - i * 1000, workspace_id: w, site_id: sid, category: "content", via: "google" });
    for (let i = 0; i < 300; i++) rows.push({ ...actor, at: now - i * 1000 - 500, workspace_id: "w_other", category: "access", via: "password" });
    for (let i = 0; i < 300; i++) rows.push({ ...actor, at: now - i * 1000 - 700, workspace_id: "w_other", category: "content", via: "password" });
    for (let i = 0; i < 150; i++)
      rows.push({ ...actor, at: now - i * 1000 - 300, workspace_id: w, site_id: sid, experiment_id: eid, site_generation: siteGen, experiment_generation: expGen, action: "experiment.update" });
    for (let i = 0; i < 100; i++)
      rows.push({ ...actor, at: now - i * 1000 - 400, workspace_id: w, site_id: sid, experiment_id: eid, site_generation: siteGen, experiment_generation: "old", action: "experiment.update" });
    await seed(rows);
    // 対象のワークスペースの access の行は、setupOwner の setup.complete の 1 行だけ(記録は消せないので、0 行の代わりに 1 行)
    expect((await env.DB.prepare(`select count(*) as n from audit_events where workspace_id = ?1 and category = 'access'`).bind(w).first<{ n: number }>())!.n).toBe(1);
    return { w, sid, eid, siteGen };
  }

  it("workspace_access_filter_uses_ws_access_index", async () => {
    const { w } = await skewed();
    const r = await explain(auditListQuery(wsScope(w), filter({ category: "access" })));
    expect(r.plan[0]).toMatch(/USING INDEX audit_events_ws_access_at /);
    expect(r.returned).toBe(1);
    expect(r.rowsRead).toBeLessThanOrEqual(4);
    // 複合(access + パスワード・非常口)も、そのワークスペースの該当行だけ
    const both = await explain(auditListQuery(wsScope(w), filter({ category: "access", elevated: true })));
    expect(both.returned).toBe(0);
    expect(both.rowsRead).toBeLessThanOrEqual(2);
  });

  it("workspace_elevated_filter_uses_ws_pw_index", async () => {
    const { w } = await skewed();
    const r = await explain(auditListQuery(wsScope(w), filter({ elevated: true })));
    expect(r.plan[0]).toMatch(/USING INDEX audit_events_ws_pw_at /);
    expect(r.returned).toBe(0);
    expect(r.rowsRead).toBeLessThanOrEqual(2);
  });

  it("rows_read_per_filter", async () => {
    // 返す行(101 まで)と読む行(rows_read。索引と、人・ワークスペースの名前の 1 行ずつの照会を含む)を絞り込みごとに測る
    const { w, sid, eid, siteGen } = await skewed();
    const measured: Record<string, { returned: number; rowsRead: number }> = {};
    const m = async (name: string, q: Parameters<typeof explain>[0]) => {
      const r = await explain(q);
      measured[name] = { returned: r.returned, rowsRead: r.rowsRead };
    };
    await m("history", auditHistoryQuery({ id: sid, workspace_id: w, generation: siteGen }, eid, { cursor: null, limit: 100 }));
    await m("ws", auditListQuery(wsScope(w), filter()));
    await m("ws_access", auditListQuery(wsScope(w), filter({ category: "access" })));
    await m("ws_content", auditListQuery(wsScope(w), filter({ category: "content" })));
    await m("ws_elevated", auditListQuery(wsScope(w), filter({ elevated: true })));
    await m("all", auditListQuery(all, filter()));
    await m("all_access", auditListQuery(all, filter({ category: "access" })));
    await m("all_content", auditListQuery(all, filter({ category: "content" })));
    await m("all_elevated", auditListQuery(all, filter({ elevated: true })));
    for (const k of ["history", "ws", "ws_content", "all", "all_access", "all_content", "all_elevated"]) expect(measured[k]!.returned, k).toBe(101);
    // 見込み: 1 行あたり、記録の行 1 + 操作した人の照会 1(導入全体はワークスペースの名前の照会でさらに + 1)。該当の行が少ない絞り込みは、その行の分だけ
    // 導入全体のサイト・エクスペリエンスは at の索引を読み、間に挟まる access の行の分も読む(category は残りの絞り込み)
    const perRow = { history: 2, ws: 2, ws_content: 2, all: 3, all_access: 3, all_content: 4, all_elevated: 3 } as const;
    for (const [k, n] of Object.entries(perRow)) expect(measured[k]!.rowsRead, k).toBeLessThanOrEqual(n * 101 + 4);
    // 対象のワークスペースの access は setup.complete の 1 行だけ。別のワークスペースの 300 行は読まない
    expect(measured.ws_access!.returned).toBe(1);
    expect(measured.ws_access!.rowsRead).toBeLessThanOrEqual(4);
    expect(measured.ws_elevated!.returned).toBe(0);
    expect(measured.ws_elevated!.rowsRead).toBeLessThanOrEqual(2);
    // 報告用に測った値を残す(失敗の文で読める)
    expect(Object.keys(measured)).toHaveLength(9);
    console.log("rows_read_per_filter", JSON.stringify(measured)); // workerd のログは vitest に出ないので、値を見るときは一時的に toEqual で落とす
  });
});
