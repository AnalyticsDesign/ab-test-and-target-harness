import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/instance-admins";
import {
  beforeD1Batch,
  beforeD1BatchMatching,
  call,
  countingD1,
  createSite,
  failingD1Insert,
  inviteAndJoin,
  json,
  SETUP_TOKEN,
  setupOwner,
  siteWithRunning,
  testEnv,
  uniqueEmail,
} from "./helpers";

/**
 * B129 Task 3(spec §3.1 の区分 access のうち batch で書く操作・§5.2・§5.3): 人とアクセス権の操作は、操作と同じ batch に記録の文を入れる。
 * 通ったときだけ 1 行、断られた(409・404)・同時の要求に負けたときは 0 行(Review Focus 1)。記録が書けなければ操作ごと戻る(Q8)
 */

type Row = {
  id: number;
  at: number;
  category: string;
  action: string;
  workspace_id: string | null;
  via: string;
  actor_user_id: string | null;
  actor_email: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail_json: string;
};
const events = async (action: string): Promise<Array<Row & { detail: Record<string, unknown> }>> =>
  (await env.DB.prepare(`select * from audit_events where action = ?1 order by id`).bind(action).all<Row>()).results.map((r) => ({
    ...r,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  }));
const allActions = async () => (await env.DB.prepare(`select action from audit_events order by id`).all<{ action: string }>()).results.map((r) => r.action);

/** システム管理者の居ないワークスペース(最後のオーナーの守りを確かめる。workspaces.test.ts と同じ形) */
const rawWorkspace = async (id: string, owners: string[]) => {
  const now = new Date().toISOString();
  await env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values (?1, ?1, ?2, ?3)`).bind(id, `ws-${id}`, now).run();
  for (const userId of owners) {
    await env.DB.prepare(`insert into member (id, "organizationId", "userId", role, "createdAt") values (?1, ?2, ?3, 'owner', ?4)`).bind(`m-${id}-${userId}`, id, userId, now).run();
  }
};
const memberIdOf = async (wid: string, userId: string) =>
  (await env.DB.prepare(`select id from member where "organizationId" = ?1 and "userId" = ?2`).bind(wid, userId).first<{ id: string }>())?.id;
const roleOf = async (memberId: string) => (await env.DB.prepare(`select role from member where id = ?1`).bind(memberId).first<{ role: string }>())?.role;
const makeKey = async (token: string, workspaceId: string | null, name = "k") => {
  const res = await call("POST", "/me/api-keys", { token, body: { name, workspaceId } });
  expect(res.status).toBe(201);
  return json<{ id: string; key: string }>(res);
};
const isRevoked = async (kid: string) => (await env.DB.prepare(`select 1 as x from apikey_revocations where key_id = ?1`).bind(kid).first()) !== null;
const newWorkspace = async (token: string, name: string) => (await json<{ id: string }>(await call("POST", "/workspaces", { token, body: { name } }))).id;
const invite = async (token: string, wid: string, email = uniqueEmail("invited"), role = "editor") => {
  const res = await call("POST", `/workspaces/${wid}/invitations`, { token, body: { email, role } });
  expect(res.status).toBe(201);
  return { ...(await json<{ id: string }>(res)), email };
};

describe("member.role_change", () => {
  it("role_change_records_from_and_to", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "admin" } });
    expect(res.status).toBe(200);
    const [e, ...rest] = await events("member.role_change");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      category: "access",
      workspace_id: owner.workspaceId,
      via: "google",
      actor_user_id: owner.userId,
      actor_email: owner.email,
      target_type: "user",
      target_id: ed.userId,
      target_label: ed.email,
      detail: { from: "editor", to: "admin" },
    });
  });

  it("role_change_refused_writes_no_event", async () => {
    const owner = await setupOwner();
    // システム管理者の行(409 instance_admin_member)
    const ownerRow = (await memberIdOf(owner.workspaceId, owner.userId))!;
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ownerRow}`, { token: owner.token, body: { role: "admin" } })).status).toBe(409);
    // 最後のオーナー(409 last_owner。システム管理者の居ないワークスペース)
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await rawWorkspace("w-x", [ed.userId]);
    const last = await call("PATCH", `/workspaces/w-x/members/${(await memberIdOf("w-x", ed.userId))!}`, { token: ed.token, body: { role: "admin" } });
    expect(last.status).toBe(409);
    expect((await json(last)).error).toBe("last_owner");
    expect(await events("member.role_change")).toEqual([]);
  });

  it("role_change_same_role_writes_no_event", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "editor" } })).status).toBe(200);
    expect(await events("member.role_change")).toEqual([]);
  });
});

describe("member.remove", () => {
  it("member_remove_records_revoked_keys", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await makeKey(ed.token, owner.workspaceId);
    await makeKey(ed.token, owner.workspaceId);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    const [e, ...rest] = await events("member.remove");
    expect(rest).toEqual([]);
    // Member の行が消えても、対象の控え(メール)は記録に残る
    expect(e).toMatchObject({ workspace_id: owner.workspaceId, target_type: "user", target_id: ed.userId, target_label: ed.email, detail: { role: "editor", revokedKeys: 2 } });
  });

  it("member_remove_revoked_keys_match_actual (Q19)", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await inviteAndJoin(owner.token, b, "editor", ed.email);
    const k1 = await makeKey(ed.token, owner.workspaceId);
    const k2 = await makeKey(ed.token, owner.workspaceId);
    // 失効済みの鍵・別のワークスペースの鍵・壊れた metadata の鍵は対象にならない
    const revoked = await makeKey(ed.token, owner.workspaceId);
    expect((await call("DELETE", `/me/api-keys/${revoked.id}`, { token: ed.token })).status).toBe(204);
    const inB = await makeKey(ed.token, b);
    const broken = await makeKey(ed.token, owner.workspaceId);
    await env.DB.prepare("update apikey set metadata = '{broken' where id = ?").bind(broken.id).run();
    const counting = countingD1(env.DB);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, envOverride: { DB: counting.db } })).status).toBe(204);
    const actual = await env.DB.prepare(`select key_id from apikey_revocations where revoked_by = ?1`).bind(owner.userId).all<{ key_id: string }>();
    expect(actual.results.map((r) => r.key_id).sort()).toEqual([k1.id, k2.id].sort());
    expect(await isRevoked(inB.id)).toBe(false);
    expect(await isRevoked(broken.id)).toBe(false);
    const [e] = await events("member.remove");
    expect(e!.detail.revokedKeys).toBe(actual.results.length);
    // 往復は増えない: 記録は外す batch の中(batch は 1 回、記録の文が 1 文だけの往復にならない)。
    // 1 文ずつの照会の数は実装の前の値(認証・対象の読み取り・失効の判定・ログイン状態の判定)
    const counts = counting.counts();
    expect(counts.batches).toBe(1);
    expect(counts.batchSql[0]![0]).toMatch(/^insert into audit_events/);
    expect(counts.sql.some((s) => /audit_events/.test(s))).toBe(false);
    expect(counts.queries).toBe(MEMBER_REMOVE_QUERIES);
  });

  it("member_remove_refused_writes_no_event", async () => {
    const owner = await setupOwner();
    // 自分(409 cannot_remove_self)
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${(await memberIdOf(owner.workspaceId, owner.userId))!}`, { token: owner.token })).status).toBe(409);
    // システム管理者の行(409 instance_admin_member)
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const ad = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ad.email } })).status).toBe(201);
    const adminRow = await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ad.memberId}`, { token: owner.token });
    expect(adminRow.status).toBe(409);
    expect((await json(adminRow)).error).toBe("instance_admin_member");
    // 最後のオーナー(409 last_owner): システム管理者の居ないワークスペースのオーナー 2 人のうち、ed が相手を外そうとした batch の直前に
    // ed 自身の行が消え、相手が最後のオーナーになる(事前の判定は通り、外す文の条件で断られる)
    const other = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    await rawWorkspace("w-x", [ed.userId, other.userId]);
    const racing = beforeD1Batch(env.DB, () => env.DB.prepare(`delete from member where id = ?1`).bind(`m-w-x-${ed.userId}`).run());
    const last = await call("DELETE", `/workspaces/w-x/members/m-w-x-${other.userId}`, { token: ed.token, envOverride: { DB: racing } });
    expect(last.status).toBe(409);
    expect((await json(last)).error).toBe("last_owner");
    expect(await events("member.remove")).toEqual([]);
  });

  it("member_remove_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const path = `/workspaces/${owner.workspaceId}/members/${ed.memberId}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("member.remove")).toHaveLength(1);
  });
});

/**
 * member_remove_revoked_keys_match_actual の 1 文ずつの照会の数(実装の前に測った値 = 6。記録を足しても変わらない):
 * 凍結の判定・セッション・user・呼ぶ人のロール・対象の member・ログイン状態の判定
 */
const MEMBER_REMOVE_QUERIES = 6;

describe("invitation.cancel", () => {
  it("invitation_cancel_records_email", async () => {
    const owner = await setupOwner();
    const inv = await invite(owner.token, owner.workspaceId);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${inv.id}`, { token: owner.token })).status).toBe(204);
    const [e, ...rest] = await events("invitation.cancel");
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ workspace_id: owner.workspaceId, target_type: "invitation", target_id: inv.id, target_label: inv.email, detail: { role: "editor" } });
    // 存在しない招待・取り消し済みの招待(404)は記録しない
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/nope`, { token: owner.token })).status).toBe(404);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/invitations/${inv.id}`, { token: owner.token })).status).toBe(404);
    expect(await events("invitation.cancel")).toHaveLength(1);
  });

  it("invitation_cancel_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const inv = await invite(owner.token, owner.workspaceId);
    const path = `/workspaces/${owner.workspaceId}/invitations/${inv.id}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(404);
    expect(await events("invitation.cancel")).toHaveLength(1);
  });
});

describe("instance_admin.grant / instance_admin.revoke", () => {
  it("instance_admin_grant_and_revoke", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    // 既にシステム管理者(200)は記録しない
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(200);
    const grants = await events("instance_admin.grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ workspace_id: null, actor_user_id: owner.userId, target_type: "user", target_id: ed.userId, target_label: ed.email, detail: {} });
    // フルの鍵 1 本を持たせてから外す
    await makeKey(ed.token, null);
    expect((await call("DELETE", `/instance-admins/${ed.userId}`, { token: owner.token })).status).toBe(204);
    const [revoke, ...rest] = await events("instance_admin.revoke");
    expect(rest).toEqual([]);
    expect(revoke).toMatchObject({ workspace_id: null, target_type: "user", target_id: ed.userId, target_label: ed.email, detail: { restore: true, revokedKeys: 1 } });
    // 最後の 1 人(409)は記録しない
    expect((await call("DELETE", `/instance-admins/${owner.userId}`, { token: owner.token })).status).toBe(409);
    // restore = false
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    expect((await call("DELETE", `/instance-admins/${ed.userId}?restore=false`, { token: owner.token })).status).toBe(204);
    const revokes = await events("instance_admin.revoke");
    expect(revokes).toHaveLength(2);
    expect(revokes[1]!.detail).toEqual({ restore: false, revokedKeys: 0 });
    expect(await events("instance_admin.grant")).toHaveLength(2);
  });

  it("instance_admin_grant_refused_writes_no_event", async () => {
    const owner = await setupOwner();
    // メンバーでない(404)
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: "nobody@example.com" } })).status).toBe(404);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token })).status).toBe(204);
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(404);
    expect(await events("instance_admin.grant")).toEqual([]);
  });

  it("instance_admin_revoke_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    expect((await call("POST", "/instance-admins", { token: owner.token, body: { email: ed.email } })).status).toBe(201);
    const path = `/instance-admins/${ed.userId}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(404);
    expect(await events("instance_admin.revoke")).toHaveLength(1);
  });
});

describe("api_key.revoke / api_key.revoke_member", () => {
  it("api_key_revoke_own_and_member", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const own = await makeKey(owner.token, owner.workspaceId, "owner ws key");
    const full = await makeKey(owner.token, null, "owner full key");
    expect((await call("DELETE", `/me/api-keys/${own.id}`, { token: owner.token })).status).toBe(204);
    expect((await call("DELETE", `/me/api-keys/${full.id}`, { token: owner.token })).status).toBe(204);
    const revokes = await events("api_key.revoke");
    expect(revokes).toHaveLength(2);
    // ワークスペースの鍵はその workspaceId、フルの鍵は NULL
    expect(revokes[0]).toMatchObject({ workspace_id: owner.workspaceId, actor_user_id: owner.userId, target_type: "api_key", target_id: own.id, target_label: "owner ws key", detail: {} });
    expect(revokes[1]).toMatchObject({ workspace_id: null, target_type: "api_key", target_id: full.id, target_label: "owner full key", detail: {} });
    // 既に失効済み(404)・他人の鍵(404)は記録しない
    expect((await call("DELETE", `/me/api-keys/${own.id}`, { token: owner.token })).status).toBe(404);
    const edKey = await makeKey(ed.token, owner.workspaceId, "editor key");
    expect((await call("DELETE", `/me/api-keys/${edKey.id}`, { token: owner.token })).status).toBe(404);
    expect(await events("api_key.revoke")).toHaveLength(2);
    // メンバーの鍵の失効
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${edKey.id}`, { token: owner.token })).status).toBe(204);
    const [m, ...rest] = await events("api_key.revoke_member");
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ workspace_id: owner.workspaceId, actor_user_id: owner.userId, target_type: "api_key", target_id: edKey.id, target_label: "editor key", detail: { owner: ed.email } });
    // 既に失効済み(404)は記録しない
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${edKey.id}`, { token: owner.token })).status).toBe(404);
    expect(await events("api_key.revoke_member")).toHaveLength(1);
  });

  it("api_key_revoke_already_revoked_writes_no_event", async () => {
    const owner = await setupOwner();
    const k = await makeKey(owner.token, owner.workspaceId);
    const path = `/me/api-keys/${k.id}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(404);
    expect(await events("api_key.revoke")).toHaveLength(1);
  });

  it("api_key_revoke_member_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(ed.token, owner.workspaceId);
    const path = `/workspaces/${owner.workspaceId}/api-keys/${k.id}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(404);
    expect(await events("api_key.revoke_member")).toHaveLength(1);
  });
});

describe("workspace.create / workspace.delete", () => {
  it("workspace_create_delete", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "Second");
    const [c, ...more] = await events("workspace.create");
    expect(more).toEqual([]);
    expect(c).toMatchObject({ workspace_id: b, actor_user_id: owner.userId, target_type: "workspace", target_id: b, target_label: "Second", detail: {} });
    await createSite(owner.token, b);
    expect((await call("DELETE", `/workspaces/${b}`, { token: owner.token })).status).toBe(204);
    const [d, ...rest] = await events("workspace.delete");
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ workspace_id: b, actor_user_id: owner.userId, target_type: "workspace", target_id: b, target_label: "Second", detail: { sites: 1 } });
  });

  it("workspace_delete_refused_writes_no_event", async () => {
    // 配信中のエクスペリエンスがある(409。最後のワークスペースにならないよう、もう 1 つ作っておく)
    const { owner } = await siteWithRunning();
    await newWorkspace(owner.token, "B");
    const running = await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token });
    expect(running.status).toBe(409);
    expect((await json(running)).error).toBe("workspace_has_running_experiments");
    // 存在しないワークスペース(404)
    expect((await call("DELETE", `/workspaces/nope`, { token: owner.token })).status).toBe(404);
    expect(await events("workspace.delete")).toEqual([]);
  });

  it("workspace_delete_last_writes_no_event", async () => {
    // 最後のワークスペース(409 last_workspace)は記録しない
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}`, { token: owner.token })).status).toBe(204);
    const last = await call("DELETE", `/workspaces/${b}`, { token: owner.token });
    expect(last.status).toBe(409);
    expect((await json(last)).error).toBe("last_workspace");
    expect(await events("workspace.delete")).toHaveLength(1);
  });

  it("workspace_delete_concurrent_second_writes_no_event", async () => {
    const owner = await setupOwner();
    const b = await newWorkspace(owner.token, "B");
    await newWorkspace(owner.token, "C");
    const path = `/workspaces/${b}`;
    const racing = beforeD1Batch(env.DB, async () => expect((await call("DELETE", path, { token: owner.token })).status).toBe(204));
    expect((await call("DELETE", path, { token: owner.token, envOverride: { DB: racing } })).status).toBe(409);
    expect(await events("workspace.delete")).toHaveLength(1);
  });

  it("workspace_create_without_actor_writes_no_event (Q17)", async () => {
    await setupOwner();
    await createWorkspace(testEnv, "No actor");
    expect(await events("workspace.create")).toEqual([]);
  });
});

describe("setup.complete", () => {
  it("setup_records_completion (Q13・Q17)", async () => {
    // setupOwner は D1 への直書きなので、本物の POST /setup を通す(setupOwner が入れる行ではなく route の記録を見る)
    const email = "owner@example.com";
    const res = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email, name: "Owner", workspaceName: "Workspace A" } });
    expect(res.status).toBe(201);
    const owner = { ...(await json<{ workspaceId: string; userId: string }>(res)), email };
    // 初期設定の記録は setup.complete の 1 行だけ(createWorkspace の workspace.create は書かない)
    expect(await allActions()).toEqual(["setup.complete"]);
    const [e] = await events("setup.complete");
    expect(e).toMatchObject({ category: "access", via: "setup", workspace_id: owner.workspaceId, actor_user_id: owner.userId, actor_email: owner.email, target_type: "workspace", target_id: owner.workspaceId, target_label: "Workspace A" });
  });

  it("setup_batch_failure_is_503_without_event (Q17)", async () => {
    const failed = await call("POST", "/setup", {
      headers: { "x-setup-token": SETUP_TOKEN },
      body: { email: "owner@example.com", workspaceName: "W" },
      envOverride: { DB: failingD1Insert(env.DB, "audit_events") },
    });
    expect(failed.status).toBe(503);
    expect((await json(failed)).error).toBe("setup_failed");
    expect(await allActions()).toEqual([]);
    expect((await env.DB.prepare(`select count(*) as n from organization`).first<{ n: number }>())?.n).toBe(0);
    expect(await env.DB.prepare(`select completed from setup_lock where id = 1`).first()).toBeNull();
  });

  it("setup_takeover_writes_no_event", async () => {
    // 完了の batch の直前に、別の要求が lock を取り直した(created_at が変わった)状態を作る
    const racing = beforeD1BatchMatching(env.DB, /update setup_lock set completed/, () => env.DB.prepare(`update setup_lock set created_at = created_at - 1 where id = 1`).run());
    const res = await call("POST", "/setup", { headers: { "x-setup-token": SETUP_TOKEN }, body: { email: "owner@example.com", workspaceName: "W" }, envOverride: { DB: racing.db } });
    expect(racing.ran()).toBe(true);
    expect(res.status).toBe(503);
    expect(await allActions()).toEqual([]);
  });
});

describe("usage.settings_change", () => {
  it("usage_settings_change_records_fields", async () => {
    const owner = await setupOwner();
    expect((await call("PATCH", "/usage/settings", { token: owner.token, body: { cloudflarePlan: "paid" } })).status).toBe(200);
    expect((await call("PATCH", "/usage/settings", { token: owner.token, body: { showPaidReference: false, usageVisibility: "instance_admins" } })).status).toBe(200);
    const [a, b, ...rest] = await events("usage.settings_change");
    expect(rest).toEqual([]);
    // 送った項目だけ。前の値は記録の文で読む(行が無ければ既定値)
    expect(a).toMatchObject({ workspace_id: null, actor_user_id: owner.userId, target_type: "instance", target_id: null, detail: { cloudflarePlan: { from: "free", to: "paid" } } });
    expect(Object.keys(a!.detail)).toEqual(["cloudflarePlan"]);
    expect(b!.detail).toEqual({ showPaidReference: { from: true, to: false }, usageVisibility: { from: "members", to: "instance_admins" } });
    // 同じ値の送り直しも 1 行書く(upsert は無条件で、プランの再送では KV の記録も書き直すため)。値が変わった項目が無いので {}(final review)
    expect((await call("PATCH", "/usage/settings", { token: owner.token, body: { cloudflarePlan: "paid" } })).status).toBe(200);
    const after = await events("usage.settings_change");
    expect(after).toHaveLength(3);
    expect(after[2]!.detail).toEqual({});
  });

  it("usage_settings_change_records_only_changed_items (final review)", async () => {
    const owner = await setupOwner();
    // 画面と同じく 3 項目を全部送る。行が無い項目は既定値と比べる
    const all = { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true };
    for (const body of [{ ...all, cloudflarePlan: "paid" }, { ...all, cloudflarePlan: "paid" }, { ...all, cloudflarePlan: "paid", showPaidReference: false }])
      expect((await call("PATCH", "/usage/settings", { token: owner.token, body })).status).toBe(200);
    expect((await events("usage.settings_change")).map((e) => e.detail)).toEqual([
      { cloudflarePlan: { from: "free", to: "paid" } },
      {},
      { showPaidReference: { from: true, to: false } },
    ]);
  });
});

describe("audit_failure_rolls_back_operation (Q8)", () => {
  const failing = () => ({ DB: failingD1Insert(env.DB, "audit_events") });

  it("role change", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const res = await call("PATCH", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, body: { role: "admin" }, envOverride: failing() });
    expect(res.status).toBe(500);
    expect(await roleOf(ed.memberId)).toBe("editor");
  });

  it("member removal", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const k = await makeKey(ed.token, owner.workspaceId);
    const res = await call("DELETE", `/workspaces/${owner.workspaceId}/members/${ed.memberId}`, { token: owner.token, envOverride: failing() });
    expect(res.status).toBe(500);
    expect(await roleOf(ed.memberId)).toBe("editor");
    expect(await isRevoked(k.id)).toBe(false);
  });

  it("key revocation", async () => {
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const own = await makeKey(owner.token, owner.workspaceId);
    const edKey = await makeKey(ed.token, owner.workspaceId);
    expect((await call("DELETE", `/me/api-keys/${own.id}`, { token: owner.token, envOverride: failing() })).status).toBe(500);
    expect((await call("DELETE", `/workspaces/${owner.workspaceId}/api-keys/${edKey.id}`, { token: owner.token, envOverride: failing() })).status).toBe(500);
    expect(await isRevoked(own.id)).toBe(false);
    expect(await isRevoked(edKey.id)).toBe(false);
  });
});
